/**
 * MT131 / Issue #174 — the multitenancy acceptance harness and its
 * independent test environment.
 *
 * Verification target (Ticket):
 * `set +x; source /tmp/mt131-env.sh && bun test server/tests/multitenancy/acceptance-harness.test.ts`
 *
 * The harness must isolate its database, loopback HTTP port and external
 * namespace away from development; prove itself by detecting an intentionally
 * injected unauthorized observation BEFORE any evidence is accepted; hard-fail
 * (never skip) when the dedicated test environment is missing; and emit a
 * machine-readable per-entrance positive/denial coverage report in which a
 * missing half, an absent scenario, or a brand-new inventory entrance is
 * `uncovered` — never a synthetic pass. Service surfaces never count as route
 * coverage. No identity-matrix business case lives here (that is MT132+).
 */

import {
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type EvidencePlan,
  evaluateObservationSide,
  HARNESS_CONTROL_DOMAIN,
  HARNESS_HTTP_PORT,
  HARNESS_SCHEMA_VERSION,
  type HarnessReport,
  resolveHarnessIsolation,
  runAcceptanceHarness,
  startHarnessHttpStatus,
} from "../../scripts/multitenancy/acceptance-harness";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import {
  clearIsolationDomainRegistrations,
  registerIsolationDomain,
} from "./support/scenarios";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const REAL_ENV: Record<string, string | undefined> = { ...process.env };
const REPO_ROOT = resolve(hereDir, "../../..");

/**
 * The setup URL of THIS process's environment, re-parsed here independently
 * of the harness: assertions must be derived from the environment (any
 * compliant dedicated environment must pass) and never hardcode one
 * machine's database name or port.
 */
function realSetupDatabaseUrl(): URL {
  const raw = REAL_ENV.ENTERPRISE_TEST_SETUP_DATABASE_URL?.trim()
    ? REAL_ENV.ENTERPRISE_TEST_SETUP_DATABASE_URL
    : REAL_ENV.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "this suite requires a dedicated ENTERPRISE_TEST_SETUP_DATABASE_URL or TEST_DATABASE_URL environment",
    );
  }
  return new URL(raw);
}

/** URL semantics: the database name is the single decoded path segment. */
function databaseNameOf(url: URL): string {
  return decodeURIComponent(
    url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
  );
}

/** One shared real inventory build: the harness must consume it as-is. */
const inventory = await buildInventory({ environment: REAL_ENV });

const CLEAN_OBSERVATION = {
  positiveControlPassed: true,
  denied: true,
  leakedRecords: [] as unknown[],
  forbiddenEffects: [] as unknown[],
} as const;

const POISON_OBSERVATION = {
  positiveControlPassed: true,
  denied: false,
  leakedRecords: [
    { seeded: "mt131-unauthorized-result", note: "intentional poison" },
  ],
  forbiddenEffects: [] as unknown[],
} as const;

/** Consistent fake URLs for pure resolution tests (no connection is opened). */
const CONSISTENT_FAKE_ENV: Record<string, string | undefined> = {
  TEST_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt131_test",
  ENTERPRISE_TEST_DIRECTORY_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt131_test",
  ENTERPRISE_TEST_DATA_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt131_test",
  ENTERPRISE_TEST_OPERATOR_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt131_test",
};

beforeEach(() => {
  clearIsolationDomainRegistrations();
});

