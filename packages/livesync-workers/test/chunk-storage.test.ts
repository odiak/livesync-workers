import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { LiveSyncVaultDO, type VaultBindings, type ChunkStorageStatus } from "../src/index.js";
import { testEnv, testBindings, testHost, memoryBucket, TEST_SECRET } from "./helpers.js";
import { INTERNAL_SECRET_HEADER } from "../src/livesync/http.js";

function setup(enabled = true, retentionMs = 0) {
  const database = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const storage = {
    sql: {
      get databaseSize() { return 4096; },
      exec(query: string, ...args: unknown[]) {
        const rows = database.prepare(query).all(...args as never[]);
        return { toArray: () => rows, one: () => { if (rows.length !== 1) throw Error("Expected one row"); return rows[0]; } };
      },
    },
    transactionSync<T>(fn: () => T): T {
      database.exec("BEGIN");
      try { const value = fn(); database.exec("COMMIT"); return value; }
      catch (e) { database.exec("ROLLBACK"); throw e; }
    },
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { alarm = at; },
  };
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, body: string) => { objects.set(key, body); return { key }; }),
    get: vi.fn(async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null),
    delete: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false })),
  };
  const env = testEnv({ FTS_BUCKET: memoryBucket().bucket, semanticSearch: false });
  const bindings: VaultBindings = { ...testBindings(env), chunkBucket: enabled ? bucket as unknown as R2Bucket : undefined, chunkBodyThresholdBytes: 1024, chunkObjectRetentionMs: retentionMs };
  class Vault extends LiveSyncVaultDO<typeof env> {
    protected host() { return testHost(env); }
    protected bindings() { return bindings; }
  }
  const ctx = { storage, id: { name: "tenant:vault" } } as unknown as DurableObjectState;
  let vault = new Vault(ctx, env);
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => vault.fetch(new Request(`https://db${path}`, {
    method, headers: { "Content-Type": "application/json", [INTERNAL_SECRET_HEADER]: TEST_SECRET },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const put = (docs: unknown[]) => request("/_bulk_docs", { docs, new_edits: false });
  const status = async () => (await request("/internal/chunk-storage")).json() as Promise<ChunkStorageStatus>;
  return { database, bindings, bucket, objects, request, put, status, raw: (request: Request) => vault.fetch(request),
    restart() { vault = new Vault(ctx, env); },
    async tick() { alarm = null; await vault.alarm(); },
    async create() { await request("/", undefined, "PUT"); },
  };
}

const leaf = (id = "h:large", data = "あ".repeat(400)) => ({ _id: id, _rev: "1-a", type: "leaf", data });

describe("R2 chunk body storage", () => {
  it("automatically stores large UTF-8 bodies, keeps small chunks inline, and preserves every replication read", async () => {
    const t = setup(); await t.create();
    const doc = leaf();
    await t.put([doc, leaf("h:small", "small")]);
    expect(t.objects.size).toBe(1);
    expect(t.database.prepare("SELECT body FROM revs WHERE id = 'h:large'").get()).toEqual({ body: '{"type":"leaf"}' });
    expect(await (await t.request("/h:large")).json()).toEqual(doc);
    expect(await (await t.request("/_all_docs", { keys: [doc._id], include_docs: true })).json()).toMatchObject({ rows: [{ doc }] });
    expect(await (await t.request("/_bulk_get", { docs: [{ id: doc._id, rev: doc._rev }], revs: true })).json()).toMatchObject({ results: [{ docs: [{ ok: { ...doc, _revisions: { start: 1, ids: ["a"] } } }] }] });
    expect(await (await t.request('/h:large?open_revs=all')).json()).toEqual([{ ok: doc }]);
    expect(await (await t.request("/_changes?include_docs=true")).json()).toMatchObject({ results: [ { doc }, { doc: leaf("h:small", "small") } ] });
    expect(await (await t.request("/_find", { selector: { data: doc.data } })).json()).toMatchObject({ docs: [doc] });
    t.restart();
    expect(await (await t.request("/h:large")).json()).toEqual(doc);
    t.bucket.get.mockClear();
    const filtered = await (await t.request("/_changes", { selector: { type: { $ne: "leaf" } } })).json();
    expect(filtered).toMatchObject({ results: [] });
    expect(t.bucket.get).not.toHaveBeenCalled();
    const s = await t.status();
    expect(s.r2Bytes).toBe(new TextEncoder().encode(JSON.stringify(doc)).length);
  });

  it("migrates retained bodies in batches without changing revisions or sequences, and resumes after eviction", async () => {
    const t = setup(false); await t.create();
    const docs = Array.from({ length: 10 }, (_, i) => leaf(`h:${i}`));
    await t.put(docs);
    const before = await (await t.request("/_changes?include_docs=true")).json();
    t.bindings.chunkBucket = t.bucket as unknown as R2Bucket;
    const preview = await t.status();
    expect(preview.remaining.count).toBe(10);
    expect(preview.distribution[0]!.count).toBe(10);
    expect((await t.request("/internal/chunk-storage", {})).status).toBe(202);
    await t.tick();
    expect((await t.status()).migration).toMatchObject({ state: "running", migrated: 8 });
    t.restart(); await t.tick();
    expect((await t.status()).migration).toMatchObject({ state: "completed", migrated: 10 });
    expect((await t.status()).remaining.count).toBe(0);
    expect(await (await t.request("/_changes?include_docs=true")).json()).toEqual(before);
    await t.request("/internal/chunk-storage", {}); await t.tick();
    expect(t.objects.size).toBe(10);
  });

  it("retains SQLite data when verification fails and lets the administrator retry", async () => {
    const t = setup(false); await t.create(); await t.put([leaf()]);
    t.bindings.chunkBucket = t.bucket as unknown as R2Bucket;
    t.bucket.get.mockResolvedValueOnce({ text: async () => "wrong" });
    await t.request("/internal/chunk-storage", {}); await t.tick();
    expect((await t.status()).migration.state).toBe("failed");
    expect((await t.status()).remaining.count).toBe(1);
    expect(await (await t.request("/h:large")).json()).toEqual(leaf());
    await t.request("/internal/chunk-storage", {}); await t.tick();
    expect((await t.status()).migration).toMatchObject({ state: "completed", migrated: 1 });
  });

  it("rejects a failed new PUT without committing a revision and treats missing R2 bodies as errors", async () => {
    const t = setup(); await t.create();
    t.bucket.put.mockRejectedValueOnce(Error("R2 unavailable"));
    expect((await t.put([leaf()])).status).toBe(500);
    expect(t.database.prepare("SELECT COUNT(*) AS n FROM revs").get()).toEqual({ n: 0 });
    await t.put([leaf()]);
    t.objects.clear();
    expect((await t.request("/h:large")).status).toBe(500);
    expect((await t.request("/_all_docs", { keys: ["h:large"], include_docs: true })).status).toBe(500);
  });

  it("reconstructs shared note chunks for reads, indexing, and optimistic note writes", async () => {
    const t = setup(); await t.create();
    const data = "searchable text ".repeat(100);
    const note = (path: string) => ({ _id: path, _rev: "1-note", path, type: "plain", children: ["h:large"] });
    await t.put([leaf("h:large", data), note("one.md"), note("two.md")]);
    expect(await (await t.request("/internal/op", { op: "readNote", path: "one.md" })).json()).toEqual({ content: data });
    await t.tick();
    const info = await (await t.request("/internal/op", { op: "indexStatus" })).json() as { indexed: number };
    expect(info.indexed).toBe(2);
    await t.request("/one.md?rev=1-note", undefined, "DELETE");
    expect(await (await t.request("/internal/op", { op: "readNote", path: "two.md" })).json()).toEqual({ content: data });
    expect(t.objects.size).toBe(1);
    expect((await t.request("/internal/op", { op: "writeNote", path: "two.md", content: data + "new" })).status).toBe(200);
  });

  it("compaction reclaims only superseded revision bodies and purge removes the vault's objects", async () => {
    const t = setup(); await t.create(); await t.put([leaf()]);
    await t.put([{ ...leaf(), _rev: "2-b", data: "b".repeat(1200), _revisions: { start: 2, ids: ["b", "a"] } }]);
    expect(t.objects.size).toBe(2);
    await t.request("/_compact", {}); await t.tick();
    expect(t.objects.size).toBe(1);
    expect((await t.request("/h:large?rev=1-a")).status).toBe(404);
    t.objects.set("chunks/another/vault/untouched", "keep");
    await t.request("/internal/purge", {});
    expect([...t.objects.keys()]).toEqual(["chunks/another/vault/untouched"]);
    expect((await t.status()).r2Bytes).toBe(0);
  });

  it("keeps unreferenced bodies for the retention period so point-in-time recovery stays whole", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const DAY = 86_400_000;
      const t = setup(true, 30 * DAY); await t.create(); await t.put([leaf()]);
      await t.put([{ ...leaf(), _rev: "2-b", data: "b".repeat(1200), _revisions: { start: 2, ids: ["b", "a"] } }]);
      await t.request("/_compact", {}); await t.tick();
      // Still there, now on the clock.
      expect(t.objects.size).toBe(2);
      expect(await t.status()).toMatchObject({ pendingCleanup: 1, retentionMs: 30 * DAY });
      expect((await t.status()).pendingCleanupBytes).toBeGreaterThan(0);
      expect(t.database.prepare("SELECT COUNT(*) AS n FROM chunk_objects WHERE unreferenced_at = ?").get(start)).toEqual({ n: 1 });
      await t.tick();
      expect(t.objects.size).toBe(2);
      vi.setSystemTime(start + 29 * DAY);
      await t.tick();
      expect(t.objects.size).toBe(2);
      vi.setSystemTime(start + 31 * DAY);
      await t.tick();
      expect(t.objects.size).toBe(1);
      expect((await t.status()).pendingCleanup).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes simultaneous writes over R2 awaits so sequence numbers remain unique", async () => {
    const t = setup(); await t.create();
    const responses = await Promise.all([t.put([leaf("h:1")]), t.put([leaf("h:2")])]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(t.database.prepare("SELECT seq FROM changes ORDER BY seq").all()).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it("does not expose migration to unauthenticated internal calls", async () => {
    const t = setup(); await t.create();
    const denied = await t.raw(new Request("https://db/internal/chunk-storage", { method: "POST" }));
    expect(denied.status).toBe(403);
    expect((await t.status()).migration.state).toBe("idle");
  });
});
