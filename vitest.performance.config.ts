import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "test/workers/wrangler.jsonc" } })],
  test: { include: ["test/performance/**/*.test.ts"], reporters: ["default", "./test/performance/reporter.mjs"] },
});
