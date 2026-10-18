import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./support/e2e-compat";

/*
 * Suites that stay on the Bun runtime, driven and reported by e2e.
 *
 * The runner only executes on Node, while the server's data layer is Bun's own SQL client
 * (`server/src/db/client.ts` imports `{ SQL } from "./support/bun-compat"` and `drizzle-orm/bun-sql`) and its HTTP
 * layer is `serve` from "./support/bun-compat". Those suites test through that layer, so their process has to be
 * Bun's; the decision recorded in ADR 0008 is that e2e still owns the entry point, the schedule and
 * the report. Each group below is one result row in the run, with Bun's own counts and failure text
 * carried into the assertion message.
 *
 * The groups come from `docs/verification/e2e-bun-suites.json`, which `scripts/e2e-bun-manifest.mjs`
 * writes from the per-file collection audit; the unit config excludes exactly those files, so a
 * suite is either collected natively or driven here, never both and never neither.
 */

interface Group {
  name: string;
  files: string[];
  env?: Record<string, string>;
}

function read(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((done) => {
    if (!stream) return done("");
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

const manifestPath = join(
  import.meta.dirname,
  "../docs/verification/e2e-bun-suites.json",
);
const all: Group[] = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { groups: Group[] })
      .groups
  : [];
// E2E_BUN_ONLY=agent-computer runs one group: enough to prove the driver without spending an hour
// on the server groups, which need the shared Postgres.
const only = (process.env.E2E_BUN_ONLY ?? "").trim();
const groups = only ? all.filter((group) => group.name.includes(only)) : all;

if (only && !groups.length) {
  test(`bun runtime group ${only} exists`, () => {
    test.skip(
      true,
      `no driven group names "${only}" (${all.length} groups in the manifest)`,
    );
  });
} else if (!groups.length) {
  // An absent manifest would otherwise read as "nothing to run on Bun" and shrink the suite.
  test("bun runtime manifest exists", () => {
    expect(
      existsSync(manifestPath),
      "docs/verification/e2e-bun-suites.json is missing; run `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`",
    ).toBe(true);
  });
}

/** Bun's junit reporter is line oriented; the outer totals, the failure texts and the files are used. */
function readJunit(xml: string): {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failed: string[];
  failingFiles: string[];
} {
  const attribute = (name: string): number => {
    const match = xml.match(new RegExp(`\\b${name}="(\\d+)"`));
    return match ? Number(match[1]) : 0;
  };
  const failed: string[] = [];
  const failingFiles = new Set<string>();
  for (const match of xml.matchAll(
    /<testcase[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g,
  )) {
    const body = match[2] ?? "";
    if (!/<(failure|error)\b/.test(body)) continue;
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const file = tag.match(/\bfile="([^"]*)"/)?.[1];
    if (file) failingFiles.add(file);
    const detail = body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    failed.push(`${match[1]}: ${detail}`);
  }
  return {
    tests: attribute("tests"),
    failures: attribute("failures"),
    errors: attribute("errors"),
    skipped: attribute("skipped"),
    failed,
    failingFiles: [...failingFiles],
  };
}

/** One `bun test` invocation, with its junit parsed. The driver needs it twice: grouped and alone. */
async function runBun(
  files: string[],
): Promise<
  ReturnType<typeof readJunit> & { exitCode: number; stderr: string }
> {
  const directory = mkdtempSync(join(tmpdir(), "openbot-bun-suite-"));
  const report = join(directory, "junit.xml");
  try {
    /*
     * node:child_process on purpose: e2e-compat installs a Node port of `Bun.spawn` on
     * globalThis.Bun for the suites, and this driver has to start the real bun binary instead.
     */
    const child = spawn(
      "bun",
      [
        "test",
        ...files,
        // Bun takes `--reporter=<val>`; the separated form is rejected as an empty format.
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        "--timeout=120000",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    /*
     * `--timeout` bounds one test, not a group: 24 files each reaching for a 120 s deadline can
     * outrun this e2e test's own timeout, and a child still running when the parent gives up keeps
     * the report from being the last word. Kill it inside the budget and say so.
     */
    let timedOut = false;
    const killAfter = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 840_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      new Promise<number>((done) => {
        child.on("exit", (code) => done(code ?? 1));
        child.on("error", () => done(1));
      }),
    ]).finally(() => clearTimeout(killAfter));
    if (timedOut) {
      throw new Error(
        `${files.length} file(s) gave no verdict within 840s; killed so the run can finish. Last output:\n${stderr.slice(-600)}${stdout.slice(-600)}`,
      );
    }
    if (!existsSync(report)) {
      // A mis-spawn must not read as a mysterious ENOENT: bun's own words are the diagnosis.
      throw new Error(
        `bun wrote no junit report for ${files[0]}:\n${(stderr || stdout).slice(-800)}`,
      );
    }
    return { ...readJunit(readFileSync(report, "utf8")), exitCode, stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/*
 * One TCP probe against the database the suites are pointed at. Returns a description of why it is
 * unreachable, or null when something answers. The credential in the URL is never echoed.
 */
async function databaseUnreachable(): Promise<string | null> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return "no TEST_DATABASE_URL/DATABASE_URL in the environment";
  const target = /\/\/[^@/]*@?([^:/?]+):(\d{2,5})\//.exec(url);
  if (!target) return `${url.replace(/:[^:@/]*@/, ":***@")} names no host:port`;
  const answered = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: target[1], port: Number(target[2]) });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  return answered ? null : `${target[1]}:${target[2]} answered nothing`;
}

for (const group of groups) {
  test(`bun runtime suite ${group.name}`, {
    tags: ["bun-runtime"],
    timeout: 900_000,
  }, async () => {
    const started = await runBun(group.files.map((f) => `./${f}`));
    // A group that ran nothing is not a pass: an unusable path or a crashed loader reports zero.
    expect(
      started.tests,
      `bun ran no tests for ${group.name}: ${started.stderr.slice(-400)}`,
    ).toBeGreaterThan(0);
    if (started.failures + started.errors === 0) return;

    /*
     * "Blocked, not judged" is a claim about the environment, so it needs environment evidence.
     * Failure text alone cannot carry it: drizzle prefixes *every* statement error with
     * `Failed query:` (a rejected insert under RLS is a product verdict) and truncates the
     * connection cause off the end, so a real outage and a real bug look identical here. The label
     * is therefore made only on a connect-level signature or on a direct probe that nothing is
     * listening where TEST_DATABASE_URL/DATABASE_URL points, and it quotes the evidence it used.
     */
    const refusals = started.failed.filter((text) =>
      /ECONNREFUSED|EADDRNOTAVAIL|Failed to connect|could not connect|getaddrinfo/i.test(
        text,
      ),
    );
    const statementFailures = started.failed.filter((text) =>
      /Failed query|PostgresError/i.test(text),
    );
    const unreachable = await databaseUnreachable();
    const half = started.failed.length / 2;
    const evidence =
      refusals.length > half
        ? `${refusals.length}/${started.failed.length} failures quote a connect-level refusal (first: ${(refusals[0] ?? "").replace(/\s+/g, " ").slice(0, 120)})`
        : unreachable && statementFailures.length > half
          ? `${statementFailures.length}/${started.failed.length} failures are statement errors and the configured database is unreachable (${unreachable})`
          : null;
    const refusalNote = evidence
      ? `\n  ${evidence}: this group is blocked, not judged. An unrunnable tier must not claim success, but "N tests failed" here is not a product verdict.`
      : "";

    /*
     * `bun test` shares one process across the files it was handed, so a suite that leaves global
     * state behind can fail a sibling that passes on its own — and which file shares a process is a
     * property of this driver's grouping, not of the suite. Re-running the files that failed inside
     * their own process separates the two: only a file that is still red alone is a real failure.
     * The interference is printed rather than hidden, because it is a defect in the suites
     * (they leak state), and the pre-migration `bun test ./app` had the same class of failure.
     */
    const alone = new Map<string, ReturnType<typeof readJunit>>();
    // A group with failures spread over many files is red for a reason that survives isolation
    // (an unreachable database), so re-running eight of them buys nothing: say so and fail fast.
    const cap = 8;
    if (started.failingFiles.length > cap) {
      throw new Error(
        `${group.name}: ${started.failures + started.errors} of ${started.tests} tests failed across ${started.failingFiles.length} files (more than the ${cap} the alone-re-run confirms); treated as a real failure\n${started.failed.slice(0, 4).join("\n")}${refusalNote}`,
      );
    }
    const startedAt = Date.now();
    for (const file of started.failingFiles) {
      if (Date.now() - startedAt > 300_000) {
        throw new Error(
          `${group.name}: ${started.failures + started.errors} tests failed and the alone-re-run budget ran out after ${alone.size} file(s); not claimed as passing`,
        );
      }
      alone.set(
        file,
        await runBun([file.startsWith("./") ? file : `./${file}`]),
      );
    }
    const realRed = [...alone].filter(
      ([, result]) => result.failures + result.errors > 0,
    );
    const interfered = [...alone].filter(
      ([, result]) => result.failures + result.errors === 0,
    );
    if (interfered.length) {
      console.error(
        `[bun-suites] ${group.name}: ${interfered.length} file(s) failed only when sharing a process: ${interfered.map(([file]) => file).join(", ")}`,
      );
    }
    expect(
      realRed.length,
      `${group.name}: ${realRed.length} of ${started.failingFiles.length} failing file(s) are still red run alone\n${realRed
        .map(
          ([file, result]) =>
            `${file}: ${result.failures + result.errors} of ${result.tests} — ${result.failed.slice(0, 3).join(" | ")}`,
        )
        .join("\n")}${refusalNote}`,
    ).toBe(0);
  });
}
