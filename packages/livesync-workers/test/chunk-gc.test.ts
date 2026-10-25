import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSyncVaultDO, type VaultBindings, type ChunkGcStatus } from "../src/index.js";
import { testEnv, testBindings, testHost, memoryBucket, TEST_SECRET } from "./helpers.js";
import { INTERNAL_SECRET_HEADER } from "../src/livesync/http.js";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
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
  const bindings: VaultBindings = { ...testBindings(env), chunkBucket: bucket as unknown as R2Bucket, chunkBodyThresholdBytes: 1024 };
  class Vault extends LiveSyncVaultDO<typeof env> {
    protected host() { return testHost(env); }
    protected bindings() { return bindings; }
  }
  const ctx = { storage, id: { name: "tenant:vault" } } as unknown as DurableObjectState;
  const vault = new Vault(ctx, env);
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => vault.fetch(new Request(`https://db${path}`, {
    method, headers: { "Content-Type": "application/json", [INTERNAL_SECRET_HEADER]: TEST_SECRET },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  type GcResponse = { collected: { count: number; sqliteBytes: number; r2Bytes: number; files: number } | null; remaining: number; status: ChunkGcStatus };
  return {
    database, objects, request, bindings, alarmAt: () => alarm,
    put: (docs: unknown[]) => request("/_bulk_docs", { docs, new_edits: false }),
    status: async () => (await request("/internal/chunk-gc")).json() as Promise<ChunkGcStatus>,
    gc: async (body: Record<string, unknown>) => (await request("/internal/chunk-gc", body)).json() as Promise<GcResponse>,
    async tick() { alarm = null; await vault.alarm(); },
    async create() { await request("/", undefined, "PUT"); },
  };
}

const leaf = (id: string, data: string) => ({ _id: id, _rev: "1-a", type: "leaf", data });
const note = (path: string, children: string[], extra: Record<string, unknown> = {}) =>
  ({ _id: path, _rev: "1-n", path, type: "plain", children, ...extra });
const large = "あ".repeat(400);

afterEach(() => vi.useRealTimers());

describe("chunk garbage collection", () => {
  it("reports orphans, waits out the grace period, then deletes them and frees their R2 bodies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-25T00:00:00Z").getTime();
    vi.setSystemTime(start);
    const t = setup(); await t.create();
    await t.put([
      leaf("h:a", "aaa"), leaf("h:b", large), leaf("h:c", "ccc"), leaf("h:d", large), leaf("h:e", "eee"),
      note("one.md", ["h:a", "h:b"]),
      note("held.md", ["h:e"], { deleted: true }),
    ]);
    expect(t.objects.size).toBe(2);
    const bytesOf = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc)).length;

    const initial = await t.status();
    expect(initial.orphans).toEqual({ count: 2, sqliteBytes: bytesOf(leaf("h:c", "ccc")) + bytesOf({ type: "leaf" }), r2Bytes: bytesOf(leaf("h:d", large)) });
    expect(initial.marked).toEqual({ count: 0, oldestMarkedAt: null });
    expect(initial.due.count).toBe(0);
    expect(initial.lastScanAt).toBeNull();

    const scanned = await t.gc({ action: "scan" });
    expect(scanned.status.marked).toEqual({ count: 2, oldestMarkedAt: start });
    expect(scanned.status.lastScanAt).toBe(start);

    // Still inside the grace period: nothing goes.
    const early = await t.gc({ action: "collect" });
    expect(early.collected).toEqual({ count: 0, sqliteBytes: 0, r2Bytes: 0, files: 0 });
    expect((await t.request("/h:c")).status).toBe(200);

    // A chunk that becomes referenced during the grace period is unmarked.
    vi.setSystemTime(start + DAY);
    await t.put([note("two.md", ["h:c"])]);
    // A chunk first seen late starts its own grace period.
    vi.setSystemTime(start + 7.5 * DAY);
    await t.put([leaf("h:late", "late")]);
    expect((await t.gc({ action: "scan" })).status.marked.count).toBe(2);

    vi.setSystemTime(start + 8 * DAY);
    const collected = await t.gc({ action: "collect" });
    expect(collected.collected).toEqual({ count: 1, sqliteBytes: bytesOf({ type: "leaf" }), r2Bytes: bytesOf(leaf("h:d", large)), files: 0 });
    expect(collected.remaining).toBe(0);
    expect(collected.status.orphans.count).toBe(1);
    expect(collected.status.lastCollect).toEqual(collected.collected);
    expect((await t.request("/h:d")).status).toBe(404);
    expect((await t.request("/h:c")).status).toBe(200);
    expect((await t.request("/h:e")).status).toBe(200);
    const changes = await (await t.request("/_changes")).json() as { results: Array<{ id: string; deleted?: boolean }> };
    expect(changes.results.filter(c => c.deleted).map(c => c.id)).toEqual(["h:d"]);
    expect(await (await t.request("/internal/op", { op: "readNote", path: "one.md" })).json()).toEqual({ content: "aaa" + large });

    // Compaction unreferenced the object; maintenance deletes it.
    await t.tick();
    expect(t.objects.size).toBe(1);
    expect((await t.status()).marked.count).toBe(1);

    vi.setSystemTime(start + 15 * DAY);
    expect((await t.gc({ action: "collect" })).collected?.count).toBe(1);
    expect((await t.request("/h:late")).status).toBe(404);

    // The deleted file is still restorable, and still holds h:e, until its own grace period ends.
    const held = (await t.status()).deletedFiles;
    expect(held).toMatchObject({ count: 1, heldChunks: { count: 1 }, marked: { count: 1, oldestMarkedAt: start }, due: { files: 0 } });
    expect((await t.request("/held.md")).status).toBe(200);
    vi.setSystemTime(start + 31 * DAY);
    const purged = await t.gc({ action: "collect" });
    expect(purged.collected).toEqual({ count: 1, sqliteBytes: bytesOf(leaf("h:e", "eee")), r2Bytes: 0, files: 1 });
    expect((await t.request("/held.md")).status).toBe(404);
    expect((await t.request("/h:e")).status).toBe(404);
    expect((await t.status()).deletedFiles).toMatchObject({ count: 0, heldChunks: { count: 0 } });
    expect(t.database.prepare("SELECT COUNT(*) AS n FROM deleted_file_gc").get()).toEqual({ n: 0 });
  });

  it("keeps a chunk while any deleted file holding it is still inside the grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const t = setup(); await t.create();
    await t.put([leaf("h:shared", "s"), note("old.md", ["h:shared"], { deleted: true })]);
    await t.gc({ action: "scan" });
    vi.setSystemTime(start + 20 * DAY);
    await t.put([note("recent.md", ["h:shared"], { deleted: true })]);
    await t.gc({ action: "scan" });
    vi.setSystemTime(start + 31 * DAY);
    const first = await t.gc({ action: "collect" });
    expect(first.collected).toMatchObject({ files: 1, count: 0 });
    expect((await t.request("/old.md")).status).toBe(404);
    expect((await t.request("/h:shared")).status).toBe(200);
    vi.setSystemTime(start + 51 * DAY);
    expect((await t.gc({ action: "collect" })).collected).toMatchObject({ files: 1, count: 1 });
    expect((await t.request("/h:shared")).status).toBe(404);
  });

  it("runs from the alarm on the host's interval when the binding turns it on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const t = setup(); await t.create();
    t.bindings.chunkGc = { every: DAY };
    // Indexing and full-text passes share the alarm and re-arm it for sooner;
    // fire every alarm before `until` (moving the clock to it) so only the GC's own is left.
    const settle = async (until: number) => {
      do {
        vi.setSystemTime(Math.max(Date.now(), t.alarmAt() ?? 0));
        await t.tick();
      } while (t.alarmAt() !== null && t.alarmAt()! <= until);
    };
    await t.put([leaf("h:x", "x"), leaf("h:y", "y")]);
    await settle(start + DAY - 1);
    const first = await t.status();
    expect(first.marked.count).toBe(2);
    // The interval counts from the run that recorded them (the put's own indexing alarm ran first).
    expect(t.alarmAt()).toBe(first.lastScanAt! + DAY);
    // Not due yet: nothing collected, the alarm stays on the interval.
    expect((await t.request("/h:y")).status).toBe(200);
    vi.setSystemTime(start + 8 * DAY);
    await settle(start + 9 * DAY - 1);
    expect((await t.request("/h:y")).status).toBe(404);
    const second = await t.status();
    expect(second.lastCollect).toMatchObject({ count: 2, files: 0 });
    expect(t.alarmAt()).toBe(second.lastCollectAt! + DAY);
  });

  it("collects in bounded batches and refuses unknown actions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const t = setup(); await t.create();
    await t.put(Array.from({ length: 5 }, (_, i) => leaf(`h:${i}`, `${i}`)));
    await t.gc({ action: "scan" });
    vi.setSystemTime(start + 8 * DAY);
    const first = await t.gc({ action: "collect", limit: 2 });
    expect(first.collected?.count).toBe(2);
    expect(first.remaining).toBe(3);
    const second = await t.gc({ action: "collect", limit: 10 });
    expect(second.collected?.count).toBe(3);
    expect(second.status.orphans.count).toBe(0);
    expect((await t.request("/internal/chunk-gc", { action: "purge" })).status).toBe(400);
    expect((await t.gc({ action: "collect", graceMs: 0 })).collected?.count).toBe(0);
  });
});
