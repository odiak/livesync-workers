import {
  CHANGES_IDLE_HEADER,
  DB_NAME_HEADER,
  INTERNAL_SECRET_HEADER,
  couchError,
  json,
  jsonHeaders,
  numberParam,
} from "./http.js";
import { vaultObjectName, type VaultBindings, type VaultHost, type VaultRef } from "../types.js";

export type LiveSyncHandlerOptions = {
  host: VaultHost;
  bindings: Pick<VaultBindings, "vaultDb">;
  /** URL prefix the CouchDB API is served under. Default "/livesync". */
  prefix?: string;
};

const DEFAULT_PREFIX = "/livesync";
const DEFAULT_SERVER_NAME = "livesync-workers";

const liveSyncDefaultOrigins = [
  "app://obsidian.md",
  "capacitor://localhost",
  "http://localhost",
] as const;

function allowsAnyOrigin(host: VaultHost): boolean {
  return host.allowedOrigins === "*";
}

function allowedOrigins(host: VaultHost, request: Request): Set<string> {
  const origins = new Set<string>([...liveSyncDefaultOrigins, new URL(request.url).origin]);
  const extra = host.allowedOrigins === "*" ? [] : (host.allowedOrigins ?? []);
  for (const origin of extra) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

function corsHeaders(request: Request, host: VaultHost): HeadersInit | null {
  const origin = request.headers.get("Origin");
  const base = {
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,content-type,accept,origin,referer,x-couch-full-commit",
    "Access-Control-Expose-Headers": "etag",
    Vary: "Origin",
  };
  if (!origin) return { ...base, "Access-Control-Allow-Origin": "*" };
  if (!allowsAnyOrigin(host) && !allowedOrigins(host, request).has(origin)) return null;
  return {
    ...base,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  };
}

function withCors(request: Request, host: VaultHost, response: Response): Response {
  const cors = corsHeaders(request, host);
  if (!cors) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decodeBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return { user: decoded.slice(0, index), pass: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

type AuthResult =
  | { ok: true; ref: VaultRef; username: string }
  | { ok: false; response: Response };

async function checkBasicAuth(request: Request, host: VaultHost): Promise<AuthResult> {
  const auth = decodeBasicAuth(request.headers.get("Authorization"));
  if (auth) {
    const ref = await host.verifyCredential(auth.user, auth.pass);
    if (ref) return { ok: true, ref, username: auth.user };
  }
  return {
    ok: false,
    response: json(
      { error: "unauthorized", reason: "Name or password is incorrect." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${host.serverName ?? DEFAULT_SERVER_NAME}"`,
        },
      },
    ),
  };
}

function configValue(section: string, key: string): string {
  const values: Record<string, string> = {
    "chttpd/require_valid_user": "true",
    "chttpd/max_http_request_size": "4294967296",
    "couchdb/max_document_size": "50000000",
    "chttpd_auth/require_valid_user": "true",
    "couchdb/single_node": "true",
  };
  return values[`${section}/${key}`] ?? "true";
}

function configObject(host: VaultHost, request: Request) {
  return {
    admins: {},
    chttpd: {
      require_valid_user: "true",
      enable_cors: "true",
      max_http_request_size: "4294967296",
    },
    chttpd_auth: {
      require_valid_user: "true",
      authentication_redirect: "/_utils/session.html",
    },
    httpd: {
      "WWW-Authenticate": `Basic realm="${host.serverName ?? DEFAULT_SERVER_NAME}"`,
      enable_cors: "true",
    },
    cors: {
      credentials: "true",
      origins: allowsAnyOrigin(host) ? "*" : [...allowedOrigins(host, request)].join(","),
      headers: "authorization,content-type,accept,origin,referer,x-couch-full-commit",
      methods: "GET,HEAD,POST,PUT,DELETE,OPTIONS",
    },
    couchdb: {
      single_node: "true",
      max_document_size: "50000000",
    },
  };
}

const MAX_WAIT_MS = 25_000;

function clampWait(ms: number): number {
  return Math.min(Math.max(ms, 1000), MAX_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Worker-side subscription to a database's change notifications.
 *
 * The Worker (not the Durable Object) is the one that waits for longpoll and
 * continuous feeds: it opens a hibernatable WebSocket into the object and
 * blocks on it. While no writes arrive the object has no in-flight request and
 * no timer, so it is eligible for hibernation and stops accruing duration.
 * Waiting in the Worker costs nothing beyond the request itself.
 */
class ChangeWatcher {
  private changed = false;
  private notify: (() => void) | null = null;

  private constructor(private socket: WebSocket | null) {
    if (!socket) return;
    socket.addEventListener("message", () => {
      if (this.notify) this.notify();
      else this.changed = true;
    });
    const drop = () => {
      this.socket = null;
    };
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);
  }

  /** Subscribe first, then read: a write landing in between is still delivered. */
  static async open(stub: DurableObjectStub, internalSecret: string): Promise<ChangeWatcher> {
    try {
      const response = await stub.fetch(
        new Request("https://livesync-db/internal/watch", {
          headers: { Upgrade: "websocket", [INTERNAL_SECRET_HEADER]: internalSecret },
        }),
      );
      const socket = response.webSocket;
      if (socket) {
        socket.accept();
        return new ChangeWatcher(socket);
      }
      console.warn("LiveSync change watcher: object refused WebSocket", response.status);
    } catch (error) {
      console.warn("LiveSync change watcher: failed to connect", error);
    }
    // Without a subscription we still honour the timeout, just without wake-ups.
    return new ChangeWatcher(null);
  }

  /** Resolves true when a change was signalled, false when `ms` elapsed first. */
  async wait(ms: number): Promise<boolean> {
    if (this.changed) {
      this.changed = false;
      return true;
    }
    if (!this.socket) {
      await sleep(ms);
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.notify = null;
        resolve(false);
      }, ms);
      this.notify = () => {
        clearTimeout(timer);
        this.notify = null;
        resolve(true);
      };
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "done");
    } catch {
      // already closed
    }
  }
}

