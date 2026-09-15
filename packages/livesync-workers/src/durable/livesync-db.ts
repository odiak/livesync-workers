import { hashText } from "../search/chunk-md.js";
import { removeNoteVectors, upsertNoteVectors } from "../search/vector-index.js";
import { deleteFtsIndex, markFtsPhase, rebuildFtsIndex } from "../search/fts-index.js";
import type { FtsDocInput } from "../search/fts/build.js";
import {
  CHANGES_IDLE_HEADER,
  DB_NAME_HEADER,
  INTERNAL_SECRET_HEADER,
  couchError,
  json,
  numberParam,
  secretEquals,
} from "../livesync/http.js";
import {
  DEFAULT_VAULT_POLICY,
  isReservedPath,
  parseVaultObjectName,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "../types.js";

type DocBody = Record<string, unknown>;

type DocRow = {
  id: string;
  winning_rev: string | null;
  deleted: number;
  updated_seq: number;
};

type RevRow = {
  id: string;
  rev: string;
  gen: number;
  parent_rev: string | null;
  body: string;
  body_chunked: number;
  body_available: number;
  deleted: number;
  seq: number;
  rev_history: string | null;
};

type LocalDocRow = {
  id: string;
  rev: string;
  body: string;
};

type ChangeRow = {
  seq: number;
  id: string;
  rev: string;
  deleted: number;
  revs?: string[];
};

type ChangeBatch = {
  rows: ChangeRow[];
  lastSeq: number;
};

type RevisionMetadata = {
  path: string | null;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

type LiveSyncFileRow = {
  path: string;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

type Selector = Record<string, unknown>;

type IndexStateRow = {
  path: string;
  doc_id: string | null;
  hash: string | null;
  chunks: number;
  pending: number;
  attempts: number;
};

type InternalOp = {
  op: string;
  path?: unknown;
  paths?: unknown;
  content?: unknown;
  expectedBaseHash?: unknown;
};

const INDEXED_SEQ_META_KEY = "indexed_seq";
const INDEX_VERSION_META_KEY = "index_version";
// Bump to force a one-time full re-embed (e.g. when vector metadata gains new fields).
const CURRENT_INDEX_VERSION = "2";
const INDEX_BATCH_SIZE = 200;
const INDEX_ALARM_DELAY_MS = 1_500;
const INDEX_RETRY_DELAY_MS = 30_000;
const INDEX_MAX_ATTEMPTS = 20;
const FTS_GENERATION_META_KEY = "fts_generation";
const FTS_REBUILD_AT_META_KEY = "fts_rebuild_at";
// Full FTS rebuilds are cheap at vault scale but write ~20 R2 objects, so
// wait for the vault to go quiet before rebuilding.
const FTS_REBUILD_DEBOUNCE_MS = 5 * 60_000;
const FTS_REBUILD_RETRY_MS = 60_000;
// Guard rails for the in-DO full rebuild: it must stay well under the DO CPU
// limit, so refuse pathological inputs instead of burning the isolate.
const FTS_MAX_TOTAL_BYTES = 50_000_000;
const FTS_MAX_NOTE_BYTES = 2_000_000;
// Chunk documents written by the server. The hash salt is a persisted format
// detail (chunk ids are content addressed); keep it stable.
const WRITE_CHUNK_PREFIX = "h:";
const WRITE_CHUNK_HASH_SALT = "kuro-chunk";
const WRITE_CHUNK_CODE_UNITS = 100_000;

const enc = new TextEncoder();
const inlineRevisionBodyMaxBytes = 1_000_000;
const revisionBodyChunkCodeUnits = 250_000;

export function splitRevisionBody(body: string): string[] | null {
  if (enc.encode(body).byteLength <= inlineRevisionBodyMaxBytes) return null;

  const chunks: string[] = [];
  for (let start = 0; start < body.length;) {
    let end = Math.min(start + revisionBodyChunkCodeUnits, body.length);
    const lastCodeUnit = body.charCodeAt(end - 1);
    if (end < body.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    chunks.push(body.slice(start, end));
    start = end;
  }
  return chunks;
}


function isExcludedByFolders(path: string, excludedFolders: string[]): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return excludedFolders.some(
    (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
  );
}

function isIndexableMarkdownPath(path: string, policy: VaultPolicy): boolean {
  return (
    path.endsWith(".md") &&
    !isReservedPath(path, policy.reservedPaths) &&
    !isExcludedByFolders(path, policy.excludedFolders)
  );
}


async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function isSafeVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function isNoteDoc(doc: DocBody): doc is DocBody & { path: string } {
  return typeof doc.path === "string" && doc.type !== "leaf" && doc.type !== "chunkpack";
}

function docIsDeleted(doc: DocBody): boolean {
  return doc._deleted === true || doc.deleted === true;
}

/** Split note content into LiveSync chunk pieces (surrogate-pair safe). */
export function splitNoteContentForChunks(content: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + WRITE_CHUNK_CODE_UNITS, content.length);
    const lastCodeUnit = content.charCodeAt(end - 1);
    if (end < content.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    pieces.push(content.slice(start, end));
    start = end;
  }
  return pieces;
}

async function writeChunkId(piece: string): Promise<string> {
  const digest = await hashText(`${WRITE_CHUNK_HASH_SALT}\n${piece.length}\n${piece}`);
  return `${WRITE_CHUNK_PREFIX}k${digest.slice(0, 40)}`;
}

/**
 * Derive a LiveSync document id for a path the way the plugin does without
 * path obfuscation: ids starting with "_" are prefixed with "/", and ids are
 * lower-cased when the vault appears to be using case-insensitive ids.
 */
function noteDocIdForPath(path: string, caseInsensitive: boolean): string {
  let id = caseInsensitive ? path.toLowerCase() : path;
  if (id.startsWith("_")) id = `/${id}`;
  return id;
}

function revisionMetadata(doc: DocBody): RevisionMetadata {
  return {
    path: typeof doc.path === "string" ? doc.path : null,
    size: typeof doc.size === "number" ? doc.size : null,
    mtime: typeof doc.mtime === "number" ? doc.mtime : null,
    type: typeof doc.type === "string" ? doc.type : null,
  };
}

function parseRev(rev: string): { gen: number; hash: string } | null {
  const match = /^(\d+)-(.+)$/.exec(rev);
  if (!match) return null;
  return { gen: Number(match[1]), hash: match[2]! };
}

function withoutMeta(doc: DocBody): DocBody {
  const out: DocBody = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== "_rev" && key !== "_revisions" && key !== "_conflicts") {
      out[key] = value;
    }
  }
  return out;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(",")}}`;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function newRevision(doc: DocBody, parentRev: string | null): Promise<string> {
  const parent = parentRev ? parseRev(parentRev) : null;
  const gen = (parent?.gen ?? 0) + 1;
  const hash = await sha1Hex(`${stableJson(withoutMeta(doc))}\n${parentRev ?? ""}`);
  return `${gen}-${hash.slice(0, 32)}`;
}

function docIdFromBody(doc: DocBody): string | null {
  return typeof doc._id === "string" && doc._id ? doc._id : null;
}

function cloneBody(row: RevRow): DocBody {
  return JSON.parse(row.body) as DocBody;
}

function normalizeSince(value: unknown, currentSeq: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value === "now") return currentSeq;
  return 0;
}


function boolParam(value: unknown): boolean {
  return value === true || value === "true";
}

function allDocsKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parentFromRevisions(doc: DocBody): string | null {
  const rev = typeof doc._rev === "string" ? parseRev(doc._rev) : null;
  const revisions = doc._revisions as
    | { start?: unknown; ids?: unknown }
    | undefined;
  if (!rev || !revisions || !Array.isArray(revisions.ids)) return null;
  const ids = revisions.ids.filter((id): id is string => typeof id === "string");
  if (ids.length < 2) return null;
  return `${rev.gen - 1}-${ids[1]}`;
}

function revisionHistory(doc: DocBody, rev: string, parentHistory?: string | null): string {
  const existing = doc._revisions;
  if (existing && typeof existing === "object") return JSON.stringify(existing);
  const parsed = parseRev(rev);
  if (!parsed) return JSON.stringify({ start: 1, ids: [rev] });
  if (parentHistory) {
    try {
      const parent = JSON.parse(parentHistory) as { ids?: unknown };
      const parentIds = Array.isArray(parent.ids)
        ? parent.ids.filter((id): id is string => typeof id === "string")
        : [];
      return JSON.stringify({ start: parsed.gen, ids: [parsed.hash, ...parentIds] });
    } catch {
      // Fall through to a single-revision history.
    }
  }
  return JSON.stringify({ start: parsed.gen, ids: [parsed.hash] });
}

function bodyWithRevisions(row: RevRow): DocBody {
  const body = cloneBody(row);
  if (row.rev_history) {
    body._revisions = JSON.parse(row.rev_history);
  }
  return body;
}

function compareWinning(a: RevRow, b: RevRow): number {
  if (a.deleted !== b.deleted) return a.deleted ? -1 : 1;
  if (a.gen !== b.gen) return a.gen - b.gen;
  return compareCodePoints(a.rev, b.rev);
}

function compareCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a, (char) => char.codePointAt(0)!);
  const bPoints = Array.from(b, (char) => char.codePointAt(0)!);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (aPoints[index] !== bPoints[index]) return aPoints[index]! - bPoints[index]!;
  }
  return aPoints.length - bPoints.length;
}

function getField(doc: DocBody, field: string): unknown {
  if (field === "_id") return doc._id;
  if (field === "_rev") return doc._rev;
  return field.split(".").reduce<unknown>((value, key) => {
    if (value == null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, doc);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareCodePoints(String(a), String(b));
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition == null || typeof condition !== "object" || Array.isArray(condition)) {
    return value === condition;
  }
  for (const [op, expected] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "$eq":
        if (value !== expected) return false;
        break;
      case "$ne":
        if (value === expected) return false;
        break;
      case "$lt":
        if (compareValues(value, expected) >= 0) return false;
        break;
      case "$lte":
        if (compareValues(value, expected) > 0) return false;
        break;
      case "$gt":
        if (compareValues(value, expected) <= 0) return false;
        break;
      case "$gte":
        if (compareValues(value, expected) < 0) return false;
        break;
      case "$exists":
        if ((value !== undefined) !== Boolean(expected)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected) || !expected.includes(value)) return false;
        break;
      case "$nin":
        if (Array.isArray(expected) && expected.includes(value)) return false;
        break;
      case "$regex":
        if (typeof value !== "string" || typeof expected !== "string") return false;
        try {
          if (!new RegExp(expected).test(value)) return false;
        } catch {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function matchesSelector(doc: DocBody, selector: Selector | null): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  for (const [field, condition] of Object.entries(selector)) {
    if (field === "$and") {
      if (!Array.isArray(condition)) return false;
      if (!condition.every((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (field === "$or") {
      if (!Array.isArray(condition)) return false;
      if (!condition.some((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (!matchesCondition(getField(doc, field), condition)) return false;
  }
  return true;
}


/**
 * Durable Object holding one LiveSync database (vault) in SQLite and keeping
 * its search indexes up to date. Hosts subclass it, export the subclass from
 * their Worker and bind it as a SQLite-backed Durable Object class:
 *
 *   export class VaultDO extends LiveSyncVaultDO<Env> {
 *     protected host() { return myHost(this.env); }
 *     protected bindings() { return myBindings(this.env); }
 *   }
 */
export abstract class LiveSyncVaultDO<TEnv = unknown> {
  /** Last successful setAlarm, as a cheap time-based throttle (never a hard gate). */
  private lastIndexScheduleAt = 0;

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: TEnv,
  ) {
    this.init();
  }

  protected abstract host(): VaultHost;
  protected abstract bindings(): VaultBindings;

  private init(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        winning_rev TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_seq INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS revs (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        gen INTEGER NOT NULL,
        parent_rev TEXT,
        body TEXT NOT NULL,
        body_chunked INTEGER NOT NULL DEFAULT 0,
        body_available INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL,
        rev_history TEXT,
        PRIMARY KEY (id, rev)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS local_docs (
        id TEXT PRIMARY KEY,
        rev TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS rev_body_chunks (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (id, rev, chunk_index)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS rev_metadata (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        path TEXT,
        size REAL,
        mtime REAL,
        type TEXT,
        PRIMARY KEY (id, rev)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const schemaVersion = sql.exec<{ version: number }>(
      `SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations`,
    ).one().version;
    const revisionColumns = new Set(
      sql.exec<{ name: string }>(`PRAGMA table_info(revs)`).toArray().map((column) => column.name),
    );
    if (schemaVersion < 1) {
      this.ctx.storage.transactionSync(() => {
        if (!revisionColumns.has("body_chunked")) {
          sql.exec(`ALTER TABLE revs ADD COLUMN body_chunked INTEGER NOT NULL DEFAULT 0`);
        }
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (1)`);
      });
    }
    if (schemaVersion < 2) {
      this.ctx.storage.transactionSync(() => {
        if (!revisionColumns.has("body_available")) {
          sql.exec(`ALTER TABLE revs ADD COLUMN body_available INTEGER NOT NULL DEFAULT 1`);
        }
        sql.exec(
          `UPDATE revs SET body_available = 0
           WHERE body = '{}' AND body_chunked = 0
             AND EXISTS (
               SELECT 1 FROM revs child
               WHERE child.id = revs.id AND child.parent_rev = revs.rev
             )`,
        );
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (2)`);
      });
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        path TEXT PRIMARY KEY,
        doc_id TEXT,
        hash TEXT,
        chunks INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_id ON revs (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_parent ON revs (id, parent_rev)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_changes_id ON changes (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_docs_updated_seq ON docs (updated_seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_rev_metadata_path ON rev_metadata (path)`);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      // Existing databases (created before indexing existed, or indexed under an
      // older index version) catch up on first access.
      if (
        Date.now() - this.lastIndexScheduleAt > 5_000 &&
        this.dbExists() &&
        (this.indexNeedsVersionUpgrade() || this.indexedSeq() < this.currentSeq())
      ) {
        void this.scheduleIndexing();
      }
      if (url.pathname.startsWith("/internal/")) {
        if (!secretEquals(request.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) {
          return couchError(403, "forbidden", "Forbidden");
        }
        if (url.pathname === "/internal/watch" && request.method === "GET") {
          if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return couchError(426, "upgrade_required", "Expected WebSocket");
          }
          return this.acceptWatcher();
        }
        if (url.pathname === "/internal/purge" && request.method === "POST") {
          return this.deleteDb();
        }
        if (url.pathname === "/internal/files" && request.method === "GET") {
          return this.listFiles();
        }
        if (url.pathname === "/internal/file" && request.method === "GET") {
          return this.readFile(url.searchParams.get("path") ?? "");
        }
        if (url.pathname === "/internal/op" && request.method === "POST") {
          return this.handleInternalOp((await readJsonBody(request)) as InternalOp);
        }
        return couchError(404, "not_found", "missing");
      }

      const dbName = request.headers.get(DB_NAME_HEADER) ?? "livesync";

      if (parts.length === 0) {
        if (request.method === "HEAD") return this.hasDbHead();
        if (request.method === "GET") return this.dbInfo(dbName);
        if (request.method === "PUT") return this.putDb(dbName);
        if (request.method === "DELETE") return this.deleteDb();
      }

      const first = parts[0]!;
      if (first === "_changes" && (request.method === "GET" || request.method === "POST")) {
        return this.handleChanges(request);
      }
      if (first === "_revs_diff" && request.method === "POST") return this.handleRevsDiff(request);
      if (first === "_bulk_docs" && request.method === "POST") return this.handleBulkDocs(request);
      if (first === "_bulk_get" && request.method === "POST") return this.handleBulkGet(request);
      if (first === "_all_docs" && (request.method === "GET" || request.method === "POST")) {
        return this.handleAllDocs(request);
      }
      if (first === "_find" && request.method === "POST") return this.handleFind(request);
      if (first === "_compact" && request.method === "POST") return this.handleCompact();

      if (first === "_local") {
        const id = decodeURIComponent(parts.slice(1).join("/"));
        return this.handleLocalDoc(request, id);
      }

      const id = decodeURIComponent(parts.join("/"));
      return this.handleDoc(request, id);
    } catch (error) {
      console.warn("LiveSync DB request failed", error);
      return couchError(500, "internal_server_error", "Internal server error");
    }
  }

  private rows<T>(query: string, ...args: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...args).toArray() as T[];
  }

  private first<T>(query: string, ...args: unknown[]): T | null {
    return this.rows<T>(query, ...args)[0] ?? null;
  }

  private getMeta(key: string): string | null {
    return this.first<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private dbExists(): boolean {
    return this.getMeta("created") === "1";
  }

  private requireDb(): Response | null {
    return this.dbExists() ? null : couchError(404, "not_found", "Database does not exist.");
  }

  private hasDbHead(): Response {
    return new Response(null, { status: this.dbExists() ? 200 : 404 });
  }

  private putDb(dbName: string): Response {
    if (this.dbExists()) {
      return couchError(
        412,
        "file_exists",
        "The database could not be created, the file already exists.",
      );
    }
    this.setMeta("created", "1");
    this.setMeta("db_name", dbName);
    return json({ ok: true });
  }

  private async deleteDb(): Promise<Response> {
    await this.removeAllVectors();
    const ref = this.vaultRef();
    if (ref) {
      await deleteFtsIndex(this.bindings().bucket, ref).catch((error) =>
        console.warn("FTS index cleanup failed", error),
      );
    }
    this.ctx.storage.sql.exec(`DELETE FROM docs`);
    this.ctx.storage.sql.exec(`DELETE FROM rev_body_chunks`);
    this.ctx.storage.sql.exec(`DELETE FROM rev_metadata`);
    this.ctx.storage.sql.exec(`DELETE FROM revs`);
    this.ctx.storage.sql.exec(`DELETE FROM local_docs`);
    this.ctx.storage.sql.exec(`DELETE FROM changes`);
    this.ctx.storage.sql.exec(`DELETE FROM meta`);
    this.ctx.storage.sql.exec(`DELETE FROM index_state`);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------------
  // Internal API (used by the vault client, never exposed to LiveSync)
  // ---------------------------------------------------------------------

  private async handleInternalOp(body: InternalOp): Promise<Response> {
    switch (body.op) {
      case "listMarkdownPaths": {
        const missing = this.requireDb();
        if (missing) return json({ paths: [] });
        return json({
          paths: this.listNoteFiles()
            .map((file) => file.path)
            .filter((path) => path.endsWith(".md") && !path.startsWith("i:")),
        });
      }
      case "listNoteStats": {
        const missing = this.requireDb();
        if (missing) return json({ files: [] });
        return json({
          files: this.listNoteFiles()
            .filter((file) => file.path.endsWith(".md") && !file.path.startsWith("i:"))
            .map((file) => ({ path: file.path, mtime: file.mtime, size: file.size })),
        });
      }
      case "readNote": {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path || !this.dbExists()) return json({ content: null });
        // Hidden files synced by LiveSync ("internal files") carry an "i:" prefix.
        const content = this.fileContent(path) ?? this.fileContent(`i:${path}`);
        return json({ content });
      }
      case "readNotes": {
        // Batch read for FTS snippets: one DO round trip for all hits.
        const paths = Array.isArray(body.paths)
          ? body.paths
              .filter((p): p is string => typeof p === "string")
              .slice(0, 50)
          : [];
        const contents: Record<string, string | null> = {};
        for (const path of paths) contents[path] = null;
        if (this.dbExists() && paths.length > 0) {
          // Single pass over winning revisions; per-path lookups would repeat
          // the JSON-scan fallback that once blew the DO CPU limit.
          const wanted = new Set(paths);
          for (const row of this.listNoteRevisionsForFts()) {
            if (wanted.has(row.fts_path) && contents[row.fts_path] == null) {
              contents[row.fts_path] = this.fileContentForRow(row);
            }
          }
        }
        return json({ contents });
      }
      case "writeNote":
        return this.writeNote(body);
      case "reindex":
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        this.armFtsRebuild(0);
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "ftsRebuild":
        this.armFtsRebuild(0);
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "indexStatus":
        return json({
          indexedSeq: this.indexedSeq(),
          currentSeq: this.currentSeq(),
          indexed: this.first<{ count: number }>(
            `SELECT COUNT(*) AS count FROM index_state WHERE pending = 0`,
          )?.count ?? 0,
          pending: this.first<{ count: number }>(
            `SELECT COUNT(*) AS count FROM index_state WHERE pending = 1`,
          )?.count ?? 0,
          fts: {
            generation: this.getMeta(FTS_GENERATION_META_KEY),
            rebuildAt: Number(this.getMeta(FTS_REBUILD_AT_META_KEY)) || null,
          },
        });
      default:
        return json({ error: "Unknown op" }, { status: 400 });
    }
  }

  private async writeNote(body: InternalOp): Promise<Response> {
    const path = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : null;
    const expectedBaseHash =
      typeof body.expectedBaseHash === "string" ? body.expectedBaseHash : "";
    if (!path.endsWith(".md") || !isSafeVaultPath(path) || content == null) {
      return json({ error: "Invalid Markdown note path" }, { status: 400 });
    }
    if (!this.dbExists()) {
      return json({ error: "LiveSync database does not exist" }, { status: 409 });
    }

    const existing = this.findNoteRow(path);
    const existingDoc = existing ? cloneBody(existing) : null;
    if (expectedBaseHash) {
      const currentContent = existing ? (this.fileContentForRow(existing) ?? "") : "";
      if ((await hashText(currentContent)) !== expectedBaseHash) {
        return json({ error: "CONFLICT", path }, { status: 409 });
      }
    }

    const pieces = splitNoteContentForChunks(content);
    const children: string[] = [];
    for (const piece of pieces) {
      const chunkId = await writeChunkId(piece);
      children.push(chunkId);
      const current = this.rawWinningRow(chunkId);
      if (current && !current.deleted) continue;
      const result = await this.insertRevision(
        { _id: chunkId, type: "leaf", data: piece },
        { newEdits: true },
      );
      if (!result.ok) {
        return json({ error: "WRITE_FAILED", path, reason: result.reason }, { status: 500 });
      }
    }

    const now = Date.now();
    const noteDoc: DocBody = {
      _id: existing?.id ?? noteDocIdForPath(path, this.usesCaseInsensitiveIds()),
      path,
      children,
      ctime:
        typeof existingDoc?.ctime === "number" && !docIsDeleted(existingDoc)
          ? existingDoc.ctime
          : now,
      mtime: now,
      size: enc.encode(content).byteLength,
      type: "plain",
      eden: {},
    };
    if (existing) noteDoc._rev = existing.rev;
    const result = await this.insertRevision(noteDoc, { newEdits: true });
    if (!result.ok) {
      const status = result.error === "conflict" ? 409 : 500;
      return json(
        { error: status === 409 ? "CONFLICT" : "WRITE_FAILED", path, reason: result.reason },
        { status },
      );
    }
    return json({ ok: true, path, rev: result.rev });
  }

  /** True when existing note ids look lower-cased relative to their paths. */
  private usesCaseInsensitiveIds(): boolean {
    const row = this.first<{ id: string; path: string }>(
      `SELECT d.id, m.path
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       WHERE m.path IS NOT NULL AND m.path != lower(m.path)
       LIMIT 1`,
    );
    if (!row) return false;
    return row.id !== row.path && row.id.replace(/^\//, "") === row.path.toLowerCase();
  }

  private listNoteFiles(): LiveSyncFileRow[] {
    const files = this.rows<LiveSyncFileRow>(
      `SELECT m.path, m.size, m.mtime, m.type
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0 AND m.path IS NOT NULL
         AND COALESCE(m.type, '') NOT IN ('leaf', 'chunkpack')
         AND (r.body_chunked = 1 OR COALESCE(json_extract(r.body, '$.deleted'), 0) != 1)`,
    );
    files.push(...this.rows<LiveSyncFileRow>(
      `SELECT
         json_extract(r.body, '$.path') AS path,
         json_extract(r.body, '$.size') AS size,
         json_extract(r.body, '$.mtime') AS mtime,
         json_extract(r.body, '$.type') AS type
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.body_chunked = 0
         AND json_type(r.body, '$.path') = 'text'
         AND COALESCE(json_extract(r.body, '$.deleted'), 0) != 1
         AND NOT EXISTS (
           SELECT 1 FROM rev_metadata m WHERE m.id = r.id AND m.rev = r.rev
         )`,
    ));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  private findNoteRow(path: string): RevRow | null {
    let row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev
       WHERE d.deleted = 0 AND m.path = ?
       LIMIT 1`,
      path,
    );
    if (!row) row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.body_chunked = 0
         AND json_extract(r.body, '$.path') = ?
       LIMIT 1`,
      path,
    );
    if (!row) return null;
    const hydrated = this.hydrateRevision(row);
    return docIsDeleted(cloneBody(hydrated)) ? null : hydrated;
  }

  private fileContent(path: string): string | null {
    const row = this.findNoteRow(path);
    return row ? this.fileContentForRow(row) : null;
  }

  /** Reassemble a note's content from inline data or child chunks. */
  private fileContentForRow(row: RevRow): string | null {
    const doc = cloneBody(this.hydrateRevision(row));
    if (typeof doc.data === "string") return doc.data;
    if (Array.isArray(doc.data) && doc.data.every((piece) => typeof piece === "string")) {
      return (doc.data as string[]).join("");
    }
    const children = Array.isArray(doc.children)
      ? doc.children.filter((id): id is string => typeof id === "string")
      : [];
    if (children.length === 0) return typeof doc.children === "undefined" ? null : "";

    const eden =
      doc.eden && typeof doc.eden === "object"
        ? (doc.eden as Record<string, { data?: unknown }>)
        : {};
    const chunks = this.rows<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(children),
    );
    const dataById = new Map(
      chunks.map((chunk) => {
        const body = cloneBody(this.hydrateRevision(chunk));
        return [chunk.id, typeof body.data === "string" ? body.data : null];
      }),
    );
    const content = children.map((id) => {
      const stored = dataById.get(id);
      if (typeof stored === "string") return stored;
      const edenChunk = eden[id];
      return typeof edenChunk?.data === "string" ? edenChunk.data : null;
    });
    return content.every((chunk): chunk is string => typeof chunk === "string")
      ? content.join("")
      : null;
  }

  // ---------------------------------------------------------------------
  // Vectorize indexing (runs in the alarm, driven by the changes feed)
  // ---------------------------------------------------------------------

  /** The vault this object holds, recovered from the object name. */
  protected vaultRef(): VaultRef | null {
    const name = this.ctx.id?.name;
    return name ? parseVaultObjectName(name) : null;
  }

  private async loadPolicy(ref: VaultRef): Promise<VaultPolicy> {
    try {
      return await this.host().loadVaultPolicy(ref);
    } catch (error) {
      console.warn("loadVaultPolicy failed; using defaults", error);
      return DEFAULT_VAULT_POLICY;
    }
  }

  private indexedSeq(): number {
    return Number(this.getMeta(INDEXED_SEQ_META_KEY) ?? "0") || 0;
  }

  private async scheduleIndexing(delayMs = INDEX_ALARM_DELAY_MS): Promise<void> {
    const storage = this.ctx.storage as Partial<DurableObjectStorage>;
    if (typeof storage.setAlarm !== "function" || !this.vaultRef()) return;
    try {
      const existing = typeof storage.getAlarm === "function" ? await storage.getAlarm() : null;
      const at = Date.now() + delayMs;
      // Reschedule when the stored alarm is in the past: a crash-looped alarm
      // the platform has given up on otherwise blocks every future setAlarm.
      if (existing == null || existing > at || existing <= Date.now()) {
        await storage.setAlarm(at);
      }
      this.lastIndexScheduleAt = Date.now();
    } catch (error) {
      console.warn("Failed to schedule LiveSync indexing", error);
    }
  }

  async alarm(): Promise<void> {
    console.log("LiveSync alarm fired", {
      indexedSeq: this.indexedSeq(),
      ftsRebuildAt: this.getMeta(FTS_REBUILD_AT_META_KEY),
    });
    try {
      const { more, retry, worked } = await this.runIndexing();
      if (more) await this.scheduleIndexing(0);
      else if (retry) await this.scheduleIndexing(INDEX_RETRY_DELAY_MS);
      // The FTS rebuild runs in an alarm event of its own: a crashing rebuild
      // must not roll back the vector-indexing progress made above (SQLite DO
      // events are transactional), so defer it whenever this event did work.
      if (more || worked) await this.scheduleIndexing(0);
      else await this.maybeRunFtsRebuild();
    } catch (error) {
      console.warn("LiveSync indexing failed", error);
      await this.scheduleIndexing(INDEX_RETRY_DELAY_MS);
    }
  }

  private indexNeedsVersionUpgrade(): boolean {
    return this.getMeta(INDEX_VERSION_META_KEY) !== CURRENT_INDEX_VERSION;
  }

  private async runIndexing(): Promise<{
    more: boolean;
    retry: boolean;
    worked: boolean;
  }> {
    const ref = this.vaultRef();
    if (!ref || !this.dbExists()) return { more: false, retry: false, worked: false };
    if (this.indexNeedsVersionUpgrade()) {
      // Clearing hashes defeats the unchanged-note skip below, so every note is
      // re-embedded once under the new index version.
      this.ctx.storage.sql.exec(`UPDATE index_state SET hash = NULL`);
      this.setMeta(INDEXED_SEQ_META_KEY, "0");
      this.setMeta(INDEX_VERSION_META_KEY, CURRENT_INDEX_VERSION);
    }
    const policy = await this.loadPolicy(ref);

    const since = this.indexedSeq();
    const changes = this.rows<ChangeRow>(
      `SELECT seq, id, rev, deleted FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`,
      since,
      INDEX_BATCH_SIZE,
    );
    const ids = new Set(changes.map((change) => change.id));
    const pendingRows = this.rows<IndexStateRow>(
      `SELECT * FROM index_state WHERE pending = 1 AND attempts < ?`,
      INDEX_MAX_ATTEMPTS,
    );

    // Paths whose winning doc changed in this batch.
    const touchedPaths = new Map<string, RevRow | null>();
    for (const id of ids) {
      const row = this.rawWinningRow(id);
      if (!row) continue;
      const hydrated = this.hydrateRevision(row);
      const doc = cloneBody(hydrated);
      if (isNoteDoc(doc)) {
        touchedPaths.set(doc.path, row.deleted || docIsDeleted(doc) ? null : hydrated);
        continue;
      }
      // Tombstones carry no path; recover it from the index state or an earlier revision.
      const previousPath =
        this.first<{ path: string }>(`SELECT path FROM index_state WHERE doc_id = ?`, id)?.path ??
        this.first<{ path: string }>(
          `SELECT path FROM rev_metadata WHERE id = ? AND path IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
          id,
        )?.path;
      if (previousPath && !touchedPaths.has(previousPath)) {
        touchedPaths.set(previousPath, this.findNoteRow(previousPath));
      }
    }
    for (const pending of pendingRows) {
      if (!touchedPaths.has(pending.path)) {
        touchedPaths.set(pending.path, this.findNoteRow(pending.path));
      }
    }
    // Chunk arrivals do not carry a path; re-check pending notes on any change.
    let retry = false;
    for (const [path, row] of touchedPaths) {
      const state = this.first<IndexStateRow>(`SELECT * FROM index_state WHERE path = ?`, path);
      const indexable = row != null && isIndexableMarkdownPath(path, policy);
      if (!indexable) {
        if (state) {
          await removeNoteVectors(this.bindings(), { ref, path, chunks: state.chunks });
          this.ctx.storage.sql.exec(`DELETE FROM index_state WHERE path = ?`, path);
        }
        continue;
      }
      const content = this.fileContentForRow(row);
      if (content == null) {
        // Chunks not replicated yet; mark pending and retry later.
        this.ctx.storage.sql.exec(
          `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
           VALUES (?, ?, NULL, 0, 1, 1)
           ON CONFLICT(path) DO UPDATE SET
             doc_id = excluded.doc_id, pending = 1, attempts = index_state.attempts + 1`,
          path,
          row.id,
        );
        retry = true;
        continue;
      }
      const hash = await hashText(content);
      if (state && !state.pending && state.hash === hash) continue;
      const chunks = await upsertNoteVectors(this.bindings(), {
        ref,
        path,
        content,
        hash,
        previousChunks: state?.chunks ?? 0,
      });
      this.ctx.storage.sql.exec(
        `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
         VALUES (?, ?, ?, ?, 0, 0)
         ON CONFLICT(path) DO UPDATE SET
           doc_id = excluded.doc_id, hash = excluded.hash, chunks = excluded.chunks,
           pending = 0, attempts = 0`,
        path,
        row.id,
        hash,
        chunks,
      );
    }

    const lastSeq = changes.at(-1)?.seq ?? since;
    if (lastSeq > since) {
      this.setMeta(INDEXED_SEQ_META_KEY, String(lastSeq));
      this.armFtsRebuild(FTS_REBUILD_DEBOUNCE_MS);
    }
    return {
      more: changes.length >= INDEX_BATCH_SIZE,
      retry,
      worked: changes.length > 0,
    };
  }

  // ---------------------------------------------------------------------
  // R2 full-text index (debounced full rebuild, piggybacking on the alarm)
  // ---------------------------------------------------------------------

  private armFtsRebuild(delayMs: number): void {
    this.setMeta(FTS_REBUILD_AT_META_KEY, String(Date.now() + delayMs));
  }

  private async maybeRunFtsRebuild(): Promise<void> {
    if (!this.vaultRef() || !this.dbExists()) return;
    const dueRaw = this.getMeta(FTS_REBUILD_AT_META_KEY);
    let due = dueRaw ? Number(dueRaw) : null;
    if (due == null) {
      if (this.getMeta(FTS_GENERATION_META_KEY)) return;
      due = Date.now(); // Vault exists but was never FTS-indexed.
    }
    if (Date.now() < due) {
      await this.scheduleIndexing(due - Date.now());
      return;
    }
    try {
      await this.runFtsRebuild();
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_AT_META_KEY);
    } catch (error) {
      console.warn("FTS rebuild failed", error);
      this.armFtsRebuild(FTS_REBUILD_RETRY_MS);
      await this.scheduleIndexing(FTS_REBUILD_RETRY_MS);
    }
  }

  /**
   * Winning note revisions with their paths in one pass. Per-path lookups
   * (findNoteRow) are unusable here: their fallback JSON-scans every winning
   * rev body per call, which blows the DO CPU limit on a full rebuild.
   */
  private listNoteRevisionsForFts(): Array<
    RevRow & { fts_path: string; fts_mtime: number | null }
  > {
    type FtsRevRow = RevRow & { fts_path: string; fts_mtime: number | null };
    const rows = this.rows<FtsRevRow>(
      `SELECT r.*, m.path AS fts_path, m.mtime AS fts_mtime
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0 AND m.path IS NOT NULL
         AND COALESCE(m.type, '') NOT IN ('leaf', 'chunkpack')
         AND (r.body_chunked = 1 OR COALESCE(json_extract(r.body, '$.deleted'), 0) != 1)`,
    );
    rows.push(...this.rows<FtsRevRow>(
      `SELECT r.*,
         json_extract(r.body, '$.path') AS fts_path,
         json_extract(r.body, '$.mtime') AS fts_mtime
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.body_chunked = 0
         AND json_type(r.body, '$.path') = 'text'
         AND COALESCE(json_extract(r.body, '$.type'), '') NOT IN ('leaf', 'chunkpack')
         AND COALESCE(json_extract(r.body, '$.deleted'), 0) != 1
         AND NOT EXISTS (
           SELECT 1 FROM rev_metadata m WHERE m.id = r.id AND m.rev = r.rev
         )`,
    ));
    return rows;
  }

  private async runFtsRebuild(): Promise<void> {
    const ref = this.vaultRef();
    if (!ref) return;
    const bucket = this.bindings().bucket;
    await markFtsPhase(bucket, ref, "gather-start");
    const policy = await this.loadPolicy(ref);
    const docs: FtsDocInput[] = [];
    let totalBytes = 0;
    for (const row of this.listNoteRevisionsForFts()) {
      const path = row.fts_path;
      if (!path.endsWith(".md") || path.startsWith("i:")) continue;
      if (!isIndexableMarkdownPath(path, policy)) continue;
      const content = this.fileContentForRow(row);
      if (content == null) continue;
      if (content.length > FTS_MAX_NOTE_BYTES) {
        console.warn("FTS rebuild skipping oversized note", { path });
        continue;
      }
      totalBytes += content.length;
      if (totalBytes > FTS_MAX_TOTAL_BYTES) {
        // Too big for the in-DO rebuild; disarm instead of burning CPU.
        console.warn("FTS rebuild aborted: vault exceeds size guard", { totalBytes });
        this.ctx.storage.sql.exec(
          `DELETE FROM meta WHERE key = ?`,
          FTS_REBUILD_AT_META_KEY,
        );
        return;
      }
      docs.push({
        path,
        content,
        ...(row.fts_mtime != null ? { mtime: row.fts_mtime } : {}),
      });
    }
    console.log("FTS rebuild starting", { docCount: docs.length, totalBytes });
    await markFtsPhase(bucket, ref, "gather-done", {
      docCount: docs.length,
      totalBytes,
    });
    const manifest = await rebuildFtsIndex(bucket, ref, docs, {
      previousGeneration: this.getMeta(FTS_GENERATION_META_KEY),
    });
    this.setMeta(FTS_GENERATION_META_KEY, manifest.generation);
    console.log("FTS rebuild finished", {
      generation: manifest.generation,
      docCount: manifest.docCount,
      totalChars: manifest.totalChars,
    });
  }

  private async removeAllVectors(): Promise<void> {
    const ref = this.vaultRef();
    if (!ref) return;
    const rows = this.rows<IndexStateRow>(`SELECT * FROM index_state WHERE chunks > 0`);
    for (const row of rows) {
      await removeNoteVectors(this.bindings(), { ref, path: row.path, chunks: row.chunks });
    }
  }

  private dbInfo(dbName: string): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    const docCount = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 0`,
    )?.count ?? 0;
    const deletedCount = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 1`,
    )?.count ?? 0;
    const updateSeq = this.currentSeq();
    return json({
      db_name: this.getMeta("db_name") ?? dbName,
      doc_count: docCount,
      doc_del_count: deletedCount,
      update_seq: updateSeq,
      committed_update_seq: updateSeq,
      compact_running: false,
      disk_format_version: 8,
      instance_start_time: "0",
      purge_seq: 0,
      sizes: { active: 0, disk: 0, external: 0 },
    });
  }

  private listFiles(): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    return json({ files: this.listNoteFiles() });
  }

  private readFile(path: string): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!path) return couchError(400, "bad_request", "File path is required.");
    const row = this.findNoteRow(path);
    if (!row) return couchError(404, "not_found", "File not found.");
    return json({ content: this.fileContentForRow(row) });
  }

  private currentSeq(): number {
    return this.first<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM changes`)?.seq ?? 0;
  }

  private nextSeq(): number {
    return this.currentSeq() + 1;
  }

  // --- change notifications -------------------------------------------------
  //
  // Longpoll/continuous waiting lives in the Worker (see ChangeWatcher). The
  // object never blocks and never arms a timer for it, so between writes it can
  // hibernate; the Worker-held WebSockets below survive hibernation and are the
  // only thing the object needs to wake for.

  private acceptWatcher(): Response {
    if (typeof this.ctx.acceptWebSocket !== "function") {
      return couchError(501, "not_implemented", "WebSockets unavailable");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private notifyWatchers(): void {
    if (typeof this.ctx.getWebSockets !== "function") return;
    const message = JSON.stringify({ type: "change", seq: this.currentSeq() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // peer already gone; the runtime reaps it
      }
    }
  }

  webSocketMessage(): void {
    // Watchers only listen; nothing is expected from them.
  }

  webSocketClose(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "error");
    } catch {
      // already closed
    }
  }

  private rawLeafRevs(id: string): RevRow[] {
    return this.rows<RevRow>(
      `SELECT r.* FROM revs r
       WHERE r.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM revs child WHERE child.id = r.id AND child.parent_rev = r.rev
         )`,
      id,
    );
  }

  private revisionBody(row: RevRow): string {
    if (!row.body_chunked) return row.body;
    const chunks = this.rows<{ body: string }>(
      `SELECT body FROM rev_body_chunks
       WHERE id = ? AND rev = ?
       ORDER BY chunk_index`,
      row.id,
      row.rev,
    );
    if (chunks.length === 0) {
      throw new Error(`Missing chunked LiveSync revision body: ${row.id}@${row.rev}`);
    }
    return chunks.map((chunk) => chunk.body).join("");
  }

  private hydrateRevision(row: RevRow): RevRow {
    return row.body_chunked ? { ...row, body: this.revisionBody(row) } : row;
  }

  private descendantLeafRevs(id: string, rev: string): RevRow[] {
    const start = this.rawRevRow(id, rev);
    if (!start) return [];
    const leaves: RevRow[] = [];
    const pending = [start];
    while (pending.length > 0) {
      const row = pending.pop()!;
      const children = this.rows<RevRow>(
        `SELECT * FROM revs WHERE id = ? AND parent_rev = ?`,
        id,
        row.rev,
      );
      if (children.length === 0) leaves.push(row);
      else pending.push(...children);
    }
    return leaves.map((row) => this.hydrateRevision(row));
  }

  private leafRevs(id: string): RevRow[] {
    return this.rawLeafRevs(id).map((row) => this.hydrateRevision(row));
  }

  private recalculateWinner(id: string): void {
    const leaves = this.rawLeafRevs(id);
    if (leaves.length === 0) {
      this.ctx.storage.sql.exec(`DELETE FROM docs WHERE id = ?`, id);
      return;
    }
    const winner = leaves.sort(compareWinning).at(-1)!;
    this.ctx.storage.sql.exec(
      `INSERT INTO docs (id, winning_rev, deleted, updated_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         winning_rev = excluded.winning_rev,
         deleted = excluded.deleted,
         updated_seq = excluded.updated_seq`,
      id,
      winner.rev,
      winner.deleted,
      winner.seq,
    );
  }

  private rawWinningRow(id: string): RevRow | null {
    const doc = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
    if (!doc?.winning_rev) return null;
    return this.first<RevRow>(`SELECT * FROM revs WHERE id = ? AND rev = ?`, id, doc.winning_rev);
  }

  private winningRow(id: string): RevRow | null {
    const row = this.rawWinningRow(id);
    return row ? this.hydrateRevision(row) : null;
  }

  private rawRevRow(id: string, rev: string): RevRow | null {
    return this.first<RevRow>(`SELECT * FROM revs WHERE id = ? AND rev = ?`, id, rev);
  }

  private revRow(id: string, rev: string): RevRow | null {
    const row = this.rawRevRow(id, rev);
    return row?.body_available ? this.hydrateRevision(row) : null;
  }

  private conflictsFor(id: string, winningRev: string): string[] {
    return this.rawLeafRevs(id)
      .filter((row) => !row.deleted && row.rev !== winningRev)
      .map((row) => row.rev);
  }

  private writeRevision(row: {
    id: string;
    rev: string;
    gen: number;
    parentRev: string | null;
    body: string;
    metadata: RevisionMetadata;
    deleted: number;
    seq: number;
    revHistory: string;
  }): void {
    const chunks = splitRevisionBody(row.body);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO revs
           (id, rev, gen, parent_rev, body, body_chunked, body_available, deleted, seq, rev_history)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        row.id,
        row.rev,
        row.gen,
        row.parentRev,
        chunks ? "{}" : row.body,
        chunks ? 1 : 0,
        row.deleted,
        row.seq,
        row.revHistory,
      );
      if (chunks) {
        for (const [chunkIndex, chunk] of chunks.entries()) {
          this.ctx.storage.sql.exec(
            `INSERT INTO rev_body_chunks (id, rev, chunk_index, body)
             VALUES (?, ?, ?, ?)`,
            row.id,
            row.rev,
            chunkIndex,
            chunk,
          );
        }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO rev_metadata (id, rev, path, size, mtime, type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.id,
        row.rev,
        row.metadata.path,
        row.metadata.size,
        row.metadata.mtime,
        row.metadata.type,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO changes (seq, id, rev, deleted) VALUES (?, ?, ?, ?)`,
        row.seq,
        row.id,
        row.rev,
        row.deleted,
      );
      this.recalculateWinner(row.id);
    });
    this.notifyWatchers();
    void this.scheduleIndexing();
  }

  private publicDoc(row: RevRow, options?: { conflicts?: boolean; revs?: boolean }): DocBody {
    const body = options?.revs ? bodyWithRevisions(row) : cloneBody(row);
    body._id = row.id;
    body._rev = row.rev;
    if (row.deleted) body._deleted = true;
    if (options?.conflicts) {
      const conflicts = this.conflictsFor(row.id, row.rev);
      if (conflicts.length > 0) body._conflicts = conflicts;
    }
    return body;
  }

  private async insertRevision(doc: DocBody, options: { newEdits: boolean }): Promise<{
    ok: boolean;
    id: string;
    rev?: string;
    error?: string;
    reason?: string;
  }> {
    const id = docIdFromBody(doc);
    if (!id) return { ok: false, id: "", error: "bad_request", reason: "Document id is required." };

    if (options.newEdits) {
      const current = this.rawWinningRow(id);
      let parentRev = typeof doc._rev === "string" ? doc._rev : null;
      if (current && current.deleted && !parentRev) parentRev = current.rev;
      if (current && parentRev !== current.rev) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      if (!current && parentRev) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      const parent = parentRev ? this.rawRevRow(id, parentRev) : null;
      if (parentRev && !parent) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      const rev = await newRevision(doc, parentRev);
      const latest = this.rawWinningRow(id);
      if ((latest?.rev ?? null) !== (current?.rev ?? null)) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      const seq = this.nextSeq();
      const deleted = doc._deleted === true ? 1 : 0;
      const parsed = parseRev(rev)!;
      const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: rev };
      if (deleted) stored._deleted = true;
      this.writeRevision({
        id,
        rev,
        gen: parsed.gen,
        parentRev,
        body: JSON.stringify(stored),
        metadata: revisionMetadata(stored),
        deleted,
        seq,
        revHistory: revisionHistory(stored, rev, parent?.rev_history),
      });
      return { ok: true, id, rev };
    }

    if (typeof doc._rev !== "string" || !parseRev(doc._rev)) {
      return { ok: false, id, error: "bad_request", reason: "Invalid rev format." };
    }
    const existing = this.rawRevRow(id, doc._rev);
    if (existing) return { ok: true, id, rev: doc._rev };

    const parsed = parseRev(doc._rev)!;
    const seq = this.nextSeq();
    const deleted = doc._deleted === true ? 1 : 0;
    const parentRev = parentFromRevisions(doc);
    const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: doc._rev };
    this.writeRevision({
      id,
      rev: doc._rev,
      gen: parsed.gen,
      parentRev,
      body: JSON.stringify(stored),
      metadata: revisionMetadata(stored),
      deleted,
      seq,
      revHistory: revisionHistory(doc, doc._rev),
    });
    return { ok: true, id, rev: doc._rev };
  }

  private async handleDoc(request: Request, id: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!id) return couchError(400, "bad_request", "Document id is required.");
    const url = new URL(request.url);

    if (request.method === "GET") {
      const openRevs = url.searchParams.get("open_revs");
      if (openRevs) return this.handleOpenRevs(id, openRevs, url);
      const rev = url.searchParams.get("rev");
      const row = rev ? this.revRow(id, rev) : this.winningRow(id);
      if (!row) return couchError(404, "not_found", "missing");
      if (row.deleted && !rev) return couchError(404, "not_found", "deleted");
      return json(this.publicDoc(row, {
        conflicts: boolParam(url.searchParams.get("conflicts")),
        revs: boolParam(url.searchParams.get("revs")),
      }), { headers: { etag: `"${row.rev}"` } });
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      body._id = id;
      const rev = url.searchParams.get("rev");
      if (rev && typeof body._rev !== "string") body._rev = rev;
      const result = await this.insertRevision(body, {
        newEdits: url.searchParams.get("new_edits") !== "false",
      });
      if (!result.ok) return couchError(result.error === "conflict" ? 409 : 400, result.error!, result.reason!);
      return json({ ok: true, id: result.id, rev: result.rev });
    }

    if (request.method === "DELETE") {
      const rev = url.searchParams.get("rev");
      if (!rev) return couchError(400, "bad_request", "rev is required.");
      const body: DocBody = { _id: id, _rev: rev, _deleted: true };
      const result = await this.insertRevision(body, { newEdits: true });
      if (!result.ok) return couchError(409, "conflict", "Document update conflict.");
      return json({ ok: true, id, rev: result.rev });
    }

    return couchError(405, "method_not_allowed", "Method not allowed");
  }

  private handleOpenRevs(id: string, openRevs: string, url: URL): Response {
    let revs: string[];
    if (openRevs === "all") {
      revs = this.leafRevs(id).map((row) => row.rev);
    } else {
      try {
        const parsed = JSON.parse(openRevs) as unknown;
        if (!Array.isArray(parsed)) {
          return couchError(400, "bad_request", "open_revs must be an array.");
        }
        revs = parsed.filter((rev): rev is string => typeof rev === "string");
      } catch {
        return couchError(400, "bad_request", "Invalid open_revs.");
      }
    }
    const includeRevs = boolParam(url.searchParams.get("revs"));
    const latest = boolParam(url.searchParams.get("latest"));
    const rows = revs.flatMap<{ ok: DocBody } | { missing: string }>((rev) => {
      const found = latest
        ? this.descendantLeafRevs(id, rev)
        : [this.revRow(id, rev)].filter((row): row is RevRow => row !== null);
      if (found.length === 0) return [{ missing: rev }];
      return found.map((row) => ({ ok: this.publicDoc(row, { revs: includeRevs }) }));
    });
    return json(rows);
  }

  private async handleLocalDoc(request: Request, id: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!id) return couchError(400, "bad_request", "Local document id is required.");
    const url = new URL(request.url);

    if (request.method === "GET") {
      const row = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if (!row) return couchError(404, "not_found", "missing");
      return json({ ...JSON.parse(row.body), _id: `_local/${id}`, _rev: row.rev });
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      const existing = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      const expectedRev = typeof body._rev === "string" ? body._rev : url.searchParams.get("rev");
      if (existing && existing.rev !== expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      if (!existing && expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      const hash = await sha1Hex(`${stableJson(withoutMeta(body))}\n${existing?.rev ?? ""}`);
      const latest = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if ((latest?.rev ?? null) !== (existing?.rev ?? null)) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      const rev = `0-${hash.slice(0, 16)}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO local_docs (id, rev, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, body = excluded.body`,
        id,
        rev,
        JSON.stringify(withoutMeta(body)),
      );
      return json({ ok: true, id: `_local/${id}`, rev });
    }

    if (request.method === "DELETE") {
      const existing = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if (!existing) return couchError(404, "not_found", "missing");
      const expectedRev = url.searchParams.get("rev");
      if (expectedRev && existing.rev !== expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      this.ctx.storage.sql.exec(`DELETE FROM local_docs WHERE id = ?`, id);
      return json({ ok: true, id: `_local/${id}`, rev: existing.rev });
    }

    return couchError(405, "method_not_allowed", "Method not allowed");
  }

  private async handleBulkDocs(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const docs = Array.isArray(body.docs) ? (body.docs as DocBody[]) : [];
    const newEdits = body.new_edits !== false;
    const results = [];
    for (const doc of docs) {
      const result = await this.insertRevision(doc, { newEdits });
      results.push(
        result.ok
          ? { ok: true, id: result.id, rev: result.rev }
          : { id: result.id, error: result.error, reason: result.reason },
      );
    }
    return json(results);
  }

  private async handleRevsDiff(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const result: Record<string, { missing: string[] }> = {};
    for (const [id, revs] of Object.entries(body)) {
      if (!Array.isArray(revs)) continue;
      const missingRevs = revs.filter(
        (rev): rev is string => typeof rev === "string" && !this.rawRevRow(id, rev),
      );
      if (missingRevs.length > 0) result[id] = { missing: missingRevs };
    }
    return json(result);
  }

  private async handleBulkGet(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const url = new URL(request.url);
    const body = await readJsonBody(request);
    const includeRevs = boolParam(body.revs) || boolParam(url.searchParams.get("revs"));
    const latest = boolParam(body.latest) || boolParam(url.searchParams.get("latest"));
    const docs = Array.isArray(body.docs)
      ? (body.docs as Array<{ id?: unknown; rev?: unknown }>)
      : [];
    const results = docs.map((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const rev = typeof item.rev === "string" ? item.rev : "";
      const rows =
        id && rev
          ? latest
            ? this.descendantLeafRevs(id, rev)
            : [this.revRow(id, rev)].filter((row): row is RevRow => row !== null)
          : id
            ? this.leafRevs(id)
            : [];
      return {
        id,
        docs:
          rows.length > 0
            ? rows.map((row) => ({
                ok: this.publicDoc(row, { revs: includeRevs }),
              }))
            : [{ error: { id, rev, error: "not_found", reason: "missing" } }],
      };
    });
    return json({ results });
  }

  private async allDocsOptions(request: Request): Promise<Record<string, unknown>> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    return {
      ...Object.fromEntries(url.searchParams.entries()),
      ...body,
    };
  }

  private async handleAllDocs(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const options = await this.allDocsOptions(request);
    const includeDocs = boolParam(options.include_docs);
    const conflicts = boolParam(options.conflicts);
    const keys = Array.isArray(options.keys) ? (options.keys as string[]) : null;
    const totalRows = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 0`,
    )?.count ?? 0;
    if (keys) {
      return json({
        total_rows: totalRows,
        offset: 0,
        rows: keys.map((key) => this.allDocsRow(key, includeDocs, conflicts)),
      });
    }

    const descending = boolParam(options.descending);
    const inclusiveEnd = options.inclusive_end === undefined || boolParam(options.inclusive_end);
    const startKey = allDocsKey(options.startkey ?? options.start_key);
    const endKey = allDocsKey(options.endkey ?? options.end_key);
    const clauses = ["deleted = 0"];
    const args: unknown[] = [];
    if (startKey !== null) {
      clauses.push(descending ? "id <= ?" : "id >= ?");
      args.push(startKey);
    }
    if (endKey !== null) {
      clauses.push(
        descending ? (inclusiveEnd ? "id >= ?" : "id > ?") : inclusiveEnd ? "id <= ?" : "id < ?",
      );
      args.push(endKey);
    }
    const skip = Math.max(numberParam(options.skip, 0), 0);
    const limit = options.limit === undefined ? -1 : Math.max(numberParam(options.limit, -1), 0);
    const rows = this.rows<DocRow>(
      `SELECT * FROM docs WHERE ${clauses.join(" AND ")}
       ORDER BY id ${descending ? "DESC" : "ASC"}
       LIMIT ? OFFSET ?`,
      ...args,
      limit,
      skip,
    ).map((row) => this.allDocsRow(row.id, includeDocs, conflicts));
    return json({ total_rows: totalRows, offset: skip, rows });
  }

  private allDocsRow(id: string, includeDoc: boolean, conflicts: boolean): Record<string, unknown> {
    const row = this.winningRow(id);
    if (!row) return { key: id, error: "not_found" };
    const value: Record<string, unknown> = { rev: row.rev };
    if (row.deleted) value.deleted = true;
    const out: Record<string, unknown> = { id, key: id, value };
    if (includeDoc) out.doc = row.deleted ? null : this.publicDoc(row, { conflicts });
    return out;
  }

  private async handleFind(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const selector = (body.selector ?? {}) as Selector;
    const limit = numberParam(body.limit, 25);
    const docs = this.rows<DocRow>(`SELECT * FROM docs ORDER BY id`)
      .map((row) => this.winningRow(row.id))
      .filter((row): row is RevRow => row !== null && !row.deleted)
      .map((row) => this.publicDoc(row))
      .filter((doc) => matchesSelector(doc, selector))
      .slice(0, limit);
    return json({ docs, warning: "no matching index found, create an index to optimize query time" });
  }

  private handleCompact(): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `DELETE FROM rev_body_chunks
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = rev_body_chunks.id AND child.parent_rev = rev_body_chunks.rev
         )`,
      );
      sql.exec(
        `DELETE FROM rev_metadata
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = rev_metadata.id AND child.parent_rev = rev_metadata.rev
         )`,
      );
      sql.exec(
        `UPDATE revs SET body = '{}', body_chunked = 0, body_available = 0
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = revs.id AND child.parent_rev = revs.rev
         )`,
      );
      sql.exec(
        `UPDATE changes
         SET rev = (SELECT winning_rev FROM docs WHERE docs.id = changes.id),
             deleted = (SELECT deleted FROM docs WHERE docs.id = changes.id)
         WHERE seq IN (SELECT MAX(seq) FROM changes GROUP BY id)`,
      );
      sql.exec(
        `DELETE FROM changes WHERE seq NOT IN (SELECT MAX(seq) FROM changes GROUP BY id)`,
      );
    });
    return json({ ok: true }, { status: 202 });
  }

  private async handleChanges(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const options: Record<string, unknown> = {
      ...Object.fromEntries(url.searchParams.entries()),
      ...body,
    };
    if (typeof options.selector === "string") {
      try {
        options.selector = JSON.parse(options.selector);
      } catch {
        return couchError(400, "bad_request", "Invalid selector.");
      }
    }
    const since = normalizeSince(options.since, this.currentSeq());
    // Longpoll and continuous feeds are driven by the Worker, which re-asks
    // after a change notification; here every feed answers immediately.
    const batch = this.changeBatch(options, since);
    const idle = batch.rows.length === 0 && batch.lastSeq === since;
    return json(
      {
        results: batch.rows.map((row) => this.changeResult(row, options)),
        last_seq: batch.lastSeq,
        pending: 0,
      },
      idle ? { headers: { [CHANGES_IDLE_HEADER]: "1" } } : undefined,
    );
  }

  private changeBatch(options: Record<string, unknown>, since: number): ChangeBatch {
    const limit = Math.min(Math.max(numberParam(options.limit, 1000), 1), 5000);
    const selector = (options.selector ?? null) as Selector | null;
    const style = String(options.style ?? "main_only");
    const scanLimit = selector ? Math.min(limit * 10, 5000) : limit;
    if (style === "all_docs") {
      const candidates = this.rows<ChangeRow>(
        `WITH latest AS (
           SELECT id, MAX(seq) AS seq
           FROM changes
           WHERE seq > ?
           GROUP BY id
           ORDER BY seq
           LIMIT ?
         )
         SELECT latest.seq, d.id, d.winning_rev AS rev, d.deleted
         FROM latest
         JOIN docs d ON d.id = latest.id
         ORDER BY latest.seq`,
        since,
        scanLimit,
      );
      const rows = candidates
        .map<ChangeRow | null>((row) => {
          const leaves = this.rawLeafRevs(row.id);
          const matching = selector
            ? leaves.filter((row) =>
                matchesSelector(this.publicDoc(this.hydrateRevision(row)), selector),
              )
            : leaves;
          const winning = this.rawWinningRow(row.id);
          if (!winning || matching.length === 0) return null;
          return {
            seq: row.seq,
            id: row.id,
            rev: winning.rev,
            deleted: winning.deleted,
            revs: matching.map((row) => row.rev),
          } satisfies ChangeRow;
        })
        .filter((row): row is ChangeRow => row !== null)
        .sort((a, b) => a.seq - b.seq);
      const limited = rows.slice(0, limit);
      return {
        rows: limited,
        lastSeq:
          rows.length > limit
            ? limited.at(-1)!.seq
            : candidates.at(-1)?.seq ?? this.currentSeq(),
      };
    }

    const candidates = this.rows<ChangeRow>(
      `SELECT c.*
       FROM changes c
       JOIN docs d ON d.id = c.id AND d.winning_rev = c.rev
       WHERE c.seq > ?
       ORDER BY c.seq
       LIMIT ?`,
      since,
      scanLimit,
    );
    const rows = candidates
      .filter((row) => {
        const winning = this.rawWinningRow(row.id);
        if (!winning || winning.rev !== row.rev) return false;
        if (!selector) return true;
        return matchesSelector(this.publicDoc(this.hydrateRevision(winning)), selector);
      });
    const limited = rows.slice(0, limit);
    return {
      rows: limited,
      lastSeq:
        rows.length > limit
          ? limited.at(-1)!.seq
          : candidates.at(-1)?.seq ?? this.currentSeq(),
    };
  }

  private changeResult(row: ChangeRow, options: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {
      seq: row.seq,
      id: row.id,
      changes: (row.revs ?? [row.rev]).map((rev) => ({ rev })),
    };
    if (row.deleted) result.deleted = true;
    if (boolParam(options.include_docs)) {
      const rev = this.revRow(row.id, row.rev);
      if (rev) {
        result.doc = this.publicDoc(rev, {
          conflicts: boolParam(options.conflicts),
          revs: boolParam(options.revs),
        });
      }
    }
    return result;
  }
}
