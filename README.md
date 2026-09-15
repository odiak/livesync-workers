# livesync-workers

A [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)-compatible backend for Obsidian, with full-text and semantic search and an [MCP](https://modelcontextprotocol.io) server, running entirely on Cloudflare Workers.

Sync your vault from Obsidian the way you would to CouchDB, then let AI assistants (Claude, Cursor, Claude Code, …) read and search your notes through MCP.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/odiak/livesync-workers)

> This is an independent project. It is not affiliated with the Self-hosted LiveSync plugin or its author.
> It implements the subset of the CouchDB API that the plugin uses, not CouchDB in general.

Built for [Kuro](https://usekuro.app). Available to everyone.

## What you get

- **LiveSync endpoint** (`/livesync`): the CouchDB-compatible API the plugin talks to. Your vault lives in a SQLite-backed Durable Object; no CouchDB server to run.
- **Search indexes**, kept up to date as notes sync:
  - full-text (exact match; character bigrams for Japanese/CJK, words for ASCII) stored in R2,
  - semantic (Workers AI embeddings + Vectorize).
- **MCP endpoint** (`/mcp`) with OAuth, exposing 11 tools:
  `listDirectory`, `listNotes`, `listRecentNotes`, `readNote`, `readDailyNote`, `searchNotes`, `grepNotes`, `vaultStatus` (read),
  `appendToDailyNote`, `appendToNote` (append), `writeNote` (write, with conflict detection).
- A small status page at `/` with your connection details.

Notes written through MCP are regular LiveSync revisions, so they show up in Obsidian on the next sync.

## Deploy

### Option A: Deploy to Cloudflare button

1. Click the button above. Cloudflare clones this repository into your GitHub/GitLab account and connects it to Workers Builds. Tick **Create private Git repository** if you would rather not publish your copy (it contains no secrets either way).
2. For the **Vectorize index**, enter **768** dimensions and **cosine** metric (the embedding model requires them). Keep the other resources as proposed.
3. Fill in the secrets. The fields start empty; the form shows what each one is for.
   - `LIVESYNC_PASSWORD`: what the Obsidian plugin will log in with (the username is the `LIVESYNC_USERNAME` variable, `obsidian` by default).
   - `ADMIN_PASSWORD`: for the admin login on the status page and when authorizing MCP clients.
   - `SESSION_SECRET`: any long random string, e.g. `openssl rand -hex 32`.
4. Deploy. Durable Objects, KV, R2, Workers AI and Vectorize are created for you.
5. Open your Worker's URL. The page shows the LiveSync URI, database name and MCP URL, and warns if a secret is still missing.

Later pushes to your copy of the repository redeploy automatically.

### Option B: wrangler

```sh
git clone https://github.com/odiak/livesync-workers.git
cd livesync-workers
npm install
npm run setup            # creates the Vectorize index and R2 bucket
npx wrangler secret put LIVESYNC_PASSWORD
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run build && npm run deploy
```

`build` and `deploy` are separate scripts on purpose: Workers Builds runs `build` and then either `deploy` (production) or `wrangler preview` (preview builds).

The KV namespace for OAuth is provisioned automatically on the first deploy.

### Requirements and cost

A Cloudflare account with Workers enabled. The Worker uses Durable Objects (SQLite), R2, KV, Vectorize and Workers AI; all have free tiers, but R2 needs a payment method on the account and usage beyond the free tiers is billed by Cloudflare. Embeddings are computed once per changed note.

## Connect Obsidian

In Self-hosted LiveSync's setup:

| Setting | Value |
|---|---|
| Remote Type | CouchDB |
| URI | `https://<your-worker>.workers.dev/livesync` |
| Database name | `vault` (the `LIVESYNC_DATABASE` var) |
| Username / Password | the `LIVESYNC_USERNAME` variable (`obsidian` by default) / your `LIVESYNC_PASSWORD` secret |
| End-to-End Encryption | **off** |

E2EE must stay off: the server has to read note contents to index them and serve them over MCP. The status page at `/` shows these values (sign in with the admin password to see the username).

## Connect an MCP client

Point the client at `https://<your-worker>.workers.dev/mcp` (Streamable HTTP). It will open a browser window; sign in with `ADMIN_PASSWORD` and choose which scopes to grant:

| Scope | Default | Tools |
|---|---|---|
| `vault:read` | always | listDirectory, listNotes, listRecentNotes, readNote, readDailyNote, searchNotes, grepNotes, vaultStatus |
| `vault:append` | off | appendToDailyNote, appendToNote |
| `vault:write` | off | writeNote |

Clients that cannot do OAuth can send `Authorization: Bearer <MCP_STATIC_TOKEN>` instead once you add that secret (`wrangler secret put MCP_STATIC_TOKEN`, or in the dashboard under Settings → Variables and Secrets). The token grants `vault:read` only; add `vault:append` and/or `vault:write` through the `MCP_STATIC_TOKEN_SCOPES` variable. Tools apply the same scope checks as for OAuth grants.

## Configuration

Variables (in `wrangler.jsonc` `vars`, editable in the dashboard):

| Variable | Default | Meaning |
|---|---|---|
| `LIVESYNC_DATABASE` | `vault` | CouchDB database name the plugin connects to |
| `LIVESYNC_USERNAME` | `obsidian` | Username the plugin logs in with |
| `VAULT_EXCLUDED_FOLDERS` | (not set) | Comma-separated folders left out of the search indexes (still readable), e.g. `Templates,Archive` |
| `MCP_STATIC_TOKEN_SCOPES` | (not set) | Extra scopes for the static token, e.g. `vault:append,vault:write` |

The "not set" ones are optional and deliberately absent from `wrangler.jsonc`, because every `vars` entry becomes a required field in the Deploy form. Add them in the dashboard (Settings → Variables and Secrets) or to `vars` when you need them.

Secrets: `LIVESYNC_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and optionally `MCP_STATIC_TOKEN` (not in `.dev.vars.example`, since every entry there becomes a required field in the Deploy form). Empty values and `change-me…` placeholders count as unset; the status page tells you which ones are missing.

`/livesync` accepts requests from any origin (authentication is HTTP Basic, so there is nothing for a cross-site page to hijack). Daily notes: `appendToDailyNote` takes the date from the client; without one it falls back to today in UTC.

## How it works

```
Obsidian ──LiveSync (CouchDB API)──▶ Worker ──▶ VaultDO (Durable Object, SQLite)
                                                   │ alarm: index changed notes
                                                   ├──▶ Vectorize (Workers AI embeddings)
                                                   └──▶ R2 (full-text index generations)
MCP client ──OAuth──▶ Worker ──▶ VaultMCP (McpAgent) ──▶ vault client ──▶ VaultDO / Vectorize / R2
```

- Longpoll and continuous `_changes` feeds are waited on in the Worker over a hibernatable WebSocket, so the Durable Object sleeps between writes.
- The full-text index is rebuilt in full (debounced 5 minutes after the last change) as immutable generations in R2.
- Vectors live in a Vectorize namespace per vault.

## Using it as a library

The `livesync-workers` npm package (in [`packages/livesync-workers`](packages/livesync-workers)) is what this Worker is built on. A multi-tenant host implements `VaultHost` (credential verification and per-vault policy) and subclasses `LiveSyncVaultDO`; see [`docs/embedding.md`](docs/embedding.md).

## Development

```sh
npm install
npm test          # library unit tests
npm run typecheck
npm run dev       # wrangler dev (needs a Cloudflare login for AI/Vectorize)
```

## License

[MIT](LICENSE)
