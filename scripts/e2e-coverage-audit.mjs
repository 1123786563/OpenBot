#!/usr/bin/env node
// The completion audit for "every test runs under tester-army e2e", stated as accounting.
//
// "All migrated" is only checkable if each suite file lands in exactly one of three buckets, and any
// file in none of them is a gap:
//
//   native   collected and executed by e2e on Node (imports the e2e-backed compat layer)
//   driven   scheduled and reported by e2e, executed by `bun test` (the Bun-runtime tier, ADR 0008)
//   excluded named in a manifest with a reason: an artifact that cannot run here, or a suite this
//            repository's own fixture broke — `bun run test:ci` prints the count so it cannot grow
//            silently
//
// A file on the bun:test layer — `bun:test` or `support/bun-test-compat` — that is not driven, a file
// that imports neither layer, or a driven file that still imports the e2e layer, is a gap: the first
// aborts collection, the second never runs, the third hits Node-only code under Bun. Exits non-zero so
// CI can gate on it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LIVE_SUITES, SUITE_DIRS } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const dirs = SUITE_DIRS;
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.test\.(tsx?|mts)$|\.spec\.(tsx?|mts)$|\.e2e\.tsx?$/.test(entry))
      files.push(full);
  }
}
for (const dir of dirs) walk(join(root, dir));

const driven = new Set(
  JSON.parse(
    readFileSync(join(root, "tests/config/e2e-bun-suites.json"), "utf8"),
  ).files ?? [],
);
const artifacts = new Set(
  JSON.parse(
    readFileSync(join(root, "tests/config/e2e-bun-suites.json"), "utf8"),
  ).artifacts ?? [],
);
const live = new Set(LIVE_SUITES);
const broken = new Set(
  (
    JSON.parse(
      readFileSync(
        join(root, "tests/config/e2e-known-broken.json"),
        "utf8",
      ),
    ).entries ?? []
  ).map((entry) => entry.file),
);

const buckets = { native: [], driven: [], engine: [], excluded: [], gap: [] };
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  const source = readFileSync(file, "utf8");
  const importsBunTest = /^import[\s\S]{0,400}?from ["']bun:test["'];/m.test(
    source,
  );
  const bunLayer = /support\/bun-test-compat["']/.test(source);
  const e2eLayer = /support\/e2e-compat["']/.test(source);
  const engine = /\.e2e\.tsx?$/.test(rel) || /from "@e2e-dev\//.test(source);
  if (artifacts.has(rel) || broken.has(rel) || live.has(rel))
    buckets.excluded.push(rel);
  else if (engine) buckets.engine.push(rel);
  else if (driven.has(rel)) {
    if (!importsBunTest && !bunLayer)
      buckets.gap.push(`${rel} (driven but not on the bun:test layer)`);
    else buckets.driven.push(rel);
  } else if (importsBunTest || bunLayer)
    buckets.gap.push(
      `${rel} (imports the bun:test layer, not driven → Node collection aborts the whole run)`,
    );
  else if (e2eLayer) buckets.native.push(rel);
  else if (/^\s*(test|describe)\s*\(/m.test(source))
    buckets.gap.push(`${rel} (registers tests, imports no runner)`);
  else buckets.gap.push(`${rel} (no runner import and no registrations)`);
}

/*
 * The entry points are part of the claim. A session that reverts `bun run test` back to a `bun test`
 * list silently un-migrates the whole corpus while every suite file above still looks correct, so the
 * scripts and the CI workflows are read as they are rather than trusted from memory. (This happened
 * once already: an integration merge restored the old `test` script and it had to be re-pointed.)
 *
 * Every package.json in the tree counts as an entry point, and every script name — not just one
 * called `test`. Two nested packages kept their own `bun test` (`agent-sandbox`'s `test`, `server`'s
 * `kb:test`) while the root-only scan reported the corpus fully migrated, which is the difference
 * between "the scripts I thought about" and "the scripts that exist".
 */
function entryPointGaps() {
  const gaps = [];
  const seen = [];
  const notCode = new Set([...SKIP, "archive", ".mimosa", "deliverables"]);
  const walkPackages = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (notCode.has(entry.name) || entry.name.startsWith(".")) continue;
        walkPackages(join(dir, entry.name));
      } else if (entry.name === "package.json") {
        seen.push(join(dir, entry.name));
      }
    }
  };
  walkPackages(root);
  for (const file of seen) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      gaps.push(`${relative(root, file)}: unreadable package.json`);
      continue;
    }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (/\bbun\s+(test|x\s+test)\b/.test(String(command)))
        gaps.push(`${relative(root, file)} "${name}": ${command}`);
    }
  }
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split(
      "\n",
    )) {
      if (/\bbun\s+(test|x\s+test)\b/.test(line) && !/^\s*[#-]*\s*#/.test(line))
        gaps.push(`${file}: ${line.trim().slice(0, 130)}`);
    }
  }
  return gaps;
}

/*
 * Tier agreement. A suite that imports `support/bun-test-compat` is written for the Bun runtime, and
 * e2e.unit.config.ts excludes files from native collection *by manifest membership* — so such a file
 * missing from the manifest is collected on Node and aborts the whole run with
 * `Only URLs with a scheme in: file, data, and node … 'bun:'`. That is how a billing commit on main
 * broke CI's tests job while this audit still printed `no gaps`: it accepted any `support/*-compat`
 * import as native and never compared the imported layer against the manifest. The check lives in the
 * classification loop above, so a mis-tiered file is a gap rather than a native count.
 */
