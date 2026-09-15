import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { sha256Hex, constantTimeEquals, randomToken } from "../credentials.js";

export type OAuthScopeSpec = {
  name: string;
  description: string;
  /** Always granted; shown checked and disabled. */
  required?: boolean;
  /** Checked by default when the client requested no scopes. */
  default?: boolean;
};

export type OAuthPrincipal = {
  /** Stable user id stored in the grant. */
  id: string;
  /** Shown on the consent page and copied into token props. */
  label?: string;
  /** Extra props merged into the access token. */
  props?: Record<string, unknown>;
};

export type VaultOAuthOptions<Env> = {
  /** Path the MCP endpoint is served under. Default "/mcp". */
  apiRoute?: string;
  /** Handler for `apiRoute`, e.g. `MyMcp.serve("/mcp")`. Receives `ctx.props`. */
  apiHandler: ExportedHandler<Env>;
  /** Everything else (your app). */
  defaultHandler: ExportedHandler<Env>;
  /** Who is signed in for this request (session cookie, etc.), or null. */
  authenticate: (request: Request, env: Env) => Promise<OAuthPrincipal | null>;
  /** Where to send an unauthenticated user; `next` is the /authorize URL to return to. */
  loginRedirect: (request: Request, env: Env, next: string) => Response | Promise<Response>;
  scopes: OAuthScopeSpec[];
  /** Secret for signing the consent-form CSRF token. */
  csrfSecret: (env: Env) => string;
  resourceName: string;
  consent?: {
    title?: string;
    /** HTML-escaped automatically. `{client}` is replaced with the client name. */
    intro?: string;
    approveLabel?: string;
    lang?: string;
  };
  accessTokenTTL?: number;
  refreshTokenTTL?: number;
};

type ParsedAuthRequest = { clientId: string; scope: string[]; redirectUri: string };

type ProviderEnv = {
  OAUTH_PROVIDER?: {
    parseAuthRequest(request: Request): Promise<ParsedAuthRequest>;
    lookupClient(clientId: string): Promise<{ clientName?: string; clientUri?: string } | null>;
    completeAuthorization(options: {
      request: ParsedAuthRequest;
      userId: string;
      metadata: unknown;
      scope: string[];
      props: unknown;
    }): Promise<{ redirectTo: string }>;
  };
};

const CSRF_COOKIE = "ls_oauth_csrf";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function htmlPage(title: string, body: string, status = 200, lang = "en"): Response {
  return new Response(
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
      title,
    )}</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.6;color:#1f2937}button,.button{display:inline-block;border:0;border-radius:999px;background:#111827;color:white;padding:10px 18px;text-decoration:none;font-weight:600;cursor:pointer}code{background:#f3f4f6;border-radius:6px;padding:2px 5px}.card{border:1px solid #e5e7eb;border-radius:20px;padding:24px;box-shadow:0 10px 24px rgba(15,23,42,.06)}.muted{color:#6b7280}.scope{display:block;margin:8px 0}input[type=password],input[type=text]{font:inherit;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;width:100%;box-sizing:border-box}label{display:block;margin:12px 0 4px}table{border-collapse:collapse}td,th{text-align:left;padding:4px 12px 4px 0;vertical-align:top}</style></head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name && v) return decodeURIComponent(v);
  }
  return undefined;
}

async function csrfPair(secret: string): Promise<{ nonce: string; token: string }> {
  const nonce = randomToken(16);
  return { nonce, token: await sha256Hex(`${secret}:${nonce}`) };
}

async function csrfValid(secret: string, nonce: string | undefined, token: string | undefined) {
  if (!nonce || !token) return false;
  return constantTimeEquals(await sha256Hex(`${secret}:${nonce}`), token);
}

