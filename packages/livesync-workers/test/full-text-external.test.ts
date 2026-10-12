import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createVault,
  handleLiveSyncRequest,
  hashText,
  type FullTextIndex,
  type FullTextIndexWriter,
  type FullTextNote,
  type VaultBindings,
  type VaultPolicy,
} from "../src/index.js";
import { TEST_SECRET, TestVaultDO, testBindings, testEnv, testHost, type TestEnv } from "./helpers.js";

type SqliteRow = Record<string, string | number | null>;

/** An in-memory stand-in for a search database. */
function memoryFullText() {
  const notes = new Map<string, FullTextNote>();
  const writer: FullTextIndexWriter = {
    upsert: vi.fn(async (note: FullTextNote) => {
      notes.set(note.path, note);
    }),
    delete: vi.fn(async (path: string) => {
      notes.delete(path);
    }),
    close: vi.fn(async () => undefined),
  };
  const index = {
    openWriter: vi.fn(async () => writer),
    search: vi.fn(async (): ReturnType<FullTextIndex["search"]> => ({ hits: [], builtAt: 0, docCount: notes.size })),
    deleteVault: vi.fn(async () => notes.clear()),
  } satisfies FullTextIndex;
  return { index, writer, notes };
}

type FullTextEnv = TestEnv & { fullText?: FullTextIndex };

class FullTextVaultDO extends TestVaultDO {
  protected bindings(): VaultBindings {
    const fullText = (this.env as FullTextEnv).fullText;
    return { ...super.bindings(), ...(fullText ? { fullText } : {}) };
  }
}

async function vaultWith(options: { fullText?: FullTextIndex; policy?: Partial<VaultPolicy> } = {}) {
  const database = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec<T extends SqliteRow>(query: string, ...bindings: unknown[]) {
        const rows = database.prepare(query).all(...(bindings as never[])) as T[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
            return rows[0]!;
          },
        };
      },
    },
    transactionSync<T>(callback: () => T): T {
      database.exec("BEGIN");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async (_at: number) => undefined),
  };
  const env: FullTextEnv = testEnv();
  env.policy = { reservedPaths: [".kuro"], excludedFolders: [], timeZone: "UTC", ...options.policy };
  if (options.fullText) env.fullText = options.fullText;
  const durableObject = new FullTextVaultDO(
    { storage, id: { name: "user-1:vault" } } as unknown as DurableObjectState,
    env,
  );
  await durableObject.fetch(new Request("https://db/", { method: "PUT" }));
  return { durableObject, storage, env, database };
}

function internalOp(durableObject: TestVaultDO, body: Record<string, unknown>) {
  return durableObject.fetch(
    new Request("https://db/internal/op", {
      method: "POST",
      headers: { "content-type": "application/json", "X-LiveSync-Internal": "test-secret" },
      body: JSON.stringify(body),
    }),
  );
}

function replicate(durableObject: TestVaultDO, docs: unknown[]) {
  return durableObject.fetch(
    new Request("https://db/_bulk_docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs, new_edits: false }),
    }),
  );
}

const noteDoc = (id: string, rev: string, children: string[], extra: Record<string, unknown> = {}) => ({
  _id: id,
  _rev: rev,
  _revisions: { start: Number(rev.split("-")[0]), ids: [rev.split("-")[1]!] },
  path: id,
  children,
  ctime: 1,
  mtime: 1700000000000,
  size: 10,
  type: "plain",
  ...extra,
});

const leafDoc = (id: string, data: string) => ({
  _id: id,
  _rev: "1-leaf",
  _revisions: { start: 1, ids: ["leaf"] },
  type: "leaf",
  data,
});

async function indexStatus(durableObject: TestVaultDO) {
  return (await (await internalOp(durableObject, { op: "indexStatus" })).json()) as Record<string, unknown>;
}

