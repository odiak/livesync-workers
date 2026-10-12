import { AUTH_LOCK_SECONDS, isLockedOut, recordAuthFailure } from "./throttle.js";
import { readBoundedText, RequestLimitError } from "livesync-workers";
import { LiveSyncVaultDO, handleLiveSyncRequest } from "livesync-workers";
import { VAULT_SCOPES, VAULT_SCOPE_DESCRIPTIONS, withMcpSessionIsolation } from "livesync-workers/mcp";
import { createVaultOAuthProvider } from "livesync-workers/oauth";
import type { Env } from "./env.js";
import {
  ConfigError,
  liveSyncUsername,
  requireSecret,
  secretValue,
  vaultBindings,
  vaultFor,
  vaultHost,
  vaultRef,
} from "./host.js";
import type { SetupConfig } from "./setup-uri.js";
import {
  checkAdminPassword,
  checkStaticToken,
  staticTokenScopes,
  clearSessionCookie,
  createSessionCookie,
  isAdmin,
  safeRedirectTarget,
} from "./auth.js";
import { listMcpConnections } from "./mcp-connections.js";
import { loginPage, statusPage } from "./pages.js";
import { VaultMCP } from "./mcp.js";

export { VaultMCP };

export class VaultDO extends LiveSyncVaultDO<Env> {
  protected host() {
    return vaultHost(this.env);
  }
  protected bindings() {
    return vaultBindings(this.env);
  }
}

const mcpHandler = withMcpSessionIsolation<Env>(
  VaultMCP.serve("/mcp", { binding: "MCP_OBJECT" }) as unknown as ExportedHandler<Env>,
  "MCP_OBJECT",
);

const appHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/livesync" || url.pathname.startsWith("/livesync/")) {
      return handleLiveSyncRequest(request, { host: vaultHost(env, request), bindings: vaultBindings(env) });
    }

    if (url.pathname === "/login") {
      const next = safeRedirectTarget(url.searchParams.get("next"), url.origin);
      if (request.method === "GET") return loginPage(next);
      if (request.method === "POST") {
        if (await isLockedOut(env, request)) return new Response("Too many sign-in attempts", { status: 429, headers: { "Retry-After": String(AUTH_LOCK_SECONDS) } });
        const form = new URLSearchParams(await readBoundedText(request, 64 * 1024));
        const password = String(form?.get("password") ?? "");
        const target = safeRedirectTarget(String(form?.get("next") ?? next), url.origin);
        if (!checkAdminPassword(env, password)) {
          if (await recordAuthFailure(env, request)) return new Response("Too many sign-in attempts", { status: 429, headers: { "Retry-After": String(AUTH_LOCK_SECONDS) } });
          return loginPage(target, "Wrong password.");
        }
        return new Response(null, {
          status: 303,
          headers: { Location: target, "Set-Cookie": await createSessionCookie(env) },
        });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/logout" && request.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": clearSessionCookie },
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      const admin = await isAdmin(request, env);
      const configured = {
        livesync: !!secretValue(env, "LIVESYNC_PASSWORD"),
        admin: !!secretValue(env, "ADMIN_PASSWORD"),
        session: !!secretValue(env, "SESSION_SECRET"),
      };
      const data: Parameters<typeof statusPage>[1] = { origin: url.origin, admin, configured };
      if (admin) {
        data.username = liveSyncUsername(env);
        try {
          if (!env.OAUTH_PROVIDER) throw new Error("OAuth provider unavailable");
          data.mcpConnections = await listMcpConnections(env.OAUTH_PROVIDER, "admin");
        } catch {
          data.mcpConnectionsError = true;
        }
        try {
          const vault = vaultFor(env);
          data.dbExists = await vault.exists();
          data.index = data.dbExists ? await vault.indexStatus() : null;
        } catch (error) {
          data.indexError = error instanceof Error ? error.message : String(error);
        }
      }
      return statusPage(env, data);
    }

    // Connection details for the browser-side Setup URI generator (admin only).
    if (url.pathname === "/api/setup-config" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return new Response("Unauthorized", { status: 401 });
      const config: SetupConfig = {
        uri: `${url.origin}/livesync`,
        username: liveSyncUsername(env),
        password: requireSecret(env, "LIVESYNC_PASSWORD"),
        database: vaultRef(env).databaseName,
      };
      return Response.json(config, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return new Response("Unauthorized", { status: 401 });
      const vault = vaultFor(env);
      const exists = await vault.exists();
      return Response.json({ exists, index: exists ? await vault.indexStatus() : null });
    }

    return new Response("Not Found", { status: 404 });
  },
};

const oauthProvider = createVaultOAuthProvider<Env>({
  apiHandler: mcpHandler as unknown as ExportedHandler<Env>,
  defaultHandler: appHandler,
  authenticate: async (request, env) =>
    (await isAdmin(request, env)) ? { id: "admin", label: "admin" } : null,
  loginRedirect: (request, _env, next) =>
    Response.redirect(`${new URL(request.url).origin}/login?next=${encodeURIComponent(next)}`, 302),
  scopes: VAULT_SCOPES.map((name) => ({
    name,
    description: VAULT_SCOPE_DESCRIPTIONS[name],
    required: name === "vault:read",
    default: name === "vault:read",
  })),
  csrfSecret: (env) => requireSecret(env, "SESSION_SECRET"),
  resourceName: "livesync-workers vault",
  refreshTokenTTL: null,
  consent: { title: "Allow access to your vault" },
});

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.body && url.pathname !== "/livesync" && !url.pathname.startsWith("/livesync/")) {
        request = new Request(request, { body: await readBoundedText(request) });
      }
      // Static bearer token bypasses OAuth for clients that cannot do it.
      if (url.pathname === "/mcp" && checkStaticToken(env, request)) {
        // Same principal shape as an OAuth grant, so tools apply the same scope checks.
        const withProps = {
          ...ctx,
          props: { userId: "admin", label: "static-token", scope: staticTokenScopes(env) },
        };
        return mcpHandler.fetch(request, env, withProps as unknown as ExecutionContext);
      }
      return await oauthProvider.fetch(
        request,
        env as Parameters<typeof oauthProvider.fetch>[1],
        ctx,
      );
    } catch (error) {
      if (error instanceof RequestLimitError) return new Response(error.message, { status: 413 });
      if (error instanceof ConfigError) {
        return new Response(`Configuration error: ${error.message}`, { status: 500 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
