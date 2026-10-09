# R2 chunk body storage

`VaultBindings.chunkBucket` enables R2 storage for every newly written, non-deleted
LiveSync `leaf` revision whose serialized JSON body reaches
`chunkBodyThresholdBytes` (default 65,536 UTF-8 bytes). Smaller bodies and file
metadata remain in SQLite. There is no per-vault enable switch. Omitting the
binding retains the SQLite-only mode for hosts that have never externalized data.
Keep the binding once any bodies have moved: it is required for reads and deletion.

```ts
return {
  vaultDb: env.VAULT_DB,
  bucket: env.FTS_BUCKET,
  chunkBucket: env.FTS_BUCKET,
  chunkBodyThresholdBytes: 64 * 1024,
};
```

One immutable object stores one revision's JSON body, without decoding Base64 or
applying new compression. Keys use
`chunks/{encoded tenantId}/{encoded databaseName}/{hash of id and rev}/{body hash}`.
The bucket may be shared with FTS; their prefixes are separate. Do not apply
expiry lifecycle rules to `chunks/`. R2 access stays behind the authenticated
LiveSync/host APIs.

`chunk_body_refs` maps `(id, rev)` to an object key; `chunk_objects` tracks object
bytes, including pending uploads and deletions. SHA-256-checked R2 PUT completes
before the revision and reference are committed together. Reads return the same
CouchDB document through GET, open revisions, bulk get, all docs, changes and find.
Note reconstruction and indexing also read external chunks. A missing external
body produces an error rather than a successful empty document.

Vault operations, including alarms, use an operation queue across asynchronous
storage I/O. R2 reads within a response run in batches of eight. This preserves
sequence allocation, optimistic writes and deletion ordering. A large request
can delay other requests to the same vault; benchmark real vault traffic before
raising request sizes or lowering the storage threshold substantially.

## Existing data

The host administrator calls `/internal/chunk-storage` with
`X-LiveSync-Internal: <host.internalSecret>`:

- GET returns storage totals, the effective threshold, cumulative inline-body
  size distribution, remaining migration candidates and persisted progress.
- POST starts or resumes migration and arms the Durable Object alarm. It does
  not affect the policy for new writes. Repeating it while running is idempotent.

Migration applies the current threshold to retained, non-tombstone leaf revision
bodies, including history. Each alarm moves at most eight bodies, stopping after
8 MiB (an individual larger body is processed on its own). The R2 body is read
back and compared before a SQLite transaction switches the reference, removes
the inline/split body and records progress. Document IDs, revisions and changes
sequences are untouched. Alarms continue after the UI closes or the object is
evicted. A caught failure records `failed` and waits for POST to resume.

Migration is not garbage collection. File deletion does not delete shared
chunks. Existing CouchDB compaction semantics determine when a revision body can
be discarded; unreferenced tracked objects are then removed in bounded alarm
batches. Database/account purge also lists and deletes the vault's entire chunk
prefix, including orphaned uploads. A partial chunk purge keeps a deletion marker,
rejects ordinary access and can be completed by retrying the purge.

Hosts enforcing quotas should add `chunkStorageBytes()` to SQLite storage usage.
This counts tracked R2 objects until their deletion succeeds. Migration can
transiently hold both copies. SQLite file allocation may not immediately shrink
when rows are removed, so migrated bytes are not a promise of an equal immediate
reduction in billed SQLite size.

Deploy reader support before migrating. After migration or the first external
write, rolling back to code without R2 readers is unsafe. Backups/recovery must
cover both SQLite and R2; SQLite point-in-time recovery alone cannot restore an
R2 object already deleted by compaction. Reverse migration is not implemented.
