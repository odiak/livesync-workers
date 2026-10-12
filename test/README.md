# Quality checks

- `npm test`: Node SQLite regressions, protocol, search, auth and MCP tools/list.
- `npm run test:workers`: actual local workerd, SQLite, R2 and alarms, including failed writes, restart and CAS.
- `npm run test:e2e:cli`: pinned official LiveSync CLI against temporary, loopback-only Workers with persistent SQLite/R2. No Cloudflare account or production bindings.
- `npm run test:e2e:install && npm run test:e2e:plugin`: checksum-pinned Linux Obsidian/plugin downloads.
- `npm run test:e2e:obsidian`: actual Obsidian sessions; requires a supported sandbox/display and OBSIDIAN_BINARY/OBSIDIAN_CLI. CI runs a separate Ubuntu GUI job. Manual replication covers real plugin integration, not continuous/mobile/background sync.
- `npm run test:performance`: deterministic corpus in workerd, SQLite and R2 variants, fixed 2ms simulated R2 latency, shared leaf chunks, metadata filtering, full indexing and reopening. Output: `.local/benchmarks/latest.json` (versions, lockfile hash, revision, dirty flag, phase durations, R2 operations and SQLite rows/bytes). Compare multiple runs on the same machine and runtime; local timing is not production latency. The benchmark asserts correctness/operation bounds rather than flaky timing thresholds.

HTTP limits are defined in `src/livesync/limits.ts` in the library: 16 MiB request, 4 MiB document, 1000 documents per bulk, 4096 keyed all_docs entries and 16 MiB response. Actual UTF-8 stream bytes are counted. Initial changes with selectors/bodies use at most 128 returned rows and an 8 MiB body budget; large keyed all_docs calls are split at the Worker boundary. No storage layout migration is introduced.

External full-text adapters must make close() durable before resolving. Optional indexVersion/beginRebuild/completeRebuild support retaining the old generation during rebuild; hooks must be idempotent. Include contentHash in hits for source validation. Implement searchWithOptions to filter and validate before top-K; legacy search adapters are queried with growing prefixes capped at 1024 candidates, so very large filtered result sets can be incomplete (`incomplete: true` in the result). Missing content hashes cannot detect edits to an existing note.

Structured `LiveSync performance` events contain counts and phase durations, never note bodies or credentials. Authentication failure limits are per IP and surface; Cloudflare's rate limiting/KV is eventually consistent. Successful synchronization does not consume the failure budget.

The E2E fixtures and helper patterns were adapted from hayatosc/livesync-workers at 7ab81c78ecd402969041a4dc515675f8ac06059d (MIT). Tests intentionally retain this project's SQLite authority; deleting SQLite is not a supported recovery operation.
