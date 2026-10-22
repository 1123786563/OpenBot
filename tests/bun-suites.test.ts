import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
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
const manifestJson = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
      groups: Group[];
      directoryIslands?: string[];
    })
  : { groups: [] as Group[] };
const all: Group[] = manifestJson.groups;
/*
 * The `multitenancy` suites create their own schema through
 * `server/scripts/multitenancy/migrate-test.ts`, which refuses a `TEST_DATABASE_URL` whose database is
 * not named `openbot_enterprise_*` on loopback — under the shared URL all 51 of them abort at
 * collection, which reads as "no tests" rather than as a defect. Those groups get their own group
 * (`DIRECTORY_ISLANDS` in scripts/lib/e2e-manifest.mjs, recorded here when the grouping is generated)
 * and, only when the environment offers one, `MT_TEST_DATABASE_URL` as their database. The family's
 * fixture also demands a coherent enterprise topology, so the island carries its own: the setup URL
 * falls back to `TEST_DATABASE_URL` (which the override just set), and each capability role comes
 * from its `MT_TEST_*` counterpart — the island is self-contained and the job-level
 * `ENTERPRISE_TEST_*` URLs stay owned by the enterprise suites. Every other group keeps the URLs the
 * rest of the corpus expects, and with `MT_TEST_DATABASE_URL` unset the driver behaves exactly as it
 * did before.
 */
const directoryIslands = manifestJson.directoryIslands ?? [];
const MT_ROLE_URLS: Record<string, string> = {
  ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: "MT_TEST_DIRECTORY_DATABASE_URL",
  ENTERPRISE_TEST_DATA_DATABASE_URL: "MT_TEST_DATA_DATABASE_URL",
  ENTERPRISE_TEST_OPERATOR_DATABASE_URL: "MT_TEST_OPERATOR_DATABASE_URL",
};
function bunEnv(groupName: string): Record<string, string | undefined> {
  const override = process.env.MT_TEST_DATABASE_URL;
  if (!override) return process.env;
  if (!directoryIslands.some((dir) => groupName.startsWith(dir)))
    return process.env;
  const env: Record<string, string | undefined> = {
    ...process.env,
    TEST_DATABASE_URL: override,
    DATABASE_URL: override,
  };
  for (const [target, source] of Object.entries(MT_ROLE_URLS)) {
    const url = process.env[source];
    if (url) env[target] = url;
  }
  return env;
}
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
    // #407: `\b` + lazy — a greedy `[^>]*name=` backtracks into
    // `classname=""` (always empty in bun's junit) and captures "" as the
    // test name, so every failure line read ": detail" with no name.
    /<testcase[^>]*?\bname="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g,
  )) {
    const body = match[2] ?? "";
    if (!/<(failure|error)\b/.test(body)) continue;
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const file = tag.match(/\bfile="([^"]*)"/)?.[1];
    if (file) failingFiles.add(file);
    const text = body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    let detail = text;
    if (!detail) {
      // #407: bun writes a timeout's verdict into the failure tag's
      // attributes, not its body — without this fallback the summary line
      // reads "name: " and a timeout is indistinguishable from a product
      // failure until someone re-runs the file by hand.
      const failureTag = /<(?:failure|error)\b[^>]*>/.exec(body)?.[0] ?? "";
      const kind = /\btype="([^"]*)"/.exec(failureTag)?.[1] ?? "";
      const message = (
        /\bmessage="([^"]*)"/.exec(failureTag)?.[1] ?? ""
      ).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
      detail = `${kind}${message ? `: ${message}` : ""}`.trim();
    }
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

/*
 * A failure assertion can carry bun's full util.inspect dump of a Happy-DOM tree: one shared-process
 * interference cascade produced a 6 GB junit.xml, and reading it as one string hits Node's
 * 0x1fffffe8 character limit before the alone-re-run fallback could even start. Reports past this
 * size are scanned in bounded windows instead: the counts come from the <testsuites> root
 * attributes near the head, and each failure keeps only its first 300 characters, exactly as the
 * in-memory parser above truncates them.
 */
const HUGE_REPORT_BYTES = 64 * 1024 * 1024;

