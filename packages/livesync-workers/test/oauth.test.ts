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
        async completeAuthorization() {
          return { redirectTo: "http://localhost:1234/callback?code=x" };
        },
      };
      return options.defaultHandler.fetch(request, { ...env, OAUTH_PROVIDER }, ctx);
    }
  },
}));

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

function provider() {
  return createVaultOAuthProvider<{ OAUTH_KV: unknown }>({
    apiHandler: { fetch: async () => new Response("api") },
    defaultHandler: { fetch: async () => new Response("app") },
    authenticate: async () => ({ id: "admin" }),
    loginRedirect: () => new Response(null, { status: 302, headers: { Location: "/login" } }),
    scopes: [{ name: "vault:read", description: "read", required: true }],
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

async function authorize(params: Record<string, string>) {
  const env = { OAUTH_KV: fakeKv() };
  return provider().fetch(new Request(authorizeUrl(params)), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
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
