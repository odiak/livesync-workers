import { hashText } from "../search/chunk-md.js";
import type { VaultBindings, VaultRef } from "../types.js";

export const DEFAULT_CHUNK_BODY_THRESHOLD_BYTES = 64 * 1024;
const BATCH_SIZE = 8;
const BATCH_BYTES = 8 * 1024 * 1024;
const MIGRATION_KEY = "chunk_body_migration";
const encoder = new TextEncoder();

export type ChunkMigrationProgress = {
  state: "idle" | "running" | "completed" | "failed";
  migrated: number;
  migratedBytes: number;
  startedAt: number | null;
  updatedAt: number | null;
  error: string | null;
};

export type ChunkStorageStatus = {
  configured: boolean;
  thresholdBytes: number;
  sqliteBytes: number;
  r2Bytes: number;
  externalRevisions: number;
  pendingCleanup: number;
  remaining: { count: number; bytes: number };
  distribution: Array<{ minimumBytes: number; count: number; bytes: number }>;
  migration: ChunkMigrationProgress;
};

type Candidate = { id: string; rev: string; body: string; body_chunked: number; bytes: number };

/** Private R2 objects are scoped to a vault. Only the body moves; revision and
 * replication metadata remain in SQLite. The owner serializes operations so
 * compaction/purge cannot delete a body while a read or upload is in flight. */
