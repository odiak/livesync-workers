import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inferDailyNotePath, listVaultDirectory } from "../vault/paths.js";
import { hashText } from "../search/chunk-md.js";
import type { Vault } from "../vault/client.js";
import { dateStringIn } from "../types.js";

export const VAULT_SCOPES = ["vault:read", "vault:append", "vault:write"] as const;
export type VaultScope = (typeof VAULT_SCOPES)[number];

export const VAULT_SCOPE_DESCRIPTIONS: Record<VaultScope, string> = {
  "vault:read": "Read and search vault notes (required)",
  "vault:append": "Append to the end of vault notes",
  "vault:write": "Create and overwrite vault notes",
};

export type VaultToolContext = {
  /** The caller's vault, or null when no vault is connected yet. */
  vault: () => Promise<Vault | null>;
  /** Scope check, evaluated on every tool call. */
  hasScope: (scope: VaultScope) => boolean;
  /** Name shown in tool descriptions. Default "Obsidian". */
  vaultLabel?: string;
};

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function clampLimit(limit: number | undefined, fallback: number, max: number) {
  if (!limit) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** Similar existing paths shown when readNote misses, so callers can self-correct. */
function suggestSimilarPaths(paths: string[], requested: string): string[] {
  const base = (requested.split("/").at(-1) ?? requested).replace(/\.md$/i, "").toLowerCase();
  if (!base) return [];
  return paths.filter((path) => path.toLowerCase().includes(base)).slice(0, 5);
}

/**
 * Register the vault tools on an MCP server:
 * listDirectory, listNotes, listRecentNotes, readNote, readDailyNote,
 * searchNotes, grepNotes, vaultStatus (vault:read);
 * appendToDailyNote, appendToNote (vault:append); writeNote (vault:write).
 */
export function registerVaultTools(server: McpServer, ctx: VaultToolContext): void {
  const label = ctx.vaultLabel ?? "Obsidian";

  const requireScope = (scope: VaultScope) => {
    if (!ctx.hasScope(scope)) throw new Error(`Missing required OAuth scope: ${scope}`);
  };
  const readyVault = async (scope: VaultScope = "vault:read"): Promise<Vault> => {
    requireScope("vault:read");
    if (scope !== "vault:read") requireScope(scope);
    const vault = await ctx.vault();
    if (!vault) throw new Error(`${label} vault is not connected`);
    return vault;
  };

  server.tool(
    "listDirectory",
    "List Markdown files and subdirectories directly under a vault-relative directory.",
    {
      path: z
        .string()
        .optional()
        .describe("Vault-relative directory path. Omit or use empty string for root."),
    },
    async ({ path }) => {
      const vault = await readyVault();
      const paths = await vault.listMarkdownPaths();
      return textResult(listVaultDirectory(paths, path ?? ""));
    },
  );

  server.tool(
    "listNotes",
    "List vault-relative Markdown note paths. Response includes the total count so you can tell when results are truncated.",
    {
      prefix: z
        .string()
        .optional()
        .describe("Only return paths starting with this vault-relative prefix, e.g. 'daily notes/'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of note paths to return. Default is 100."),
    },
    async ({ prefix, limit }) => {
      const vault = await readyVault();
      let paths = await vault.listMarkdownPaths();
      if (prefix) paths = paths.filter((path) => path.startsWith(prefix));
      return textResult({ total: paths.length, paths: paths.slice(0, clampLimit(limit, 100, 500)) });
    },
  );

  server.tool(
    "listRecentNotes",
    "List Markdown notes sorted by modification time (newest first), with mtime and size.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of notes to return. Default is 20."),
    },
    async ({ limit }) => {
      const vault = await readyVault();
      const files = await vault.listNoteStats();
      files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      return textResult({
        total: files.length,
        notes: files.slice(0, clampLimit(limit, 20, 100)).map((file) => ({
          path: file.path,
          modifiedAt: file.mtime != null ? new Date(file.mtime).toISOString() : null,
          size: file.size,
        })),
      });
    },
  );

  server.tool(
    "readNote",
    "Read a Markdown note by vault-relative path.",
    {
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
    },
    async ({ path }) => {
      const vault = await readyVault();
      const content = await vault.readNote(path);
      if (content == null) {
        const paths = await vault.listMarkdownPaths();
        return textResult({
          error: "NOT_FOUND",
          path,
          similarPaths: suggestSimilarPaths(paths, path),
        });
      }
      return textResult({
        path,
        content,
        // Pass back to writeNote as expectedContentHash when overwriting.
        contentHash: await hashText(content),
      });
    },
  );

  server.tool(
    "searchNotes",
    `Search indexed ${label} notes semantically.`,
    {
      query: z.string().min(1).describe("Search query."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum search hits to return. Default is 8."),
    },
    async ({ query, limit }) => {
      const vault = await readyVault();
      const hits = await vault.search(query, clampLimit(limit, 8, 20));
      return textResult({ hits });
    },
  );

  server.tool(
    "grepNotes",
    `Exact-match full-text search over ${label} notes (substring for Japanese/CJK, whole-word for ASCII). Whitespace-separated phrases are ANDed. Use searchNotes for semantic queries instead.`,
    {
      query: z.string().min(1).max(200).describe("Search phrase(s)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum search hits to return. Default is 20."),
    },
    async ({ query, limit }) => {
      const vault = await readyVault();
      const result = await vault.grep(query, clampLimit(limit, 20, 50));
      if (result.status === "building") {
        return textResult({
          status: "building",
          message: "The full-text index is being built; retry shortly.",
          debug: result.debug ?? null,
        });
      }
      return textResult(result);
    },
  );

  server.tool(
    "readDailyNote",
    "Read a daily note by date using Obsidian daily-notes settings when available.",
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Daily note date in YYYY-MM-DD format."),
    },
    async ({ date }) => {
      const vault = await readyVault();
      const [paths, settings] = await Promise.all([
        vault.listMarkdownPaths(),
        vault.dailyNoteSettings(),
      ]);
      const path = inferDailyNotePath(paths, date, settings);
      const content = await vault.readNote(path);
      if (content == null) return textResult({ error: "NOT_FOUND", date, path });
      return textResult({ date, path, content, contentHash: await hashText(content) });
    },
  );

  server.tool(
    "appendToDailyNote",
    "Append a Markdown block to the end of a daily note (created if missing). Requires the vault:append scope.",
    {
      text: z.string().min(1).max(20_000).describe("Markdown block to append."),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Daily note date (YYYY-MM-DD). Defaults to today in the vault's time zone."),
    },
    async ({ text, date }) => {
      const vault = await readyVault("vault:append");
      const targetDate = date ?? dateStringIn(vault.policy.timeZone);
      const [paths, settings] = await Promise.all([
        vault.listMarkdownPaths(),
        vault.dailyNoteSettings(),
      ]);
      const path = inferDailyNotePath(paths, targetDate, settings);
      const result = await vault.appendToNote(path, text, { createIfMissing: true });
      if (!result.ok) return textResult({ error: result.error, date: targetDate, path });
      return textResult({ ok: true, date: targetDate, path, created: result.created });
    },
  );

  server.tool(
    "appendToNote",
    "Append a Markdown block to the end of an existing note. Fails with NOT_FOUND when the note does not exist. Requires the vault:append scope.",
    {
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
      text: z.string().min(1).max(20_000).describe("Markdown block to append."),
    },
    async ({ path, text }) => {
      const vault = await readyVault("vault:append");
      const result = await vault.appendToNote(path, text);
      if (!result.ok) {
        if (result.error === "NOT_FOUND") {
          const paths = await vault.listMarkdownPaths();
          return textResult({
            error: "NOT_FOUND",
            path,
            similarPaths: suggestSimilarPaths(paths, path),
          });
        }
        return textResult({ error: result.error, path });
      }
      return textResult({ ok: true, path });
    },
  );

  server.tool(
    "writeNote",
    "Create or overwrite a vault note. Overwriting an existing note requires expectedContentHash (the contentHash returned by readNote), which detects concurrent edits. Prefer appendToDailyNote/appendToNote when appending is enough. Requires the vault:write scope.",
    {
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
      content: z
        .string()
        .max(200_000)
        .describe("Full note content (replaces the existing content)."),
      expectedContentHash: z
        .string()
        .optional()
        .describe(
          "contentHash from readNote of the version being replaced. Required when the note already exists.",
        ),
    },
    async ({ path, content, expectedContentHash }) => {
      const vault = await readyVault("vault:write");
      const current = await vault.readNote(path);
      if (current != null && !expectedContentHash) {
        return textResult({
          error: "HASH_REQUIRED",
          path,
          message: "Note already exists. Call readNote first and pass its contentHash as expectedContentHash.",
        });
      }
      const result = await vault.writeNote(
        path,
        content,
        current == null ? await hashText("") : expectedContentHash!,
      );
      if (!result.ok) return textResult({ error: result.error, path });
      return textResult({ ok: true, path, created: current == null });
    },
  );

  server.tool(
    "vaultStatus",
    "Show vault connection state and search index progress. Useful when other tools fail or search returns nothing.",
    {},
    async () => {
      requireScope("vault:read");
      const vault = await ctx.vault();
      if (!vault || !(await vault.exists())) {
        return textResult({ connected: false, index: null });
      }
      const index = await vault.indexStatus();
      return textResult({ connected: true, timeZone: vault.policy.timeZone, index });
    },
  );
}
