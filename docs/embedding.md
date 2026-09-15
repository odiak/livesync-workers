# Embedding livesync-workers in your own Worker

The root of this repository is a single-tenant deployment. The same code is
published as the `livesync-workers` npm package so that a multi-tenant service
can host many vaults with its own user management.

## Pieces

| Import | What |
|---|---|
| `livesync-workers` | `LiveSyncVaultDO` (Durable Object base class), `handleLiveSyncRequest`, `createVault`, types, helpers |
| `livesync-workers/mcp` | `registerVaultTools(server, ctx)` and the vault scope constants (peer: `@modelcontextprotocol/sdk`, `zod`) |
| `livesync-workers/oauth` | `createVaultOAuthProvider` (peer: `@cloudflare/workers-oauth-provider`) |

## 1. Implement `VaultHost`

```ts
import type { VaultHost, VaultRef } from "livesync-workers";

export function myHost(env: Env): VaultHost {
  return {
    // Basic auth from the LiveSync plugin → which vault it grants.
    async verifyCredential(username, password): Promise<VaultRef | null> {
      const row = await lookupCredential(env.DB, username, password);
      return row ? { tenantId: row.userId, databaseName: row.databaseName } : null;
    },
    // Called from the Worker and from the Durable Object alarm.
    async loadVaultPolicy(ref) {
      return {
        reservedPaths: [".myapp"],           // hidden from MCP and the vault client
        excludedFolders: await excludedFolders(env.DB, ref.tenantId),
        timeZone: await userTimeZone(env.DB, ref.tenantId),
      };
    },
    internalSecret: env.INTERNAL_SECRET,
    allowedOrigins: [],
    serverName: "my-service",
  };
}
```

## 2. Provide bindings

```ts
import { workersAiEmbedder, type VaultBindings } from "livesync-workers";

export function myBindings(env: Env): VaultBindings {
  return {
    vaultDb: env.VAULT_DB,
    vectorize: env.VECTORIZE,
    bucket: env.FTS_BUCKET,
    embedder: workersAiEmbedder(env.AI),
    vectorIsolation: "namespace", // or "metadata" (needs a metadata index on userId)
  };
}
```

## 3. Export the Durable Object

```ts
import { LiveSyncVaultDO } from "livesync-workers";

export class VaultDO extends LiveSyncVaultDO<Env> {
  protected host() { return myHost(this.env); }
  protected bindings() { return myBindings(this.env); }
}
```

Bind it as a SQLite-backed class (`new_sqlite_classes`). The object name is
`${tenantId}:${databaseName}`; the class recovers the vault from it.

## 4. Route LiveSync traffic

```ts
if (url.pathname.startsWith("/livesync")) {
  return handleLiveSyncRequest(request, { host: myHost(env), bindings: myBindings(env) });
}
```

## 5. Use the vault client

```ts
const vault = createVault(myBindings(env), {
  ref: { tenantId: user.id, databaseName },
  policy: await myHost(env).loadVaultPolicy(ref),
  internalSecret: env.INTERNAL_SECRET,
});
await vault.readNote("Projects/Plan.md");
await vault.search("meeting notes", 8);
vault.unrestricted(); // same vault without reservedPaths filtering, for host-internal use
```

## 6. MCP tools

```ts
registerVaultTools(this.server, {
  vault: async () => (await hasVault(userId)) ? vaultFor(userId) : null,
  hasScope: (scope) => this.props.scope.includes(scope),
});
// add your own tools to the same server
```

`createVaultOAuthProvider` gives you the consent page and OAuth endpoints; pass
`authenticate` (your session lookup) and `loginRedirect`, and extend `scopes`
with any of your own.