export class ChunkBodyStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bindings: () => VaultBindings,
    private readonly ref: () => VaultRef | null,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS chunk_objects (
      object_key TEXT PRIMARY KEY, bytes INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS chunk_body_refs (
      id TEXT NOT NULL, rev TEXT NOT NULL, object_key TEXT NOT NULL,
      PRIMARY KEY (id, rev)
    )`);
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_body_refs_key ON chunk_body_refs(object_key)`);
  }

  private rows<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.storage.sql.exec(sql, ...args).toArray() as T[];
  }

  private bucket(): R2Bucket {
    const bucket = this.bindings().chunkBucket;
    if (!bucket) throw new Error("Chunk R2 binding is required to read or delete stored bodies");
    return bucket;
  }

  private threshold(): number {
    const value = this.bindings().chunkBodyThresholdBytes ?? DEFAULT_CHUNK_BODY_THRESHOLD_BYTES;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid chunk body threshold");
    return value;
  }

  private prefix(): string {
    const ref = this.ref();
    if (!ref) throw new Error("Vault identity is required for chunk R2 storage");
    return `chunks/${encodeURIComponent(ref.tenantId)}/${encodeURIComponent(ref.databaseName)}/`;
  }

  storedBytes(): number {
    return this.rows<{ bytes: number }>(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM chunk_objects`)[0]!.bytes;
  }

  private progress(): ChunkMigrationProgress {
    const row = this.rows<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, MIGRATION_KEY)[0];
    return row ? JSON.parse(row.value) as ChunkMigrationProgress : {
      state: "idle", migrated: 0, migratedBytes: 0, startedAt: null, updatedAt: null, error: null,
    };
  }

  private saveProgress(value: ChunkMigrationProgress): void {
    this.storage.sql.exec(`INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, MIGRATION_KEY, JSON.stringify(value));
  }

  // Includes historical bodies still available, even for deleted files. This
  // migration does not decide which chunks are no longer needed by LiveSync.
  private candidatesSql(): string {
    return `SELECT r.id, r.rev, r.body, r.body_chunked,
      CASE WHEN r.body_chunked = 1 THEN
        (SELECT COALESCE(SUM(length(CAST(c.body AS BLOB))), 0) FROM rev_body_chunks c WHERE c.id = r.id AND c.rev = r.rev)
        ELSE length(CAST(r.body AS BLOB)) END AS bytes
      FROM revs r LEFT JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev
      WHERE COALESCE(m.type, json_extract(r.body, '$.type')) = 'leaf' AND r.body_available = 1 AND r.deleted = 0
        AND NOT EXISTS (SELECT 1 FROM chunk_body_refs b WHERE b.id = r.id AND b.rev = r.rev)`;
  }

  status(): ChunkStorageStatus {
    const distribution = [0, 16 * 1024, 64 * 1024, 256 * 1024].map((minimumBytes) => ({
      minimumBytes,
      ...this.rows<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
        FROM (${this.candidatesSql()}) WHERE bytes >= ?`, minimumBytes)[0]!,
    }));
    return {
      configured: !!this.bindings().chunkBucket,
      thresholdBytes: this.threshold(),
      sqliteBytes: this.storage.sql.databaseSize,
      r2Bytes: this.storedBytes(),
      externalRevisions: this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_body_refs`)[0]!.n,
      pendingCleanup: this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_objects o
        WHERE NOT EXISTS (SELECT 1 FROM chunk_body_refs b WHERE b.object_key = o.object_key)`)[0]!.n,
      remaining: this.rows<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
        FROM (${this.candidatesSql()}) WHERE bytes >= ?`, this.threshold())[0]!,
      distribution,
      migration: this.progress(),
    };
  }

  startMigration(): ChunkStorageStatus {
    this.bucket();
    const previous = this.progress();
    if (previous.state !== "running") {
      const resume = previous.state === "failed";
      this.saveProgress({
        state: "running", migrated: resume ? previous.migrated : 0,
        migratedBytes: resume ? previous.migratedBytes : 0,
        startedAt: resume ? previous.startedAt : Date.now(), updatedAt: Date.now(), error: null,
      });
    }
    return this.status();
  }

  async prepare(id: string, rev: string, body: string, type: string | null, deleted: number): Promise<string | null> {
    if (!this.bindings().chunkBucket || type !== "leaf" || deleted || encoder.encode(body).byteLength < this.threshold()) return null;
    return this.upload(id, rev, body);
  }

  private async upload(id: string, rev: string, body: string): Promise<string> {
    const digest = await hashText(body);
    const key = `${this.prefix()}${await hashText(`${id}\0${rev}`)}/${digest}`;
    // Track before PUT. An interrupted/failed upload can be retried with the
    // same key, or reclaimed by maintenance without scanning the bucket.
    this.storage.sql.exec(`INSERT OR IGNORE INTO chunk_objects(object_key, bytes) VALUES (?, ?)`, key, encoder.encode(body).byteLength);
    const result = await this.bucket().put(key, body, { sha256: digest });
    if (!result) throw new Error("Chunk R2 write did not complete");
    return key;
  }

  reference(id: string, rev: string, key: string): void {
    this.storage.sql.exec(`INSERT INTO chunk_body_refs(id, rev, object_key) VALUES (?, ?, ?)`, id, rev, key);
  }

  async read(id: string, rev: string): Promise<string | null> {
    const row = this.rows<{ object_key: string }>(`SELECT object_key FROM chunk_body_refs WHERE id = ? AND rev = ?`, id, rev)[0];
    if (!row) return null;
    const object = await this.bucket().get(row.object_key);
    if (!object) throw new Error("Stored chunk body is missing from R2");
    return object.text();
  }

  compact(): void {
    this.storage.sql.exec(`DELETE FROM chunk_body_refs WHERE EXISTS (
      SELECT 1 FROM revs child WHERE child.id = chunk_body_refs.id AND child.parent_rev = chunk_body_refs.rev
    )`);
  }

  needsMaintenance(): boolean {
    return this.progress().state === "running" || this.rows(`SELECT 1 FROM chunk_objects o
      WHERE NOT EXISTS (SELECT 1 FROM chunk_body_refs b WHERE b.object_key = o.object_key) LIMIT 1`).length > 0;
  }

  async runMaintenance(): Promise<void> {
    // Keep failed migrations stopped until an administrator resumes them.
    if (this.progress().state === "running") {
      try {
        const candidates = this.rows<Candidate>(`SELECT * FROM (${this.candidatesSql()}) WHERE bytes >= ? ORDER BY id, rev LIMIT ?`, this.threshold(), BATCH_SIZE);
        let bytes = 0;
        for (const row of candidates) {
          if (bytes >= BATCH_BYTES) break;
          const body = row.body_chunked
            ? this.rows<{ body: string }>(`SELECT body FROM rev_body_chunks WHERE id = ? AND rev = ? ORDER BY chunk_index`, row.id, row.rev).map((c) => c.body).join("")
            : row.body;
          const key = await this.upload(row.id, row.rev, body);
          const saved = await this.bucket().get(key);
          if (!saved || await saved.text() !== body) throw new Error("Chunk R2 verification failed");
          this.storage.transactionSync(() => {
            this.reference(row.id, row.rev, key);
            this.storage.sql.exec(`UPDATE revs SET body = '{"type":"leaf"}', body_chunked = 0 WHERE id = ? AND rev = ?`, row.id, row.rev);
            this.storage.sql.exec(`DELETE FROM rev_body_chunks WHERE id = ? AND rev = ?`, row.id, row.rev);
            const progress = this.progress();
            this.saveProgress({ ...progress, migrated: progress.migrated + 1, migratedBytes: progress.migratedBytes + row.bytes, updatedAt: Date.now() });
          });
          bytes += row.bytes;
        }
        if (!this.rows(`SELECT 1 FROM (${this.candidatesSql()}) WHERE bytes >= ? LIMIT 1`, this.threshold()).length) {
          this.saveProgress({ ...this.progress(), state: "completed", updatedAt: Date.now() });
        }
      } catch (error) {
        console.warn("Chunk R2 migration failed", error);
        this.saveProgress({ ...this.progress(), state: "failed", updatedAt: Date.now(), error: "R2 migration failed. Stored SQLite bodies were retained for retry." });
      }
    }
    const unused = this.rows<{ object_key: string }>(`SELECT object_key FROM chunk_objects o
      WHERE NOT EXISTS (SELECT 1 FROM chunk_body_refs b WHERE b.object_key = o.object_key) LIMIT ?`, BATCH_SIZE);
    if (unused.length) {
      await this.bucket().delete(unused.map((row) => row.object_key));
      this.storage.transactionSync(() => {
        for (const row of unused) this.storage.sql.exec(`DELETE FROM chunk_objects WHERE object_key = ?`, row.object_key);
      });
    }
  }

  async purge(): Promise<void> {
    if (!this.bindings().chunkBucket && this.storedBytes() === 0) return;
    // Include orphan uploads whose SQLite transaction did not survive a reset.
    let cursor: string | undefined;
    do {
      const page = await this.bucket().list({ prefix: this.prefix(), cursor, limit: 1000 });
      if (page.objects.length) await this.bucket().delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM chunk_body_refs`);
      this.storage.sql.exec(`DELETE FROM chunk_objects`);
    });
  }
}
