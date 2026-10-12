import { beforeEach, describe, expect, it } from "vitest";
import { AuthThrottledError } from "livesync-workers";
import type { Env } from "./env.js";
import { vaultHost } from "./host.js";
import { isLockedOut, recordAuthFailure, resetLockCache } from "./throttle.js";

/** Fixed-window stand-in for the rate limiting binding. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    async limit({ key }: { key: string }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function testEnv(withLimiter = true) {
  return {
    SESSION_SECRET: "test-secret",
    LIVESYNC_PASSWORD: "right-password",
    OAUTH_KV: fakeKv(),
    ...(withLimiter ? { AUTH_FAILURE_LIMITER: fakeLimiter(3) } : {}),
  } as unknown as Env;
}

const from = (ip: string) => new Request("https://worker/livesync/vault", { headers: { "CF-Connecting-IP": ip } });

beforeEach(() => resetLockCache());

describe("sign-in lockout", () => {
  it("locks an IP out after repeated failures, even for the right password", async () => {
    const env = testEnv();
    const host = vaultHost(env, from("192.0.2.1"));
    for (let i = 0; i < 3; i++) expect(await host.verifyCredential("obsidian", "wrong")).toBeNull();
    await expect(host.verifyCredential("obsidian", "wrong")).rejects.toBeInstanceOf(AuthThrottledError);
    await expect(host.verifyCredential("obsidian", "right-password")).rejects.toBeInstanceOf(AuthThrottledError);
    expect(await vaultHost(env, from("192.0.2.2")).verifyCredential("obsidian", "right-password")).not.toBeNull();
  });

  it("reads the lock written by another isolate", async () => {
    const env = testEnv();
    (env.OAUTH_KV as unknown as ReturnType<typeof fakeKv>).store.set("auth-lock:worker:sync:192.0.2.9", "1");
    expect(await isLockedOut(env, from("192.0.2.9"))).toBe(true);
    expect(await isLockedOut(env, from("192.0.2.10"))).toBe(false);
  });

  it("does not count successful sign-ins", async () => {
    const env = testEnv();
    const host = vaultHost(env, from("192.0.2.3"));
    for (let i = 0; i < 10; i++) expect(await host.verifyCredential("obsidian", "right-password")).not.toBeNull();
  });

  it("does nothing without the rate limiting binding", async () => {
    const env = testEnv(false);
    for (let i = 0; i < 20; i++) expect(await recordAuthFailure(env, from("192.0.2.4"))).toBe(false);
    expect(await isLockedOut(env, from("192.0.2.4"))).toBe(false);
  });
});
