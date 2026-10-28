#!/usr/bin/env node
// Per-file collection ground truth, straight from the runner.
//
// `e2e` stops a whole run at the first file that fails to collect, and an in-process import probe
// disagrees with it (Node strips types, the runner transforms them), so the only trustworthy answer
// is one short runner pass per file. The result partitions the corpus into suites the runner loads
// natively and suites that are stuck on the Bun runtime.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const auditDir = root;
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".audit",
]);
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = dirs.length
  ? dirs
  : [
      "shared",
      "supervisor",
      "worker",
      "deliverables",
      "desktop",
      "agent-bot",
      "agent-sandbox",
      "agent-langgraph",
      "agent-mastra",
      "agent-computer",
      "app",
      "server",
      "tests",
      "scripts",
    ];
const jobs = process.argv.find((a) => a.startsWith("--jobs="));
const concurrency = jobs ? Number(jobs.split("=")[1]) : 6;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

const files = list.flatMap((d) => walk(resolve(root, d), []));

function runOne(rel) {
  const slug = rel.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const config = join(auditDir, `.audit.${slug}.config.ts`);
  const source = `import type { E2EConfig } from "e2e";
export default {
  projectId: "audit",
  tests: ["${rel}"],
  targets: [{ name: "node", platform: "node" }],
  workers: 1,
  timeout: 30000,
  output: ".audit-out",
} satisfies E2EConfig;
`;
  writeFileSync(config, source);
  return new Promise((done) => {
    const child = spawn(
      "./node_modules/.bin/e2e",
      ["list", "--config", config.replace(`${root}/`, "")],
      {
        cwd: root,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(config, { force: true });
      const failed = output.match(/COLLECTION_ERROR:[^\n]*\n?[^\n]*/);
      const count = output.split("\n").filter((line) => line.includes(" › "));
      done({
        file: rel,
        status: failed ? "collect_error" : code === 0 ? "collected" : "error",
        tests: count.length,
        error: failed
          ? failed[0].replace(/\s+/g, " ").slice(0, 240)
          : code === 0
            ? ""
            : output.slice(-240),
      });
    });
  });
}

const results = [];
let cursor = 0;

async function worker() {
  while (cursor < files.length) {
    const index = cursor++;
    const rel = files[index].replace(`${root}/`, "");
    const result = await runOne(rel);
    results.push(result);
    if (results.length % 50 === 0) {
      console.log(`… ${results.length}/${files.length}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((a, b) => a.file.localeCompare(b.file));

mkdirSync(join(root, "archive/verification"), { recursive: true });
writeFileSync(
  join(root, "archive/verification/e2e-file-audit.json"),
  JSON.stringify(results, null, 1),
);
const bad = results.filter((r) => r.status !== "collected");
const causes = new Map();
for (const entry of bad) {
  const key = entry.error
    .replace(/["'`].{0,60}["'`]/g, "…")
    .replace(/\d+/g, "N")
    .slice(0, 90);
  causes.set(key, (causes.get(key) ?? 0) + 1);
}
console.log(
  `\n${results.length} files · ${results.length - bad.length} collect under e2e · ${bad.length} do not`,
);
console.log(
  `tests registered by the collectable files: ${results.reduce((n, r) => n + r.tests, 0)}`,
);
console.log(`\nwhy the rest do not (${causes.size} distinct):`);
for (const [cause, count] of [...causes]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
}
console.log(`\nledger: archive/verification/e2e-file-audit.json`);
