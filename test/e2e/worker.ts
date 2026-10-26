// Isolated local E2E only; not referenced by production config.
import { LiveSyncVaultDO, handleLiveSyncRequest, DEFAULT_VAULT_POLICY, constantTimeEquals, INTERNAL_SECRET_HEADER, type VaultHost } from "livesync-workers";
type Env = { VAULT_DB: DurableObjectNamespace; CONTENT_BUCKET: R2Bucket; FTS_BUCKET: R2Bucket; SESSION_SECRET: string; E2E_PASSWORD: string };
function host(env: Env): VaultHost {
  return { internalSecret: env.SESSION_SECRET,
    async verifyCredential(user, password) { return ["a", "b"].includes(user) && constantTimeEquals(password, env.E2E_PASSWORD) ? { tenantId: "e2e", databaseName: `vault-${user}` } : null; },
    async loadVaultPolicy() { return DEFAULT_VAULT_POLICY; } };
}
function bindings(env: Env) { return { vaultDb: env.VAULT_DB, bucket: env.FTS_BUCKET, chunkBucket: env.CONTENT_BUCKET }; }
export class E2EVaultDO extends LiveSyncVaultDO<Env> {
  protected host() { return host(this.env); }
  protected bindings() { return bindings(this.env); }
}
export default { fetch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname === "/e2e/ready") return Response.json({ localE2E: true });
  // Harness-only: drives the vault's chunk garbage collection, as a host's admin tooling would.
  if (url.pathname === "/e2e/chunk-gc" && request.method === "POST") {
    const vault = url.searchParams.get("vault");
    if (!vault || !["a", "b"].includes(vault)) return new Response("unknown vault", { status: 404 });
    const stub = env.VAULT_DB.get(env.VAULT_DB.idFromName(`e2e:vault-${vault}`));
    return stub.fetch(new Request("https://db/internal/chunk-gc", {
      method: "POST", body: request.body,
      headers: { "Content-Type": "application/json", [INTERNAL_SECRET_HEADER]: env.SESSION_SECRET },
    }));
  }
  return handleLiveSyncRequest(request, { host: host(env), bindings: bindings(env) });
} };
