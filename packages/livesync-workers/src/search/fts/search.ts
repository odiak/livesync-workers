import { decodeShard, gunzip, shardForTerm, type Posting } from "./codec.js";
import {
  normalizeText,
  termCharLength,
  tokenize,
  type Token,
} from "./tokenize.js";
import { DOCS_FILE_NAME, shardFileName, type FtsDocMeta } from "./build.js";

/** Fetch a generation-relative file ("shard-003.bin.gz"); null if missing. */
export type FetchGenerationFile = (name: string) => Promise<Uint8Array | null>;

export type SearchMatch = {
  /** Match start, as an index into the doc's normalized code points. */
  pos: number;
  /** Match length in normalized code points. */
  len: number;
};

export type SearchHit = {
  doc: number;
  path: string;
  title?: string;
  mtime?: number;
  score: number;
  matches: SearchMatch[];
};

type Phrase = {
  tokens: Token[];
  /** Token positions relative to the first token. */
  basePos: number;
  matchLen: number;
};

function parsePhrases(query: string): Phrase[] {
  const phrases: Phrase[] = [];
  for (const part of query.split(/\s+/)) {
    if (!part) continue;
    const { chars } = normalizeText(part);
    const tokens = tokenize(chars, "query");
    if (tokens.length === 0) continue;
    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;
    phrases.push({
      tokens,
      basePos: first.pos,
      matchLen: last.pos + termCharLength(last.term) - first.pos,
    });
  }
  return phrases;
}

function postingsSize(postings: Posting[]): number {
  return postings.reduce((sum, p) => sum + p.positions.length, 0);
}

/**
 * Whitespace-separated phrases are ANDed; each phrase is an exact substring
 * match (CJK) / exact word match (ASCII), verified through token positions.
 */
export async function searchIndex(
  query: string,
  options: {
    shardCount: number;
    fetchFile: FetchGenerationFile;
    limit?: number;
    maxMatchesPerDoc?: number;
  },
): Promise<SearchHit[]> {
  const { shardCount, fetchFile } = options;
  const limit = options.limit ?? 20;
  const maxMatchesPerDoc = options.maxMatchesPerDoc ?? 20;

  const phrases = parsePhrases(query);
  if (phrases.length === 0) return [];

  const terms = new Set<string>();
  for (const phrase of phrases) {
    for (const token of phrase.tokens) terms.add(token.term);
  }
  const shardIds = new Set<number>();
  for (const term of terms) shardIds.add(shardForTerm(term, shardCount));

  const [docsRaw, ...shardBodies] = await Promise.all([
    fetchFile(DOCS_FILE_NAME),
    ...[...shardIds].map((shard) => fetchFile(shardFileName(shard))),
  ]);
  if (!docsRaw) throw new Error("FTS index docs file is missing");
  const docs = (
    JSON.parse(new TextDecoder().decode(await gunzip(docsRaw))) as {
      docs: FtsDocMeta[];
    }
  ).docs;

  const termPostings = new Map<string, Posting[]>();
  const shardList = [...shardIds];
  for (let i = 0; i < shardList.length; i += 1) {
    const body = shardBodies[i];
    const decoded = body ? decodeShard(await gunzip(body)) : new Map<string, Posting[]>();
    for (const term of terms) {
      if (shardForTerm(term, shardCount) !== shardList[i]) continue;
      termPostings.set(term, decoded.get(term) ?? []);
    }
  }

  // Verified match start positions per doc, per phrase.
  const phraseMatches: Array<Map<number, number[]>> = [];
  for (const phrase of phrases) {
    const ordered = [...phrase.tokens].sort(
      (a, b) =>
        postingsSize(termPostings.get(a.term) ?? []) -
        postingsSize(termPostings.get(b.term) ?? []),
    );
    if (ordered.some((token) => (termPostings.get(token.term) ?? []).length === 0)) {
      return []; // AND semantics: one impossible phrase empties the result.
    }
    const positionsByDoc = ordered.map((token) => {
      const byDoc = new Map<number, number[]>();
      for (const posting of termPostings.get(token.term)!) {
        byDoc.set(posting.doc, posting.positions);
      }
      return byDoc;
    });
    const matches = new Map<number, number[]>();
    const rarest = ordered[0]!;
    for (const [doc, rarestPositions] of positionsByDoc[0]!) {
      let bases: number[] | null = rarestPositions.map(
        (pos) => pos - (rarest.pos - phrase.basePos),
      );
      for (let t = 1; t < ordered.length && bases.length > 0; t += 1) {
        const positions = positionsByDoc[t]!.get(doc);
        if (!positions) {
          bases = null;
          break;
        }
        const set = new Set(positions);
        const rel = ordered[t]!.pos - phrase.basePos;
        bases = bases.filter((base) => set.has(base + rel));
      }
      if (bases && bases.length > 0) matches.set(doc, bases.sort((a, b) => a - b));
    }
    if (matches.size === 0) return [];
    phraseMatches.push(matches);
  }

  const hits: SearchHit[] = [];
  outer: for (const [doc, firstBases] of phraseMatches[0]!) {
    const allMatches: SearchMatch[] = firstBases.map((pos) => ({
      pos,
      len: phrases[0]!.matchLen,
    }));
    let score = firstBases.length;
    for (let p = 1; p < phraseMatches.length; p += 1) {
      const bases = phraseMatches[p]!.get(doc);
      if (!bases) continue outer;
      score += bases.length;
      for (const pos of bases) allMatches.push({ pos, len: phrases[p]!.matchLen });
    }
    const meta = docs[doc];
    if (!meta) continue;
    allMatches.sort((a, b) => a.pos - b.pos);
    hits.push({
      doc,
      path: meta.path,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
      score: score / Math.log2(4 + meta.chars),
      matches: allMatches.slice(0, maxMatchesPerDoc),
    });
  }

  hits.sort((a, b) => b.score - a.score || (b.mtime ?? 0) - (a.mtime ?? 0));
  return hits.slice(0, limit);
}

export type Snippet = { before: string; match: string; after: string };

/**
 * Slice a snippet out of the original document text for a match whose
 * position refers to normalized code points. Positions can drift if the doc
 * changed after the index generation was built; the slice is best-effort.
 */
export function extractSnippet(
  content: string,
  match: SearchMatch,
  context = 40,
): Snippet {
  const { chars, orig } = normalizeText(content);
  const at = (index: number): number => {
    if (index <= 0) return 0;
    if (index >= chars.length) return content.length;
    return orig[index]!;
  };
  const start = Math.max(0, match.pos - context);
  const end = Math.min(chars.length, match.pos + match.len + context);
  return {
    before: content.slice(at(start), at(match.pos)),
    match: content.slice(at(match.pos), at(match.pos + match.len)),
    after: content.slice(at(match.pos + match.len), at(end)),
  };
}