describe("harness isolation resolution", () => {
  test("refuses missing and development environments, never falls back", () => {
    // No environment at all: explicit failure, never a skip.
    expect(() => resolveHarnessIsolation({})).toThrow(
      /TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/,
    );
    // A development DATABASE_URL never substitutes for the test URL.
    expect(() =>
      resolveHarnessIsolation({
        DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      }),
    ).toThrow(/TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/);
    // The live application database name is refused even through the test var.
    expect(() =>
      resolveHarnessIsolation({
        TEST_DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      }),
    ).toThrow(/openbot_enterprise_/);
    // Non-loopback hosts are refused outright.
    expect(() =>
      resolveHarnessIsolation({
        ...CONSISTENT_FAKE_ENV,
        TEST_DATABASE_URL:
          "postgres://user:secret@example.invalid:55434/openbot_enterprise_mt131_test",
      }),
    ).toThrow(/loopback/);
    // Restricted business role URLs are mandatory: no fallback to the setup login.
    const { ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: _omit, ...missingRoles } =
      CONSISTENT_FAKE_ENV;
    expect(() => resolveHarnessIsolation(missingRoles)).toThrow(
      /ENTERPRISE_TEST_DIRECTORY_DATABASE_URL/,
    );
    // A role URL pointing somewhere else than the setup database is refused.
    expect(() =>
      resolveHarnessIsolation({
        ...CONSISTENT_FAKE_ENV,
        ENTERPRISE_TEST_DATA_DATABASE_URL:
          "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt131_other",
      }),
    ).toThrow(/same PostgreSQL instance/);
  });

  test("returns the dedicated isolation configuration from the real environment", () => {
    const isolation = resolveHarnessIsolation(REAL_ENV, "run123");
    expect(isolation.runId).toBe("run123");
    // Derived from this process's dedicated environment, not from any one
    // machine's constants: the resolution must echo exactly what the
    // environment points at, and the name must stay in the enterprise
    // test-database namespace.
    const setupUrl = realSetupDatabaseUrl();
    expect(isolation.databaseName).toBe(databaseNameOf(setupUrl));
    expect(isolation.databaseName).toMatch(/^openbot_enterprise_/);
    expect(isolation.databaseHost).toBe(setupUrl.hostname);
    expect(isolation.databasePort).toBe(Number(setupUrl.port) || 5432);
    expect(isolation.restrictedRoles).toEqual([
      "directory",
      "data",
      "operator",
    ]);
    expect(isolation.loopbackOnly).toBe(true);
    // Dedicated loopback HTTP port, away from any development port.
    expect(HARNESS_HTTP_PORT).toBe(45435);
    expect(isolation.httpPort).toBe(HARNESS_HTTP_PORT);
    expect(isolation.httpHostname).toBe("127.0.0.1");
    // Task-prefixed external namespace and task-specific temp directory.
    expect(isolation.externalNamespace).toBe("issue6_mt131_run123");
    expect(
      isolation.tempDir.startsWith(join(tmpdir(), "openbot-mt131-harness")),
    ).toBe(true);
    expect(isolation.tempDir.includes("run123")).toBe(true);
    // Generated run ids are unique and shape the namespace.
    const a = resolveHarnessIsolation(REAL_ENV);
    const b = resolveHarnessIsolation(REAL_ENV);
    expect(a.externalNamespace).toMatch(/^issue6_mt131_[a-z0-9-]+$/);
    expect(a.externalNamespace).not.toBe(b.externalNamespace);
  });
});

describe("harness loopback HTTP isolation", () => {
  test("serves on 127.0.0.1:45435 only, refuses double bind, releases on close", async () => {
    const server = await startHarnessHttpStatus("run-http");
    expect(server.port).toBe(45435);
    const response = await fetch("http://127.0.0.1:45435/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      harness: "mt131-acceptance",
      runId: "run-http",
      httpPort: 45435,
    });
    // A second exclusive bind must fail: the port is dedicated to this harness.
    await expect(startHarnessHttpStatus("run-http-2")).rejects.toThrow(
      /HARNESS_PORT_UNAVAILABLE/,
    );
    await server.close();
    // Closing releases the port for the next run.
    const rebind = await startHarnessHttpStatus("run-http-3");
    await rebind.close();
  });
});

