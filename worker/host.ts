import {
  constantTimeEquals,
  createVault,
  normalizeDatabaseName,
  normalizeExcludedFolders,
  workersAiEmbedder,
  type Vault,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "livesync-workers";
import { TENANT_ID, type Env } from "./env.js";

export class ConfigError extends Error {}

export type SecretName = "SESSION_SECRET" | "ADMIN_PASSWORD" | "LIVESYNC_PASSWORD";

/**
 * Whether a secret is usable. Empty values and the "change-me…" placeholders that
 * older .dev.vars.example files shipped are treated as unset, so a deploy that kept
 * them does not silently run with a well-known password.
 */
export function secretValue(env: Env, name: SecretName): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^change[-_ ]?me/i.test(value)) return undefined;
  return value;
}

export function requireSecret(env: Env, name: SecretName): string {
  const value = secretValue(env, name);
  if (!value) throw new ConfigError(`Missing secret ${name}. Set it with: wrangler secret put ${name}`);
  return value;
}

export const DEFAULT_LIVESYNC_USERNAME = "obsidian";

export function liveSyncUsername(env: Env): string {
  return env.LIVESYNC_USERNAME?.trim() || DEFAULT_LIVESYNC_USERNAME;
}

export function vaultRef(env: Env): VaultRef {
  return { tenantId: TENANT_ID, databaseName: normalizeDatabaseName(env.LIVESYNC_DATABASE) };
}

export function vaultPolicy(env: Env): VaultPolicy {
  return {
    reservedPaths: [],
    excludedFolders: normalizeExcludedFolders((env.VAULT_EXCLUDED_FOLDERS ?? "").split(",")),
    // Only used to pick "today" when appendToDailyNote gets no date; clients are told to pass one.
    timeZone: "UTC",
  };
}

export function vaultHost(env: Env): VaultHost {
  const ref = vaultRef(env);
  return {
    async verifyCredential(username, password) {
      const expectedUser = liveSyncUsername(env);
      const expectedPass = secretValue(env, "LIVESYNC_PASSWORD");
      if (!expectedPass) return null;
      const userOk = constantTimeEquals(username, expectedUser);
      const passOk = constantTimeEquals(password, expectedPass);
      return userOk && passOk ? ref : null;
    },
    async loadVaultPolicy() {
      return vaultPolicy(env);
    },
    internalSecret: requireSecret(env, "SESSION_SECRET"),
    // Library default: the Obsidian app origins plus this Worker's own origin.
    // Echoing any Origin with credentials would let a page on another site read
    // the vault with Basic credentials the browser has cached for /livesync.
    serverName: "livesync-workers",
  };
}

export function vaultBindings(env: Env): VaultBindings {
  return {
    vaultDb: env.VAULT_DB,
    vectorize: env.VECTORIZE,
    bucket: env.FTS_BUCKET,
    embedder: workersAiEmbedder(env.AI),
    vectorIsolation: "namespace",
  };
}

export function vaultFor(env: Env): Vault {
  return createVault(vaultBindings(env), {
    ref: vaultRef(env),
    policy: vaultPolicy(env),
    internalSecret: requireSecret(env, "SESSION_SECRET"),
  });
}