function stripIdleHeader(response: Response): Response {
  if (!response.headers.has(CHANGES_IDLE_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(CHANGES_IDLE_HEADER);
  return new Response(response.body, { status: response.status, headers });
}

type ChangeFeedBatch = { results?: unknown[]; last_seq?: unknown };

async function proxyChanges(
  request: Request,
  rewritten: URL,
  headers: Headers,
  stub: DurableObjectStub,
  internalSecret: string,
): Promise<Response> {
  const bodyText = request.method === "POST" ? await request.text() : null;
  let body: Record<string, unknown> = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const options: Record<string, unknown> = {
    ...Object.fromEntries(rewritten.searchParams.entries()),
    ...body,
  };
  const feed = String(options.feed ?? "normal");

  // The object only ever answers immediately; `feed` is forced back to normal.
  const fetchChanges = (overrides: Record<string, string>): Promise<Response> => {
    const url = new URL(rewritten.toString());
    for (const [key, value] of Object.entries(overrides)) url.searchParams.set(key, value);
    const init: RequestInit = { method: request.method, headers };
    if (bodyText !== null) {
      init.body = Object.keys(overrides).length
        ? JSON.stringify({ ...body, ...overrides })
        : bodyText;
    }
    return stub.fetch(new Request(url.toString(), init));
  };

  if (feed === "longpoll") {
    const timeout = clampWait(numberParam(options.timeout, MAX_WAIT_MS));
    const watcher = await ChangeWatcher.open(stub, internalSecret);
    try {
      const response = await fetchChanges({ feed: "normal" });
      if (!response.ok || response.headers.get(CHANGES_IDLE_HEADER) !== "1") {
        return stripIdleHeader(response);
      }
      // Idle: remember where the object resolved `since` to (it may have been
      // "now"), so the re-ask after a notification starts from that point
      // instead of skipping past the change we were woken for.
      const idle = (await response.json()) as { last_seq?: unknown };
      const changed = await watcher.wait(timeout);
      if (changed && idle.last_seq !== undefined) {
        return stripIdleHeader(
          await fetchChanges({ feed: "normal", since: String(idle.last_seq) }),
        );
      }
      return json(idle);
    } finally {
      watcher.close();
    }
  }

  if (feed === "continuous") {
    // Resolve the first batch before streaming so that errors (missing DB, bad
    // selector, ...) keep their status instead of being buried in a 200 stream.
    const first = await fetchChanges({ feed: "normal" });
    if (!first.ok) return stripIdleHeader(first);
    const firstBatch = (await first.json()) as ChangeFeedBatch;
    return continuousChangesProxy(
      fetchChanges,
      await ChangeWatcher.open(stub, internalSecret),
      options,
      firstBatch,
    );
  }

  return stripIdleHeader(await fetchChanges({}));
}

function continuousChangesProxy(
  fetchChanges: (overrides: Record<string, string>) => Promise<Response>,
  watcher: ChangeWatcher,
  options: Record<string, unknown>,
  firstBatch: ChangeFeedBatch,
): Response {
  const encoder = new TextEncoder();
  const deadline = Date.now() + clampWait(numberParam(options.timeout, MAX_WAIT_MS));
  const heartbeat = clampWait(numberParam(options.heartbeat, 10_000));
  let cursor = options.since === undefined ? "0" : String(options.since);

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        let batch: ChangeFeedBatch | null = firstBatch;
        while (batch) {
          for (const row of batch.results ?? []) {
            controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
          }
          if (batch.last_seq !== undefined) cursor = String(batch.last_seq);
          batch = null;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const changed = await watcher.wait(Math.min(heartbeat, remaining));
          if (!changed) {
            controller.enqueue(encoder.encode("\n"));
            if (Date.now() >= deadline) break;
          }
          const response = await fetchChanges({ feed: "normal", since: cursor });
          if (!response.ok) {
            throw new Error(`_changes failed mid-stream: ${response.status}`);
          }
          batch = (await response.json()) as ChangeFeedBatch;
        }
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ last_seq: Number(cursor) || cursor, pending: 0 })}\n`,
          ),
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        watcher.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

/** Stub for the Durable Object holding a vault. */
export function vaultStub(vaultDb: DurableObjectNamespace, ref: VaultRef): DurableObjectStub {
  return vaultDb.get(vaultDb.idFromName(vaultObjectName(ref)));
}

/**
 * Serve the CouchDB-compatible API that Self-hosted LiveSync talks to.
 * Mount it for every request whose path starts with `prefix`.
 */
export async function handleLiveSyncRequest(
  request: Request,
  options: LiveSyncHandlerOptions,
): Promise<Response> {
  const { host } = options;
  const prefix = (options.prefix ?? DEFAULT_PREFIX).replace(/\/+$/, "");

  if (request.method === "OPTIONS") {
    const cors = corsHeaders(request, host);
    if (!cors) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return new Response("Not Found", { status: 404 });
  }

  const relative = url.pathname.slice(prefix.length).replace(/^\/+/, "");
  const parts = relative ? relative.split("/") : [];
  const rootPath = parts[0] ?? "";
  const publicRoot = request.method === "GET" && (relative === "" || rootPath === "_up");
  const authResult = publicRoot ? null : await checkBasicAuth(request, host);
  if (authResult && !authResult.ok) {
    return withCors(request, host, authResult.response);
  }
  const auth = authResult?.ok ? authResult : null;

  if (relative === "" && request.method === "GET") {
    return withCors(
      request,
      host,
      json({
        couchdb: "Welcome",
        version: "3.3.0",
        vendor: { name: host.serverName ?? DEFAULT_SERVER_NAME },
      }),
    );
  }
  if (rootPath === "_up" && request.method === "GET") {
    return withCors(request, host, json({ status: "ok" }));
  }
  if (rootPath === "_session" && request.method === "GET") {
    return withCors(
      request,
      host,
      json({
        ok: true,
        userCtx: { name: auth?.username ?? "user", roles: ["_admin"] },
        info: { authentication_db: "_users" },
      }),
    );
  }
  if (rootPath === "_membership" && request.method === "GET") {
    return withCors(request, host, json({ all_nodes: ["cf"], cluster_nodes: ["cf"] }));
  }
  if (parts[0] === "_node" && parts[1] === "_local" && parts[2] === "_config") {
    if (request.method === "GET") {
      if (parts.length === 3) {
        return withCors(request, host, json(configObject(host, request)));
      }
      return withCors(
        request,
        host,
        new Response(JSON.stringify(configValue(parts[3] ?? "", parts[4] ?? "")), {
          headers: jsonHeaders,
        }),
      );
    }
    if (request.method === "PUT") {
      return withCors(request, host, json({ ok: true }));
    }
  }

  const dbName = parts[0];
  if (!dbName || dbName.startsWith("_")) {
    return withCors(request, host, couchError(404, "not_found", "missing"));
  }
  const decodedDbName = decodeURIComponent(dbName);
  if (auth!.ref.databaseName !== decodedDbName) {
    return withCors(
      request,
      host,
      couchError(403, "forbidden", "Database is not allowed for this credential."),
    );
  }

  const dbPath = `/${parts.slice(1).join("/")}`;
  const rewritten = new URL(request.url);
  rewritten.pathname = dbPath;
  const headers = new Headers(request.headers);
  headers.set(DB_NAME_HEADER, decodedDbName);
  const stub = vaultStub(options.bindings.vaultDb, auth!.ref);
  if (dbPath === "/_changes" && (request.method === "GET" || request.method === "POST")) {
    return withCors(
      request,
      host,
      await proxyChanges(request, rewritten, headers, stub, host.internalSecret),
    );
  }
  const response = await stub.fetch(
    new Request(rewritten.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect,
    }),
  );
  return withCors(request, host, response);
}
