#!/usr/bin/env node
// Close the loop the runner forces: one uncollectable file aborts a whole run, and the audit is a
// snapshot that other work moves past. Each pass asks the runner, and a file whose cause is the Bun
// runtime itself joins the driven manifest; anything else stops for a human, because a harness gap
// must not be hidden by routing a suite onto another runtime.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "docs/verification/e2e-bun-suites.json");
const groupSize = 24;
const BUN_RUNTIME = [
  /Received protocol 'bun:'/,
  /Cannot find package ['"]bun['"]/,
  /bun:sqlite/,
  /bun:ffi/,
  /drizzle-orm\/bun-/,
  /Bun is not defined/,
  /Unknown file extension /,
  /Cannot assign to property .* of \[object Module\]/,
  /does not provide an export named/,
  /Cannot find package ['"]@tauri-apps/,
];
const ARTIFACT = /^deliverables\//;
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 200;

const read = () => JSON.parse(readFileSync(manifestPath, "utf8"));

function write(files, artifacts) {
  const groups = [];
  const byDirectory = new Map();
  for (const file of files) {
    const directory = file.split("/").slice(0, 2).join("/");
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(file);
  }
  for (const [directory, list] of byDirectory) {
    for (let index = 0; index < list.length; index += groupSize) {
      groups.push({
        name: `${directory}${list.length > groupSize ? ` part ${index / groupSize + 1}` : ""}`,
        files: list.slice(index, index + groupSize),
      });
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ generatedBy: "scripts/e2e-partition-fix-loop.mjs", groups, files, artifacts }, null, 1)}\n`,
  );
  return groups.length;
}

const added = [];
const blocked = [];
for (let pass = 0; pass < limit; pass++) {
  const run = spawnSync("./node_modules/.bin/e2e", ["list", "--config", "e2e.unit.config.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const failing =
    output.match(/failed to collect ([^:]+): ([^\n]+)/) ??
    output.match(/COLLECTION_ERROR: ([^:]+): ([^\n]+)/);
  if (!failing) {
    console.log(`collection clean after ${pass} fix(es)`);
    break;
  }
  const file = failing[1].trim();
  const reason = failing[2].trim();
  const manifest = read();
  const files = new Set(manifest.files);
  const artifacts = new Set(manifest.artifacts ?? []);
  if (files.has(file) || artifacts.has(file)) {
    blocked.push({ file, reason: `${reason} (already bucketed: the exclusion did not take)` });
    break;
  }
  if (ARTIFACT.test(file)) {
    artifacts.add(file);
    added.push({ file, reason, bucket: "artifact" });
  } else if (BUN_RUNTIME.some((pattern) => pattern.test(reason))) {
    files.add(file);
    added.push({ file, reason, bucket: "bun-runtime" });
  } else {
    blocked.push({ file, reason });
    console.log(`stopped: ${file} is a harness gap, not a runtime boundary\n  ${reason}`);
    break;
  }
  const groups = write([...files], [...artifacts]);
  spawnSync("node", ["scripts/e2e-apply-partition.mjs"], { cwd: root, encoding: "utf8" });
  console.log(`+ ${file} → ${added.at(-1).bucket} (${groups} groups)`);
}

writeFileSync(
  join(root, "docs/verification/e2e-partition-loop.json"),
  JSON.stringify({ added, blocked }, null, 1),
);
console.log(`\nmoved ${added.length} file(s); ${blocked.length} blocked:`);
for (const entry of blocked) console.log(`  ${entry.file} — ${entry.reason}`);
for (const entry of added.slice(-6)) console.log(`  last moves: ${entry.file} (${entry.bucket})`);
