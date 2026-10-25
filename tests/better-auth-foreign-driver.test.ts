/*
 * The BA foreign driver's contract, as named counterexamples (T01.10 / #522).
 *
 * `BA_FOREIGN_SUITE=TaskId` may only select the fixed cwd/runner/argv/test target of an entry in
 * tests/config/better-auth-foreign-suites.json. Root e2e owns the schedule and the report; a child
 * verdict only counts when its report (Bun JUnit or `go test -json`) names tests that actually ran,
 * none of them skipped, none failed. Everything here runs against throwaway registries and fixture
 * runners in the OS temp dir, so a failing assertion can never touch the committed config or start a
 * real submodule suite — the fixtures prove startup arguments, report parsing, cancellation cleanup
 * and unknown-target refusal without needing apps/openmuse or bifrost content.
 *
 * The three named cases are the acceptance contract:
 *   unlisted_command_or_missing_target_never_starts_child — expect(spawnCount).toBe(0)
 *   zero_skipped_or_failed_foreign_suite_is_refused        — expect(exitCode).not.toBe(0)
 *   valid_child_result_preserves_actual_test_count         — expect(reportedTests).toBe(actualTests)
 */
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "./support/e2e-compat";
import {
  baForeignGaps,
  readForeignWhitelist,
  runForeignTarget,
  runForeignTask,
  scrubSecrets,
  type ForeignWhitelist,
} from "./support/better-auth-foreign";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/*
 * The fixture runner is a real executable (the Node binary this suite already runs on) that receives
 * exactly the argv the driver built, records what it was started with, and writes one canned report
 * per mode. The mode is selected by the target's basename, so no registry field can smuggle behaviour
 * the driver does not hand over as a fixed argument.
 */
const FIXTURE_RUNNER = `import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const value = (name) => {
  const hit = argv.find((arg) => arg.startsWith(\`--\${name}=\`));
  return hit ? hit.slice(name.length + 3) : "";
};
const target = value("target");
const report = value("report");
const mode = basename(target).replace(/\\.test\\.ts$/, "");

writeFileSync(
  join(process.cwd(), "probe.json"),
  \`\${JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() })}\\n\`,
);

const testcase = (name, body = "") =>
  body
    ? \`    <testcase name="\${name}" file="\${target}">\${body}</testcase>\`
    : \`    <testcase name="\${name}" file="\${target}"/>\`;
const junit = (attrs, cases) =>
  \`<?xml version="1.0" encoding="UTF-8"?>\\n<testsuites name="fixture" \${attrs}>\\n  <testsuite name="\${target}" \${attrs}>\\n\${cases}\\n  </testsuite>\\n</testsuites>\\n\`;

if (mode === "pass-3") {
  writeFileSync(report, junit('tests="3" failures="0" errors="0" skipped="0"', [testcase("case one"), testcase("case two"), testcase("case three")].join("\\n")));
  process.exit(0);
}
if (mode === "zero") {
  writeFileSync(report, junit('tests="0" failures="0" errors="0" skipped="0"', ""));
  process.exit(0);
}
if (mode === "skipped-1") {
  writeFileSync(report, junit('tests="2" failures="0" errors="0" skipped="1"', [testcase("case one"), testcase("case two", "<skipped/>")].join("\\n")));
  process.exit(0);
}
if (mode === "fail-1") {
  writeFileSync(report, junit('tests="2" failures="1" errors="0" skipped="0"', [testcase("case one"), testcase("case red", "<failure>boom</failure>")].join("\\n")));
  process.exit(1);
}
if (mode === "sleep") {
  // Long enough for the driver to abort it, short enough that a driver without cancellation
  // handling fails fast instead of hitting the runner timeout.
  setTimeout(() => process.exit(0), 5000);
} else if (mode.startsWith("go-")) {
  const pkg = "fixture/pkg";
  const verdicts = mode === "go-fail-1"
    ? [["TestOne", "pass"], ["TestRed", "fail"]]
    : [["TestOne", "pass"], ["TestTwo", "pass"], ["TestThree", "pass"]];
  const lines = [];
  for (const [name, action] of verdicts) {
    lines.push(JSON.stringify({ Action: "run", Package: pkg, Test: name }));
    if (action === "fail")
      lines.push(JSON.stringify({ Action: "output", Package: pkg, Test: name, Output: "connect postgres://fixture-user:fixture-secret@db:5432/app failed\\n" }));
    lines.push(JSON.stringify({ Action: action, Package: pkg, Test: name, Elapsed: 0.01 }));
  }
  lines.push(JSON.stringify({ Action: mode === "go-fail-1" ? "fail" : "pass", Package: pkg, Elapsed: 0.1 }));
  process.stdout.write(\`\${lines.join("\\n")}\\n\`);
  process.exit(mode === "go-fail-1" ? 1 : 0);
}
`;

