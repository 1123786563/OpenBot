/*
 * The BA foreign driver (T01.10 / #522): root e2e schedules and reports the suites that live in the
 * submodules, on a fixed whitelist contract.
 *
 * BA_FOREIGN_SUITE=TaskId selects a task's targets from tests/config/better-auth-foreign-suites.json.
 * An entry may name only a declared runner type and a target path; the type alone fixes the runner,
 * the cwd and the argv template, so no registry field can carry a command. The driver refuses —
 * without starting a child — any task the registry does not name, any target that does not exist on
 * disk, and any registry that breaks the structural contract. A child verdict counts only when its
 * own report says so (Bun JUnit or `go test -json`): more than zero tests, none skipped, none
 * failed, with the child's non-zero exit preserved as-is. Credentials in child output are redacted
 * before they reach any message.
 *
 * tests/better-auth-foreign-driver.test.ts drives this module against throwaway registries and
 * fixture runners; tests/better-auth-foreign.test.ts is the root scheduler over the committed
 * registry. scripts/e2e-coverage-audit.mjs separately pins the two committed runner types.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface ForeignRunnerType {
  runner: string;
  cwd: string;
  argv: string[];
  report: "bun-junit" | "go-json";
}

export interface ForeignTarget {
  type: string;
  target: string;
}

export interface ForeignTask {
  task: string;
  targets: ForeignTarget[];
}

export interface ForeignWhitelist {
  version?: unknown;
  generatedBy?: unknown;
  executedBy?: unknown;
  purpose?: unknown;
  runnerTypes?: Record<string, ForeignRunnerType>;
  tasks: ForeignTask[];
}

export type ForeignRunStatus =
  | "passed"
  | "failed"
  | "refused"
  | "blocked"
  | "cancelled";

export interface ForeignRunResult {
  task: string;
  type: string;
  target: string;
  status: ForeignRunStatus;
  /** 0 only for a passed verdict; refusals, blocks, failures and cancellations are non-zero. */
  exitCode: number;
  reportedTests: number;
  skipped: number;
  failed: number;
  message: string;
  /**
   * The report directory the run used. It is removed before the result returns; the path stays on
   * the result so a caller (the contract tests) can assert the cleanup actually happened.
   */
  reportDir?: string;
  childPid?: number;
}

export interface ForeignRunOptions {
  spawn?: typeof nodeSpawn;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  timeoutMs?: number;
}

