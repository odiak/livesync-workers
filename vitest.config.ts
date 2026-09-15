import { defineConfig } from "vitest/config";

// Tests for the single-tenant Worker (worker/). The library has its own config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts"],
  },
});
