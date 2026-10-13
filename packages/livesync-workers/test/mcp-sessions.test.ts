import { describe, expect, it, vi } from "vitest";
import { McpAgent } from "agents/mcp";
import { withMcpSessionIsolation } from "../src/mcp/sessions.js";

type Props = { userId: string; scope: string[] };

function setup() {
  const objects = new Map<string, {
    name: string; props?: Props; initialized: unknown; destroy: ReturnType<typeof vi.fn>;
    __unsafe_ensureInitialized(props?: Props): Promise<void>;
    getInitializeRequest(): Promise<unknown>;
    setInitializeRequest(value: unknown): Promise<void>;
    fetch(): Promise<{ webSocket: { accept(): void; close(): void; addEventListener(): void } }>;
  }>();
  const namespace = {
    newUniqueId() { return { toString: () => "session-1" }; },
    idFromName(name: string) {
      expect(this).toBe(namespace);
      return name;
    },
    get(name: string) {
      expect(this).toBe(namespace);
      if (!objects.has(name)) {
        objects.set(name, {
          name, initialized: null, destroy: vi.fn(async () => {}),
          async __unsafe_ensureInitialized(props) {
            // Match Agent lifecycle: props initialize a warm object only once.
            this.props ??= props;
          },
          async getInitializeRequest() { return this.initialized; },
          async setInitializeRequest(value) { this.initialized = value; },
          async fetch() { return { webSocket: { accept() {}, close() {}, addEventListener() {} } }; },
        });
      }
      return objects.get(name)!;
    },
  };
  const handler = withMcpSessionIsolation<{ MCP_OBJECT: DurableObjectNamespace }>(
    McpAgent.serve("/mcp") as unknown as ExportedHandler<{ MCP_OBJECT: DurableObjectNamespace }>,
    "MCP_OBJECT",
  );
  async function call(props: Props, method: string, sessionId?: string) {
    const headers = new Headers({ Accept: "application/json, text/event-stream", "Content-Type": "application/json" });
    if (sessionId) headers.set("mcp-session-id", sessionId);
    const request = new Request("https://vault.example/mcp", {
      method, headers,
      ...(method === "POST" ? { body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: sessionId ? "tools/list" : "initialize",
        ...(sessionId ? {} : { params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      }) } : {}),
    });
    const response = await handler.fetch(request as Parameters<typeof handler.fetch>[0], { MCP_OBJECT: namespace as unknown as DurableObjectNamespace }, {
      props, waitUntil() {}, passThroughOnException() {},
    } as unknown as ExecutionContext);
    await response.body?.cancel();
    return response;
  }
  return { objects, call };
}

describe("MCP authenticated session isolation", () => {
  it("keeps the wire session ID and routes the same principal back to its warm object", async () => {
    const { call, objects } = setup();
    const props = { userId: "A", scope: ["vault:read", "vault:write"] };
    const initialized = await call(props, "POST");
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBe("session-1");
    expect((await call({ ...props, scope: [...props.scope].reverse() }, "POST", "session-1")).status).toBe(200);
    expect(objects.size).toBe(1);
    const name = [...objects.keys()][0]!;
    expect(name.split(":").slice(0, 2)).toEqual(["streamable-http", "session-1"]);
  });

  it("refuses another user's session on POST, GET and DELETE", async () => {
    const { call, objects } = setup();
    await call({ userId: "A", scope: ["vault:read"] }, "POST");
    for (const method of ["POST", "GET", "DELETE"]) {
      expect((await call({ userId: "B", scope: ["vault:read"] }, method, "session-1")).status).toBe(404);
    }
    expect([...objects.values()][0]!.props!.userId).toBe("A");
    expect([...objects.values()][0]!.destroy).not.toHaveBeenCalled();
  });

  it("prevents a read-only token or static token from borrowing an existing write session", async () => {
    const { call, objects } = setup();
    await call({ userId: "admin", scope: ["vault:read", "vault:write"] }, "POST");
    expect((await call({ userId: "admin", scope: ["vault:read"] }, "POST", "session-1")).status).toBe(404);
    expect([...objects.values()][0]!.props!.scope).toContain("vault:write");
  });
});
