import { matchesSelector, matchesMetadata } from "./selector.js";
import { mapBatches } from "../storage/concurrency.js";
import { REQUEST_LIMITS, readBoundedJson, BadRequestError, RequestLimitError, assertBulkLimits, assertDocumentSize, decodePathSegment } from "../livesync/limits.js";
import { hashText } from "../search/chunk-md.js";
import { removeNoteVectors, upsertNoteVectors } from "../search/vector-index.js";
import {
  appendFtsSegment,
  compactFtsSegments,
  deleteFtsIndex,
  FTS_SETTLED_PHASES,
  markFtsPhase,
  planFtsCompaction,
  planFtsStaleRewrite,
  readFtsManifest,
  readFtsPhase,
  readFtsSegmentDocs,
  retireFtsSegments,
  type CompactionPlan,
  type FtsManifest,
  type FtsSegment,
} from "../search/fts-index.js";
import type { FtsDocInput } from "../search/fts/build.js";
import {
  CHANGES_IDLE_HEADER,
  DB_NAME_HEADER,
  VAULT_REF_HEADER,
  INTERNAL_SECRET_HEADER,
  couchError,
  json,
  numberParam,
  secretEquals,
} from "../livesync/http.js";
import {
  isHiddenPath,
  isReservedPath,
  parseVaultObjectName,
  vaultObjectName,
  type FullTextIndex,
  type FullTextIndexWriter,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "../types.js";

import { decodeLiveSyncBinary } from "../vault/binary.js";
import { ChunkBodyStore } from "./chunk-body-store.js";

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
  pending: number;
};

type RevisionMetadata = {
  soft_deleted: number;
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
  /** Content hash last written to the full-text index (null = not there yet). */
  fts_hash: string | null;
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
const CURRENT_INDEX_VERSION = "3";
const INDEX_BATCH_SIZE = 200;
const INDEX_ALARM_DELAY_MS = 1_500;
const INDEX_RETRY_DELAY_MS = 30_000;
const INDEX_MAX_ATTEMPTS = 20;
// Newest segment the built-in full-text index wrote (shown as fts.generation).
const FTS_GENERATION_META_KEY = "fts_generation";
// Layout of the built-in index this code writes: "2" = per-note segments,
// "3" = bucketed shards read by range, "4" = same layout, but the build
// streams (0.5.x) so a "failed" verdict recorded by an earlier build no
// longer applies, "5" (0.5.2) clears the verdict a pass that indexed nothing
// used to earn. The whole-vault generation before them had no version
// meta. A change clears that verdict and arms a maintenance pass, which
// rewrites what the new code cannot read efficiently.
const FTS_INDEX_VERSION_META_KEY = "fts_index_version";
const CURRENT_FTS_INDEX_VERSION = "5";
const FTS_REBUILD_AT_META_KEY = "fts_rebuild_at";
// Why the last pass gave up; cleared by the next successful pass.
const FTS_ERROR_META_KEY = "fts_error";
// Every full-text pass writes a segment (~18 R2 objects), so wait for the
// vault to go quiet before writing one for a burst of edits.
const FTS_BUILD_DEBOUNCE_MS = 2 * 60_000;
const FTS_BUILD_RETRY_MS = 60_000;
// One pass indexes at most this much note text (JS code units, what the
// tokenizer walks) into one segment. Measured 2026-09: ~10 bytes of heap and
// ~1.5 s of DO CPU per million code units, so a pass stays well under the
// 128 MB / 30 s Durable Object limits; a big backlog takes several passes.
const FTS_SEGMENT_MAX_CODE_UNITS = 2_000_000;
const FTS_SEGMENT_MAX_DOCS = 4_000;
// Ceiling on the whole index (sum of segment text); passes stop with an
// explicit error above it. 50M code units is ~120 MB of Japanese Markdown.
const FTS_MAX_TOTAL_CODE_UNITS = 50_000_000;
// One note contributes at most this much text (code units): the built-in
// index takes the first part of a longer note, an external one skips it.
// Measured 2026-09: a 2M-code-unit note builds in ~65 MB of heap, so this
// leaves room for the rest of the segment.
const FTS_MAX_NOTE_CODE_UNITS = 1_000_000;
// A pass that dies from a memory reset leaves no SQLite trace (the event's
// writes roll back), so attempts are counted in the R2 phase marker. After
// this many interrupted attempts the index is disarmed instead of looping.
const FTS_MAX_BUILD_ATTEMPTS = 3;
// Compaction merges the two smallest segments once there are more than this
// many, as long as the merged text stays under the char bound (one merge per
// alarm event, no re-tokenizing).
const FTS_COMPACT_MAX_SEGMENTS = 8;
const FTS_COMPACT_MAX_MERGED_CHARS = 16_000_000;
// Segments count replaced/deleted versions until compaction drops them, and
// the size guard counts them too. A segment is rewritten alone once that
// dead weight is this large (share of its text, and at least this many
// code units), so a vault that is edited a lot does not grow into the guard.
const FTS_STALE_REWRITE_MIN_RATIO = 0.25;
const FTS_STALE_REWRITE_MIN_CHARS = 250_000;
// Finding stale text means reading every segment's doc list; skip that while
// the manifest's doc count is within this factor of the live doc count.
const FTS_STALE_SCAN_DOC_RATIO = 1.2;
// Set by ftsRebuild: segments built before this are retired once every note
// has been re-indexed, and the size guard ignores them meanwhile.
const FTS_REBUILD_EPOCH_META_KEY = "fts_rebuild_epoch";
// Most candidates one search asks the vault to check against its current state.
const FTS_RESOLVE_MAX_CANDIDATES = 500;
// External full-text index (VaultBindings.fullText): notes already
// vector-indexed but not yet written there (a fresh setup, or after
// "ftsRebuild") are backfilled this many per alarm run.
// Chunk documents written by the server. The hash salt is a persisted format
// detail (chunk ids are content addressed); keep it stable.
const WRITE_CHUNK_PREFIX = "h:";
const WRITE_CHUNK_HASH_SALT = "kuro-chunk";
const WRITE_CHUNK_CODE_UNITS = 100_000;

function mapBatched<T, U>(items: T[], map: (item: T) => Promise<U>): Promise<U[]> {
  return mapBatches(items, 8, map);
}

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
    !isExcludedByFolders(path, policy.excludedFolders) &&
    // "i:" marks files LiveSync's hidden file sync carries (".obsidian/…").
    !(policy.excludeHiddenPaths && (path.startsWith("i:") || isHiddenPath(path)))
  );
}


const readJsonBody = readBoundedJson;

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

class FtsTooLargeError extends Error {
  constructor(
    readonly codeUnits: number,
    readonly limit: number,
  ) {
    super(`FTS rebuild input exceeds ${limit} code units`);
  }
}

