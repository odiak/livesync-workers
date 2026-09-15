#!/usr/bin/env node
// Creates the Cloudflare resources wrangler.jsonc expects, for people deploying
// with wrangler instead of the Deploy to Cloudflare button. Idempotent.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const indexName = /"index_name":\s*"([^"]+)"/.exec(config)?.[1] ?? "livesync-notes";
const bucketName = /"bucket_name":\s*"([^"]+)"/.exec(config)?.[1] ?? "livesync-fts";

function wrangler(args, { allowExisting = true } = {}) {
  console.log(`\n$ wrangler ${args.join(" ")}`);
  const result = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.status !== 0) {
    if (allowExisting && /already exists|already_exists|409/i.test(output)) {
      console.log("(already exists, continuing)");
      return;
    }
    console.error(`wrangler exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// Dimensions must match the embedding model (embeddinggemma-300m → 768).
wrangler(["vectorize", "create", indexName, "--dimensions=768", "--metric=cosine"]);
wrangler(["r2", "bucket", "create", bucketName]);

console.log(`
Done. The KV namespace for OAuth (OAUTH_KV) is provisioned automatically on first deploy.

Next:
  1. Set secrets (see .dev.vars.example):
       npx wrangler secret put LIVESYNC_USERNAME
       npx wrangler secret put LIVESYNC_PASSWORD
       npx wrangler secret put ADMIN_PASSWORD
       npx wrangler secret put SESSION_SECRET
  2. Deploy:
       npm run deploy
`);
