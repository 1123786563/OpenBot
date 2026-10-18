#!/usr/bin/env node
// One pass over every suite file: import it with the runner stubbed and record what fails to load.
// The runner aborts its collection at the first broken file, so this is how a whole repository's
// load errors get enumerated without paying a runner start-up per file.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
register(pathToFileURL(join(root, "scripts/e2e-collect/loader.mjs")));

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
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

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => collect(resolve(root, d), []));
const failures = [];
const timeoutOf = 30_000;

for (const [index, file] of files.entries()) {
  const label = file.replace(`${root}/`, "");
  let timer;
  try {
    await Promise.race([
      import(pathToFileURL(file).href).then((mod) => ({ module: mod })),
      new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`import timed out after ${timeoutOf / 1000}s`)), timeoutOf);
      }),
    ]);
  } catch (error) {
    failures.push({ file: label, name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 300) });
  } finally {
    clearTimeout(timer);
  }
  if ((index + 1) % 100 === 0) console.error(`… ${index + 1}/${files.length}`);
}

const grouped = new Map();
for (const failure of failures) {
  const key = failure.message.replace(/["'`].{0,60}["'`]/g, "…").replace(/\d+/g, "N").slice(0, 100);
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}

writeFileSync(join(root, "archive/verification/e2e-collection.json"), JSON.stringify({ files: files.length, failures }, null, 1));
console.log(`\n${files.length} suite files imported, ${failures.length} failed to load.`);
console.log(`\nload errors by cause (${grouped.size} distinct):`);
for (const [cause, count] of [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
}
console.log(`\nfull ledger: archive/verification/e2e-collection.json`);
