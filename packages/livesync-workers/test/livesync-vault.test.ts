import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createVault, hashText, splitNoteContentForChunks } from "../src/index.js";
import { ftsSearch, readFtsManifest } from "../src/search/fts-index.js";
import { buildIndex } from "../src/search/fts/build.js";
import { memoryBucket, TestVaultDO, testBindings, testEnv } from "./helpers.js";

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

  it("hides chunked logical deletions from lists, batch reads, and semantic hit validation", async () => {
    const { durableObject, env, storage } = await created();
    const content = "private body ".repeat(100_000);
    await replicate(durableObject, [
      leafDoc("h:private", "private child body"),
      noteDoc("data.md", "1-a", "data.md", [], { deleted: true, data: content }),
      noteDoc("children.md", "1-b", "children.md", ["h:private"], { deleted: true, padding: content }),
    ]);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM revs WHERE body_chunked = 1").one())
      .toEqual({ count: 2 });
    await expect(json(await internalOp(durableObject, { op: "listMarkdownPaths" })))
      .resolves.toEqual({ paths: [] });
    await expect(json(await internalOp(durableObject, { op: "listNoteStats" })))
      .resolves.toEqual({ files: [] });
    await expect(json(await internalOp(durableObject, { op: "readNotes", paths: ["data.md", "children.md"] })))
      .resolves.toEqual({ contents: { "data.md": null, "children.md": null } });
    env.VAULT_DB = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => durableObject.fetch(request) }),
    } as unknown as DurableObjectNamespace;
    env.VECTORIZE.query.mockResolvedValue({ matches: [
      { score: 1, metadata: { origin: "vault", path: "data.md", hash: await hashText(content), preview: "private preview" } },
      { score: 1, metadata: { origin: "vault", path: "children.md", hash: await hashText("private child body"), preview: "private preview" } },
    ] });
    const vault = createVault(testBindings(env), {
      ref: { tenantId: "user-1", databaseName: "vault" }, policy: env.policy, internalSecret: "test-secret",
    });
    expect(await vault.search("private", 5)).toEqual([]);
  });

  it("loads only requested note bodies for a batch read", async () => {
    const { durableObject, storage } = await created();
    await replicate(durableObject, [
      noteDoc("wanted.md", "1-a", "wanted.md", [], { data: "wanted" }),
      noteDoc("unrelated.md", "1-b", "unrelated.md", [], { data: "unrelated".repeat(10_000) }),
    ]);
    const returnedIds: string[] = [];
    const exec = storage.sql.exec.bind(storage.sql);
    vi.spyOn(storage.sql, "exec").mockImplementation((query, ...bindings) => {
      const cursor = exec(query, ...bindings);
      if (query.includes("SELECT r.*")) {
        returnedIds.push(...cursor.toArray().map((row) => String(row.id)));
      }
      return cursor;
    });
    await expect(json(await internalOp(durableObject, { op: "readNotes", paths: ["wanted.md"] })))
      .resolves.toEqual({ contents: { "wanted.md": "wanted" } });
    expect(returnedIds).toEqual(["wanted.md"]);
  });

  it("lists every synced file except hidden internal files", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      leafDoc("h:a", "# Hello\n"),
      noteDoc("notes/hello.md", "1-n", "notes/hello.md", ["h:a"]),
      noteDoc("images/a.png", "1-i", "images/a.png", ["h:a"], { type: "newnote" }),
      noteDoc("i:.obsidian/plugins/x/readme.md", "1-p", "i:.obsidian/plugins/x/readme.md", ["h:a"]),
      noteDoc("gone.png", "1-g", "gone.png", ["h:a"], { type: "newnote", deleted: true }),
    ]);
    const { files } = await json(await internalOp(durableObject, { op: "listFileStats" })) as {
      files: Array<{ path: string }>;
    };
    expect(files.map((file) => file.path).sort()).toEqual(["images/a.png", "notes/hello.md"]);
  });

  it("reads binary files by decoding each base64 chunk separately", async () => {
    const { durableObject } = await created();
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    // 100-byte pieces end in "==" padding, so joining the strings would not decode.
    const pieces = [bytes.subarray(0, 100), bytes.subarray(100, 200), bytes.subarray(200)]
      .map((piece) => Buffer.from(piece).toString("base64"));
    await replicate(durableObject, [
      leafDoc("h:b1", pieces[0]!),
      leafDoc("h:b2", pieces[1]!),
      leafDoc("h:b3", pieces[2]!),
      noteDoc("images/a.png", "1-i", "images/a.png", ["h:b1", "h:b2", "h:b3"], { type: "newnote" }),
      noteDoc("inline.png", "1-d", "inline.png", [], { type: "newnote", data: pieces }),
      noteDoc("text.md", "1-t", "text.md", [], { data: "日本語" }),
      noteDoc("pending.png", "1-p", "pending.png", ["h:missing"], { type: "newnote" }),
    ]);

    for (const path of ["images/a.png", "inline.png"]) {
      const response = await internalOp(durableObject, { op: "readFile", path });
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    const text = await internalOp(durableObject, { op: "readFile", path: "text.md" });
    expect(await text.text()).toBe("日本語");
    for (const path of ["pending.png", "missing.png"]) {
      expect((await internalOp(durableObject, { op: "readFile", path })).status).toBe(404);
    }
  });

  it("reads binary files in LiveSync's legacy encoding", async () => {
    const { durableObject } = await created();
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encode = (piece: Uint8Array) =>
      String.fromCharCode(...Array.from(piece, (b) =>
        b >= 0x26 && b <= 0x7e && b !== 0x3a ? b : 0xc0 + b,
      ));
    await replicate(durableObject, [
      noteDoc("legacy.png", "1-l", "legacy.png", [], {
        type: "newnote",
        data: [`%${encode(bytes.subarray(0, 128))}`, encode(bytes.subarray(128))],
      }),
      noteDoc("broken.png", "1-b", "broken.png", [], { type: "newnote", data: ["not base64!"] }),
    ]);
    const response = await internalOp(durableObject, { op: "readFile", path: "legacy.png" });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await internalOp(durableObject, { op: "readFile", path: "broken.png" })).status).toBe(404);
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

  it("rejects replacing a note whose child chunks have not arrived", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [noteDoc("Daily/today.md", "1-n", "Daily/today.md", ["h:late"])]);
    for (const expectedBaseHash of [await hashText(""), ""]) {
      const response = await internalOp(durableObject, {
        op: "writeNote", path: "Daily/today.md", content: "appended", expectedBaseHash,
      });
      expect(response.status).toBe(409);
    }
    await replicate(durableObject, [leafDoc("h:late", "original body")]);
    await expect(json(await internalOp(durableObject, { op: "readNote", path: "Daily/today.md" })))
      .resolves.toEqual({ content: "original body" });
  });

  it("recreates a logically deleted note as a child of its deleted revision", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [noteDoc("Notes/Note.md", "1-n", "Notes/Note.md", [], { deleted: true })]);
    const response = await internalOp(durableObject, {
      op: "writeNote", path: "Notes/Note.md", content: "revived", expectedBaseHash: await hashText(""),
    });
    expect(response.status).toBe(200);
    const note = await json<{ _rev: string; _conflicts?: string[] }>(
      await durableObject.fetch(new Request("https://db/Notes%2FNote.md?conflicts=true")),
    );
    expect(note._rev).toMatch(/^2-/);
    expect(note._conflicts).toBeUndefined();
    await expect(json(await internalOp(durableObject, { op: "readNote", path: "Notes/Note.md" })))
      .resolves.toEqual({ content: "revived" });
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

  it("re-embeds unchanged long lines from index version 2, including their tails, only once", async () => {
    const { durableObject, storage, env } = await created();
    const content = "x".repeat(5_000) + "tailneedle";
    await replicate(durableObject, [noteDoc("long.md", "1-a", "long.md", [], { data: content })]);
    // Model the old completed index: identical content hash, but only one truncated vector.
    storage.sql.exec(`INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
      VALUES (?, ?, ?, 1, 0, 0)`, "long.md", "long.md", await hashText(content));
    storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('index_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('indexed_seq', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await durableObject.alarm();
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const inputs = env.AI.run.mock.calls.flatMap((call) => (call[1] as { text: string[] }).text);
    expect(inputs).toHaveLength(2);
    expect(inputs.some((text) => text.includes("tailneedle"))).toBe(true);
    expect(inputs.every((text) => text.length <= 4_000)).toBe(true);
    expect(storage.sql.exec("SELECT value FROM meta WHERE key = 'index_version'").one())
      .toEqual({ value: "3" });
    await durableObject.alarm();
    expect(env.AI.run).toHaveBeenCalledTimes(1);
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

  it("runs the FTS rebuild once the vault is quiet and records the generation", async () => {
    const { durableObject, env } = await created();
    await replicate(durableObject, [leafDoc("h:a", "全文検索のメモ"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm(); // vectors; arms the debounced rebuild
    await internalOp(durableObject, { op: "ftsRebuild" }); // make it due now
    await durableObject.alarm();
    const status = await json<{ fts: { generation: string | null; rebuildAt: number | null; error: string | null } }>(
      await internalOp(durableObject, { op: "indexStatus" }),
    );
    expect(status.fts.generation).toMatch(/\w+-\w+/);
    expect(status.fts.rebuildAt).toBeNull();
    expect(status.fts.error).toBeNull();
    const puts = vi.mocked(env.FTS_BUCKET.put).mock.calls.map(([key]) => String(key));
    expect(puts.filter((key) => key.endsWith("/manifest.json"))).toHaveLength(1);
    expect(puts.filter((key) => /shard-\d{3}\.bin$/.test(key))).toHaveLength(16);
    expect(puts.filter((key) => key.endsWith("/index.bin"))).toHaveLength(1);
  });

  it("gives up with an explicit error when the vault exceeds the FTS size guard", async () => {
    const context = vaultDb();
    context.env.ftsMaxTotalCodeUnits = 20;
    const { durableObject, env } = context;
    await durableObject.fetch(new Request("https://db/", { method: "PUT" }));
    await replicate(durableObject, [
      leafDoc("h:a", "十文字ちょうどの本文です。"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
      noteDoc("b.md", "1-b", "b.md", ["h:a"]),
      noteDoc("c.md", "1-c", "c.md", ["h:a"]),
    ]);
    await durableObject.alarm();
    await internalOp(durableObject, { op: "ftsRebuild" });
    await durableObject.alarm();
    const status = await json<{ fts: { generation: string | null; rebuildAt: number | null; error: string | null } }>(
      await internalOp(durableObject, { op: "indexStatus" }),
    );
    expect(status.fts.error).toMatch(/exceeds the full-text size guard/);
    expect(status.fts.rebuildAt).toBeNull();
    expect(status.fts.generation).toBeNull();
    const markers = () =>
      vi.mocked(env.FTS_BUCKET.put).mock.calls
        .filter(([key]) => String(key).endsWith("/debug.json"))
        .map(([, body]) => JSON.parse(String(body)) as { phase: string });
    expect(vi.mocked(env.FTS_BUCKET.put).mock.calls.some(([key]) => String(key).endsWith("/manifest.json"))).toBe(false);
    expect(markers().at(-1)).toMatchObject({ phase: "too-large" });
    const markerCount = markers().length;

    // Another ftsRebuild request retries (the guard is a size check, not a lockout).
    await internalOp(durableObject, { op: "ftsRebuild" });
    await durableObject.alarm();
    expect(markers().length).toBeGreaterThan(markerCount);
    expect(markers().at(-1)).toMatchObject({ phase: "too-large" });
  });

  it("stops retrying the FTS rebuild after repeated interrupted attempts", async () => {
    const { durableObject, env } = await created();
    await replicate(durableObject, [leafDoc("h:a", "本文"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    // The R2 marker says the previous attempts died mid-build (memory reset):
    // SQLite has no trace of them, only the marker survives.
    vi.mocked(env.FTS_BUCKET.get).mockImplementation((async (key: string) =>
      key.endsWith("/debug.json")
        ? ({ json: async () => ({ phase: "gather-start", attempts: 3, at: 1 }) } as unknown as R2ObjectBody)
        : null) as never);
    await internalOp(durableObject, { op: "ftsRebuild" });
    await durableObject.alarm();
    const status = await json<{ fts: { generation: string | null; rebuildAt: number | null; error: string | null } }>(
      await internalOp(durableObject, { op: "indexStatus" }),
    );
    expect(status.fts.error).toMatch(/interrupted 3 times/);
    expect(status.fts.rebuildAt).toBeNull();
    expect(status.fts.generation).toBeNull();
    const markers = vi.mocked(env.FTS_BUCKET.put).mock.calls.filter(([key]) => String(key).endsWith("/debug.json"));
    expect(JSON.parse(String(markers.at(-1)![1]))).toMatchObject({ phase: "failed", attempts: 3 });
    expect(vi.mocked(env.FTS_BUCKET.put).mock.calls.some(([key]) => String(key).endsWith("/manifest.json"))).toBe(false);
  });

  it("tracks notes and builds the full-text index without a vector index", async () => {
    const context = vaultDb();
    context.env.semanticSearch = false;
    const { durableObject, env, upserted } = context;
    await durableObject.fetch(new Request("https://db/", { method: "PUT" }));
    await replicate(durableObject, [leafDoc("h:a", "全文検索だけの vault"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    expect(vi.mocked(env.AI.run)).not.toHaveBeenCalled();
    expect(upserted).toHaveLength(0);
    await expect(json(await internalOp(durableObject, { op: "indexStatus" }))).resolves.toMatchObject({
      indexed: 1,
      pending: 0,
    });
    await internalOp(durableObject, { op: "ftsRebuild" });
    await durableObject.alarm();
    const status = await json<{ fts: { generation: string | null } }>(
      await internalOp(durableObject, { op: "indexStatus" }),
    );
    expect(status.fts.generation).toMatch(/\w+-\w+/);
    // Deleting the note must not touch Vectorize either.
    await replicate(durableObject, [
      { _id: "a.md", _rev: "2-del", _revisions: { start: 2, ids: ["del", "a"] }, _deleted: true },
    ]);
    await durableObject.alarm();
    expect(vi.mocked(env.VECTORIZE.deleteByIds)).not.toHaveBeenCalled();
  });

  it("indexes only changed notes into new segments and resolves the current versions", async () => {
    const context = await created();
    const { bucket } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    type Status = { fts: { generation: string | null; rebuildAt: number | null; error: string | null; pending: number } };
    const status = async () => json<Status>(await internalOp(durableObject, { op: "indexStatus" }));
    // Pull the debounced pass forward to "now".
    const makeDue = () => storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);

    await replicate(durableObject, [
      leafDoc("h:a", "京都の会議メモ"),
      leafDoc("h:b", "検索エンジンの実験"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
      noteDoc("b.md", "1-b", "b.md", ["h:b"]),
    ]);
    await durableObject.alarm(); // vectors; arms the debounced full-text pass
    expect(await status()).toMatchObject({ fts: { pending: 2, generation: null } });
    expect((await status()).fts.rebuildAt).toBeGreaterThan(Date.now());
    makeDue();
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null, error: null } });
    expect((await status()).fts.generation).toMatch(/^seg-/);
    expect((await readFtsManifest(bucket, ref))?.segments.map((s) => s.docCount)).toEqual([2]);

    // a.md changes, c.md is new, b.md is deleted: only a and c go into the next segment.
    await replicate(durableObject, [
      leafDoc("h:a2", "京都の会議は中止"),
      noteDoc("a.md", "2-a2", "a.md", ["h:a2"]),
      leafDoc("h:c", "会議室の予約"),
      noteDoc("c.md", "1-c", "c.md", ["h:c"]),
      { _id: "b.md", _rev: "2-del", _revisions: { start: 2, ids: ["del", "b"] }, _deleted: true },
    ]);
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 2 } });
    makeDue();
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null } });
    expect((await readFtsManifest(bucket, ref))?.segments.map((s) => s.docCount)).toEqual([2, 2]);

    // The index still holds the old a.md and the deleted b.md; the vault drops them.
    const result = await ftsSearch(bucket, ref, "会議", 20);
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.hits.filter((hit) => hit.path === "a.md")).toHaveLength(2);
    const resolved = await json<{ hits: Array<{ path: string; hash: string | null; content: string | null }> }>(
      await internalOp(durableObject, {
        op: "resolveFtsHits",
        candidates: [
          ...result.hits.map((hit) => ({ path: hit.path, hash: hit.hash })),
          { path: "b.md", hash: await hashText("検索エンジンの実験") },
        ],
        limit: 10,
      }),
    );
    expect(resolved.hits.map((hit) => hit.path).sort()).toEqual(["a.md", "c.md"]);
    expect(resolved.hits.find((hit) => hit.path === "a.md")).toMatchObject({
      hash: await hashText("京都の会議は中止"),
      content: "京都の会議は中止",
    });

    // A forced rebuild re-sends every note; the old segments stay searchable meanwhile.
    await internalOp(durableObject, { op: "ftsRebuild" });
    expect(await status()).toMatchObject({ fts: { pending: 2 } });
    const during = await json<{ hits: Array<{ path: string }> }>(
      await internalOp(durableObject, {
        op: "resolveFtsHits",
        candidates: result.hits.map((hit) => ({ path: hit.path, hash: hit.hash })),
        limit: 10,
      }),
    );
    expect(during.hits.map((hit) => hit.path).sort()).toEqual(["a.md", "c.md"]);
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0 } });
    const rebuilt = (await readFtsManifest(bucket, ref))!;
    expect(rebuilt.segments).toHaveLength(3);
    // Once every note is in a segment built since the rebuild, the older ones are retired.
    await durableObject.alarm();
    const settled = (await readFtsManifest(bucket, ref))!;
    expect(settled.segments.map((s) => s.id)).toEqual([rebuilt.segments[2]!.id]);
    expect(settled.retired.map((r) => r.id).sort()).toEqual(rebuilt.segments.slice(0, 2).map((s) => s.id).sort());
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null, error: null } });
    expect(storage.sql.exec(`SELECT value FROM meta WHERE key = 'fts_rebuild_epoch'`).toArray()).toEqual([]);
  });

  it("does not expose an FTS candidate whose recorded hash does not match its current body", async () => {
    const context = await created();
    const { bucket } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    const status = async () =>
      json<{ fts: { pending: number; error: string | null } }>(await internalOp(durableObject, { op: "indexStatus" }));
    await replicate(durableObject, [leafDoc("h:a", "会議のメモ"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    // Whatever left the vault's record disagreeing with the body (an older
    // build, a conflict): the note must not stay pending forever.
    storage.sql.exec(`UPDATE index_state SET hash = 'bogus' WHERE path = 'a.md'`);
    storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, error: null } });
    const result = await ftsSearch(bucket, ref, "会議", 5);
    expect(result.status === "ready" && result.hits.map((hit) => [hit.path, hit.hash])).toEqual([["a.md", "bogus"]]);
    const live = await json<{ hits: Array<{ path: string }> }>(
      await internalOp(durableObject, { op: "resolveFtsHits", candidates: [{ path: "a.md", hash: "bogus" }], limit: 5 }),
    );
    expect(live.hits).toEqual([]);
  });

  it("does not count a pass that indexed nothing as interrupted", async () => {
    const context = await created();
    const { bucket, store } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const status = async () =>
      json<{ fts: { pending: number; error: string | null; rebuildAt: number | null } }>(
        await internalOp(durableObject, { op: "indexStatus" }),
      );
    await replicate(durableObject, [leafDoc("h:a", "会議のメモ"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    // A note the vault tracks but whose document is gone: skipped by every pass.
    storage.sql.exec(
      `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts) VALUES ('ghost.md', 'missing', 'h', 0, 0, 0)`,
    );
    for (let i = 0; i < 4; i += 1) {
      storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_rebuild_at', '0')`);
      storage.sql.exec(`UPDATE index_state SET fts_hash = NULL WHERE path = 'ghost.md'`);
      await durableObject.alarm();
      expect((await status()).fts.error).toBeNull();
    }
    const marker = JSON.parse(new TextDecoder().decode(store.get("fts/user-1/vault/debug.json")));
    expect(marker).toMatchObject({ phase: "segment-empty", attempts: 1 });
  });

  it("indexes only the start of a very long note", async () => {
    const context = await created();
    const { bucket } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    const content = `${"会議".repeat(500_000)}末尾の合図`; // 1,000,005 code units
    await replicate(durableObject, [leafDoc("h:a", content), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);
    await durableObject.alarm();
    const manifest = (await readFtsManifest(bucket, ref))!;
    expect(manifest.segments.map((s) => s.totalChars)).toEqual([1_000_000]);
    expect((await ftsSearch(bucket, ref, "会議", 5)).status === "ready").toBe(true);
    const tail = await ftsSearch(bucket, ref, "末尾の合図", 5);
    expect(tail.status === "ready" && tail.hits).toEqual([]);
    expect(await json(await internalOp(durableObject, { op: "indexStatus" }))).toMatchObject({
      fts: { pending: 0, error: null },
    });
  });

  it("rewrites a segment whose text is mostly replaced versions once the vault is idle", async () => {
    const context = await created();
    const { bucket } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    type Status = { fts: { rebuildAt: number | null; error: string | null; pending: number } };
    const status = async () => json<Status>(await internalOp(durableObject, { op: "indexStatus" }));
    const makeDue = () => storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);

    await replicate(durableObject, [leafDoc("h:a1", "あ".repeat(300_000)), noteDoc("a.md", "1-a", "a.md", ["h:a1"])]);
    await durableObject.alarm();
    makeDue();
    await durableObject.alarm();
    const first = (await readFtsManifest(bucket, ref))!;
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null } });

    await replicate(durableObject, [leafDoc("h:a2", "い".repeat(300_000)), noteDoc("a.md", "2-a2", "a.md", ["h:a2"])]);
    await durableObject.alarm();
    makeDue();
    await durableObject.alarm(); // the new version's segment; the old one is now dead weight
    expect((await readFtsManifest(bucket, ref))!.segments).toHaveLength(2);
    expect((await status()).fts.rebuildAt).not.toBeNull(); // a maintenance pass is armed
    await durableObject.alarm();
    const after = (await readFtsManifest(bucket, ref))!;
    expect(after.segments.map((s) => s.totalChars)).toEqual([300_000]);
    expect(after.retired.map((r) => r.id)).toEqual(first.segments.map((s) => s.id));
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null, error: null } });
  });

  it("sheds replaced versions before giving up on the size guard", async () => {
    const context = await created();
    context.env.ftsMaxTotalCodeUnits = 400_000;
    const { bucket } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    type Status = { fts: { rebuildAt: number | null; error: string | null; pending: number } };
    const status = async () => json<Status>(await internalOp(durableObject, { op: "indexStatus" }));
    const makeDue = () => storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);

    await replicate(durableObject, [leafDoc("h:a1", "あ".repeat(300_000)), noteDoc("a.md", "1-a", "a.md", ["h:a1"])]);
    await durableObject.alarm();
    makeDue();
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, error: null } });
    const first = (await readFtsManifest(bucket, ref))!;
    expect(first.segments.map((s) => s.totalChars)).toEqual([300_000]);

    // The replacement does not fit next to the old version (600k > 400k)...
    await replicate(durableObject, [leafDoc("h:a2", "い".repeat(300_000)), noteDoc("a.md", "2-a2", "a.md", ["h:a2"])]);
    await durableObject.alarm();
    makeDue();
    await durableObject.alarm(); // over the guard: the old version's segment is rewritten away
    expect(await status()).toMatchObject({ fts: { pending: 1, error: null } });
    const shed = (await readFtsManifest(bucket, ref))!;
    expect(shed.segments).toEqual([]);
    expect(shed.retired.map((r) => r.id)).toEqual(first.segments.map((s) => s.id));
    await durableObject.alarm(); // ...and now it does.
    expect(await status()).toMatchObject({ fts: { pending: 0, error: null } });
    expect((await readFtsManifest(bucket, ref))!.segments.map((s) => s.totalChars)).toEqual([300_000]);
    const hits = await ftsSearch(bucket, ref, "いい", 5);
    expect(hits.status === "ready" && hits.hits.map((h) => h.path)).toEqual(["a.md"]);
    await durableObject.alarm();
    expect(await status()).toMatchObject({ fts: { pending: 0, rebuildAt: null, error: null } });
  });

  it("re-indexes a vault with a version-1 index into segments and retires the old generation", async () => {
    const context = await created();
    const { bucket, store } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    await replicate(durableObject, [leafDoc("h:a", "旧世代の会議メモ"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    // The index as the previous release left it: one generation, notes untracked per hash.
    await bucket.put(
      "fts/user-1/vault/manifest.json",
      JSON.stringify({ version: 1, generation: "gen-old", shardCount: 16, docCount: 1, totalChars: 8, builtAt: 5 }),
    );
    await bucket.put("fts/user-1/vault/gen-old/docs.json.gz", new Uint8Array([1]));
    storage.sql.exec(`DELETE FROM meta WHERE key = 'fts_rebuild_at'`);
    storage.sql.exec(`UPDATE index_state SET fts_hash = NULL`);
    // ...including the old build's verdict, which a fresh object clears on its first start.
    storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('fts_error', 'vault exceeds the full-text size guard')`);
    storage.sql.exec(`DELETE FROM meta WHERE key = 'fts_index_version'`);
    const upgraded = new TestVaultDO(
      { storage, id: { name: "user-1:vault" } } as unknown as DurableObjectState,
      context.env,
    );
    expect(await json(await internalOp(upgraded, { op: "indexStatus" }))).toMatchObject({
      fts: { error: null, pending: 1 },
    });

    // Legacy docs count as current until the note is written to a hashed segment.
    const live = async () =>
      json<{ hits: Array<{ path: string }> }>(
        await internalOp(durableObject, { op: "resolveFtsHits", candidates: [{ path: "a.md", hash: null }], limit: 5 }),
      );
    expect((await live()).hits).toHaveLength(1);

    await durableObject.alarm(); // nothing armed, but notes are pending: builds a segment
    let manifest = await readFtsManifest(bucket, ref);
    expect(manifest?.segments.map((s) => s.hashed)).toEqual([false, true]);
    expect((await live()).hits).toHaveLength(0);
    await durableObject.alarm(); // maintenance: the legacy generation is retired
    manifest = await readFtsManifest(bucket, ref);
    expect(manifest?.segments.map((s) => s.hashed)).toEqual([true]);
    expect(manifest?.retired.map((r) => r.id)).toEqual(["gen-old"]);
    expect(store.has("fts/user-1/vault/gen-old/docs.json.gz")).toBe(true);
    await durableObject.alarm();
    expect(await json(await internalOp(durableObject, { op: "indexStatus" }))).toMatchObject({
      fts: { pending: 0, rebuildAt: null, error: null },
    });
  });

  it("rewrites segments of an older shard format after an index-version upgrade", async () => {
    const context = await created();
    const { bucket, store } = memoryBucket();
    context.env.FTS_BUCKET = bucket;
    const { durableObject, storage } = context;
    const ref = { tenantId: "user-1", databaseName: "vault" };
    await replicate(durableObject, [leafDoc("h:a", "旧形式の会議メモ"), noteDoc("a.md", "1-a", "a.md", ["h:a"])]);
    await durableObject.alarm();
    storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'fts_rebuild_at'`);
    await durableObject.alarm();
    const fresh = (await readFtsManifest(bucket, ref))!;
    expect(fresh.segments.map((s) => s.format)).toEqual([2]);

    // Replace it with the same content as 0.3.0 wrote it (format 1, no index.bin).
    const hash = await hashText("旧形式の会議メモ");
    const old = await buildIndex([{ path: "a.md", content: "旧形式の会議メモ", hash }], { format: 1 });
    for (const [name, body] of old.files) await bucket.put(`fts/user-1/vault/seg-old/${name}`, body);
    await bucket.put(
      "fts/user-1/vault/manifest.json",
      JSON.stringify({ ...fresh, segments: [{ id: "seg-old", docCount: 1, totalChars: 8, builtAt: 1, hashed: true }] }),
    );
    storage.sql.exec(`UPDATE meta SET value = '2' WHERE key = 'fts_index_version'`);
    storage.sql.exec(`DELETE FROM meta WHERE key = 'fts_rebuild_at'`);

    // The upgraded object arms a pass; the first request schedules its alarm.
    const upgraded = new TestVaultDO({ storage, id: { name: "user-1:vault" } } as unknown as DurableObjectState, context.env);
    vi.mocked(storage.setAlarm).mockClear();
    (upgraded as unknown as { lastIndexScheduleAt: number }).lastIndexScheduleAt = 0;
    await upgraded.fetch(new Request("https://db/_changes?since=0"));
    expect(storage.setAlarm).toHaveBeenCalled();
    await upgraded.alarm();
    const after = (await readFtsManifest(bucket, ref))!;
    expect(after.segments.map((s) => s.format)).toEqual([2]);
    expect(after.segments[0]!.id).not.toBe("seg-old");
    expect(after.retired.map((r) => r.id)).toEqual(["seg-old"]);
    expect(store.has(`fts/user-1/vault/${after.segments[0]!.id}/index.bin`)).toBe(true);
    await upgraded.alarm();
    expect(await json(await internalOp(upgraded, { op: "indexStatus" }))).toMatchObject({
      fts: { pending: 0, rebuildAt: null, error: null },
    });
    const result = await ftsSearch(bucket, ref, "会議メモ", 5);
    expect(result.status === "ready" && result.hits.map((hit) => hit.path)).toEqual(["a.md"]);
  });

  it("drops deleted and changed FTS candidates before their indexing alarm runs", async () => {
    const { durableObject } = await created();
    await replicate(durableObject, [
      noteDoc("gone.md", "1-a", "gone.md", [], { data: "deleted private body" }),
      noteDoc("changed.md", "1-b", "changed.md", [], { data: "old private body" }),
    ]);
    await durableObject.alarm();
    const candidates = [
      { path: "gone.md", hash: await hashText("deleted private body") },
      { path: "changed.md", hash: await hashText("old private body") },
    ];
    await replicate(durableObject, [
      noteDoc("gone.md", "2-c", "gone.md", [], { data: "deleted private body", deleted: true,
        _revisions: { start: 2, ids: ["c", "a"] } }),
      noteDoc("changed.md", "2-d", "changed.md", [], { data: "new body",
        _revisions: { start: 2, ids: ["d", "b"] } }),
    ]);
    await expect(json(await internalOp(durableObject, { op: "resolveFtsHits", candidates, limit: 10 })))
      .resolves.toEqual({ hits: [] });
  });

  it("purge waits for an indexing pass paused in embedding and removes its output", async () => {
    const { durableObject, env, deletedIds, storage } = await created();
    await replicate(durableObject, [leafDoc("h:a", "private body"), noteDoc("secret.md", "1-a", "secret.md", ["h:a"])]);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    env.AI.run.mockImplementationOnce(async (_model: string, input: { text: string[] }) => {
      entered();
      await gate;
      return { data: input.text.map(() => [1, 2]) };
    });
    const indexing = durableObject.alarm();
    await paused;
    const purging = durableObject.fetch(new Request("https://db/internal/purge", {
      method: "POST", headers: { "X-LiveSync-Internal": "test-secret" },
    }));
    resume();
    await indexing;
    expect((await purging).status).toBe(200);
    expect(env.upserted).toHaveLength(1);
    expect(deletedIds).toEqual(env.upserted.map((vector) => vector.id));
    expect(storage.sql.exec("SELECT * FROM index_state").toArray()).toEqual([]);
    expect((await durableObject.fetch(new Request("https://db/", { method: "HEAD" }))).status).toBe(404);
  });

  it("tracks partial vector batches so a later shortening and deletion clean them all", async () => {
    const { durableObject, env, storage } = await created();
    const vectors = new Map<string, VectorizeVector>();
    let batches = 0;
    env.VECTORIZE.upsert.mockImplementation(async (batch: VectorizeVector[]) => {
      if (++batches === 2) throw new Error("second vector batch unavailable");
      for (const vector of batch) vectors.set(vector.id, vector);
    });
    env.VECTORIZE.deleteByIds.mockImplementation(async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
    });
    const content = Array.from({ length: 60 }, (_, index) => `## Section ${index}\n${"body ".repeat(100)}`).join("\n\n");
    await replicate(durableObject, [noteDoc("a.md", "1-a", "a.md", [], { data: content })]);
    await durableObject.alarm();
    expect(vectors.size).toBe(50);
    expect(storage.sql.exec("SELECT hash, chunks, pending FROM index_state WHERE path = 'a.md'").one())
      .toMatchObject({ hash: null, chunks: 60, pending: 1 });
    await replicate(durableObject, [noteDoc("a.md", "2-b", "a.md", [], {
      data: "short body", _revisions: { start: 2, ids: ["b", "a"] },
    })]);
    await durableObject.alarm();
    expect(vectors.size).toBe(1);
    await replicate(durableObject, [{ _id: "a.md", _rev: "3-d", _deleted: true,
      _revisions: { start: 3, ids: ["d", "b", "a"] } }]);
    await durableObject.alarm();
    expect(vectors.size).toBe(0);
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

  it("purge fails and keeps the data when the FTS index cannot be deleted", async () => {
    const context = await created();
    const { durableObject, env } = context;
    await replicate(durableObject, [
      leafDoc("h:a", "content"),
      noteDoc("a.md", "1-a", "a.md", ["h:a"]),
    ]);
    const list = vi.mocked(env.FTS_BUCKET.list);
    list.mockRejectedValue(new Error("R2 unavailable"));
    const res = await durableObject.fetch(
      new Request("https://db/internal/purge", {
        method: "POST",
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    list.mockReset();
    expect(res.status).toBe(500);
    // Nothing was deleted, so a retry can still reach the index and the notes.
    await expect(json(await internalOp(durableObject, { op: "listMarkdownPaths" }))).resolves.toEqual({
      paths: ["a.md"],
    });
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
