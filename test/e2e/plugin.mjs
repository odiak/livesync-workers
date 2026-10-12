import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
export async function downloadPlugin() {
  const lock = JSON.parse(await readFile(new URL('./plugin-lock.json', import.meta.url), 'utf8'));
  const directory = resolve('.local/e2e/plugin');
  await mkdir(directory, { recursive: true });
  for (const [name, checksum] of Object.entries(lock.sha256)) {
    const path = join(directory, name);
    let data = await readFile(path).catch(() => null);
    if (!data || createHash('sha256').update(data).digest('hex') !== checksum) {
      const response = await fetch(`https://github.com/${lock.repository}/releases/download/${lock.version}/${name}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Official plugin download failed (${response.status})`);
      data = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(data).digest('hex') !== checksum)
        throw new Error(`Plugin checksum mismatch: ${name}`);
      await writeFile(path, data);
    }
  }
  return directory;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(await downloadPlugin());