describe("unauthorized-result detector", () => {
  test("a poisoned unauthorized observation never passes any side", () => {
    const positive = evaluateObservationSide(POISON_OBSERVATION, "positive");
    expect(positive.verdict).toBe("fail");
    expect(positive.reasons).toContain("leaked-records:1");

    const denial = evaluateObservationSide(POISON_OBSERVATION, "denial");
    expect(denial.verdict).toBe("fail");
    expect(denial.reasons).toContain("denied:false");
    expect(denial.reasons).toContain("leaked-records:1");
  });

  test("a clean observation passes both sides; each side keeps its own failure mode", () => {
    expect(evaluateObservationSide(CLEAN_OBSERVATION, "positive").verdict).toBe(
      "pass",
    );
    expect(evaluateObservationSide(CLEAN_OBSERVATION, "denial").verdict).toBe(
      "pass",
    );

    const controlFailed = {
      ...CLEAN_OBSERVATION,
      positiveControlPassed: false,
    };
    expect(evaluateObservationSide(controlFailed, "positive").verdict).toBe(
      "fail",
    );
    expect(
      evaluateObservationSide(controlFailed, "positive").reasons,
    ).toContain("positive-control-failed");
    expect(evaluateObservationSide(controlFailed, "denial").verdict).toBe(
      "pass",
    );

    const forbidden = { ...CLEAN_OBSERVATION, forbiddenEffects: [{ x: 1 }] };
    expect(evaluateObservationSide(forbidden, "positive").verdict).toBe("fail");
    expect(evaluateObservationSide(forbidden, "denial").verdict).toBe("fail");
  });
});

