# Upgrading

## If you deployed with the Deploy to Cloudflare button

The button does not fork this repository. It creates an independent copy under your
GitHub/GitLab account, with `wrangler.jsonc` rewritten to point at the resources it
created for you (bucket and index names, binding ids). Your copy does not receive
updates on its own, so pull them in with git:

```sh
git clone <your copy>
cd <your copy>
git remote add upstream https://github.com/odiak/livesync-workers.git
git fetch upstream
git merge upstream/main
```

Then push. Workers Builds redeploys on every push to your production branch.

### What conflicts

Almost only `wrangler.jsonc`. The button edits that file (resource names, ids,
`vars` you changed), while upstream changes code under `worker/` and
`packages/`, which your copy never touches. When `wrangler.jsonc` conflicts,
keep **your** side and re-apply upstream's change by hand if it added a new
binding or variable; the release notes say when that happens.

```sh
git checkout --ours wrangler.jsonc
# then add anything new from `git show upstream/main:wrangler.jsonc`
git add wrangler.jsonc
git commit
```

Secrets live in Cloudflare, not in the repository, so they survive upgrades.
If an upgrade needs a new secret or variable, add it in the dashboard under
Settings → Variables and Secrets.

### Durable Object migrations

Upstream ships schema changes as new entries in the `migrations` list in
`wrangler.jsonc`. Keep the whole list from upstream in order; Cloudflare applies
only the tags it has not seen for your Worker.

## If you deployed with wrangler

Your clone tracks this repository directly:

```sh
git pull
npm install
npm run build && npm run deploy
```

New secrets or variables are announced in the release notes; set them with
`wrangler secret put NAME` or in the dashboard before deploying.

## If you embed the library

Bump `livesync-workers` in your `package.json` and read the changelog for
breaking changes to `VaultHost`, `VaultPolicy` or the MCP tool surface.
