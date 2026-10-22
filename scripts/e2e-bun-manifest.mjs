#!/usr/bin/env node
// Split the per-file audit into what must keep running on Bun and what is still ours to fix.
//
// Only a Bun-runtime dependency belongs in the driven manifest. Anything else — a matcher the compat
// layer has not grown yet, an alias the runner cannot resolve, a file that registers nothing — is a
// gap in this repository's harness and must not be hidden by routing it onto another runtime.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// The grouping, the manifest path and THE writer come from the shared lib:
// writeManifest() applies BOTH island kinds — the filename-prefix ISLANDS
// (ai-observability-, billing-credits-writer, gateway-probe; measured, not
// guessed — see the lib comment) and the DIRECTORY_ISLANDS — with the same
// sort and "part N" naming every other writer uses, and persists the same
// payload shape (directoryIslands + audit + causes) so no writer can strip
// what another recorded. A hand-rolled second grouping here once drifted
// from it and silently re-merged the prefix islands into 24-file
// alphabetical slices, which is exactly the false-red configuration the
// islands exist to prevent.
import { MANIFEST, readManifest, writeManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const auditPath = process.argv[2] ?? "archive/verification/e2e-file-audit.json";

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

// One grouping algorithm, one writer: writeManifest() keys directory islands
// by full path and filename-prefix islands by their own key, so a group's red
// keeps meaning "these files are red together" without this script
// re-deriving any of it. The per-file `causes` evidence other writers
// recorded is preserved (filtered to files still on the manifest) — a
// regeneration that wiped it was the dual-writer bug this convergence fixes.
// Bootstrap-from-zero: a manifest that is missing, wiped, or half-written
// (an interrupted writer leaves truncated JSON) must not crash the generator
// before it writes anything — so the parse is guarded, not just the stat.
// Only `causes` is read off `existing`; `audit` is absent, which
// writeManifest() treats as "this writer records none".
let existing;
try {
  existing = existsSync(MANIFEST) ? readManifest() : { causes: {} };
} catch (error) {
  console.warn(
    `e2e-bun-manifest: existing manifest unreadable, dropping recorded causes (${
      error instanceof Error ? error.message : String(error)
    })`,
  );
  existing = { causes: {} };
}
const kept = new Set([...driven, ...artifacts].map((entry) => entry.file));
const keptCauses = Object.fromEntries(
  Object.entries(existing.causes).filter(([file]) => kept.has(file)),
);
const groupCount = writeManifest(
  {
    files: driven.map((d) => d.file),
    artifacts: artifacts.map((a) => a.file),
    causes: keptCauses,
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
