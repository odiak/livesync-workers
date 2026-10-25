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
 * reference in between is unmarked by the next scan. Chunks held by logically
 * deleted files (LiveSync keeps those restorable) count as referenced.
 */

export const DEFAULT_CHUNK_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_AT_KEY = "chunk_gc_scan_at";
const COLLECT_AT_KEY = "chunk_gc_collect_at";
const LAST_COLLECT_KEY = "chunk_gc_last_collect";

export type ChunkGcBytes = { count: number; sqliteBytes: number; r2Bytes: number };

export type ChunkGcStatus = {
  graceMs: number;
  /** Live chunk documents nothing references right now. */
  orphans: ChunkGcBytes;
  /** Orphans a scan has already recorded, with when the oldest was first seen. */
  marked: { count: number; oldestMarkedAt: number | null };
  /** Marked orphans past the grace period: what the next collect deletes. */
  due: ChunkGcBytes;
  lastScanAt: number | null;
  lastCollectAt: number | null;
  lastCollect: ChunkGcBytes | null;
};

export type OrphanChunk = { id: string; rev: string; sqliteBytes: number; r2Bytes: number };

type Sql = Pick<SqlStorage, "exec">;

function sum(rows: Iterable<OrphanChunk>): ChunkGcBytes {
  const total = { count: 0, sqliteBytes: 0, r2Bytes: 0 };
  for (const row of rows) {
    total.count += 1;
    total.sqliteBytes += row.sqliteBytes;
    total.r2Bytes += row.r2Bytes;
  }
  return total;
}

export class ChunkGarbageCollector {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS chunk_gc (
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

  /** Chunk ids some current (leaf, non-tombstone) revision of a non-chunk document points at. */
  private referencedChunkIds(): Set<string> {
    const live = `r.deleted = 0
      AND NOT EXISTS (SELECT 1 FROM revs child WHERE child.id = r.id AND child.parent_rev = r.rev)
      AND r.id NOT LIKE 'h:%'`;
    const ids = new Set<string>();
    for (const row of this.rows<{ value: string }>(
      `SELECT DISTINCT j.value FROM revs r, json_each(r.body, '$.children') j
       WHERE ${live} AND r.body_chunked = 0 AND json_type(r.body, '$.children') = 'array' AND j.type = 'text'`,
    )) ids.add(row.value);
    // Bodies stored in pieces (very long child lists) are read back whole.
    for (const row of this.rows<{ id: string; rev: string }>(`SELECT r.id, r.rev FROM revs r WHERE ${live} AND r.body_chunked = 1`)) {
      const body = this.rows<{ body: string }>(
        `SELECT body FROM rev_body_chunks WHERE id = ? AND rev = ? ORDER BY chunk_index`, row.id, row.rev,
      ).map((piece) => piece.body).join("");
      try {
        const children = (JSON.parse(body) as { children?: unknown }).children;
        if (Array.isArray(children)) for (const id of children) if (typeof id === "string") ids.add(id);
      } catch {
        // Not JSON: nothing to reference.
      }
    }
    return ids;
  }

  /** Live `leaf` chunk documents no current revision of any file points at. */
  orphans(): OrphanChunk[] {
    const referenced = this.referencedChunkIds();
    const hasR2 = this.rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk_body_refs'`).length > 0;
    const candidates = this.rows<{ id: string; rev: string; sqlite_bytes: number; r2_bytes: number }>(
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
    );
    return candidates
      .filter((row) => !referenced.has(row.id))
      .map((row) => ({ id: row.id, rev: row.rev, sqliteBytes: Number(row.sqlite_bytes), r2Bytes: Number(row.r2_bytes) }));
  }

  /**
   * Records the current orphans: new ones start their grace period now, ones
   * that gained a reference or changed revision are forgotten.
   */
  scan(now = Date.now()): OrphanChunk[] {
    const orphans = this.orphans();
    this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TEMP TABLE IF NOT EXISTS chunk_gc_current (id TEXT PRIMARY KEY, rev TEXT NOT NULL)`);
      this.sql.exec(`DELETE FROM chunk_gc_current`);
      for (const orphan of orphans) this.sql.exec(`INSERT INTO chunk_gc_current (id, rev) VALUES (?, ?)`, orphan.id, orphan.rev);
      this.sql.exec(`DELETE FROM chunk_gc WHERE NOT EXISTS (
        SELECT 1 FROM chunk_gc_current c WHERE c.id = chunk_gc.id AND c.rev = chunk_gc.rev)`);
      this.sql.exec(`INSERT OR IGNORE INTO chunk_gc (id, rev, marked_at)
        SELECT id, rev, ? FROM chunk_gc_current`, now);
      this.sql.exec(`DELETE FROM chunk_gc_current`);
      this.setMeta(SCAN_AT_KEY, String(now));
    });
    return orphans;
  }

  /** Marked orphans whose grace period has passed (call after `scan`). */
  due(orphans: OrphanChunk[], graceMs: number, now = Date.now()): OrphanChunk[] {
    const marked = new Map(
      this.rows<{ id: string; rev: string }>(`SELECT id, rev FROM chunk_gc WHERE marked_at <= ?`, now - graceMs)
        .map((row) => [row.id, row.rev]),
    );
    return orphans.filter((orphan) => marked.get(orphan.id) === orphan.rev);
  }

  /** Forget collected chunks and remember the outcome. */
  recordCollect(collected: OrphanChunk[], now = Date.now()): void {
    this.storage.transactionSync(() => {
      for (const chunk of collected) this.sql.exec(`DELETE FROM chunk_gc WHERE id = ?`, chunk.id);
      this.setMeta(COLLECT_AT_KEY, String(now));
      this.setMeta(LAST_COLLECT_KEY, JSON.stringify(sum(collected)));
    });
  }

  status(graceMs: number, orphans = this.orphans(), now = Date.now()): ChunkGcStatus {
    const current = new Map(orphans.map((orphan) => [orphan.id, orphan.rev]));
    const marked = this.rows<{ id: string; rev: string; marked_at: number }>(`SELECT id, rev, marked_at FROM chunk_gc`)
      .filter((row) => current.get(row.id) === row.rev);
    const number = (key: string) => {
      const value = Number(this.meta(key));
      return value > 0 ? value : null;
    };
    const lastCollect = this.meta(LAST_COLLECT_KEY);
    return {
      graceMs,
      orphans: sum(orphans),
      marked: {
        count: marked.length,
        oldestMarkedAt: marked.length ? Math.min(...marked.map((row) => Number(row.marked_at))) : null,
      },
      due: sum(this.due(orphans, graceMs, now)),
      lastScanAt: number(SCAN_AT_KEY),
      lastCollectAt: number(COLLECT_AT_KEY),
      lastCollect: lastCollect ? JSON.parse(lastCollect) as ChunkGcBytes : null,
    };
  }
}
