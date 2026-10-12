// Real official LiveSync CLI/shared core ↔ real local Workers/R2/DO.
// This suite does not start Obsidian or claim renderer/plugin integration.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareCli } from './prepare-cli.mjs';
import { startBackend } from './backend.mjs';
const exec = promisify(execFile);
const evidence = resolve('.local/e2e/cli-evidence');
await mkdir(evidence, { recursive: true });
const lockPath = join(evidence, 'running.lock');
const lock = await open(lockPath, 'wx').catch((error) => {
  if (error.code === 'EEXIST')
    throw new Error(
      `E2E lock exists: ${lockPath}. Check for an active equivalent run; remove this file only after confirming the previous run stopped.`,
    );
  throw error;
});
await lock.writeFile(String(process.pid));
const result = {
  status: 'running',
  actualObsidian: false,
  realOfficialLiveSyncCli: true,
  overallObsidianE2EComplete: false,
  unfinishedAcceptance: [
    'Actual Obsidian is covered separately by test:e2e:obsidian',
  ],
  cases: [],
  commands: [],
  startedAt: new Date().toISOString(),
};
let backend, directory, cli;
const redacted = (text) =>
  backend
    ? String(text).replaceAll(backend.password, '[redacted]').replaceAll(backend.secret, '[redacted]')
    : String(text);
