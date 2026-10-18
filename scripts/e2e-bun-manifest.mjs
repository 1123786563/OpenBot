#!/usr/bin/env node
// Split the per-file audit into what must keep running on Bun and what is still ours to fix.
//
// Only a Bun-runtime dependency belongs in the driven manifest. Anything else — a matcher the compat
// layer has not grown yet, an alias the runner cannot resolve, a file that registers nothing — is a
// gap in this repository's harness and must not be hidden by routing it onto another runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const auditPath = process.argv[2] ?? "docs/verification/e2e-file-audit.json";
const groupSize = Number(process.env.E2E_BUN_GROUP_SIZE ?? 24);

// The mobile QA deliverable is written against an Appium driver and a device bundle: it is not
// executable in this repository and never ran under `bun test` either. It is kept out of both the
// native collection and the Bun-driven groups, and named here so the exclusion is auditable.
const ARTIFACTS = [/^deliverables\//];

// Bun's module loader answers things Node's does not: the `bun` package itself, stylesheets and
// other assets, and writable ESM namespace objects. Those are runtime differences, not gaps this
// repository's harness can paper over, so the suites that need them run under the driven groups.
const LOADER_GAP = [
  /Unknown file extension /,
  /Cannot assign to property .* of \[object Module\]/,
  /does not provide an export named/,
];

const BUN_RUNTIME = [
  /Cannot find package ['"]bun['"]/,
  /bun:sqlite/,
  /bun:ffi/,
  /drizzle-orm\/bun-/,
  /Bun is not defined/,
  /Cannot find package ['"]@tauri-apps/,
];

const audit = JSON.parse(readFileSync(resolve(root, auditPath), "utf8"));

const artifacts = audit.filter(
  (entry) => entry.status !== "collected" && ARTIFACTS.some((pattern) => pattern.test(entry.file)),
);
const driven = audit.filter(
  (entry) =>
    entry.status !== "collected" &&
    !artifacts.includes(entry) &&
    (BUN_RUNTIME.some((pattern) => pattern.test(entry.error ?? "")) ||
      LOADER_GAP.some((pattern) => pattern.test(entry.error ?? ""))),
);
const todo = audit.filter(
  (entry) => entry.status !== "collected" && !driven.includes(entry) && !artifacts.includes(entry),
);

const byDirectory = new Map();
for (const entry of driven) {
  const directory = entry.file.split("/").slice(0, 2).join("/");
  if (!byDirectory.has(directory)) byDirectory.set(directory, []);
  byDirectory.get(directory).push(entry.file);
}

const groups = [];
for (const [directory, files] of byDirectory) {
  for (let index = 0; index < files.length; index += groupSize) {
    const chunk = files.slice(index, index + groupSize);
    groups.push({
      name: `${directory}${files.length > groupSize ? ` part ${index / groupSize + 1}` : ""}`,
      files: chunk,
    });
  }
}

writeFileSync(
  resolve(root, "docs/verification/e2e-bun-suites.json"),
  `${JSON.stringify({ generatedBy: "scripts/e2e-bun-manifest.mjs", audit: auditPath, groups, files: driven.map((d) => d.file),
      artifacts: artifacts.map((a) => a.file) }, null, 1)}\n`,
);

console.log(`${audit.length} files audited`);
console.log(`${driven.length} kept on the Bun runtime, in ${groups.length} driven group(s)`);
console.log(`${artifacts.length} deliverable artifacts, not executable here: ${artifacts.map((a) => a.file).join(", ")}`);
console.log(`${todo.length} still ours to fix:`);
const causes = new Map();
for (const entry of todo) {
  const key = (entry.error ?? "").replace(/["'`].{0,60}["'`]/g, "…").replace(/\d+/g, "N").slice(0, 96);
  causes.set(key, (causes.get(key) ?? 0) + 1);
}
for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
}
