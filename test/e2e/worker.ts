// Isolated local E2E only; not referenced by production config.
import { LiveSyncVaultDO, handleLiveSyncRequest, DEFAULT_VAULT_POLICY, constantTimeEquals, type VaultHost } from "livesync-workers";
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
  if (new URL(request.url).pathname === "/e2e/ready") return Response.json({ localE2E: true });
  return handleLiveSyncRequest(request, { host: host(env), bindings: bindings(env) });
} };
