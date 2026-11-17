import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKERS_AI_EMBEDDING_MODEL, workersAiEmbedder } from "../src/search/embedder.js";

describe("Workers AI embedder", () => {
  it("uses the Gemma 2 schema and distinct document/query task prefixes", async () => {
    const run = vi.fn(async () => ({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] }));
    const embedder = workersAiEmbedder({ run } as unknown as Ai);
    expect(await embedder.embed(["a", "b"])).toEqual([[1, 2], [3, 4]]);
    expect(run).toHaveBeenLastCalledWith(DEFAULT_WORKERS_AI_EMBEDDING_MODEL, {
      input: ["title: none | text: a", "title: none | text: b"], dimensions: 768, encoding_format: "float",
    });
    run.mockResolvedValueOnce({ data: [{ index: 0, embedding: [5, 6] }] });
    expect(await embedder.embed(["find"], "query")).toEqual([[5, 6]]);
    expect(run).toHaveBeenLastCalledWith(DEFAULT_WORKERS_AI_EMBEDDING_MODEL, {
      input: ["task: search result | query: find"], dimensions: 768, encoding_format: "float",
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects missing embeddings before vectors can be written", async () => {
    for (const data of [undefined, [], [[1, 2]], [{}]]) {
      const embedder = workersAiEmbedder({ run: async () => ({ data }) } as unknown as Ai);
      await expect(embedder.embed(["a"])).rejects.toThrow("invalid data");
    }
  });

  it("keeps explicit legacy models compatible", async () => {
    const run = vi.fn(async () => ({ data: [[1, 2]] }));
    const embedder = workersAiEmbedder({ run } as unknown as Ai, "@cf/baai/bge-base-en-v1.5");
    expect(await embedder.embed(["a"])).toEqual([[1, 2]]);
    expect(embedder.indexVersion).toBeUndefined();
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: ["a"] });
  });
});
