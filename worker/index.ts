import { LiveSyncVaultDO, handleLiveSyncRequest } from "livesync-workers";
import { VAULT_SCOPES, VAULT_SCOPE_DESCRIPTIONS } from "livesync-workers/mcp";
import { createVaultOAuthProvider } from "livesync-workers/oauth";
import type { Env } from "./env.js";
import {
  ConfigError,
  requireSecret,
  vaultBindings,
  vaultFor,
  vaultHost,
} from "./host.js";
import {
  checkAdminPassword,
  checkStaticToken,
  clearSessionCookie,
  createSessionCookie,
  isAdmin,
} from "./auth.js";
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

const mcpHandler = VaultMCP.serve("/mcp", { binding: "MCP_OBJECT" });

function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const appHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/livesync" || url.pathname.startsWith("/livesync/")) {
      return handleLiveSyncRequest(request, { host: vaultHost(env), bindings: vaultBindings(env) });
    }

    if (url.pathname === "/login") {
      const next = safeNext(url.searchParams.get("next"));
      if (request.method === "GET") return loginPage(next);
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        const password = String(form?.get("password") ?? "");
        const target = safeNext(String(form?.get("next") ?? next));
        if (!checkAdminPassword(env, password)) {
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
        livesync: !!(env.LIVESYNC_USERNAME && env.LIVESYNC_PASSWORD),
        admin: !!env.ADMIN_PASSWORD,
        session: !!env.SESSION_SECRET,
      };
      const data: Parameters<typeof statusPage>[1] = { origin: url.origin, admin, configured };
      if (admin) {
        data.username = env.LIVESYNC_USERNAME;
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
  consent: { title: "Allow access to your vault" },
});

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      // Static bearer token bypasses OAuth for clients that cannot do it.
      if (url.pathname === "/mcp" && checkStaticToken(env, request)) {
        const withProps = { ...ctx, props: { userId: "admin", label: "admin", scope: [...VAULT_SCOPES] } };
        return mcpHandler.fetch(request, env, withProps as unknown as ExecutionContext);
      }
      return await oauthProvider.fetch(
        request,
        env as Parameters<typeof oauthProvider.fetch>[1],
        ctx,
      );
    } catch (error) {
      if (error instanceof ConfigError) {
        return new Response(`Configuration error: ${error.message}`, { status: 500 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
