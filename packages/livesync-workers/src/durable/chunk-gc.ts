/**
 * Garbage collection of LiveSync chunks no file references any more.
 *
 * LiveSync splits every file into content-addressed `h:` chunk documents and
 * never deletes them: deleting or rewriting a file leaves its chunks behind as
 * live documents, which compaction cannot touch. This finds those orphans and,
 * after a grace period, lets the vault object delete them (CouchDB tombstones,
 * so clients drop their copies too) and compact, which frees inline bodies and
 * unreferences their R2 objects.
 *
 * The grace period matters because LiveSync uploads a file's chunks before the
 * file document that points at them: a chunk is an orphan for a moment during
 * every upload. Orphans are therefore marked first and collected only once they
 * have stayed orphaned for the whole grace period; a chunk that gains a
 * reference in between is unmarked by the next scan.
 *
 * Files LiveSync deleted logically (the document stays, marked `deleted` in its
 * body, so a client can restore it) keep their chunks referenced. They get a
 * longer grace period of their own: once a deleted file has been seen deleted
 * for that long, the collector turns it into a CouchDB tombstone and collects
 * the chunks only it held, so nothing points at a chunk that is gone.
 */

export const DEFAULT_CHUNK_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DELETED_FILES_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often the automatic collection runs when a host turns it on. */
export const DEFAULT_CHUNK_GC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_AT_KEY = "chunk_gc_scan_at";
const COLLECT_AT_KEY = "chunk_gc_collect_at";
const LAST_COLLECT_KEY = "chunk_gc_last_collect";

export type ChunkGcBytes = { count: number; sqliteBytes: number; r2Bytes: number };
export type ChunkGcCollected = ChunkGcBytes & { files: number };

export type ChunkGcOptions = {
  /** How long a chunk must stay orphaned before it is collected. Default 7 days. */
  graceMs?: number;
  /** How long a logically deleted file is kept restorable. Default 30 days. */
  deletedFilesGraceMs?: number;
  /** Deletions per collect call (files and chunks together). Default 1000. */
  limit?: number;
};

export type ChunkGcStatus = {
  graceMs: number;
  deletedFilesGraceMs: number;
  /** Live chunk documents nothing references right now. */
  orphans: ChunkGcBytes;
  /** Orphans a scan has already recorded, with when the oldest was first seen. */
  marked: { count: number; oldestMarkedAt: number | null };
  /** Marked orphans past the grace period: what the next collect deletes. */
  due: ChunkGcBytes;
  deletedFiles: {
    count: number;
    /** Chunks only deleted files still point at. */
    heldChunks: ChunkGcBytes;
    marked: { count: number; oldestMarkedAt: number | null };
    /** Deleted files past their grace period, and the chunks that go with them. */
    due: { files: number; chunks: ChunkGcBytes };
  };
  lastScanAt: number | null;
  lastCollectAt: number | null;
  lastCollect: ChunkGcCollected | null;
};

export type OrphanChunk = { id: string; rev: string; sqliteBytes: number; r2Bytes: number };
export type DeletedFile = { id: string; rev: string; children: string[] };

/** One scan's view of the vault, shared by the status and collect paths. */
export type ChunkGcScan = {
  orphans: OrphanChunk[];
  /** Live chunks referenced by deleted files only. */
  held: OrphanChunk[];
  deletedFiles: DeletedFile[];
};

type Sql = Pick<SqlStorage, "exec">;

export function sumChunks(rows: Iterable<OrphanChunk>): ChunkGcBytes {
  const total = { count: 0, sqliteBytes: 0, r2Bytes: 0 };
  for (const row of rows) {
    total.count += 1;
    total.sqliteBytes += row.sqliteBytes;
    total.r2Bytes += row.r2Bytes;
  }
  return total;
}

