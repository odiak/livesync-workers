import { LiveSyncVaultDO } from "../../packages/livesync-workers/src/durable/livesync-db.js";
import { handleLiveSyncRequest } from "../../packages/livesync-workers/src/livesync/handler.js";
import { DEFAULT_VAULT_POLICY, type VaultHost, type VaultBindings } from "../../packages/livesync-workers/src/types.js";
export type TestEnv = {
  CONTENT: R2Bucket;
  SEARCH: R2Bucket;
  VAULT_DB: DurableObjectNamespace;
};
export const host: VaultHost = {
  internalSecret: "integration-secret",
  async verifyCredential(user, password) {
    return password === "integration-pass" && ["alice", "bob"].includes(user)
      ? { tenantId: user, databaseName: "vault" }
      : null;
  },
  async loadVaultPolicy() {
    return DEFAULT_VAULT_POLICY;
  },
};
export class PersistentVaultDO extends LiveSyncVaultDO<TestEnv> {
  protected host() {
    return host;
  }
  protected bindings(): VaultBindings {
    return {
      vaultDb: this.env.VAULT_DB,
      chunkBucket: this.env.CONTENT,
      chunkBodyThresholdBytes: 64,
      bucket: this.env.SEARCH,
    };
  }
}
export default {
  fetch(request: Request, env: TestEnv) {
    return handleLiveSyncRequest(request, { host, bindings: { vaultDb: env.VAULT_DB } });
  },
};
