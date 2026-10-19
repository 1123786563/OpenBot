import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { SUITE_DIRS, readManifest } = await import(
  join(root, "scripts/lib/e2e-manifest.mjs")
);
const reportPath = resolve(root, process.argv[2] ?? ".e2e/unit/report.json");
const run = JSON.parse(readFileSync(reportPath, "utf8")).run;
const executed = new Map();
for (const r of run.results ?? []) {
  if (!r.file) continue;
  const rel = r.file.replace(`${root}/`, "");
  executed.set(rel, (executed.get(rel) ?? 0) + 1);
}
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const m = readManifest();
const excluded = new Set([...m.artifacts]);
for (const e of JSON.parse(
  readFileSync(join(root, "docs/verification/e2e-known-broken.json"), "utf8"),
).entries ?? [])
  excluded.add(e.file);
const native = [],
  engine = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.e2e\.tsx?$/.test(entry))
      engine.push(full.replace(`${root}/`, ""));
    else if (TEST_FILE.test(entry)) {
      const rel = full.replace(`${root}/`, "");
      if (!m.files.has(rel) && !excluded.has(rel)) native.push(rel);
    }
  }
}
for (const d of SUITE_DIRS) {
  const abs = join(root, d);
  if (existsSync(abs)) walk(abs);
}
native.sort();
const missing = native.filter((f) => !executed.has(f));
const extra = [...executed.keys()].filter(
  (f) =>
    !native.includes(f) &&
    !m.files.has(f) &&
    !excluded.has(f) &&
    !/\.e2e\.tsx?$/.test(f),
);
console.log("report:", reportPath.replace(`${root}/`, ""));
console.log(
  `native bucket ${native.length} · files e2e executed ${executed.size} · engine ${engine.length}`,
);
console.log(`native files that contributed NO test: ${missing.length}`);
missing.slice(0, 40).forEach((f) => {
  console.log("   ", f);
});
/*
 * Missing files that are missing by design, not by drift. `api.e2e.test.ts` only runs against a
 * live deployment (`bun run test:api`); anything else joining this set must say why it is exempt
 * and when it plans to leave. Everything outside the set fails the run: a native-bucket file no
 * entry collected is the audit's bucket and the runner disagreeing, which is how 85 desktop tests
 * sat "covered" while nothing ran them (docs/plans/2026-10-18-e2e-tester-army-migration-status.md,
 * the 10-19 04:07 section).
 */
const ALLOWED_MISSING = new Set(["tests/e2e/api.e2e.test.ts"]);
const unlisted = missing.filter((f) => !ALLOWED_MISSING.has(f));
if (unlisted.length) {
  console.error(
    `\n${unlisted.length} native file(s) contributed no test and are not whitelisted in ALLOWED_MISSING —`,
  );
  console.error(
    "collect them, move them to the driven manifest, or name them in e2e-known-broken.json.",
  );
  process.exit(1);
}
console.log(
  `executed but in no bucket (expect the driver file): ${extra.length}`,
);
extra.slice(0, 10).forEach((f) => {
  console.log("   ", f);
});
