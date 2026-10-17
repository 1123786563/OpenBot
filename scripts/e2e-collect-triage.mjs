#!/usr/bin/env node
// Enumerate e2e collection errors one by one: the collector stops at the first failing file,
// so each run names one, we record it, exclude it, and run again. Prints a triage ledger.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = process.argv[2] ?? "e2e.unit.config.ts";
const path = resolve(root, config);
const MARK_START =
  "    // >>> 收集失败暂被排除，见 scripts/e2e-collect-triage.mjs";
const MARK_END = "    // <<< 收集失败排除";
const excluded = new Set();
const found = [];
const base = readFileSync(path, "utf8");
const start = base.indexOf(MARK_START);
const current =
  start === -1
    ? base
    : base.slice(0, start) +
      base.slice(base.indexOf(MARK_END) + MARK_END.length);

function writeExclusions(list) {
  const end = current.lastIndexOf("\n  ],");
  if (end === -1) {
    console.error("cannot find the end of the tests array in this config");
    process.exit(2);
  }
  const block = list.length
    ? `\n${MARK_START}\n${list.map((f) => `    "!${f}",`).join("\n")}${MARK_END}\n`
    : "";
  const body = `${current.slice(0, end)}${block}${current.slice(end)}`;
  writeFileSync(path, body.replace(/\n{3,}/g, "\n\n"));
}
writeExclusions([]);

for (let pass = 0; pass < 400; pass++) {
  const result = spawnSync(
    "./node_modules/.bin/e2e",
    ["list", "--config", config],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failing =
    output.match(/failed to collect ([^:]+): ([^\n]+)/) ??
    output.match(/COLLECTION_ERROR: ([^:]+): ([^\n]+)/) ??
    output.match(
      /ERROR\s+\S+ error \S+ \(\w+\)\n(?:\s*\n)*failed to collect ([^:]+): ([^\n]+)/,
    );
  if (!failing) {
    console.log(
      output
        .split("\n")
        .filter((line) => /tests? in|Test Files/.test(line))[0] ??
        "collection clean",
    );
    break;
  }
  const file = failing[1].trim();
  const error = failing[2].trim();
  if (excluded.has(file)) {
    console.error(
      `the same file failed after exclusion — the glob did not take: ${file}`,
    );
    break;
  }
  excluded.add(file);
  found.push({ file, error });
  writeExclusions([...excluded]);
}

writeFileSync(
  "/tmp/e2e-collection-errors.json",
  JSON.stringify(found, null, 1),
);
console.log(
  `\ncollection errors: ${found.length} (excluded for now; ledger in /tmp/e2e-collection-errors.json)`,
);
for (const entry of found) console.log(`  ${entry.file} — ${entry.error}`);
