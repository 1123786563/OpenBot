#!/usr/bin/env node
// Which matcher-like names does the corpus use that the compat layer does not provide?
// Finding this once up front beats discovering it one failing test at a time.
//
// A regex over source cannot tell `expect(x).toBeString()` from `value.toString()`, so the plain
// Object/String methods that merely start with `to` are excluded; what is left is a candidate list
// to confirm, not a verdict.
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
// A regex over source cannot tell `expect(x).toBeString()` from `value.toString()`.
const NOT_MATCHERS = new Set([
  "toString",
  "toLocaleString",
  "toLowerCase",
  "toUpperCase",
  "toISOString",
  "toSorted",
  "toJSON",
  "toPrimitive",
  "toPromise",
  "toReversed",
  "toSpliced",
  "toSlice",
]);
/*
 * Read the supported set out of the compat layer itself. A hand-maintained copy here silently
 * claimed `toBeTrue` and friends were missing long after the shim grew them, which is how a
 * coverage tool talks itself into a wave of nonexistent work.
 */
const compat = readFileSync(join(root, "tests/support/e2e-compat.ts"), "utf8");
const namesFrom = (block) =>
  [...block.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
const delegatedBlock = compat.slice(
  compat.indexOf("const DELEGATED"),
  compat.indexOf("const ADDED"),
);
const addedBlock = compat.slice(
  compat.indexOf("const ADDED"),
  compat.indexOf("/** Bun's type predicates"),
);
const typesBlock = compat.slice(
  compat.indexOf("const TYPES"),
  compat.indexOf("function show("),
);
const SUPPORTED = new Set([
  ...namesFrom(delegatedBlock),
  ...namesFrom(addedBlock),
  ...namesFrom(typesBlock),
  "toStartWith",
  "toEndWith",
  "toContainEqual",
  // Engine matchers, legal only on a locator or browser fixture.
  "toBeVisible",
  "toBeHidden",
  "toBeAttached",
  "toBeChecked",
  "toBeDisabled",
  "toBeEnabled",
  "toBeFocused",
  "toBeExpanded",
  "toBeSelected",
  "toContainText",
  "toHaveURL",
  "toHaveTitle",
  "toHaveText",
  "toHaveValue",
  "toHaveAttribute",
  "toHaveScreenshot",
  "toHaveCount",
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

for (const dir of process.argv.slice(2).length
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
    ]) {
  walk(resolve(root, dir));
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\.(to[A-Za-z0-9_]+)\s*\(/g)) {
    const name = match[1];
    if (!SUPPORTED.has(name) && !NOT_MATCHERS.has(name)) {
      const entry = used.get(name) ?? { count: 0, files: new Set() };
      entry.count++;
      entry.files.add(file.replace(`${root}/`, ""));
      used.set(name, entry);
    }
  }
}

const rows = [...used].sort((a, b) => b[1].count - a[1].count);
console.log(
  `${files.length} suite files, ${rows.length} matcher names the compat layer does not have:\n`,
);
for (const [name, entry] of rows) {
  console.log(
    `  ${String(entry.count).padStart(5)}  ${name}  (${entry.files.size} files)  e.g. ${[...entry.files][0]}`,
  );
}
