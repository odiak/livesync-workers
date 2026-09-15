export * from "./types.js";
export { LiveSyncVaultDO, splitRevisionBody, splitNoteContentForChunks } from "./durable/livesync-db.js";
export { handleLiveSyncRequest, vaultStub, type LiveSyncHandlerOptions } from "./livesync/handler.js";
export { INTERNAL_SECRET_HEADER } from "./livesync/http.js";
export {
  createVault,
  type Vault,
  type CreateVaultOptions,
  type VaultNoteStat,
  type VaultIndexStatus,
  type WriteVaultNoteResult,
  type AppendVaultNoteResult,
  type FullTextSearchHit,
  type FullTextSearchResult,
} from "./vault/client.js";
export {
  inferDailyNotePath,
  listVaultDirectory,
  listDailyNotePaths,
  normalizeExcludedFolders,
  type VaultDirectoryEntry,
  type DailyNotePath,
} from "./vault/paths.js";
export { chunkMarkdown, hashText, type MarkdownChunk } from "./search/chunk-md.js";
export {
  workersAiEmbedder,
  DEFAULT_WORKERS_AI_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from "./search/embedder.js";
export { type VectorSearchHit } from "./search/vector-index.js";
export * from "./credentials.js";
