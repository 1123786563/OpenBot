#!/usr/bin/env node
// Bring collection to a fixed point by asking the runner, which fails fast and names the file.
//
// `e2e` aborts a whole run at the first suite it cannot collect, and the abort costs ~10 seconds,
// so this loop is the cheap way to converge: run, read the named file, and either record it as a
// Bun-runtime suite (the runner's own words are the evidence) or stop, because a harness gap must be
// fixed here rather than parked on another runtime. It replaces a per-directory listing loop that
// cost minutes per pass and could not tell a timeout from a clean directory.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readManifest, writeManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const BUN_RUNTIME = [
  /Received protocol 'bun:'/,
  /Cannot find package ['"]bun['"]/,
  /Cannot find package ['"]bun:test['"]/,
  /bun:sqlite/,
  /bun:ffi/,
  /drizzle-orm\/bun-/,
  /Bun is not defined/,
  /Unknown file extension /,
  /Cannot assign to property .* of \[object Module\]/,
  /does not provide an export named/,
  /require is not defined in ES module scope/,
  /Cannot find package ['"]@tauri-apps/,
];
const ARTIFACT = /^deliverables\//;
const maxPasses = Number(
  (process.argv.find((a) => a.startsWith("--passes=")) ?? "").split("=")[1] ?? 80,
);

function collectOnce() {
  const run = spawnSync("./node_modules/.bin/e2e", ["list", "--config", "e2e.unit.config.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 1_800_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.error || run.signal) {
    return { kind: "error", reason: run.error?.message ?? `killed: ${run.signal}` };
  }
  const failing =
    output.match(/failed to collect ([^:]+): ([^\n]+)/) ??
    output.match(/COLLECTION_ERROR: ([^:]+): ([^\n]+)/);
  if (!failing) return { kind: "clean", listed: /[node]/.test(output) };
  return { kind: "failing", file: failing[1].trim(), reason: failing[2].trim() };
}

const manifest = readManifest();
const moves = [];
let blocked = null;

for (let pass = 0; pass < maxPasses; pass++) {
  const result = collectOnce();
  if (result.kind === "clean") {
    console.log(`collection clean after ${moves.length} move(s)`);
    break;
  }
  if (result.kind === "error") {
    blocked = { file: "(listing)", reason: result.reason };
    break;
  }
  const { file, reason } = result;
  if (manifest.files.has(file) || manifest.artifacts.has(file)) {
    blocked = { file, reason: `${reason} — already bucketed, the exclusion did not take` };
    break;
  }
  if (ARTIFACT.test(file)) {
    manifest.artifacts.add(file);
    manifest.causes[file] = `deliverable spec, not executable in this repository (${reason})`;
    moves.push({ file, bucket: "artifact", reason });
  } else if (BUN_RUNTIME.some((pattern) => pattern.test(reason))) {
    manifest.files.add(file);
    manifest.causes[file] = `runner named it: ${reason}`;
    moves.push({ file, bucket: "bun-runtime", reason });
  } else {
    blocked = { file, reason };
    console.log(`stopping — ${file} is a harness gap, not a runtime boundary\n  ${reason}`);
    break;
  }
  writeManifest(manifest, "scripts/e2e-fix-collection.mjs");
  spawnSync("node", ["scripts/e2e-apply-partition.mjs"], { cwd: root, encoding: "utf8" });
  console.log(`+ ${file} → ${moves.at(-1).bucket}`);
}

writeFileSync(
  join(root, "docs/verification/e2e-fix-collection.json"),
  JSON.stringify({ moves, blocked }, null, 1),
);
console.log(
  `\nmoved ${moves.length} file(s); blocked: ${blocked ? `${blocked.file} — ${blocked.reason}` : "no"}`,
);
