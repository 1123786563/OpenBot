/**
 * MT131 / Issue #174 — the multitenancy acceptance harness.
 *
 * A directly runnable harness that lives strictly inside its own test
 * environment: URLs come only from the enterprise test variables (validated by
 * the shared MT002-lineage validators — there is no path to a development
 * database), the loopback HTTP port 45435 is dedicated to this harness, and
 * every external/temp name is namespaced `issue6_mt131_<run-id>`.
 *
 * Before any evidence is accepted the harness proves itself: it seeds an
 * intentionally unauthorized observation (the positive control claims success
 * while an unauthorized result leaked a record) through the real scenario
 * registry and verifies its own detector catches it on both sides. Only when
 * the poison is detected and the real environment checks (through the real
 * MT002 fixture seam) pass does the harness evaluate per-entrance evidence.
 *
 * Coverage semantics (Spec §11 / ADR 0004): only enumerated `entrances` from
 * the MT001 inventory are route surfaces. An entrance is `covered` only when
 * BOTH its positive and denial evidence pass. A missing half, an absent
 * scenario, an absent provider credential, or a brand-new inventory entrance
 * is `uncovered` — never a synthetic pass. `serviceSurfaces` never count as
 * route coverage; unassembled / not_enumerated surfaces stay uncovered.
 *
 * CLI (run from the repository root, dedicated environment sourced first):
 *   bun server/scripts/multitenancy/acceptance-harness.ts [--pretty]
 *        [--out <report.json>] [--evidence <plan.json>] [--run-id <id>]
 * Exit 0 = the harness ran honestly and produced a trustworthy report (the
 * report's `overall` field states acceptance); exit 1 = the harness could not
 * run or could not trust itself (missing environment, unavailable port,
 * occupied control domain, failed self-check, invalid evidence plan).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createIsolationFixture,
  type IsolationFixture,
  RESTRICTED_ROLES,
} from "../../tests/multitenancy/support/fixture";
import {
  type DomainScenarioAdapter,
  ISOLATION_DOMAINS,
  type IsolationDomain,
  type IsolationObservation,
  registeredIsolationDomains,
  registerIsolationDomain,
  runIsolationScenario,
} from "../../tests/multitenancy/support/scenarios";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseNameFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../tests/support/enterprise-database";
import { buildInventory, type CoverageInventory } from "./inventory";

// ---------------------------------------------------------------------------
// Harness constants
// ---------------------------------------------------------------------------

/** The only loopback HTTP port this harness ever binds. */
export const HARNESS_HTTP_PORT = 45435;
/** Every external/temp name this run creates starts with this prefix. */
export const HARNESS_EXTERNAL_NAMESPACE_PREFIX = "issue6_mt131";
/** Machine-readable report schema. */
export const HARNESS_SCHEMA_VERSION = 1;
/** The scenario-registry domain this harness owns for its own controls. */
export const HARNESS_CONTROL_DOMAIN: IsolationDomain = "full-coverage";

/** Scenario ids of the harness-owned control adapter. */
export const HARNESS_CONTROL_SCENARIOS = {
  identity: "harness.control.identity",
  poison: "harness.poison.unauthorized-success",
  clean: "harness.control.clean-observation",
  environmentPositive: "harness.environment.positive-control",
  environmentDenial: "harness.environment.cross-tenant-denial",
} as const;

// ---------------------------------------------------------------------------
// Isolation resolution
// ---------------------------------------------------------------------------

/** Where the harness runs: every value is dedicated, loopback, run-scoped. */
export interface HarnessIsolation {
  runId: string;
  /** Which environment variable supplied the setup URL (never DATABASE_URL). */
  setupUrlVariable: "ENTERPRISE_TEST_SETUP_DATABASE_URL" | "TEST_DATABASE_URL";
  databaseName: string;
  databaseHost: string;
  databasePort: number;
  restrictedRoles: readonly string[];
  httpHostname: "127.0.0.1";
  httpPort: number;
  externalNamespace: string;
  tempDir: string;
  loopbackOnly: boolean;
}

