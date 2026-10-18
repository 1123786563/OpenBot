import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./support/e2e-compat";

/*
 * Suites that stay on the Bun runtime, driven and reported by e2e.
 *
 * The runner only executes on Node, while the server's data layer is Bun's own SQL client
 * (`server/src/db/client.ts` imports `{ SQL } from "bun"` and `drizzle-orm/bun-sql`) and its HTTP
 * layer is `serve` from "bun". Those suites test through that layer, so their process has to be
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

const manifest = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../docs/verification/e2e-bun-suites.json"),
    "utf8",
  ),
) as { groups: Group[] };

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
      const child = Bun.spawn(
        [
          "bun",
          "test",
          ...group.files,
          "--reporter",
          "junit",
          "--reporter-outfile",
          report,
          "--timeout",
          "120000",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...(group.env ?? {}) } as Record<
            string,
            string
          >,
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

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