const PASS_3_JUNIT = [
  "<testcase name=\"case one\"",
  "<testcase name=\"case two\"",
  "<testcase name=\"case three\"",
];
const actualTests = PASS_3_JUNIT.length;

interface Fixture {
  directory: string;
  cwd: string;
  target: string;
  whitelist: ForeignWhitelist;
}

/**
 * One throwaway registry around one fixture runner. The runner types are the structural twin of the
 * committed ones — a fixed runner, a fixed cwd, an argv template whose only variables are the target
 * and the report path — so the driver's checks are the same checks the committed whitelist gets.
 */
function makeFixture(
  mode: string,
  { targetExists = true }: { targetExists?: boolean } = {},
): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ba-foreign-driver-"));
  scratch.push(directory);
  const cwd = join(directory, "cwd");
  const runner = join(directory, "runner.mjs");
  mkdirSync(join(cwd, "cases"), { recursive: true });
  writeFileSync(runner, FIXTURE_RUNNER);
  const isGo = mode.startsWith("go-");
  const target = isGo ? `cases/${mode}` : `cases/${mode}.test.ts`;
  if (isGo) mkdirSync(join(cwd, target), { recursive: true });
  else if (targetExists) writeFileSync(join(cwd, target), "// fixture target\n");
  const whitelist: ForeignWhitelist = {
    version: 1,
    generatedBy: "T01.10 driver fixture",
    executedBy: "tests/better-auth-foreign.test.ts",
    runnerTypes: {
      "fixture-bun": {
        runner: process.execPath,
        cwd,
        argv: [
          runner,
          "--target={{target}}",
          "--report={{reportPath}}",
        ],
        report: "bun-junit",
      },
      "fixture-go": {
        runner: process.execPath,
        cwd,
        argv: [runner, "--target={{target}}"],
        report: "go-json",
      },
    },
    tasks: [
      { task: "T99.99", targets: [{ type: isGo ? "fixture-go" : "fixture-bun", target }] },
    ],
  };
  return { directory, cwd, target, whitelist };
}

/**
 * A spawner that never starts anything: it counts the attempt and hands back a child that exits
 * immediately. Refusal paths must leave the count at zero; a driver that runs the registry instead of
 * the whitelist trips it.
 */
function countingSpawn(): { spawn: typeof nodeSpawn; count: () => number } {
  let spawnCount = 0;
  const spawn = (() => {
    spawnCount += 1;
    const child = new EventEmitter() as unknown as ReturnType<typeof nodeSpawn>;
    (child as unknown as { stdout: null; stderr: null }).stdout = null;
    (child as unknown as { stdout: null; stderr: null }).stderr = null;
    (child as unknown as { pid: number }).pid = 4242;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setImmediate(() => child.emit("exit", 1));
    return child;
  }) as typeof nodeSpawn;
  return { spawn, count: () => spawnCount };
}

interface SpawnCall {
  runner: string;
  argv: readonly string[];
  options: { cwd?: string; env?: Record<string, string | undefined>; shell?: unknown };
}

