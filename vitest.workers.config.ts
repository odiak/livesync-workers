import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "test/workers/wrangler.jsonc" } })],
  test: { include: ["test/workers/**/*.test.ts"] },
});
