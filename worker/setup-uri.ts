/**
 * Browser-side generator for a Self-hosted LiveSync "Setup URI".
 *
 * The plugin's "Use Setup URI" option accepts
 *   obsidian://setuplivesync?settings=<encodeURIComponent(encrypted JSON)>
 * where the JSON is the plugin's settings object and the encryption is
 * octagonal-wheels' encryptWithEphemeralSalt:
 *   "%$" + base64( pbkdf2Salt(32) | iv(12) | hkdfSalt(32) | AES-GCM ciphertext )
 *   key  = HKDF-SHA256(salt = hkdfSalt, ikm = PBKDF2-SHA256(passphrase, pbkdf2Salt, 310000 iterations))
 *
 * It runs in the admin's browser rather than in the Worker because Workers cap
 * PBKDF2 iterations below what the plugin uses. The Worker only hands the
 * connection details to the page (see /api/setup-config).
 */

export type SetupConfig = {
  /** CouchDB-compatible endpoint, e.g. https://x.workers.dev/livesync */
  uri: string;
  username: string;
  password: string;
  database: string;
};

/** Element ids the script expects on the status page. */
export const SETUP_URI_IDS = {
  button: "setup-uri-generate",
  result: "setup-uri-result",
  uri: "setup-uri-value",
  passphrase: "setup-uri-passphrase",
  error: "setup-uri-error",
} as const;

export const SETUP_URI_CLIENT_SCRIPT = String.raw`
(() => {
  const PREFIX = "%$";
  const URI_BASE = "obsidian://setuplivesync?settings=";
  const enc = new TextEncoder();

  function base64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function randomPassphrase() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function deriveKey(passphrase, pbkdf2Salt, hkdfSalt) {
    const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), { name: "PBKDF2", length: 256 }, false, ["deriveKey"]);
    const master = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: pbkdf2Salt, iterations: 310000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const raw = await crypto.subtle.exportKey("raw", master);
    const hkdf = await crypto.subtle.importKey("raw", raw, { name: "HKDF" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", salt: hkdfSalt, info: new Uint8Array(), hash: "SHA-256" },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function encryptWithEphemeralSalt(text, passphrase) {
    const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveKey(passphrase, pbkdf2Salt, hkdfSalt);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, enc.encode(text)));
    const out = new Uint8Array(32 + 12 + 32 + data.length);
    out.set(pbkdf2Salt, 0);
    out.set(iv, 32);
    out.set(hkdfSalt, 44);
    out.set(data, 76);
    return PREFIX + base64(out);
  }

  // Mirrors the plugin's own generator (utils/setup/generate_setup_uri.ts in
  // obsidian-livesync) for a self-hosted CouchDB, with end-to-end encryption
  // off because this server has to read notes to index them.
  function setupSettings(c) {
    return {
      remoteType: "",
      couchDB_URI: c.uri,
      couchDB_USER: c.username,
      couchDB_PASSWORD: c.password,
      couchDB_DBNAME: c.database,
      isConfigured: true,
      encrypt: false,
      passphrase: "",
      usePathObfuscation: false,
      batchSave: true,
      periodicReplication: true,
      syncOnStart: true,
      syncOnFileOpen: true,
      syncAfterMerge: true,
      syncMaxSizeInMB: 50,
      chunkSplitterVersion: "v3-rabin-karp",
      doNotUseFixedRevisionForChunks: false,
      usePluginSyncV2: true,
      handleFilenameCaseSensitive: false,
      E2EEAlgorithm: "v2",
      customChunkSize: 50,
      sendChunksBulkMaxSize: 1,
      concurrencyOfReadChunksOnline: 30,
      minimumIntervalOfReadChunksOnline: 25,
      configPassphraseStore: "",
      encryptedCouchDBConnection: "",
      encryptedPassphrase: "",
    };
  }

  async function encodeSetupUri(config, passphrase) {
    const encrypted = await encryptWithEphemeralSalt(JSON.stringify(setupSettings(config)), passphrase);
    return URI_BASE + encodeURIComponent(encrypted);
  }

  const api = { encodeSetupUri, randomPassphrase, setupSettings, encryptWithEphemeralSalt };
  if (typeof window !== "undefined") window.livesyncSetupUri = api;
  if (typeof document === "undefined") return;

  const $ = (id) => document.getElementById(id);
  const button = $("${SETUP_URI_IDS.button}");
  if (!button) return;

  async function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  for (const el of document.querySelectorAll("[data-copy]")) {
    el.addEventListener("click", async () => {
      const source = $(el.getAttribute("data-copy"));
      if (!source) return;
      const label = el.textContent;
      try {
        await copy(source.value);
        el.textContent = "Copied";
      } catch {
        source.select();
        el.textContent = "Press Ctrl/Cmd+C";
      }
      setTimeout(() => { el.textContent = label; }, 1500);
    });
  }

  button.addEventListener("click", async () => {
    const error = $("${SETUP_URI_IDS.error}");
    const result = $("${SETUP_URI_IDS.result}");
    error.hidden = true;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Generating…";
    try {
      const res = await fetch("/api/setup-config", { credentials: "same-origin" });
      if (!res.ok) throw new Error("Could not load connection details (HTTP " + res.status + "). Sign in again and retry.");
      const config = await res.json();
      const passphrase = randomPassphrase();
      $("${SETUP_URI_IDS.uri}").value = await encodeSetupUri(config, passphrase);
      $("${SETUP_URI_IDS.passphrase}").value = passphrase;
      result.hidden = false;
    } catch (e) {
      error.textContent = e && e.message ? e.message : String(e);
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
})();
`;
