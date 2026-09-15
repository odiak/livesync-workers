import { chunkMarkdown, hashText } from "./chunk-md.js";
import type { VaultBindings, VaultRef } from "../types.js";
import { vaultObjectName } from "../types.js";

const VECTORIZE_DELETE_BATCH_SIZE = 100;
const VECTORIZE_UPSERT_BATCH_SIZE = 50;
const PREVIEW_MAX_CHARS = 300;
const EMBED_INPUT_MAX_CHARS = 4000;

/** Human-readable snippet stored in vector metadata; chunk text starts with "[path]\n". */
export function chunkPreview(text: string, path: string): string {
  const prefix = `[${path}]\n`;
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return body.trim().slice(0, PREVIEW_MAX_CHARS);
}

export type VectorSearchHit = {
  score: number;
  path: string;
  heading: string;
  textPreview: string;
};

type VectorBindings = Pick<VaultBindings, "vectorize" | "embedder" | "vectorIsolation">;

export async function vectorId(ref: VaultRef, path: string, chunkIndex: number): Promise<string> {
  const digest = await hashText(`${ref.tenantId}\n${ref.databaseName}\n${path}\n${chunkIndex}`);
  return `v1:${digest.slice(0, 60)}`;
}

function isolation(bindings: VectorBindings) {
  return bindings.vectorIsolation ?? "namespace";
}

export async function deleteVectorIds(vectorize: VectorizeIndex, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_BATCH_SIZE) {
    await vectorize.deleteByIds(ids.slice(i, i + VECTORIZE_DELETE_BATCH_SIZE));
  }
}

/**
 * Embed a Markdown note and upsert its chunks into Vectorize. Vectors of
 * chunks beyond the new chunk count (from a previous, longer version) are
 * removed. Returns the number of chunks now indexed for the note.
 */
export async function upsertNoteVectors(
  bindings: VectorBindings,
  input: {
    ref: VaultRef;
    path: string;
    content: string;
    hash: string;
    previousChunks: number;
  },
): Promise<number> {
  const { ref, path, content, hash, previousChunks } = input;
  const chunks = chunkMarkdown(path, content);
  const mtime = Date.now();
  const namespace = isolation(bindings) === "namespace" ? vaultObjectName(ref) : undefined;
  for (let start = 0; start < chunks.length; start += VECTORIZE_UPSERT_BATCH_SIZE) {
    const slice = chunks.slice(start, start + VECTORIZE_UPSERT_BATCH_SIZE);
    const embeddings = await bindings.embedder.embed(
      slice.map((chunk) => chunk.text.slice(0, EMBED_INPUT_MAX_CHARS)),
    );
    const vectors: VectorizeVector[] = [];
    for (let offset = 0; offset < slice.length; offset += 1) {
      const chunkIndex = start + offset;
      vectors.push({
        id: await vectorId(ref, path, chunkIndex),
        values: embeddings[offset]!,
        ...(namespace ? { namespace } : {}),
        metadata: {
          // Legacy key names kept so existing indexes stay valid.
          userId: ref.tenantId,
          vaultId: ref.databaseName,
          origin: "vault",
          path,
          mtime,
          hash,
          heading: slice[offset]!.heading,
          preview: chunkPreview(slice[offset]!.text, path),
        },
      });
    }
    if (vectors.length > 0) await bindings.vectorize.upsert(vectors);
  }

  const stale: string[] = [];
  for (let i = chunks.length; i < previousChunks; i += 1) {
    stale.push(await vectorId(ref, path, i));
  }
  if (stale.length > 0) await deleteVectorIds(bindings.vectorize, stale);
  return chunks.length;
}

export async function removeNoteVectors(
  bindings: VectorBindings,
  input: { ref: VaultRef; path: string; chunks: number },
): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < input.chunks; i += 1) {
    ids.push(await vectorId(input.ref, input.path, i));
  }
  if (ids.length > 0) await deleteVectorIds(bindings.vectorize, ids);
}

export async function vectorSearch(
  bindings: VectorBindings,
  ref: VaultRef,
  query: string,
  topK: number,
): Promise<VectorSearchHit[]> {
  const [qvec] = await bindings.embedder.embed([query.slice(0, EMBED_INPUT_MAX_CHARS)]);
  const namespaced = isolation(bindings) === "namespace";
  // Metadata mode over-fetches: the default namespace may hold other vectors
  // (e.g. a host's memory store), dropped below (returnMetadata "all" caps topK at 20).
  const res = await bindings.vectorize.query(qvec!, {
    topK: Math.min(20, namespaced ? topK : topK + 8),
    returnMetadata: "all",
    ...(namespaced
      ? { namespace: vaultObjectName(ref) }
      : { filter: { userId: { $eq: ref.tenantId } } }),
  });
  return res.matches
    .filter((m) => {
      const md = m.metadata ?? {};
      if (namespaced) return true;
      if (md.origin != null && md.origin !== "vault") return false;
      return md.vaultId == null || md.vaultId === ref.databaseName;
    })
    .slice(0, topK)
    .map((m) => {
      const md = m.metadata ?? {};
      const path = String(md.path ?? "");
      const heading = String(md.heading ?? "");
      const preview = typeof md.preview === "string" ? md.preview : "";
      return {
        score: m.score,
        path,
        heading,
        // Vectors indexed before previews existed fall back to path + heading.
        textPreview: preview || `${path} — ${heading}`,
      };
    });
}