function consentHandler<Env>(options: VaultOAuthOptions<Env>): ExportedHandler<Env> {
  const requiredScopes = options.scopes.filter((s) => s.required).map((s) => s.name);
  const allScopes = options.scopes.map((s) => s.name);
  const defaultScopes = options.scopes.filter((s) => s.required || s.default).map((s) => s.name);
  const descriptions = new Map(options.scopes.map((s) => [s.name, s.description]));
  const lang = options.consent?.lang ?? "en";
  const title = options.consent?.title ?? `Authorize ${options.resourceName}`;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") {
        return options.defaultHandler.fetch!(request, env, ctx);
      }
      const providerEnv = env as unknown as ProviderEnv;
      const principal = await options.authenticate(request, env);
      if (!principal) {
        return options.loginRedirect(request, env, `${url.pathname}${url.search}`);
      }
      if (!providerEnv.OAUTH_PROVIDER) {
        return htmlPage(title, "<p>OAuth provider is not available.</p>", 500, lang);
      }

      // Clone before parseAuthRequest, which may consume the POST body.
      const formRequest = request.method === "POST" ? request.clone() : null;
      let authRequest: ParsedAuthRequest;
      try {
        authRequest = await providerEnv.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid authorization request";
        return htmlPage(
          title,
          `<div class="card"><h1>OAuth request error</h1><p>${escapeHtml(message)}</p></div>`,
          400,
          lang,
        );
      }

      // Many MCP clients request no scope at all; offer every supported
      // scope then, or only what the client asked for otherwise.
      const requestedScopes = authRequest.scope.filter((scope) => allScopes.includes(scope));
      const offeredScopes = requestedScopes.length > 0 ? requestedScopes : allScopes;
      for (const required of requiredScopes) {
        if (!offeredScopes.includes(required)) {
          return htmlPage(
            title,
            `<div class="card"><h1>Unsupported scope</h1><p>${escapeHtml(
              options.resourceName,
            )} requires <code>${escapeHtml(required)}</code>.</p></div>`,
            400,
            lang,
          );
        }
      }

      const client = await providerEnv.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      const clientName = client?.clientName ?? client?.clientUri ?? authRequest.clientId;
      const secret = options.csrfSecret(env);

      if (request.method === "GET") {
        const { nonce, token } = await csrfPair(secret);
        const scopeRows = offeredScopes
          .map((scope) => {
            const required = requiredScopes.includes(scope);
            const checked =
              required || (requestedScopes.length > 0 ? true : defaultScopes.includes(scope));
            return `<label class="scope"><input type="checkbox" name="grant_scope" value="${escapeHtml(
              scope,
            )}"${checked ? " checked" : ""}${required ? " disabled" : ""}> <code>${escapeHtml(
              scope,
            )}</code> — ${escapeHtml(descriptions.get(scope) ?? "")}</label>`;
          })
          .join("");
        const intro = escapeHtml(
          options.consent?.intro ??
            `{client} is asking for access to ${options.resourceName}. Choose what to allow.`,
        ).replace("{client}", `<strong>${escapeHtml(clientName)}</strong>`);
        const who = principal.label
          ? `<p class="muted">Signed in as ${escapeHtml(principal.label)}</p>`
          : "";
        const response = htmlPage(
          title,
          `<div class="card"><h1>${escapeHtml(title)}</h1><p>${intro}</p>${who}<form method="post" action="${escapeHtml(
            url.pathname + url.search,
          )}"><input type="hidden" name="csrf" value="${escapeHtml(
            token,
          )}">${scopeRows}<p><button type="submit">${escapeHtml(
            options.consent?.approveLabel ?? "Allow",
          )}</button></p></form></div>`,
          200,
          lang,
        );
        response.headers.append(
          "Set-Cookie",
          `${CSRF_COOKIE}=${encodeURIComponent(nonce)}; Path=/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        );
        return response;
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const form = await formRequest?.formData().catch(() => null);
      const nonce = cookieValue(request.headers.get("Cookie"), CSRF_COOKIE);
      const token = form?.get("csrf");
      if (!(await csrfValid(secret, nonce, typeof token === "string" ? token : undefined))) {
        return htmlPage(
          title,
          '<div class="card"><h1>Invalid request</h1><p>The consent form expired. Go back and try again.</p></div>',
          403,
          lang,
        );
      }
      const selected = new Set(
        (form?.getAll("grant_scope") ?? [])
          .map(String)
          .filter((scope) => offeredScopes.includes(scope)),
      );
      for (const required of requiredScopes) selected.add(required);
      const grantedScopes = allScopes.filter((scope) => selected.has(scope));

      const { redirectTo } = await providerEnv.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: principal.id,
        metadata: { clientName, grantedAt: new Date().toISOString() },
        scope: grantedScopes,
        props: {
          userId: principal.id,
          label: principal.label,
          scope: grantedScopes,
          ...(principal.props ?? {}),
        },
      });
      const response = Response.redirect(redirectTo, 302);
      const headers = new Headers(response.headers);
      headers.append("Set-Cookie", `${CSRF_COOKIE}=; Path=/authorize; Max-Age=0`);
      return new Response(null, { status: 302, headers });
    },
  };
}

/**
 * OAuth 2.1 provider (authorization code + PKCE, dynamic client registration)
 * in front of an MCP endpoint, with a scope consent page.
 *
 * Requires a KV binding named `OAUTH_KV`.
 */
export function createVaultOAuthProvider<Env>(options: VaultOAuthOptions<Env>) {
  const scopesSupported = options.scopes.map((s) => s.name);
  return new OAuthProvider({
    apiRoute: options.apiRoute ?? "/mcp",
    apiHandler: options.apiHandler as never,
    defaultHandler: consentHandler(options) as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported,
    accessTokenTTL: options.accessTokenTTL ?? 60 * 60,
    refreshTokenTTL: options.refreshTokenTTL ?? 60 * 60 * 24 * 30,
    allowPlainPKCE: false,
    resourceMetadata: { resource_name: options.resourceName, scopes_supported: scopesSupported },
  });
}
