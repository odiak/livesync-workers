import {
  constantTimeEquals,
  createVault,
  isValidTimeZone,
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

export function requireSecret(env: Env, name: "SESSION_SECRET" | "ADMIN_PASSWORD" | "LIVESYNC_USERNAME" | "LIVESYNC_PASSWORD"): string {
  const value = env[name];
  if (!value) throw new ConfigError(`Missing secret ${name}. Set it with: wrangler secret put ${name}`);
  return value;
}

export function vaultRef(env: Env): VaultRef {
  return { tenantId: TENANT_ID, databaseName: normalizeDatabaseName(env.LIVESYNC_DATABASE) };
}

export function vaultPolicy(env: Env): VaultPolicy {
  const timeZone = env.VAULT_TIMEZONE?.trim() || "UTC";
  return {
    reservedPaths: [],
    excludedFolders: normalizeExcludedFolders((env.VAULT_EXCLUDED_FOLDERS ?? "").split(",")),
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
  };
}

export function vaultHost(env: Env): VaultHost {
  const ref = vaultRef(env);
  return {
    async verifyCredential(username, password) {
      const expectedUser = env.LIVESYNC_USERNAME;
      const expectedPass = env.LIVESYNC_PASSWORD;
      if (!expectedUser || !expectedPass) return null;
      const userOk = constantTimeEquals(username, expectedUser);
      const passOk = constantTimeEquals(password, expectedPass);
      return userOk && passOk ? ref : null;
    },
    async loadVaultPolicy() {
      return vaultPolicy(env);
    },
    internalSecret: requireSecret(env, "SESSION_SECRET"),
    allowedOrigins: (env.APP_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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