/*
 * Foreign runners. The claim "every test runs under tester-army e2e" is only honest if the corpora
 * e2e cannot execute are *named* — and naming them once is not enough, because the boundary moves:
 * a new `python -m pytest agent-new/tests` job or a deleted Go job both leave the registry, and the
 * audit, lying quietly. So every workflow line that invokes a non-e2e runner must match an entry, and
 * every entry must still match something in the tree.
 */
const FOREIGN_TRIGGER = /(python -m pytest .*|cargo test .*|\bgo test .*)$/;
function foreignGaps() {
  const gaps = [];
  const registryPath = join(
    root,
    "tests/config/e2e-foreign-suites.json",
  );
  if (!existsSync(registryPath))
    return [
      "tests/config/e2e-foreign-suites.json is missing: a corpus e2e cannot execute must be migrated or named there, not left out of the walk.",
    ];
  const entries =
    JSON.parse(readFileSync(registryPath, "utf8")).entries ?? [];
  const seen = new Set();
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split("\n")) {
      const trimmed = line.trim().replace(/^-\s*/, "").replace(/^run:\s*/, "");
      if (!trimmed || trimmed.startsWith("#")) continue;
      const hit = trimmed.match(FOREIGN_TRIGGER);
      if (!hit) continue;
      const command = hit[1].trim();
      const named = entries.some((entry) =>
        new RegExp(entry.pattern).test(command),
      );
      if (!named)
        gaps.push(
          `${file}: \`${command}\` runs a non-e2e test corpus that no entry in tests/config/e2e-foreign-suites.json names`,
        );
      entries.forEach((entry, index) => {
        if (new RegExp(entry.pattern).test(command))
          seen.add(index);
      });
    }
  }
  entries.forEach((entry, index) => {
    // `invoked: false` is the shape of a named hole: the corpus exists and nothing runs it. Requiring
    // it to be invoked would turn the finding back into a green check, which is the opposite of why
    // the Go row is here.
    if (!seen.has(index) && entry.invoked !== false)
      gaps.push(
        `${entry.runner}: named in the registry but invoked by no workflow any more — the boundary moved, so either the corpus came back to e2e or the job was dropped; say which and delete the entry`,
      );
  });
  return gaps;
}

/*
 * The engine tier needs its own entry check. `tests/e2e/*.e2e.ts` is collected by e2e's *default*
 * config (measured: `bunx e2e list` with no `--config` selects exactly those 10 files / 28 tests, the
 * same set `--config e2e.config.ts` gives), so counting them as "scheduled by e2e" is only honest if
 * some entry point actually invokes that default. It also must not be read as CI coverage: the only
 * entry is a human-run script, and the job list says no workflow runs it.
 */
function engineEntry() {
  const scripts = Object.entries(
    JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).scripts ?? {},
  );
  const entry = scripts.find(
    ([, command]) =>
      /\be2e\s+run\b/.test(String(command)) &&
      !/--config\s+\S*unit\.config/.test(String(command)),
  );
  const inCI = [];
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split(
      "\n",
    )) {
      if (!/\be2e run\b/.test(line) || /unit\.config/.test(line)) continue;
      if (/\.e2e\.(ts|tsx)/.test(line) || /run test:ui/.test(line)) inCI.push(file);
    }
  }
  return {
    name: entry ? `bun run ${entry[0]}` : null,
    scheduledInCI: [...new Set(inCI)],
  };
}

const engineEntryInfo = engineEntry();
const foreign = foreignGaps();
const entries = entryPointGaps();
if (buckets.engine.length && !engineEntryInfo.name)
  entries.push(
    `engine tier: ${buckets.engine.length} .e2e.ts files are collected only by e2e's default config, and no script invokes \`e2e run\` without --config`,
  );
console.log(
  `${files.length} suite files in the 14 migrated directories · ${buckets.native.length} native e2e · ${buckets.driven.length} driven by e2e (bun runtime) · ${buckets.engine.length} engine (.e2e.ts, web/mobile) · ${buckets.excluded.length} named exclusions`,
);
if (buckets.gap.length) {
  console.log(
    `\nGAPS (${buckets.gap.length}) — each one means the corpus is not fully accounted:`,
  );
  for (const gap of buckets.gap.slice(0, 40)) console.log(`  ${gap}`);
  process.exit(1);
}
if (foreign.length) {
  console.log(
    `\nFOREIGN RUNNERS (${foreign.length}) — the boundary between e2e and the runners e2e cannot execute must stay named:`,
  );
  for (const gap of foreign) console.log(`  ${gap}`);
  process.exit(1);
}
if (entries.length) {
  console.log(
    `\nENTRY-POINT GAPS (${entries.length}) — every suite may be scheduled by e2e while the command that runs it is not:`,
  );
  for (const gap of entries) console.log(`  ${gap}`);
  process.exit(1);
}
console.log(
  "\nno gaps: every suite file is scheduled by e2e, every test entry point runs e2e, and exclusions are named with a reason.",
);
console.log(
  `engine tier entry: ${engineEntryInfo.name ?? "none"} · scheduled by CI: ${
    engineEntryInfo.scheduledInCI.length
      ? engineEntryInfo.scheduledInCI.join(", ")
      : "no — nothing in .github/workflows runs it, so those tests are collected and reported by e2e but never executed there (audit item 7)"
  }`,
);
