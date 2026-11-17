import type { Embedder } from "../types.js";

export const DEFAULT_WORKERS_AI_EMBEDDING_MODEL = "@cf/google/embeddinggemma-2";
/** Output dimensions of the default model; the Vectorize index must match. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Embedder backed by Workers AI. Other models retain the legacy text/data schema. */
export function workersAiEmbedder(
  ai: Ai,
  model: string = DEFAULT_WORKERS_AI_EMBEDDING_MODEL,
): Embedder {
  const gemma2 = model === DEFAULT_WORKERS_AI_EMBEDDING_MODEL;
  return {
    ...(gemma2 ? { indexVersion: model } : {}),
    async embed(texts, purpose = "document") {
      if (texts.length === 0) return [];
      if (gemma2) {
        // The installed Workers AI types predate this model's OpenAI-style schema.
        const out = await ai.run(model as Parameters<Ai["run"]>[0], {
          input: texts.map((text) => purpose === "query"
            ? `task: search result | query: ${text}`
            : `title: none | text: ${text}`),
          dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
          encoding_format: "float",
        });
        const data = (out as { data?: Array<{ embedding: number[] }> }).data;
        if (!data || data.length !== texts.length || data.some((item) => !Array.isArray(item.embedding))) {
          throw new Error("Embedding model returned invalid data");
        }
        return data.map((item) => item.embedding);
      }
      const out = await ai.run(model as Parameters<Ai["run"]>[0], { text: texts });
      const data = (out as { data?: number[][] }).data;
      if (!data) throw new Error("Embedding model returned no data");
      return data;
    },
  };
}
