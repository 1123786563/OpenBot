/**
 * MT132 / Issue #175 — the identity-matrix runner.
 *
 * Verification target (Ticket):
 * `set +x; source /tmp/mt24-env.sh && bun --no-env-file test server/tests/multitenancy/identity-matrix-runner.test.ts`
 *
 * The runner must carry the Spec §11 minimum matrix (all eight identity
 * classes, AC1), produce per-entrance positive AND denial conclusions in
 * which a missing half, an absent scenario, an absent provider credential or
 * a brand-new inventory entrance is `uncovered` — never a synthetic pass
 * (AC2) — in a machine-readable report that downstream coverage tickets and
 * the release candidate can consume (AC3, proven here by consuming the
 * report through the exported seam). Drift detection (AC4) is pinned by
 * rebuilding the inventory with a brand-new entrance. Business evidence
 * adapters are fakes here; the real ones ride the domain fixtures in the
 * MT133–MT135 coverage suites, which consume this runner.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { HARNESS_CONTROL_DOMAIN } from "../../scripts/multitenancy/acceptance-harness";
import {
  IDENTITY_MATRIX_CLASSES,
  MATRIX_EXTERNAL_NAMESPACE_PREFIX,
  MATRIX_SCHEMA_VERSION,
  type MatrixCoverageReport,
  type MatrixPlan,
  matrixClassOf,
  matrixSideStatus,
  resolveMatrixIsolation,
  runMatrixCoverage,
  validateIdentityMatrix,
  validateMatrixPlan,
} from "../../scripts/multitenancy/identity-matrix-runner";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { FIXTURE_IDENTITIES, SPEC_IDENTITY_MATRIX } from "./support/fixture";
import {
  clearIsolationDomainRegistrations,
  registerIsolationDomain,
} from "./support/scenarios";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const REAL_ENV: Record<string, string | undefined> = { ...process.env };
const REPO_ROOT = resolve(hereDir, "../../..");

/** One shared real inventory build: the runner must consume it as-is. */
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
  leakedRecords: [{ seeded: "mt132-unauthorized-result" }],
  forbiddenEffects: [] as unknown[],
} as const;

/** Consistent fake URLs for pure resolution tests (no connection opens). */
const CONSISTENT_FAKE_ENV: Record<string, string | undefined> = {
  TEST_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt132_test",
  ENTERPRISE_TEST_DIRECTORY_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt132_test",
  ENTERPRISE_TEST_DATA_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt132_test",
  ENTERPRISE_TEST_OPERATOR_DATABASE_URL:
    "postgres://user:secret@127.0.0.1:55434/openbot_enterprise_mt132_test",
};

beforeEach(() => {
  clearIsolationDomainRegistrations();
});

// ---------------------------------------------------------------------------
// AC1 — the fixed identity matrix
// ---------------------------------------------------------------------------

