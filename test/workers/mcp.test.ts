import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("initializes a real MCP agent and isolates warm sessions by user and scopes", async () => {
  async function call(user: string, scope: string, method: string, session?: string) {
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-test-user": user, "x-test-scope": scope });
    if (session) headers.set("mcp-session-id", session);
    return SELF.fetch("https://vault.example/mcp", { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration", version: "1" } } : method === "tools/call" ? { name: "identity", arguments: {} } : {},
    }) });
  }
  const initialized = await call("alice", "vault:read vault:write", "initialize");
  expect(initialized.status).toBe(200);
  const session = initialized.headers.get("mcp-session-id")!;
  expect(session).toBeTruthy();
  await initialized.text();
  const result = await call("alice", "vault:write vault:read", "tools/call", session);
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('"text":"alice"');
  for (const [user, scope] of [["bob", "vault:read vault:write"], ["alice", "vault:read"]]) {
    const denied = await call(user!, scope!, "tools/list", session);
    expect(denied.status).toBe(404);
    await denied.text();
  }
});
