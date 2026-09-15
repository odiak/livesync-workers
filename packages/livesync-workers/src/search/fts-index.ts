/**
 * R2-backed full-text index (see ./fts/). Index generations are immutable
 * file sets under fts/{tenantId}/{databaseName}/{generation}/; the manifest
 * points at the live generation and is swapped atomically. The previous
 * generation is retained one rebuild so in-flight searches that already read
 * the old manifest can still finish.
 */

import { buildIndex, type FtsDocInput, type FtsManifest } from "./fts/build.js";
import { searchIndex, type SearchHit } from "./fts/search.js";
import type { VaultRef } from "../types.js";

export const FTS_SHARD_COUNT = 16;

function basePrefix(ref: VaultRef): string {
  return `fts/${ref.tenantId}/${ref.databaseName}`;
}

function manifestKey(ref: VaultRef): string {
  return `${basePrefix(ref)}/manifest.json`;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Crash-surviving progress marker (R2 writes are not rolled back when a DO
 * event dies, unlike its SQLite writes). After a CPU-limit reset, this shows
 * the last phase the rebuild completed.
 */
export async function markFtsPhase(
  bucket: R2Bucket,
  ref: VaultRef,
  phase: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await bucket
    .put(`${basePrefix(ref)}/debug.json`, JSON.stringify({ phase, at: Date.now(), ...extra }), {
      httpMetadata: { contentType: "application/json" },
    })
    .catch((error) => console.warn("FTS debug marker write failed", error));
}

export async function readFtsPhase(
  bucket: R2Bucket,
  ref: VaultRef,
): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(`${basePrefix(ref)}/debug.json`);
  if (!object) return null;
  try {
    return (await object.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function rebuildFtsIndex(
  bucket: R2Bucket,
  ref: VaultRef,
  docs: FtsDocInput[],
  options: { previousGeneration?: string | null } = {},
): Promise<FtsManifest> {
  const built = await buildIndex(docs, { shardCount: FTS_SHARD_COUNT });
  await markFtsPhase(bucket, ref, "build-done", {
    docCount: built.stats.docCount,
    termCount: built.stats.termCount,
  });
  const generation = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const base = basePrefix(ref);

  for (const [name, body] of built.files) {
    await bucket.put(`${base}/${generation}/${name}`, body);
  }
  await markFtsPhase(bucket, ref, "upload-done", { generation });
  const manifest: FtsManifest = {
    version: 1,
    generation,
    shardCount: FTS_SHARD_COUNT,
    docCount: built.stats.docCount,
    totalChars: built.stats.totalChars,
    builtAt: Date.now(),
  };
  await bucket.put(manifestKey(ref), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });

  const keep = new Set([generation, options.previousGeneration].filter((g): g is string => !!g));
  const stale = (await listAllKeys(bucket, `${base}/`)).filter((key) => {
    const rest = key.slice(base.length + 1);
    const gen = rest.slice(0, rest.indexOf("/"));
    return rest.includes("/") && !keep.has(gen);
  });
  for (let i = 0; i < stale.length; i += 1000) {
    await bucket.delete(stale.slice(i, i + 1000));
  }
  await markFtsPhase(bucket, ref, "rebuild-complete", { generation });
  return manifest;
}

export async function deleteFtsIndex(bucket: R2Bucket, ref: VaultRef): Promise<void> {
  const keys = await listAllKeys(bucket, `${basePrefix(ref)}/`);
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

export type FtsSearchResult =
  | { status: "ready"; manifest: FtsManifest; hits: SearchHit[] }
  | { status: "not-built" };

export async function ftsSearch(
  bucket: R2Bucket,
  ref: VaultRef,
  query: string,
  limit: number,
): Promise<FtsSearchResult> {
  const manifestObject = await bucket.get(manifestKey(ref));
  if (!manifestObject) return { status: "not-built" };
  const manifest = (await manifestObject.json()) as FtsManifest;
  const base = basePrefix(ref);
  const hits = await searchIndex(query, {
    shardCount: manifest.shardCount,
    fetchFile: async (name) => {
      const object = await bucket.get(`${base}/${manifest.generation}/${name}`);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    limit,
  });
  return { status: "ready", manifest, hits };
}