describe("acceptance harness pipeline", () => {
  test("hard-fails on a missing environment instead of skipping", async () => {
    await expect(
      runAcceptanceHarness({ environment: {}, inventory }),
    ).rejects.toThrow(/HARNESS_ENVIRONMENT_FAILED/);
    // A development DATABASE_URL does not rescue the run either.
    await expect(
      runAcceptanceHarness({
        environment: {
          DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
        },
        inventory,
      }),
    ).rejects.toThrow(/HARNESS_ENVIRONMENT_FAILED/);
  });

  test("refuses a foreign adapter squatting on the harness control domain", async () => {
    registerIsolationDomain(HARNESS_CONTROL_DOMAIN, {
      run: async () => CLEAN_OBSERVATION,
    });
    await expect(
      runAcceptanceHarness({ environment: REAL_ENV, inventory }),
    ).rejects.toThrow(/HARNESS_CONTROL_DOMAIN_OCCUPIED/);
  });

  test("aborts before any evidence when the detector misses the poison", async () => {
    let evidenceRuns = 0;
    registerIsolationDomain("bots", {
      run: async () => {
        evidenceRuns += 1;
        return CLEAN_OBSERVATION;
      },
    });
    const entranceId = inventory.entrances[0].id;
    const plan: EvidencePlan = {
      [entranceId]: {
        positive: { domain: "bots", scenarioId: "positive" },
        denial: { domain: "bots", scenarioId: "denial" },
      },
    };
    // A broken detector that would wave anything through — including the
    // seeded unauthorized observation. The self-check must catch it and the
    // harness must abort before collecting a single piece of evidence.
    await expect(
      runAcceptanceHarness({
        environment: REAL_ENV,
        inventory,
        evidencePlan: plan,
        evaluator: () => ({ verdict: "pass", reasons: [] }),
      }),
    ).rejects.toThrow(/HARNESS_SELF_CHECK_FAILED/);
    expect(evidenceRuns).toBe(0);
  });

  test("produces machine-readable per-entrance positive/denial coverage", async () => {
    const covered = inventory.entrances[0].id;
    const halfCovered = inventory.entrances[1].id;
    const poisoned = inventory.entrances[2].id;
    registerIsolationDomain("bots", {
      run: async (scenarioId) =>
        scenarioId === "leaked" ? POISON_OBSERVATION : CLEAN_OBSERVATION,
    });
    registerIsolationDomain("conversations", {
      run: async () => {
        throw new Error("scenario does not exist");
      },
    });
    const plan: EvidencePlan = {
      [covered]: {
        positive: { domain: "bots", scenarioId: "positive" },
        denial: { domain: "bots", scenarioId: "denial" },
      },
      [halfCovered]: {
        positive: { domain: "bots", scenarioId: "positive" },
      },
      [poisoned]: {
        positive: { domain: "bots", scenarioId: "leaked" },
        denial: { domain: "conversations", scenarioId: "absent" },
      },
    };

    const report = await runAcceptanceHarness({
      environment: REAL_ENV,
      inventory,
      evidencePlan: plan,
    });

    // --- Output schema -----------------------------------------------------
    expect(report.schemaVersion).toBe(HARNESS_SCHEMA_VERSION);
    expect(HARNESS_SCHEMA_VERSION).toBe(1);
    expect(report.harness).toBe("mt131-acceptance");
    // Derived from this process's dedicated environment: the report must
    // describe the database the run actually used, whatever it is named.
    expect(report.isolation.databaseName).toBe(
      databaseNameOf(realSetupDatabaseUrl()),
    );
    expect(report.isolation.databaseName).toMatch(/^openbot_enterprise_/);
    expect(report.isolation.httpPort).toBe(45435);
    expect(report.isolation.externalNamespace).toMatch(
      /^issue6_mt131_[a-z0-9-]+$/,
    );
    expect(report.inventory.digest).toBe(inventory.digest);
    expect(report.inventory.totalEntrances).toBe(inventory.entrances.length);
    expect(() => JSON.stringify(report)).not.toThrow();

    // --- Self-proof ran first and detected the seeded unauthorized result --
    expect(report.positiveControl.status).toBe("passed");
    expect(report.positiveControl.seedPoison.detected).toBe(true);
    const checks = Object.fromEntries(
      report.positiveControl.checks.map((check) => [check.id, check]),
    );
    expect(checks["poison-unauthorized-success"]?.status).toBe("pass");
    expect(checks["clean-observation"]?.status).toBe("pass");
    // The real environment checks went through the real MT002 fixture seam.
    expect(checks["environment-positive-control"]?.status).toBe("pass");
    expect(checks["environment-cross-tenant-denial"]?.status).toBe("pass");

    // --- Per-entrance results ----------------------------------------------
    const byId = new Map(report.entrances.map((entry) => [entry.id, entry]));
    expect(report.entrances.length).toBe(inventory.entrances.length);

    const good = byId.get(covered);
    expect(good?.status).toBe("covered");
    expect(good?.positive.status).toBe("pass");
    expect(good?.denial.status).toBe("pass");

    const half = byId.get(halfCovered);
    expect(half?.status).toBe("uncovered");
    expect(half?.positive.status).toBe("pass");
    expect(half?.denial.status).toBe("missing");

    const bad = byId.get(poisoned);
    expect(bad?.status).toBe("uncovered");
    expect(bad?.positive.status).toBe("fail");
    expect(bad?.positive.reasons).toContain("leaked-records:1");
    expect(bad?.denial.status).toBe("scenario-error");

    // Every unmapped entrance is uncovered with both sides missing.
    const unplanned = report.entrances.filter((entry) => !plan[entry.id]);
    expect(unplanned.length).toBe(inventory.entrances.length - 3);
    for (const entry of unplanned) {
      expect(entry.status).toBe("uncovered");
      expect(entry.positive.status).toBe("missing");
      expect(entry.denial.status).toBe("missing");
    }

    // --- Service surfaces never count as route coverage ---------------------
    expect(report.serviceSurfaces.length).toBe(
      inventory.serviceSurfaces.length,
    );
    expect(report.serviceSurfaces.length).toBeGreaterThan(0);
    for (const surface of report.serviceSurfaces) {
      expect(surface.countsAsRouteCoverage).toBe(false);
      expect(surface.status).toBe("uncovered");
    }
    expect(report.summary.serviceSurfacesCountingAsRouteCoverage).toBe(0);

    // --- Summary and overall verdict ----------------------------------------
    expect(report.summary.totalEntrances).toBe(inventory.entrances.length);
    expect(report.summary.coveredEntrances).toBe(1);
    expect(report.summary.uncoveredEntrances).toBe(
      inventory.entrances.length - 1,
    );
    expect(report.overall).toBe("acceptance-not-passed");
  }, 120_000);

  test("a newly added inventory entrance appears as uncovered", async () => {
    const drifted = await buildInventory({
      environment: REAL_ENV,
      mutateApp: (name, app) => {
        if (name !== "deployment-full") return;
        app.routes.push({ method: "GET", path: "/api/__mt131_new_entrance" });
      },
    });
    const probe = drifted.entrances.find(
      (entry) => entry.entrance === "GET /api/__mt131_new_entrance",
    );
    expect(probe).toBeDefined();

    const report = await runAcceptanceHarness({
      environment: REAL_ENV,
      inventory: drifted,
    });
    const entry = report.entrances.find((item) => item.id === probe?.id);
    expect(entry?.status).toBe("uncovered");
    expect(entry?.positive.status).toBe("missing");
    expect(entry?.denial.status).toBe("missing");
    expect(report.overall).toBe("acceptance-not-passed");
  }, 120_000);

  test("an evidence plan naming an entrance absent from the inventory is refused", async () => {
    await expect(
      runAcceptanceHarness({
        environment: REAL_ENV,
        inventory,
        evidencePlan: {
          "PATCH /does/not/exist": {
            positive: { domain: "bots", scenarioId: "positive" },
          },
        },
      }),
    ).rejects.toThrow(/HARNESS_EVIDENCE_PLAN_ENTRANCE_UNKNOWN/);
  });

  test("refuses harness-owned control scenarios as business evidence", async () => {
    const entranceId = inventory.entrances[0].id;
    // The harness control domain and its harness.* scenario ids are
    // reserved for the harness's own self-checks: a business evidence plan
    // may never cite them as evidence, because a control scenario answers
    // from the harness itself and would act as an always-green oracle.
    await expect(
      runAcceptanceHarness({
        environment: REAL_ENV,
        inventory,
        evidencePlan: {
          [entranceId]: {
            positive: {
              domain: HARNESS_CONTROL_DOMAIN,
              scenarioId: "harness.control.clean-observation",
            },
          },
        },
      }),
    ).rejects.toThrow(/HARNESS_EVIDENCE_PLAN_INVALID.*control domain/);
    // A harness-prefixed scenario id is refused even on a foreign domain:
    // the reserved namespace belongs to the harness's internal controls.
    await expect(
      runAcceptanceHarness({
        environment: REAL_ENV,
        inventory,
        evidencePlan: {
          [entranceId]: {
            positive: {
              domain: "bots",
              scenarioId: "harness.control.identity",
            },
          },
        },
      }),
    ).rejects.toThrow(/HARNESS_EVIDENCE_PLAN_INVALID.*harness-prefixed/);
  }, 120_000);

  test("uses its temp directory for run-scoped metadata", async () => {
    const report = await runAcceptanceHarness({
      environment: REAL_ENV,
      inventory,
    });
    const metadataPath = join(report.isolation.tempDir, "run-metadata.json");
    const raw = await Bun.file(metadataPath).text();
    const metadata = JSON.parse(raw);
    expect(metadata.schemaVersion).toBe(HARNESS_SCHEMA_VERSION);
    expect(metadata.harness).toBe("mt131-acceptance");
    expect(metadata.runId).toBe(report.runId);
    expect(metadata.isolation.databaseName).toBe(report.isolation.databaseName);
    expect(metadata.isolation.httpPort).toBe(HARNESS_HTTP_PORT);
    // Run-scoped state must stay free of credentials.
    expect(raw).not.toContain("postgres://");
    expect(raw.toLowerCase()).not.toContain("password");
    await rm(report.isolation.tempDir, { recursive: true, force: true });
  }, 120_000);

  test("absent provider credentials are environment gaps, never passes", async () => {
    const gapped = inventory.entrances[3].id;
    const configured = inventory.entrances[4].id;
    registerIsolationDomain("bots", {
      run: async () => CLEAN_OBSERVATION,
    });
    const plan: EvidencePlan = {
      [gapped]: {
        positive: { domain: "bots", scenarioId: "positive" },
        denial: {
          domain: "bots",
          scenarioId: "external-provider-denial",
          requiresConfig: ["MT131_ABSENT_PROVIDER_TOKEN"],
        },
      },
      [configured]: {
        positive: { domain: "bots", scenarioId: "positive" },
        denial: {
          domain: "bots",
          scenarioId: "external-provider-denial",
          requiresConfig: ["MT131_PRESENT_PROVIDER_TOKEN"],
        },
      },
    };

    const report = await runAcceptanceHarness({
      environment: {
        ...REAL_ENV,
        MT131_PRESENT_PROVIDER_TOKEN: "configured-for-this-run",
      },
      inventory,
      evidencePlan: plan,
    });

    const byId = new Map(report.entrances.map((entry) => [entry.id, entry]));
    const gap = byId.get(gapped);
    expect(gap?.positive.status).toBe("pass");
    expect(gap?.denial.status).toBe("environment-gap");
    expect(gap?.status).toBe("uncovered");
    const configuredEntry = byId.get(configured);
    expect(configuredEntry?.denial.status).toBe("pass");
    expect(configuredEntry?.status).toBe("covered");

    expect(report.environmentGaps).toEqual([
      {
        entranceId: gapped,
        side: "denial",
        missingConfigKeys: ["MT131_ABSENT_PROVIDER_TOKEN"],
      },
    ]);
    expect(report.overall).toBe("acceptance-not-passed");
  }, 120_000);
});

