#!/usr/bin/env node
// Does the driven tier judge each file the way the pre-migration invocation did?
//
// The pre-migration entry handed `bun test` one process per top-level directory. The driven tier
// slices each directory into 24-file groups, which is *less* shared state, so a file that is green
// inside a slice could have been red in the whole-directory run — and vice versa. Group-level
// equality was already measured; this reconciles per file, which is the claim the migration
// actually rests on.
//
// Both sides come from `bun test` itself, so this is not a runner-vs-runner check: it is
// "one process per directory" vs "the process shape e2e schedules", with the same suite text and
// the same code.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const reportPath = resolve(
  root,
  arg("report", ".e2e/clean-confirm/report.json"),
);
const out = resolve(
  root,
  arg("out", "docs/verification/e2e-driven-file-equality.json"),
);
const timeoutMs = Number(arg("timeout", 900_000));

if (!existsSync(reportPath)) {
  console.error(`no e2e report at ${reportPath}; run \`bun run test\` first`);
  process.exit(2);
}

/* Per-file verdicts the driver recorded: it names each failing file in its assertion message. */
const run = JSON.parse(readFileSync(reportPath, "utf8")).run;
const driver = new Map();
const groupStatus = new Map();
for (const result of run.results ?? []) {
  const title = (result.titlePath || []).join(" > ");
  if (!title.includes("bun runtime suite")) continue;
  const group = title.replace(/^.*bun runtime suite /, "");
  const message = (result.attempts || [])
    .map((a) => a?.error?.message || "")
    .join("\n");
  groupStatus.set(group, result.status);
  const named = new Set(
    [
      ...message.matchAll(
        /((?:server|app|agent-[a-z]+|desktop|shared|tests|scripts)\/[^ :\n]+\.test\.tsx?)/g,
      ),
    ].map((m) => m[1]),
  );
  for (const file of named) driver.set(file, (driver.get(file) ?? 0) + 1);
}

/* Whole-directory runs, the shape the pre-migration entry used. */
const driven = [...readManifest().files];
const only = (arg("only", "") || "").split(",").filter(Boolean);
// A driven file can sit two segments deep (`shared/x.test.ts`), where "the directory" is the top
// segment; taking two segments anyway produced a key that is a file path, whose prefix match found no
// files at all and handed `bun test` an empty list — which then ran the whole repository.
const keyOf = (f) => {
  const segments = f.split("/");
  return segments.length > 2 ? segments.slice(0, 2).join("/") : segments[0];
};
const directories = [...new Set(driven.map(keyOf))]
  .sort()
  .filter((d) => !only.length || only.includes(d));
const perFile = new Map();
const runs = [];
for (const directory of directories) {
  const files = driven.filter((f) => keyOf(f) === directory).sort();
  if (!files.length) continue;
  const work = mkdtempSync(join(tmpdir(), "e2e-driven-eq-"));
  const junit = join(work, "junit.xml");
  const child = spawnSync(
    "bun",
    [
      "test",
      ...files.map((f) => `./${f}`),
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ],
    { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 28 },
  );
  let counted = null;
  if (existsSync(junit)) {
    const xml = readFileSync(junit, "utf8");
    // A `<testcase/>` that is self-closed passed; one with a body carries `<failure>` or
    // `<skipped/>`, and counting a skipped case as red would invent mismatches.
    for (const block of xml.matchAll(
      /<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g,
    )) {
      const tag = /<testcase\b[^>]*>/.exec(block[0])?.[0];
      const file = tag ? /file="([^"]+)"/.exec(tag)?.[1] : undefined;
      if (!file) continue;
      const rel = file.replace(`${root}/`, "");
      const failed = /<failure\b/.test(block[0]);
      const entry = perFile.get(rel) ?? { tests: 0, failures: 0 };
      entry.tests++;
      if (failed) entry.failures++;
      perFile.set(rel, entry);
      counted = (counted ?? 0) + 1;
    }
  }
  runs.push({
    directory,
    files: files.length,
    exit: child.status ?? `signal ${child.signalCode}`,
    cases: counted ?? 0,
    note: counted
      ? ""
      : "no junit parsed — this directory's verdict is unmeasured, not green",
  });
  rmSync(work, { recursive: true, force: true });
  console.log(
    `${directory}: files ${files.length} · cases ${counted ?? 0} · exit ${child.status}`,
  );
}

/* Reconcile: a file red in the whole-directory run must be red in the driver, and vice versa. */
const mismatches = [];
for (const [file, entry] of [...perFile].sort()) {
  const dirRed = entry.failures > 0;
  const driverRed = driver.has(file);
  if (dirRed !== driverRed) {
    mismatches.push({
      file,
      wholeDirectory: dirRed
        ? `red (${entry.failures}/${entry.tests})`
        : `green (${entry.tests})`,
      driver: driverRed
        ? "named red"
        : perFile.has(file)
          ? "not named"
          : "unknown",
    });
  }
}
const summary = {
  generatedAt: new Date().toISOString(),
  report: reportPath.replace(`${root}/`, ""),
  directories: runs,
  filesMeasured: perFile.size,
  filesNamedRedByDriver: driver.size,
  mismatches,
};
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(
  `\n${perFile.size} file(s) judged by the whole-directory runs · ${driver.size} named red by the driver · ${mismatches.length} mismatch(es)`,
);
for (const m of mismatches.slice(0, 40))
  console.log(
    `  ${m.file}\n     directory-run ${m.wholeDirectory} · driver ${m.driver}`,
  );
console.log(`\nwrote ${out.replace(`${root}/`, "")}`);
