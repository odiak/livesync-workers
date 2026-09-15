import type { Embedder } from "../types.js";

export const DEFAULT_WORKERS_AI_EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
/** Output dimensions of the default model; the Vectorize index must match. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Embedder backed by Workers AI. */
export function workersAiEmbedder(
  ai: Ai,
  model: string = DEFAULT_WORKERS_AI_EMBEDDING_MODEL,
): Embedder {
  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const out = await ai.run(model as Parameters<Ai["run"]>[0], { text: texts });
      const data = (out as { data?: number[][] }).data;
      if (!data) throw new Error("Embedding model returned no data");
      return data;
    },
  };
}
