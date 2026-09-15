export interface Env {
  VAULT_DB: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  FTS_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  LIVESYNC_DATABASE?: string;
  VAULT_TIMEZONE?: string;
  VAULT_EXCLUDED_FOLDERS?: string;
  APP_ORIGINS?: string;

  LIVESYNC_USERNAME?: string;
  LIVESYNC_PASSWORD?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  MCP_STATIC_TOKEN?: string;
}

export const TENANT_ID = "default";