function childrenOf(body: string): string[] {
  try {
    const children = (JSON.parse(body) as { children?: unknown }).children;
    return Array.isArray(children) ? children.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export class ChunkGarbageCollector {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS chunk_gc (
      id TEXT PRIMARY KEY, rev TEXT NOT NULL, marked_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS deleted_file_gc (
      id TEXT PRIMARY KEY, rev TEXT NOT NULL, marked_at INTEGER NOT NULL
    )`);
  }

  private get sql(): Sql {
    return this.storage.sql;
  }

  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec<T>(query, ...args).toArray();
  }

  private meta(key: string): string | null {
    return this.rows<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  private revisionBody(id: string, rev: string, body: string, chunked: number): string {
    if (!chunked) return body;
    return this.rows<{ body: string }>(
      `SELECT body FROM rev_body_chunks WHERE id = ? AND rev = ? ORDER BY chunk_index`, id, rev,
    ).map((piece) => piece.body).join("");
  }

  /**
   * Current (leaf, non-tombstone) revisions of non-chunk documents with the
   * chunks they point at, split by whether the file is logically deleted.
   */
  private references(): { live: Set<string>; deleted: Set<string>; deletedFiles: DeletedFile[] } {
    const live = new Set<string>();
    const deleted = new Set<string>();
    const deletedFiles: DeletedFile[] = [];
    const rows = this.rows<{ id: string; rev: string; body: string; body_chunked: number; soft_deleted: number; winning: number }>(
      `SELECT r.id, r.rev, r.body, r.body_chunked, COALESCE(m.soft_deleted, 0) AS soft_deleted,
              (d.winning_rev = r.rev) AS winning
       FROM revs r
       JOIN docs d ON d.id = r.id
       LEFT JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev
       WHERE r.deleted = 0 AND d.deleted = 0 AND r.id NOT LIKE 'h:%'
         AND NOT EXISTS (SELECT 1 FROM revs child WHERE child.id = r.id AND child.parent_rev = r.rev)`,
    );
    for (const row of rows) {
      const children = childrenOf(this.revisionBody(row.id, row.rev, row.body, row.body_chunked));
      const target = row.soft_deleted ? deleted : live;
      for (const id of children) target.add(id);
      if (row.soft_deleted && row.winning) deletedFiles.push({ id: row.id, rev: row.rev, children });
    }
    return { live, deleted, deletedFiles };
  }

  /** Live `leaf` chunk documents, with what they cost in SQLite and R2. */
  private liveChunks(): OrphanChunk[] {
    const hasR2 = this.rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk_body_refs'`).length > 0;
    return this.rows<{ id: string; rev: string; sqlite_bytes: number; r2_bytes: number }>(
      `SELECT d.id, d.winning_rev AS rev,
         LENGTH(CAST(r.body AS BLOB)) + COALESCE(
           (SELECT SUM(LENGTH(CAST(c.body AS BLOB))) FROM rev_body_chunks c WHERE c.id = r.id AND c.rev = r.rev), 0) AS sqlite_bytes,
         ${hasR2
           ? `COALESCE((SELECT o.bytes FROM chunk_body_refs b JOIN chunk_objects o ON o.object_key = b.object_key
                WHERE b.id = r.id AND b.rev = r.rev), 0)`
           : "0"} AS r2_bytes
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       LEFT JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       WHERE d.deleted = 0 AND d.id LIKE 'h:%'
         AND COALESCE(m.type, json_extract(r.body, '$.type')) = 'leaf'`,
    ).map((row) => ({ id: row.id, rev: row.rev, sqliteBytes: Number(row.sqlite_bytes), r2Bytes: Number(row.r2_bytes) }));
  }

  /** What the vault looks like right now, without recording anything. */
  look(): ChunkGcScan {
    const { live, deleted, deletedFiles } = this.references();
    const orphans: OrphanChunk[] = [];
    const held: OrphanChunk[] = [];
    for (const chunk of this.liveChunks()) {
      if (live.has(chunk.id)) continue;
      (deleted.has(chunk.id) ? held : orphans).push(chunk);
    }
    return { orphans, held, deletedFiles };
  }

  /**
   * Records the current orphans and deleted files: new ones start their grace
   * period now, ones that gained a reference, were restored or changed
   * revision are forgotten.
   */
  scan(now = Date.now()): ChunkGcScan {
    const scan = this.look();
    const record = (table: string, rows: Array<{ id: string; rev: string }>) => {
      const current = new Map(rows.map((row) => [row.id, row.rev]));
      // Row by row: Durable Object SQLite has no temporary tables to join against.
      for (const row of this.rows<{ id: string; rev: string }>(`SELECT id, rev FROM ${table}`)) {
        if (current.get(row.id) !== row.rev) this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, row.id);
      }
      for (const row of rows) {
        this.sql.exec(`INSERT OR IGNORE INTO ${table} (id, rev, marked_at) VALUES (?, ?, ?)`, row.id, row.rev, now);
      }
    };
    this.storage.transactionSync(() => {
      record("chunk_gc", scan.orphans);
      record("deleted_file_gc", scan.deletedFiles);
      this.setMeta(SCAN_AT_KEY, String(now));
    });
    return scan;
  }

  private dueRows<T extends { id: string; rev: string }>(table: string, rows: T[], graceMs: number, now: number): T[] {
    const marked = new Map(
      this.rows<{ id: string; rev: string }>(`SELECT id, rev FROM ${table} WHERE marked_at <= ?`, now - graceMs)
        .map((row) => [row.id, row.rev]),
    );
    return rows.filter((row) => marked.get(row.id) === row.rev);
  }

  /** Marked orphans whose grace period has passed (call after `scan`). */
  due(scan: ChunkGcScan, graceMs: number, now = Date.now()): OrphanChunk[] {
    return this.dueRows("chunk_gc", scan.orphans, graceMs, now);
  }

  /** Deleted files whose grace period has passed, and the held chunks that go with them. */
  dueDeletedFiles(scan: ChunkGcScan, graceMs: number, now = Date.now()): { files: DeletedFile[]; chunks: OrphanChunk[] } {
    const files = this.dueRows("deleted_file_gc", scan.deletedFiles, graceMs, now);
    const dueIds = new Set(files.map((file) => file.id));
    // A held chunk goes only once every deleted file holding it is due.
    const holders = new Map<string, string[]>();
    for (const file of scan.deletedFiles) {
      for (const child of file.children) holders.set(child, [...(holders.get(child) ?? []), file.id]);
    }
    const chunks = scan.held.filter((chunk) => (holders.get(chunk.id) ?? []).every((id) => dueIds.has(id)));
    return { files, chunks };
  }

  /** Forget collected rows and remember the outcome. */
  recordCollect(chunks: OrphanChunk[], files: DeletedFile[], now = Date.now()): void {
    this.storage.transactionSync(() => {
      for (const chunk of chunks) this.sql.exec(`DELETE FROM chunk_gc WHERE id = ?`, chunk.id);
      for (const file of files) this.sql.exec(`DELETE FROM deleted_file_gc WHERE id = ?`, file.id);
      this.setMeta(COLLECT_AT_KEY, String(now));
      this.setMeta(LAST_COLLECT_KEY, JSON.stringify({ ...sumChunks(chunks), files: files.length }));
    });
  }

  private markedSummary(table: string, rows: Array<{ id: string; rev: string }>): { count: number; oldestMarkedAt: number | null } {
    const current = new Map(rows.map((row) => [row.id, row.rev]));
    const marked = this.rows<{ id: string; rev: string; marked_at: number }>(`SELECT id, rev, marked_at FROM ${table}`)
      .filter((row) => current.get(row.id) === row.rev);
    return {
      count: marked.length,
      oldestMarkedAt: marked.length ? Math.min(...marked.map((row) => Number(row.marked_at))) : null,
    };
  }

  status(options: Required<Pick<ChunkGcOptions, "graceMs" | "deletedFilesGraceMs">>, scan = this.look(), now = Date.now()): ChunkGcStatus {
    const number = (key: string) => {
      const value = Number(this.meta(key));
      return value > 0 ? value : null;
    };
    const lastCollect = this.meta(LAST_COLLECT_KEY);
    const dueDeleted = this.dueDeletedFiles(scan, options.deletedFilesGraceMs, now);
    return {
      graceMs: options.graceMs,
      deletedFilesGraceMs: options.deletedFilesGraceMs,
      orphans: sumChunks(scan.orphans),
      marked: this.markedSummary("chunk_gc", scan.orphans),
      due: sumChunks(this.due(scan, options.graceMs, now)),
      deletedFiles: {
        count: scan.deletedFiles.length,
        heldChunks: sumChunks(scan.held),
        marked: this.markedSummary("deleted_file_gc", scan.deletedFiles),
        due: { files: dueDeleted.files.length, chunks: sumChunks(dueDeleted.chunks) },
      },
      lastScanAt: number(SCAN_AT_KEY),
      lastCollectAt: number(COLLECT_AT_KEY),
      lastCollect: lastCollect ? JSON.parse(lastCollect) as ChunkGcCollected : null,
    };
  }
}
