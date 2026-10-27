/*
 * The engine tier's browser isolation, as named counterexamples (T04.12 / #563, plan F4):
 *
 *   default_and_ba_web_collectors_are_disjoint — both collectors are enumerated by the real
 *     runner (`e2e list`, which starts no engine and no worker), their intersection is empty, and
 *     each equals its group in tests/config/e2e-engine-suites.json exactly. A BA Web file that
 *     slipped into the default corpus would drive the legacy stack (app :3010 behind Casdoor
 *     :8000) where no BA plane exists, and a legacy file under the BA config would demand BA
 *     origins it cannot have.
 *   missing_origin_fails_before_any_navigation — a BA Web run without BA_E2E_APP_ORIGIN fails
 *     before any network access: in-process, the preflight throws against a recording fetch that
 *     saw zero requests; through the real runner, the run exits non-zero naming the variable at
 *     config-load time, which is before any engine is created and any page is opened.
 *   wrong_config_target_refuses_the_ba_web_file — the default config refuses the BA subtree by
 *     collection (non-zero, no silently green run), and if a widened glob ever collected the file
 *     anyway, the suite guard it imports refuses the run because the suite token only the BA
 *     config sets is absent — checked here against the guard directly, zero network.
 *   unregistered_engine_file_fails_the_engine_audit — a file claimed by the engine manifest that
 *     its suite's collector does not collect makes `e2e-coverage-audit.mjs --engine-manifest`
 *     exit non-zero, so an unregistered engine file can never read as coverage. Runs against a
 *     throwaway manifest in the OS temp dir so a failing assertion cannot mutate the committed
 *     config.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "./support/e2e-compat";

const root = resolve(import.meta.dirname, "..");
const e2eBin = join(root, "node_modules", ".bin", "e2e");
const auditBin = join(root, "scripts", "e2e-coverage-audit.mjs");
const engineManifestPath = join(
  import.meta.dirname,
  "config/e2e-engine-suites.json",
);
const BA_FILE = "tests/e2e/better-auth/web/directory.e2e.ts";

interface EngineSuite {
  name: string;
  config: string;
  script: string;
  tests: string[];
  target: string;
  preflight: string | null;
  files: string[];
}

function committedSuites(): EngineSuite[] {
  const parsed = JSON.parse(readFileSync(engineManifestPath, "utf8"));
  return parsed.suites;
}

/** What `e2e list` says one config collects: unique file paths, in the runner's order. */
function collectedFiles(config: string): {
  status: number | null;
  files: string[];
  output: string;
} {
  const run = spawnSync(e2eBin, ["list", "--config", config], {
    cwd: root,
    encoding: "utf8",
  });
  const files = [
    ...new Set(
      run.stdout
        .split("\n")
        .filter((line) => line.includes(" › "))
        .map((line) => line.split(" › ")[0].trim()),
    ),
  ];
  return { status: run.status, files, output: run.stdout + run.stderr };
}

/** The runner's environment with the BA origins absent, so spawns stay hermetic. */
function envWithoutBaOrigins(): NodeJS.ProcessEnv {
  return { ...process.env, BA_E2E_APP_ORIGIN: "", BA_E2E_API_ORIGIN: "" };
}

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("browser suite isolation", () => {
  test("default_and_ba_web_collectors_are_disjoint", {
    timeout: 120_000,
  }, () => {
    const byName = new Map(
      committedSuites().map((suite) => [suite.name, suite] as const),
    );
    const defaultSuite = byName.get("default");
    const baSuite = byName.get("better-auth-web");
    expect(defaultSuite).toBeDefined();
    expect(baSuite).toBeDefined();

    const defaultList = collectedFiles(defaultSuite.config);
    const baList = collectedFiles(baSuite.config);
    expect(defaultList.status, defaultList.output).toBe(0);
    expect(baList.status, baList.output).toBe(0);

    const intersection = defaultList.files.filter((file) =>
      baList.files.includes(file),
    );
    expect(intersection).toEqual([]);

    // Each collector equals its manifest group exactly — otherwise the audit's
    // accounting and the runner's collection disagree about what "collected" means.
    expect([...defaultList.files].sort()).toEqual(
      [...defaultSuite.files].sort(),
    );
    expect([...baList.files].sort()).toEqual([...baSuite.files].sort());
  });

  test("missing_origin_fails_before_any_navigation", {
    timeout: 120_000,
  }, async () => {
    // In-process: the preflight refuses with a recording fetch that sees zero requests.
    const preflight = await import("./support/better-auth-preflight");
    const networkRequests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      networkRequests.push(String(input));
      throw new Error(`unexpected network access: ${String(input)}`);
    }) as typeof fetch;
    await expect(
      preflight.preflightBaWebEngine({ env: {}, fetchImpl }),
    ).rejects.toThrow(/BA_E2E_APP_ORIGIN/);
    expect(networkRequests).toHaveLength(0);

    // The real runner: same refusal, at config load — before any engine exists.
    const run = spawnSync(
      e2eBin,
      ["run", "--config", "e2e.better-auth.config.ts", BA_FILE],
      { cwd: root, encoding: "utf8", env: envWithoutBaOrigins() },
    );
    expect(run.status, run.stdout + run.stderr).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("BA_E2E_APP_ORIGIN");
  });

  test("wrong_config_target_refuses_the_ba_web_file", {
    timeout: 120_000,
  }, async () => {
    // By collection: the default config's globs do not reach the BA subtree, and a
    // selection that matches nothing exits non-zero instead of silently passing.
    const run = spawnSync(
      e2eBin,
      ["run", "--config", "e2e.config.ts", BA_FILE],
      {
        cwd: root,
        encoding: "utf8",
        env: envWithoutBaOrigins(),
      },
    );
    expect(run.status, run.stdout + run.stderr).not.toBe(0);

    // By guard: even if a widened glob ever collected the file, the suite guard
    // refuses a run whose token is not the BA Web suite's.
    const preflight = await import("./support/better-auth-preflight");
    expect(() => preflight.assertBaWebSuite(BA_FILE, "default")).toThrow(
      /test:ui:better-auth/,
    );
  });

  test("unregistered_engine_file_fails_the_engine_audit", {
    timeout: 60_000,
  }, () => {
    const directory = mkdtempSync(join(tmpdir(), "e2e-engine-suites-"));
    scratch.push(directory);
    const manifest = { suites: committedSuites() };
    const baSuite = manifest.suites.find(
      (suite) => suite.name === "better-auth-web",
    );
    baSuite.files.push("tests/e2e/better-auth/web/ghost.e2e.ts");
    const target = join(directory, "e2e-engine-suites.json");
    writeFileSync(target, JSON.stringify(manifest, null, 2));

    const audit = spawnSync(
      process.execPath,
      [auditBin, `--engine-manifest=${target}`],
      { cwd: root, encoding: "utf8" },
    );
    expect(audit.status, audit.stdout + audit.stderr).not.toBe(0);
    expect(audit.stdout + audit.stderr).toContain("ghost.e2e.ts");
  });
});
