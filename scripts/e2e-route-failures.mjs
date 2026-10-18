#!/usr/bin/env node
// Route the suites the runner itself proves are Bun-coupled, by their failure text.
//
// The import graph cannot see this class: `Bun.serve`, `Bun.SQL.PostgresError` and a `spyOn` on an
// ESM namespace are reached through the runtime global or through Node's own object model, so a
// static scan says "loadable on Node" and the run says otherwise. The runner's message is the
// evidence, and the two-tier decision recorded in docs/adr/0008 says what to do with it: keep the
// suite on the Bun runtime and let e2e schedule and report it, rather than rewrite a production
// boundary or fake Bun inside Node.
//
// Anything that fails with a message outside this list is left alone — an assertion diff is a
// product finding, not a runtime boundary, and routing it would hide it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, writeManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const report = resolve(root, arg("report", ".e2e/unit/report.json"));
const verdicts = resolve(root, arg("verdicts", "docs/verification/e2e-vs-bun.json"));
const byVerdict = arg("verdict", "");
const apply = process.argv.includes("--apply");

// Bun's own bindings, loader behaviour, and the writable-module semantics Node refuses.
const RUNTIME_GAP = [
  /Received protocol 'bun:/,
  /Cannot find package ['"]bun['"]/,
  /bun:sqlite/,
  /bun:ffi/,
  /drizzle-orm\/bun-/,
  /Bun is not defined/,
  /Bun\.\$ is not a function/,
  /Bun\.SQL/,
  // A suite reaching for a Bun global the Node port does not carry reads off `undefined` instead.
  /Cannot read properties of undefined \(reading '(PostgresError|SQL|YAML|Glob|which|spawn|serve)'\)/,
  /Unknown file extension /,
  /Cannot assign to property .* of \[object Module\]/,
  /does not provide an export named/,
  /Cannot find package ['"]@tauri-apps/,
];

const run = existsSync(report)
  ? JSON.parse(readFileSync(report, "utf8")).run
  : null;
const manifest = readManifest();
// The driver is the e2e test that runs the Bun tier, so its own failures quote a driven suite's
// message. Routing it would move the scheduler onto the runtime it schedules.
const DRIVER = "tests/bun-suites.test.ts";
const hits = new Map();
if (byVerdict) {
  // `scripts/e2e-vs-bun.mjs` has already answered the harder question: the same suite text against
  // the same production code, old runner green and new runner red. That verdict is the evidence.
  const parsed = JSON.parse(readFileSync(verdicts, "utf8"));
  for (const row of parsed.rows ?? []) {
    if (row.verdict !== byVerdict || row.file === DRIVER) continue;
    hits.set(row.file, {
      pattern: `attributed ${byVerdict}`,
      count: row.e2eFailures ?? 0,
      message: row.e2eFirst ?? "",
    });
  }
} else {
  if (!run) {
    console.error(`no report at ${report}; run \`bun run test\` first`);
    process.exit(2);
  }
  for (const result of run.results ?? []) {
    if (result.status === "passed" || result.status === "skipped") continue;
    if (result.file === DRIVER) continue;
    const attempt = result.attempts?.[result.attempts.length - 1];
    const message = String(attempt?.error?.message ?? "");
    const pattern = RUNTIME_GAP.find((candidate) => candidate.test(message));
    if (!pattern) continue;
    const entry =
      hits.get(result.file) ?? { pattern: String(pattern), count: 0, message };
    entry.count++;
    hits.set(result.file, entry);
  }
}

const fresh = [...hits].filter(
  ([file, entry]) => !manifest.files.has(file) && !manifest.artifacts.has(file),
);
console.log(
  `${hits.size} file(s) failed on a Bun runtime boundary, ${fresh.length} not yet driven:`,
);
for (const [file, entry] of [...hits].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    `  ${String(entry.count).padStart(3)}  ${file}  ${manifest.files.has(file) ? "(already driven)" : `— ${entry.pattern}`}`,
  );
}

if (!apply) {
  console.log(`\ndry run; --apply records them in docs/verification/e2e-bun-suites.json`);
  process.exit(0);
}
for (const [file, entry] of fresh) {
  manifest.files.add(file);
  manifest.causes[file] = `runner reported: ${entry.message.slice(0, 120)}`;
}
if (fresh.length) {
  const groups = writeManifest(manifest, "scripts/e2e-route-failures.mjs");
  spawnSync("node", ["scripts/e2e-apply-partition.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  console.log(
    `\nmoved ${fresh.length} file(s) to the driven tier · ${manifest.files.size} driven · ${groups} groups`,
  );
} else {
  console.log("\nnothing new to move");
}