/** Windowed twin of `readJunit` for reports too large for a single string. */
function readHugeJunit(path: string): ReturnType<typeof readJunit> {
  const failed: string[] = [];
  const failingFiles = new Set<string>();
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;

  const attribute = (tag: string, name: string): number => {
    const match = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
    return match ? Number(match[1]) : 0;
  };

  const handleTestcase = (tag: string, body: string) => {
    if (!/<(failure|error)\b/.test(body)) return;
    const file = /\bfile="([^"]*)"/.exec(tag)?.[1];
    if (file) failingFiles.add(file);
    const name = /\bname="([^"]*)"/.exec(tag)?.[1] ?? "";
    /*
     * A window can cut the excerpt inside the failure opening tag (review F-1). When that
     * fragment leads the body, drop it so the summary keeps readable text instead of raw
     * attribute characters.
     */
    let text = body;
    const failureTag = /<(?:failure|error)\b[^>]*>/.exec(body)?.[0] ?? null;
    if (failureTag === null) {
      // Opening tag cut mid-way: the fragment has no '>' so nothing after it was parsed yet.
      if (/\s*<(?:failure|error)\b[^>]*$/.test(body)) text = "";
    } else if (body.slice(0, body.indexOf(failureTag)).trim() === "") {
      text = body.slice(body.indexOf(failureTag) + failureTag.length);
    }
    let detail = text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (!detail) {
      const failureTag = /<(?:failure|error)\b[^>]*>/.exec(body)?.[0] ?? "";
      const kind = /\btype="([^"]*)"/.exec(failureTag)?.[1] ?? "";
      const message = (
        /\bmessage="([^"]*)"/.exec(failureTag)?.[1] ?? ""
      ).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
      detail = `${kind}${message ? `: ${message}` : ""}`.trim();
    }
    failed.push(`${name}: ${detail}`);
  };

  /*
   * Scan in fixed windows. Each iteration rebuilds `window` from `carry` (the unprocessed tail
   * of the previous window, capped at carryLimit) plus the next chunk; `cursor` walks complete
   * testcase tags inside it. When a failure body overflows the window the loop keeps only the
   * head excerpt, then seeks the closing tag byte offset and resumes after it, so the dump
   * itself is never held in memory.
   */
  const fd = openSync(path, "r");
  try {
    const chunkSize = 4 * 1024 * 1024;
    // Enough to hold an opening tag, its 300-character excerpt, and a closing tag in one window.
    const carryLimit = 8192;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let carry = "";
    let rootSeen = false;
    let position = 0;
    outer: while (true) {
      // Both Node and Bun return the byte count directly (no { bytesRead } wrapper).
      const readBytes = readSync(fd, buffer, 0, chunkSize, position) as number;
      if (readBytes === 0) break;
      position += readBytes;
      const window = carry + buffer.toString("utf8", 0, readBytes);
      if (!rootSeen) {
        const root = /<testsuites\b[^>]*>/.exec(window);
        if (root) {
          rootSeen = true;
          tests = attribute(root[0], "tests");
          failures = attribute(root[0], "failures");
          errors = attribute(root[0], "errors");
          skipped = attribute(root[0], "skipped");
        }
      }
      let cursor = 0;
      for (;;) {
        const open = window.indexOf("<testcase", cursor);
        if (open === -1) {
          carry =
            window.length > carryLimit ? window.slice(-carryLimit) : window;
          continue outer;
        }
        const tagEnd = window.indexOf(">", open);
        // Incomplete opening tag: wait for the next chunk.
        if (tagEnd === -1) {
          carry = window.slice(open);
          continue outer;
        }
        /*
         * A failure body is the inspect dump itself and can dwarf any window. 300 characters of
         * body already decide the summary, so when the closing tag is not in view take the head
         * excerpt and then seek the close tag in bounded steps from the current chunk onward.
         */
        const close = window.indexOf("</testcase>", tagEnd);
        let bodyEnd = close;
        if (close === -1) {
          bodyEnd = window.length;
        }
        if (bodyEnd - tagEnd > carryLimit) {
          bodyEnd = tagEnd + carryLimit;
        }
        handleTestcase(
          window.slice(open, tagEnd + 1),
          window.slice(tagEnd + 1, bodyEnd),
        );
        if (close === -1) {
          // Skip the rest of this dump: find the closing tag byte offset, then resume after it.
          const skip = findClosingTagFrom(fd, position, "</testcase>");
          if (skip === -1) break outer; // truncated report; nothing more to read
          position = skip;
          carry = "";
          continue outer;
        }
        cursor = close + "</testcase>".length;
      }
    }
  } finally {
    closeSync(fd);
  }
  return {
    tests,
    failures,
    errors,
    skipped,
    failed,
    failingFiles: [...failingFiles],
  };
}

/**
 * Searches `haystack` starting at byte `from` for `needle`, in bounded chunks, and returns the byte
 * offset just past the match (-1 at end of file). Neither the dump nor an oversized intermediate
 * string is ever materialized: each chunk is decoded, searched, and dropped.
 */
function findClosingTagFrom(fd: number, from: number, needle: string): number {
  const chunkSize = 4 * 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  // needle.length - 1 bytes of a partial match can straddle chunks; carry them as a string.
  let overlap = "";
  let position = Math.max(0, from - (needle.length - 1));
  for (;;) {
    const readBytes = readSync(fd, buffer, 0, chunkSize, position) as number;
    if (readBytes === 0) return -1;
    const chunk = overlap + buffer.toString("utf8", 0, readBytes);
    const index = chunk.indexOf(needle);
    if (index !== -1) {
      // Bytes consumed to the end of the match, discounting the overlap prefix.
      const consumed =
        Buffer.byteLength(chunk.slice(0, index + needle.length)) -
        Buffer.byteLength(overlap);
      return position + consumed;
    }
    position += readBytes;
    overlap = chunk.slice(-(needle.length - 1));
  }
}

/** One `bun test` invocation, with its junit parsed. The driver needs it twice: grouped and alone. */
async function runBun(
  files: string[],
  env: Record<string, string | undefined> = process.env,
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
      { cwd: process.cwd(), env: env as NodeJS.ProcessEnv },
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
    // A shared-process cascade once wrote a 6 GB dump; the fallback below must still run.
    const parsed =
      statSync(report).size > HUGE_REPORT_BYTES
        ? readHugeJunit(report)
        : readJunit(readFileSync(report, "utf8"));
    return { ...parsed, exitCode, stderr };
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
    const started = await runBun(
      group.files.map((f) => `./${f}`),
      bunEnv(group.name),
    );
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
        await runBun(
          [file.startsWith("./") ? file : `./${file}`],
          bunEnv(group.name),
        ),
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