async function invoke(args, options = {}) {
  const command = [process.execPath, cli.executable, ...args];
  const started = Date.now();
  try {
    const output = await exec(command[0], command.slice(1), {
      cwd: cli.source,
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    result.commands.push({ args, status: 'passed', durationMs: Date.now() - started });
    return output.stdout;
  } catch (error) {
    result.commands.push({ args, status: 'failed', exitCode: error.code, durationMs: Date.now() - started });
    throw new Error(redacted(`CLI command ${args.at(-1)} failed: ${error.message}\n${error.stdout}\n${error.stderr}`));
  }
}
async function client(name, vaultId) {
  const db = join(directory, name, 'db'),
    settings = join(directory, name, 'settings.json');
  await mkdir(db, { recursive: true });
  await invoke(['init-settings', '--force', settings]);
  const data = JSON.parse(await readFile(settings, 'utf8'));
  Object.assign(data, {
    couchDB_URI: `${backend.origin}/livesync`,
    couchDB_USER: vaultId,
    couchDB_PASSWORD: backend.password,
    couchDB_DBNAME: `vault-${vaultId}`,
    remoteType: '',
    isConfigured: true,
    encrypt: false,
    liveSync: false,
    syncOnStart: false,
    syncOnSave: false,
    usePluginSync: false,
    useEden: false,
    customChunkSize: 0,
    sendChunksBulk: false,
    readChunksOnline: true,
    enableCompression: false,
  });
  await writeFile(settings, JSON.stringify(data));
  return { db, settings, run: (...args) => invoke([db, '--settings', settings, ...args]) };
}
async function fixture(client, path, bytes) {
  const source = join(directory, `source-${result.commands.length}`);
  await writeFile(source, bytes);
  await client.run('push', source, path);
}
async function expectFile(client, path, bytes) {
  const destination = join(directory, `received-${result.commands.length}`);
  await client.run('pull', path, destination);
  const received = await readFile(destination);
  assert.equal(
    createHash('sha256').update(received).digest('hex'),
    createHash('sha256').update(bytes).digest('hex'),
    `exact file bytes: ${path}`,
  );
}
async function expectMissing(client, path) {
  const listing = await client.run('ls', path);
  assert.equal(
    listing.split('\n').some((line) => line.startsWith(`${path}\t`)),
    false,
    `deleted or isolated path: ${path}`,
  );
}
async function sync(...clients) {
  for (const client of clients) await client.run('sync');
}
async function step(name, operation) {
  await operation();
  result.cases.push({ name, status: 'passed' });
  console.log(`PASS ${name}`);
}
try {
  cli = await prepareCli();
  result.officialCli = cli.receipt;
  assert.equal(cli.receipt.sharedCore, '0.1.35');
  directory = await mkdtemp(join(tmpdir(), 'livesync-cli-workers-e2e-'));
  backend = await startBackend();
  for (const id of ['a', 'b']) assert.equal((await backend.request(id, '', { method: 'PUT' })).status, 200);
  const a = await client('writer', 'a'),
    reader = await client('reader', 'a'),
    foreign = await client('foreign', 'b');
  const note = Buffer.from('# 東京 API 😀\n![原本](assets/original.pdf)\n日本語 English\n');
  const original = Buffer.from(Array.from({ length: 160_003 }, (_, i) => i % 256));
  const updated = Buffer.from(Array.from({ length: 180_011 }, (_, i) => (i * 7) % 256));
  await step('note and multi-chunk binary create → official core → Workers → independent CLI client', async () => {
    await fixture(a, '日本語.md', note);
    await fixture(a, 'assets/original.pdf', original);
    await fixture(a, 'assets/retained.png', updated);
    await sync(a, reader);
    await expectFile(reader, '日本語.md', note);
    await expectFile(reader, 'assets/original.pdf', original);
    await expectFile(reader, 'assets/retained.png', updated);
    const info = await reader.run('info', 'assets/original.pdf');
    result.binaryInfo = JSON.parse(info);
    assert.ok(result.binaryInfo.chunks > 1, 'Official splitter must produce multiple actual chunks');
  });
  await step('same paths isolated across two immutable vaults', async () => {
    await fixture(foreign, '日本語.md', Buffer.from('foreign'));
    await sync(foreign, reader);
    await expectFile(foreign, '日本語.md', Buffer.from('foreign'));
    await expectFile(reader, '日本語.md', note);
    await expectMissing(foreign, 'assets/original.pdf');
  });
  await step('note and binary updates retain exact bytes and original attachment link', async () => {
    await fixture(a, '日本語.md', Buffer.concat([note, Buffer.from('updated\n')]));
    await fixture(a, 'assets/original.pdf', updated);
    await sync(a, reader);
    await expectFile(reader, '日本語.md', Buffer.concat([note, Buffer.from('updated\n')]));
    await expectFile(reader, 'assets/original.pdf', updated);
  });
  await step('offline local write survives reconnect after Workers restart', async () => {
    await backend.pause();
    await fixture(a, 'reconnect.md', Buffer.from('offline 😀'));
    let failed = false;
    try {
      await a.run('sync');
    } catch {
      failed = true;
    }
    result.offlineSyncExitNonzero = failed;
    assert.ok(failed, 'Offline sync must fail before reconnect');
    await backend.resume();
    await sync(a, reader);
    await expectFile(reader, 'reconnect.md', Buffer.from('offline 😀'));
  });
  await step('separate CLI processes reuse persisted revision and replication checkpoints', async () => {
    // Every CLI invocation is a new Node process over the same PouchDB root.
    await fixture(a, 'reconnect.md', Buffer.from('after process restart'));
    await sync(a, reader);
    await expectFile(reader, 'reconnect.md', Buffer.from('after process restart'));
  });
  await step('note and binary deletes propagate tombstones', async () => {
    await a.run('rm', '日本語.md');
    await a.run('rm', 'assets/original.pdf');
    await sync(a, reader);
    await expectMissing(reader, '日本語.md');
    await expectMissing(reader, 'assets/original.pdf');
    const changes = await (await backend.request('a', '/_changes?include_docs=true')).json();
    result.tombstones = changes.results
      .filter((row) => row.doc?.deleted || row.deleted)
      .map((row) => ({
        id: row.id,
        couchDeleted: row.deleted === true,
        liveSyncDeleted: row.doc?.deleted === true,
        path: row.doc?.path,
      }));
    assert.ok(changes.results.some((row) => (row.deleted || row.doc?.deleted) && row.doc?.path === '日本語.md'));
    assert.ok(
      changes.results.some((row) => (row.deleted || row.doc?.deleted) && row.doc?.path === 'assets/original.pdf'),
    );
  });
  await step('SQLite/R2 persistence after compaction and backend restart reaches a fresh official CLI client', async () => {
    await backend.compact('a');
    await backend.restart();
    const fresh = await client('fresh-after-recovery', 'a');
    await sync(fresh);
    await expectFile(fresh, 'assets/retained.png', updated);
    await expectFile(fresh, 'reconnect.md', Buffer.from('after process restart'));
    await expectMissing(fresh, '日本語.md');
    await expectMissing(fresh, 'assets/original.pdf');
    await sync(foreign);
    await expectFile(foreign, '日本語.md', Buffer.from('foreign'));
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = redacted(error.message);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await backend?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  await lock.close();
  await unlink(lockPath);
}