function revisionMetadata(doc: DocBody): RevisionMetadata {
  return {
    soft_deleted: doc.deleted === true ? 1 : 0,
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

/**
 * Ancestors of a replicated revision, nearest first, from its `_revisions`
 * path (`ids[0]` is the revision itself). Replicators send only leaves, so
 * the generations in between must be recorded from this list or the
 * previously stored ancestor stays a leaf and surfaces as a conflict.
 */
function ancestorsFromRevisions(doc: DocBody): string[] {
  const rev = typeof doc._rev === "string" ? parseRev(doc._rev) : null;
  const revisions = doc._revisions as
    | { start?: unknown; ids?: unknown }
    | undefined;
  if (!rev || !revisions || !Array.isArray(revisions.ids)) return [];
  const ids = revisions.ids.filter((id): id is string => typeof id === "string");
  const ancestors: string[] = [];
  for (let index = 1; index < ids.length && rev.gen - index >= 1; index += 1) {
    ancestors.push(`${rev.gen - index}-${ids[index]}`);
  }
  return ancestors;
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
  private selectorFallbacks = 0;
  private selectorScanned = 0;
  private maintenance = Promise.resolve();
  private exclusive = Promise.resolve();
  private readonly chunkBodies: ChunkBodyStore;

  /** Serialize vault operations across R2 awaits, including compaction and migration. */
  private async withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.maintenance;
    let release!: () => void;
    this.maintenance = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Serialize vault operations across R2 awaits, including compaction and migration. */
  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusive;
    let release!: () => void;
    this.exclusive = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: TEnv,
  ) {
    this.init();
    this.chunkBodies = new ChunkBodyStore(this.ctx.storage, () => this.bindings(), () => this.vaultRef());
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
        soft_deleted INTEGER NOT NULL DEFAULT 0,
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
    if (schemaVersion < 3) {
      // Replicated revisions whose skipped ancestors were never recorded left
      // the stored ancestor as a leaf (a phantom conflict that resurrected
      // deleted notes). Reconnect the trees and recompute winners, and make
      // docs.updated_seq the document's latest change.
      const touched = new Set<string>();
      this.ctx.storage.transactionSync(() => {
        // Rows whose parent is missing, or that were stored without one
        // (a short history) although they are not first-generation.
        const orphans = sql
          .exec<{ id: string; rev: string; seq: number; rev_history: string | null }>(
            `SELECT r.id, r.rev, r.seq, r.rev_history FROM revs r
             WHERE (r.parent_rev IS NULL AND r.gen > 1)
                OR (r.parent_rev IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM revs p WHERE p.id = r.id AND p.rev = r.parent_rev))`,
          )
          .toArray();
        for (const orphan of orphans) {
          let revisions: unknown = null;
          try {
            revisions = orphan.rev_history ? JSON.parse(orphan.rev_history) : null;
          } catch {
            // Unreadable history: leave this branch as it is.
          }
          if (!revisions) continue;
          const ancestors = ancestorsFromRevisions({ _rev: orphan.rev, _revisions: revisions });
          if (ancestors.length === 0) continue;
          sql.exec(
            `UPDATE revs SET parent_rev = ? WHERE id = ? AND rev = ? AND parent_rev IS NULL`,
            ancestors[0],
            orphan.id,
            orphan.rev,
          );
          this.linkAncestors(orphan.id, ancestors, orphan.seq);
          touched.add(orphan.id);
        }
        for (const id of touched) {
          const before = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
          this.recalculateWinner(id);
          const after = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
          if (!after?.winning_rev || after.winning_rev === before?.winning_rev) continue;
          // Clients that replicated the phantom winner have checkpoints past
          // this document; a new change row is the only way they learn of
          // the corrected winner.
          sql.exec(
            `INSERT INTO changes (seq, id, rev, deleted) VALUES (?, ?, ?, ?)`,
            this.nextSeq(),
            id,
            after.winning_rev,
            after.deleted,
          );
        }
        sql.exec(
          `UPDATE docs SET updated_seq =
             (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE changes.id = docs.id)`,
        );
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (3)`);
      });
      if (touched.size > 0) {
        // Winners changed without a new change row; re-scan the search indexes
        // (unchanged notes are skipped by hash, so nothing is re-embedded).
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        this.armFtsBuild(0);
        void this.scheduleIndexing(0);
      }
    }
    if (schemaVersion < 4) {
      const metadataColumns = new Set(
        sql.exec<{ name: string }>(`PRAGMA table_info(rev_metadata)`).toArray().map((column) => column.name),
      );
      this.ctx.storage.transactionSync(() => {
        if (!metadataColumns.has("soft_deleted")) {
          sql.exec(`ALTER TABLE rev_metadata ADD COLUMN soft_deleted INTEGER NOT NULL DEFAULT 0`);
        }
        sql.exec(
          `UPDATE rev_metadata SET soft_deleted = COALESCE((
             SELECT json_extract(r.body, '$.deleted') = 1 FROM revs r
             WHERE r.id = rev_metadata.id AND r.rev = rev_metadata.rev AND r.body_chunked = 0
           ), 0)`,
        );
        const chunked = this.rows<RevRow>(`SELECT r.* FROM revs r
          JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev WHERE r.body_chunked = 1`);
        for (const row of chunked) {
          sql.exec(`UPDATE rev_metadata SET soft_deleted = ? WHERE id = ? AND rev = ?`,
            revisionMetadata(cloneBody(this.hydrateRevision(row))).soft_deleted, row.id, row.rev);
        }
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (4)`);
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
    const indexStateColumns = new Set(
      sql.exec<{ name: string }>(`PRAGMA table_info(index_state)`).toArray().map((column) => column.name),
    );
    if (!indexStateColumns.has("fts_hash")) {
      // NULL rows are pending for the full-text index (built-in or external).
      sql.exec(`ALTER TABLE index_state ADD COLUMN fts_hash TEXT`);
    }
    if (this.getMeta(FTS_INDEX_VERSION_META_KEY) !== CURRENT_FTS_INDEX_VERSION) {
      // Upgrading from the whole-vault build: its "too large" / "interrupted"
      // verdicts do not apply to the segmented index, which picks up every
      // note (fts_hash is NULL for all of them) in bounded passes. Arming a
      // pass also lets the maintenance step rewrite older segment formats.
      sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
      this.setMeta(FTS_INDEX_VERSION_META_KEY, CURRENT_FTS_INDEX_VERSION);
      this.armFtsBuild(0);
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_id ON revs (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_parent ON revs (id, parent_rev)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_changes_id ON changes (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_docs_updated_seq ON docs (updated_seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_rev_metadata_path ON rev_metadata (path)`);
  }

  async fetch(request: Request): Promise<Response> {
    // `return await`: a handler's rejected promise must reach this catch,
    // which a bare `return handler()` inside try would skip.
    try {
      if (request.body) await readJsonBody(request);
      const pathname = new URL(request.url).pathname;
      const body = request.method === "POST" && pathname === "/internal/op" ? await readJsonBody(request) : null;
      const destructive = (request.method === "DELETE" && pathname === "/") || pathname === "/internal/purge" || body?.op === "reindex" || body?.op === "ftsRebuild";
      const run = () => this.withExclusive(() => this.route(request));
      return await (destructive ? this.withMaintenance(run) : run());
    } catch (error) {
      if (error instanceof BadRequestError) return couchError(400, "bad_request", error.message);
      if (error instanceof RequestLimitError) return couchError(413, "request_entity_too_large", error.message);
      console.warn("LiveSync DB request failed", error);
      if (this.chunkBodies.needsMaintenance()) await this.scheduleIndexing(1_000);
      return couchError(500, "internal_server_error", "Internal server error");
    }
  }

  private async route(request: Request): Promise<Response> {
    this.bindVaultIdentity(request);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    for (const part of parts) decodePathSegment(part);
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (this.getMeta("chunk_storage_purging") === "1" &&
        !(request.method === "DELETE" && parts.length === 0) &&
        !(request.method === "POST" && url.pathname === "/internal/purge")) {
      return couchError(503, "database_deleting", "Retry the database deletion to finish cleanup.");
    }
    // Existing databases (created before indexing existed, or indexed under an
    // older index version) catch up on first access.
    if (
      Date.now() - this.lastIndexScheduleAt > 5_000 &&
      this.dbExists() &&
      (this.indexNeedsVersionUpgrade() ||
        this.indexedSeq() < this.currentSeq() ||
        this.hasFullTextBacklog() ||
        this.first(`SELECT 1 FROM index_state WHERE pending = 1 AND attempts < ? LIMIT 1`, INDEX_MAX_ATTEMPTS) != null ||
        this.chunkBodies.needsMaintenance())
    ) {
      void this.scheduleIndexing();
    }
    if (url.pathname.startsWith("/internal/")) {
      if (!secretEquals(request.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) {
        return couchError(403, "forbidden", "Forbidden");
      }
      if (url.pathname === "/internal/chunk-storage") {
        if (request.method === "GET") return json(this.chunkBodies.status());
        if (request.method === "POST") {
          const missing = this.requireDb();
          if (missing) return missing;
          const status = this.chunkBodies.startMigration();
          await this.ctx.storage.setAlarm(Date.now());
          return json(status, { status: 202 });
        }
        return couchError(405, "method_not_allowed", "Method not allowed");
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
      const id = decodePathSegment(parts.slice(1).join("/"));
      return this.handleLocalDoc(request, id);
    }

    const id = decodePathSegment(parts.join("/"));
    return this.handleDoc(request, id);
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

  /**
   * Deletes everything the vault holds. External copies (vectors, the FTS
   * index in R2) go first and any failure there aborts the request: the
   * SQLite rows stay, so the caller can retry instead of ending up with an
   * orphaned index that nothing can reach any more.
   */
  private deleteDb(): Promise<Response> {
    return this.purgeDb();
  }

  private async purgeDb(): Promise<Response> {
    await this.removeAllVectors();
    const ref = this.vaultRef();
    if (ref) {
      const fullText = this.bindings().fullText;
      if (fullText) await fullText.deleteVault(ref);
      else await deleteFtsIndex(this.ftsBucket(), ref);
    }
    this.setMeta("chunk_storage_purging", "1");
    await this.chunkBodies.purge();
    this.ctx.storage.sql.exec(`DELETE FROM docs`);
    this.ctx.storage.sql.exec(`DELETE FROM rev_body_chunks`);
    this.ctx.storage.sql.exec(`DELETE FROM rev_metadata`);
    this.ctx.storage.sql.exec(`DELETE FROM revs`);
    this.ctx.storage.sql.exec(`DELETE FROM local_docs`);
    this.ctx.storage.sql.exec(`DELETE FROM changes`);
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key != 'vault_identity'`);
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
      case "listFileStats": {
        const missing = this.requireDb();
        if (missing) return json({ files: [] });
        return json({
          files: this.listNoteFiles()
            .filter((file) => !file.path.startsWith("i:"))
            .map((file) => ({ path: file.path, mtime: file.mtime, size: file.size })),
        });
      }
      case "readFile": {
        const path = typeof body.path === "string" ? body.path : "";
        const row = path && this.dbExists() ? this.findNoteRow(path) : null;
        const bytes = row ? await this.fileBytesForRow(row) : null;
        if (!bytes) return couchError(404, "not_found", "File not found or incomplete.");
        return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
      }
      case "readNote": {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path || !this.dbExists()) return json({ content: null });
        // Hidden files synced by LiveSync ("internal files") carry an "i:" prefix.
        const content = await this.fileContent(path) ?? await this.fileContent(`i:${path}`);
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
          for (const row of this.listNoteRevisionsForFts(paths)) {
            if (wanted.has(row.fts_path) && contents[row.fts_path] == null) {
              contents[row.fts_path] = await this.fileContentForRow(row);
            }
          }
        }
        return json({ contents });
      }
      case "resolveFtsHits":
        return this.resolveFtsHits(body);
      case "writeNote":
        return this.writeNote(body);
      case "reindex":
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        await this.requestFullTextRebuild();
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "ftsRebuild":
        await this.requestFullTextRebuild();
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "indexStatus":
        return json({
          ...(this.externalFullText()
            ? {
                fullText: {
                  indexed: this.first<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NOT NULL`,
                  )?.count ?? 0,
                  pending: this.first<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NULL`,
                  )?.count ?? 0,
                },
              }
            : {}),
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
            error: this.getMeta(FTS_ERROR_META_KEY),
            ...(this.externalFullText() ? {} : { pending: this.countFtsPending() }),
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

    const existing = this.findNoteRow(path, true);
    const existingDoc = existing ? cloneBody(existing) : null;
    const currentContent = existing && !docIsDeleted(existingDoc!)
      ? await this.fileContentForRow(existing)
      : "";
    if (currentContent == null) {
      return json({ error: "CONFLICT", path, reason: "Note content is not fully synced" }, { status: 409 });
    }
    if (expectedBaseHash) {
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
         AND m.soft_deleted = 0`,
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

  private findNoteRow(path: string, includeDeleted = false): RevRow | null {
    let row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev
       WHERE ${includeDeleted ? "1" : "d.deleted = 0"} AND m.path = ?
       LIMIT 1`,
      path,
    );
    if (!row) row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE ${includeDeleted ? "1" : "d.deleted = 0"}
         AND r.body_chunked = 0
         AND json_extract(r.body, '$.path') = ?
       LIMIT 1`,
      path,
    );
    if (!row) return null;
    const hydrated = this.hydrateRevision(row);
    return !includeDeleted && docIsDeleted(cloneBody(hydrated)) ? null : hydrated;
  }

  private async fileContent(path: string): Promise<string | null> {
    const row = this.findNoteRow(path);
    return row ? await this.fileContentForRow(row) : null;
  }

  /** Reassemble a note's content from inline data or child chunks. */
  private async fileContentForRow(row: RevRow, cache?: Map<string, Promise<DocBody>>): Promise<string | null> {
    return (await this.filePieces(cloneBody(this.hydrateRevision(row)), cache))?.join("") ?? null;
  }

  /**
   * A file's raw bytes: UTF-8 for text documents, decoded pieces for binary
   * ones. Null while chunks are missing or when a piece cannot be decoded.
   */
  private async fileBytesForRow(row: RevRow): Promise<Uint8Array | null> {
    const doc = cloneBody(this.hydrateRevision(row));
    const pieces = await this.filePieces(doc);
    if (!pieces) return null;
    // LiveSync stores text as "plain" and everything else as base64 "newnote".
    const text = doc.type === "plain" || doc.datatype === "plain";
    return text ? new TextEncoder().encode(pieces.join("")) : decodeLiveSyncBinary(pieces);
  }

  /** The stored pieces of a file in order: inline data or child chunks. */
  private async filePieces(doc: DocBody, cache?: Map<string, Promise<DocBody>>): Promise<string[] | null> {
    if (typeof doc.data === "string") return [doc.data];
    if (Array.isArray(doc.data) && doc.data.every((piece) => typeof piece === "string")) {
      return doc.data as string[];
    }
    const children = Array.isArray(doc.children)
      ? doc.children.filter((id): id is string => typeof id === "string")
      : [];
    if (children.length === 0) return typeof doc.children === "undefined" ? null : [];

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
    const dataById = new Map(await mapBatched(chunks, async (chunk): Promise<[string, string | null]> => {
      const key = `${chunk.id}\0${chunk.rev}`;
      let read = cache?.get(key);
      if (!read) { read = this.publicDoc(chunk); cache?.set(key, read); }
      const body = await read;
      return [chunk.id, typeof body.data === "string" ? body.data : null];
    }));
    const content = children.map((id) => {
      const stored = dataById.get(id);
      if (typeof stored === "string") return stored;
      const edenChunk = eden[id];
      return typeof edenChunk?.data === "string" ? edenChunk.data : null;
    });
    return content.every((chunk): chunk is string => typeof chunk === "string")
      ? content
      : null;
  }

  // ---------------------------------------------------------------------
  // Vectorize indexing (runs in the alarm, driven by the changes feed)
  // ---------------------------------------------------------------------

  /** The vault this object holds, recovered from the object name. */
  protected vaultRef(): VaultRef | null {
    const name = this.ctx.id?.name;
    if (name) return parseVaultObjectName(name);
    const persisted = this.getMeta("vault_identity");
    return persisted ? JSON.parse(persisted) as VaultRef : null;
  }

  private bindVaultIdentity(request: Request): void {
    const header = request.headers.get(VAULT_REF_HEADER);
    if (!header) return;
    if (!secretEquals(request.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) {
      throw new BadRequestError("Untrusted vault identity");
    }
    let ref: VaultRef;
    try { ref = JSON.parse(decodePathSegment(header)); } catch { throw new BadRequestError("Invalid vault identity"); }
    if (!ref || typeof ref.tenantId !== "string" || typeof ref.databaseName !== "string" || !ref.tenantId || !ref.databaseName) throw new BadRequestError("Invalid vault identity");
    const known = this.vaultRef();
    if (known) {
      if (known.tenantId !== ref.tenantId || known.databaseName !== ref.databaseName) throw new BadRequestError("Vault identity mismatch");
      return;
    }
    const bindings = this.bindings();
    const expected = bindings.vaultDb.idFromName((bindings.objectName ?? vaultObjectName)(ref));
    if (!this.ctx.id.equals(expected)) throw new BadRequestError("Vault identity mismatch");
    this.setMeta("vault_identity", JSON.stringify(ref));
  }

  /**
   * Errors propagate: indexing with a default policy would expose reserved
   * paths and excluded folders, so the alarm retries instead.
   */
  private loadPolicy(ref: VaultRef): Promise<VaultPolicy> {
    return this.host().loadVaultPolicy(ref);
  }

  private indexedSeq(): number {
    return Number(this.getMeta(INDEXED_SEQ_META_KEY) ?? "0") || 0;
  }

  private async scheduleIndexing(delayMs = INDEX_ALARM_DELAY_MS): Promise<void> {
    const storage = this.ctx.storage as Partial<DurableObjectStorage>;
    if (typeof storage.setAlarm !== "function" || !this.vaultRef()) return;
    try {
      const existing = typeof storage.getAlarm === "function" ? await storage.getAlarm() : null;
      const at = Math.max(Date.now() + delayMs, Number(this.getMeta("index_retry_at")) || 0);
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

  alarm(): Promise<void> {
    return this.withMaintenance(() => this.runAlarm());
  }

  /** Tracked R2 object bytes; includes pending cleanup until deletion succeeds. */
  protected chunkStorageBytes(): number {
    return this.chunkBodies.storedBytes();
  }

  private async runAlarm(): Promise<void> {
    if (this.getMeta("chunk_storage_purging") === "1") return;
    if (this.chunkBodies.needsMaintenance()) {
      try { await this.withExclusive(() => this.chunkBodies.runMaintenance()); }
      catch (error) { console.warn("LiveSync chunk maintenance failed", error); await this.scheduleIndexing(INDEX_RETRY_DELAY_MS); }
      if (this.chunkBodies.needsMaintenance()) await this.scheduleIndexing(1_000);
    }
    console.log("LiveSync alarm fired", {
      indexedSeq: this.indexedSeq(),
      ftsRebuildAt: this.getMeta(FTS_REBUILD_AT_META_KEY),
    });
    try {
      const ftsDue = Number(this.getMeta(FTS_REBUILD_AT_META_KEY));
      if (!this.externalFullText() && ftsDue && ftsDue <= Date.now() && this.getMeta("maintenance_phase") === "index") {
        this.setMeta("maintenance_phase", "fts");
        await this.withExclusive(() => this.maybeRunFtsBuild());
        await this.scheduleIndexing(0);
        return;
      }
      this.setMeta("maintenance_phase", "index");
      const { more, retry, worked } = await this.runIndexing();
      if (more) await this.scheduleIndexing(0);
      else if (retry) await this.scheduleIndexing(INDEX_RETRY_DELAY_MS);
      // The FTS rebuild runs in an alarm event of its own: a crashing rebuild
      // must not roll back the vector-indexing progress made above (SQLite DO
      // events are transactional), so defer it whenever this event did work.
      if (more || (worked && !retry)) await this.scheduleIndexing(0);
      else if (!retry) await this.withExclusive(() => this.maybeRunFtsBuild());
    } catch (error) {
      console.warn("LiveSync indexing failed", error);
      this.setMeta("index_retry_at", String(Date.now() + INDEX_RETRY_DELAY_MS));
      if (/subrequest/i.test(String(error))) this.setMeta("index_batch_size", String(Math.max(1, Math.floor((Number(this.getMeta("index_batch_size")) || 16) / 2))));
      await this.scheduleIndexing(INDEX_RETRY_DELAY_MS);
    }
  }

  private indexNeedsVersionUpgrade(): boolean {
    return this.getMeta(INDEX_VERSION_META_KEY) !== CURRENT_INDEX_VERSION;
  }

  private async runIndexing(): Promise<{ more: boolean; retry: boolean; worked: boolean }> {
    const started = Date.now();
    const ref = this.vaultRef();
    if (!ref || !this.dbExists()) return { more: false, retry: false, worked: false };
    const retryAt = Number(this.getMeta("index_retry_at")) || 0;
    if (retryAt > Date.now()) {
      await this.scheduleIndexing(retryAt - Date.now());
      return { more: false, retry: true, worked: false };
    }
    const fullText = this.bindings().fullText;
    const policy = await this.loadPolicy(ref);
    if (fullText?.indexVersion && this.getMeta("external_fts_version") !== fullText.indexVersion) {
      await this.withExclusive(async () => {
        await this.requestFullTextRebuild();
        this.setMeta("external_fts_version", fullText.indexVersion!);
        this.setMeta("external_fts_building", "1");
      });
    }
    const size = Math.max(1, Math.min(16, Number(this.getMeta("index_batch_size")) || 16));
    type Prepared = {
      path: string; row: RevRow | null; source: RevRow | null; state: IndexStateRow | null;
      revisions: Array<[string, string | null]>;
      content: string | null; hash: string | null; chunks: number;
      vectorOk: boolean; ftsOk: boolean; failed: boolean;
    };
    let scanned = 0;
    let preparedBytes = 0;
    let lastSeq = this.indexedSeq();
    let moreChanges = false;
    let cacheReads = 0;
    let preparationLimit = false;
    const prepared = await this.withExclusive(async () => {
      if (this.indexNeedsVersionUpgrade()) {
        this.ctx.storage.sql.exec(`UPDATE index_state SET hash = NULL`);
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        this.setMeta(INDEX_VERSION_META_KEY, CURRENT_INDEX_VERSION);
      }
      const since = this.indexedSeq();
      const changes = this.rows<ChangeRow>(
        `SELECT seq, id, rev, deleted FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`, since, INDEX_BATCH_SIZE,
      );
      scanned = changes.length;
      for (const change of changes) {
        const raw = this.rawWinningRow(change.id);
        const meta = raw ? this.first<RevisionMetadata>(`SELECT * FROM rev_metadata WHERE id = ? AND rev = ?`, raw.id, raw.rev) : null;
        const previousPath = this.first<{path: string}>(`SELECT path FROM index_state WHERE doc_id = ?`, change.id)?.path;
        if (previousPath && previousPath !== meta?.path) this.ctx.storage.sql.exec(`UPDATE index_state SET pending = 1, attempts = 0 WHERE path = ?`, previousPath);
        const path = meta?.path ?? this.first<{path: string}>(`SELECT path FROM index_state WHERE doc_id = ?`, change.id)?.path;
        if (path) {
          this.ctx.storage.sql.exec(
            `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts) VALUES (?, ?, NULL, 0, 1, 0)
             ON CONFLICT(path) DO UPDATE SET pending = 1, attempts = 0`, path, change.id,
          );
        } else if (raw && !raw.deleted) {
          // A persistent sweep revives every exhausted note, across bounded passes.
          this.setMeta("index_revive_pending", "1");
        }
      }
      if (this.getMeta("index_revive_pending") === "1") {
        const exhausted = this.rows<{path: string}>(`SELECT path FROM index_state WHERE pending = 1 AND attempts >= ? ORDER BY path LIMIT ?`, INDEX_MAX_ATTEMPTS, size);
        for (const row of exhausted) this.ctx.storage.sql.exec(`UPDATE index_state SET attempts = 0 WHERE path = ?`, row.path);
        if (exhausted.length < size) this.setMeta("index_revive_pending", "0");
      }
      // Old pending notes and new changes share a rotating cursor: neither starves.
      const cursor = this.getMeta("index_pending_cursor") ?? "";
      const candidates = this.rows<IndexStateRow>(
        `SELECT * FROM index_state WHERE (pending = 1 AND attempts < ?) OR
          (? = 1 AND fts_hash IS NULL AND hash IS NOT NULL AND pending = 0)
         ORDER BY CASE WHEN path > ? THEN 0 ELSE 1 END, path LIMIT ?`,
        INDEX_MAX_ATTEMPTS, fullText ? 1 : 0, cursor, size,
      );
      const cache = new Map<string, Promise<DocBody>>();
      const result: Prepared[] = [];
      for (const state of candidates) {
        const row = this.findNoteRow(state.path);
        const indexable = row && isIndexableMarkdownPath(state.path, policy) ? row : null;
        const children = indexable ? cloneBody(indexable).children : [];
        const revisions: Array<[string, string | null]> = indexable ? [[indexable.id, indexable.rev]] : [];
        if (Array.isArray(children)) for (const id of new Set(children.filter((id): id is string => typeof id === "string"))) {
          revisions.push([id, this.rawWinningRow(id)?.rev ?? null]);
        }
        // Stop before starting another note when its child I/O would exceed
        // this pass's budget. One large note may run alone to guarantee progress.
        const uncached = revisions.slice(1).filter(([id, rev]) => !cache.has(`${id}\0${rev}`)).length;
        if (result.length > 0 && cache.size + uncached > 128) break;
        let content: string | null = null;
        let preparationFailed = false;
        try { content = indexable ? await this.fileContentForRow(indexable, cache) : null; }
        catch (error) {
          preparationFailed = true;
          if (/subrequest/i.test(String(error))) preparationLimit = true;
        }
        const hash = content == null ? null : await hashText(content);
        result.push({path: state.path, row: indexable, source: row, state, revisions, content, hash, chunks: state.chunks, vectorOk: false, ftsOk: false, failed: preparationFailed});
        this.setMeta("index_pending_cursor", state.path);
        preparedBytes += content == null ? 0 : enc.encode(content).byteLength;
        if (preparationLimit || preparedBytes >= 4 * 1024 * 1024) break;
      }
      cacheReads = cache.size;
      lastSeq = changes.at(-1)?.seq ?? since;
      // All changes are durably represented as pending before moving the cursor.
      this.setMeta(INDEXED_SEQ_META_KEY, String(lastSeq));
      moreChanges = changes.length >= INDEX_BATCH_SIZE;
      return result;
    });
    const preparedAt = Date.now();
    let writer: FullTextIndexWriter | undefined;
    let closeOk = true;
    let failed = prepared.some(item => item.failed);
    let subrequestLimit = preparationLimit;
    const failure = (error: unknown) => {
      failed = true;
      if (/subrequest|too many requests/i.test(String(error))) subrequestLimit = true;
      console.warn("LiveSync index publication failed", { message: error instanceof Error ? error.message : String(error) });
    };
    try {
      for (const item of prepared) {
        try {
          if (!item.row) {
            await removeNoteVectors(this.bindings(), { ref, path: item.path, chunks: item.chunks });
            item.chunks = 0;
            item.vectorOk = true;
            if (fullText) {
              writer ??= await fullText.openWriter(ref);
              await writer.delete(item.path);
            }
            item.ftsOk = true;
          } else if (item.content != null && item.hash != null) {
            item.chunks = item.state?.hash === item.hash ? item.chunks : await upsertNoteVectors(this.bindings(), {
              ref, path: item.path, content: item.content, hash: item.hash, previousChunks: item.chunks,
              onChunksPlanned: count => { item.chunks = Math.max(item.chunks, count); this.recordPlannedChunks(item.path, item.row!.id, count); },
            });
            item.vectorOk = true;
            if (fullText && item.state?.fts_hash !== item.hash) {
              writer ??= await fullText.openWriter(ref);
              if (item.content.length > FTS_MAX_NOTE_CODE_UNITS) await writer.delete(item.path);
              else await writer.upsert({path: item.path, content: item.content, contentHash: item.hash, mtime: this.noteMtimeForRow(item.row)});
            }
            item.ftsOk = true;
          }
        } catch (error) {
          item.failed = true;
          failure(error);
          if (subrequestLimit) break;
        }
      }
    } finally {
      if (writer) {
        try { await writer.close(); }
        catch (error) { closeOk = false; failure(error); }
      }
    }
    const publishedAt = Date.now();
    const result = await this.withExclusive(async () => {
      for (const item of prepared) {
        const current = this.findNoteRow(item.path);
        const unchanged = (current?.id ?? null) === (item.source?.id ?? null) &&
          (current?.rev ?? null) === (item.source?.rev ?? null) &&
          item.revisions.every(([id, rev]) => (this.rawWinningRow(id)?.rev ?? null) === rev);
        if (!unchanged) {
          this.ctx.storage.sql.exec(`UPDATE index_state SET pending = 1, attempts = 0 WHERE path = ?`, item.path);
          continue;
        }
        const completed = item.vectorOk && item.ftsOk && closeOk && !item.failed;
        if (completed && !item.row) {
          this.ctx.storage.sql.exec(`DELETE FROM index_state WHERE path = ?`, item.path);
          continue;
        }
        // Never acknowledge a buffered upsert OR deletion before close succeeds.
        this.ctx.storage.sql.exec(
          `UPDATE index_state SET hash = ?, fts_hash = ?, chunks = ?, doc_id = ?, pending = ?, attempts = CASE WHEN ? = 0 THEN 0 ELSE attempts + 1 END WHERE path = ?`,
          item.vectorOk ? item.hash : item.state?.hash ?? null,
          fullText && item.ftsOk && closeOk && !item.failed ? item.hash : item.state?.fts_hash ?? null,
          item.chunks, item.source?.id ?? item.state?.doc_id ?? null, completed ? 0 : 1, !completed && item.row && item.content == null && !item.failed ? 1 : 0, item.path,
        );
      }
      if (!fullText && (prepared.length || scanned)) this.armFtsBuild(FTS_BUILD_DEBOUNCE_MS);
      const pending = this.first<{n: number}>(`SELECT COUNT(*) AS n FROM index_state WHERE pending = 1 AND attempts < ?`, INDEX_MAX_ATTEMPTS)?.n ?? 0;
      const backlog = fullText && !!this.first(`SELECT 1 FROM index_state WHERE fts_hash IS NULL AND pending = 0 AND hash IS NOT NULL LIMIT 1`);
      const retry = failed || prepared.some(item => item.row && item.content == null);
      this.setMeta("index_retry_at", failed ? String(Date.now() + INDEX_RETRY_DELAY_MS) : "0");
      this.setMeta("index_batch_size", String(subrequestLimit ? Math.max(1, Math.floor(size / 2)) : failed ? size : Math.min(16, size + 1)));
      return { more: !retry && (moreChanges || pending > 0 || !!backlog || this.getMeta("index_revive_pending") === "1"), retry, worked: prepared.length > 0 || scanned > 0, pendingCount: pending };
    });
    if (fullText && !result.more && !result.retry && this.getMeta("external_fts_building") === "1" &&
        !this.first(`SELECT 1 FROM index_state WHERE pending = 1 OR fts_hash IS NULL LIMIT 1`)) {
      await fullText.completeRebuild?.(ref);
      this.setMeta("external_fts_building", "0");
    }
    console.log("LiveSync performance", { phase: "index", scanned, prepared: prepared.length, preparedBytes, chunkReads: cacheReads,
      prepareMs: preparedAt - started, publishMs: publishedAt - preparedAt, acknowledgeMs: Date.now() - publishedAt,
      more: result.more, retry: result.retry, pending: result.pendingCount });
    return result;
  }

  /** Track every vector a partially successful upsert might leave behind. */
  private recordPlannedChunks(path: string, docId: string, count: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
       VALUES (?, ?, NULL, ?, 1, 0)
       ON CONFLICT(path) DO UPDATE SET
         doc_id = excluded.doc_id, chunks = MAX(index_state.chunks, excluded.chunks), pending = 1`,
      path,
      docId,
      count,
    );
  }

  /**
   * Whether notes wait for the full-text index with no pass scheduled to
   * take them: external index backlog, or (built-in) pending notes while
   * nothing is armed. An armed pass or a recorded error means the alarm, or
   * an explicit ftsRebuild, handles it.
   */
  private hasFullTextBacklog(): boolean {
    const external = this.externalFullText();
    if (external) {
      return (Boolean(external.indexVersion && external.indexVersion !== this.getMeta("external_fts_version")) || this.getMeta("external_fts_building") === "1" ||
        this.first<{ n: number }>(
          `SELECT 1 AS n FROM index_state
           WHERE fts_hash IS NULL AND pending = 0 AND hash IS NOT NULL LIMIT 1`,
        ) != null
      );
    }
    if (this.getMeta(FTS_ERROR_META_KEY)) return false;
    const due = Number(this.getMeta(FTS_REBUILD_AT_META_KEY)) || null;
    // A pass whose time has come but whose alarm was lost (reset, upgrade)
    // counts as backlog too; the alarm this schedules runs it.
    if (due != null) return due <= Date.now();
    return this.hasFtsPending();
  }

  /** Re-send every note to the full-text index (external: per note; built-in: new segments). */
  private async requestFullTextRebuild(): Promise<void> {
    const fullText = this.externalFullText();
    const ref = this.vaultRef();
    if (fullText && ref) {
      await fullText.beginRebuild?.(ref);
      this.setMeta("external_fts_building", "1");
    }
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = 'fts_debounce_deadline'`);
    this.setMeta("index_retry_at", "0");
    this.setMeta("maintenance_phase", "fts");
    // Resetting attempts also revives notes that gave up while the index was unreachable.
    this.ctx.storage.sql.exec(`UPDATE index_state SET fts_hash = NULL, attempts = 0`);
    if (!this.externalFullText()) {
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
      // The existing segments keep serving searches until the rebuilt ones
      // cover every note; then they are retired (see runFtsPass).
      this.setMeta(FTS_REBUILD_EPOCH_META_KEY, String(Date.now()));
      this.armFtsBuild(0);
    }
  }

  /**
   * The host's external full-text index, if any. Paths that never looked at
   * bindings before it existed treat a failing bindings() as "none", so they
   * keep behaving as they did.
   */
  private externalFullText(): FullTextIndex | undefined {
    try {
      return this.bindings().fullText;
    } catch {
      return undefined;
    }
  }

  private noteMtimeForRow(row: RevRow): number | null {
    const meta = this.first<{ mtime: number | null }>(
      `SELECT mtime FROM rev_metadata WHERE id = ? AND rev = ?`,
      row.id,
      row.rev,
    );
    if (meta?.mtime != null) return meta.mtime;
    const mtime = cloneBody(row).mtime;
    return typeof mtime === "number" ? mtime : null;
  }

  private ftsBucket(): R2Bucket {
    const bucket = this.bindings().bucket;
    if (!bucket) throw new Error("VaultBindings needs either bucket or fullText");
    return bucket;
  }

  // ---------------------------------------------------------------------
  // Built-in R2 full-text index: one immutable segment per pass, driven by
  // index_state.fts_hash (null or stale = the note waits for the index)
  // ---------------------------------------------------------------------

  private static readonly FTS_PENDING_WHERE = `pending = 0 AND hash IS NOT NULL AND doc_id IS NOT NULL
         AND (fts_hash IS NULL OR fts_hash != hash)`;

  private hasFtsPending(): boolean {
    return (
      this.first<{ n: number }>(
        `SELECT 1 AS n FROM index_state WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE} LIMIT 1`,
      ) != null
    );
  }

  private countFtsPending(): number {
    return (
      this.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM index_state WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE}`,
      )?.count ?? 0
    );
  }

  private armFtsBuild(delayMs: number): void {
    let at = Date.now() + delayMs;
    if (delayMs === FTS_BUILD_DEBOUNCE_MS) {
      const deadline = Number(this.getMeta("fts_debounce_deadline")) || at;
      at = Math.min(at, deadline);
      this.setMeta("fts_debounce_deadline", String(deadline));
    }
    this.setMeta(FTS_REBUILD_AT_META_KEY, String(at));
  }

  private async maybeRunFtsBuild(): Promise<void> {
    if (!this.vaultRef() || !this.dbExists() || this.externalFullText()) return;
    const dueRaw = this.getMeta(FTS_REBUILD_AT_META_KEY);
    let due = dueRaw ? Number(dueRaw) : null;
    if (due == null) {
      // Nothing armed: notes can still be waiting after a reset rolled the
      // arming back, or from before the index tracked them per note.
      if (this.getMeta(FTS_ERROR_META_KEY) || !this.hasFtsPending()) return;
      due = Date.now();
    }
    if (Date.now() < due) {
      await this.scheduleIndexing(due - Date.now());
      return;
    }
    try {
      const more = await this.runFtsPass();
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = 'fts_debounce_deadline'`);
      if (more) {
        this.armFtsBuild(0);
        await this.scheduleIndexing(0);
      } else {
        this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_AT_META_KEY);
      }
    } catch (error) {
      console.warn("FTS pass failed", error);
      this.armFtsBuild(FTS_BUILD_RETRY_MS);
      await this.scheduleIndexing(FTS_BUILD_RETRY_MS);
    }
  }

  /**
   * One alarm event's worth of full-text work: index pending notes into a
   * new segment, or, once nothing is pending, one maintenance step (retire
   * the legacy generation, merge two segments). Returns whether another pass
   * is needed right away.
   */
  private async runFtsPass(): Promise<boolean> {
    const ref = this.vaultRef();
    if (!ref) return false;
    const bucket = this.ftsBucket();

    // An interrupted previous attempt (memory reset, CPU limit) leaves its
    // last phase marker behind; a completed or abandoned one does not count.
    const previous = await readFtsPhase(bucket, ref);
    const interrupted = previous != null && !FTS_SETTLED_PHASES.includes(String(previous.phase));
    const attempts = (interrupted ? Number(previous.attempts) || 0 : 0) + 1;
    if (attempts > FTS_MAX_BUILD_ATTEMPTS) {
      const message = `full-text pass was interrupted ${attempts - 1} times (last phase: ${String(previous?.phase)}); the vault is probably too large for the in-DO build`;
      console.warn("FTS pass giving up", { attempts: attempts - 1, lastPhase: previous?.phase });
      await markFtsPhase(bucket, ref, "failed", { attempts: attempts - 1, lastPhase: previous?.phase });
      this.setMeta(FTS_ERROR_META_KEY, message);
      return false;
    }
    const marker = { attempts };

    const pending = this.rows<{ path: string; doc_id: string; hash: string }>(
      `SELECT path, doc_id, hash FROM index_state
       WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE}
       ORDER BY path LIMIT ?`,
      FTS_SEGMENT_MAX_DOCS + 1,
    );
    if (pending.length > 0) {
      await markFtsPhase(bucket, ref, "segment-start", { ...marker, pending: pending.length });
      const manifest = await readFtsManifest(bucket, ref);
      const maxTotal = this.bindings().ftsMaxTotalCodeUnits ?? FTS_MAX_TOTAL_CODE_UNITS;
      const indexedChars = manifest ? this.ftsCountedSegments(manifest).reduce((sum, s) => sum + s.totalChars, 0) : 0;
      try {
        return await this.buildFtsSegment(ref, pending, { marker, budget: maxTotal - indexedChars, maxTotal });
      } catch (error) {
        if (!(error instanceof FtsTooLargeError)) throw error;
        // Over the guard. Dead weight (replaced versions) counts toward it,
        // so shed the worst segment's first and try again; only a vault that
        // is too big when live is recorded as such and disarmed.
        const rewrite = manifest ? await this.planFtsStaleRewrite(ref, manifest, { force: true }) : null;
        if (rewrite) {
          console.warn("FTS pass over the size guard; rewriting a segment to drop stale text", { segment: rewrite.segments[0]?.id });
          await this.runFtsCompaction(ref, rewrite, marker, "current");
          return true;
        }
        const message = `vault exceeds the full-text size guard (${error.codeUnits.toLocaleString("en")}+ of ${error.limit.toLocaleString("en")} code units)`;
        console.warn("FTS pass aborted: vault exceeds size guard", { codeUnits: error.codeUnits });
        await markFtsPhase(bucket, ref, "too-large", { codeUnits: error.codeUnits });
        this.setMeta(FTS_ERROR_META_KEY, message);
        return false;
      }
    }

    // Nothing pending: maintenance, one step per event.
    const manifest = await readFtsManifest(bucket, ref);
    if (!manifest) return false;
    const epoch = this.ftsRebuildEpoch();
    const outdated = this.ftsOutdatedSegments(manifest).map((s) => s.id);
    if (outdated.length > 0) {
      // Every note is in a hashed segment now (and, after a rebuild, in one
      // built since): the older ones are redundant.
      await retireFtsSegments(bucket, ref, outdated);
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
      console.log("FTS outdated segments retired", { segments: outdated, rebuild: epoch != null });
      return true;
    }
    if (epoch != null) {
      // Nothing pending and nothing older than the rebuild: it is complete.
      this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
    }
    const merge = planFtsCompaction(manifest, {
      maxSegments: FTS_COMPACT_MAX_SEGMENTS,
      maxMergedChars: FTS_COMPACT_MAX_MERGED_CHARS,
    });
    if (merge) {
      await this.runFtsCompaction(ref, merge, marker, "indexed");
      return true;
    }
    const rewrite = await this.planFtsStaleRewrite(ref, manifest);
    if (!rewrite) return false;
    await this.runFtsCompaction(ref, rewrite, marker, "current");
    return true;
  }

  /**
   * Merge or rewrite segments. "indexed" keeps the version the index last
   * recorded for a path (searches never lose a note that way); "current"
   * keeps only the vault's current content, dropping versions of notes that
   * are still waiting to be re-indexed, which is what frees space.
   */
  private async runFtsCompaction(
    ref: VaultRef,
    plan: CompactionPlan,
    marker: Record<string, unknown>,
    keep: "indexed" | "current",
  ): Promise<void> {
    const merged = await compactFtsSegments(this.ftsBucket(), ref, plan, {
      isLive: (docs) =>
        docs.map((doc) =>
          keep === "indexed" ? this.ftsDocIsLive(doc.path, doc.hash ?? null) : this.ftsDocIsCurrent(doc.path, doc.hash ?? null),
        ),
      marker,
    });
    if (merged) this.setMeta(FTS_GENERATION_META_KEY, merged.segment.id);
    console.log("FTS segments compacted", {
      merged: plan.segments.map((s) => s.id),
      into: merged?.segment.id,
      docCount: merged?.segment.docCount,
    });
  }

  private ftsRebuildEpoch(): number | null {
    const raw = this.getMeta(FTS_REBUILD_EPOCH_META_KEY);
    return raw ? Number(raw) || null : null;
  }

  /** Segments a maintenance step retires: the legacy generation, and those a rebuild replaced. */
  private ftsOutdatedSegments(manifest: FtsManifest): FtsSegment[] {
    const epoch = this.ftsRebuildEpoch();
    return manifest.segments.filter((s) => !s.hashed || (epoch != null && s.builtAt < epoch));
  }

  /** Whether a segment entry is the vault's current content of its path (see runFtsCompaction). */
  private ftsDocIsCurrent(path: string, hash: string | null): boolean {
    if (hash == null) return false;
    const row = this.first<{ hash: string | null }>(`SELECT hash FROM index_state WHERE path = ?`, path);
    return row?.hash === hash;
  }

  private ftsStaleRewriteCandidates(manifest: FtsManifest): FtsSegment[] {
    return this.ftsCountedSegments(manifest).filter((s) => s.hashed && s.format === 2);
  }

  /** Cheap check (manifest and doc counts only) for whether a stale scan could find enough to rewrite. */
  private ftsStaleDocsSuspected(manifest: FtsManifest): boolean {
    const candidates = this.ftsStaleRewriteCandidates(manifest);
    if (!candidates.some((s) => s.totalChars >= FTS_STALE_REWRITE_MIN_CHARS)) return false;
    const liveDocs =
      this.first<{ count: number }>(`SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NOT NULL`)?.count ?? 0;
    return candidates.reduce((sum, s) => sum + s.docCount, 0) > liveDocs * FTS_STALE_SCAN_DOC_RATIO;
  }

  /** Segments the size guard counts: all of them, minus those a rebuild in progress will retire. */
  private ftsCountedSegments(manifest: FtsManifest): FtsSegment[] {
    const epoch = this.ftsRebuildEpoch();
    return epoch == null ? manifest.segments : manifest.segments.filter((s) => s.builtAt >= epoch);
  }

  /**
   * The segment worth rewriting alone to drop replaced/deleted versions, if
   * any. Reading every segment's doc list is skipped while the manifest's
   * doc count says there is little to gain, unless `force` (the size guard
   * tripped).
   */
  private async planFtsStaleRewrite(
    ref: VaultRef,
    manifest: FtsManifest,
    options: { force?: boolean } = {},
  ): Promise<CompactionPlan | null> {
    const candidates = this.ftsStaleRewriteCandidates(manifest);
    if (candidates.length === 0) return null;
    if (!options.force && !this.ftsStaleDocsSuspected(manifest)) return null;
    const liveChars = new Map<string, number>();
    for (const segment of candidates) {
      const docs = await readFtsSegmentDocs(this.ftsBucket(), ref, segment.id);
      let live = 0;
      for (const doc of docs) if (this.ftsDocIsCurrent(doc.path, doc.hash ?? null)) live += doc.chars;
      liveChars.set(segment.id, live);
    }
    return planFtsStaleRewrite({ ...manifest, segments: candidates }, liveChars, {
      minFreedRatio: FTS_STALE_REWRITE_MIN_RATIO,
      minFreedChars: FTS_STALE_REWRITE_MIN_CHARS,
    });
  }

  /**
   * Index up to one segment's worth of the pending notes and record them as
   * indexed. Returns whether another pass is needed: more of the backlog, or
   * a maintenance step the new manifest calls for. Bodies are read one note
   * at a time while the segment is built, so only the postings and one note
   * live in memory at once.
   */
  private async buildFtsSegment(
    ref: VaultRef,
    pending: Array<{ path: string; doc_id: string; hash: string }>,
    options: { marker: Record<string, unknown>; budget: number; maxTotal: number },
  ): Promise<boolean> {
    const bucket = this.ftsBucket();
    const self = this;
    const written: Array<{ path: string; hash: string }> = [];
    // Notes not worth a segment entry (oversized, body gone) are still marked
    // indexed, or the pass would pick them up again forever.
    const skipped: Array<{ path: string; hash: string }> = [];
    let consumed = 0;
    let codeUnits = 0;
    const cache = new Map<string, Promise<DocBody>>();
    async function* inputs(): AsyncGenerator<FtsDocInput> {
      for (const row of pending) {
        if (consumed >= Math.min(128, FTS_SEGMENT_MAX_DOCS) || codeUnits >= FTS_SEGMENT_MAX_CODE_UNITS || (consumed > 0 && cache.size >= 128)) break;
        const rev = self.rawWinningRow(row.doc_id);
        const full = rev ? await self.fileContentForRow(rev, cache) : null;
        if (full == null) {
          consumed += 1;
          console.warn("FTS pass skipping note without a readable body", { path: row.path });
          skipped.push(row);
          continue;
        }
        // The note is indexed as its body is now, under the hash the vault
        // recorded for it (which is what "indexed" is checked against). If
        // the body moved on since, the change is in the feed and re-queues
        // the note with its new hash; a note whose recorded hash never
        // matches its body would otherwise stay pending forever.
        // A long note is indexed up to the cap (its first part stays
        // searchable), and a note the segment has no room for starts the
        // next one rather than stretching this one.
        const content = full.length > FTS_MAX_NOTE_CODE_UNITS ? full.slice(0, FTS_MAX_NOTE_CODE_UNITS) : full;
        if (content.length < full.length) {
          console.warn("FTS pass indexing only the start of a long note", { path: row.path, codeUnits: full.length });
        }
        if (consumed > 0 && codeUnits + content.length > FTS_SEGMENT_MAX_CODE_UNITS) break;
        consumed += 1;
        codeUnits += content.length;
        if (codeUnits > options.budget) {
          throw new FtsTooLargeError(options.maxTotal - options.budget + codeUnits, options.maxTotal);
        }
        const mtime = rev ? self.noteMtimeForRow(rev) : null;
        written.push(row);
        yield {
          path: row.path,
          content,
          hash: row.hash,
          ...(mtime != null ? { mtime } : {}),
        };
      }
    }

    const result = await appendFtsSegment(bucket, ref, inputs(), { marker: options.marker });
    // A note the build handed back (segment full of terms) stays pending for
    // the next segment; one it dropped (too many terms on its own) is marked
    // like an oversized note.
    if (result.dropped.length > 0) console.warn("FTS pass dropping notes with too many distinct terms", { paths: result.dropped });
    const settled = new Set([...result.docs.map((doc) => doc.path), ...result.dropped]);
    const indexed = written.filter((row) => settled.has(row.path));
    for (const row of [...indexed, ...skipped]) {
      this.ctx.storage.sql.exec(
        `UPDATE index_state SET fts_hash = ? WHERE path = ? AND hash = ?`,
        row.hash,
        row.path,
        row.hash,
      );
    }
    if (result.segment) this.setMeta(FTS_GENERATION_META_KEY, result.segment.id);
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
    console.log("FTS segment written", {
      segment: result.segment?.id ?? null,
      docCount: result.segment?.docCount ?? 0,
      codeUnits,
      skipped: skipped.length,
      dropped: result.dropped.length,
      segments: result.manifest?.segments.length,
      attempts: options.marker.attempts,
    });
    return consumed < pending.length || this.hasFtsPending() || this.ftsNeedsMaintenance(result.manifest);
  }

  /** Whether the idle maintenance step (retire outdated, merge, shed stale text) may have work. */
  private ftsNeedsMaintenance(manifest: FtsManifest | null | undefined): boolean {
    if (!manifest) return false;
    return (
      this.ftsOutdatedSegments(manifest).length > 0 ||
      planFtsCompaction(manifest, {
        maxSegments: FTS_COMPACT_MAX_SEGMENTS,
        maxMergedChars: FTS_COMPACT_MAX_MERGED_CHARS,
      }) != null ||
      this.ftsStaleDocsSuspected(manifest)
    );
  }

  /**
   * Whether a segment entry is the vault's current version of its path. A
   * hashed entry is current when the index last wrote that hash, or, while a
   * forced rebuild has cleared the index's record, when the note still has
   * that content. A legacy entry (no hash) stands until the note is written
   * to a hashed segment.
   */
  private ftsDocIsLive(path: string, hash: string | null): boolean {
    const row = this.first<{ hash: string | null; fts_hash: string | null }>(
      `SELECT hash, fts_hash FROM index_state WHERE path = ?`,
      path,
    );
    if (!row) return false;
    if (hash == null) return row.fts_hash == null;
    return row.fts_hash === hash || (row.fts_hash == null && row.hash === hash);
  }

  /**
   * Check ranked search candidates against the vault's current state, drop
   * replaced/deleted versions and duplicate paths, and return the bodies of
   * the first `limit` survivors (for snippets) in one round trip.
   */
  private async resolveFtsHits(body: InternalOp & { candidates?: unknown; limit?: unknown }): Promise<Response> {
    const candidates = Array.isArray(body.candidates)
      ? body.candidates
          .filter(
            (c): c is { path: string; hash: string | null } =>
              typeof c === "object" && c != null && typeof (c as { path: unknown }).path === "string",
          )
          .slice(0, FTS_RESOLVE_MAX_CANDIDATES)
      : [];
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 20;
    const hits: Array<{ path: string; hash: string | null; content: string | null }> = [];
    if (!this.dbExists()) return json({ hits });
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (hits.length >= limit) break;
      const hash = typeof candidate.hash === "string" ? candidate.hash : null;
      if (seen.has(candidate.path) || !this.ftsDocIsLive(candidate.path, hash)) continue;
      const docId = this.first<{ doc_id: string | null }>(
        `SELECT doc_id FROM index_state WHERE path = ?`,
        candidate.path,
      )?.doc_id;
      const rev = docId ? this.rawWinningRow(docId) : null;
      if (!rev || rev.deleted) continue;
      const metadata = this.first<{ path: string | null; soft_deleted: number }>(
        `SELECT path, soft_deleted FROM rev_metadata WHERE id = ? AND rev = ?`, rev.id, rev.rev,
      );
      if (metadata && (metadata.soft_deleted || metadata.path !== candidate.path)) continue;
      if (docIsDeleted(cloneBody(this.hydrateRevision(rev)))) continue;
      const content = await this.fileContentForRow(rev);
      if (content == null || (hash != null && (await hashText(content)) !== hash)) continue;
      seen.add(candidate.path);
      hits.push({ path: candidate.path, hash, content });
    }
    return json({ hits });
  }

  /**
   * Winning note revisions with their paths in one pass. Per-path lookups
   * (findNoteRow) are unusable here: their fallback JSON-scans every winning
   * rev body per call, which blows the DO CPU limit on a full rebuild.
   */
  private listNoteRevisionsForFts(paths?: string[]): Array<
    RevRow & { fts_path: string; fts_mtime: number | null }
  > {
    const pathBindings = paths ? [JSON.stringify(paths)] : [];
    type FtsRevRow = RevRow & { fts_path: string; fts_mtime: number | null };
    const rows = this.rows<FtsRevRow>(
      `SELECT r.*, m.path AS fts_path, m.mtime AS fts_mtime
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0 AND m.path IS NOT NULL
         AND COALESCE(m.type, '') NOT IN ('leaf', 'chunkpack')
         AND m.soft_deleted = 0
         ${paths ? "AND m.path IN (SELECT value FROM json_each(?))" : ""}`,
      ...pathBindings,
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
         ${paths ? "AND json_extract(r.body, '$.path') IN (SELECT value FROM json_each(?))" : ""}
         AND COALESCE(json_extract(r.body, '$.deleted'), 0) != 1
         AND NOT EXISTS (
           SELECT 1 FROM rev_metadata m WHERE m.id = r.id AND m.rev = r.rev
         )`,
      ...pathBindings,
    ));
    return rows;
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

  private async readFile(path: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!path) return couchError(400, "bad_request", "File path is required.");
    const row = this.findNoteRow(path);
    if (!row) return couchError(404, "not_found", "File not found.");
    return json({ content: await this.fileContentForRow(row) });
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
    // updated_seq is the document's latest change, not the winner's own seq:
    // a _changes reader must learn that the winner changed (e.g. the old
    // winner was deleted) even when the new winner's revision is old.
    this.ctx.storage.sql.exec(
      `INSERT INTO docs (id, winning_rev, deleted, updated_seq)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE id = ?))
       ON CONFLICT(id) DO UPDATE SET
         winning_rev = excluded.winning_rev,
         deleted = excluded.deleted,
         updated_seq = excluded.updated_seq`,
      id,
      winner.rev,
      winner.deleted,
      id,
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

  /**
   * Connects a revision's ancestors (nearest first) into the stored tree:
   * ancestors the replicator skipped become body-less stubs, and an
   * ancestor stored earlier with a shorter history gets its missing parent
   * filled in. Walk the complete supplied path: an existing parent may itself
   * have arrived with a shorter, incomplete history.
   */
  private linkAncestors(id: string, ancestors: string[], seq: number): void {
    for (const [index, rev] of ancestors.entries()) {
      const parentRev = ancestors[index + 1] ?? null;
      const existing = this.rawRevRow(id, rev);
      if (existing) {
        if (existing.parent_rev) continue;
        if (!parentRev) break;
        this.ctx.storage.sql.exec(
          `UPDATE revs SET parent_rev = ? WHERE id = ? AND rev = ?`,
          parentRev,
          id,
          rev,
        );
        continue;
      }
      const parsed = parseRev(rev);
      if (!parsed) break;
      this.ctx.storage.sql.exec(
        `INSERT INTO revs
           (id, rev, gen, parent_rev, body, body_chunked, body_available, deleted, seq, rev_history)
         VALUES (?, ?, ?, ?, '{}', 0, 0, 0, ?, NULL)`,
        id,
        rev,
        parsed.gen,
        parentRev,
        seq,
      );
    }
  }

  private async writeRevision(row: {
    id: string;
    rev: string;
    gen: number;
    parentRev: string | null;
    ancestors?: string[];
    body: string;
    metadata: RevisionMetadata;
    deleted: number;
    seq: number;
    revHistory: string;
  }): Promise<void> {
    const external = await this.chunkBodies.prepare(row.id, row.rev, row.body, row.metadata.type, row.deleted);
    const chunks = external ? null : splitRevisionBody(row.body);
    this.ctx.storage.transactionSync(() => {
      if (external) this.chunkBodies.reference(row.id, row.rev, external);
      if (row.ancestors) this.linkAncestors(row.id, row.ancestors, row.seq);
      this.ctx.storage.sql.exec(
        `INSERT INTO revs
           (id, rev, gen, parent_rev, body, body_chunked, body_available, deleted, seq, rev_history)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        row.id,
        row.rev,
        row.gen,
        row.parentRev,
        external ? '{"type":"leaf"}' : chunks ? "{}" : row.body,
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
        `INSERT INTO rev_metadata (id, rev, path, size, mtime, type, soft_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.rev,
        row.metadata.path,
        row.metadata.size,
        row.metadata.mtime,
        row.metadata.type,
        row.metadata.soft_deleted,
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

  private async publicDoc(row: RevRow, options?: { conflicts?: boolean; revs?: boolean }): Promise<DocBody> {
    row = { ...row, body: await this.chunkBodies.read(row.id, row.rev) ?? this.revisionBody(row) };
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
      let parentRev = typeof doc._rev === "string" ? doc._rev : null;
      const deletedWinner = this.rawWinningRow(id);
      if (deletedWinner && deletedWinner.deleted && !parentRev) parentRev = deletedWinner.rev;
      const rev = await newRevision(doc, parentRev);
      // All vault operations share the operation queue, including R2 writes.
      const current = this.rawWinningRow(id);
      if (!parentRev && current) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      // Any current leaf may be extended, not only the winner: deleting a
      // losing revision is how CouchDB conflicts are resolved.
      const parent = parentRev
        ? this.rawLeafRevs(id).find((leaf) => leaf.rev === parentRev) ?? null
        : null;
      if (parentRev && !parent) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      const seq = this.nextSeq();
      const deleted = doc._deleted === true ? 1 : 0;
      const parsed = parseRev(rev)!;
      const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: rev };
      if (deleted) stored._deleted = true;
      await this.writeRevision({
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
    const ancestors = ancestorsFromRevisions(doc);
    const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: doc._rev };
    await this.writeRevision({
      id,
      rev: doc._rev,
      gen: parsed.gen,
      parentRev: ancestors[0] ?? null,
      ancestors,
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
      return json(await this.publicDoc(row, {
        conflicts: boolParam(url.searchParams.get("conflicts")),
        revs: boolParam(url.searchParams.get("revs")),
      }), { headers: { etag: `"${row.rev}"` } });
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      assertDocumentSize(body);
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

  private async handleOpenRevs(id: string, openRevs: string, url: URL): Promise<Response> {
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
    const rows: Array<{ ok: DocBody } | { missing: string }> = [];
    for (const rev of revs) {
      const found = latest
        ? this.descendantLeafRevs(id, rev)
        : [this.revRow(id, rev)].filter((row): row is RevRow => row !== null);
      if (found.length === 0) rows.push({ missing: rev });
      for (const row of found) rows.push({ ok: await this.publicDoc(row, { revs: includeRevs }) });
    }
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
      assertDocumentSize(body);
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
    const started = Date.now();
    const body = await readJsonBody(request);
    assertBulkLimits(body);
    if (!Array.isArray(body.docs) || body.docs.some(doc => !doc || typeof doc !== "object" || Array.isArray(doc))) {
      throw new BadRequestError("docs must be an array of documents");
    }
    const docs = body.docs as DocBody[];
    const newEdits = body.new_edits !== false;
    const validatedAt = Date.now();
    const results = [];
    for (const doc of docs) {
      const result = await this.insertRevision(doc, { newEdits });
      results.push(
        result.ok
          ? { ok: true, id: result.id, rev: result.rev }
          : { id: result.id, error: result.error, reason: result.reason },
      );
    }
    console.log("LiveSync performance", { phase: "bulk", documents: docs.length, validateMs: validatedAt - started, persistMs: Date.now() - validatedAt });
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
    assertBulkLimits(body);
    const includeRevs = boolParam(body.revs) || boolParam(url.searchParams.get("revs"));
    const latest = boolParam(body.latest) || boolParam(url.searchParams.get("latest"));
    const docs = Array.isArray(body.docs)
      ? (body.docs as Array<{ id?: unknown; rev?: unknown }>)
      : [];
    const results = await mapBatched(docs, async (item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const rev = typeof item.rev === "string" ? item.rev : "";
      const rows = id && rev
        ? latest ? this.descendantLeafRevs(id, rev)
          : [this.revRow(id, rev)].filter((row): row is RevRow => row !== null)
        : id ? this.leafRevs(id) : [];
      const found: unknown[] = [];
      for (const row of rows) found.push({ ok: await this.publicDoc(row, { revs: includeRevs }) });
      return { id, docs: found.length ? found : [{ error: { id, rev, error: "not_found", reason: "missing" } }] };
    });
    return json({ results });
  }

  private async allDocsOptions(request: Request): Promise<Record<string, unknown>> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const options: Record<string, unknown> = { ...Object.fromEntries(url.searchParams.entries()), ...body };
    if (typeof options.keys === "string") {
      try { options.keys = JSON.parse(options.keys); }
      catch { throw new BadRequestError("keys must be a JSON array of strings"); }
    }
    if (options.keys !== undefined && (!Array.isArray(options.keys) || options.keys.some(key => typeof key !== "string"))) {
      throw new BadRequestError("keys must be an array of strings");
    }
    return options;
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
      if (keys.length > REQUEST_LIMITS.maxAllDocsKeys) throw new RequestLimitError("maxAllDocsKeys");
      return json({
        total_rows: totalRows,
        offset: 0,
        rows: await this.allDocsRows(keys, includeDocs, conflicts),
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
    );
    return json({ total_rows: totalRows, offset: skip, rows: await this.allDocsRows(rows.map((row) => row.id), includeDocs, conflicts) });
  }

  private async allDocsRows(ids: string[], includeDoc: boolean, conflicts: boolean): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    for (let offset = 0; offset < ids.length; offset += 4) {
      const page = await mapBatches(ids.slice(offset, offset + 4), 4, id => this.allDocsRow(id, includeDoc, conflicts));
      for (const row of page) {
        bytes += enc.encode(JSON.stringify(row)).byteLength;
        if (bytes > REQUEST_LIMITS.maxResponseBytes) throw new RequestLimitError("maxResponseBytes");
        rows.push(row);
      }
    }
    return rows;
  }

  private async allDocsRow(id: string, includeDoc: boolean, conflicts: boolean): Promise<Record<string, unknown>> {
    const row = this.winningRow(id);
    if (!row) return { key: id, error: "not_found" };
    const value: Record<string, unknown> = { rev: row.rev };
    if (row.deleted) value.deleted = true;
    const out: Record<string, unknown> = { id, key: id, value };
    if (includeDoc) out.doc = row.deleted ? null : await this.publicDoc(row, { conflicts });
    return out;
  }

  private async handleFind(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const selector = (body.selector ?? {}) as Selector;
    const limit = numberParam(body.limit, 25);
    const docs: DocBody[] = [];
    for (const entry of this.rows<DocRow>(`SELECT * FROM docs ORDER BY id`)) {
      if (docs.length >= limit) break;
      const row = this.winningRow(entry.id);
      if (!row || row.deleted) continue;
      const doc = await this.publicDoc(row);
      if (matchesSelector(doc, selector)) docs.push(doc);
    }
    return json({ docs, warning: "no matching index found, create an index to optimize query time" });
  }

  private async handleCompact(): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      this.chunkBodies.compact();
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
    await this.scheduleIndexing(0);
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
    const started = Date.now();
    this.selectorFallbacks = 0;
    this.selectorScanned = 0;
    const batch = await this.changeBatch(options, since);
    const selectedAt = Date.now();
    const results = await this.changeResults(batch.rows, options);
    if (results.length < batch.rows.length) {
      batch.lastSeq = batch.rows[results.length - 1]!.seq;
      batch.pending = this.first<{count: number}>(`SELECT COUNT(*) AS count FROM docs WHERE updated_seq > ?`, batch.lastSeq)?.count ?? 0;
    }
    console.log("LiveSync performance", { phase: "changes", selected: results.length, pending: batch.pending,
      scanned: this.selectorScanned, metadataFallbacks: this.selectorFallbacks, selectMs: selectedAt - started, hydrateMs: Date.now() - selectedAt });
    const idle = batch.rows.length === 0 && batch.lastSeq === since;
    return json(
      {
        results,
        last_seq: batch.lastSeq,
        pending: batch.pending,
      },
      idle ? { headers: { [CHANGES_IDLE_HEADER]: "1" } } : undefined,
    );
  }

  private async changeBatch(options: Record<string, unknown>, since: number): Promise<ChangeBatch> {
    const cap = boolParam(options.include_docs) || options.selector ? 128 : 5000;
    const limit = Math.min(Math.max(numberParam(options.limit, 1000), 1), cap);
    const selector = (options.selector ?? null) as Selector | null;
    const style = String(options.style ?? "main_only");
    const scanLimit = selector ? Math.min(limit * 10, 5000) : limit;
    const rows: ChangeRow[] = [];
    let lastSeq = since;

    // The limit applies to matching rows, not scanned documents. In particular,
    // a run of chunks must not look like the end of a filtered replication.
    while (rows.length < limit) {
      // Each document appears once, at its latest change (including when
      // deleting a winning revision reveals an older winner).
      const candidates = this.rows<ChangeRow>(
        `SELECT updated_seq AS seq, id, winning_rev AS rev, deleted
         FROM docs
         WHERE updated_seq > ?
         ORDER BY updated_seq
         LIMIT ?`,
        lastSeq,
        scanLimit,
      );
      for (const row of candidates) {
        this.selectorScanned++;
        lastSeq = row.seq;
        if (style === "all_docs") {
          const leaves = this.rawLeafRevs(row.id);
          const matching: RevRow[] = [];
          for (const leaf of leaves) {
            if (!selector || await this.matchesRevisionSelector(leaf, selector)) matching.push(leaf);
          }
          if (matching.length === 0) continue;
          rows.push({ ...row, revs: matching.map((leaf) => leaf.rev) });
        } else {
          if (selector) {
            const winning = this.rawWinningRow(row.id);
            if (!winning || !await this.matchesRevisionSelector(winning, selector)) continue;
          }
          rows.push(row);
        }
        if (rows.length === limit) break;
      }
      if (rows.length < limit && candidates.length < scanLimit) {
        lastSeq = this.currentSeq();
        break;
      }
    }
    return {
      rows,
      lastSeq,
      pending: this.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM docs WHERE updated_seq > ?`,
        lastSeq,
      )?.count ?? 0,
    };
  }

  private async matchesRevisionSelector(row: RevRow, selector: Selector): Promise<boolean> {
    const metadata = this.first<RevisionMetadata>(`SELECT * FROM rev_metadata WHERE id = ? AND rev = ?`, row.id, row.rev);
    const matched = matchesMetadata(row, metadata, selector);
    if (matched !== undefined) return matched;
    this.selectorFallbacks++;
    return matchesSelector(await this.publicDoc(row), selector);
  }

  private async changeResults(rows: ChangeRow[], options: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let bytes = 0;
    for (let offset = 0; offset < rows.length; offset += 4) {
      const page = await mapBatches(rows.slice(offset, offset + 4), 4, row => this.changeResult(row, options));
      for (const result of page) {
        const size = enc.encode(JSON.stringify(result)).byteLength;
        if (results.length && bytes + size > REQUEST_LIMITS.maxResponseBytes / 2) return results;
        results.push(result);
        bytes += size;
      }
    }
    return results;
  }

  private async changeResult(row: ChangeRow, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {
      seq: row.seq,
      id: row.id,
      changes: (row.revs ?? [row.rev]).map((rev) => ({ rev })),
    };
    if (row.deleted) result.deleted = true;
    if (boolParam(options.include_docs)) {
      const rev = this.revRow(row.id, row.rev);
      if (rev) {
        result.doc = await this.publicDoc(rev, {
          conflicts: boolParam(options.conflicts),
          revs: boolParam(options.revs),
        });
      }
    }
    return result;
  }
}
