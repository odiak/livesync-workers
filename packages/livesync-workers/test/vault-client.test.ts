import { describe, expect, it, vi } from "vitest";
import { createVault, type VaultBindings } from "../src/index.js";
import { memoryBucket, testBindings, testEnv, TEST_SECRET } from "./helpers.js";
import { appendFtsSegment } from "../src/search/fts-index.js";
import { hashText } from "../src/search/chunk-md.js";
import { isReservedPath } from "../src/types.js";

function vaultWith(
  response: Response | Response[],
  options: { searchHits?: unknown[]; restricted?: boolean } = {},
) {
  const env = testEnv();
  env.VECTORIZE.query.mockImplementation(async () => ({
    matches: (options.searchHits ?? []).map((hit) => ({ score: 1, metadata: hit })),
  }));
  const responses = Array.isArray(response) ? [...response] : [response];
  const fetch = vi.fn(async (_request: Request) => responses.shift() ?? Response.json({}));
  const idFromName = vi.fn((name: string) => name);
  const bindings: VaultBindings = {
    ...testBindings(env),
    vaultDb: { idFromName, get: vi.fn(() => ({ fetch })) } as unknown as DurableObjectNamespace,
  };
  const vault = createVault(bindings, {
    ref: { tenantId: "user-1", databaseName: "notes-test" },
    policy: { reservedPaths: [".kuro"], excludedFolders: [], timeZone: "UTC" },
    internalSecret: TEST_SECRET,
  });
  return { vault, fetch, idFromName };
}

