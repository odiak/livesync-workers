import { defineConfig } from "vitest/config";

// Tests for the single-tenant Worker (worker/). The library has its own config.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./packages/livesync-workers/test/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
  test: {
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    environment: "node",
    include: ["worker/**/*.test.ts"],
  },
});
