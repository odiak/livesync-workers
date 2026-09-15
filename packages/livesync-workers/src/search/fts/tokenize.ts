/**
 * Tokenizer for the R2 full-text index.
 *
 * Text is normalized per code point (NFKC + lowercase) and split into runs:
 *   - ASCII word runs ([a-z0-9_]) become one exact-match word token
 *   - separator chars (whitespace / punctuation / symbols) are skipped
 *   - everything else (CJK, kana, accented latin, ...) becomes character
 *     bigrams, giving substring semantics without a dictionary
 *
 * Index mode additionally emits unigrams for the first and last char of each
 * non-word run, so phrases spanning a word/CJK boundary ("第1回") stay
 * searchable. Query mode emits only the minimal cover needed to verify a
 * phrase: bigrams for runs of 2+, a unigram only for single-char runs.
 * Consequence: a single-CJK-char query only matches places where that char is
 * adjacent to a word char, separator, or text edge.
 */

export type Token = { term: string; pos: number };

export type NormalizedText = {
  /** Normalized code points (positions in tokens index into this array). */
  chars: string[];
  /** For each normalized char, the code-unit offset in the original string. */
  orig: number[];
};

const WORD_RE = /^[a-z0-9_]$/;
const SEP_RE = /^[\s\p{P}\p{S}\p{C}]$/u;

/**
 * NFKC + lowercase applied per code point so positions map back to the
 * original string (whole-string NFKC could merge across combining sequences,
 * which we accept losing for the sake of a stable offset map).
 */
export function normalizeText(text: string): NormalizedText {
  const chars: string[] = [];
  const orig: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const norm = ch.normalize("NFKC").toLowerCase();
    for (const nc of norm) {
      chars.push(nc);
      orig.push(offset);
    }
    offset += ch.length;
  }
  return { chars, orig };
}

export function tokenize(chars: string[], mode: "index" | "query"): Token[] {
  const tokens: Token[] = [];
  const n = chars.length;
  let i = 0;
  while (i < n) {
    const c = chars[i]!;
    if (WORD_RE.test(c)) {
      let j = i + 1;
      while (j < n && WORD_RE.test(chars[j]!)) j += 1;
      tokens.push({ term: chars.slice(i, j).join(""), pos: i });
      i = j;
    } else if (SEP_RE.test(c)) {
      i += 1;
    } else {
      let j = i + 1;
      while (j < n && !WORD_RE.test(chars[j]!) && !SEP_RE.test(chars[j]!)) j += 1;
      const len = j - i;
      if (len === 1) {
        tokens.push({ term: c, pos: i });
      } else {
        for (let k = i; k < j - 1; k += 1) {
          tokens.push({ term: chars[k]! + chars[k + 1]!, pos: k });
        }
        if (mode === "index") {
          tokens.push({ term: chars[i]!, pos: i });
          tokens.push({ term: chars[j - 1]!, pos: j - 1 });
        }
      }
      i = j;
    }
  }
  return tokens;
}

/** Number of normalized chars a token's term covers in the text. */
export function termCharLength(term: string): number {
  return [...term].length;
}