describe("Vault.writeNote", () => {
  it("writes notes through the vault's durable object", async () => {
    const { vault, fetch, idFromName } = vaultWith(
      Response.json({ ok: true, path: "2026-06-03.md" }),
    );

    await expect(vault.writeNote("2026-06-03.md", "updated", "base-hash")).resolves.toEqual({
      ok: true,
      path: "2026-06-03.md",
    });

    expect(idFromName).toHaveBeenCalledWith("user-1:notes-test");
    const request = fetch.mock.calls[0]![0];
    expect(request.url).toBe("https://livesync-db/internal/op");
    expect(request.headers.get("X-LiveSync-Internal")).toBe(TEST_SECRET);
    await expect(request.json()).resolves.toMatchObject({
      op: "writeNote",
      path: "2026-06-03.md",
      content: "updated",
      expectedBaseHash: "base-hash",
    });
  });

  it("maps write conflicts", async () => {
    const { vault } = vaultWith(
      Response.json({ error: "CONFLICT", path: "2026-06-03.md" }, { status: 409 }),
    );
    await expect(vault.writeNote("2026-06-03.md", "updated", "base-hash")).resolves.toEqual({
      ok: false,
      error: "CONFLICT",
      path: "2026-06-03.md",
    });
  });

  it("refuses writes into reserved paths", async () => {
    const { vault, fetch } = vaultWith([]);
    await expect(vault.writeNote(".kuro/MEMORY.md", "x", "")).resolves.toEqual({
      ok: false,
      error: "FORBIDDEN_PATH",
      path: ".kuro/MEMORY.md",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Vault reserved paths", () => {
  it("hides reserved notes from markdown listings", async () => {
    const { vault } = vaultWith(
      Response.json({ paths: ["Daily/2026-06-03.md", ".kuro/MEMORY.md"] }),
    );
    await expect(vault.listMarkdownPaths()).resolves.toEqual(["Daily/2026-06-03.md"]);
  });

  it("hides reserved notes from search results", async () => {
    const { vault } = vaultWith(Response.json({ contents: {
      "Daily/2026-06-03.md": "- [ ] 牛乳を買う",
      "Daily/2026-06-02.md": "Log",
    } }), {
      searchHits: [
        { path: ".kuro/MEMORY.md", heading: "" },
        { path: "Daily/2026-06-03.md", heading: "Todo", preview: "- [ ] 牛乳を買う" },
        { path: "Daily/2026-06-02.md", heading: "Log" },
      ],
    });

    await expect(vault.search("query", 8)).resolves.toEqual([
      { score: 1, path: "Daily/2026-06-03.md", heading: "Todo", textPreview: "- [ ] 牛乳を買う" },
      // Vectors indexed before previews existed fall back to path + heading.
      { score: 1, path: "Daily/2026-06-02.md", heading: "Log", textPreview: "Daily/2026-06-02.md — Log" },
    ]);
  });

  it("hides reserved notes from note stats", async () => {
    const { vault } = vaultWith(
      Response.json({
        files: [
          { path: "Daily/2026-06-03.md", mtime: 1000, size: 42 },
          { path: ".kuro/MEMORY.md", mtime: 2000, size: 10 },
        ],
      }),
    );
    await expect(vault.listNoteStats()).resolves.toEqual([
      { path: "Daily/2026-06-03.md", mtime: 1000, size: 42 },
    ]);
  });

  it("lists and reads attachments as bytes, hiding reserved paths", async () => {
    const { vault, fetch } = vaultWith([
      Response.json({
        files: [
          { path: "images/a.png", mtime: 1000, size: 3 },
          { path: ".kuro/secret.png", mtime: 2000, size: 3 },
        ],
      }),
      new Response(new Uint8Array([1, 2, 3])),
      Response.json({ error: "not_found" }, { status: 404 }),
    ]);
    await expect(vault.listFileStats()).resolves.toEqual([
      { path: "images/a.png", mtime: 1000, size: 3 },
    ]);
    await expect(vault.readFile("images/a.png")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(vault.readFile("images/missing.png")).resolves.toBe(null);
    await expect(vault.readFile(".kuro/secret.png")).resolves.toBe(null);
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(fetch.mock.calls[1]![0].json()).resolves.toEqual({ op: "readFile", path: "images/a.png" });
  });

  it("blocks reserved notes from reads unless unrestricted", async () => {
    const { vault } = vaultWith(Response.json({ content: "# Memory" }));
    await expect(vault.readNote(".kuro/MEMORY.md")).resolves.toBe(null);
    await expect(vault.unrestricted().readNote(".kuro/MEMORY.md")).resolves.toBe("# Memory");
  });

  it("refuses the hidden-file-sync alias of any path", async () => {
    const { vault, fetch } = vaultWith(Response.json({ content: "# Memory" }));
    await expect(vault.readNote("i:.kuro/MEMORY.md")).resolves.toBe(null);
    await expect(vault.readFile("i:.kuro/secret.png")).resolves.toBe(null);
    await expect(vault.writeNote("i:.kuro/MEMORY.md", "x", "")).resolves.toMatchObject({
      ok: false,
      error: "FORBIDDEN_PATH",
    });
    await expect(vault.readNotes(["i:.kuro/MEMORY.md", "i:.obsidian/plugins/x/readme.md"])).resolves.toEqual({
      "i:.kuro/MEMORY.md": null,
      "i:.obsidian/plugins/x/readme.md": null,
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(vault.unrestricted().readNote("i:.kuro/MEMORY.md")).resolves.toBe("# Memory");
  });
});

it("isReservedPath looks through the hidden-file-sync prefix", () => {
  expect(isReservedPath("i:.kuro/MEMORY.md", [".kuro"])).toBe(true);
  expect(isReservedPath("i:.kuro", [".kuro"])).toBe(true);
  expect(isReservedPath("i:.obsidian/app.json", [".kuro"])).toBe(false);
  expect(isReservedPath("i:.kuro/MEMORY.md", [])).toBe(false);
});

describe("Vault.readNotes", () => {
  it("reads in batches the vault object will serve in full", async () => {
    const paths = Array.from({ length: 120 }, (_, i) => `Notes/${i}.md`);
    const { vault, fetch } = vaultWith(
      [paths.slice(0, 50), paths.slice(50, 100), paths.slice(100)].map((batch) =>
        Response.json({ contents: Object.fromEntries(batch.map((path) => [path, `body of ${path}`])) }),
      ),
    );
    const contents = await vault.readNotes([...paths, ".kuro/MEMORY.md"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const sent = await Promise.all(
      fetch.mock.calls.map(async (call) => ((await call[0].json()) as { paths: string[] }).paths),
    );
    expect(sent.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(sent.flat()).toEqual(paths);
    expect(Object.keys(contents)).toHaveLength(121);
    expect(contents["Notes/0.md"]).toBe("body of Notes/0.md");
    expect(contents["Notes/119.md"]).toBe("body of Notes/119.md");
    expect(contents[".kuro/MEMORY.md"]).toBe(null);
  });
});

describe("Vault.appendToNote", () => {
  it("appends with an optimistic lock on the content read", async () => {
    const { vault, fetch } = vaultWith([
      Response.json({ content: "hello\n" }),
      Response.json({ ok: true, path: "a.md" }),
    ]);
    await expect(vault.appendToNote("a.md", "world")).resolves.toEqual({
      ok: true,
      path: "a.md",
      created: false,
    });
    const write = (await fetch.mock.calls[1]![0].json()) as Record<string, unknown>;
    expect(write.content).toBe("hello\n\nworld\n");
  });

  it("reports NOT_FOUND unless createIfMissing", async () => {
    const { vault } = vaultWith(Response.json({ content: null }));
    await expect(vault.appendToNote("missing.md", "x")).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
      path: "missing.md",
    });
  });
});


describe("Vault search freshness", () => {
  it("drops deleted and replaced semantic hits while keeping the current version", async () => {
    const { vault, fetch } = vaultWith(Response.json({ contents: {
      "gone.md": null, "updated.md": "current", "live.md": "live",
    } }), { searchHits: [
      { path: "gone.md", hash: await hashText("gone"), preview: "gone" },
      { path: "updated.md", hash: await hashText("old"), preview: "old" },
      { path: "updated.md", hash: await hashText("current"), preview: "current" },
      { path: "live.md", hash: await hashText("live"), preview: "live" },
    ] });
    const hits = await vault.search("query", 8);
    expect(hits.map((hit) => [hit.path, hit.textPreview])).toEqual([
      ["updated.md", "current"], ["live.md", "live"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fetch.mock.calls[0]![0].json()).resolves.toEqual({
      op: "readNotes", paths: ["gone.md", "updated.md", "live.md"],
    });
  });
});

describe("Vault.grep candidate pages", () => {
  async function indexedVault(includeLive: boolean) {
    const { bucket } = memoryBucket();
    const ref = { tenantId: "user-1", databaseName: "notes-test" };
    const live = "other ".repeat(100) + "needle";
    const liveHash = await hashText(live);
    await appendFtsSegment(bucket, ref, [
      ...Array.from({ length: 40 }, (_, index) => ({
        path: `gone-${index}.md`, content: "needle", hash: `gone-${index}`,
      })),
      ...(includeLive ? [{ path: "live.md", content: live, hash: liveHash }] : []),
    ]);
    const get = vi.spyOn(bucket, "get");
    const fetch = vi.fn(async (request: Request) => {
      const body = await request.json() as {
        candidates: Array<{ path: string; hash: string | null }>; limit: number;
      };
      const hits = body.candidates.filter((candidate) => candidate.path === "live.md" && candidate.hash === liveHash)
        .slice(0, body.limit).map((candidate) => ({ ...candidate, content: live }));
      return Response.json({ hits });
    });
    const env = testEnv();
    const vault = createVault({
      ...testBindings(env), bucket,
      vaultDb: { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace,
    }, { ref, policy: { reservedPaths: [], excludedFolders: [], timeZone: "UTC" }, internalSecret: TEST_SECRET });
    return { vault, fetch, get };
  }

  it("continues past stale top candidates without rereading the R2 ranking", async () => {
    const { vault, fetch, get } = await indexedVault(true);
    const result = await vault.grep("needle", 1);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("not ready");
    expect(result.hits.map((hit) => hit.path)).toEqual(["live.md"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.filter(([key]) => key.endsWith("manifest.json"))).toHaveLength(1);
  });

  it("stops once all stale candidates have been resolved", async () => {
    const { vault, fetch } = await indexedVault(false);
    const result = await vault.grep("needle", 1);
    expect(result.status === "ready" && result.hits).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("append retries only explicit conflicts and re-reads before composing", async () => {
  const {vault,fetch}=vaultWith([Response.json({content:"base"}),Response.json({error:"CONFLICT"},{status:409}),Response.json({content:"base\n\nconcurrent\n"}),Response.json({ok:true})]);
  expect(await vault.appendToNote("a.md","mine")).toMatchObject({ok:true});
  const write=await fetch.mock.calls[3]![0].json() as {content:string;expectedBaseHash:string};
  expect(write.content).toBe("base\n\nconcurrent\n\nmine\n");
  expect(write.expectedBaseHash).toBe(await hashText("base\n\nconcurrent\n"));
});
it("does not retry ambiguous append failures, and caps genuine conflicts at three", async () => {
  for(const status of [409,500]) {
    const responses=Array.from({length:3},()=>[Response.json({content:"base"}),Response.json({error:status===409?"CONFLICT":"WRITE_FAILED"},{status})]).flat();
    const {vault,fetch}=vaultWith(responses);
    expect(await vault.appendToNote("a.md","mine")).toMatchObject({ok:false,error:status===409?"CONFLICT":"WRITE_FAILED"});
    expect(fetch).toHaveBeenCalledTimes(status===409?6:2);
  }
});
it("refills external FTS results after stale, deleted and out-of-folder hits", async () => {
  const hits=[{path:"Else/first.md",contentHash:await hashText("live")},{path:"Notes/old.md",contentHash:await hashText("old")},{path:"Notes/deleted.md",contentHash:await hashText("gone")},{path:"Notes/live.md",contentHash:await hashText("live")}].map(hit=>({...hit,score:1,matchCount:1,snippets:[]}));
  const search=vi.fn(async(_ref:unknown,_query:string,limit:number)=>({hits:hits.slice(0,limit),builtAt:1,docCount:4}));
  const vault=createVault({vaultDb:{idFromName:()=>"a",get:()=>({fetch:async()=>Response.json({contents:{"Else/first.md":"live","Notes/old.md":"new","Notes/deleted.md":null,"Notes/live.md":"live"}})})} as unknown as DurableObjectNamespace,fullText:{search,openWriter:async()=>({upsert:async()=>{},delete:async()=>{},close:async()=>{}}),deleteVault:async()=>{}}},{ref:{tenantId:"a",databaseName:"vault"},policy:{reservedPaths:[],excludedFolders:[],timeZone:"UTC"},internalSecret:TEST_SECRET});
  const result=await vault.grep("live",1,{folder:"Notes"});
  expect(result).toMatchObject({status:"ready",hits:[{path:"Notes/live.md"}]});
  expect(search.mock.calls.map(call=>call[2])).toEqual([1,2,4]);
});
