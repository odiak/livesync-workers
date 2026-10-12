import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
