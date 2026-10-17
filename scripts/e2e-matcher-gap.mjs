#!/usr/bin/env node
// Which matchers does the corpus actually ask for, and which of them does the compat layer not have?
// Finding this once up front beats discovering it one failing test at a time.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const SUPPORTED = new Set([
  // e2e's own value matchers.
  "toBe", "toEqual", "toMatchObject", "toBeTruthy", "toBeFalsy", "toBeNull", "toBeUndefined",
  "toBeDefined", "toHaveLength", "toHaveProperty", "toContain", "toMatch", "toBeGreaterThan",
  "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual", "toBeCloseTo", "toMatchSchema",
  // Added by tests/support/e2e-compat.ts.
  "toThrow", "toThrowError", "toBeInstanceOf", "toContainEqual", "toStartWith", "toEndWith",
  "toHaveBeenCalled", "toHaveBeenCalledOnce", "toHaveBeenCalledTimes", "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith", "toHaveBeenNthCalledWith",
  // Engine matchers, only legal on a locator or browser fixture.
  "toBeVisible", "toBeHidden", "toBeAttached", "toBeChecked", "toBeDisabled", "toBeEnabled",
  "toBeFocused", "toBeExpanded", "toBeSelected", "toContainText", "toHaveURL", "toHaveTitle",
  "toHaveText", "toHaveValue", "toHaveAttribute", "toHaveScreenshot", "toHaveCount",
]);

const used = new Map();
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/(\.test|\.spec)\.(ts|tsx|mts)$/.test(entry)) files.push(full);
  }
}

for (const dir of process.argv.slice(2).length ? process.argv.slice(2) : ["shared", "supervisor", "worker", "deliverables", "desktop", "agent-bot", "agent-sandbox", "agent-langgraph", "agent-mastra", "agent-computer", "app", "server", "tests", "scripts"]) {
  walk(resolve(root, dir));
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\.(to[A-Za-z0-9_]+)\s*\(/g)) {
    const name = match[1];
    if (!SUPPORTED.has(name)) {
      const entry = used.get(name) ?? { count: 0, files: new Set() };
      entry.count++;
      entry.files.add(file.replace(`${root}/`, ""));
      used.set(name, entry);
    }
  }
}

const rows = [...used].sort((a, b) => b[1].count - a[1].count);
console.log(`${files.length} suite files, ${rows.length} matcher names the compat layer does not have:\n`);
for (const [name, entry] of rows) {
  console.log(`  ${String(entry.count).padStart(5)}  ${name}  (${entry.files.size} files)  e.g. ${[...entry.files][0]}`);
}