describe("acceptance harness CLI", () => {
  test("writes a machine-readable report and exits 0 on an honest run", async () => {
    const dir = join(tmpdir(), `mt131-cli-${Date.now()}`);
    const out = join(dir, "report.json");
    const proc = Bun.spawn(
      [
        process.execPath,
        join(REPO_ROOT, "server/scripts/multitenancy/acceptance-harness.ts"),
        "--out",
        out,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    expect(code).toBe(0);
    const report: HarnessReport = JSON.parse(await Bun.file(out).text());
    expect(report.schemaVersion).toBe(1);
    expect(report.positiveControl.status).toBe("passed");
    expect(report.positiveControl.seedPoison.detected).toBe(true);
    expect(report.summary.coveredEntrances).toBe(0);
    expect(report.overall).toBe("acceptance-not-passed");
    await rm(dir, { recursive: true, force: true });
  }, 180_000);

  test("refuses CLI flags given without a value", async () => {
    for (const flag of ["--out", "--evidence", "--run-id"]) {
      const proc = Bun.spawn(
        [
          process.execPath,
          join(REPO_ROOT, "server/scripts/multitenancy/acceptance-harness.ts"),
          flag,
        ],
        { cwd: REPO_ROOT, env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      expect(code).toBe(1);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toMatch(/HARNESS_FLAG_MISSING_VALUE/);
    }
  }, 60_000);

  test("exits 1 with an explicit message when the environment is missing", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(REPO_ROOT, "server/scripts/multitenancy/acceptance-harness.ts"),
      ],
      { cwd: REPO_ROOT, env: {}, stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toMatch(/HARNESS_RUN_FAILED/);
    expect(stderr).toMatch(
      /TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/,
    );
  }, 60_000);
});
