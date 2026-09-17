import { describe, expect, it, vi } from "vitest";

// The real provider imports `cloudflare:workers`, which Node cannot load.
// This stand-in keeps the parts the consent handler relies on, including the
// provider's own PKCE parsing (challenge optional, method defaulting to plain).
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    constructor(private readonly options: Record<string, any>) {}
    fetch(request: Request, env: Record<string, unknown>, ctx: unknown) {
      const options = this.options;
      const OAUTH_PROVIDER = {
        async parseAuthRequest(req: Request) {
          const url = new URL(req.url);
          const codeChallenge = url.searchParams.get("code_challenge") || undefined;
          const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "plain";
          if (codeChallengeMethod === "plain" && options.allowPlainPKCE === false) {
            throw new Error("The plain PKCE method is not allowed. Use S256 instead.");
          }
          return {
            clientId: url.searchParams.get("client_id") ?? "",
            redirectUri: url.searchParams.get("redirect_uri") ?? "",
            scope: (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
            state: url.searchParams.get("state") ?? "",
            codeChallenge,
            codeChallengeMethod,
          };
        },
        async lookupClient(clientId: string) {
          return (env.OAUTH_KV as ReturnType<typeof fakeKv>).get(`client:${clientId}`, { type: "json" });
        },
        async completeAuthorization(args: { scope: string[] }) {
          completed.push(args);
          return { redirectTo: "http://localhost:1234/callback?code=x" };
        },
      };
      return options.defaultHandler.fetch(request, { ...env, OAUTH_PROVIDER }, ctx);
    }
  },
}));

const completed: { scope: string[] }[] = [];

const { createVaultOAuthProvider } = await import("../src/oauth/index.js");

const client = {
  clientId: "test-client",
  clientName: "Test Client",
  redirectUris: ["http://localhost:1234/callback"],
  tokenEndpointAuthMethod: "none",
  registrationDate: 1,
};

function fakeKv() {
  const store = new Map<string, string>([[`client:${client.clientId}`, JSON.stringify(client)]]);
  return {
    async get(key: string, options?: { type?: string }) {
      const value = store.get(key) ?? null;
      return value !== null && options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true };
    },
  };
}

function provider(principal: { id: string; scopes?: string[] } = { id: "admin" }) {
  return createVaultOAuthProvider<{ OAUTH_KV: unknown }>({
    apiHandler: { fetch: async () => new Response("api") },
    defaultHandler: { fetch: async () => new Response("app") },
    authenticate: async () => principal,
    loginRedirect: () => new Response(null, { status: 302, headers: { Location: "/login" } }),
    scopes: [
      { name: "vault:read", description: "read", required: true },
      { name: "memory:read", description: "memory", default: true },
      { name: "vault:write", description: "write" },
    ],
    csrfSecret: () => "csrf-secret",
    resourceName: "Vault",
  });
}

function authorizeUrl(params: Record<string, string>) {
  const url = new URL("https://vault.example/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUris[0]!);
  url.searchParams.set("state", "s");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function authorize(
  params: Record<string, string>,
  principal?: { id: string; scopes?: string[] },
) {
  const env = { OAUTH_KV: fakeKv() };
  return provider(principal).fetch(new Request(authorizeUrl(params)), env, ctx);
}

const pkce = {
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
};

/** GET the consent page, then POST it back with the given scopes checked. */
async function consent(principal: { id: string; scopes?: string[] }, granted: string[]) {
  const env = { OAUTH_KV: fakeKv() };
  const p = provider(principal);
  const page = await p.fetch(new Request(authorizeUrl(pkce)), env, ctx);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const cookie = page.headers.get("Set-Cookie")!.split(";")[0]!;
  const form = new URLSearchParams();
  form.set("csrf", csrf);
  for (const scope of granted) form.append("grant_scope", scope);
  const before = completed.length;
  const response = await p.fetch(
    new Request(authorizeUrl(pkce), {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }),
    env,
    ctx,
  );
  return { html, response, granted: completed[before]?.scope };
}

describe("OAuth consent PKCE requirement", () => {
  it("shows the consent page for an S256 challenge", async () => {
    const response = await authorize({
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="grant_scope"');
  });

  it("rejects a request whose challenge is missing even if the method says S256", async () => {
    const response = await authorize({ code_challenge_method: "S256" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("PKCE is required");
  });

  it("rejects a request without any PKCE parameters", async () => {
    const response = await authorize({});
    expect(response.status).toBe(400);
  });

  it("rejects the plain method", async () => {
    const response = await authorize({ code_challenge: "abc", code_challenge_method: "plain" });
    expect(response.status).toBe(400);
  });
});

describe("OAuth consent per-principal scopes", () => {
  it("offers every scope when the principal does not narrow them", async () => {
    const { html, granted } = await consent({ id: "u" }, ["vault:read", "memory:read", "vault:write"]);
    expect(html).toContain('value="memory:read"');
    expect(html).toContain('value="vault:write"');
    expect(granted).toEqual(["vault:read", "memory:read", "vault:write"]);
  });

  it("hides scopes outside principal.scopes and refuses them on submit", async () => {
    const { html, response, granted } = await consent({ id: "u", scopes: ["vault:write"] }, [
      "vault:read",
      "memory:read",
      "vault:write",
    ]);
    expect(html).not.toContain('value="memory:read"');
    expect(html).toContain('value="vault:write"');
    expect(response.status).toBe(302);
    expect(granted).toEqual(["vault:read", "vault:write"]);
  });

  it("keeps required scopes even when principal.scopes omits them", async () => {
    const { html, granted } = await consent({ id: "u", scopes: [] }, []);
    expect(html).toContain('value="vault:read"');
    expect(granted).toEqual(["vault:read"]);
  });

  it("only offers requested scopes that the principal may hold", async () => {
    const response = await authorize({ ...pkce, scope: "vault:read memory:read" }, {
      id: "u",
      scopes: ["vault:write"],
    });
    const html = await response.text();
    expect(html).toContain('value="vault:read"');
    expect(html).not.toContain('value="memory:read"');
  });
});