describe("external full-text index (VaultBindings.fullText)", () => {
  it("sends notes per change and never builds the R2 index", async () => {
    const { index, writer, notes } = memoryFullText();
    const { durableObject, env } = await vaultWith({ fullText: index });
    await replicate(durableObject, [
      leafDoc("h:a", "alpha"),
      leafDoc("h:t", "trashed"),
      noteDoc("a.md", "1-a", ["h:a"]),
      noteDoc(".trash/t.md", "1-t", ["h:t"]),
      noteDoc(".kuro/m.md", "1-m", ["h:a"]),
    ]);

    await durableObject.alarm();
    await durableObject.alarm(); // would run the R2 rebuild without fullText

    expect([...notes.keys()].sort()).toEqual([".trash/t.md", "a.md"]);
    expect(notes.get("a.md")).toEqual({
      path: "a.md",
      content: "alpha",
      contentHash: await hashText("alpha"),
      mtime: 1700000000000,
    });
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(env.FTS_BUCKET.put)).not.toHaveBeenCalled();
    await expect(indexStatus(durableObject)).resolves.toMatchObject({
      indexed: 2,
      pending: 0,
      fullText: { indexed: 2, pending: 0 },
    });

    // An edit re-sends the note; a deletion removes it.
    await replicate(durableObject, [
      leafDoc("h:a2", "alpha v2"),
      noteDoc("a.md", "2-b", ["h:a2"], { _revisions: { start: 2, ids: ["b", "a"] } }),
    ]);
    await durableObject.alarm();
    expect(notes.get("a.md")?.content).toBe("alpha v2");
    await replicate(durableObject, [
      { _id: ".trash/t.md", _rev: "2-del", _revisions: { start: 2, ids: ["del", "t"] }, _deleted: true },
    ]);
    await durableObject.alarm();
    expect(writer.delete).toHaveBeenCalledWith(".trash/t.md");
    expect([...notes.keys()]).toEqual(["a.md"]);
  });

  it("retries a failed write without embedding the note again", async () => {
    const { index, notes } = memoryFullText();
    const openWriter = index.openWriter.getMockImplementation()!;
    index.openWriter.mockRejectedValueOnce(new Error("database unreachable"));
    const { durableObject, env, storage } = await vaultWith({ fullText: index });
    await replicate(durableObject, [leafDoc("h:a", "alpha"), noteDoc("a.md", "1-a", ["h:a"])]);

    await durableObject.alarm();
    expect(notes.size).toBe(0);
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);
    await expect(indexStatus(durableObject)).resolves.toMatchObject({
      pending: 1,
      fullText: { indexed: 0, pending: 1 },
    });
    expect(storage.setAlarm).toHaveBeenCalled();

    index.openWriter.mockImplementation(openWriter);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    await durableObject.alarm();
    expect([...notes.keys()]).toEqual(["a.md"]);
    vi.restoreAllMocks();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);
    await expect(indexStatus(durableObject)).resolves.toMatchObject({
      pending: 0,
      fullText: { indexed: 1, pending: 0 },
    });
  });

  it("backfills notes indexed before the external index was configured", async () => {
    const { durableObject, env, storage } = await vaultWith();
    await replicate(durableObject, [leafDoc("h:a", "alpha"), noteDoc("a.md", "1-a", ["h:a"])]);
    await durableObject.alarm();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);

    const { index, notes } = memoryFullText();
    env.fullText = index;
    storage.setAlarm.mockClear();
    (durableObject as unknown as { lastIndexScheduleAt: number }).lastIndexScheduleAt = 0;
    await durableObject.fetch(new Request("https://db/_changes?since=0"));
    expect(storage.setAlarm).toHaveBeenCalled();

    await durableObject.alarm();
    expect([...notes.keys()]).toEqual(["a.md"]);
    vi.restoreAllMocks();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);
  });

  it("re-sends every note on ftsRebuild and drops the vault on purge", async () => {
    const { index, writer } = memoryFullText();
    const { durableObject } = await vaultWith({ fullText: index });
    await replicate(durableObject, [leafDoc("h:a", "alpha"), noteDoc("a.md", "1-a", ["h:a"])]);
    await durableObject.alarm();
    expect(writer.upsert).toHaveBeenCalledTimes(1);

    await internalOp(durableObject, { op: "ftsRebuild" });
    await durableObject.alarm();
    expect(writer.upsert).toHaveBeenCalledTimes(2);

    const res = await durableObject.fetch(
      new Request("https://db/internal/purge", {
        method: "POST",
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(index.deleteVault).toHaveBeenCalledWith({ tenantId: "user-1", databaseName: "vault" });
  });
});

describe("VaultPolicy.excludeHiddenPaths", () => {
  it("keeps hidden paths out of the indexes only when enabled", async () => {
    for (const excludeHiddenPaths of [false, true]) {
      const { durableObject, env } = await vaultWith({ policy: { excludeHiddenPaths } });
      await replicate(durableObject, [
        leafDoc("h:a", "alpha"),
        noteDoc("a.md", "1-a", ["h:a"]),
        noteDoc(".trash/t.md", "1-t", ["h:a"]),
        noteDoc("Notes/.draft.md", "1-d", ["h:a"]),
        noteDoc("i:.obsidian/snippets/x.md", "1-i", ["h:a"]),
      ]);
      await durableObject.alarm();
      const indexed = env.upserted.map((vector) => vector.metadata?.path);
      if (excludeHiddenPaths) expect(indexed).toEqual(["a.md"]);
      else expect(indexed).toEqual(expect.arrayContaining([".trash/t.md", "Notes/.draft.md", "a.md"]));
      // Still readable either way.
      const read = await internalOp(durableObject, { op: "readNote", path: ".trash/t.md" });
      await expect(read.json()).resolves.toEqual({ content: "alpha" });
    }
  });
});

describe("VaultBindings.objectName", () => {
  it("routes LiveSync requests to the named Durable Object", async () => {
    const stub = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const idFromName = vi.fn((name: string) => ({ name }));
    const base = testEnv();
    const ref = { tenantId: "team", databaseName: "knowledge" };
    const response = await handleLiveSyncRequest(
      new Request("https://example.test/livesync/knowledge/", {
        headers: { Authorization: `Basic ${btoa("sync-user:sync-pass")}` },
      }),
      {
        host: testHost(base, ref),
        bindings: {
          vaultDb: { idFromName, get: vi.fn(() => stub) } as unknown as DurableObjectNamespace,
          objectName: (vault) => vault.databaseName,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("knowledge");
  });
});

describe("handleLiveSyncRequest CORS", () => {
  it("lets clients cache the preflight", async () => {
    const base = testEnv();
    const response = await handleLiveSyncRequest(
      new Request("https://example.test/livesync/vault/_changes", {
        method: "OPTIONS",
        headers: { Origin: "app://obsidian.md" },
      }),
      { host: testHost(base), bindings: testBindings(base) },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});

describe("handleLiveSyncRequest errors", () => {
  it("answers a failing credential check with a CORS-enabled 500", async () => {
    const base = testEnv();
    const host = { ...testHost(base), verifyCredential: vi.fn(async () => Promise.reject(new Error("D1 down"))) };
    const response = await handleLiveSyncRequest(
      new Request("https://example.test/livesync/vault/_changes", {
        headers: { Authorization: `Basic ${btoa("sync-user:sync-pass")}`, Origin: "app://obsidian.md" },
      }),
      { host, bindings: testBindings(base) },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("app://obsidian.md");
    await expect(response.json()).resolves.toEqual({
      error: "internal_server_error",
      reason: "Internal server error",
    });
  });
});

describe("Vault client with fullText and objectName", () => {
  it("greps through the external index and reaches the named object", async () => {
    const { index } = memoryFullText();
    index.search.mockResolvedValue({
      hits: [
        { path: "a.md", score: 2, matchCount: 2, snippets: [{ before: "x ", match: "alpha", after: " y" }] },
        { path: ".kuro/m.md", score: 1, matchCount: 1, snippets: [] },
      ],
      builtAt: 123,
      docCount: 2,
    });
    const fetch = vi.fn(async () => Response.json({ paths: ["a.md"], contents: { "a.md": "x alpha y" } }));
    const idFromName = vi.fn((name: string) => name);
    const env = testEnv();
    const { bucket: _bucket, ...withoutBucket } = testBindings(env);
    const vault = createVault(
      {
        ...withoutBucket,
        vaultDb: { idFromName, get: vi.fn(() => ({ fetch })) } as unknown as DurableObjectNamespace,
        fullText: index,
        objectName: () => "knowledge",
      },
      {
        ref: { tenantId: "team", databaseName: "knowledge" },
        policy: { reservedPaths: [".kuro"], excludedFolders: [], timeZone: "UTC" },
        internalSecret: TEST_SECRET,
      },
    );

    await expect(vault.grep("alpha", 10)).resolves.toEqual({
      status: "ready",
      hits: [{ path: "a.md", score: 2, matchCount: 2, snippets: [{ before: "x ", match: "alpha", after: " y" }] }],
      builtAt: 123,
      docCount: 2,
    });
    expect(index.search).toHaveBeenCalledWith({ tenantId: "team", databaseName: "knowledge" }, "alpha", 10);

    await vault.listMarkdownPaths();
    expect(idFromName).toHaveBeenCalledWith("knowledge");
  });
});

describe("publication and concurrency regressions", () => {
  it("retries both buffered upserts and deletes after close fails", async () => {
    const { index, writer } = memoryFullText();
    const { durableObject, database } = await vaultWith({ fullText: index });
    await replicate(durableObject, [noteDoc("a.md", "1-a", [], { data: "alpha" })]);
    vi.mocked(writer.close).mockRejectedValueOnce(new Error("publish failed"));
    await durableObject.alarm();
    expect(database.prepare("SELECT pending, fts_hash FROM index_state").get()).toMatchObject({ pending: 1, fts_hash: null });
    database.prepare("DELETE FROM meta WHERE key = 'index_retry_at'").run();
    await durableObject.alarm();
    expect(writer.upsert).toHaveBeenCalledTimes(2);
    await replicate(durableObject, [{ _id: "a.md", _rev: "2-b", _deleted: true, _revisions: { start: 2, ids: ["b", "a"] } }]);
    vi.mocked(writer.close).mockRejectedValueOnce(new Error("delete publication failed"));
    await durableObject.alarm();
    expect(database.prepare("SELECT pending FROM index_state").get()).toMatchObject({ pending: 1 });
    database.prepare("DELETE FROM meta WHERE key = 'index_retry_at'").run();
    await durableObject.alarm();
    expect(writer.delete).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT * FROM index_state").all()).toHaveLength(0);
  });

  it.each(["note", "child", "unrelated"])("allows sync during publication and validates %s revisions", async (change) => {
    const { index, writer, notes } = memoryFullText();
    const { durableObject, database } = await vaultWith({ fullText: index });
    await replicate(durableObject, [leafDoc("h:a", "alpha"), noteDoc("a.md", "1-a", ["h:a"])]);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(writer.close).mockImplementationOnce(async () => { entered(); await gate; });
    const alarm = durableObject.alarm();
    await paused;
    try {
      const doc = change === "note" ? noteDoc("a.md", "2-b", [], { data: "beta", _revisions: { start: 2, ids: ["b", "a"] } }) :
        change === "child" ? { _id: "h:a", _rev: "2-b", type: "leaf", data: "beta", _revisions: { start: 2, ids: ["b", "leaf"] } } :
        noteDoc("other.md", "1-a", [], { data: "unrelated" });
      // Would deadlock before publication was split from the canonical lock.
      expect((await replicate(durableObject, [doc])).status).toBe(200);
      expect((await durableObject.fetch(new Request("https://db/_changes"))).status).toBe(200);
    } finally { release(); }
    await alarm;
    const state = database.prepare("SELECT pending FROM index_state WHERE path = 'a.md'").get();
    expect(state).toMatchObject({ pending: change === "unrelated" ? 0 : 1 });
    await durableObject.alarm();
    expect(notes.get("a.md")?.content).toBe(change === "unrelated" ? "alpha" : "beta");
  });

  it("drains bounded pending-only batches without another foreground request", async () => {
    const { index, notes } = memoryFullText();
    const { durableObject, database } = await vaultWith({ fullText: index });
    await replicate(durableObject, Array.from({ length: 41 }, (_, i) => noteDoc(`${i}.md`, "1-a", [], { data: `note ${i}` })));
    await durableObject.alarm();
    expect(notes.size).toBe(16);
    expect(database.prepare("SELECT COUNT(*) n FROM index_state WHERE pending = 1").get()).toMatchObject({ n: 25 });
    await durableObject.alarm();
    await durableObject.alarm();
    expect(notes.size).toBe(41);
    expect(database.prepare("SELECT COUNT(*) n FROM index_state WHERE pending = 1").get()).toMatchObject({ n: 0 });
  });

  it("revives all exhausted missing-chunk notes across bounded passes", async () => {
    const { index, notes } = memoryFullText();
    const { durableObject, database } = await vaultWith({ fullText: index });
    await replicate(durableObject, Array.from({ length: 35 }, (_, i) => noteDoc(`${i}.md`, "1-a", ["h:shared"])));
    await durableObject.alarm();
    database.prepare("UPDATE index_state SET attempts = 20").run();
    await replicate(durableObject, [leafDoc("h:shared", "arrived")]);
    for (let i = 0; i < 6; i++) await durableObject.alarm();
    expect(notes.size).toBe(35);
  });

  it("persists subrequest backoff and reduces the next batch", async () => {
    const { index } = memoryFullText();
    index.openWriter.mockRejectedValue(new Error("Too many subrequests"));
    const { durableObject, database, storage } = await vaultWith({ fullText: index });
    await replicate(durableObject, [noteDoc("a.md", "1-a", [], { data: "alpha" })]);
    await durableObject.alarm();
    expect(database.prepare("SELECT value FROM meta WHERE key = 'index_batch_size'").get()).toMatchObject({ value: "8" });
    const attempts = index.openWriter.mock.calls.length;
    await durableObject.alarm();
    expect(index.openWriter).toHaveBeenCalledTimes(attempts);
    const deadline = Number((database.prepare("SELECT value FROM meta WHERE key = 'index_retry_at'").get() as {value:string}).value);
    expect(storage.setAlarm.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(deadline);
  });

  it("changes only the full-text generation when its version changes", async () => {
    const { index, writer } = memoryFullText();
    const begin = vi.fn(async () => {}), complete = vi.fn(async () => {});
    const external: FullTextIndex = { ...index, indexVersion: "1", beginRebuild: begin, completeRebuild: complete };
    const { durableObject, env } = await vaultWith({ fullText: external });
    await replicate(durableObject, [noteDoc("a.md", "1-a", [], { data: "alpha" })]);
    await durableObject.alarm();
    external.indexVersion = "2";
    await durableObject.alarm();
    expect(begin).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(writer.upsert).toHaveBeenCalledTimes(2);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });
});

it("retries a published batch after acknowledgement storage fails and the instance restarts", async () => {
  const {index,writer}=memoryFullText();const {durableObject,storage,database,env}=await vaultWith({fullText:index});
  await replicate(durableObject,[noteDoc("a.md","1-a",[],{data:"alpha"})]);
  const exec=storage.sql.exec.bind(storage.sql);let fail=true;
  storage.sql.exec=((query:string,...args:unknown[])=>{if(fail&&query.includes("UPDATE index_state SET hash = ?")){fail=false;throw new Error("injected ack failure");}return exec(query,...args);}) as typeof storage.sql.exec;
  await durableObject.alarm();
  expect(database.prepare("SELECT pending,fts_hash FROM index_state").get()).toMatchObject({pending:1,fts_hash:null});
  database.prepare("DELETE FROM meta WHERE key = 'index_retry_at'").run();
  const restarted=new FullTextVaultDO({storage,id:{name:"user-1:vault"}} as unknown as DurableObjectState,env);
  await restarted.alarm();
  expect(writer.upsert).toHaveBeenCalledTimes(2);
  expect(database.prepare("SELECT pending FROM index_state").get()).toMatchObject({pending:0});
});

it("tracks a replacement document id even when the content hash is unchanged",async()=>{
  const {index,notes}=memoryFullText();const {durableObject,database}=await vaultWith({fullText:index});
  await replicate(durableObject,[noteDoc("old-id","1-a",[],{path:"a.md",data:"same"})]);await durableObject.alarm();
  await replicate(durableObject,[{_id:"old-id",_rev:"2-b",_deleted:true,_revisions:{start:2,ids:["b","a"]}},noteDoc("new-id","1-a",[],{path:"a.md",data:"same"})]);
  await durableObject.alarm();
  expect(database.prepare("SELECT doc_id FROM index_state WHERE path='a.md'").get()).toMatchObject({doc_id:"new-id"});
  await replicate(durableObject,[{_id:"new-id",_rev:"2-b",_deleted:true,_revisions:{start:2,ids:["b","a"]}}]);await durableObject.alarm();
  expect(notes.has("a.md")).toBe(false);
});
it("bounds changes response bytes without skipping revisions",async()=>{
  const {durableObject}=await vaultWith();
  const docs=Array.from({length:5},(_,i)=>({_id:`h:${i}`,_rev:"1-a",type:"leaf",data:"x".repeat(2*1024*1024)}));
  expect((await replicate(durableObject,docs)).status).toBe(200);
  const seen:string[]=[];let since=0;
  for(let i=0;i<5;i++){
    const response=await durableObject.fetch(new Request(`https://db/_changes?include_docs=true&since=${since}`));
    const text=await response.text();expect(new TextEncoder().encode(text).byteLength).toBeLessThan(9*1024*1024);
    const batch=JSON.parse(text);seen.push(...batch.results.map((row:{id:string})=>row.id));since=batch.last_seq;
    if(!batch.pending)break;
  }
  expect(seen).toEqual(docs.map(doc=>doc._id));
});

it("re-arms pending-only work after a missing alarm without resetting its retry deadline",async()=>{
  const {index,writer}=memoryFullText();const {durableObject,storage,database}=await vaultWith({fullText:index});
  await replicate(durableObject,[noteDoc("a.md","1-a",[],{data:"alpha"})]);
  vi.mocked(writer.close).mockRejectedValueOnce(new Error("unavailable"));await durableObject.alarm();
  const deadline=Number((database.prepare("SELECT value FROM meta WHERE key='index_retry_at'").get() as {value:string}).value);
  storage.setAlarm.mockClear();
  (durableObject as unknown as {lastIndexScheduleAt:number}).lastIndexScheduleAt=0;
  await durableObject.fetch(new Request('https://db/'));
  expect(storage.setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(deadline);
  expect((database.prepare("SELECT value FROM meta WHERE key='indexed_seq'").get() as {value:string}).value).toBe('1');
});