describe("identity matrix", () => {
  test("covers exactly the Spec §11 eight classes, aligned with the MT002 fixture matrix", () => {
    // The eight Spec classes, in Spec order, one label each.
    expect(IDENTITY_MATRIX_CLASSES).toHaveLength(8);
    expect(IDENTITY_MATRIX_CLASSES.map((entry) => entry.id)).toEqual(
      Object.keys(SPEC_IDENTITY_MATRIX),
    );
    for (const entry of IDENTITY_MATRIX_CLASSES) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      // Every class is non-empty and only contains real fixture identities.
      expect(SPEC_IDENTITY_MATRIX[entry.id].length).toBeGreaterThan(0);
      for (const identity of SPEC_IDENTITY_MATRIX[entry.id]) {
        expect(FIXTURE_IDENTITIES).toContain(identity);
      }
    }
    // Every fixture identity sits in some class — no identity may silently
    // fall outside the matrix (the ninth `multi-company` identity belongs to
    // the cross-company class together with `b1-member`).
    const union = new Set(
      IDENTITY_MATRIX_CLASSES.flatMap((entry) => [
        ...SPEC_IDENTITY_MATRIX[entry.id],
      ]),
    );
    for (const identity of FIXTURE_IDENTITIES) {
      expect(union.has(identity)).toBe(true);
    }
    // The shipped matrix validates as-is, and each identity resolves to the
    // one class it belongs to.
    expect(() => validateIdentityMatrix()).not.toThrow();
    expect(matrixClassOf("a1-member")).toBe("company-a-team-a1-only");
    expect(matrixClassOf("a2-member")).toBe("company-a-team-a2-only");
    expect(matrixClassOf("a1a2-member")).toBe("company-a-both-teams");
    expect(matrixClassOf("a1-other")).toBe("same-team-other-person");
    expect(matrixClassOf("b1-member")).toBe("cross-company");
    expect(matrixClassOf("multi-company")).toBe("cross-company");
    expect(matrixClassOf("company-admin")).toBe("company-admin");
    expect(matrixClassOf("platform-operator")).toBe("platform-operator");
    expect(matrixClassOf("worker")).toBe("restricted-worker");
  });

  test("resolveMatrixIsolation refuses missing and development environments", () => {
    expect(() => resolveMatrixIsolation({})).toThrow(
      /TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/,
    );
    expect(() =>
      resolveMatrixIsolation({
        DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      }),
    ).toThrow(/TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/);
    expect(() =>
      resolveMatrixIsolation({
        TEST_DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      }),
    ).toThrow(/openbot_enterprise_/);
    const { ENTERPRISE_TEST_OPERATOR_DATABASE_URL: _omit, ...missingRole } =
      CONSISTENT_FAKE_ENV;
    expect(() => resolveMatrixIsolation(missingRole)).toThrow(
      /ENTERPRISE_TEST_OPERATOR_DATABASE_URL/,
    );
  });

  test("resolves the dedicated isolation from the real environment", () => {
    const isolation = resolveMatrixIsolation(REAL_ENV, "run-mx-1");
    expect(isolation.runId).toBe("run-mx-1");
    expect(isolation.databaseName).toMatch(/^openbot_enterprise_/);
    expect(isolation.restrictedRoles).toEqual([
      "directory",
      "data",
      "operator",
    ]);
    expect(isolation.externalNamespace).toBe(
      `${MATRIX_EXTERNAL_NAMESPACE_PREFIX}_run-mx-1`,
    );
    expect(
      isolation.tempDir.startsWith(join(tmpdir(), "openbot-mt132-matrix")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

describe("matrix plan validation", () => {
  const entranceId = inventory.entrances[0].id;
  const baseRef = {
    domain: "bots",
    scenarioId: "positive",
    identity: "a1-member",
    matrixClass: "company-a-team-a1-only",
  } as const;

  test("refuses entrances absent from the inventory (the plan may not drift)", () => {
    expect(() =>
      validateMatrixPlan(
        {
          "PATCH /does/not/exist": {
            positive: baseRef,
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/MATRIX_PLAN_ENTRANCE_UNKNOWN/);
  });

  test("refuses a named entrance with a missing half (half evidence is a lie)", () => {
    expect(() =>
      validateMatrixPlan(
        { [entranceId]: { positive: baseRef, denial: undefined as never } },
        inventory,
      ),
    ).toThrow(`MATRIX_PLAN_SIDE_MISSING:${entranceId}:denial`);
  });

  test("refuses one scenario answering both sides (always-green oracle)", () => {
    expect(() =>
      validateMatrixPlan(
        { [entranceId]: { positive: baseRef, denial: baseRef } },
        inventory,
      ),
    ).toThrow(`MATRIX_PLAN_SIDES_IDENTICAL:${entranceId}:positive`);
  });

  test("refuses harness-owned control scenarios as matrix evidence", () => {
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: {
              ...baseRef,
              domain: HARNESS_CONTROL_DOMAIN,
              scenarioId: "harness.control.clean-observation",
            },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/MATRIX_PLAN_INVALID.*control domain/);
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: { ...baseRef, scenarioId: "harness.control.identity" },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/MATRIX_PLAN_INVALID.*harness-prefixed/);
  });

  test("refuses identities outside the matrix and identity/class mismatches", () => {
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: { ...baseRef, identity: "not-an-identity" as never },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/MATRIX_PLAN_INVALID.*not a matrix identity/);
    // b1-member is a cross-company identity: claiming it for the A1-only
    // class would mislabel which class the evidence exercised.
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: {
              ...baseRef,
              identity: "b1-member",
              matrixClass: "company-a-team-a1-only",
            },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/does not belong to class/);
  });

  test("refuses unknown domains, blank scenario ids and malformed requiresConfig", () => {
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: { ...baseRef, domain: "no-such-domain" as never },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/unknown domain/);
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: { ...baseRef, scenarioId: "  " },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/scenarioId required/);
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: { ...baseRef, requiresConfig: [""] },
            denial: { ...baseRef, scenarioId: "denial" },
          },
        },
        inventory,
      ),
    ).toThrow(/requiresConfig/);
  });

  test("accepts a well-formed plan for every entrance shape", () => {
    expect(() =>
      validateMatrixPlan(
        {
          [entranceId]: {
            positive: baseRef,
            denial: {
              ...baseRef,
              scenarioId: "denial",
              identity: "b1-member",
              matrixClass: "cross-company",
              requiresConfig: ["SOME_OPTIONAL_PROVIDER"],
            },
          },
        },
        inventory,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3 — per-entrance conclusions in a machine-readable report
// ---------------------------------------------------------------------------

describe("matrix coverage pipeline", () => {
  test("hard-fails on a missing environment instead of skipping", async () => {
    await expect(
      runMatrixCoverage({ environment: {}, inventory }),
    ).rejects.toThrow(/MATRIX_ENVIRONMENT_FAILED/);
    await expect(
      runMatrixCoverage({
        environment: {
          DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
        },
        inventory,
      }),
    ).rejects.toThrow(/MATRIX_ENVIRONMENT_FAILED/);
  });

  test("produces per-entrance positive/denial conclusions; a missing half is uncovered", async () => {
    const covered = inventory.entrances[0].id;
    const poisoned = inventory.entrances[1].id;
    const errored = inventory.entrances[2].id;
    registerIsolationDomain("bots", {
      run: async (scenarioId) =>
        scenarioId === "leaked" ? POISON_OBSERVATION : CLEAN_OBSERVATION,
    });
    registerIsolationDomain("conversations", {
      run: async () => {
        throw new Error("scenario does not exist");
      },
    });
    const plan: MatrixPlan = {
      [covered]: {
        positive: {
          domain: "bots",
          scenarioId: "positive",
          identity: "a1-member",
          matrixClass: "company-a-team-a1-only",
        },
        denial: {
          domain: "bots",
          scenarioId: "denial",
          identity: "b1-member",
          matrixClass: "cross-company",
        },
      },
      [poisoned]: {
        positive: {
          domain: "bots",
          scenarioId: "leaked",
          identity: "a1-member",
          matrixClass: "company-a-team-a1-only",
        },
        denial: {
          domain: "conversations",
          scenarioId: "absent",
          identity: "b1-member",
          matrixClass: "cross-company",
        },
      },
      [errored]: {
        positive: {
          domain: "conversations",
          scenarioId: "absent",
          identity: "a1-member",
          matrixClass: "company-a-team-a1-only",
        },
        denial: {
          domain: "bots",
          scenarioId: "denial",
          identity: "b1-member",
          matrixClass: "cross-company",
        },
      },
    };

    const report = await runMatrixCoverage({
      environment: REAL_ENV,
      inventory,
      plan,
    });

    // --- Machine-readable schema (AC3) -------------------------------------
    expect(report.schemaVersion).toBe(MATRIX_SCHEMA_VERSION);
    expect(MATRIX_SCHEMA_VERSION).toBe(1);
    expect(report.runner).toBe("mt132-identity-matrix");
    expect(report.inventory.digest).toBe(inventory.digest);
    expect(report.inventory.totalEntrances).toBe(inventory.entrances.length);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();

    // --- The matrix travelled with the report (AC1) ------------------------
    expect(report.matrix.complete).toBe(true);
    expect(report.matrix.classes).toHaveLength(8);
    const byClass = new Map(
      report.matrix.classes.map((entry) => [entry.id, entry]),
    );
    expect(byClass.get("company-a-team-a1-only")?.entrancesExercised).toBe(3);
    expect(byClass.get("cross-company")?.entrancesExercised).toBe(3);
    expect(byClass.get("company-a-team-a1-only")?.entrancesCovered).toBe(1);
    // Classes never cited by evidence stay visible as unexercised facts.
    expect(byClass.get("platform-operator")?.entrancesExercised).toBe(0);
    expect(report.summary.identityClassesExercised).toBe(2);
    expect(report.summary.identityClassesTotal).toBe(8);

    // --- Per-entrance conclusions (AC2) -------------------------------------
    const byId = new Map(report.entrances.map((entry) => [entry.id, entry]));
    expect(report.entrances.length).toBe(inventory.entrances.length);

    const good = byId.get(covered);
    expect(good?.status).toBe("covered");
    expect(good?.positive.status).toBe("pass");
    expect(good?.positive.identity).toBe("a1-member");
    expect(good?.positive.matrixClass).toBe("company-a-team-a1-only");
    expect(good?.denial.status).toBe("pass");
    expect(good?.denial.identity).toBe("b1-member");

    // The seeded unauthorized observation fails its side and uncovers the
    // entrance — the detector semantics are inherited from MT131.
    const bad = byId.get(poisoned);
    expect(bad?.status).toBe("uncovered");
    expect(bad?.positive.status).toBe("fail");
    expect(bad?.positive.reasons).toContain("leaked-records:1");
    expect(bad?.denial.status).toBe("scenario-error");

    const absent = byId.get(errored);
    expect(absent?.status).toBe("uncovered");
    expect(absent?.positive.status).toBe("scenario-error");

    // Every unplanned entrance is uncovered with both sides missing.
    const unplanned = report.entrances.filter((entry) => !plan[entry.id]);
    expect(unplanned.length).toBe(inventory.entrances.length - 3);
    for (const entry of unplanned) {
      expect(entry.status).toBe("uncovered");
      expect(entry.positive.status).toBe("missing");
      expect(entry.denial.status).toBe("missing");
      expect(entry.positive.reasons).toContain(
        "side-absent-from-evidence-plan",
      );
    }

    // --- Gap list (AC3: the gap list is part of the report) ------------------
    const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
    expect(gapIds.has(covered)).toBe(false);
    expect(gapIds.has(poisoned)).toBe(true);
    expect(gapIds.has(errored)).toBe(true);
    expect(report.gaps.length).toBe(inventory.entrances.length - 1);
    const poisonedGap = report.gaps.find((gap) => gap.entranceId === poisoned);
    expect(poisonedGap?.reasons).toContain("leaked-records:1");

    expect(report.summary.coveredEntrances).toBe(1);
    expect(report.summary.uncoveredEntrances).toBe(
      inventory.entrances.length - 1,
    );
    expect(report.summary.entrancesWithScenarioErrors).toBe(2);
    expect(report.overall).toBe("coverage-incomplete");

    // --- Consumption seam (AC3): a downstream ticket reads side statuses ----
    expect(matrixSideStatus(report, covered, "positive")).toBe("pass");
    expect(matrixSideStatus(report, covered, "denial")).toBe("pass");
    expect(matrixSideStatus(report, poisoned, "positive")).toBe("fail");
    expect(matrixSideStatus(report, "PATCH /does/not/exist", "positive")).toBe(
      undefined,
    );
  }, 120_000);

  test("absent provider credentials are environment gaps, never passes", async () => {
    const gapped = inventory.entrances[3].id;
    const configured = inventory.entrances[4].id;
    registerIsolationDomain("bots", {
      run: async () => CLEAN_OBSERVATION,
    });
    const plan: MatrixPlan = {
      [gapped]: {
        positive: {
          domain: "bots",
          scenarioId: "positive",
          identity: "a1-member",
          matrixClass: "company-a-team-a1-only",
        },
        denial: {
          domain: "bots",
          scenarioId: "external-denial",
          identity: "b1-member",
          matrixClass: "cross-company",
          requiresConfig: ["MT132_ABSENT_PROVIDER_TOKEN"],
        },
      },
      [configured]: {
        positive: {
          domain: "bots",
          scenarioId: "positive",
          identity: "a1-member",
          matrixClass: "company-a-team-a1-only",
        },
        denial: {
          domain: "bots",
          scenarioId: "external-denial",
          identity: "b1-member",
          matrixClass: "cross-company",
          requiresConfig: ["MT132_PRESENT_PROVIDER_TOKEN"],
        },
      },
    };
    const report = await runMatrixCoverage({
      environment: { ...REAL_ENV, MT132_PRESENT_PROVIDER_TOKEN: "present" },
      inventory,
      plan,
    });
    expect(matrixSideStatus(report, gapped, "denial")).toBe("environment-gap");
    expect(report.entrances.find((entry) => entry.id === gapped)?.status).toBe(
      "uncovered",
    );
    expect(matrixSideStatus(report, configured, "denial")).toBe("pass");
    expect(report.summary.entrancesWithEnvironmentGaps).toBe(1);
    expect(report.overall).toBe("coverage-incomplete");
  }, 120_000);

  test("uses its temp directory for run-scoped metadata", async () => {
    const report = await runMatrixCoverage({
      environment: REAL_ENV,
      inventory,
      runId: "meta-run",
    });
    const raw = await Bun.file(
      join(report.isolation.tempDir, "run-metadata.json"),
    ).text();
    const metadata = JSON.parse(raw);
    expect(metadata.runner).toBe("mt132-identity-matrix");
    expect(metadata.runId).toBe("meta-run");
    expect(raw).not.toContain("postgres://");
    expect(raw.toLowerCase()).not.toContain("password");
    await rm(report.isolation.tempDir, { recursive: true, force: true });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// AC4 — drift: new entrances are uncovered by construction
// ---------------------------------------------------------------------------

describe("matrix drift detection", () => {
  test("a brand-new inventory entrance appears in the gap list as uncovered", async () => {
    const drifted = await buildInventory({
      environment: REAL_ENV,
      mutateApp: (name, app) => {
        if (name !== "deployment-full") return;
        app.routes.push({ method: "GET", path: "/api/__mt132_new_entrance" });
      },
    });
    const probe = drifted.entrances.find(
      (entry) => entry.entrance === "GET /api/__mt132_new_entrance",
    );
    expect(probe).toBeDefined();

    const report = await runMatrixCoverage({
      environment: REAL_ENV,
      inventory: drifted,
    });
    const entry = report.entrances.find((item) => item.id === probe?.id);
    expect(entry?.status).toBe("uncovered");
    expect(entry?.positive.status).toBe("missing");
    expect(entry?.denial.status).toBe("missing");
    // The gap list names it, so the release candidate sees the drift.
    const gap = report.gaps.find((item) => item.entranceId === probe?.id);
    expect(gap?.reasons).toContain("side-absent-from-evidence-plan");
    expect(report.overall).toBe("coverage-incomplete");
  }, 120_000);

  test("a plan naming an entrance absent from the inventory is refused", async () => {
    await expect(
      runMatrixCoverage({
        environment: REAL_ENV,
        inventory,
        plan: {
          "PATCH /does/not/exist": {
            positive: {
              domain: "bots",
              scenarioId: "positive",
              identity: "a1-member",
              matrixClass: "company-a-team-a1-only",
            },
            denial: {
              domain: "bots",
              scenarioId: "denial",
              identity: "b1-member",
              matrixClass: "cross-company",
            },
          },
        },
      }),
    ).rejects.toThrow(/MATRIX_PLAN_ENTRANCE_UNKNOWN/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("identity-matrix runner CLI", () => {
  test("writes a machine-readable report and exits 0 on an honest run", async () => {
    const dir = join(tmpdir(), `mt132-cli-${Date.now()}`);
    const out = join(dir, "report.json");
    const proc = Bun.spawn(
      [
        process.execPath,
        join(
          REPO_ROOT,
          "server/scripts/multitenancy/identity-matrix-runner.ts",
        ),
        "--out",
        out,
        "--run-id",
        "cli-run",
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
    const report: MatrixCoverageReport = JSON.parse(await Bun.file(out).text());
    expect(report.schemaVersion).toBe(1);
    expect(report.runId).toBe("cli-run");
    // No plan on the CLI run: every entrance is an honest uncovered gap.
    expect(report.summary.coveredEntrances).toBe(0);
    expect(report.gaps.length).toBe(report.summary.totalEntrances);
    expect(report.overall).toBe("coverage-incomplete");
    await rm(dir, { recursive: true, force: true });
  }, 180_000);

  test("refuses CLI flags given without a value", async () => {
    for (const flag of ["--out", "--plan", "--run-id"]) {
      const proc = Bun.spawn(
        [
          process.execPath,
          join(
            REPO_ROOT,
            "server/scripts/multitenancy/identity-matrix-runner.ts",
          ),
          flag,
        ],
        { cwd: REPO_ROOT, env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      expect(code).toBe(1);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toMatch(/MATRIX_FLAG_MISSING_VALUE/);
    }
  }, 60_000);

  test("exits 1 with an explicit message when the environment is missing", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(
          REPO_ROOT,
          "server/scripts/multitenancy/identity-matrix-runner.ts",
        ),
      ],
      { cwd: REPO_ROOT, env: {}, stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toMatch(/MATRIX_RUN_FAILED/);
    expect(stderr).toMatch(
      /TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL/,
    );
  }, 60_000);
});
