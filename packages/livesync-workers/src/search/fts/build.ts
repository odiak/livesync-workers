import { encodeShard, gzip, shardForTerm, type Posting } from "./codec.js";
import { normalizeText, tokenize } from "./tokenize.js";

export const DEFAULT_SHARD_COUNT = 16;

export type FtsDocInput = {
  path: string;
  content: string;
  title?: string;
  mtime?: number;
};

/** Entry in docs.json.gz; the docId is the array index (generation-local). */
export type FtsDocMeta = {
  path: string;
  title?: string;
  /** Normalized char count, used for score normalization and sanity checks. */
  chars: number;
  mtime?: number;
};

export type FtsManifest = {
  version: 1;
  generation: string;
  shardCount: number;
  docCount: number;
  totalChars: number;
  builtAt: number;
};

export type FtsBuildResult = {
  /** Generation-relative name (e.g. "shard-003.bin.gz") to file body. */
  files: Map<string, Uint8Array>;
  docs: FtsDocMeta[];
  stats: { docCount: number; totalChars: number; termCount: number; postingCount: number };
};

export function shardFileName(shard: number): string {
  return `shard-${String(shard).padStart(3, "0")}.bin.gz`;
}

export const DOCS_FILE_NAME = "docs.json.gz";

/**
 * Build a complete index generation in memory. Pure apart from gzip; callers
 * decide the generation id and where the files live (R2, disk, memory).
 */
export async function buildIndex(
  inputs: FtsDocInput[],
  options: { shardCount?: number } = {},
): Promise<FtsBuildResult> {
  const shardCount = options.shardCount ?? DEFAULT_SHARD_COUNT;
  const postingsByTerm = new Map<string, Posting[]>();
  const docs: FtsDocMeta[] = [];
  let totalChars = 0;
  let postingCount = 0;

  for (let docId = 0; docId < inputs.length; docId += 1) {
    const input = inputs[docId]!;
    const { chars } = normalizeText(input.content);
    docs.push({
      path: input.path,
      ...(input.title !== undefined ? { title: input.title } : {}),
      chars: chars.length,
      ...(input.mtime !== undefined ? { mtime: input.mtime } : {}),
    });
    totalChars += chars.length;

    const positionsByTerm = new Map<string, number[]>();
    for (const token of tokenize(chars, "index")) {
      let positions = positionsByTerm.get(token.term);
      if (!positions) {
        positions = [];
        positionsByTerm.set(token.term, positions);
      }
      positions.push(token.pos);
    }
    for (const [term, positions] of positionsByTerm) {
      let postings = postingsByTerm.get(term);
      if (!postings) {
        postings = [];
        postingsByTerm.set(term, postings);
      }
      // Tokens are emitted in ascending position order per mode section, but
      // index-mode boundary unigrams arrive after the bigrams; keep sorted.
      positions.sort((a, b) => a - b);
      postings.push({ doc: docId, positions });
    }
  }

  const shards: Array<Array<[string, Posting[]]>> = Array.from(
    { length: shardCount },
    () => [],
  );
  for (const [term, postings] of postingsByTerm) {
    shards[shardForTerm(term, shardCount)]!.push([term, postings]);
    postingCount += postings.reduce((sum, p) => sum + p.positions.length, 0);
  }

  const files = new Map<string, Uint8Array>();
  for (let shard = 0; shard < shardCount; shard += 1) {
    files.set(shardFileName(shard), await gzip(encodeShard(shards[shard]!)));
  }
  files.set(
    DOCS_FILE_NAME,
    await gzip(new TextEncoder().encode(JSON.stringify({ docs }))),
  );

  return {
    files,
    docs,
    stats: {
      docCount: docs.length,
      totalChars,
      termCount: postingsByTerm.size,
      postingCount,
    },
  };
}
