import type { DailyNoteSettings } from "../types.js";

export type VaultDirectoryEntry = {
  type: "directory" | "file";
  name: string;
  path: string;
};

export type DailyNotePath = {
  date: string;
  path: string;
};

function normalizeDirectory(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

export function normalizeExcludedFolders(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeDirectory).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, "ja", { numeric: true }),
  );
}

function dailyNoteDateKey(path: string): string | null {
  const fileName = path.split("/").at(-1) ?? path;
  const dashed = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(fileName);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})\.md$/.exec(fileName);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function dailyNoteFolder(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function dailyNoteFileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

function dailyNotePathFromSettings(
  settings: DailyNoteSettings | undefined,
  date: string,
): string | null {
  if (!settings?.format) return null;
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return null;

  const fileName = settings.format
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/YYYY/g, year)
    .replace(/YY/g, year.slice(-2))
    .replace(/MM/g, month)
    .replace(/DD/g, day);
  const path = normalizeDirectory(
    [settings.folder, fileName].filter(Boolean).join("/"),
  );
  if (!path) return null;
  return path.endsWith(".md") ? path : `${path}.md`;
}

export function inferDailyNotePath(
  paths: string[],
  date: string,
  settings?: DailyNoteSettings,
): string {
  const configuredPath = dailyNotePathFromSettings(settings, date);
  if (configuredPath) return configuredPath;

  const notes = listDailyNotePaths(paths, paths.length);
  const exact = notes.find((note) => note.date === date);
  if (exact) return exact.path;

  const sample = notes[0];
  if (!sample) return `Daily/${date}.md`;

  const folder = dailyNoteFolder(sample.path);
  const sampleName = dailyNoteFileName(sample.path);
  const fileName = /^\d{8}\.md$/.test(sampleName)
    ? `${compactDate(date)}.md`
    : `${date}.md`;
  return folder ? `${folder}/${fileName}` : fileName;
}

export function listVaultDirectory(
  paths: string[],
  directory = "",
): VaultDirectoryEntry[] {
  const dir = normalizeDirectory(directory);
  const prefix = dir ? `${dir}/` : "";
  const entries = new Map<string, VaultDirectoryEntry>();

  for (const path of paths) {
    if (!path.endsWith(".md")) continue;
    if (prefix && !path.startsWith(prefix)) continue;

    const rest = prefix ? path.slice(prefix.length) : path;
    if (!rest || rest.startsWith("/")) continue;

    const [name, ...tail] = rest.split("/");
    if (!name) continue;

    const type = tail.length > 0 ? "directory" : "file";
    const entryPath = prefix ? `${prefix}${name}` : name;
    const key = `${type}:${entryPath}`;
    entries.set(key, { type, name, path: entryPath });
  }

  return [...entries.values()].sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      a.name.localeCompare(b.name, "ja", { numeric: true }),
  );
}

export function listDailyNotePaths(
  paths: string[],
  limit = 20,
): DailyNotePath[] {
  return paths
    .flatMap((path) => {
      if (!path.endsWith(".md")) return [];
      const date = dailyNoteDateKey(path);
      return date ? [{ date, path }] : [];
    })
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}
