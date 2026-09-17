import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools, vaultInstructions, type VaultScope } from "livesync-workers/mcp";
import type { Env } from "./env.js";
import { vaultFor } from "./host.js";

export type McpProps = {
  userId: string;
  label?: string;
  scope: string[];
};

export class VaultMCP extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer(
    { name: "livesync-workers", version: "0.1.0" },
    { instructions: vaultInstructions() },
  );

  async init(): Promise<void> {
    registerVaultTools(this.server, {
      vault: async () => vaultFor(this.env),
      hasScope: (scope: VaultScope) => this.props?.scope?.includes(scope) ?? false,
    });
  }
}
