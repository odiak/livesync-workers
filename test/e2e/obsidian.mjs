import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createTemporaryVault,
  startObsidianPluginSession,
  requireObsidianBinary,
  requireObsidianCli,
  withObsidianPage,
} from '@vrtmrz/obsidian-test-session';
import { CURRENT_SETTING_VERSION } from '@vrtmrz/livesync-commonlib/compat/common/models/setting.const';
import { VER } from '@vrtmrz/livesync-commonlib/compat/common/types';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
import { startBackend, eventually, freePort } from './backend.mjs';
import { downloadPlugin } from './plugin.mjs';
const evidence = resolve('.local/e2e/evidence');
await mkdir(evidence, { recursive: true });
// Exclusive lock prevents equivalent local harness executions. No broad process killing.
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
  cases: [],
  versions: [],
  startedAt: new Date().toISOString(),
};
let backend;
const clients = [];
async function evaluate(client, code, argument) {
  return withObsidianPage(client.session.remoteDebuggingPort, async (page) => {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(code, argument),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Obsidian operation exceeded 45 seconds')), 45_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}
async function sync(client) {
  const succeeded = await evaluate(client, async () => {
    const core = app.plugins.plugins['obsidian-livesync'].core;
    await core.services.fileProcessing.commitPendingFileEvents();
    return !!(await core.services.replication.replicate(true));
  });
  assert.equal(succeeded, true, 'Official LiveSync one-shot replication must succeed');
}
async function startClient(vaultId, reuse) {
  const vault =
    reuse?.vault ?? (await createTemporaryVault({ prefix: 'workers-obsidian-e2e-', pluginIds: ['obsidian-livesync'] }));
  const data = {
    couchDB_URI: `${backend.origin}/livesync`,
    couchDB_USER: vaultId,
    couchDB_PASSWORD: backend.password,
    couchDB_DBNAME: `vault-${vaultId}`,
    remoteType: '',
    displayLanguage: 'def',
    liveSync: false,
    syncOnStart: false,
    syncOnSave: false,
    usePluginSync: false,
    usePluginSyncV2: true,
    useEden: false,
    customChunkSize: 0,
    sendChunksBulk: false,
    chunkSplitterVersion: 'v3-rabin-karp',
    readChunksOnline: true,
    enableCompression: false,
    hashAlg: 'xxhash64',
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: true,
    encrypt: false,
    E2EEAlgorithm: 'v2',
    doctorProcessedVersion: '0.25.27',
    settingVersion: CURRENT_SETTING_VERSION,
    isConfigured: true,
  };
  upsertRemoteConfigurationInPlace(data, 'couchdb', { id: 'e2e', name: 'Local E2E', activate: true });
  const client = reuse ?? { vault, vaultId };
  if (!reuse) clients.push(client); // Track before launch so failing bootstrap is cleaned up.
  client.session = await startObsidianPluginSession({
    binary: requireObsidianBinary(),
    cliBinary: requireObsidianCli(),
    vault,
    pluginId: 'obsidian-livesync',
    artifactRoot: await downloadPlugin(),
    pluginData: data,
    localStorageEntries: { [`${vault.name}--database-compatibility-version`]: String(VER) },
    versionPolicy: { expectedVersion: '1.13.7', allowUnverifiedVersion: true },
    env: {
      E2E_OBSIDIAN_REMOTE_DEBUGGING_PORT: String(await freePort()),
      E2E_OBSIDIAN_USE_XVFB: 'false',
      E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false',
    },
    lifecycle: {
      beforeLaunch(context) {
        // The upstream helper defaults to --no-sandbox. Override the COMPLETE argv.
        // No user-supplied switches, no sandbox disabling and no inspector on a public interface.
        context.cliEnv.E2E_OBSIDIAN_ARGS = `${process.platform === 'darwin' ? '--use-mock-keychain ' : ''}--user-data-dir=${vault.userDataPath} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${context.remoteDebuggingPort} obsidian://open?path=${encodeURIComponent(vault.path)}`;
      },
    },
  });
  assert.equal(client.session.readiness.obsidianVersion, '1.13.7');
  assert.equal(client.session.readiness.pluginVersion, '1.0.34');
  result.actualObsidian = true;
  result.versions.push(client.session.readiness);
  await eventually(async () =>
    assert.equal(
      await evaluate(client, () => {
        const core = app.plugins.plugins['obsidian-livesync'].core;
        return core.services.database.isDatabaseReady() && core.services.appLifecycle.isReady();
      }),
      true,
    ),
  );
  await evaluate(client, async () => {
    const core = app.plugins.plugins['obsidian-livesync'].core;
    const settings = core.services.setting.currentSettings();
    const replicator = core.services.replicator.getActiveReplicator();
    await replicator.tryCreateRemoteDatabase(settings);
    await replicator.markRemoteResolved(settings);
    if (!(await replicator.ensurePBKDF2Salt(settings, false, false)))
      throw new Error('Remote security seed preparation failed');
    if (settings.versionUpFlash) throw new Error('Compatibility review paused synchronization');
  });
  return client;
}
async function write(client, path, content, binary = false) {
  await evaluate(
    client,
    async ({ path, content, binary }) => {
      for (const folder of path
        .split('/')
        .slice(0, -1)
        .map((_, i, all) => all.slice(0, i + 1).join('/')))
        if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      const existing = app.vault.getAbstractFileByPath(path);
      if (binary) {
        const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0)).buffer;
        if (existing) await app.vault.modifyBinary(existing, bytes);
        else await app.vault.createBinary(path, bytes);
      } else if (existing) await app.vault.modify(existing, content);
      else await app.vault.create(path, content);
    },
    { path, content, binary },
  );
}
async function expectFile(client, path, expected) {
  await eventually(async () => {
    const bytes = await readFile(join(client.vault.path, path));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
      path,
    );
  });
}
async function expectDeleted(client, path) {
  await eventually(async () =>
    assert.equal(await evaluate(client, (path) => app.vault.getAbstractFileByPath(path) === null, path), true),
  );
}
async function step(name, operation) {
  await operation();
  result.cases.push({ name, status: 'passed' });
  console.log(`PASS ${name}`);
}
try {
  process.env.E2E_OBSIDIAN_VERSION = '1.13.7';
  process.env.E2E_OBSIDIAN_ALLOW_UNVERIFIED_VERSION = 'true';
  requireObsidianBinary();
  requireObsidianCli();
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    throw new Error('No desktop display; actual Obsidian cannot run here. Use the desktop handoff instructions.');
  backend = await startBackend();
  const writer = await startClient('a');
  const reader = await startClient('a');
  const foreign = await startClient('b');
  const note = '# 東京 API 😀\n![原本](assets/original.pdf)\n日本語・English\n';
  const original = Buffer.from(Array.from({ length: 160_003 }, (_, i) => i % 256));
  const updated = Buffer.from(Array.from({ length: 180_011 }, (_, i) => (i * 7) % 256));
  await step(
    'note and multi-chunk binary create through real Obsidian → LiveSync → Workers → second Obsidian',
    async () => {
      await write(writer, '日本語.md', note);
      await write(writer, 'assets/original.pdf', original.toString('base64'), true);
      await write(writer, 'assets/retained.png', updated.toString('base64'), true);
      await sync(writer);
      await sync(reader);
      await expectFile(reader, '日本語.md', Buffer.from(note));
      await expectFile(reader, 'assets/original.pdf', original);
      await expectFile(reader, 'assets/retained.png', updated);
      const doc = await (await backend.request('a', '/assets%2Foriginal.pdf')).json();
      assert.ok(doc.children?.length > 1, 'Actual plugin splitter must produce multiple chunks');
      result.binaryChunks = doc.children.length;
    },
  );
  await step('same paths remain isolated between immutable vaults', async () => {
    await write(foreign, '日本語.md', 'foreign');
    await sync(foreign);
    await expectFile(foreign, '日本語.md', Buffer.from('foreign'));
    await sync(reader);
    await expectFile(reader, '日本語.md', Buffer.from(note));
    await expectDeleted(foreign, 'assets/original.pdf');
  });
  await step('note and binary updates preserve links and bytes', async () => {
    await write(writer, '日本語.md', `${note}updated\n`);
    await write(writer, 'assets/original.pdf', updated.toString('base64'), true);
    await sync(writer);
    await sync(reader);
    await expectFile(reader, '日本語.md', Buffer.from(`${note}updated\n`));
    await expectFile(reader, 'assets/original.pdf', updated);
  });
  await step('offline edit reconnects after local backend restart', async () => {
    await backend.pause();
    await write(writer, 'reconnect.md', 'offline 😀');
    assert.equal(
      await evaluate(
        writer,
        async () => !!(await app.plugins.plugins['obsidian-livesync'].core.services.replication.replicate(false)),
      ),
      false,
      'Offline replication must not report success',
    );
    await backend.resume();
    await sync(writer);
    await sync(reader);
    await expectFile(reader, 'reconnect.md', Buffer.from('offline 😀'));
  });
  await step('Obsidian restart resumes existing local replication checkpoints', async () => {
    await reader.session.app.stop();
    reader.session = undefined;
    await startClient('a', reader);
    await write(writer, 'reconnect.md', 'after client restart');
    await sync(writer);
    await sync(reader);
    await expectFile(reader, 'reconnect.md', Buffer.from('after client restart'));
  });
  await step('note and binary deletes propagate to second Obsidian', async () => {
    for (const path of ['日本語.md', 'assets/original.pdf'])
      await evaluate(
        writer,
        async (path) => {
          const file = app.vault.getAbstractFileByPath(path);
          if (!file) throw new Error('Missing deletion fixture');
          await app.vault.delete(file);
        },
        path,
      );
    await sync(writer);
    await sync(reader);
    await expectDeleted(reader, '日本語.md');
    await expectDeleted(reader, 'assets/original.pdf');
  });
  await step(
    'SQLite/R2 persistence after compaction and Worker restart reaches fresh Obsidian without resurrection',
    async () => {
      await backend.compact('a');
      await backend.restart();
      const fresh = await startClient('a');
      await sync(fresh);
      await expectFile(fresh, 'assets/retained.png', updated);
      await expectFile(fresh, 'reconnect.md', Buffer.from('after client restart'));
      await expectDeleted(fresh, '日本語.md');
      await expectDeleted(fresh, 'assets/original.pdf');
    },
  );
  result.status = 'passed';
} catch (error) {
  result.status = result.actualObsidian ? 'failed' : 'blocked';
  result.error = String(error.message);
  process.exitCode = result.actualObsidian ? 1 : 2;
  for (const [i, client] of clients.entries())
    if (client.session)
      await withObsidianPage(client.session.remoteDebuggingPort, (page) =>
        page.screenshot({ path: join(evidence, `failure-${i}.png`) }),
      ).catch(() => {});
  console.error(result.error);
} finally {
  for (const client of clients.reverse()) {
    await client.session?.app.stop().catch(() => {});
    await client.vault.dispose();
  }
  await backend?.dispose();
  result.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  await lock.close();
  const { unlink } = await import('node:fs/promises');
  await unlink(lockPath);
}
