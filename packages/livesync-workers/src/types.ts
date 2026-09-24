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
  /**
   * Also leave hidden paths (any folder or file name starting with ".", such as
   * ".obsidian/" or ".trash/") out of the search indexes. They stay readable.
   * Default false.
   */
  excludeHiddenPaths?: boolean;
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
  /**
   * Extra CORS origins besides the Obsidian defaults and the Worker's own origin.
   * "*" allows any origin (the request's Origin is echoed back, since LiveSync sends credentials).
   */
  allowedOrigins?: string[] | "*";
  /** Vendor name reported by the CouchDB welcome endpoint and the auth realm. */
  serverName?: string;
}

/** A note as handed to a {@link FullTextIndex}. */
export type FullTextNote = {
  path: string;
  content: string;
  /** sha256 hex of `content`. */
  contentHash: string;
  /** Obsidian mtime (ms), when the note carries one. */
  mtime: number | null;
};

export type FullTextSearchHit = {
  path: string;
  score: number;
  matchCount: number;
  snippets: Array<{ before: string; match: string; after: string }>;
};

/** Writes for one indexing pass; `close` is always called at the end of the pass. */
export interface FullTextIndexWriter {
  upsert(note: FullTextNote): Promise<void>;
  delete(path: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * An externally stored full-text index kept up to date one note at a time
 * (e.g. a search database). Replaces the built-in R2 index, which is rebuilt
 * in full inside the Durable Object.
 */
export interface FullTextIndex {
  /** Called lazily once per indexing pass that has something to write. */
  openWriter(ref: VaultRef): Promise<FullTextIndexWriter>;
  search(
    ref: VaultRef,
    query: string,
    limit: number,
  ): Promise<{
    hits: FullTextSearchHit[];
    /** Time of the newest index write (ms); 0 when unknown. */
    builtAt: number;
    docCount: number;
  }>;
  /** Drop everything indexed for the vault (the vault is being deleted). */
  deleteVault(ref: VaultRef): Promise<void>;
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
/**
 * A Durable Object namespace of any class. `wrangler types` generates
 * `DurableObjectNamespace<YourVaultDO>`, which a plain `DurableObjectNamespace`
 * does not accept.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDurableObjectNamespace = DurableObjectNamespace<any>;

export interface VaultBindings {
  vaultDb: AnyDurableObjectNamespace;
  vectorize: VectorizeIndex;
  /** Holds the built-in full-text index. Required unless `fullText` is given. */
  bucket?: R2Bucket;
  embedder: Embedder;
  vectorIsolation?: VectorIsolation;
  /**
   * External full-text index, updated per note as the vault changes. When set,
   * the built-in R2 index is not used at all.
   */
  fullText?: FullTextIndex;
  /**
   * Durable Object name for a vault. Default {@link vaultObjectName}
   * (`${tenantId}:${databaseName}`). A host that changes it must also override
   * `LiveSyncVaultDO.vaultRef()`, which otherwise parses the default name.
   */
  objectName?: (ref: VaultRef) => string;
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

/** Whether any folder or file name in the path starts with "." (".obsidian/…", ".trash/…"). */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
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
