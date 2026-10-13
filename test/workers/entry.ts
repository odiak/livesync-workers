import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withMcpSessionIsolation } from "../../packages/livesync-workers/src/mcp/sessions.js";
import { LiveSyncVaultDO } from "../../packages/livesync-workers/src/durable/livesync-db.js";
import { handleLiveSyncRequest } from "../../packages/livesync-workers/src/livesync/handler.js";
import { DEFAULT_VAULT_POLICY, type VaultHost, type VaultBindings } from "../../packages/livesync-workers/src/types.js";
export type TestEnv = {
  CONTENT: R2Bucket;
  SEARCH: R2Bucket;
  VAULT_DB: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
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
export class IntegrationMCP extends McpAgent<TestEnv, unknown, { userId: string; scope: string[] }> {
  server = new McpServer({ name: "integration", version: "1" });
  async init() {
    this.server.registerTool("identity", { description: "Return test principal" }, async () => ({
      content: [{ type: "text", text: this.props!.userId }],
    }));
  }
}
const mcp = withMcpSessionIsolation<TestEnv>(IntegrationMCP.serve("/mcp", { binding: "MCP_OBJECT" }) as unknown as ExportedHandler<TestEnv>, "MCP_OBJECT");
export default {
  fetch(request: Request<unknown, IncomingRequestCfProperties>, env: TestEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/mcp") {
      // Test-only principal injection; production obtains these from OAuth.
      Object.assign(ctx, { props: { userId: request.headers.get("x-test-user") ?? "alice", scope: (request.headers.get("x-test-scope") ?? "vault:read").split(" ") } });
      return mcp.fetch(request, env, ctx);
    }
    return handleLiveSyncRequest(request, { host, bindings: { vaultDb: env.VAULT_DB } });
  },
};