function generateRunId(): string {
  return `r${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Resolves (and refuses) the harness environment before anything connects.
 * Refusal semantics come from the shared enterprise validators: a missing
 * TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL, a development
 * database name, a non-loopback host, or a missing/mispointed restricted role
 * URL is an explicit failure. DATABASE_URL is never consulted.
 */
export function resolveHarnessIsolation(
  environment: Record<string, string | undefined>,
  runIdInput?: string,
): HarnessIsolation {
  const runId = runIdInput ?? generateRunId();
  if (!/^[a-z0-9-]{1,64}$/.test(runId)) {
    throw new Error(`HARNESS_RUN_ID_INVALID:${runId}`);
  }
  const setupUrlRaw = enterpriseTestDatabaseUrlFrom(environment);
  for (const role of RESTRICTED_ROLES) {
    enterpriseRuntimeDatabaseUrlFrom(role, environment);
  }
  const setupUrl = new URL(setupUrlRaw);
  return {
    runId,
    setupUrlVariable: enterpriseSetupDatabaseVariable(environment),
    databaseName: enterpriseTestDatabaseNameFrom(setupUrlRaw),
    databaseHost: setupUrl.hostname,
    databasePort: Number(setupUrl.port || 5432),
    restrictedRoles: [...RESTRICTED_ROLES],
    httpHostname: "127.0.0.1",
    httpPort: HARNESS_HTTP_PORT,
    externalNamespace: `${HARNESS_EXTERNAL_NAMESPACE_PREFIX}_${runId}`,
    tempDir: join(tmpdir(), "openbot-mt131-harness", runId),
    loopbackOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Loopback HTTP status endpoint
// ---------------------------------------------------------------------------

/** The harness-local status server bound to 127.0.0.1:45435. */
export interface HarnessHttpStatusServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Binds the dedicated loopback port exclusively. A second bind while the port
 * is held fails with HARNESS_PORT_UNAVAILABLE — the port is never shared with
 * any development service.
 */
export async function startHarnessHttpStatus(
  runId: string,
): Promise<HarnessHttpStatusServer> {
  const status = () =>
    new Response(
      JSON.stringify({
        harness: "mt131-acceptance",
        runId,
        httpPort: HARNESS_HTTP_PORT,
      }),
      { headers: { "content-type": "application/json" } },
    );
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: HARNESS_HTTP_PORT,
      fetch: () => status(),
    });
  } catch (error) {
    throw new Error(
      `HARNESS_PORT_UNAVAILABLE:${HARNESS_HTTP_PORT}:${messageOf(error)}`,
    );
  }
  return {
    port: server.port ?? HARNESS_HTTP_PORT,
    url: `http://127.0.0.1:${server.port}/`,
    close: async () => {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// The unauthorized-result detector
// ---------------------------------------------------------------------------

export type EvidenceSide = "positive" | "denial";

/** A detector verdict with machine-readable reasons. */
export interface ObservationVerdict {
  verdict: "pass" | "fail";
  reasons: string[];
}

/**
 * Evaluates one observation fact for one side. The positive side passes only
 * when the positive control passed and nothing leaked; the denial side passes
 * only when access was denied and nothing leaked. Any leaked record or
 * forbidden effect fails either side.
 */
export function evaluateObservationSide(
  observation: IsolationObservation,
  side: EvidenceSide,
): ObservationVerdict {
  const reasons: string[] = [];
  if (side === "positive") {
    if (!observation.positiveControlPassed) {
      reasons.push("positive-control-failed");
    }
  } else if (!observation.denied) {
    reasons.push("denied:false");
  }
  if (observation.leakedRecords.length > 0) {
    reasons.push(`leaked-records:${observation.leakedRecords.length}`);
  }
  if (observation.forbiddenEffects.length > 0) {
    reasons.push(`forbidden-effects:${observation.forbiddenEffects.length}`);
  }
  return reasons.length === 0
    ? { verdict: "pass", reasons }
    : { verdict: "fail", reasons };
}

// ---------------------------------------------------------------------------
// Harness-owned control adapter (registered on the "full-coverage" domain)
// ---------------------------------------------------------------------------

/**
 * The observation the identity probe answers with. Only the harness's own
 * adapter produces this exact shape; anything else squatting on the control
 * domain is refused with HARNESS_CONTROL_DOMAIN_OCCUPIED.
 */
const CONTROL_IDENTITY_OBSERVATION: IsolationObservation = {
  positiveControlPassed: true,
  denied: true,
  leakedRecords: [{ harness: "mt131-full-coverage-control" }],
  forbiddenEffects: [],
};

/**
 * The seeded unauthorized result: the positive control claims success while an
 * unauthorized request leaked a record. This is the poison the harness must
 * detect on both sides before accepting any evidence.
 */
const SEEDED_POISON_OBSERVATION: IsolationObservation = {
  positiveControlPassed: true,
  denied: false,
  leakedRecords: [
    { seeded: "mt131-unauthorized-result", note: "intentional poison" },
  ],
  forbiddenEffects: [],
};

const CLEAN_CONTROL_OBSERVATION: IsolationObservation = {
  positiveControlPassed: true,
  denied: true,
  leakedRecords: [],
  forbiddenEffects: [],
};

/** Handle for the harness-owned adapter plus its fixture lifecycle. */
export interface HarnessControl {
  adapter: DomainScenarioAdapter;
  dispose(): Promise<void>;
}

/**
 * Creates the harness control adapter. Environment checks run for real through
 * the exact MT002 seam (`createIsolationFixture`) against the dedicated test
 * database; nothing is mocked.
 */
export function createHarnessControl(
  environment: Record<string, string | undefined>,
): HarnessControl {
  let fixturePromise: Promise<IsolationFixture> | undefined;
  const fixture = () =>
    (fixturePromise ??= createIsolationFixture(HARNESS_CONTROL_DOMAIN, {
      environment,
    }));
  return {
    adapter: {
      async run(scenarioId: string): Promise<IsolationObservation> {
        switch (scenarioId) {
          case HARNESS_CONTROL_SCENARIOS.identity:
            return CONTROL_IDENTITY_OBSERVATION;
          case HARNESS_CONTROL_SCENARIOS.poison:
            return SEEDED_POISON_OBSERVATION;
          case HARNESS_CONTROL_SCENARIOS.clean:
            return CLEAN_CONTROL_OBSERVATION;
          case HARNESS_CONTROL_SCENARIOS.environmentPositive: {
            const live = await fixture();
            const response = await live.requestAs("a1-member", {
              method: "GET",
              path: `/resources/${live.ids["resource-a1"]}`,
              tenantId: live.ids["company-a"],
              workspaceId: live.ids["team-a1"],
            });
            return {
              positiveControlPassed: response.status === 200,
              denied: false,
              leakedRecords: [],
              forbiddenEffects: [],
            };
          }
          case HARNESS_CONTROL_SCENARIOS.environmentDenial: {
            const live = await fixture();
            // A2 member reading team A1's resource is unauthorized.
            const response = await live.requestAs("a2-member", {
              method: "GET",
              path: `/resources/${live.ids["resource-a1"]}`,
              tenantId: live.ids["company-a"],
              workspaceId: live.ids["team-a1"],
            });
            const denied = [401, 403, 404].includes(response.status);
            const leaked = denied
              ? []
              : [
                  await response
                    .json()
                    .catch(() => ({ status: response.status })),
                ];
            return {
              positiveControlPassed: false,
              denied,
              leakedRecords: leaked,
              forbiddenEffects: [],
            };
          }
          default:
            throw new Error(`HARNESS_CONTROL_SCENARIO_UNKNOWN:${scenarioId}`);
        }
      },
    },
    async dispose() {
      const pending = fixturePromise;
      fixturePromise = undefined;
      try {
        await (await pending)?.dispose();
      } catch {
        // createIsolationFixture already cleans up its own partial state;
        // dispose failures here cannot invalidate the produced evidence.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence plan
// ---------------------------------------------------------------------------

/** Where one side's evidence comes from; `requiresConfig` names provider
 * credentials that must exist for the scenario to be real. */
export interface EvidenceRef {
  domain: IsolationDomain;
  scenarioId: string;
  requiresConfig?: readonly string[];
}

/** Per-entrance evidence: both sides are required for coverage. */
export interface EntranceEvidence {
  positive?: EvidenceRef;
  denial?: EvidenceRef;
}

/** Entrance id (exact "METHOD path") -> required evidence. */
export type EvidencePlan = Readonly<Record<string, EntranceEvidence>>;

function validateEvidencePlan(
  plan: EvidencePlan,
  inventory: CoverageInventory,
): void {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("HARNESS_EVIDENCE_PLAN_INVALID:not an object");
  }
  const known = new Set(inventory.entrances.map((entry) => entry.id));
  const unknown: string[] = [];
  for (const [entranceId, evidence] of Object.entries(plan)) {
    if (!known.has(entranceId)) {
      unknown.push(entranceId);
    }
    for (const side of ["positive", "denial"] as const) {
      const ref = evidence?.[side];
      if (!ref) continue;
      if (!(ISOLATION_DOMAINS as readonly string[]).includes(ref.domain)) {
        throw new Error(
          `HARNESS_EVIDENCE_PLAN_INVALID:${entranceId}:${side}:unknown domain ${String(ref.domain)}`,
        );
      }
      if (typeof ref.scenarioId !== "string" || !ref.scenarioId.trim()) {
        throw new Error(
          `HARNESS_EVIDENCE_PLAN_INVALID:${entranceId}:${side}:scenarioId required`,
        );
      }
      if (
        ref.requiresConfig !== undefined &&
        (!Array.isArray(ref.requiresConfig) ||
          ref.requiresConfig.some(
            (key) => typeof key !== "string" || !key.trim(),
          ))
      ) {
        throw new Error(
          `HARNESS_EVIDENCE_PLAN_INVALID:${entranceId}:${side}:requiresConfig must be non-empty strings`,
        );
      }
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `HARNESS_EVIDENCE_PLAN_ENTRANCE_UNKNOWN:${[...unknown].sort().join(",")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type SideStatus =
  | "pass"
  | "fail"
  | "missing"
  | "scenario-error"
  | "environment-gap";

/** One side's evidence result for one entrance. */
export interface SideResult {
  status: SideStatus;
  domain?: string;
  scenarioId?: string;
  reasons: string[];
}

/** Per-entrance coverage result. */
export interface EntranceCoverageResult {
  id: string;
  entrance: string;
  method: string;
  path: string;
  kind: string;
  type: string;
  businessClosure: string;
  ownerTicket: string | null;
  positive: SideResult;
  denial: SideResult;
  status: "covered" | "uncovered";
}

/** Service surfaces are listed for honesty and never count as route coverage. */
export interface ServiceSurfaceCoverage {
  id: string;
  name: string;
  businessClosure: string;
  ownerTicket: string | null;
  assemblyStatus: string;
  routeEnumeration: string;
  status: "uncovered";
  countsAsRouteCoverage: false;
  reason: string;
}

/** One absent provider credential that blocked a side. */
export interface EnvironmentGap {
  entranceId: string;
  side: EvidenceSide;
  missingConfigKeys: string[];
}

/** One self-check executed before any evidence was accepted. */
export interface PositiveControlCheck {
  id: string;
  expected: string;
  actual: string;
  status: "pass" | "fail";
  reasons: string[];
}

/** The machine-readable acceptance report (see docs report for the schema). */
export interface HarnessReport {
  schemaVersion: number;
  harness: "mt131-acceptance";
  generatedAt: string;
  runId: string;
  isolation: HarnessIsolation;
  inventory: {
    schemaVersion: number;
    digest: string;
    generatedAt: string;
    /** Which stages ran when the consumed inventory was built (digest provenance). */
    stages: Array<{ stage: string; status: string }>;
    totalEntrances: number;
    routeEntrances: number;
    catchallEntrances: number;
    serveUpgradeEntrances: number;
  };
  positiveControl: {
    status: "passed";
    checks: PositiveControlCheck[];
    seedPoison: {
      scenarioId: string;
      detected: boolean;
      reasons: string[];
    };
  };
  entrances: EntranceCoverageResult[];
  serviceSurfaces: ServiceSurfaceCoverage[];
  environmentGaps: EnvironmentGap[];
  summary: {
    totalEntrances: number;
    coveredEntrances: number;
    uncoveredEntrances: number;
    entrancesWithMissingPositive: number;
    entrancesWithMissingDenial: number;
    entrancesWithFailedSides: number;
    entrancesWithScenarioErrors: number;
    entrancesWithEnvironmentGaps: number;
    serviceSurfacesListed: number;
    serviceSurfacesCountingAsRouteCoverage: 0;
  };
  overall: "acceptance-passed" | "acceptance-not-passed";
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Options for `runAcceptanceHarness`. `inventory`/`evaluator` are seams for
 * verifying the harness itself; production runs omit them. */
export interface RunHarnessOptions {
  environment?: Record<string, string | undefined>;
  evidencePlan?: EvidencePlan;
  /** Prebuilt inventory (the CLI always builds a fresh one). */
  inventory?: CoverageInventory;
  runId?: string;
  now?: () => Date;
  /** Detector override — used only by the harness's own self-verification. */
  evaluator?: typeof evaluateObservationSide;
}

async function runPositiveControl(
  control: HarnessControl,
  evaluator: typeof evaluateObservationSide,
): Promise<HarnessReport["positiveControl"]> {
  if (!registeredIsolationDomains().includes(HARNESS_CONTROL_DOMAIN)) {
    registerIsolationDomain(HARNESS_CONTROL_DOMAIN, control.adapter);
  }
  let probe: IsolationObservation;
  try {
    probe = await runIsolationScenario(
      HARNESS_CONTROL_DOMAIN,
      HARNESS_CONTROL_SCENARIOS.identity,
    );
  } catch (error) {
    throw new Error(
      `HARNESS_CONTROL_DOMAIN_OCCUPIED:${HARNESS_CONTROL_DOMAIN}:${messageOf(error)}`,
    );
  }
  if (JSON.stringify(probe) !== JSON.stringify(CONTROL_IDENTITY_OBSERVATION)) {
    throw new Error(
      `HARNESS_CONTROL_DOMAIN_OCCUPIED:${HARNESS_CONTROL_DOMAIN}:identity probe mismatch`,
    );
  }

  const checks: PositiveControlCheck[] = [];

  // 1. The seeded unauthorized observation must be detected on both sides.
  const poison = await runIsolationScenario(
    HARNESS_CONTROL_DOMAIN,
    HARNESS_CONTROL_SCENARIOS.poison,
  );
  const poisonPositive = evaluator(poison, "positive");
  const poisonDenial = evaluator(poison, "denial");
  const poisonDetected =
    poisonPositive.verdict === "fail" && poisonDenial.verdict === "fail";
  checks.push({
    id: "poison-unauthorized-success",
    expected: "detected",
    actual: poisonDetected ? "detected" : "undetected",
    status: poisonDetected ? "pass" : "fail",
    reasons: [...new Set([...poisonPositive.reasons, ...poisonDenial.reasons])],
  });

  // 2. The clean observation must pass both sides (the detector is not
  //    merely rejecting everything).
  const clean = await runIsolationScenario(
    HARNESS_CONTROL_DOMAIN,
    HARNESS_CONTROL_SCENARIOS.clean,
  );
  const cleanPositive = evaluator(clean, "positive");
  const cleanDenial = evaluator(clean, "denial");
  const cleanPassed =
    cleanPositive.verdict === "pass" && cleanDenial.verdict === "pass";
  checks.push({
    id: "clean-observation",
    expected: "pass",
    actual: cleanPassed ? "pass" : "fail",
    status: cleanPassed ? "pass" : "fail",
    reasons: [...new Set([...cleanPositive.reasons, ...cleanDenial.reasons])],
  });

  // 3./4. The real environment, through the real MT002 fixture seam: a
  // legitimate read works and a cross-team read is denied without leaks.
  const environmentPositive = await runIsolationScenario(
    HARNESS_CONTROL_DOMAIN,
    HARNESS_CONTROL_SCENARIOS.environmentPositive,
  );
  const environmentPositiveVerdict = evaluator(environmentPositive, "positive");
  checks.push({
    id: "environment-positive-control",
    expected: "pass",
    actual: environmentPositiveVerdict.verdict,
    status: environmentPositiveVerdict.verdict === "pass" ? "pass" : "fail",
    reasons: environmentPositiveVerdict.reasons,
  });
  const environmentDenial = await runIsolationScenario(
    HARNESS_CONTROL_DOMAIN,
    HARNESS_CONTROL_SCENARIOS.environmentDenial,
  );
  const environmentDenialVerdict = evaluator(environmentDenial, "denial");
  checks.push({
    id: "environment-cross-tenant-denial",
    expected: "pass",
    actual: environmentDenialVerdict.verdict,
    status: environmentDenialVerdict.verdict === "pass" ? "pass" : "fail",
    reasons: environmentDenialVerdict.reasons,
  });

  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    // Abort before any evidence is collected: a harness that cannot catch an
    // intentionally injected unauthorized result must not produce evidence.
    throw new Error(
      `HARNESS_SELF_CHECK_FAILED:${JSON.stringify(
        failed.map((check) => ({ id: check.id, actual: check.actual })),
      )}`,
    );
  }
  return {
    status: "passed",
    checks,
    seedPoison: {
      scenarioId: HARNESS_CONTROL_SCENARIOS.poison,
      detected: poisonDetected,
      reasons: checks[0].reasons,
    },
  };
}

async function collectEntranceCoverage(
  inventory: CoverageInventory,
  plan: EvidencePlan,
  environment: Record<string, string | undefined>,
  evaluator: typeof evaluateObservationSide,
): Promise<{
  entrances: EntranceCoverageResult[];
  environmentGaps: EnvironmentGap[];
}> {
  const entrances: EntranceCoverageResult[] = [];
  const environmentGaps: EnvironmentGap[] = [];
  for (const entry of inventory.entrances) {
    const planned = plan[entry.id];
    const sides: Record<EvidenceSide, SideResult> = {
      positive: {
        status: "missing",
        reasons: ["side-absent-from-evidence-plan"],
      },
      denial: {
        status: "missing",
        reasons: ["side-absent-from-evidence-plan"],
      },
    };
    for (const side of ["positive", "denial"] as const) {
      const ref = planned?.[side];
      if (!ref) continue;
      const missingConfigKeys = (ref.requiresConfig ?? []).filter(
        (key) => !environment[key]?.trim(),
      );
      if (missingConfigKeys.length > 0) {
        sides[side] = {
          status: "environment-gap",
          domain: ref.domain,
          scenarioId: ref.scenarioId,
          reasons: missingConfigKeys.map((key) => `missing-config:${key}`),
        };
        environmentGaps.push({
          entranceId: entry.id,
          side,
          missingConfigKeys,
        });
        continue;
      }
      try {
        const observation = await runIsolationScenario(
          ref.domain,
          ref.scenarioId,
        );
        const verdict = evaluator(observation, side);
        sides[side] = {
          status: verdict.verdict,
          domain: ref.domain,
          scenarioId: ref.scenarioId,
          reasons: verdict.reasons,
        };
      } catch (error) {
        // Unregistered domains, absent scenarios, adapter failures and
        // skip-shaped results are uncovered facts — never synthetic passes.
        sides[side] = {
          status: "scenario-error",
          domain: ref.domain,
          scenarioId: ref.scenarioId,
          reasons: [messageOf(error)],
        };
      }
    }
    entrances.push({
      id: entry.id,
      entrance: entry.entrance,
      method: entry.method,
      path: entry.path,
      kind: entry.kind,
      type: entry.type,
      businessClosure: entry.businessClosure,
      ownerTicket: entry.ownerTicket,
      positive: sides.positive,
      denial: sides.denial,
      status:
        sides.positive.status === "pass" && sides.denial.status === "pass"
          ? "covered"
          : "uncovered",
    });
  }
  return { entrances, environmentGaps };
}

function mapServiceSurfaces(
  inventory: CoverageInventory,
): ServiceSurfaceCoverage[] {
  return inventory.serviceSurfaces.map((surface) => ({
    id: surface.id,
    name: surface.name,
    businessClosure: surface.businessClosure,
    ownerTicket: surface.ownerTicket,
    assemblyStatus: surface.assemblyStatus,
    routeEnumeration: surface.routeEnumeration,
    status: "uncovered",
    countsAsRouteCoverage: false,
    reason:
      surface.routeEnumeration === "not_enumerated"
        ? "route-enumeration:not_enumerated"
        : surface.assemblyStatus === "unassembled"
          ? "assembly:unassembled"
          : "service-surface-is-not-a-route-surface",
  }));
}

/**
 * Runs the whole acceptance pipeline: resolve the isolated environment, prove
 * the port, validate the evidence plan, run the self-proof, then evaluate
 * per-entrance evidence and return the machine-readable report.
 */
export async function runAcceptanceHarness(
  options: RunHarnessOptions = {},
): Promise<HarnessReport> {
  const environment = options.environment ?? process.env;
  const runId = options.runId ?? generateRunId();

  let isolation: HarnessIsolation;
  try {
    isolation = resolveHarnessIsolation(environment, runId);
  } catch (error) {
    throw new Error(`HARNESS_ENVIRONMENT_FAILED:${messageOf(error)}`);
  }
  await mkdir(isolation.tempDir, { recursive: true });

  const inventory: CoverageInventory =
    options.inventory ?? (await buildInventory({ environment }));
  const evidencePlan = options.evidencePlan ?? {};
  validateEvidencePlan(evidencePlan, inventory);
  const evaluator = options.evaluator ?? evaluateObservationSide;

  const statusServer = await startHarnessHttpStatus(runId);
  const control = createHarnessControl(environment);
  try {
    const positiveControl = await runPositiveControl(control, evaluator);
    const { entrances, environmentGaps } = await collectEntranceCoverage(
      inventory,
      evidencePlan,
      environment,
      evaluator,
    );
    const serviceSurfaces = mapServiceSurfaces(inventory);
    const coveredEntrances = entrances.filter(
      (entry) => entry.status === "covered",
    ).length;
    const countWhere = (
      predicate: (entry: EntranceCoverageResult) => boolean,
    ) => entrances.filter(predicate).length;
    const report: HarnessReport = {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      harness: "mt131-acceptance",
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      runId,
      isolation,
      inventory: {
        schemaVersion: inventory.schemaVersion,
        digest: inventory.digest,
        generatedAt: inventory.generatedAt,
        stages: inventory.stages.map((stage) => ({
          stage: stage.stage,
          status: stage.status,
        })),
        totalEntrances: entrances.length,
        routeEntrances: entrances.filter((entry) => entry.kind === "route")
          .length,
        catchallEntrances: entrances.filter(
          (entry) => entry.kind === "catchall",
        ).length,
        serveUpgradeEntrances: entrances.filter(
          (entry) => entry.kind === "serve-upgrade",
        ).length,
      },
      positiveControl,
      entrances,
      serviceSurfaces,
      environmentGaps,
      summary: {
        totalEntrances: entrances.length,
        coveredEntrances,
        uncoveredEntrances: entrances.length - coveredEntrances,
        entrancesWithMissingPositive: countWhere(
          (entry) => entry.positive.status === "missing",
        ),
        entrancesWithMissingDenial: countWhere(
          (entry) => entry.denial.status === "missing",
        ),
        entrancesWithFailedSides: countWhere(
          (entry) =>
            entry.positive.status === "fail" || entry.denial.status === "fail",
        ),
        entrancesWithScenarioErrors: countWhere(
          (entry) =>
            entry.positive.status === "scenario-error" ||
            entry.denial.status === "scenario-error",
        ),
        entrancesWithEnvironmentGaps: new Set(
          environmentGaps.map((gap) => gap.entranceId),
        ).size,
        serviceSurfacesListed: serviceSurfaces.length,
        serviceSurfacesCountingAsRouteCoverage: 0,
      },
      overall:
        coveredEntrances === entrances.length && environmentGaps.length === 0
          ? "acceptance-passed"
          : "acceptance-not-passed",
    };
    return report;
  } finally {
    await control.dispose();
    await statusServer.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  out?: string;
  pretty: boolean;
  evidence?: string;
  runId?: string;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pretty") flags.pretty = true;
    else if (arg === "--out") {
      index += 1;
      flags.out = argv[index];
    } else if (arg === "--evidence") {
      index += 1;
      flags.evidence = argv[index];
    } else if (arg === "--run-id") {
      index += 1;
      flags.runId = argv[index];
    } else {
      throw new Error(`HARNESS_FLAG_UNKNOWN:${arg}`);
    }
  }
  return flags;
}

/** Keeps stdout pure for the JSON report by replaying noisy module output. */
async function withCleanStdout<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = original;
    for (const chunk of captured) process.stderr.write(chunk);
  }
}

async function main(): Promise<void> {
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
  const flags = parseFlags(process.argv.slice(2));
  let evidencePlan: EvidencePlan = {};
  if (flags.evidence) {
    try {
      evidencePlan = JSON.parse(readFileSync(flags.evidence, "utf8"));
    } catch (error) {
      throw new Error(
        `HARNESS_EVIDENCE_PLAN_UNREADABLE:${flags.evidence}:${messageOf(error)}`,
      );
    }
  }
  const report = await withCleanStdout(() =>
    runAcceptanceHarness({ evidencePlan, runId: flags.runId }),
  );
  const json = JSON.stringify(report, null, flags.pretty ? 2 : undefined);
  if (flags.out) {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, `${json}\n`);
    process.stderr.write(`report written: ${flags.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.stderr.write(
    `mt131 harness ${report.overall}: covered ${report.summary.coveredEntrances}/${report.summary.totalEntrances} entrances; self-check ${report.positiveControl.status}; environment gaps ${report.environmentGaps.length}\n`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`HARNESS_RUN_FAILED:${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
