/**
 * Helpers for LiveSync Basic-auth credentials. The hash format
 * (sha256 of "salt:password", hex) is a persisted detail; keep it stable.
 */

const enc = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type HashedCredential = { salt: string; hash: string };

export async function hashCredentialPassword(
  password: string,
  salt: string = randomToken(16),
): Promise<HashedCredential> {
  return { salt, hash: await sha256Hex(`${salt}:${password}`) };
}

export async function verifyCredentialPassword(
  password: string,
  stored: HashedCredential,
): Promise<boolean> {
  const hash = await sha256Hex(`${stored.salt}:${password}`);
  return constantTimeEquals(hash, stored.hash);
}

/** Generate a fresh username/password pair suitable for a LiveSync client. */
export function generateCredential(usernamePrefix = "sync"): { username: string; password: string } {
  return { username: `${usernamePrefix}_${randomToken(9)}`, password: randomToken(32) };
}

export const DEFAULT_DATABASE_NAME = "vault";

/** Coerce user input into a CouchDB-legal database name. */
export function normalizeDatabaseName(raw: string | undefined): string {
  let normalized = (raw ?? DEFAULT_DATABASE_NAME)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_$()+-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized && !/^[a-z]/.test(normalized)) {
    normalized = `vault-${normalized.replace(/^_+/, "")}`;
  }
  return normalized || DEFAULT_DATABASE_NAME;
}
