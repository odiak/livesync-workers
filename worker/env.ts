export interface Env {
  VAULT_DB: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  FTS_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // Variables (wrangler.jsonc `vars`, or added in the dashboard).
  LIVESYNC_DATABASE?: string;
  LIVESYNC_USERNAME?: string;
  VAULT_EXCLUDED_FOLDERS?: string;
  /** Optional. Extra scopes for MCP_STATIC_TOKEN, e.g. "vault:append,vault:write". */
  MCP_STATIC_TOKEN_SCOPES?: string;

  // Secrets.
  LIVESYNC_PASSWORD?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  MCP_STATIC_TOKEN?: string;
}

export const TENANT_ID = "default";
