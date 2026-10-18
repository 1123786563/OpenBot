#!/usr/bin/env node
// Attributes every failure honestly: was this suite already red before the migration, or did the
// migration make it red?
//
// A red test under `bun run test` says nothing on its own about faithfulness, so each failing file is
// run three ways and compared:
//
//   new runner   current code + migrated suite, via the report the run already produced
//   old runner   current code + the suite as it read before the migration, via `bun test`
//   baseline     the whole tree at the pre-migration commit, via `bun test`
//
// The middle control is the one that separates the two explanations: same code, same suite text, only
// the runner swapped. It needs a copy of the working tree, because dropping an old suite file next to
// current production code inside this checkout would write into a tree other sessions share — so the
// snapshot lives outside it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const reportPath = resolve(root, arg("report", ".e2e/unit/report.json"));
const baseline = resolve(
  root,
  arg("baseline", `${process.env.HOME}/.cache/openbot-e2e/baseline`),
);
const live = resolve(root, arg("live", `${process.env.HOME}/.cache/openbot-e2e/live`));
const out = resolve(root, arg("out", "docs/verification/e2e-vs-bun.json"));
const jobs = Number(arg("jobs", 4));
const timeoutMs = Number(arg("timeout", 240_000));
const only = (arg("only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const [label, dir] of [
  ["baseline", baseline],
  ["live snapshot", live],
]) {
  if (!existsSync(dir)) {
    console.error(
      `no ${label} tree at ${dir}\n  baseline: git archive <pre-migration SHA> | tar -x -C ~/.cache/openbot-e2e/baseline\n  live:     rsync -a --exclude node_modules --exclude .git --exclude .e2e --exclude .worktrees ./ ~/.cache/openbot-e2e/live/`,
    );
    process.exit(2);
  }
}

const run = JSON.parse(readFileSync(reportPath, "utf8")).run;
const failed = new Map();
for (const result of run.results ?? []) {
  if (result.status === "passed" || result.status === "skipped") continue;
  const entry = failed.get(result.file) ?? { tests: 0, messages: [] };
  entry.tests++;
  const attempt = result.attempts?.[result.attempts.length - 1];
  if (attempt?.error?.message) {
    entry.messages.push(
      `${result.titlePath?.slice(-1)[0]}: ${String(attempt.error.message).replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
  failed.set(result.file, entry);
}
const files = (only.length ? only : [...failed.keys()]).sort();

function bunTest(cwd, file) {
  return new Promise((done) => {
    const junit = `/tmp/openbot-e2e-vs-bun-${file.replace(/[^\w]/g, "_")}.xml`;
    const child = spawn(
      "bun",
      ["test", file, "--reporter=junit", `--reporter-outfile=${junit}`],
      {
        cwd,
        env: { ...process.env, BUN_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let tail = "";
    child.stdout.on("data", (chunk) => (tail = (tail + chunk).slice(-6000)));
    child.stderr.on("data", (chunk) => (tail = (tail + chunk).slice(-6000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      let counts = null;
      try {
        const m = readFileSync(junit, "utf8").match(
          /<testsuite[^>]*\stests="(\d+)"[^>]*\sfailures="(\d+)"[^>]*\serrors="(\d+)"/,
        );
        counts = m ? { tests: +m[1], failures: +m[2] + +m[3] } : null;
      } catch {
        counts = null;
      }
      // A killed or unparseable run is never counted as a pass.
      done({
        counts,
        signal: child.signalCode ?? null,
        named: tail
          .split("\n")
          .filter((line) => /^\((fail|error)\)/.test(line))
          .slice(0, 5),
      });
    });
  });
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length || 1) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

const rows = await pool(files, jobs, async (file) => {
  const target = resolve(live, file);
  const before = existsSync(resolve(baseline, file))
    ? readFileSync(resolve(baseline, file), "utf8")
    : null;
  let old = { counts: null, signal: null, named: [] };
  let base = { counts: null, signal: null, named: [] };
  if (before !== null && existsSync(target)) {
    // The control writes only into the snapshot: the suite text as it read before the migration,
    // against production code as it stands now.
    writeFileSync(target, before);
    old = await bunTest(live, file);
    base = await bunTest(baseline, file);
  }
  const oldRed = old.counts ? old.counts.failures > 0 || old.counts.tests === 0 : null;
  const baseRed = base.counts ? base.counts.failures > 0 || base.counts.tests === 0 : null;
  let verdict;
  if (before === null || !existsSync(target)) {
    verdict = "no-pre-migration-suite";
  } else if (old.counts === null) {
    verdict = old.signal ? "old-runner-timeout" : "old-runner-unreadable";
  } else if (oldRed) {
    verdict = baseRed ? "already-red-at-baseline" : "red-on-old-runner-with-current-code";
  } else {
    verdict = "runner-difference";
  }
  return {
    file,
    e2eFailures: failed.get(file)?.tests ?? 0,
    e2eFirst: (failed.get(file)?.messages ?? [])[0] ?? null,
    oldRunner: old.counts,
    baselineRunner: base.counts,
    oldRunnerFailures: old.named,
    verdict,
  };
});

const byVerdict = new Map();
for (const row of rows) {
  byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
}
writeFileSync(
  out,
  `${JSON.stringify(
    {
      generatedBy: "scripts/e2e-vs-bun.mjs",
      report: reportPath.replace(`${root}/`, ""),
      baselineTree: baseline,
      liveTree: live,
      counts: Object.fromEntries(byVerdict),
      rows,
    },
    null,
    1,
  )}\n`,
);

console.log(
  `${rows.length} failing file(s) compared against the pre-migration runner`,
);
for (const [verdict, count] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${verdict}`);
}
console.log(`\nrunner-difference — the old runner is green on the same code and suite text:`);
for (const row of rows.filter((r) => r.verdict === "runner-difference").slice(0, 60)) {
  console.log(`  ${row.file}  (${row.e2eFailures})  ${row.e2eFirst ?? ""}`);
}
