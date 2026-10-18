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
const REPORT = ".e2e/unit/report.json";

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

const proc = Bun.spawn(["./node_modules/.bin/e2e", "run", "--config", CONFIG], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitStatus = await proc.exited;
if (exitStatus !== 0) {
  process.exitCode = exitStatus;
  await writeStderr(`\n\`e2e run --config ${CONFIG}\` exited ${exitStatus}.\n`);
} else {
  let report: Report | undefined;
  try {
    report = JSON.parse(readFileSync(resolve(REPORT), "utf8")) as Report;
  } catch {
    await writeStderr(
      `\nNo readable ${REPORT} after a run that exited 0. Refusing to report a pass on a run that cannot be counted.\n`,
    );
    process.exitCode = 1;
  }

  if (report) {
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
      const broken = existsSync("docs/verification/e2e-known-broken.json")
        ? ((
            JSON.parse(
              readFileSync("docs/verification/e2e-known-broken.json", "utf8"),
            ) as { entries?: unknown[] }
          ).entries?.length ?? 0)
        : 0;
      await writeStderr(
        `\n${summary.executed} tests ran (floor ${MINIMUM_TESTS}), all passed, ${summary.skipped} skipped,` +
          ` from ${summary.discovered} discovered.` +
          (broken
            ? `\n\n${broken} suite file(s) are excluded because their own fixture moved\n` +
              "(docs/verification/e2e-known-broken.json) — that is a real broken test, not a pass.\n"
            : "") +
          "\n",
      );
    }
  }
}
