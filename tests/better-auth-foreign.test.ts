/*
 * The root scheduler for the foreign (submodule) suites (T01.10 / #522).
 *
 * Root e2e owns the schedule and the report. With BA_FOREIGN_SUITE=<TaskId> this file drives that
 * task's whitelisted targets through tests/support/better-auth-foreign.ts and turns each child
 * verdict into a root result: the child's own counts carried in, zero tests, skips, failures,
 * missing targets and unknown tasks red — never skipped. Without the variable nothing foreign runs;
 * the committed whitelist still gets its structural contract checked on every corpus run, so a
 * registry drift is a red test rather than a quiet schedule change.
 *
 * Registration is not execution: a target appears here only after the task that owns it registered
 * it in tests/config/better-auth-foreign-suites.json, and an entry whose file does not exist in this
 * checkout blocks (explicitly, non-zero) rather than passing or silently skipping.
 */
import { join } from "node:path";
import {
  baForeignGaps,
  readForeignWhitelist,
  runForeignTarget,
} from "./support/better-auth-foreign";
import { expect, test } from "./support/e2e-compat";

const whitelistPath = join(
  import.meta.dirname,
  "config/better-auth-foreign-suites.json",
);
const whitelist = readForeignWhitelist(whitelistPath);
const wanted = (process.env.BA_FOREIGN_SUITE ?? "").trim();

if (!wanted) {
  test("foreign whitelist registry satisfies the fixed contract", () => {
    const gaps = baForeignGaps(whitelist);
    expect(
      gaps.join("\n") || "no gaps",
      "tests/config/better-auth-foreign-suites.json breaks the contract the driver schedules from; fix the registry, do not loosen this check",
    ).toBe("no gaps");
  });
} else {
  const entry = whitelist.tasks.find((task) => task.task === wanted);
  if (!entry) {
    // A miss must fail, not skip: an empty run would read as "nothing asked for" in a green suite.
    test(`BA foreign task ${wanted} exists`, () => {
      expect(
        whitelist.tasks.some((task) => task.task === wanted),
        `BA_FOREIGN_SUITE=${wanted} names no task in tests/config/better-auth-foreign-suites.json (registered: ${whitelist.tasks.map((task) => task.task).join(", ") || "none"}). A task registers its own existing targets; registration is not execution.`,
      ).toBe(true);
    });
  } else if (!entry.targets.length) {
    test(`BA foreign task ${wanted} schedules a target`, () => {
      expect(entry.targets.length).toBeGreaterThan(0);
    });
  } else {
    for (const target of entry.targets) {
      test(`BA foreign suite ${wanted} ${target.type} ${target.target}`, {
        timeout: 900_000,
      }, async () => {
        const result = await runForeignTarget(whitelist, wanted, target);
        expect(result.exitCode, result.message).toBe(0);
        expect(result.reportedTests, result.message).toBeGreaterThan(0);
        expect(result.skipped, result.message).toBe(0);
      });
    }
  }
}
