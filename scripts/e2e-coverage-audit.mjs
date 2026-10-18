#!/usr/bin/env node
// The completion audit for "every test runs under tester-army e2e", stated as accounting.
//
// "All migrated" is only checkable if each suite file lands in exactly one of three buckets, and any
// file in none of them is a gap:
//
//   native   collected and executed by e2e on Node (imports the e2e-backed compat layer)
//   driven   scheduled and reported by e2e, executed by `bun test` (the Bun-runtime tier, ADR 0008)
//   excluded named in a manifest with a reason: an artifact that cannot run here, or a suite this
//            repository's own fixture broke — `bun run test:ci` prints the count so it cannot grow
//            silently
//
// A file that imports `bun:test` but is not driven, or imports neither layer, is a gap: it would
// either abort collection or never run. Exits non-zero so CI can gate on it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const dirs = [
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
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.test\.(tsx?|mts)$|\.spec\.(tsx?|mts)$|\.e2e\.tsx?$/.test(entry))
      files.push(full);
  }
}
for (const dir of dirs) walk(join(root, dir));

const driven = new Set(
  JSON.parse(
    readFileSync(join(root, "docs/verification/e2e-bun-suites.json"), "utf8"),
  ).files ?? [],
);
const artifacts = new Set(
  JSON.parse(
    readFileSync(join(root, "docs/verification/e2e-bun-suites.json"), "utf8"),
  ).artifacts ?? [],
);
const broken = new Set(
  (
    JSON.parse(
      readFileSync(
        join(root, "docs/verification/e2e-known-broken.json"),
        "utf8",
      ),
    ).entries ?? []
  ).map((entry) => entry.file),
);

const buckets = { native: [], driven: [], engine: [], excluded: [], gap: [] };
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  const source = readFileSync(file, "utf8");
  const importsBunTest = /^import[\s\S]{0,400}?from ["']bun:test["'];/m.test(
    source,
  );
  const importsCompat = /support\/(e2e-compat|bun-test-compat)["']/.test(
    source,
  );
  const engine = /\.e2e\.tsx?$/.test(rel) || /from "@e2e-dev\//.test(source);
  if (artifacts.has(rel) || broken.has(rel)) buckets.excluded.push(rel);
  else if (engine) buckets.engine.push(rel);
  else if (driven.has(rel)) {
    if (!importsBunTest && !/bun-test-compat/.test(source))
      buckets.gap.push(`${rel} (driven but not on the bun:test layer)`);
    else buckets.driven.push(rel);
  } else if (importsBunTest)
    buckets.gap.push(
      `${rel} (imports bun:test, not driven → aborts collection)`,
    );
  else if (importsCompat) buckets.native.push(rel);
  else if (/^\s*(test|describe)\s*\(/m.test(source))
    buckets.gap.push(`${rel} (registers tests, imports no runner)`);
  else buckets.gap.push(`${rel} (no runner import and no registrations)`);
}

console.log(
  `${files.length} suite files in the 14 migrated directories · ${buckets.native.length} native e2e · ${buckets.driven.length} driven by e2e (bun runtime) · ${buckets.engine.length} engine (.e2e.ts, web/mobile) · ${buckets.excluded.length} named exclusions`,
);
if (buckets.gap.length) {
  console.log(
    `\nGAPS (${buckets.gap.length}) — each one means the corpus is not fully accounted:`,
  );
  for (const gap of buckets.gap.slice(0, 40)) console.log(`  ${gap}`);
  process.exit(1);
}
console.log(
  "\nno gaps: every suite file is scheduled by e2e, or excluded by name with a reason.",
);
