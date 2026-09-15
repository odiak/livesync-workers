export const INTERNAL_SECRET_HEADER = "X-LiveSync-Internal";
export const DB_NAME_HEADER = "X-LiveSync-Db";
/**
 * Set by the Durable Object on a `_changes` response that returned nothing new
 * for the requested `since`, i.e. a longpoll caller should keep waiting.
 */
export const CHANGES_IDLE_HEADER = "X-LiveSync-Changes-Idle";

export const jsonHeaders = { "content-type": "application/json" };

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...jsonHeaders, ...init?.headers },
  });
}

export function couchError(status: number, error: string, reason: string): Response {
  return json({ error, reason }, { status });
}

export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function numberParam(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}
