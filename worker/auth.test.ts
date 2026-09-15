import { describe, expect, it } from "vitest";
import { safeRedirectTarget } from "./auth.js";

const origin = "https://vault.example";

describe("safeRedirectTarget", () => {
  it("keeps same-origin paths with their query", () => {
    expect(safeRedirectTarget("/authorize?client_id=x&state=y", origin)).toBe(
      "/authorize?client_id=x&state=y",
    );
    expect(safeRedirectTarget("/", origin)).toBe("/");
  });

  it("falls back to / for anything that leaves the origin", () => {
    for (const raw of [
      null,
      "",
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "/\\\\evil.example",
      "\\/evil.example",
      "/%5Cevil.example/..",
      "javascript:alert(1)",
      "authorize",
    ]) {
      expect(safeRedirectTarget(raw, origin), JSON.stringify(raw)).toBe("/");
    }
  });
});