/** A spawner that records the exact call and delegates to the real one. */
function recordingSpawn(): { spawn: typeof nodeSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn = ((runner: string, argv: readonly string[], options: SpawnCall["options"]) => {
    calls.push({ runner, argv: [...argv], options });
    return nodeSpawn(runner, argv as string[], options);
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return predicate();
}

describe("BA foreign driver contract", () => {
  test("unlisted_command_or_missing_target_never_starts_child", async () => {
    const spawns = countingSpawn();
    const fixture = makeFixture("pass-3");
    // A task the registry does not name, a listed task whose target file does not exist, and a
    // registry entry that tries to carry its own command. None may start a child process.
    const absentTarget = makeFixture("pass-3", { targetExists: false });
    const tampered: ForeignWhitelist = {
      ...fixture.whitelist,
      tasks: [
        {
          task: "T99.99",
          targets: [
            {
              type: "fixture-bun",
              target: fixture.target,
              // The whitelist may name a declared type and a target; a command is unrepresentable.
              command: "node --eval 'process.exit(0)'",
            } as never,
          ],
        },
      ],
    };

    const unlisted = await runForeignTask(fixture.whitelist, "T97.97", {
      spawn: spawns.spawn,
    });
    const missingTarget = await runForeignTask(absentTarget.whitelist, "T99.99", {
      spawn: spawns.spawn,
    });
    const commandEntry = await runForeignTask(tampered, "T99.99", {
      spawn: spawns.spawn,
    });

    expect(unlisted.exitCode, unlisted.message).not.toBe(0);
    expect(missingTarget.exitCode, missingTarget.message).not.toBe(0);
    expect(commandEntry.exitCode, commandEntry.message).not.toBe(0);
    // The named acceptance assertion.
    const spawnCount = spawns.count();
    expect(spawnCount).toBe(0);
  });

  test("zero_skipped_or_failed_foreign_suite_is_refused", async () => {
    for (const mode of ["zero", "skipped-1", "fail-1"]) {
      const fixture = makeFixture(mode);
      const result = await runForeignTarget(
        fixture.whitelist,
        "T99.99",
        { type: "fixture-bun", target: fixture.target },
      );
      // The named acceptance assertion, per refused shape.
      const exitCode = result.exitCode;
      expect(
        exitCode,
        `${mode}: ${result.status}: ${result.message}`,
      ).not.toBe(0);
      expect(result.status, result.message).not.toBe("passed");
    }
    // A failing suite names the test it failed, so the verdict is actionable at the root report.
    const red = makeFixture("fail-1");
    const failed = await runForeignTarget(
      red.whitelist,
      "T99.99",
      { type: "fixture-bun", target: red.target },
    );
    expect(failed.message).toContain("case red");
  });

  test("valid_child_result_preserves_actual_test_count", async () => {
    const fixture = makeFixture("pass-3");
    const result = await runForeignTarget(fixture.whitelist, "T99.99", {
      type: "fixture-bun",
      target: fixture.target,
    });
    expect(result.exitCode, result.message).toBe(0);
    // The named acceptance assertion: the count is read from the child's report, not claimed.
    const reportedTests = result.reportedTests;
    expect(reportedTests).toBe(actualTests);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("fixed_runner_argv_and_cwd_are_the_only_thing_spawned", async () => {
    const fixture = makeFixture("pass-3");
    const recording = recordingSpawn();
    const result = await runForeignTarget(
      fixture.whitelist,
      "T99.99",
      { type: "fixture-bun", target: fixture.target },
      { spawn: recording.spawn },
    );
    expect(result.exitCode, result.message).toBe(0);
    expect(recording.calls.length).toBe(1);
    const call = recording.calls[0];
    expect(call.runner).toBe(process.execPath);
    // argv comes from the type template alone: the target and the report path, nothing else.
    expect(call.argv.length).toBe(3);
    expect(call.argv[0]).toBe(join(fixture.directory, "runner.mjs"));
    expect(call.argv[1]).toBe(`--target=${fixture.target}`);
    expect(call.argv[2].startsWith("--report=")).toBe(true);
    expect(call.options.cwd).toBe(fixture.cwd);
    expect(call.options.shell ?? false).toBe(false);
    // The child's environment is the driver's allowlist; no inherited DSN or secret survives.
    const envKeys = Object.keys(call.options.env ?? {}).sort();
    expect(envKeys).toEqual(["HOME", "PATH"]);
    const probe = JSON.parse(readFileSync(join(fixture.cwd, "probe.json"), "utf8"));
    expect(probe.argv).toEqual([`--target=${fixture.target}`, probe.argv[1]]);
    // The child resolves the macOS /var symlink; the fixed cwd is the same directory either way.
    expect(probe.cwd).toBe(realpathSync(fixture.cwd));
  });

  test("go_json_report_names_tests_and_preserves_counts", async () => {
    const ok = makeFixture("go-pass-3");
    const passed = await runForeignTarget(ok.whitelist, "T99.99", {
      type: "fixture-go",
      target: ok.target,
    });
    expect(passed.exitCode, passed.message).toBe(0);
    expect(passed.reportedTests).toBe(3);

    const red = makeFixture("go-fail-1");
    const failed = await runForeignTarget(red.whitelist, "T99.99", {
      type: "fixture-go",
      target: red.target,
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.message).toContain("TestRed");
    // Secrets in child output never reach the message: the DSN credential is redacted.
    expect(failed.message).not.toContain("fixture-secret");
    expect(scrubSecrets("postgres://user:pass@host/db")).not.toContain("user:pass");
  });

  test("cancellation_kills_child_and_removes_report_directory", async () => {
    const fixture = makeFixture("sleep");
    const controller = new AbortController();
    const running = runForeignTarget(
      fixture.whitelist,
      "T99.99",
      { type: "fixture-bun", target: fixture.target },
      { signal: controller.signal },
    );
    expect(
      await waitFor(() => existsSync(join(fixture.cwd, "probe.json")), 10_000),
      "the fixture child never started",
    ).toBe(true);
    const pid = JSON.parse(
      readFileSync(join(fixture.cwd, "probe.json"), "utf8"),
    ).pid;
    controller.abort();
    const result = await running;
    const exitCode = result.exitCode;
    expect(exitCode).not.toBe(0);
    expect(result.status).toBe("cancelled");
    // The report directory is removed even on the cancellation path.
    expect(result.reportDir).toBeTruthy();
    expect(existsSync(result.reportDir as string)).toBe(false);
    // And the child itself is reaped, not orphaned.
    expect(await waitFor(() => !alive(pid), 10_000)).toBe(true);
  });

  test("registry_cannot_carry_a_command", () => {
    const fixture = makeFixture("pass-3");
    const clean = baForeignGaps(fixture.whitelist);
    expect(clean, clean.join("\n")).toEqual([]);

    const smuggled = {
      ...fixture.whitelist,
      tasks: [{ task: "T99.99", targets: [{ type: "fixture-bun", target: fixture.target, shell: "rm -rf /" }] }],
    };
    const undeclared = {
      ...fixture.whitelist,
      tasks: [{ task: "T99.99", targets: [{ type: "fixture-unknown", target: fixture.target }] }],
    };
    const escaping = {
      ...fixture.whitelist,
      tasks: [{ task: "T99.99", targets: [{ type: "fixture-bun", target: "../../etc/passwd" }] }],
    };
    for (const registry of [smuggled, undeclared, escaping]) {
      const gaps = baForeignGaps(registry);
      expect(gaps.length, JSON.stringify(registry.tasks)).toBeGreaterThan(0);
    }
  });

  test("committed_whitelist_satisfies_the_structure_the_driver_requires", () => {
    const committed = readForeignWhitelist(
      resolve(import.meta.dirname, "config/better-auth-foreign-suites.json"),
    );
    const gaps = baForeignGaps(committed);
    expect(gaps, gaps.join("\n")).toEqual([]);
    // The pinned two-type fixity is the audit's check; here the driver only needs the structure.
    expect(Object.keys(committed.runnerTypes ?? {})).toContain("openmuse-bun");
    expect(Object.keys(committed.runnerTypes ?? {})).toContain("bifrost-go-governance");
  });
});
