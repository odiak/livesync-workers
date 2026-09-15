import { escapeHtml, htmlPage } from "livesync-workers/oauth";
import type { VaultIndexStatus } from "livesync-workers";
import { type Env } from "./env.js";
import { vaultPolicy, vaultRef } from "./host.js";

const TITLE = "livesync-workers";

export function loginPage(next: string, error?: string): Response {
  return htmlPage(
    `${TITLE} — Sign in`,
    `<div class="card"><h1>Sign in</h1><p class="muted">Enter the admin password (the <code>ADMIN_PASSWORD</code> secret).</p>${
      error ? `<p style="color:#b91c1c">${escapeHtml(error)}</p>` : ""
    }<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(
      next,
    )}"><label for="password">Password</label><input id="password" type="password" name="password" autofocus required><p><button type="submit">Sign in</button></p></form></div>`,
    error ? 401 : 200,
  );
}

export type StatusPageData = {
  origin: string;
  admin: boolean;
  configured: { livesync: boolean; admin: boolean; session: boolean };
  username?: string;
  dbExists?: boolean;
  index?: VaultIndexStatus | null;
  indexError?: string;
};

export function statusPage(env: Env, data: StatusPageData): Response {
  const ref = vaultRef(env);
  const policy = vaultPolicy(env);
  const missing = Object.entries(data.configured)
    .filter(([, ok]) => !ok)
    .map(
      ([key]) =>
        ({ livesync: "LIVESYNC_USERNAME / LIVESYNC_PASSWORD", admin: "ADMIN_PASSWORD", session: "SESSION_SECRET" })[
          key
        ] ?? key,
    );
  const warn =
    missing.length > 0
      ? `<div class="card" style="border-color:#f59e0b"><h2>Setup incomplete</h2><p>Missing secrets: <code>${missing
          .map(escapeHtml)
          .join("</code>, <code>")}</code>.</p><p class="muted">Set them with <code>wrangler secret put NAME</code> (or in the Cloudflare dashboard under Settings → Variables and Secrets), then reload.</p></div>`
      : "";
  const indexHtml = data.admin
    ? data.indexError
      ? `<p class="muted">Index status unavailable: ${escapeHtml(data.indexError)}</p>`
      : data.dbExists === false
        ? `<p class="muted">No database yet. Once Obsidian completes its first sync it will show up here.</p>`
        : data.index
          ? `<table><tr><th>Vector index</th><td>${data.index.indexed} notes indexed, ${data.index.pending} pending (seq ${data.index.indexedSeq}/${data.index.currentSeq})</td></tr><tr><th>Full-text index</th><td>${
              data.index.fts?.generation ? `generation ${escapeHtml(data.index.fts.generation)}` : "not built yet"
            }${data.index.fts?.rebuildAt ? ` · rebuild scheduled ${new Date(data.index.fts.rebuildAt).toISOString()}` : ""}</td></tr></table>`
          : ""
    : "";
  const adminBlock = data.admin
    ? `<p class="muted">Signed in as admin · <form method="post" action="/logout" style="display:inline"><button type="submit" style="background:#6b7280;padding:4px 12px">Sign out</button></form></p>`
    : `<p><a class="button" href="/login?next=%2F">Sign in as admin</a> <span class="muted">to see the username and index status.</span></p>`;

  return htmlPage(
    TITLE,
    `<h1>${TITLE}</h1><p>A <a href="https://github.com/vrtmrz/obsidian-livesync">Self-hosted LiveSync</a>-compatible backend with search and MCP, running on Cloudflare Workers.</p>${warn}
<div class="card"><h2>Obsidian → Self-hosted LiveSync</h2><table>
<tr><th>Remote Type</th><td>CouchDB</td></tr>
<tr><th>URI</th><td><code>${escapeHtml(data.origin)}/livesync</code></td></tr>
<tr><th>Database name</th><td><code>${escapeHtml(ref.databaseName)}</code></td></tr>
<tr><th>Username</th><td>${data.username ? `<code>${escapeHtml(data.username)}</code>` : '<span class="muted">(sign in to view)</span>'}</td></tr>
<tr><th>Password</th><td><span class="muted">the <code>LIVESYNC_PASSWORD</code> secret</span></td></tr>
<tr><th>End-to-End Encryption</th><td><strong>off</strong> (the server must read notes to index them)</td></tr>
</table></div>
<div class="card"><h2>MCP</h2><table>
<tr><th>Endpoint</th><td><code>${escapeHtml(data.origin)}/mcp</code></td></tr>
<tr><th>Auth</th><td>OAuth (sign in with the admin password when the client asks)${env.MCP_STATIC_TOKEN ? ", or <code>Authorization: Bearer &lt;MCP_STATIC_TOKEN&gt;</code> (read-only unless <code>MCP_STATIC_TOKEN_SCOPES</code> adds more)" : ""}</td></tr>
<tr><th>Tools</th><td>listDirectory, listNotes, listRecentNotes, readNote, readDailyNote, searchNotes, grepNotes, vaultStatus, appendToDailyNote, appendToNote, writeNote</td></tr>
<tr><th>Time zone</th><td><code>${escapeHtml(policy.timeZone)}</code></td></tr>
</table></div>
<div class="card"><h2>Status</h2>${adminBlock}${indexHtml}</div>`,
  );
}
