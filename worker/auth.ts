import { constantTimeEquals } from "livesync-workers";
import type { Env } from "./env.js";
import { requireSecret, secretValue } from "./host.js";

export const SESSION_COOKIE = "ls_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const enc = new TextEncoder();

/**
 * Same-origin path for the post-login redirect, or "/" for anything else.
 * A prefix check is not enough: browsers read `/\evil.example` as
 * `//evil.example`, so the value is parsed against the request origin.
 */
export function safeRedirectTarget(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/")) return "/";
  let target: URL;
  try {
    target = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (target.origin !== origin) return "/";
  return `${target.pathname}${target.search}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name && rest.length) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function createSessionCookie(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmacHex(requireSecret(env, "SESSION_SECRET"), `admin:${exp}`);
  return `${SESSION_COOKIE}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const value = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  const secret = secretValue(env, "SESSION_SECRET");
  if (!value || !secret) return false;
  const [expRaw, sig] = value.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || !sig) return false;
  const expected = await hmacHex(secret, `admin:${exp}`);
  return constantTimeEquals(sig, expected);
}

export function checkAdminPassword(env: Env, password: string): boolean {
  const expected = secretValue(env, "ADMIN_PASSWORD");
  return !!expected && constantTimeEquals(password, expected);
}

/** Scopes a static token grants: vault:read plus whatever MCP_STATIC_TOKEN_SCOPES allows. */
export function staticTokenScopes(env: Env): string[] {
  const allowed = new Set(["vault:read", "vault:append", "vault:write"]);
  const scopes = new Set(["vault:read"]);
  for (const raw of (env.MCP_STATIC_TOKEN_SCOPES ?? "").split(",")) {
    const scope = raw.trim();
    if (allowed.has(scope)) scopes.add(scope);
  }
  return [...scopes];
}

export function checkStaticToken(env: Env, request: Request): boolean {
  const token = env.MCP_STATIC_TOKEN;
  if (!token) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEquals(header.slice("Bearer ".length), token);
}
