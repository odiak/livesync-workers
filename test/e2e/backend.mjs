import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
export async function freePort() {
  const server = createServer();
  await new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', r);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
export async function eventually(operation, timeout = 60_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      return await operation();
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < end);
  throw last;
}
export async function startBackend() {
  const directory = await mkdtemp(join(tmpdir(), 'livesync-workers-e2e-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secret = randomBytes(24).toString('hex');
  const password = randomBytes(24).toString('hex');
  const vaults = ['a', 'b'].map((id) => ({
    vaultId: id,
    tenantId: 'e2e',
    databaseName: `vault-${id}`,
    displayName: id,
    ownerId: id,
    username: id,
    passwordSecret: 'E2E_PASSWORD',
  }));
  const config = {
    name: 'livesync-local-e2e',
    main: resolve('test/e2e/worker.ts'),
    compatibility_date: '2026-04-30',
    compatibility_flags: ['nodejs_compat'],
    vars: {
      SESSION_SECRET: secret,
      E2E_PASSWORD: password,
      VAULTS_JSON: JSON.stringify(vaults),
      SEMANTIC_SEARCH: 'off',
    },
    r2_buckets: [
      { binding: 'CONTENT_BUCKET', bucket_name: 'e2e-content' },
      { binding: 'FTS_BUCKET', bucket_name: 'e2e-search' },
    ],
    durable_objects: { bindings: [{ name: 'VAULT_DB', class_name: 'E2EVaultDO' }] },
    migrations: [{ tag: 'e2e', new_sqlite_classes: ['E2EVaultDO'] }],
  };
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(directory, '.dev.vars'), '');
  let child,
    output = '';
  async function start() {
    const runtimeEnv = {
      ...process.env,
      WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
      XDG_CONFIG_HOME: join(directory, 'config'),
      WRANGLER_SEND_METRICS: 'false',
    };
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID']) delete runtimeEnv[key];
    child = spawn(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--config',
        configPath,
        '--persist-to',
        join(directory, 'state'),
      ],
      { env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (bytes) => {
      output = (output + bytes).slice(-20_000);
    });
    child.stderr.on('data', (bytes) => {
      output = (output + bytes).slice(-20_000);
    });
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error('Local Wrangler exited');
      const response = await fetch(`${origin}/e2e/ready`);
      if (!(await response.json()).localE2E) throw new Error('Wrong server');
    }, 45_000);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
  }
  try {
    await start();
  } catch (error) {
    await stop();
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `${error.message}\n${output
        .replaceAll(secret, '[redacted]')
        .replaceAll(password, '[redacted]')
        .replace(/env\.(SESSION_SECRET|E2E_PASSWORD)[^\n]*/g, 'env.$1 [redacted]')}`,
    );
  }
  return {
    origin,
    secret,
    password,
    vaults,
    async request(vaultId, suffix = '', options = {}) {
      return fetch(`${origin}/livesync/vault-${vaultId}${suffix}`, {
        ...options,
        headers: {
          Authorization: `Basic ${Buffer.from(`${vaultId}:${password}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    },
    async compact(vaultId) {
      const response = await this.request(vaultId, '/_compact', { method: 'POST' });
      if (response.status !== 202) throw new Error('Background compaction was not accepted');

    },
    async pause() {
      await stop();
    },
    async resume() {
      await start();
    },
    async restart() {
      await stop();
      await start();
    },
    async dispose() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
