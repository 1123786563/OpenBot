/**
 * The test run, with a floor under how much of it must actually execute.
 *
 * A suite file that throws while it is imported contributes no tests, so a green exit code alone
 * cannot tell a passing repository from one whose files simply stopped loading. The e2e report
 * carries both halves: the counts, and the files the collector could not load.
 *
 * This asserts the count as well as the result. A drop is treated as a failure, because a smaller
 * suite with no failure report gives false coverage.
 *
 * The floor is deliberately a floor and not an exact number. Tests are added constantly and a check
 * that has to be edited for every new test is a check people learn to edit without thinking.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MINIMUM_TESTS = 400;
const CONFIG = "e2e.unit.config.ts";
// Sessions run `e2e` concurrently in this checkout and a shared output directory means the last
// writer's report wins; the run and its reader must agree on one place.
const OUTPUT = process.env.E2E_UNIT_OUTPUT ?? ".e2e/unit";
const REPORT = `${OUTPUT}/report.json`;

interface Report {
  run: {
    summary: {
      discovered: number;
      selected: number;
      executed: number;
      passed: number;
      failed: number;
      skipped: number;
    };
    errors?: { file?: string; message?: string }[];
  };
}

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolvePromise) =>
    process.stderr.once("drain", resolvePromise),
  );
}

/*
 * "Every suite runs under e2e" is an accounting claim, so it is checked as one before anything is
 * executed: a file that imports `bun:test` without being on the driven tier aborts collection for
 * the whole run, and a file that imports neither runner silently never runs. Failing here says which
 * file and why, instead of leaving a zero-test run as the symptom.
 */
const coverage = Bun.spawn(["node", "scripts/e2e-coverage-audit.mjs"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await coverage.exited) !== 0) {
  await writeStderr(
    "\nCoverage audit failed: some suite file is not scheduled by e2e. Repair the partition (`node scripts/e2e-batch-drive-bun-test.mjs`) before trusting a run.\n",
  );
  process.exit(1);
}

const proc = Bun.spawn(["./node_modules/.bin/e2e", "run", "--config", CONFIG], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitStatus = await proc.exited;
if (exitStatus !== 0) {
  process.exitCode = exitStatus;
  await writeStderr(`\n\`e2e run --config ${CONFIG}\` exited ${exitStatus}.\n`);
}
/*
 * These report gates used to sit in an `else` on the run's exit status, so the reconciliation between
 * "the audit's bucket" and "what the runner actually collected" ran only on an already-green corpus.
 * CI proved what that costs: the first run that executed the whole corpus (7936 tests, 176 known-red)
 * printed its summary and exited without ever reaching the reconcile. A red suite is exactly when the
 * coverage claim needs checking, so they now run for every exit status while the runner's own status
 * still decides the exit code.
 */
{
  let report: Report | undefined;
  try {
    report = JSON.parse(readFileSync(resolve(REPORT), "utf8")) as Report;
  } catch {
    await writeStderr(
      `\nNo readable ${REPORT} after a run that exited ${exitStatus}. Refusing to report a pass on a run that cannot be counted.\n`,
    );
    // A run that already failed keeps its own status: 1 here would replace the
    // child's detail-worthy code with a generic one.
    if (exitStatus === 0) process.exitCode = 1;
  }

  if (report) {
    /*
     * The coverage audit above is a claim; this closes the loop against what the runner actually
     * collected. A native-bucket file that contributed no test is the two disagreeing — the shape
     * that once left 85 desktop tests "covered" while no entry ran them.
     */
    const reconcile = Bun.spawn(
      ["node", "scripts/e2e-collection-reconcile.mjs", REPORT],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await reconcile.exited) !== 0) {
      await writeStderr(
        "\nCollection reconcile failed: see the files listed above. The audit's bucket and the\n" +
          "runner's report disagree; a green exit code over a file nothing collected is not coverage.\n",
      );
      process.exitCode = 1;
    }

    const summary = report.run.summary;
    const errors = report.run.errors ?? [];

    if (errors.length) {
      await writeStderr(
        `\n${errors.length} suite file(s) could not be collected, so their tests did not run:\n\n` +
          `${errors.map((error) => `  ${error.file ?? "unknown"} — ${error.message ?? "collection error"}`).join("\n")}\n\n` +
          "An exit code of 0 with uncollected files is a suite that got smaller, not a green suite.\n",
      );
      process.exitCode = 1;
    } else if (summary.executed < MINIMUM_TESTS) {
      await writeStderr(
        `\n${summary.executed} tests ran, and at least ${MINIMUM_TESTS} were expected.\n\n` +
          "Nothing failed and nothing was uncollected, so the suite itself shrank. The usual cause is a\n" +
          "glob that stopped matching a directory.\n\n" +
          `If tests were deliberately removed, lower MINIMUM_TESTS in scripts/test-ci.ts and say why.\n`,
      );
      process.exitCode = 1;
    } else if (summary.failed > 0) {
      await writeStderr(
        `\n${summary.failed} of ${summary.executed} tests failed (floor ${MINIMUM_TESTS}).\n`,
      );
      process.exitCode = 1;
    } else {
      const broken = existsSync("tests/config/e2e-known-broken.json")
        ? ((
            JSON.parse(
              readFileSync("tests/config/e2e-known-broken.json", "utf8"),
            ) as { entries?: unknown[] }
          ).entries?.length ?? 0)
        : 0;
      await writeStderr(
        `\n${summary.executed} tests ran (floor ${MINIMUM_TESTS}), all passed, ${summary.skipped} skipped,` +
          ` from ${summary.discovered} discovered.` +
          (broken
            ? `\n\n${broken} suite file(s) are excluded because their own fixture moved\n` +
              "(tests/config/e2e-known-broken.json) — that is a real broken test, not a pass.\n"
            : "") +
          "\n",
      );
    }
  }
}