const TASK_ID = /^T\d+\.\d+$/;
const ALLOWED_KEYS = new Set([
  "version",
  "generatedBy",
  "executedBy",
  "purpose",
  "runnerTypes",
  "tasks",
]);
const ALLOWED_TYPE_KEYS = new Set(["runner", "cwd", "argv", "report"]);
const PLACEHOLDERS = new Set(["{{target}}", "{{reportPath}}"]);
const REPORT_KINDS = new Set(["bun-junit", "go-json"]);
// No shell syntax may appear in any registry value: the driver hands argv to spawn verbatim, and the
// gate keeps the file itself from ever being a place a command could be typed.
const SHELLISH = /[;&|`$<>()\\\n\r]/;

/**
 * The structural half of the whitelist contract, as checkable gaps. This is what the driver demands
 * of any registry it is handed (the committed one and the contract tests' fixtures alike); the audit
 * additionally pins the committed file's two runner types. An empty result means the registry can be
 * scheduled from; anything else is refused before a child is ever started.
 */
export function baForeignGaps(registry: unknown): string[] {
  const gaps: string[] = [];
  if (!registry || typeof registry !== "object")
    return ["the whitelist is not a JSON object"];
  const record = registry as Record<string, unknown>;
  if (record.version !== 1)
    gaps.push(`version must be 1 (found ${JSON.stringify(record.version)})`);
  for (const key of Object.keys(record))
    if (!ALLOWED_KEYS.has(key))
      gaps.push(
        `unknown key "${key}": the whitelist may carry only ${[...ALLOWED_KEYS].join(", ")}`,
      );
  const types = record.runnerTypes;
  const declared = new Set<string>(
    types && typeof types === "object" && !Array.isArray(types)
      ? Object.keys(types)
      : [],
  );
  if (!declared.size) gaps.push("runnerTypes declares no runner type");
  else
    for (const [id, value] of Object.entries(
      types as Record<string, unknown>,
    )) {
      const type = (value ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(type))
        if (!ALLOWED_TYPE_KEYS.has(key))
          gaps.push(
            `runner type "${id}" carries "${key}": only runner, cwd, argv, report`,
          );
      if (
        typeof type.runner !== "string" ||
        !type.runner ||
        SHELLISH.test(type.runner)
      )
        gaps.push(`runner type "${id}" names no plain runner`);
      if (typeof type.cwd !== "string" || !type.cwd)
        gaps.push(`runner type "${id}" names no cwd`);
      if (!REPORT_KINDS.has(type.report as string))
        gaps.push(
          `runner type "${id}" report must be one of ${[...REPORT_KINDS].join(", ")}`,
        );
      const argv = type.argv;
      if (
        !Array.isArray(argv) ||
        !argv.length ||
        argv.some((argument) => typeof argument !== "string" || !argument)
      ) {
        gaps.push(`runner type "${id}" argv is not a non-empty string array`);
      } else {
        const placeholders = (argv as string[]).flatMap(
          (argument) => argument.match(/\{\{[^}]*\}\}/g) ?? [],
        );
        for (const hit of placeholders)
          if (!PLACEHOLDERS.has(hit))
            gaps.push(
              `runner type "${id}" argv uses unknown placeholder ${hit}`,
            );
        if (placeholders.filter((hit) => hit === "{{target}}").length !== 1)
          gaps.push(
            `runner type "${id}" argv must name {{target}} exactly once`,
          );
        // A junit-reporting runner needs a file to write; a stream reporter must not be given one.
        const wantsFile = type.report === "bun-junit";
        if (wantsFile !== placeholders.includes("{{reportPath}}"))
          gaps.push(
            `runner type "${id}" report "${type.report}" and its {{reportPath}} placeholder disagree`,
          );
        for (const argument of argv as string[])
          if (SHELLISH.test(argument))
            gaps.push(
              `runner type "${id}" argv contains shell syntax: ${JSON.stringify(argument)}`,
            );
      }
    }
  const tasks = record.tasks;
  if (!Array.isArray(tasks)) {
    gaps.push("tasks must be an array");
  } else {
    const seenTasks = new Set<string>();
    const seenTargets = new Set<string>();
    for (const value of tasks) {
      const entry = (value ?? {}) as Record<string, unknown>;
      const task = String(entry.task ?? "");
      if (!TASK_ID.test(task))
        gaps.push(`task "${task}" is not a TaskId of the form Txx.nn`);
      if (seenTasks.has(task))
        gaps.push(`task ${task} is listed more than once`);
      seenTasks.add(task);
      for (const key of Object.keys(entry))
        if (key !== "task" && key !== "targets")
          gaps.push(
            `task ${task} carries "${key}": an entry may name only its targets — the registry is not a command list`,
          );
      const targets = entry.targets;
      if (!Array.isArray(targets) || !targets.length) {
        gaps.push(`task ${task} registers no target`);
        continue;
      }
      for (const item of targets) {
        const target = (item ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(target))
          if (key !== "type" && key !== "target")
            gaps.push(
              `task ${task} target carries "${key}": only a declared runner type and a target path`,
            );
        const type = String(target.type ?? "");
        if (!declared.has(type))
          gaps.push(`task ${task} uses undeclared runner type "${type}"`);
        const path = String(target.target ?? "");
        if (
          !path ||
          isAbsolute(path) ||
          path.split("/").includes("..") ||
          path.startsWith("-") ||
          SHELLISH.test(path)
        )
          gaps.push(
            `task ${task} target "${path}" is not a safe relative path`,
          );
        const key = `${type}\t${path}`;
        if (seenTargets.has(key))
          gaps.push(`${type} target "${path}" is registered twice`);
        seenTargets.add(key);
      }
    }
  }
  return gaps;
}

export function readForeignWhitelist(path: string): ForeignWhitelist {
  return JSON.parse(readFileSync(path, "utf8")) as ForeignWhitelist;
}

/** DSN credentials and *_DATABASE_URL assignments never survive into a message. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/:\/\/[^@\s/]+@/g, "://***@")
    .replace(/\b((?:BA_)?(?:TEST_)?[A-Z_]*DATABASE_URL)=\S+/g, "$1=***");
}

export interface ReportCounts {
  tests: number;
  failures: number;
  skipped: number;
  failed: string[];
}

/** Bun's junit: the outer totals plus the failing tests, named with their file. */
export function parseBunJunit(xml: string): ReportCounts {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? "";
  const attribute = (name: string): number => {
    const match = new RegExp(`\\b${name}="(\\d+)"`).exec(root);
    return match ? Number(match[1]) : 0;
  };
  const failed: string[] = [];
  let skippedCases = 0;
  // `\b` + lazy, like tests/bun-suites.test.ts (#407): a greedy match backtracks into classname=""
  // and captures the empty string as the test name. Self-closing cases (`<testcase ... />`) are
  // matched with an empty body — otherwise their lazy body would swallow the next paired case,
  // which is how a passing case ends up carrying a sibling's failure.
  for (const match of xml.matchAll(
    /<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const body = match[1] === "/>" ? "" : (match[2] ?? "");
    if (/<skipped\b/.test(body)) skippedCases += 1;
    if (!/<(?:failure|error)\b/.test(body)) continue;
    const name = /\bname="([^"]*)"/.exec(match[0])?.[1] ?? "";
    const file = /\bfile="([^"]*)"/.exec(match[0])?.[1] ?? "";
    failed.push(`${file ? `${file}: ` : ""}${name}`);
  }
  const hasRootCounts = /tests="/.test(root);
  return {
    tests: hasRootCounts
      ? attribute("tests")
      : [...xml.matchAll(/<testcase\b/g)].length,
    failures: attribute("failures") + attribute("errors"),
    skipped: hasRootCounts ? attribute("skipped") : skippedCases,
    failed,
  };
}

/** `go test -json`: one verdict per Package+Test, the last event for a test being its verdict. */
export function parseGoJson(stdout: string): ReportCounts {
  const verdicts = new Map<string, "pass" | "fail" | "skip">();
  for (const line of stdout.split("\n")) {
    if (!line.trimStart().startsWith("{")) continue;
    let event: { Action?: unknown; Package?: unknown; Test?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // test2json also emits the raw build errors as plain lines
    }
    const action = event.Action;
    if (
      typeof event.Test !== "string" ||
      (action !== "pass" && action !== "fail" && action !== "skip")
    )
      continue;
    verdicts.set(
      `${typeof event.Package === "string" ? event.Package : ""}\t${event.Test}`,
      action,
    );
  }
  const failed: string[] = [];
  let failures = 0;
  let skipped = 0;
  for (const [key, action] of verdicts) {
    if (action === "fail") {
      failures += 1;
      const [pkg, name] = key.split("\t");
      failed.push(pkg ? `${pkg}.${name}` : name);
    } else if (action === "skip") skipped += 1;
  }
  return { tests: verdicts.size, failures, skipped, failed };
}

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((done) => {
    if (!stream) return done("");
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

/*
 * The child's environment is an allowlist, not an inheritance: a foreign suite sees PATH and HOME
 * plus whatever the caller explicitly hands over. The five BA_TEST_* role URLs a better-auth island
 * needs are the caller's decision (see scripts/lib/e2e-manifest.mjs), and no job-level secret rides
 * along unasked.
 */
function childEnv(extra?: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

function verdict(
  taskId: string,
  target: ForeignTarget,
  status: ForeignRunStatus,
  message: string,
): ForeignRunResult {
  return {
    task: taskId,
    type: target.type,
    target: target.target,
    status,
    exitCode: 1,
    reportedTests: 0,
    skipped: 0,
    failed: 0,
    message: scrubSecrets(message),
  };
}

export async function runForeignTarget(
  whitelist: ForeignWhitelist,
  taskId: string,
  target: ForeignTarget,
  options: ForeignRunOptions = {},
): Promise<ForeignRunResult> {
  const gaps = baForeignGaps(whitelist);
  if (gaps.length)
    return verdict(
      taskId,
      target,
      "refused",
      `the whitelist breaks the fixed contract, so no child was started: ${gaps.slice(0, 5).join("; ")}`,
    );
  const type = whitelist.runnerTypes?.[target.type];
  if (!type)
    return verdict(
      taskId,
      target,
      "refused",
      `runner type "${target.type}" is not declared in the whitelist (declared: ${Object.keys(whitelist.runnerTypes ?? {}).join(", ") || "none"}), so no child was started`,
    );
  const repoRoot = options.repoRoot ?? process.cwd();
  const cwd = isAbsolute(type.cwd) ? type.cwd : resolve(repoRoot, type.cwd);
  const absoluteTarget = resolve(cwd, target.target);
  if (absoluteTarget !== cwd && !absoluteTarget.startsWith(cwd + sep))
    return verdict(
      taskId,
      target,
      "refused",
      `target "${target.target}" escapes the fixed cwd ${type.cwd}, so no child was started`,
    );
  if (!existsSync(absoluteTarget))
    return verdict(
      taskId,
      target,
      "blocked",
      `target "${target.target}" does not exist under ${type.cwd} — the submodule checkout is absent here or the file is not there; no child was started`,
    );
  if (options.signal?.aborted)
    return verdict(
      taskId,
      target,
      "cancelled",
      "the run was aborted before the child started; nothing was scheduled",
    );

  const spawn = options.spawn ?? nodeSpawn;
  const reportDir = mkdtempSync(join(tmpdir(), "ba-foreign-"));
  const reportPath = `${reportDir}/junit.xml`;
  const argv = type.argv.map((argument) =>
    argument
      .split("{{target}}")
      .join(target.target)
      .split("{{reportPath}}")
      .join(reportPath),
  );
  const child = spawn(type.runner, argv, {
    cwd,
    env: childEnv(options.env) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutMs ?? 600_000;
  let cancelledBy: "signal" | "timeout" | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: "signal" | "timeout") => {
    if (cancelledBy) return;
    cancelledBy = why;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  const onAbort = () => stop("signal");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let counts: ReportCounts | null = null;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((done) => {
        child.on("exit", (code) => done(code));
        child.on("error", () => done(1));
      }),
    ]);
    // Parse while the report file still exists; the finally below removes the directory.
    counts =
      type.report === "bun-junit"
        ? existsSync(reportPath)
          ? parseBunJunit(readFileSync(reportPath, "utf8"))
          : null
        : parseGoJson(stdout);
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
    rmSync(reportDir, { recursive: true, force: true });
  }
  const tail = scrubSecrets(
    `${stderr}${stdout}`.replace(/\s+/g, " ").slice(-600),
  );
  if (cancelledBy)
    return {
      task: taskId,
      type: target.type,
      target: target.target,
      status: "cancelled",
      exitCode: 1,
      reportedTests: 0,
      skipped: 0,
      failed: 0,
      message: scrubSecrets(
        `${target.target}: ${cancelledBy === "timeout" ? `no verdict within ${timeoutMs}ms` : "cancelled while running"} — the child was stopped (exit ${exitCode ?? "signal"}) and the report directory was removed`,
      ),
      reportDir,
      childPid: child.pid,
    };
  if (!counts)
    return {
      ...verdict(
        taskId,
        target,
        "failed",
        `${target.target}: the child (exit ${exitCode}) wrote no junit report${tail ? `: ${tail}` : ""}`,
      ),
      reportDir,
      childPid: child.pid,
    };
  const problems: string[] = [];
  if (counts.tests === 0)
    problems.push(
      "the report names no test — a suite that ran nothing is not a pass",
    );
  if (counts.skipped > 0)
    problems.push(
      `${counts.skipped} test(s) skipped — a foreign suite may not skip`,
    );
  if (counts.failures > 0)
    problems.push(
      `${counts.failures} test(s) failed: ${counts.failed.slice(0, 5).join(" | ")}`,
    );
  if (exitCode !== 0)
    problems.push(`child exited ${exitCode}${tail ? `: ${tail}` : ""}`);
  return {
    task: taskId,
    type: target.type,
    target: target.target,
    status: problems.length ? "failed" : "passed",
    exitCode: problems.length ? 1 : 0,
    reportedTests: counts.tests,
    skipped: counts.skipped,
    failed: counts.failures,
    message: scrubSecrets(
      problems.length
        ? `${target.target}: ${problems.join("; ")}`
        : `${target.target}: ${counts.tests} test(s) passed`,
    ),
    reportDir,
    childPid: child.pid,
  };
}

export async function runForeignTask(
  whitelist: ForeignWhitelist,
  taskId: string,
  options: ForeignRunOptions = {},
): Promise<{
  exitCode: number;
  results: ForeignRunResult[];
  message: string;
}> {
  const gaps = baForeignGaps(whitelist);
  if (gaps.length)
    return {
      exitCode: 1,
      results: [],
      message: scrubSecrets(
        `the whitelist breaks the fixed contract, so nothing was started: ${gaps.slice(0, 5).join("; ")}`,
      ),
    };
  const wanted = String(taskId ?? "").trim();
  const entry = whitelist.tasks.find((candidate) => candidate.task === wanted);
  if (!entry)
    return {
      exitCode: 1,
      results: [],
      message: `BA_FOREIGN_SUITE=${wanted || "(empty)"} names no task in the whitelist (registered: ${whitelist.tasks.map((task) => task.task).join(", ") || "none"}); a task registers the targets it already owns — registration is not execution`,
    };
  const results: ForeignRunResult[] = [];
  for (const target of entry.targets)
    results.push(await runForeignTarget(whitelist, wanted, target, options));
  const red = results.filter((result) => result.exitCode !== 0);
  return {
    exitCode: red.length ? 1 : 0,
    results,
    message: results
      .map((result) => `${result.status} ${result.target}: ${result.message}`)
      .join("\n"),
  };
}
