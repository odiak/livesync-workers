import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleLiveSyncRequest, splitRevisionBody } from "../src/index.js";
import { TestVaultDO, testBindings, testEnv, testHost } from "./helpers.js";

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

function liveSyncDbForTest(revisionsSchema: "current" | "legacy" | "interrupted" = "current") {
  const database = new DatabaseSync(":memory:");
  if (revisionsSchema !== "current") {
    database.exec(`
      CREATE TABLE revs (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        gen INTEGER NOT NULL,
        parent_rev TEXT,
        body TEXT NOT NULL,
        ${revisionsSchema === "interrupted" ? "body_chunked INTEGER NOT NULL DEFAULT 0, body_available INTEGER NOT NULL DEFAULT 1," : ""}
        deleted INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL,
        rev_history TEXT,
        PRIMARY KEY (id, rev)
      )
    `);
    if (revisionsSchema === "interrupted") {
      database.exec(`
        CREATE TABLE _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (1)
      `);
    }
  }
  const queries: string[] = [];
  const sql = {
    exec<T extends SqliteRow>(query: string, ...bindings: unknown[]) {
      queries.push(query);
      const rows = database.prepare(query).all(...(bindings as never[])) as T[];
      return new TestSqlCursor(rows);
    },
  };
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
  };
  const durableObject = new TestVaultDO({ storage } as unknown as DurableObjectState, testEnv());
  return { database, durableObject, queries, storage };
}

