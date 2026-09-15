/**
 * Binary codec for shard files: LEB128 varints, delta-encoded posting lists,
 * gzip via CompressionStream (available in Workers and Node 18+).
 *
 * Shard layout (before gzip):
 *   magic "KFTS", format version varint, term count varint, then per term:
 *     term byte length varint, term bytes (UTF-8), doc count varint, per doc:
 *       docId delta varint, position count varint, position delta varints
 */

export const SHARD_FORMAT_VERSION = 1;

const MAGIC = [0x4b, 0x46, 0x54, 0x53]; // "KFTS"

export type Posting = { doc: number; positions: number[] };

export class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len] = value & 0xff;
    this.len += 1;
  }

  varint(value: number): void {
    if (value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`varint out of range: ${value}`);
    }
    this.ensure(10);
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len] = (v & 0x7f) | 0x80;
      this.len += 1;
      v = Math.floor(v / 128);
    }
    this.buf[this.len] = v;
    this.len += 1;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error("Unexpected end of shard data");
    const value = this.buf[this.pos]!;
    this.pos += 1;
    return value;
  }

  varint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  }

  bytes(length: number): Uint8Array {
    if (this.pos + length > this.buf.length) {
      throw new Error("Unexpected end of shard data");
    }
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function shardForTerm(term: string, shardCount: number): number {
  return fnv1a(term) % shardCount;
}

export function encodeShard(entries: Iterable<[string, Posting[]]>): Uint8Array {
  const writer = new ByteWriter();
  for (const byte of MAGIC) writer.u8(byte);
  writer.varint(SHARD_FORMAT_VERSION);
  const list = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  writer.varint(list.length);
  const encoder = new TextEncoder();
  for (const [term, postings] of list) {
    const termBytes = encoder.encode(term);
    writer.varint(termBytes.length);
    writer.bytes(termBytes);
    writer.varint(postings.length);
    let prevDoc = 0;
    for (const posting of postings) {
      writer.varint(posting.doc - prevDoc);
      prevDoc = posting.doc;
      writer.varint(posting.positions.length);
      let prevPos = 0;
      for (const pos of posting.positions) {
        writer.varint(pos - prevPos);
        prevPos = pos;
      }
    }
  }
  return writer.toUint8Array();
}

export function decodeShard(data: Uint8Array): Map<string, Posting[]> {
  const reader = new ByteReader(data);
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new Error("Bad shard magic");
  }
  const version = reader.varint();
  if (version !== SHARD_FORMAT_VERSION) {
    throw new Error(`Unsupported shard format version ${version}`);
  }
  const termCount = reader.varint();
  const decoder = new TextDecoder();
  const result = new Map<string, Posting[]>();
  for (let t = 0; t < termCount; t += 1) {
    const term = decoder.decode(reader.bytes(reader.varint()));
    const docCount = reader.varint();
    const postings: Posting[] = [];
    let doc = 0;
    for (let d = 0; d < docCount; d += 1) {
      doc += reader.varint();
      const posCount = reader.varint();
      const positions: number[] = [];
      let pos = 0;
      for (let p = 0; p < posCount; p += 1) {
        pos += reader.varint();
        positions.push(pos);
      }
      postings.push({ doc, positions });
    }
    result.set(term, postings);
  }
  return result;
}

async function pipeThrough(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const response = new Response(source.pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream("gzip"));
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream("gzip"));
}
