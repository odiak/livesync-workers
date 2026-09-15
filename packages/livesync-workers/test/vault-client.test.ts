import { describe, expect, it, vi } from "vitest";
import { createVault, type VaultBindings } from "../src/index.js";
import { testBindings, testEnv, TEST_SECRET } from "./helpers.js";

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
    const { vault } = vaultWith([], {
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

  it("blocks reserved notes from reads unless unrestricted", async () => {
    const { vault } = vaultWith(Response.json({ content: "# Memory" }));
    await expect(vault.readNote(".kuro/MEMORY.md")).resolves.toBe(null);
    await expect(vault.unrestricted().readNote(".kuro/MEMORY.md")).resolves.toBe("# Memory");
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
