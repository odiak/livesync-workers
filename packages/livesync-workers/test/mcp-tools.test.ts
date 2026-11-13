import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Vault } from "../src/vault/client.js";
import { hashText } from "../src/search/chunk-md.js";
import { VAULT_TOOL_NAMES, registerVaultTools } from "../src/mcp/index.js";

describe("VAULT_TOOL_NAMES", () => {
  it("lists exactly the tools registerVaultTools adds", async () => {
    const server = new McpServer({ name: "tools", version: "1" });
    registerVaultTools(server, { vault: async () => null, hasScope: () => true });
    const client = new Client({ name: "tools-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...VAULT_TOOL_NAMES].sort());
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
it("keeps the README tool table in sync", () => {
  const readme=readFileSync(new FileURL("../../../README.md",import.meta.url),"utf8");
  const scopeRows=readme.split("\n").filter(line=>/^\| `vault:(read|append|write)`/.test(line));
  const names=scopeRows.flatMap(line=>line.split("|")[3]!.trim().split(/,\s*/));
  expect(names.sort()).toEqual([...VAULT_TOOL_NAMES].sort());
});

describe("MCP note-read response compatibility", () => {
  it.each(["# 日本語のノート\n本文", "", null])(
    "preserves text, hashes and missing-note errors over MCP (%j)",
    async (body) => {
      const path = "daily notes/2026-11-13.md";
      const vault = {
        readNote: async () => body,
        listMarkdownPaths: async () => [path],
        dailyNoteSettings: async () => ({ folder: "daily notes", format: "YYYY-MM-DD" }),
      } as unknown as Vault;
      const server = new McpServer({ name: "notes", version: "1" });
      registerVaultTools(server, { vault: async () => vault, hasScope: () => true });
      const client = new Client({ name: "notes-client", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        for (const name of ["readNote", "readDailyNote"]) {
          const result = await client.callTool({
            name,
            arguments: name === "readNote" ? { path } : { date: "2026-11-13" },
          });
          expect(result.isError).not.toBe(true);
          const blocks = result.content as Array<{ type: string; text: string }>;
          expect(blocks).toHaveLength(1);
          expect(blocks[0]!.type).toBe("text");
          const payload = JSON.parse(blocks[0]!.text);
          expect(payload.path).toBe(path);
          expect(payload).not.toHaveProperty("content");
          if (name === "readDailyNote") expect(payload.date).toBe("2026-11-13");
          if (body === null) {
            expect(payload.error).toBe("NOT_FOUND");
          } else {
            expect(payload.text).toBe(body);
            expect(payload.contentHash).toBe(await hashText(body));
          }
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
