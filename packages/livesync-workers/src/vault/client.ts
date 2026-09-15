import { INTERNAL_SECRET_HEADER } from "../livesync/http.js";
import { vaultStub } from "../livesync/handler.js";
import { hashText } from "../search/chunk-md.js";
import { vectorSearch, type VectorSearchHit } from "../search/vector-index.js";
import { ftsSearch, readFtsPhase } from "../search/fts-index.js";
import { extractSnippet } from "../search/fts/search.js";
import {
  isReservedPath,
  type DailyNoteSettings,
  type VaultBindings,
  type VaultPolicy,
  type VaultRef,
} from "../types.js";

export type WriteVaultNoteResult =
  | { ok: true; path: string }
  | { ok: false; error: "FORBIDDEN_PATH" | "CONFLICT" | "WRITE_FAILED"; path: string };

export type AppendVaultNoteResult =
  | { ok: true; path: string; created: boolean }
  | {
      ok: false;
      error: "FORBIDDEN_PATH" | "NOT_FOUND" | "CONFLICT" | "WRITE_FAILED";
      path: string;
    };

export type VaultNoteStat = {
  path: string;
  mtime: number | null;
  size: number | null;
};

export type VaultIndexStatus = {
  indexedSeq: number;
  currentSeq: number;
  indexed: number;
  pending: number;
  fts?: { generation: string | null; rebuildAt: number | null };
};

export type FullTextSearchHit = {
  path: string;
  score: number;
  matchCount: number;
  snippets: Array<{ before: string; match: string; after: string }>;
};

export type FullTextSearchResult =
  | { status: "ready"; hits: FullTextSearchHit[]; builtAt: number; docCount: number }
  | { status: "building"; debug?: Record<string, unknown> | null };

const FTS_SNIPPETS_PER_DOC = 3;

/** Operations on one vault, with the policy's reserved paths enforced. */
export interface Vault {
  readonly ref: VaultRef;
  readonly policy: VaultPolicy;
  /** Vault-relative Markdown paths, sorted. */
  listMarkdownPaths(): Promise<string[]>;
  listNoteStats(): Promise<VaultNoteStat[]>;
  readNote(path: string): Promise<string | null>;
  /** Batch read; missing notes map to null. */
  readNotes(paths: string[]): Promise<Record<string, string | null>>;
  /**
   * Create or replace a note. `expectedBaseHash` is the sha256 of the content
   * being replaced ("" hashed for a new note); a mismatch yields CONFLICT.
   */
  writeNote(path: string, content: string, expectedBaseHash: string): Promise<WriteVaultNoteResult>;
  /**
   * Append a block to the end of a note with an optimistic lock on the content
   * that was read. `createIfMissing` also locks on the empty content, so a
   * concurrent creation is detected as CONFLICT.
   */
  appendToNote(
    path: string,
    text: string,
    options?: { createIfMissing?: boolean },
  ): Promise<AppendVaultNoteResult>;
  /** Semantic search over indexed notes. */
  search(query: string, topK: number): Promise<VectorSearchHit[]>;
  /** Exact-match full-text search. Kicks off a rebuild when no index exists yet. */
  grep(query: string, limit: number): Promise<FullTextSearchResult>;
  dailyNoteSettings(): Promise<DailyNoteSettings | undefined>;
  indexStatus(): Promise<VaultIndexStatus>;
  /** Re-scan every document (e.g. after excluded folders change). */
  reindex(): Promise<void>;
  /** Delete the database and all of its indexes. */
  purge(): Promise<void>;
  /** Whether a LiveSync client has created the database yet. */
  exists(): Promise<boolean>;
  /** Same vault without the reserved-path restriction. For host-internal use only. */
  unrestricted(): Vault;
}

export type CreateVaultOptions = {
  ref: VaultRef;
  policy: VaultPolicy;
  internalSecret: string;
};

export function createVault(bindings: VaultBindings, options: CreateVaultOptions): Vault {
  return new VaultClient(bindings, options, true);
}

class VaultClient implements Vault {
  readonly ref: VaultRef;
  readonly policy: VaultPolicy;

  constructor(
    private readonly bindings: VaultBindings,
    private readonly options: CreateVaultOptions,
    private readonly restricted: boolean,
  ) {
    this.ref = options.ref;
    this.policy = options.policy;
  }

  unrestricted(): Vault {
    return new VaultClient(this.bindings, this.options, false);
  }

  private hidden(path: string): boolean {
    return this.restricted && isReservedPath(path, this.policy.reservedPaths);
  }

