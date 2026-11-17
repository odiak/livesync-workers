import { vi } from "vitest";
import {
  DEFAULT_VAULT_POLICY,
  LiveSyncVaultDO,
  workersAiEmbedder,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "../src/index.js";

export const TEST_SECRET = "test-secret";

export type TestEnv = {
  policy: VaultPolicy;
  ftsMaxTotalCodeUnits?: number;
  /** false leaves vectorize/embedder out of the bindings (semantic search off). */
  semanticSearch?: boolean;
  AI: { run: ReturnType<typeof vi.fn> };
  VECTORIZE: { upsert: ReturnType<typeof vi.fn>; deleteByIds: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  FTS_BUCKET: R2Bucket;
  VAULT_DB: DurableObjectNamespace;
  upserted: VectorizeVector[];
  deletedIds: string[];
};

export function testEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const upserted: VectorizeVector[] = [];
  const deletedIds: string[] = [];
  return {
    policy: { ...DEFAULT_VAULT_POLICY },
    AI: {
      run: vi.fn(async (_model: string, input: { input: string[] }) => ({
        data: input.input.map((_, index) => ({ index, embedding: [index, 1] })),
      })),
    },
    VECTORIZE: {
      upsert: vi.fn(async (vectors: VectorizeVector[]) => {
        upserted.push(...vectors);
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        deletedIds.push(...ids);
      }),
      query: vi.fn(async () => ({ matches: [] })),
    },
    FTS_BUCKET: { put: vi.fn(async () => null), get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })), delete: vi.fn(async () => {}) } as unknown as R2Bucket,
    VAULT_DB: {} as DurableObjectNamespace,
    upserted,
    deletedIds,
    ...overrides,
  };
}

export function testHost(env: TestEnv, ref?: VaultRef): VaultHost {
  return {
    async verifyCredential(username, password) {
      return username === "sync-user" && password === "sync-pass" && ref ? ref : null;
    },
    async loadVaultPolicy() {
      return env.policy;
    },
    internalSecret: TEST_SECRET,
  };
}

export function testBindings(env: TestEnv): VaultBindings {
  return {
    vaultDb: env.VAULT_DB,
    bucket: env.FTS_BUCKET,
    ...(env.semanticSearch === false
      ? {}
      : {
          vectorize: env.VECTORIZE as unknown as VectorizeIndex,
          embedder: workersAiEmbedder(env.AI as unknown as Ai),
        }),
    vectorIsolation: "metadata",
    ...(env.ftsMaxTotalCodeUnits !== undefined ? { ftsMaxTotalCodeUnits: env.ftsMaxTotalCodeUnits } : {}),
  };
}

export class TestVaultDO extends LiveSyncVaultDO<TestEnv> {
  protected host(): VaultHost {
    return testHost(this.env);
  }
  protected bindings(): VaultBindings {
    return testBindings(this.env);
  }
}

/** Minimal in-memory stand-in for the FTS R2 bucket binding. */
export function memoryBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, body: Uint8Array | string) {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const whole = store.get(key);
      if (!whole) return null;
      const range = options?.range;
      const body = range ? whole.subarray(range.offset, range.offset + range.length) : whole;
      return {
        arrayBuffer: async () => body.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(body)),
      };
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys: string[] | string) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}
