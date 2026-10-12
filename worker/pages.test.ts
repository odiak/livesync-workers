import { describe, expect, it } from "vitest";
import { statusPage, type StatusPageData } from "./pages.js";
import type { Env } from "./env.js";

const data: StatusPageData = {
  origin: "https://vault.example", admin: true,
  configured: { livesync: true, admin: true, session: true },
  mcpConnections: [{ id: "grant", clientId: "client", clientName: "<script>alert(1)</script>", scopes: ["vault:read"], createdAt: "2026-10-09T00:00:00Z", expiresAt: null }],
};

describe("MCP connections on the status page", () => {
  it("renders expiry and escapes client-controlled names", async () => {
    const html = await statusPage({} as Env, data).text();
    expect(html).toContain("MCP connections");
    expect(html).toContain("No expiry");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
  it("does not expose connection metadata to visitors", async () => {
    const html = await statusPage({} as Env, { ...data, admin: false }).text();
    expect(html).not.toContain("MCP connections");
    expect(html).not.toContain("alert(1)");
  });
  it("distinguishes a load error from no connections", async () => {
    const html = await statusPage({} as Env, { ...data, mcpConnections: undefined, mcpConnectionsError: true }).text();
    expect(html).toContain("Could not load MCP connections");
    expect(html).not.toContain("No MCP connections.");
  });
});

import { VAULT_TOOL_NAMES } from "livesync-workers/mcp";
it("keeps the status page and README MCP tool list aligned", async()=>{
  const html=await statusPage({} as Env,data).text();
  expect(html).toContain(VAULT_TOOL_NAMES.join(", "));

});