async function liveSyncDbCreated() {
  const context = liveSyncDbForTest();
  await context.durableObject.fetch(new Request("https://db/", { method: "PUT" }));
  return context;
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function replicatedDocs(durableObject: TestVaultDO, docs: unknown[]): Promise<Response> {
  return durableObject.fetch(
    postRequest("https://db/_bulk_docs", { docs, new_edits: false }),
  );
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function envWithStub(
  stub: { fetch: ReturnType<typeof vi.fn> },
  databaseName = "my-vault",
) {
  const idFromName = vi.fn((name: string) => ({ name }));
  const base = testEnv();
  const ref = { tenantId: "user-1", databaseName };
  return {
    idFromName,
    env: {
      host: testHost(base, ref),
      bindings: {
        ...testBindings(base),
        vaultDb: { idFromName, get: vi.fn(() => stub) } as unknown as DurableObjectNamespace,
      },
    },
  };
}

async function requestWithStub(
  request: Request,
  stub: { fetch: ReturnType<typeof vi.fn> },
) {
  const { env } = await envWithStub(stub);
  return handleLiveSyncRequest(request, env);
}

describe("LiveSync worker routing", () => {
  it("answers root health endpoints without auth", async () => {
    const stub = { fetch: vi.fn() };
    const response = await requestWithStub(
      new Request("https://kuro.example/livesync"),
      stub,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      couchdb: "Welcome",
      vendor: { name: "livesync-workers" },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("requires Basic Auth for database requests", async () => {
    const stub = { fetch: vi.fn() };
    const response = await requestWithStub(
      new Request("https://kuro.example/livesync/vault"),
      stub,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("returns the LiveSync CouchDB config object shim", async () => {
    const stub = { fetch: vi.fn() };
    const response = await requestWithStub(
      new Request("https://kuro.example/livesync/_node/_local/_config", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      stub,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chttpd: { require_valid_user: "true" },
      couchdb: { max_document_size: "50000000" },
      cors: {
        credentials: "true",
        origins:
          "app://obsidian.md,capacitor://localhost,http://localhost,https://kuro.example",
      },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("rewrites /livesync/{db} away before dispatching to the user Durable Object", async () => {
    const stub = {
      fetch: vi.fn(async (request: Request) =>
        Response.json({ path: new URL(request.url).pathname }),
      ),
    };
    const { env, idFromName } = await envWithStub(stub);
    const response = await handleLiveSyncRequest(
      new Request("https://kuro.example/livesync/my-vault/_changes", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: "/_changes" });
    expect(idFromName).toHaveBeenCalledWith("user-1:my-vault");
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects databases outside the credential scope", async () => {
    const stub = { fetch: vi.fn() };
    const { env } = await envWithStub(stub, "allowed-vault");
    const response = await handleLiveSyncRequest(
      new Request("https://kuro.example/livesync/other-vault/_changes", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "app://obsidian.md",
    "capacitor://localhost",
    "http://localhost",
  ])("handles CORS preflight from %s", async (origin) => {
    const stub = { fetch: vi.fn() };
    const response = await requestWithStub(
      new Request("https://kuro.example/livesync/vault", {
        method: "OPTIONS",
        headers: { Origin: origin },
      }),
      stub,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "authorization",
    );
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects CORS preflight from unknown browser origins", async () => {
    const stub = { fetch: vi.fn() };
    const response = await requestWithStub(
      new Request("https://kuro.example/livesync/vault", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      stub,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("LiveSync revision body chunking", () => {
  it("keeps bodies at the inline limit and splits larger bodies", () => {
    expect(splitRevisionBody("a".repeat(1_000_000))).toBeNull();
    expect(splitRevisionBody("a".repeat(1_000_001))).not.toBeNull();
  });

  it("does not split a surrogate pair between stored chunks", () => {
    const body = `${"a".repeat(249_999)}😀${"b".repeat(800_000)}`;
    const chunks = splitRevisionBody(body)!;
    const restored = chunks
      .map((chunk) => new TextDecoder().decode(new TextEncoder().encode(chunk)))
      .join("");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.charCodeAt(chunks[0]!.length - 1)).not.toBe(0xd83d);
    expect(restored).toBe(body);
  });

  it("stores and restores a body larger than 2 MB across LiveSync APIs", async () => {
    const { durableObject, queries } = liveSyncDbForTest();
    await durableObject.fetch(new Request("https://db/", { method: "PUT" }));
    const data = "あ😀".repeat(500_000);
    const doc = {
      _id: "large-file",
      _rev: "1-large",
      _revisions: { start: 1, ids: ["large"] },
      path: "attachments/large.bin",
      size: new TextEncoder().encode(data).byteLength,
      mtime: 123456,
      type: "binary",
      data,
    };
    const writeResponse = await durableObject.fetch(
      new Request("https://db/_bulk_docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docs: [doc], new_edits: false }),
      }),
    );
    expect(writeResponse.status).toBe(200);

    queries.length = 0;
    const changesResponse = await durableObject.fetch(
      new Request("https://db/_changes?since=0"),
    );
    expect(changesResponse.status).toBe(200);
    expect(queries.some((query) => query.includes("FROM rev_body_chunks"))).toBe(false);

    const changesWithDocsResponse = await durableObject.fetch(
      new Request("https://db/_changes?since=0&include_docs=true"),
    );
    const changesWithDocs = await changesWithDocsResponse.json() as {
      results: Array<{ doc: { data: string } }>;
    };
    expect(changesWithDocs.results[0]!.doc.data).toBe(data);

    queries.length = 0;
    const filesResponse = await durableObject.fetch(
      new Request("https://db/internal/files", {
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    expect(await filesResponse.json()).toEqual({
      files: [{
        path: "attachments/large.bin",
        size: doc.size,
        mtime: 123456,
        type: "binary",
      }],
    });
    expect(queries.some((query) => query.includes("FROM rev_body_chunks"))).toBe(false);

    const getResponse = await durableObject.fetch(
      new Request("https://db/large-file"),
    );
    expect((await getResponse.json() as { data: string }).data).toBe(data);

    const bulkGetResponse = await durableObject.fetch(
      new Request("https://db/_bulk_get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docs: [{ id: "large-file", rev: "1-large" }] }),
      }),
    );
    const bulkGet = await bulkGetResponse.json() as {
      results: Array<{ docs: Array<{ ok: { data: string } }> }>;
    };
    expect(bulkGet.results[0]!.docs[0]!.ok.data).toBe(data);

    const fileResponse = await durableObject.fetch(
      new Request("https://db/internal/file?path=attachments%2Flarge.bin", {
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    expect(await fileResponse.json()).toEqual({ content: data });

    const purgeResponse = await durableObject.fetch(
      new Request("https://db/internal/purge", {
        method: "POST",
        headers: { "X-LiveSync-Internal": "test-secret" },
      }),
    );
    expect(await purgeResponse.json()).toEqual({ ok: true });
    const missingResponse = await durableObject.fetch(
      new Request("https://db/large-file"),
    );
    expect(missingResponse.status).toBe(404);
  });

  it("migrates an existing revisions table once", () => {
    const { database, storage } = liveSyncDbForTest("legacy");
    new TestVaultDO({ storage } as unknown as DurableObjectState, testEnv());
    const columns = database.prepare(`PRAGMA table_info(revs)`).all() as Array<{
      name: string;
    }>;
    const migrations = database.prepare(
      `SELECT id FROM _sql_schema_migrations ORDER BY id`,
    ).all();

    expect(columns.some((column) => column.name === "body_chunked")).toBe(true);
    expect(columns.some((column) => column.name === "body_available")).toBe(true);
    expect(migrations).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("resumes a migration when the column exists before its migration record", () => {
    const { database } = liveSyncDbForTest("interrupted");

    const columns = database.prepare(`PRAGMA table_info(revs)`).all() as Array<{
      name: string;
    }>;
    const migrations = database.prepare(
      `SELECT id FROM _sql_schema_migrations ORDER BY id`,
    ).all();

    expect(columns.filter((column) => column.name === "body_available")).toHaveLength(1);
    expect(migrations).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("LiveSync CouchDB compatibility", () => {
  for (const style of ["all_docs", "main_only"]) {
    it(`does not skip filtered ${style} changes when the batch limit truncates matches`, async () => {
      const { durableObject } = await liveSyncDbCreated();
      const matching = ["note-0", "note-1", "note-2", "note-3", "note-4"];
      for (const [index, id] of matching.entries()) {
        await replicatedDocs(durableObject, [
          { _id: id, _rev: `1-m${index}`, _revisions: { start: 1, ids: [`m${index}`] }, type: "notes" },
        ]);
        await replicatedDocs(durableObject, [
          { _id: `leaf-${index}`, _rev: `1-l${index}`, _revisions: { start: 1, ids: [`l${index}`] }, type: "leaf" },
        ]);
      }

      const seen: string[] = [];
      let since = 0;
      for (let round = 0; round < 20; round += 1) {
        const response = await durableObject.fetch(
          postRequest("https://db/_changes?limit=2", {
            since,
            style,
            selector: { type: { $ne: "leaf" } },
          }),
        );
        const batch = await response.json() as {
          results: Array<{ id: string }>;
          last_seq: number;
        };
        seen.push(...batch.results.map((row) => row.id));
        since = batch.last_seq;
        if (batch.results.length === 0) break;
      }

      expect(seen.sort()).toEqual(matching);
    });
  }

  it("compares _id ranges by code point instead of locale", async () => {
    const { durableObject } = await liveSyncDbCreated();
    for (const [index, id] of ["Apple", "Banana", "apple"].entries()) {
      await replicatedDocs(durableObject, [
        { _id: id, _rev: `1-c${index}`, _revisions: { start: 1, ids: [`c${index}`] } },
      ]);
    }

    const response = await durableObject.fetch(
      postRequest("https://db/_find", { selector: { _id: { $lt: "a" } } }),
    );
    const found = await response.json() as { docs: Array<{ _id: string }> };

    expect(found.docs.map((doc) => doc._id)).toEqual(["Apple", "Banana"]);
  });

  it("compares astral _id characters by Unicode code point", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "\uE000", _rev: "1-bmp", _revisions: { start: 1, ids: ["bmp"] } },
      { _id: "\u{10000}", _rev: "1-astral", _revisions: { start: 1, ids: ["astral"] } },
    ]);

    const response = await durableObject.fetch(
      postRequest("https://db/_find", { selector: { _id: { $lt: "\u{10000}" } } }),
    );
    const found = await response.json() as { docs: Array<{ _id: string }> };

    expect(found.docs.map((doc) => doc._id)).toEqual(["\uE000"]);
  });

  it("supports the Mango $regex selector operator", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "regex-doc", _rev: "1-r", _revisions: { start: 1, ids: ["r"] }, path: "abc" },
    ]);

    const response = await durableObject.fetch(
      postRequest("https://db/_find", { selector: { path: { $regex: "^a" } } }),
    );

    expect(await response.json()).toMatchObject({ docs: [{ _id: "regex-doc" }] });
  });

  it("treats unknown selector operators as non-matching", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "unknown-doc", _rev: "1-u", _revisions: { start: 1, ids: ["u"] }, path: "abc" },
    ]);

    const response = await durableObject.fetch(
      postRequest("https://db/_find", { selector: { path: { $unknown: true } } }),
    );

    expect(await response.json()).toMatchObject({ docs: [] });
  });

  it("rejects an unparsable selector on _changes", async () => {
    const { durableObject } = await liveSyncDbCreated();
    const response = await durableObject.fetch(
      new Request("https://db/_changes?selector=%7Bnot-json"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("applies a selector passed as a query string", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "keep", _rev: "1-k", _revisions: { start: 1, ids: ["k"] }, type: "notes" },
      { _id: "drop", _rev: "1-d", _revisions: { start: 1, ids: ["d"] }, type: "leaf" },
    ]);

    const selector = encodeURIComponent(JSON.stringify({ type: { $ne: "leaf" } }));
    const response = await durableObject.fetch(
      new Request(`https://db/_changes?since=0&selector=${selector}`),
    );
    const batch = await response.json() as { results: Array<{ id: string }> };

    expect(batch.results.map((row) => row.id)).toEqual(["keep"]);
  });

  it("does not persist _revisions inside a replicated document body", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      {
        _id: "replicated",
        _rev: "2-b",
        _revisions: { start: 2, ids: ["b", "a"] },
        _conflicts: ["2-zzz"],
        value: 1,
      },
    ]);

    const plain = await (await durableObject.fetch(
      new Request("https://db/replicated"),
    )).json() as Record<string, unknown>;
    const withRevs = await (await durableObject.fetch(
      new Request("https://db/replicated?revs=true"),
    )).json() as Record<string, unknown>;

    expect(plain).toEqual({ _id: "replicated", _rev: "2-b", value: 1 });
    expect(withRevs._revisions).toEqual({ start: 2, ids: ["b", "a"] });
  });

  it("recreates a deleted document with a revless PUT", async () => {
    const { durableObject } = await liveSyncDbCreated();
    const created = await (await durableObject.fetch(
      new Request("https://db/revived", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      }),
    )).json() as { rev: string };
    const deleted = await (await durableObject.fetch(
      new Request(`https://db/revived?rev=${created.rev}`, { method: "DELETE" }),
    )).json() as { rev: string };

    const missing = await durableObject.fetch(new Request("https://db/revived"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ reason: "deleted" });

    const recreated = await durableObject.fetch(
      new Request("https://db/revived", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 2 }),
      }),
    );
    const revived = await recreated.json() as { ok: boolean; rev: string };

    expect(recreated.status).toBe(200);
    expect(deleted.rev.startsWith("2-")).toBe(true);
    expect(revived.rev.startsWith("3-")).toBe(true);
    await expect(
      (await durableObject.fetch(new Request("https://db/revived"))).json(),
    ).resolves.toMatchObject({ value: 2 });
  });

  it("hides deleted documents from _all_docs and honours key ranges", async () => {
    const { durableObject } = await liveSyncDbCreated();
    for (const id of ["doc-a", "doc-b", "doc-c", "doc-d"]) {
      await durableObject.fetch(
        new Request(`https://db/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: id }),
        }),
      );
    }
    const current = await (await durableObject.fetch(
      new Request("https://db/doc-c"),
    )).json() as { _rev: string };
    await durableObject.fetch(
      new Request(`https://db/doc-c?rev=${current._rev}`, { method: "DELETE" }),
    );

    const all = await (await durableObject.fetch(
      new Request("https://db/_all_docs"),
    )).json() as { total_rows: number; rows: Array<{ id: string }> };
    expect(all.total_rows).toBe(3);
    expect(all.rows.map((row) => row.id)).toEqual(["doc-a", "doc-b", "doc-d"]);

    const ranged = await (await durableObject.fetch(
      new Request('https://db/_all_docs?startkey="doc-b"&endkey="doc-d"&limit=2'),
    )).json() as { rows: Array<{ id: string }> };
    expect(ranged.rows.map((row) => row.id)).toEqual(["doc-b", "doc-d"]);

    const keyed = await (await durableObject.fetch(
      postRequest("https://db/_all_docs?include_docs=true", { keys: ["doc-c", "doc-a"] }),
    )).json() as { rows: Array<{ id: string; value: { deleted?: boolean }; doc: unknown }> };
    expect(keyed.rows[0]!.value.deleted).toBe(true);
    expect(keyed.rows[0]!.doc).toBeNull();
    expect(keyed.rows[1]!.doc).toMatchObject({ value: "doc-a" });
  });

  it("rejects creating a database twice", async () => {
    const { durableObject } = await liveSyncDbCreated();
    const response = await durableObject.fetch(
      new Request("https://db/", { method: "PUT" }),
    );

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({ error: "file_exists" });
  });

  it("returns descendant leaves for latest=true lookups", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "chain", _rev: "1-a", _revisions: { start: 1, ids: ["a"] }, value: 1 },
      { _id: "chain", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, value: 2 },
    ]);

    const bulk = await (await durableObject.fetch(
      postRequest("https://db/_bulk_get", {
        latest: true,
        docs: [{ id: "chain", rev: "1-a" }],
      }),
    )).json() as { results: Array<{ docs: Array<{ ok: { _rev: string } }> }> };
    expect(bulk.results[0]!.docs.map((entry) => entry.ok._rev)).toEqual(["2-b"]);

    const open = await (await durableObject.fetch(
      new Request('https://db/chain?open_revs=["1-a"]&latest=true'),
    )).json() as Array<{ ok: { _rev: string } }>;
    expect(open.map((entry) => entry.ok._rev)).toEqual(["2-b"]);

    const exact = await (await durableObject.fetch(
      postRequest("https://db/_bulk_get", { docs: [{ id: "chain", rev: "1-a" }] }),
    )).json() as { results: Array<{ docs: Array<{ ok: { _rev: string } }> }> };
    expect(exact.results[0]!.docs.map((entry) => entry.ok._rev)).toEqual(["1-a"]);
  });

  it("reclaims non-leaf revision bodies on _compact", async () => {
    const { durableObject, database } = await liveSyncDbCreated();
    const data = "x".repeat(1_100_000);
    await replicatedDocs(durableObject, [
      { _id: "chain", _rev: "1-a", _revisions: { start: 1, ids: ["a"] }, value: 1 },
      { _id: "chain", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, value: 2 },
      { _id: "big", _rev: "1-a", _revisions: { start: 1, ids: ["a"] }, data },
      { _id: "big", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, value: "small" },
    ]);

    const compact = await durableObject.fetch(
      new Request("https://db/_compact", { method: "POST" }),
    );
    expect(compact.status).toBe(202);
    await expect(compact.json()).resolves.toEqual({ ok: true });

    const bodies = database.prepare(
      `SELECT id, rev, body, body_chunked FROM revs ORDER BY id, rev`,
    ).all() as Array<{ id: string; rev: string; body: string; body_chunked: number }>;
    expect(bodies.filter((row) => row.rev === "1-a").every((row) => row.body === "{}")).toBe(true);
    expect(bodies.filter((row) => row.rev === "1-a").every((row) => row.body_chunked === 0)).toBe(true);
    expect(bodies.filter((row) => row.rev === "2-b").every((row) => row.body !== "{}")).toBe(true);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM rev_body_chunks`).all()).toEqual([
      { count: 0 },
    ]);

    await expect(
      (await durableObject.fetch(new Request("https://db/chain"))).json(),
    ).resolves.toMatchObject({ _rev: "2-b", value: 2 });

    const compactedRevision = await durableObject.fetch(
      new Request("https://db/chain?rev=1-a"),
    );
    expect(compactedRevision.status).toBe(404);

    const openCompacted = await (await durableObject.fetch(
      new Request('https://db/chain?open_revs=["1-a"]'),
    )).json();
    expect(openCompacted).toEqual([{ missing: "1-a" }]);

    const latest = await (await durableObject.fetch(
      new Request('https://db/chain?open_revs=["1-a"]&latest=true'),
    )).json() as Array<{ ok: { _rev: string } }>;
    expect(latest.map((entry) => entry.ok._rev)).toEqual(["2-b"]);

    const bulkCompacted = await (await durableObject.fetch(
      postRequest("https://db/_bulk_get", { docs: [{ id: "chain", rev: "1-a" }] }),
    )).json() as { results: Array<{ docs: unknown[] }> };
    expect(bulkCompacted.results[0]!.docs).toEqual([
      { error: { id: "chain", rev: "1-a", error: "not_found", reason: "missing" } },
    ]);

    const diff = await (await durableObject.fetch(
      postRequest("https://db/_revs_diff", { chain: ["1-a", "2-b", "3-c"] }),
    )).json() as Record<string, { missing: string[] }>;
    expect(diff).toEqual({ chain: { missing: ["3-c"] } });

    const changes = await (await durableObject.fetch(
      new Request("https://db/_changes?since=0"),
    )).json() as { results: Array<{ id: string }> };
    expect(changes.results.map((row) => row.id).sort()).toEqual(["big", "chain"]);
  });

  it("keeps the winning revision visible in main_only changes after _compact", async () => {
    const { durableObject } = await liveSyncDbCreated();
    await replicatedDocs(durableObject, [
      { _id: "conflict", _rev: "1-root", _revisions: { start: 1, ids: ["root"] }, value: "root" },
      { _id: "conflict", _rev: "2-z-winner", _revisions: { start: 2, ids: ["z-winner", "root"] }, value: "winner" },
      { _id: "conflict", _rev: "2-a-loser", _revisions: { start: 2, ids: ["a-loser", "root"] }, value: "loser" },
    ]);

    await durableObject.fetch(new Request("https://db/_compact", { method: "POST" }));

    const changes = await (await durableObject.fetch(
      new Request("https://db/_changes?since=0&include_docs=true"),
    )).json() as {
      results: Array<{ id: string; changes: Array<{ rev: string }>; doc: { value: string } }>;
    };
    expect(changes.results).toHaveLength(1);
    expect(changes.results[0]).toMatchObject({
      id: "conflict",
      changes: [{ rev: "2-z-winner" }],
      doc: { value: "winner" },
    });
  });
});

describe("LiveSync change waiting", () => {
  it("answers a longpoll _changes immediately in the Durable Object and flags idleness", async () => {
    const { durableObject } = await liveSyncDbCreated();

    const started = Date.now();
    const idle = await durableObject.fetch(
      new Request("https://db/_changes?feed=longpoll&since=0&timeout=5000"),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(idle.status).toBe(200);
    expect(idle.headers.get("X-LiveSync-Changes-Idle")).toBe("1");
    await expect(idle.json()).resolves.toEqual({ results: [], last_seq: 0, pending: 0 });

    await replicatedDocs(durableObject, [{ _id: "note", _rev: "1-a", value: 1 }]);
    const busy = await durableObject.fetch(
      new Request("https://db/_changes?feed=longpoll&since=0"),
    );
    expect(busy.headers.get("X-LiveSync-Changes-Idle")).toBeNull();
    const body = (await busy.json()) as { results: unknown[]; last_seq: number };
    expect(body.results).toHaveLength(1);
    expect(body.last_seq).toBe(1);
  });

  it("notifies Worker-held watcher sockets on write", async () => {
    const context = liveSyncDbForTest();
    const sent: string[] = [];
    const socket = { send: (message: string) => sent.push(message) };
    const ctx = context.durableObject as unknown as { ctx: Record<string, unknown> };
    ctx.ctx.getWebSockets = () => [socket];
    await context.durableObject.fetch(new Request("https://db/", { method: "PUT" }));

    await replicatedDocs(context.durableObject, [{ _id: "note", _rev: "1-a", value: 1 }]);

    expect(sent.map((message) => JSON.parse(message))).toEqual([{ type: "change", seq: 1 }]);
  });

  it("waits in the Worker for a change notification, then re-asks the object", async () => {
    type Listener = (event: unknown) => void;
    const listeners = new Map<string, Listener[]>();
    const fakeSocket = {
      accept: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, listener: Listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    };
    let changesCalls = 0;
    const calls: string[] = [];
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        calls.push(url.pathname);
        if (url.pathname === "/internal/watch") {
          expect(request.headers.get("Upgrade")).toBe("websocket");
          return { status: 101, webSocket: fakeSocket };
        }
        expect(url.pathname).toBe("/_changes");
        expect(url.searchParams.get("feed")).toBe("normal");
        changesCalls += 1;
        if (changesCalls === 1) {
          // "now" is resolved by the object; the re-ask must use that seq.
          expect(url.searchParams.get("since")).toBe("now");
          setTimeout(() => {
            for (const listener of listeners.get("message") ?? []) listener({ data: "{}" });
          }, 20);
          return Response.json(
            { results: [], last_seq: 7, pending: 0 },
            { headers: { "X-LiveSync-Changes-Idle": "1" } },
          );
        }
        expect(url.searchParams.get("since")).toBe("7");
        return Response.json({ results: [{ seq: 8, id: "note" }], last_seq: 8, pending: 0 });
      }),
    };
    const { env } = await envWithStub(stub);

    const response = await handleLiveSyncRequest(
      new Request("https://kuro.example/livesync/my-vault/_changes?feed=longpoll&since=now&timeout=20000", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-LiveSync-Changes-Idle")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      results: [{ seq: 8, id: "note" }],
      last_seq: 8,
      pending: 0,
    });
    expect(calls).toEqual(["/internal/watch", "/_changes", "/_changes"]);
    expect(fakeSocket.accept).toHaveBeenCalledTimes(1);
    expect(fakeSocket.close).toHaveBeenCalledTimes(1);
  });

  it("returns the empty longpoll answer once the timeout elapses without changes", async () => {
    const fakeSocket = { accept: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/internal/watch") return { status: 101, webSocket: fakeSocket };
        return Response.json(
          { results: [], last_seq: 3, pending: 0 },
          { headers: { "X-LiveSync-Changes-Idle": "1" } },
        );
      }),
    };
    const { env } = await envWithStub(stub);

    const started = Date.now();
    const response = await handleLiveSyncRequest(
      new Request("https://kuro.example/livesync/my-vault/_changes?feed=longpoll&since=3&timeout=1000", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      env,
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    await expect(response.json()).resolves.toEqual({ results: [], last_seq: 3, pending: 0 });
    expect(stub.fetch).toHaveBeenCalledTimes(2);
    expect(fakeSocket.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the object's error status for a continuous feed instead of streaming it", async () => {
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/internal/watch") throw new Error("must not subscribe before first batch");
        return Response.json({ error: "bad_request", reason: "Invalid selector." }, { status: 400 });
      }),
    };
    const { env } = await envWithStub(stub);

    const response = await handleLiveSyncRequest(
      new Request("https://kuro.example/livesync/my-vault/_changes?feed=continuous&selector=%7Bnot-json", {
        headers: { Authorization: basic("sync-user", "sync-pass") },
      }),
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request", reason: "Invalid selector." });
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});
