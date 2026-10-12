// Download official, checksum-pinned Linux x64 test executables into .local only.
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned installers support Linux x64 only');
const lock = JSON.parse(await readFile(new URL('./plugin-lock.json', import.meta.url), 'utf8'));
async function hash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
async function download(asset, directory, name) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  if ((await hash(path).catch(() => null)) !== asset.sha256) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Official installer download failed (${response.status})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
    if ((await hash(path)) !== asset.sha256) throw new Error(`Installer checksum mismatch: ${name}`);
  }
  return path;
}
const obsidianRoot = resolve('.local/e2e/obsidian');
const appImage = await download(lock.obsidian, obsidianRoot, 'Obsidian-1.13.7.AppImage');
await chmod(appImage, 0o755);
await exec(appImage, ['--appimage-extract'], { cwd: obsidianRoot, maxBuffer: 8 * 1024 * 1024 });
console.log('Installed checksum-pinned Obsidian 1.13.7 into .local/e2e. Use the runner-provided Xvfb.');
