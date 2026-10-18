#!/usr/bin/env node
// Every suite that still imports `bun:test` must be on the driven tier: e2e runs on Node, where the
// `bun:` specifier cannot be resolved, and one uncollectable file aborts the whole run and leaves no
// report at all. Parallel sessions keep merging such suites into main, so the rule is re-applied
// from the source text rather than remembered.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest } from "./lib/e2e-manifest.mjs";

const root = "/Users/wuyongjun/trea/OpenBot";
const SKIP = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);
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
    else if (/\.test\.tsx?$/.test(entry)) files.push(full);
  }
}
for (const dir of dirs) walk(join(root, dir));

const manifest = readManifest();
let added = 0;
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  if (rel.startsWith("tests/support/")) continue;
  const source = readFileSync(file, "utf8");
  // Column 0 only: a probe script written inside a template literal is meant for a child Bun.
  if (!/^import[\s\S]{0,400}?from ["']bun:test["'];/m.test(source)) continue;
  if (manifest.files.has(rel)) continue;
  manifest.files.add(rel);
  manifest.causes[rel] =
    'suite still imports "bun:test" at column 0; e2e on Node cannot resolve the bun: specifier and aborts the whole run';
  added++;
}
const groups = writeManifest(manifest, "scripts/e2e-batch-drive-bun-test.mjs");
spawnSync("node", ["scripts/e2e-apply-partition.mjs"], {
  cwd: root,
  stdio: "inherit",
});
console.log(
  `${files.length} suite files scanned · ${added} newly driven · ${manifest.files.size} driven · ${groups} groups`,
);