  private async internalResponse(body: Record<string, unknown>): Promise<Response> {
    return vaultStub(this.bindings.vaultDb, this.ref).fetch(
      new Request("https://livesync-db/internal/op", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_SECRET_HEADER]: this.options.internalSecret,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  private async internal<T>(body: Record<string, unknown>): Promise<T> {
    const res = await this.internalResponse(body);
    if (!res.ok) throw new Error(`LiveSync vault request failed (${res.status})`);
    return (await res.json()) as T;
  }

  async exists(): Promise<boolean> {
    const res = await vaultStub(this.bindings.vaultDb, this.ref).fetch(
      new Request("https://livesync-db/", { method: "HEAD" }),
    );
    return res.status === 200;
  }

  async listMarkdownPaths(): Promise<string[]> {
    const payload = await this.internal<{ paths: string[] }>({ op: "listMarkdownPaths" });
    return payload.paths
      .filter((path) => !this.hidden(path))
      .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  }

  async listNoteStats(): Promise<VaultNoteStat[]> {
    const payload = await this.internal<{ files: VaultNoteStat[] }>({ op: "listNoteStats" });
    return payload.files.filter((file) => !this.hidden(file.path));
  }

  async readNote(path: string): Promise<string | null> {
    if (this.hidden(path)) return null;
    const payload = await this.internal<{ content: string | null }>({ op: "readNote", path });
    return payload.content;
  }

  async readNotes(paths: string[]): Promise<Record<string, string | null>> {
    const visible = paths.filter((path) => !this.hidden(path));
    const contents: Record<string, string | null> = {};
    for (const path of paths) contents[path] = null;
    if (visible.length === 0) return contents;
    const payload = await this.internal<{ contents: Record<string, string | null> }>({
      op: "readNotes",
      paths: visible,
    });
    return { ...contents, ...payload.contents };
  }

  async writeNote(
    path: string,
    content: string,
    expectedBaseHash: string,
  ): Promise<WriteVaultNoteResult> {
    if (this.hidden(path)) return { ok: false, error: "FORBIDDEN_PATH", path };
    const res = await this.internalResponse({
      op: "writeNote",
      path,
      content,
      expectedBaseHash,
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 409 && payload.error === "CONFLICT") {
      return { ok: false, error: "CONFLICT", path };
    }
    if (!res.ok) return { ok: false, error: "WRITE_FAILED", path };
    return { ok: true, path };
  }

  async appendToNote(
    path: string,
    text: string,
    options: { createIfMissing?: boolean } = {},
  ): Promise<AppendVaultNoteResult> {
    if (this.hidden(path)) return { ok: false, error: "FORBIDDEN_PATH", path };
    const current = await this.readNote(path);
    if (current == null && !options.createIfMissing) {
      return { ok: false, error: "NOT_FOUND", path };
    }
    const block = text.trim();
    const base = current?.replace(/\s+$/, "");
    const next = base ? `${base}\n\n${block}\n` : `${block}\n`;
    const result = await this.writeNote(path, next, await hashText(current ?? ""));
    if (!result.ok) return { ok: false, error: result.error, path };
    return { ok: true, path, created: current == null };
  }

  async search(query: string, topK: number): Promise<VectorSearchHit[]> {
    const hits = await vectorSearch(this.bindings, this.ref, query, topK);
    return hits.filter((hit) => !this.hidden(hit.path));
  }

  async grep(query: string, limit: number): Promise<FullTextSearchResult> {
    const result = await ftsSearch(this.bindings.bucket, this.ref, query, limit);
    if (result.status === "not-built") {
      await this.internalResponse({ op: "ftsRebuild" });
      // The last phase marker the rebuild reached; survives DO resets.
      const debug = await readFtsPhase(this.bindings.bucket, this.ref);
      return { status: "building", debug };
    }
    const hits = result.hits.filter((hit) => !this.hidden(hit.path));
    const contents = await this.readNotes(hits.map((hit) => hit.path));
    const withSnippets: FullTextSearchHit[] = hits.map((hit) => {
      const content = contents[hit.path];
      return {
        path: hit.path,
        score: hit.score,
        matchCount: hit.matches.length,
        snippets:
          content == null
            ? []
            : hit.matches
                .slice(0, FTS_SNIPPETS_PER_DOC)
                .map((match) => extractSnippet(content, match)),
      };
    });
    return {
      status: "ready",
      hits: withSnippets,
      builtAt: result.manifest.builtAt,
      docCount: result.manifest.docCount,
    };
  }

  async dailyNoteSettings(): Promise<DailyNoteSettings | undefined> {
    const payload = await this.internal<{ content: string | null }>({
      op: "readNote",
      path: ".obsidian/daily-notes.json",
    });
    if (!payload.content) return undefined;
    try {
      return JSON.parse(payload.content) as DailyNoteSettings;
    } catch {
      return undefined;
    }
  }

  indexStatus(): Promise<VaultIndexStatus> {
    return this.internal<VaultIndexStatus>({ op: "indexStatus" });
  }

  async reindex(): Promise<void> {
    await this.internalResponse({ op: "reindex" });
  }

  async purge(): Promise<void> {
    const res = await vaultStub(this.bindings.vaultDb, this.ref).fetch(
      new Request("https://livesync-db/internal/purge", {
        method: "POST",
        headers: { [INTERNAL_SECRET_HEADER]: this.options.internalSecret },
      }),
    );
    if (!res.ok) throw new Error(`LiveSync vault purge failed (${res.status})`);
  }
}
