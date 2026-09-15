import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { hashText, splitNoteContentForChunks } from "../src/index.js";
import { TestVaultDO, testEnv } from "./helpers.js";

type SqliteRow = Record<string, string | number | null>;

class TestSqlCursor<T extends SqliteRow> {
  constructor(private readonly rows: T[]) {}
  toArray(): T[] {
    return this.rows;
  }
  one(): T {
    if (this.rows.length !== 1) throw new Error(`Expected one row, got ${this.rows.length}`);
    return this.rows[0]!;
  }
}

function vaultDb(options: { excludedFolders?: string[] } = {}) {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T extends SqliteRow>(query: string, ...bindings: unknown[]) {
      const rows = database.prepare(query).all(...(bindings as never[])) as T[];
      return new TestSqlCursor(rows);
    },
  };
  let alarmAt: number | null = null;
  const storage = {
    sql,
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
    getAlarm: vi.fn(async () => alarmAt),
    setAlarm: vi.fn(async (at: number) => {
      alarmAt = at;
    }),
  };
  const env = testEnv();
  env.policy = {
    reservedPaths: [".kuro"],
    excludedFolders: options.excludedFolders ?? [],
    timeZone: "UTC",
  };
  const { upserted, deletedIds } = env;
  const durableObject = new TestVaultDO(
    { storage, id: { name: "user-1:vault" } } as unknown as DurableObjectState,
    env,
  );
  return {
    durableObject,
    storage,
    env,
    upserted,
    deletedIds,
    alarmAt: () => alarmAt,
  };
}

async function created(options: { excludedFolders?: string[] } = {}) {
  const context = vaultDb(options);
  await context.durableObject.fetch(new Request("https://db/", { method: "PUT" }));
  return context;
}

