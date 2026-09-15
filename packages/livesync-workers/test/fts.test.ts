import { describe, expect, it } from "vitest";
import {
  buildIndex,
  DEFAULT_SHARD_COUNT,
  type FtsDocInput,
} from "../src/search/fts/build.js";
import {
  decodeShard,
  encodeShard,
  gunzip,
  gzip,
  type Posting,
} from "../src/search/fts/codec.js";
import { normalizeText, tokenize } from "../src/search/fts/tokenize.js";
import { extractSnippet, searchIndex } from "../src/search/fts/search.js";

async function search(docs: FtsDocInput[], query: string, limit?: number) {
  const built = await buildIndex(docs);
  return searchIndex(query, {
    shardCount: DEFAULT_SHARD_COUNT,
    fetchFile: (name) => Promise.resolve(built.files.get(name) ?? null),
    ...(limit !== undefined ? { limit } : {}),
  });
}

const paths = (hits: Array<{ path: string }>) => hits.map((hit) => hit.path);

describe("tokenize", () => {
  it("emits bigrams for CJK runs and words for ASCII runs", () => {
    const { chars } = normalizeText("会議室でLiveSyncを使う");
    const tokens = tokenize(chars, "query");
    expect(tokens).toEqual([
      { term: "会議", pos: 0 },
      { term: "議室", pos: 1 },
      { term: "室で", pos: 2 },
      { term: "livesync", pos: 4 },
      { term: "を使", pos: 12 },
      { term: "使う", pos: 13 },
    ]);
  });

  it("adds boundary unigrams only in index mode", () => {
    const { chars } = normalizeText("会議室");
    const queryTerms = tokenize(chars, "query").map((t) => t.term);
    const indexTerms = tokenize(chars, "index").map((t) => t.term);
    expect(queryTerms).toEqual(["会議", "議室"]);
    expect(indexTerms.sort()).toEqual(["会議", "会", "室", "議室"].sort());
  });

  it("normalizes width and case with a usable offset map", () => {
    const original = "ＬｉｖｅＳｙｎｃ設定";
    const { chars, orig } = normalizeText(original);
    expect(chars.join("")).toBe("livesync設定");
    expect(original.slice(orig[8]!)).toBe("設定");
  });
});

describe("codec", () => {
  it("round-trips shard postings through encode/gzip", async () => {
    const postings = new Map<string, Posting[]>([
      ["会議", [{ doc: 0, positions: [0, 5, 130000] }, { doc: 7, positions: [42] }]],
      ["z", [{ doc: 3, positions: [1] }]],
    ]);
    const decoded = decodeShard(await gunzip(await gzip(encodeShard(postings))));
    expect(decoded).toEqual(postings);
  });
});

describe("searchIndex", () => {
  const docs: FtsDocInput[] = [
    { path: "a.md", content: "東京都の会議室を予約した", mtime: 100 },
    { path: "b.md", content: "会議と室内の話。LiveSync の設定メモ", mtime: 200 },
    { path: "c.md", content: "毎年第1回目のイベント", mtime: 300 },
    { path: "d.md", content: "全文検索のメモ。会議室 会議室 会議室", mtime: 400 },
  ];

  it("matches CJK substrings with adjacency verification", async () => {
    expect(paths(await search(docs, "会議室"))).toEqual(["d.md", "a.md"]);
    // Substring semantics: 京都 inside 東京都 is a correct hit.
    expect(paths(await search(docs, "京都"))).toEqual(["a.md"]);
    // 会議…室 without adjacency must not match.
    expect(paths(await search(docs, "議と室"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "都会"))).toEqual([]);
  });

  it("treats ASCII runs as exact words, case- and width-insensitive", async () => {
    expect(paths(await search(docs, "livesync"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "ＬｉｖｅＳｙｎｃ"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "live"))).toEqual([]);
  });

  it("spans word/CJK boundaries via boundary unigrams", async () => {
    expect(paths(await search(docs, "第1回"))).toEqual(["c.md"]);
    expect(paths(await search(docs, "第1回目のイベント"))).toEqual(["c.md"]);
  });

  it("ANDs whitespace-separated phrases", async () => {
    expect(paths(await search(docs, "会議室 予約"))).toEqual(["a.md"]);
    expect(paths(await search(docs, "会議室 存在しない"))).toEqual([]);
  });

  it("ranks more matches higher and reports positions", async () => {
    const hits = await search(docs, "会議室");
    expect(hits[0]!.path).toBe("d.md");
    expect(hits[0]!.matches.length).toBe(3);
    const first = (await search(docs, "会議室"))[1]!;
    expect(first.matches).toEqual([{ pos: 4, len: 3 }]);
  });

  it("returns nothing for empty or separator-only queries", async () => {
    expect(await search(docs, "")).toEqual([]);
    expect(await search(docs, "、。 ・")).toEqual([]);
  });

  it("respects the limit", async () => {
    expect((await search(docs, "の", 1)).length).toBeLessThanOrEqual(1);
  });
});

describe("extractSnippet", () => {
  it("slices the original text around a normalized match position", async () => {
    const content = "前置きの文章。ＬｉｖｅＳｙｎｃ設定はここ。後ろの文章";
    const hits = await search([{ path: "x.md", content }], "livesync設定");
    const snippet = extractSnippet(content, hits[0]!.matches[0]!, 5);
    expect(snippet.match).toBe("ＬｉｖｅＳｙｎｃ設定");
    expect(snippet.before).toBe("きの文章。");
    expect(snippet.after).toBe("はここ。後");
  });
});
