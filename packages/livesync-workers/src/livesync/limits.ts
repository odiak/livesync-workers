/** Enforced limits, also used by the CouchDB configuration shim. All bytes are UTF-8. */
export const REQUEST_LIMITS = Object.freeze({
  maxRequestBytes: 16 * 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxBulkDocuments: 1000,
  // At most 32 inner all_docs requests of 128 keys each.
  maxAllDocsKeys: 4096,
  maxResponseBytes: 16 * 1024 * 1024,
});
/** A request body or path CouchDB would answer with 400 bad_request. */
export class BadRequestError extends Error {}
/** Thrown by `VaultHost.verifyCredential` to refuse an attempt with 429 instead of checking it. */
export class AuthThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many failed sign-in attempts");
  }
}
export class RequestLimitError extends Error {
  readonly status = 413;
  constructor(readonly limit: keyof typeof REQUEST_LIMITS) {
    super(`${limit} exceeds ${REQUEST_LIMITS[limit]}`);
  }
}
const texts = new WeakMap<Request, { text: string; bytes: number }>();

/** Bound retained bytes even with missing/false Content-Length and tiny stream chunks. */
export async function readBoundedText(request: Request, maximum = REQUEST_LIMITS.maxRequestBytes): Promise<string> {
  const cached = texts.get(request);
  if (cached) {
    if (cached.bytes > maximum) throw new RequestLimitError("maxRequestBytes");
    return cached.text;
  }
  const declared = request.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    void request.body?.cancel().catch(() => {});
    throw new RequestLimitError("maxRequestBytes");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(65536, maximum));
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - length) {
        void reader.cancel().catch(() => {});
        throw new RequestLimitError("maxRequestBytes");
      }
      const needed = length + value.byteLength;
      if (needed > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(needed, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length = needed;
    }
    const text = new TextDecoder().decode(bytes.subarray(0, length));
    texts.set(request, { text, bytes: length });
    return text;
  } finally {
    reader.releaseLock();
  }
}
const parsed = new WeakMap<Request, Record<string, unknown>>();
export async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const previous = parsed.get(request);
  if (previous) return previous;
  const text = await readBoundedText(request);
  const body = parseJsonObject(text);
  parsed.set(request, body);
  return body;
}
/** An empty body is `{}`; anything but a JSON object is a 400, as in CouchDB. */
export function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestError("Request body must be a JSON object");
  return body as Record<string, unknown>;
}
/** Percent-decode a path segment, answering 400 for malformed escapes. */
export function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError("Malformed percent-encoding in path");
  }
}
export function assertDocumentSize(document: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(document) ?? "").byteLength > REQUEST_LIMITS.maxDocumentBytes) {
    throw new RequestLimitError("maxDocumentBytes");
  }
}
export function assertBulkLimits(body: Record<string, unknown>): void {
  if (!Array.isArray(body.docs)) return;
  if (body.docs.length > REQUEST_LIMITS.maxBulkDocuments) throw new RequestLimitError("maxBulkDocuments");
  // Validate the complete batch before the first immutable object or SQL write.
  for (const document of body.docs) assertDocumentSize(document);
}