function internalOp(durableObject: TestVaultDO, body: Record<string, unknown>) {
  return durableObject.fetch(
    new Request("https://db/internal/op", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-LiveSync-Internal": "test-secret",
      },
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const noteDoc = (id: string, rev: string, path: string, children: string[], extra: Record<string, unknown> = {}) => ({
  _id: id,
  _rev: rev,
  _revisions: { start: Number(rev.split("-")[0]), ids: [rev.split("-")[1]!] },
  path,
  children,
  ctime: 1,
  mtime: 2,
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

describe("LiveSync internal note access", () => {
  it("lists markdown notes and reassembles chunked content", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:a", "# Hello\n"),
      leafDoc("h:b", "world"),
      noteDoc("notes/hello.md", "1-n", "notes/hello.md", ["h:a", "h:b"]),
      noteDoc("image.png", "1-i", "image.png", ["h:a"], { type: "newnote" }),
      noteDoc("i:.obsidian/plugins/x/readme.md", "1-p", "i:.obsidian/plugins/x/readme.md", ["h:a"]),
      noteDoc("gone.md", "1-g", "gone.md", ["h:a"], { deleted: true }),
    ]);

    await expect(
      json(await internalOp(durableObject, { op: "listMarkdownPaths" })),
    ).resolves.toEqual({ paths: ["notes/hello.md"] });
    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: "notes/hello.md" })),
    ).resolves.toEqual({ content: "# Hello\nworld" });
    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: "gone.md" })),
    ).resolves.toEqual({ content: null });
  });

  it("lists note stats with mtime and size", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:a", "# Hello\n"),
      noteDoc("notes/hello.md", "1-n", "notes/hello.md", ["h:a"]),
      noteDoc("image.png", "1-i", "image.png", ["h:a"], { type: "newnote" }),
      noteDoc("i:.obsidian/plugins/x/readme.md", "1-p", "i:.obsidian/plugins/x/readme.md", ["h:a"]),
    ]);

    await expect(
      json(await internalOp(durableObject, { op: "listNoteStats" })),
    ).resolves.toEqual({
      files: [{ path: "notes/hello.md", mtime: 2, size: 10 }],
    });
  });

  it("reads hidden internal files through the i: prefix", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:s", '{"folder":"Daily"}'),
      noteDoc("i:.obsidian/daily-notes.json", "1-s", "i:.obsidian/daily-notes.json", ["h:s"]),
    ]);
    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: ".obsidian/daily-notes.json" })),
    ).resolves.toEqual({ content: '{"folder":"Daily"}' });
  });

  it("returns null content while chunks are still missing", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      noteDoc("pending.md", "1-p", "pending.md", ["h:missing"]),
    ]);
    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: "pending.md" })),
    ).resolves.toEqual({ content: null });
  });

  it("rejects internal ops without the shared secret", async () => {
    const { durableObject } = await created();
    const response = await durableObject.fetch(
      new Request("https://db/internal/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "listMarkdownPaths" }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("LiveSync writeNote", () => {
  it("creates a new note as chunk + plain entry documents", async () => {
    const { durableObject } = await created();
    const response = await internalOp(durableObject, {
      op: "writeNote",
      path: "Daily/2026-08-18.md",
      content: "# Today\n- [ ] task",
      expectedBaseHash: await hashText(""),
    });
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({ ok: true, path: "Daily/2026-08-18.md" });

    const doc = await json<{
      _id: string;
      path: string;
      children: string[];
      type: string;
      size: number;
      eden: Record<string, unknown>;
    }>(await durableObject.fetch(new Request("https://db/Daily%2F2026-08-18.md")));
    expect(doc).toMatchObject({
      _id: "Daily/2026-08-18.md",
      path: "Daily/2026-08-18.md",
      type: "plain",
      size: new TextEncoder().encode("# Today\n- [ ] task").byteLength,
      eden: {},
    });
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]).toMatch(/^h:k[0-9a-f]{40}$/);

    const chunk = await json<{ type: string; data: string }>(
      await durableObject.fetch(new Request(`https://db/${encodeURIComponent(doc.children[0]!)}`)),
    );
    expect(chunk).toMatchObject({ type: "leaf", data: "# Today\n- [ ] task" });

    // The change feed exposes the chunk before the note so replicators can fetch children.
    const changes = await json<{ results: Array<{ id: string }> }>(
      await durableObject.fetch(new Request("https://db/_changes?since=0")),
    );
    expect(changes.results.map((row) => row.id)).toEqual([doc.children[0], "Daily/2026-08-18.md"]);

    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: "Daily/2026-08-18.md" })),
    ).resolves.toEqual({ content: "# Today\n- [ ] task" });
  });

  it("updates an existing note in place, keeping id and ctime and bumping the revision", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:old", "old body"),
      noteDoc("Notes/Note.md", "1-n", "Notes/Note.md", ["h:old"], { ctime: 42 }),
    ]);

    const response = await internalOp(durableObject, {
      op: "writeNote",
      path: "Notes/Note.md",
      content: "new body",
      expectedBaseHash: await hashText("old body"),
    });
    expect(response.status).toBe(200);
    const doc = await json<{ _id: string; _rev: string; ctime: number; children: string[] }>(
      await durableObject.fetch(new Request("https://db/Notes%2FNote.md")),
    );
    expect(doc._id).toBe("Notes/Note.md");
    expect(doc._rev.startsWith("2-")).toBe(true);
    expect(doc.ctime).toBe(42);
    expect(doc.children[0]).not.toBe("h:old");
    await expect(
      json(await internalOp(durableObject, { op: "readNote", path: "Notes/Note.md" })),
    ).resolves.toEqual({ content: "new body" });
  });

  it("returns CONFLICT when the base hash does not match", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:old", "old body"),
      noteDoc("n.md", "1-n", "n.md", ["h:old"]),
    ]);
    const response = await internalOp(durableObject, {
      op: "writeNote",
      path: "n.md",
      content: "new",
      expectedBaseHash: await hashText("something else"),
    });
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({ error: "CONFLICT", path: "n.md" });
  });

  it("follows the vault's lower-cased id convention for new notes", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:x", "x"),
      noteDoc("folder/existing note.md", "1-e", "Folder/Existing Note.md", ["h:x"]),
    ]);
    await internalOp(durableObject, {
      op: "writeNote",
      path: "Folder/New Note.md",
      content: "hi",
      expectedBaseHash: "",
    });
    const response = await durableObject.fetch(new Request("https://db/folder%2Fnew%20note.md"));
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({ path: "Folder/New Note.md" });
  });

  it("rejects unsafe or non-markdown paths", async () => {
    const { durableObject } = await created();
    for (const path of ["../x.md", "/abs.md", "note.txt", "a//b.md"]) {
      const response = await internalOp(durableObject, {
        op: "writeNote",
        path,
        content: "x",
        expectedBaseHash: "",
      });
      expect(response.status, path).toBe(400);
    }
  });

  it("splits very large content into multiple chunks", () => {
    const pieces = splitNoteContentForChunks("あ😀".repeat(120_000));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("あ😀".repeat(120_000));
  });
});

