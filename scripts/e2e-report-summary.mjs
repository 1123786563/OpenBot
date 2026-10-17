#!/usr/bin/env node
// Group a run's failures by their message, so one shim gap and one hundred failures are visible apart.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const file = process.argv[2] ?? ".e2e/unit/report.json";
const report = JSON.parse(readFileSync(resolve(root, file), "utf8")).run;
const results = report.results ?? [];

const byMessage = new Map();
const byFile = new Map();
for (const result of results) {
  if (result.status === "passed" || result.status === "skipped") continue;
  const attempt = result.attempts?.[result.attempts.length - 1];
  const raw =
    attempt?.error?.message ??
    attempt?.error?.reason ??
    result.status ??
    "unknown";
  const message = String(raw)
    .replace(
      /["'`].{0,40}["'`]/g,
      (quoted) => `${quoted[0]}…${quoted[quoted.length - 1]}`,
    )
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 90);
  byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
  const path = result.file ?? result.titlePath?.[0] ?? "unknown";
  byFile.set(path, (byFile.get(path) ?? 0) + 1);
}

console.log(
  `${report.summary.executed} executed · ${report.summary.passed} passed · ${report.summary.failed} failed`,
);
console.log(`\nfailure messages (${byMessage.size} distinct):`);
for (const [message, count] of [...byMessage]
  .sort((a, b) => b[1] - a[1])
  .slice(0, Number(process.argv[3] ?? 25))) {
  console.log(`  ${String(count).padStart(4)}  ${message}`);
}
console.log(`\nfiles with failures (${byFile.size}):`);
for (const [path, count] of [...byFile]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)) {
  console.log(`  ${String(count).padStart(4)}  ${path}`);
}
