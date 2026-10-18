import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Bun's junit reporter is line oriented; the outer totals and the failure texts are enough. */
function readJunit(xml: string): {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failed: string[];
} {
  const attribute = (name: string): number => {
    const match = xml.match(new RegExp(`\\b${name}="(\\d+)"`));
    return match ? Number(match[1]) : 0;
  };
  const failed: string[] = [];
  for (const match of xml.matchAll(
    /<testcase[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g,
  )) {
    const body = match[2] ?? "";
    if (/<(failure|error)\b/.test(body)) {
      const detail = body
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      failed.push(`${match[1]}: ${detail}`);
    }
  }
  return {
    tests: attribute("tests"),
    failures: attribute("failures"),
    errors: attribute("errors"),
    skipped: attribute("skipped"),
    failed,
  };
}

for (const group of groups) {
  test(`bun runtime suite ${group.name}`, {
    tags: ["bun-runtime"],
    timeout: 900_000,
  }, async () => {
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
          ...group.files,
          // Bun takes `--reporter=<val>`; the separated form is rejected as an empty format.
          "--reporter=junit",
          `--reporter-outfile=${report}`,
          "--timeout=120000",
        ],
        { cwd: process.cwd(), env: { ...process.env, ...(group.env ?? {}) } },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        read(child.stdout),
        read(child.stderr),
        new Promise<number>((done) => {
          child.on("exit", (code) => done(code ?? 1));
          child.on("error", () => done(1));
        }),
      ]);

      if (!existsSync(report)) {
        // A mis-spawn must not read as a mysterious ENOENT: bun's own words are the diagnosis.
        throw new Error(
          `bun wrote no junit report for ${group.name}:\n${(stderr || stdout).slice(-800)}`,
        );
      }
      const parsed = readJunit(readFileSync(report, "utf8"));
      // A group that ran nothing is not a pass: an unusable path or a crashed loader reports zero.
      expect(
        parsed.tests,
        `bun ran no tests for ${group.name}: ${stderr.slice(-400)}`,
      ).toBeGreaterThan(0);
      expect(
        parsed.failures + parsed.errors,
        `${group.name}: ${parsed.failures + parsed.errors} of ${parsed.tests} bun tests failed\n${parsed.failed.slice(0, 12).join("\n")}\n${exitCode === 0 ? "" : stderr.slice(-400)}${stdout.slice(-400)}`,
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
