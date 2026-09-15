/** Identifies one LiveSync database (an Obsidian vault) owned by one tenant. */
export type VaultRef = {
  /** Data owner. A multi-tenant host passes its user id; a single-tenant deployment a fixed value. */
  tenantId: string;
  /** CouchDB database name the LiveSync client connects to. */
  databaseName: string;
};

/** Per-vault behaviour the host decides. Loaded again on every indexing pass. */
export type VaultPolicy = {
  /**
   * Vault paths hidden from external vault operations (MCP tools, the vault
   * client). Applies to reads, search results and writes. Each entry matches
   * the path itself and everything below it, e.g. ".kuro".
   */
  reservedPaths: string[];
  /** Folders excluded from search indexing. They stay readable. */
  excludedFolders: string[];
  /** IANA time zone used to resolve "today" for daily notes. */
  timeZone: string;
};

export const DEFAULT_VAULT_POLICY: VaultPolicy = {
  reservedPaths: [],
  excludedFolders: [],
  timeZone: "UTC",
};

/** Host-provided hooks: authentication and policy. */
export interface VaultHost {
  /** Verify a LiveSync Basic-auth credential and return the vault it grants. */
  verifyCredential(username: string, password: string): Promise<VaultRef | null>;
  /** Policy for a vault. Called from the Worker and from the Durable Object alarm. */
  loadVaultPolicy(ref: VaultRef): Promise<VaultPolicy>;
  /** Shared secret protecting the Worker → Durable Object internal API. */
  internalSecret: string;
  /** Extra CORS origins besides the Obsidian defaults and the Worker's own origin. */
  allowedOrigins?: string[];
  /** Vendor name reported by the CouchDB welcome endpoint and the auth realm. */
  serverName?: string;
}

/** Text embedding provider for semantic search. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * How vault vectors are kept apart inside one Vectorize index.
 * - "namespace": one Vectorize namespace per vault; needs no metadata index.
 * - "metadata": default namespace filtered by `userId`; requires a metadata
 *   index on `userId` (legacy layout).
 */
export type VectorIsolation = "namespace" | "metadata";

/** Cloudflare resources the library needs. Names are the host's choice. */
export interface VaultBindings {
  vaultDb: DurableObjectNamespace;
  vectorize: VectorizeIndex;
  bucket: R2Bucket;
  embedder: Embedder;
  vectorIsolation?: VectorIsolation;
}

export type DailyNoteSettings = {
  folder?: string;
  format?: string;
};

export function vaultObjectName(ref: VaultRef): string {
  return `${ref.tenantId}:${ref.databaseName}`;
}

export function parseVaultObjectName(name: string): VaultRef | null {
  const index = name.indexOf(":");
  if (index <= 0) return null;
  return { tenantId: name.slice(0, index), databaseName: name.slice(index + 1) };
}

export function isReservedPath(path: string, reservedPaths: string[]): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return reservedPaths.some((reserved) => {
    const base = reserved.replace(/^\/+|\/+$/g, "");
    return base !== "" && (normalized === base || normalized.startsWith(`${base}/`));
  });
}

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function dateStringIn(timeZone: string, date = new Date()): string {
  try {
    return date.toLocaleDateString("en-CA", { timeZone });
  } catch {
    return date.toLocaleDateString("en-CA", { timeZone: "UTC" });
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
