import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export default class BenchmarkReporter {
  results = [];
  onUserConsoleLog(log) {
    const marker = "LIVESYNC_BENCHMARK ";
    for (const line of log.content.split("\n")) {
      const at = line.indexOf(marker);
      if (at >= 0) this.results.push(JSON.parse(line.slice(at + marker.length)));
    }
  }
  onTestRunEnd() {
    mkdirSync(".local/benchmarks", {recursive: true});
    writeFileSync(".local/benchmarks/latest.json", JSON.stringify({
      dependencies: JSON.parse(readFileSync("package.json", "utf8")).devDependencies,
      lockSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
      node: process.version, platform: process.platform, architecture: process.arch,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {encoding:"utf8"}).trim(),
      measuredAt: new Date().toISOString(), results: this.results,
    }, null, 2)+"\n");
  }
}
