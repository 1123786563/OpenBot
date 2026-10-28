#!/usr/bin/env node
// Drive the collection partition to a fixed point, one suite directory at a time.
//
// The runner aborts an entire run at the first file it cannot collect, and a whole-corpus listing
// costs minutes, so this asks one directory at a time: fix what the runner names, re-ask that
// directory, then move on. A file whose cause is the Bun runtime itself joins the driven manifest;
// anything else stops the directory, because a harness gap must stay visible rather than be hidden
// by routing a suite onto another runtime.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "tests/config/e2e-bun-suites.json");
const groupSize = 24;
const flag = (name, fallback) =>
  process.argv
    .find((entry) => entry.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const maxFixesPerScope = Number(flag("fixes", "40"));
const ALL_SCOPES = [
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
const scopes = String(flag("scopes", ALL_SCOPES.join(",")))
  .split(",")
  .filter(Boolean);

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

const read = () => JSON.parse(readFileSync(manifestPath, "utf8"));

function regroup(files, artifacts) {
  const byDirectory = new Map();
  for (const file of files) {
    const directory = file.split("/").slice(0, 2).join("/");
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(file);
  }
  const groups = [];
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

function listScope(scope) {
  return spawnSync(
    "./node_modules/.bin/e2e",
    ["list", "--config", "e2e.unit.config.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, E2E_UNIT_SCOPE: scope },
      timeout: Number(flag("timeout", "900000")),
    },
  );
}

const added = [];
const blocked = [];
const clean = [];

for (const scope of scopes) {
  let status = "clean";
  for (let fix = 0; fix <= maxFixesPerScope; fix++) {
    const run = listScope(scope);
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (run.error || run.signal) {
      status = "blocked";
      blocked.push({
        scope,
        file: "(listing)",
        reason: run.error?.message ?? `listing did not finish: ${run.signal}`,
      });
      break;
    }
    const failing =
      output.match(/failed to collect ([^:]+): ([^\n]+)/) ??
      output.match(/COLLECTION_ERROR: ([^:]+): ([^\n]+)/);
    if (!failing) {
      // Nothing failed to collect. A directory whose files all live on the Bun side legitimately
      // lists nothing, which is clean rather than a missing suite.
      break;
    }
    const file = failing[1].trim();
    const reason = failing[2].trim();
    const manifest = read();
    const files = new Set(manifest.files);
    const artifacts = new Set(manifest.artifacts ?? []);
    if (files.has(file) || artifacts.has(file)) {
      status = "blocked";
      blocked.push({
        scope,
        file,
        reason: `${reason} — already bucketed, the exclusion did not take`,
      });
      break;
    }
    if (ARTIFACT.test(file)) {
      artifacts.add(file);
      added.push({ file, reason, bucket: "artifact" });
    } else if (BUN_RUNTIME.some((pattern) => pattern.test(reason))) {
      files.add(file);
      added.push({ file, reason, bucket: "bun-runtime" });
    } else {
      status = "blocked";
      blocked.push({ scope, file, reason });
      console.log(
        `${scope}: stopping — ${file} is a harness gap, not a runtime boundary\n  ${reason}`,
      );
      break;
    }
    const groups = regroup([...files], [...artifacts]);
    spawnSync("node", ["scripts/e2e-apply-partition.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    console.log(
      `${scope}: + ${file} → ${added.at(-1).bucket} (${groups} groups)`,
    );
  }
  if (status === "clean") clean.push(scope);
}

writeFileSync(
  join(root, ".archive/runs/e2e/e2e-partition-loop.json"),
  JSON.stringify({ added, blocked, clean }, null, 1),
);
console.log(
  `\nclean scopes: ${clean.length}/${scopes.length} · moved ${added.length} file(s) · blocked ${blocked.length}`,
);
for (const entry of blocked)
  console.log(`  BLOCKED ${entry.file} — ${entry.reason}`);
