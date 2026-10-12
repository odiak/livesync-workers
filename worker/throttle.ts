import type { Env } from "./env.js";

/**
 * Lockout for repeated sign-in failures (LiveSync Basic auth and the admin login).
 *
 * AUTH_FAILURE_LIMITER (a Workers rate limiting binding) counts failures per
 * client IP. Once it trips, the IP is locked in OAUTH_KV, and every attempt from
 * it, right or wrong, gets 429 until the lock expires. The lock has to cover
 * correct passwords too, or a guesser would still learn which guess worked.
 * Without the binding, nothing is throttled.
 */
export const AUTH_LOCK_SECONDS = 15 * 60;
const LOCK_KEY_PREFIX = "auth-lock:";
// Successful LiveSync clients poll constantly; re-read the KV lock at most this often per isolate.
const LOCK_CACHE_MS = 30_000;
const LOCK_CACHE_MAX = 1000;
const lockCache = new Map<string, { locked: boolean; checkedAt: number }>();

function clientKey(request: Request): string {
  return `${new URL(request.url).host}:${new URL(request.url).pathname === "/login" ? "admin" : "sync"}:${request.headers.get("CF-Connecting-IP") ?? "local"}`;
}

function remember(key: string, locked: boolean): void {
  if (lockCache.size >= LOCK_CACHE_MAX) lockCache.clear();
  lockCache.set(key, { locked, checkedAt: Date.now() });
}

export async function isLockedOut(env: Env, request: Request): Promise<boolean> {
  if (!env.AUTH_FAILURE_LIMITER) return false;
  const key = clientKey(request);
  const cached = lockCache.get(key);
  if (cached && Date.now() - cached.checkedAt < LOCK_CACHE_MS) return cached.locked;
  const locked = (await env.OAUTH_KV.get(`${LOCK_KEY_PREFIX}${key}`)) !== null;
  remember(key, locked);
  return locked;
}

/** Count one failed attempt. Returns true when this failure locked the client out. */
export async function recordAuthFailure(env: Env, request: Request): Promise<boolean> {
  if (!env.AUTH_FAILURE_LIMITER) return false;
  const key = clientKey(request);
  const { success } = await env.AUTH_FAILURE_LIMITER.limit({ key });
  if (success) return false;
  if (!lockCache.get(key)?.locked) {
    await env.OAUTH_KV.put(`${LOCK_KEY_PREFIX}${key}`, "1", { expirationTtl: AUTH_LOCK_SECONDS });
  }
  remember(key, true);
  return true;
}

/** For tests: forget cached lock states. */
export function resetLockCache(): void {
  lockCache.clear();
}
