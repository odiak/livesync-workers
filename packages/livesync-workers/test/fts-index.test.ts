import { describe, expect, it } from "vitest";
import { ftsSearch, rebuildFtsIndex } from "../src/search/fts-index.js";

/** Minimal in-memory stand-in for the FTS_BUCKET R2 binding. */
function memoryBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, body: Uint8Array | string) {
      store.set(
        key,
        typeof body === "string" ? new TextEncoder().encode(body) : body,
      );
    },
    async get(key: string) {
      const body = store.get(key);
      if (!body) return null;
      return {
        arrayBuffer: async () => body.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(body)),
      };
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys: string[]) {
      for (const key of keys) store.delete(key);
    },
  };
  return { bucket, store };
}

const docs = [
  { path: "a.md", content: "京都の会議メモ", mtime: 1 },
  { path: "b.md", content: "検索エンジンの実験", mtime: 2 },
];

describe("fts-index service", () => {
  it("builds, searches, and swaps generations with one-generation retention", async () => {
    const { bucket, store } = memoryBucket();

    expect(await ftsSearch(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, "会議", 10)).toEqual({
      status: "not-built",
    });

    const first = await rebuildFtsIndex(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, docs);
    const ready = await ftsSearch(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, "会議", 10);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("unreachable");
    expect(ready.hits.map((hit) => hit.path)).toEqual(["a.md"]);
    expect(ready.manifest.docCount).toBe(2);

    const second = await rebuildFtsIndex(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, docs.slice(1), {
      previousGeneration: first.generation,
    });
    const third = await rebuildFtsIndex(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, docs, {
      previousGeneration: second.generation,
    });
    const generations = new Set(
      [...store.keys()]
        .filter(
          (key) =>
            key.includes("/") &&
            !key.endsWith("manifest.json") &&
            !key.endsWith("debug.json"),
        )
        .map((key) => key.split("/")[3]),
    );
    // The first generation is gone; the previous and current remain.
    expect(generations).toEqual(new Set([second.generation, third.generation]));

    const after = await ftsSearch(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, "会議", 10);
    expect(after.status).toBe("ready");
    if (after.status !== "ready") throw new Error("unreachable");
    expect(after.manifest.generation).toBe(third.generation);
    expect(after.hits.map((hit) => hit.path)).toEqual(["a.md"]);
  });

  it("keeps user and vault namespaces separate", async () => {
    const { bucket } = memoryBucket();
    await rebuildFtsIndex(bucket as unknown as R2Bucket, { tenantId: "u1", databaseName: "v1" }, docs);
    expect(await ftsSearch(bucket as unknown as R2Bucket, { tenantId: "u2", databaseName: "v1" }, "会議", 10)).toEqual({
      status: "not-built",
    });
  });
});
