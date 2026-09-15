// Copy the repository README into the package for npm, turning relative
// links (which only work on GitHub) into absolute ones.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "https://github.com/odiak/livesync-workers/blob/main/";
const readme = readFileSync(resolve(pkgDir, "../../README.md"), "utf8").replace(
  /\]\((?!https?:|#)([^)]+)\)/g,
  (_, target) => `](${repo}${target.replace(/^\.\//, "")})`,
);
writeFileSync(resolve(pkgDir, "README.md"), readme);
