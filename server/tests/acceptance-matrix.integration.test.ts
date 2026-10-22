import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  ACCEPTANCE_MATRIX,
  CROSS_PROCESS_SCENARIOS,
  MATRIX_ACS,
  countsAsPassed,
} from "../src/billing/acceptance-matrix";

/*
 * Ticket 22.5 (#356) — the AC acceptance matrix's own check, plus the executability it
 * stands on.
 *
 *   AC-1  AC01–AC19 每条都有绑定代码版本的可复现结果 — every row exists exactly once
 *         with a scenario, a runnable command and a delivered suite; the batch report
 *         binds each executed command's receipt to the worktree HEAD it ran on;
 *   AC-2  跨进程故障场景全部执行并记录结果 — the five scenario tags are each claimed
 *         by rows whose suites drive them (the report carries their bound receipts);
 *   AC-3  skip 或因环境缺失未执行的项不计为通过 — the accounting rule is code: a run
 *         with skips or failures never counts as passed, demonstrated here on a real
 *         executed suite AND on the synthetic skip world;
 *   AC-4  未通过项有明确阻塞原因 — the executor reports reasons through the same rule,
 *         and this file pins that a suite that cannot even run is a named failure, not
 *         an absence.
 */

const repoRoot = join(import.meta.dirname, "../..");

describe("Bifrost 22.5 (#356): the AC acceptance matrix", () => {
  test("the matrix carries exactly the Spec's nineteen ACs, each once, each executable", () => {
    expect(ACCEPTANCE_MATRIX.map((row) => row.ac)).toEqual([...MATRIX_ACS]);
    for (const row of ACCEPTANCE_MATRIX) {
      expect(row.requirement.length, row.ac).toBeGreaterThan(20);
      expect(row.scenario.length, row.ac).toBeGreaterThan(20);
      expect(row.commands.length, row.ac).toBeGreaterThan(0);
      expect(row.suites.length, row.ac).toBeGreaterThan(0);
      // Every command runs a suite that exists, against the dedicated test database
      // where the suite needs one.
      for (const command of row.commands) {
        const match = command.match(/(server\/tests\/[A-Za-z0-9_./-]+\.test\.ts[ex]*)/);
        expect(match, `${row.ac}: ${command}`).not.toBeNull();
        if (match) expect(existsSync(join(repoRoot, match[1])), match[1]).toBe(true);
        if (/integration\.test\.ts$/.test(match?.[1] ?? "")) {
          expect(command.startsWith("TEST_DATABASE_URL=<test-db> "), `${row.ac}: ${command}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("every cross-process fault scenario is claimed by at least one row", () => {
    const claimed = new Set(
      ACCEPTANCE_MATRIX.flatMap((row) => row.crossProcess ?? []),
    );
    for (const scenario of CROSS_PROCESS_SCENARIOS) {
      expect(claimed.has(scenario), scenario).toBe(true);
    }
    // And the concrete claims: restart/replay on the recovery rows, concurrency on the
    // reserve row, clock on the expiry rows, disconnect on the realtime recovery world.
    const restartRows = ACCEPTANCE_MATRIX.filter((row) => row.crossProcess?.includes("restart"));
    expect(restartRows.map((row) => row.ac)).toContain("AC07");
    expect(restartRows.map((row) => row.ac)).toContain("AC17");
    expect(
      ACCEPTANCE_MATRIX.filter((row) =>
        row.crossProcess?.includes("concurrent-workers"),
      ).map((row) => row.ac),
    ).toContain("AC04");
    // The disconnect scenario lives on the realtime recovery world (15.8's own suites).
    expect(
      ACCEPTANCE_MATRIX.find((row) => row.ac === "AC16")?.suites.join(" "),
    ).toContain("realtime");
  });

  test("skip 不计为通过 — the accounting rule refuses to fold skips and failures into passes", () => {
    expect(countsAsPassed({ passed: 5, failed: 0, skipped: 0 })).toEqual({ passed: true });
    expect(countsAsPassed({ passed: 5, failed: 0, skipped: 2 })).toEqual({
      passed: false,
      reason: "2 skipped — skip 不计为通过",
    });
    expect(countsAsPassed({ passed: 5, failed: 1, skipped: 0 })).toEqual({
      passed: false,
      reason: "1 failed",
    });
  });

  test("a matrix suite actually executes green here — the executability is real, not declared", () => {
    // 14.3's evidence suite is pure and fast; run it for real through the same runner
    // the receipts use, and fold the counts through the matrix's own rule. Bun's test
    // reporter writes to stderr, so both streams are folded into the parsed output.
    const run = spawnSync(
      "bun",
      ["test", "server/tests/audio-capability-evidence.test.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    expect(run.status).toBe(0);
    const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? 0);
    const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? 0);
    const skipped = /(\d+) skip/.exec(output)?.[1] ?? "0";
    expect(passed).toBeGreaterThan(0);
    expect(countsAsPassed({ passed, failed, skipped: Number(skipped) })).toEqual({
      passed: true,
    });
  });

  test("a suite that cannot run is a named failure — absence is not a pass", () => {
    // The zero-case world (a suite that collected nothing, an executor that ran nothing)
    // does NOT count as passed: the rule names it, so an empty run can never be folded
    // into a matrix pass.
    expect(countsAsPassed({ passed: 0, failed: 0, skipped: 0 })).toEqual({
      passed: false,
      reason: "0 cases executed — absence is not a pass",
    });
    // And the executability check keeps that world from arising silently: every suite
    // path the matrix names exists on disk (pinned above), so a vanished suite fails
    // before any executor could report an empty green.
    expect(existsSync(join(repoRoot, "server/tests/audio-capability-evidence.test.ts"))).toBe(true);
  });
});
