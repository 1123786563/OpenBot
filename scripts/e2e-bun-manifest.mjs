#!/usr/bin/env node
// Split the per-file audit into what must keep running on Bun and what is still ours to fix.
//
// Only a Bun-runtime dependency belongs in the driven manifest. Anything else — a matcher the compat
// layer has not grown yet, an alias the runner cannot resolve, a file that registers nothing — is a
// gap in this repository's harness and must not be hidden by routing it onto another runtime.
// A file that collects nowhere on this machine is also not allowed to vanish: it cannot live in the
// manifest's files[] (that key is the driven contract — the unit config excludes exactly it from
// native collection), so it is registered with its reason in tests/config/e2e-known-broken.json,
// the exclusion surface the unit config honors and the coverage audit counts as named exclusions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// The writer is the shared one: writeManifest() applies BOTH island kinds
// (filename-prefix ISLANDS and DIRECTORY_ISLANDS) and persists the full
// payload shape (directoryIslands + audit + causes). A hand-rolled second
// writer here once omitted those keys and silently re-merged the multitenancy
// islands into 24-file slices — the exact false-red configuration the
// directoryIslands contract exists to prevent (the driver keys
// MT_TEST_DATABASE_URL routing off it).
import { sanitizeCauseText, writeManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const auditPath = process.argv[2] ?? "archive/verification/e2e-file-audit.json";
const BROKEN_PATH = "tests/config/e2e-known-broken.json";

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
  /Received protocol 'bun:'/,
  /from ['"]bun:[a-z]+['"]/,
  /bun:ffi/,
  /drizzle-orm\/bun-/,
  /Bun is not defined/,
  /Cannot find package ['"]@tauri-apps/,
];

const audit = JSON.parse(readFileSync(resolve(root, auditPath), "utf8"));

const artifacts = audit.filter(
  (entry) =>
    entry.status !== "collected" &&
    ARTIFACTS.some((pattern) => pattern.test(entry.file)),
);
const driven = audit.filter(
  (entry) =>
    entry.status !== "collected" &&
    !artifacts.includes(entry) &&
    (BUN_RUNTIME.some((pattern) => pattern.test(entry.error ?? "")) ||
      LOADER_GAP.some((pattern) => pattern.test(entry.error ?? ""))),
);
const todo = audit.filter(
  (entry) =>
    entry.status !== "collected" &&
    !driven.includes(entry) &&
    !artifacts.includes(entry),
);

/*
 * The named-exclusion surface for suites that collect nowhere on this machine.
 * This regenerator owns the registry's reconciliation: a hand-written entry for
 * a file that still fails keeps its reason (curation wins over the machine's),
 * a file that now collects or is drivable loses its entry (the registry's own
 * rule — the entry disappears when the suite is repointed), and every reason
 * the machine writes is sanitized of host paths first. Written only when
 * something changed, so a regeneration never churns an unchanged registry.
 */
function registerKnownBroken(todo) {
  const existing = existsSync(BROKEN_PATH)
    ? JSON.parse(readFileSync(BROKEN_PATH, "utf8"))
    : {};
  const byFile = new Map(
    (existing.entries ?? []).map((entry) => [entry.file, entry]),
  );
  const failing = new Set(todo.map((entry) => entry.file));
  const entries = todo.map((entry) => {
    const hand = byFile.get(entry.file);
    if (hand) return hand;
    return {
      file: entry.file,
      reason: sanitizeCauseText(
        entry.error ?? "does not collect in this checkout",
      ),
      evidence: `scripts/e2e-file-audit.mjs collection audit, status=${entry.status}`,
      added: new Date().toISOString().slice(0, 10),
    };
  });
  const dropped = [...byFile.keys()].filter((file) => !failing.has(file));
  const next = { ...existing, entries };
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    writeFileSync(BROKEN_PATH, `${JSON.stringify(next, null, 1)}\n`);
  }
  console.log(
    `${entries.length} suite(s) registered uncollectable in ${BROKEN_PATH}` +
      (dropped.length
        ? ` (${dropped.length} recovered since the last registry, entry dropped)`
        : ""),
  );
  return entries;
}
registerKnownBroken(todo);

const groupCount = writeManifest(
  {
    files: driven.map((d) => d.file),
    artifacts: artifacts.map((a) => a.file),
    causes: Object.fromEntries(
      todo.map((entry) => [entry.file, entry.error ?? "unknown"]),
    ),
    audit: auditPath,
  },
  "scripts/e2e-bun-manifest.mjs",
);

console.log(`${audit.length} files audited`);
console.log(
  `${driven.length} kept on the Bun runtime, in ${groupCount} driven group(s)`,
);
console.log(
  `${artifacts.length} deliverable artifacts, not executable here: ${artifacts.map((a) => a.file).join(", ")}`,
);
console.log(`${todo.length} still ours to fix:`);
const causes = new Map();
for (const entry of todo) {
  const key = (entry.error ?? "")
    .replace(/["'`].{0,60}["'`]/g, "…")
    .replace(/\d+/g, "N")
    .slice(0, 96);
  causes.set(key, (causes.get(key) ?? 0) + 1);
}
for (const [cause, count] of [...causes]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
}