describe("LiveSync Vectorize indexing", () => {
  it("schedules an alarm on writes and indexes markdown notes", async () => {
    const context = await created({ excludedFolders: ["Archive"] });
    const { durableObject, storage, upserted } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "## Heading\nbody"),
      noteDoc("Notes/a.md", "1-a", "Notes/a.md", ["h:a"]),
      noteDoc("Archive/old.md", "1-o", "Archive/old.md", ["h:a"]),
      noteDoc("pic.png", "1-p", "pic.png", ["h:a"], { type: "newnote" }),
      noteDoc(".kuro/MEMORY.md", "1-m", ".kuro/MEMORY.md", ["h:a"]),
    ]);
    expect(storage.setAlarm).toHaveBeenCalled();

    await durableObject.alarm();

    expect(upserted.map((vector) => vector.metadata?.path)).toEqual(["Notes/a.md"]);
    expect(upserted[0]!.metadata).toMatchObject({
      userId: "user-1",
      vaultId: "vault",
      heading: "Heading",
      preview: "## Heading\nbody",
    });
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1, pending: 0, indexedSeq: 5, currentSeq: 5 });
  });

  it("skips unchanged notes, removes deleted ones, and retries notes missing chunks", async () => {
    const context = await created();
    const { durableObject, upserted, deletedIds, env } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "content a"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
      noteDoc("late.md", "1-l", "late.md", ["h:late"]),
    ]);
    await durableObject.alarm();
    expect(upserted.map((vector) => vector.metadata?.path)).toEqual(["a.md"]);
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1, pending: 1 });

    // Chunk arrives later: the pending note gets indexed, a.md is untouched.
    await replicate(durableObject, [leafDoc("h:late", "late content")]);
    await durableObject.alarm();
    expect(upserted.map((vector) => vector.metadata?.path)).toEqual(["a.md", "late.md"]);
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(2);

    // Deleting a note removes its vectors.
    await replicate(durableObject, [
      { _id: "a.md", _rev: "2-del", _revisions: { start: 2, ids: ["del", "a"] }, _deleted: true },
    ]);
    await durableObject.alarm();
    expect(deletedIds).toHaveLength(1);
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1, pending: 0 });
  });


  it("indexes a note whose chunk arrives after the periodic retries gave up", async () => {
    const context = await created();
    const { durableObject, upserted, storage } = context;
    await replicate(durableObject, [noteDoc("late.md", "1-l", "late.md", ["h:late"])]);
    for (let attempt = 0; attempt < 25; attempt += 1) await durableObject.alarm();
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 0, pending: 1 });
    // Past the cap the alarm stops re-arming the periodic retry.
    storage.setAlarm.mockClear();
    await durableObject.alarm();
    expect(storage.setAlarm).not.toHaveBeenCalled();

    // Any chunk arrival re-checks pending notes regardless of the attempt count.
    await replicate(durableObject, [leafDoc("h:late", "late content")]);
    await durableObject.alarm();
    expect(upserted.map((vector) => vector.metadata?.path)).toEqual(["late.md"]);
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1, pending: 0 });
  });

  it("re-scans everything on reindex and drops newly excluded folders", async () => {
    const context = await created();
    const { durableObject, deletedIds } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "content"),
      noteDoc("Archive/a.md", "1-a", "Archive/a.md", ["h:a"]),
    ]);
    await durableObject.alarm();
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1 });

    context.env.policy = { ...context.env.policy, excludedFolders: ["Archive"] };
    await internalOp(durableObject, { op: "reindex" });
    await durableObject.alarm();
    expect(deletedIds).toHaveLength(1);
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 0 });
  });

  it("re-embeds every note once when the index version changes", async () => {
    const context = await created();
    const { durableObject, storage, env } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "content"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
    ]);
    await durableObject.alarm();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);

    // Nothing changed: no re-embedding.
    await durableObject.alarm();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(1);

    // Simulate an index built under an older version.
    storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'index_version'`);
    await durableObject.alarm();
    expect(vi.mocked(env.AI.run)).toHaveBeenCalledTimes(2);
    await expect(
      json(await internalOp(durableObject, { op: "indexStatus" })),
    ).resolves.toMatchObject({ indexed: 1, pending: 0 });
  });

  it("purge removes indexed vectors", async () => {
    const context = await created();
    const { durableObject, deletedIds } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "content"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
    ]);
    await durableObject.alarm();
    await durableObject.fetch(
      new Request("https://db/internal/purge", {
        method: "POST",
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    expect(deletedIds).toHaveLength(1);
  });
});

describe("LiveSync indexing catch-up", () => {
  it("schedules indexing on first access when existing docs are not indexed yet", async () => {
    const context = await created();
    const { durableObject, storage } = context;
    // Simulate a database populated before indexing existed: replicate, then forget the alarm.
    await replicate(durableObject, [leafDoc("h:a", "content"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    vi.mocked(storage.setAlarm).mockClear();
    vi.mocked(storage.getAlarm).mockResolvedValueOnce(null);
        (durableObject as unknown as { lastIndexScheduleAt: number }).lastIndexScheduleAt = 0;

    await durableObject.fetch(new Request("https://db/_changes?since=0"));
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it("schedules indexing on access when the index version is outdated", async () => {
    const context = await created();
    const { durableObject, storage } = context;
    await replicate(durableObject, [leafDoc("h:a", "content"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();

    storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'index_version'`);
    vi.mocked(storage.setAlarm).mockClear();
    vi.mocked(storage.getAlarm).mockResolvedValueOnce(null);
    (durableObject as unknown as { lastIndexScheduleAt: number }).lastIndexScheduleAt = 0;

    await durableObject.fetch(new Request("https://db/_changes?since=0"));
    expect(storage.setAlarm).toHaveBeenCalled();
  });
});
