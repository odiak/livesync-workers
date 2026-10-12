import { afterEach, describe, expect, it, vi } from "vitest";
import { createVaultOAuthProvider } from "../src/oauth/index.js";

function setup(refreshTokenTTL?: number | null) {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string, options?: { type?: string }) {
      const value = store.get(key) ?? null;
      return value !== null && options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
  const env = { OAUTH_KV: kv as unknown as KVNamespace };
  const provider = createVaultOAuthProvider<typeof env>({
    refreshTokenTTL,
    apiHandler: { fetch: async (_request, _env, ctx) => Response.json(
      (ctx as ExecutionContext & { props: unknown }).props,
    ) },
    defaultHandler: { fetch: async () => new Response("app") },
    authenticate: async () => ({ id: "A" }),
    loginRedirect: () => new Response("login", { status: 401 }),
    scopes: [{ name: "vault:read", description: "read", required: true }, { name: "vault:write", description: "write" }],
    csrfSecret: () => "test-secret", resourceName: "Vault",
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const fetch = (request: Request) => provider.fetch(request, env, { ...ctx });
  return { fetch, store };
}

const origin = "https://vault.example";
const callback = "http://localhost:1234/callback";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function authorize(fetch: ReturnType<typeof setup>["fetch"]) {
  const registration = await fetch(new Request(`${origin}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [callback], token_endpoint_auth_method: "none" }),
  }));
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json<{ client_id: string }>();
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: "code", state: "state",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
  }).toString();
  const page = await fetch(new Request(url));
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  const html = await page.text();
  expect(html).toContain(callback);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const form = new URLSearchParams({ csrf });
  form.append("grant_scope", "vault:read");
  form.append("grant_scope", "vault:write");
  const approved = await fetch(new Request(url, {
    method: "POST", headers: { Cookie: page.headers.get("Set-Cookie")!.split(";")[0]!, "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  }));
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
  return { clientId, code };
}

async function token(fetch: ReturnType<typeof setup>["fetch"], body: Record<string, string>) {
  const response = await fetch(new Request(`${origin}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
  }));
  expect(response.status).toBe(200);
  return response.json<{ access_token: string; refresh_token: string; scope: string }>();
}

async function apiProps(fetch: ReturnType<typeof setup>["fetch"], accessToken: string) {
  const response = await fetch(new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } }));
  expect(response.status).toBe(200);
  return response.json<{ userId: string; scope: string[] }>();
}

describe("OAuth provider token scope enforcement", () => {
  it("passes the authorization-code token's narrowed scopes to the API", async () => {
    const { fetch } = setup();
    const { clientId, code } = await authorize(fetch);
    const issued = await token(fetch, {
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, scope: "vault:read",
    });
    expect(issued.scope).toBe("vault:read");
    expect((await apiProps(fetch, issued.access_token)).scope).toEqual(["vault:read"]);
  });

  it("narrows refresh-token scopes without shrinking the underlying grant", async () => {
    const { fetch } = setup();
    const { clientId, code } = await authorize(fetch);
    const issued = await token(fetch, {
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: callback,
    });
    expect((await apiProps(fetch, issued.access_token)).scope).toEqual(["vault:read", "vault:write"]);
    const narrowed = await token(fetch, {
      grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token, scope: "vault:read",
    });
    expect(narrowed.scope).toBe("vault:read");
    expect((await apiProps(fetch, narrowed.access_token)).scope).toEqual(["vault:read"]);
    const restored = await token(fetch, {
      grant_type: "refresh_token", client_id: clientId, refresh_token: narrowed.refresh_token,
    });
    expect((await apiProps(fetch, restored.access_token)).scope).toEqual(["vault:read", "vault:write"]);
  });
});


afterEach(() => vi.useRealTimers());

describe("OAuth refresh token lifetime", () => {
  it("keeps an indefinite grant refreshable after 31 days and rotates tokens", async () => {
    vi.useFakeTimers();
    const { fetch, store } = setup(null);
    const { clientId, code } = await authorize(fetch);
    const issued = await token(fetch, {
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: callback,
    });
    const grant = () => JSON.parse([...store.entries()].find(([key]) => key.startsWith("grant:"))![1]);
    expect(grant().expiresAt).toBeUndefined();
    vi.setSystemTime(Date.now() + 31 * 86400000);
    const refreshed = await token(fetch, {
      grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token,
    });
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
    expect(grant().expiresAt).toBeUndefined();
    expect((await apiProps(fetch, refreshed.access_token)).userId).toBe("A");
    expect(refreshed).toMatchObject({ expires_in: 3600 });
  });

  it("preserves the default 30-day expiry", async () => {
    vi.useFakeTimers();
    const { fetch } = setup();
    const { clientId, code } = await authorize(fetch);
    const issued = await token(fetch, {
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: callback,
    });
    vi.setSystemTime(Date.now() + 31 * 86400000);
    const response = await fetch(new Request(`${origin}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});
