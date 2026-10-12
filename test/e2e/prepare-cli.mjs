import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const CLI_COMMIT = '27a2d9e8c9672fb8df522470712da3cc6e35af11';
export async function prepareCli() {
  const source = resolve(process.env.LIVESYNC_CLI_SOURCE ?? '.local/e2e/livesync-cli');
  const evidence = resolve('.local/e2e/cli-evidence');
  await mkdir(evidence, { recursive: true });
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = async (command, args) =>
    (await exec(command, args, { cwd: source, env: environment, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
  if (!(await readFile(join(source, 'package.json')).catch(() => null))) {
    await mkdir(resolve('.local/e2e'), { recursive: true });
    await exec(
      'git',
      ['clone', '--depth', '1', '--branch', '1.0.34', 'https://github.com/vrtmrz/obsidian-livesync.git', source],
      { env: environment, timeout: 60_000 },
    );
  }
  const commit = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (commit !== CLI_COMMIT || (await run('git', ['status', '--porcelain'])).trim())
    throw new Error('Official CLI checkout must match the pinned clean 1.0.34 source');
  const receiptPath = join(evidence, 'official-cli-build.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => '{}'));
  if (
    receipt.commit !== commit ||
    receipt.source !== source ||
    !(await readFile(join(source, 'src/apps/cli/dist/index.cjs')).catch(() => null))
  ) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installed = await run(npm, ['ci', '--cache', resolve('.local/e2e/npm-cache')]);
    const built = await run(npm, ['run', 'build', '-w', 'self-hosted-livesync-cli']);
    await writeFile(join(evidence, 'official-cli-build.log'), installed + built);
    const core = JSON.parse(
      await readFile(join(source, 'node_modules/@vrtmrz/livesync-commonlib/package.json'), 'utf8'),
    );
    await writeFile(
      receiptPath,
      JSON.stringify({ source, commit, tag: '1.0.34', sharedCore: core.version, node: process.version }),
    );
  }
  return {
    source,
    executable: join(source, 'src/apps/cli/dist/index.cjs'),
    receipt: JSON.parse(await readFile(receiptPath, 'utf8')),
  };
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify((await prepareCli()).receipt));
