import { describe, expect, it } from "vitest";
import { SETUP_URI_CLIENT_SCRIPT, type SetupConfig } from "./setup-uri.js";

type Api = {
  encodeSetupUri(config: SetupConfig, passphrase: string): Promise<string>;
  randomPassphrase(): string;
  setupSettings(config: SetupConfig): Record<string, unknown>;
};

function loadClient(): Api {
  const window: { livesyncSetupUri?: Api } = {};
  // The script is plain browser JS; run it with a bare `window` and no `document`.
  new Function("window", SETUP_URI_CLIENT_SCRIPT)(window);
  if (!window.livesyncSetupUri) throw new Error("script did not export its API");
  return window.livesyncSetupUri;
}

// Reference decryption, transcribed from decryptWithEphemeralSalt in
// octagonal-wheels (src/encryption/hkdf.ts,
// https://github.com/vrtmrz/octagonal-wheels), Copyright (c) 2024 vorotamoroz,
// MIT License. It is what the plugin uses to read a Setup URI.
async function referenceDecrypt(encrypted: string, passphrase: string): Promise<string> {
  if (!encrypted.startsWith("%$")) throw new Error("bad prefix");
  const bytes = Uint8Array.from(atob(encrypted.slice(2)), (c) => c.charCodeAt(0));
  const pbkdf2Salt = bytes.slice(0, 32);
  const iv = bytes.slice(32, 44);
  const hkdfSalt = bytes.slice(44, 76);
  const data = bytes.slice(76);
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), { name: "PBKDF2", length: 256 }, false, ["deriveKey"]);
  const master = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: pbkdf2Salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const hkdf = await crypto.subtle.importKey("raw", await crypto.subtle.exportKey("raw", master), { name: "HKDF" }, false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", salt: hkdfSalt, info: new Uint8Array(), hash: "SHA-256" },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, data));
}

const config: SetupConfig = {
  uri: "https://example.workers.dev/livesync",
  username: "obsidian",
  password: "p@ss/word+with?chars",
  database: "vault",
};

describe("Setup URI client script", () => {
  it("produces a URI the plugin's decryption routine can read", async () => {
    const api = loadClient();
    const passphrase = api.randomPassphrase();
    const uri = await api.encodeSetupUri(config, passphrase);

    expect(uri.startsWith("obsidian://setuplivesync?settings=")).toBe(true);
    const encrypted = decodeURIComponent(uri.slice("obsidian://setuplivesync?settings=".length));
    const settings = JSON.parse(await referenceDecrypt(encrypted, passphrase));
    expect(settings).toMatchObject({
      couchDB_URI: config.uri,
      couchDB_USER: config.username,
      couchDB_PASSWORD: config.password,
      couchDB_DBNAME: config.database,
      remoteType: "",
      encrypt: false,
      isConfigured: true,
    });
  });

  it("fails to decrypt with another passphrase", async () => {
    const api = loadClient();
    const uri = await api.encodeSetupUri(config, "one");
    const encrypted = decodeURIComponent(uri.slice("obsidian://setuplivesync?settings=".length));
    await expect(referenceDecrypt(encrypted, "two")).rejects.toThrow();
  });

  it("generates URL-safe passphrases of a fixed length", () => {
    const api = loadClient();
    const p = api.randomPassphrase();
    expect(p).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(api.randomPassphrase()).not.toBe(p);
  });
});
