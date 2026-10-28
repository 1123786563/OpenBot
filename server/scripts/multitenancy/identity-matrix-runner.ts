/**
 * MT132 / Issue #175 — the identity-matrix runner.
 *
 * Runs the Spec §11 minimum identity matrix (the eight classes the MT002
 * fixture materializes) against the REAL registered-entrance inventory and
 * emits a machine-readable per-entrance coverage status plus a gap list.
 *
 * Layering (MT131 first, this second): the harness proved the environment,
 * the detector and the coverage semantics. This runner adds the identity
 * dimension. Every evidence reference names the matrix identity the case
 * runs as and which of the eight Spec classes that identity represents, so
 * the report can state not only "is this entrance covered" but "which
 * identity classes the evidence actually exercised".
 *
 * Coverage semantics are inherited verbatim from the harness: an entrance is
 * `covered` only when BOTH its positive and its denial evidence pass; a
 * missing half, an absent scenario, an absent provider credential or a
 * brand-new inventory entrance is `uncovered` — never a synthetic pass. An
 * entrance named in the plan MUST carry both sides: citing half an evidence
 * pair is refused outright (MATRIX_PLAN_SIDE_MISSING) instead of being
 * quietly degraded to uncovered. The two sides must be distinct cases — the
 * same scenario answering both sides would be an always-green oracle.
 *
 * CLI (run from the repository root, dedicated environment sourced first;
 * adapters must be registered beside the domains they cover — see the
 * coverage-evidence suites):
 *   bun server/scripts/multitenancy/identity-matrix-runner.ts [--pretty]
 *        [--out <report.json>] [--plan <plan.json>] [--run-id <id>]
 * Exit 0 = the runner ran honestly and produced a trustworthy report (the
 * report's `overall` field states acceptance); exit 1 = the runner could not
 * run or could not trust itself.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FIXTURE_IDENTITIES,
  type FixtureIdentity,
  RESTRICTED_ROLES,
  SPEC_IDENTITY_MATRIX,
} from "../../tests/multitenancy/support/fixture";
import {
  ISOLATION_DOMAINS,
  type IsolationDomain,
  runIsolationScenario,
} from "../../tests/multitenancy/support/scenarios";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseNameFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../tests/support/enterprise-database";
import {
  type EvidenceSide,
  evaluateObservationSide,
  HARNESS_CONTROL_DOMAIN,
  type SideResult,
  type SideStatus,
} from "./acceptance-harness";
import { buildInventory, type CoverageInventory } from "./inventory";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Machine-readable report schema. */
export const MATRIX_SCHEMA_VERSION = 1;
/** Every external/temp name this run creates starts with this prefix. */
export const MATRIX_EXTERNAL_NAMESPACE_PREFIX = "issue6_mt132";

/** The eight Spec §11 classes, in Spec order, with their fixture identities. */
export const IDENTITY_MATRIX_CLASSES = [
  {
    id: "company-a-team-a1-only",
    label: "仅属甲（公司 A 团队 A1 唯一成员）",
  },
  {
    id: "company-a-team-a2-only",
    label: "仅属乙（公司 A 团队 A2 唯一成员）",
  },
  {
    id: "company-a-both-teams",
    label: "甲乙双成员（公司 A 两团队同属）",
  },
  { id: "same-team-other-person", label: "同团队另一人" },
  { id: "cross-company", label: "跨公司用户" },
  { id: "company-admin", label: "公司管理员" },
  { id: "platform-operator", label: "平台操作身份" },
  { id: "restricted-worker", label: "受限 Worker 身份" },
] as const satisfies ReadonlyArray<{
  id: keyof typeof SPEC_IDENTITY_MATRIX;
  label: string;
}>;

export type IdentityMatrixClassId =
  (typeof IDENTITY_MATRIX_CLASSES)[number]["id"];

const CLASS_IDS: readonly IdentityMatrixClassId[] = IDENTITY_MATRIX_CLASSES.map(
  (entry) => entry.id,
);
const CLASS_LABELS: Readonly<Record<IdentityMatrixClassId, string>> =
  Object.fromEntries(
    IDENTITY_MATRIX_CLASSES.map((entry) => [entry.id, entry.label]),
  ) as Record<IdentityMatrixClassId, string>;

/**
 * Validates the fixed matrix against the Spec's own eight classes and the
 * MT002 fixture identities. The matrix is code, but a drifted matrix must be
 * a loud failure, not a silent coverage hole: every class must be non-empty,
 * every fixture identity must sit in some class, and no unknown class may
 * appear.
 */
export function validateIdentityMatrix(): void {
  const specClasses = Object.keys(SPEC_IDENTITY_MATRIX);
  const unknown = specClasses.filter(
    (id) => !CLASS_IDS.includes(id as IdentityMatrixClassId),
  );
  if (unknown.length > 0) {
    throw new Error(`MATRIX_INVALID:unknown-spec-classes:${unknown.join(",")}`);
  }
  const missing = CLASS_IDS.filter((id) => {
    const identities = SPEC_IDENTITY_MATRIX[id];
    return (
      !identities ||
      identities.length === 0 ||
      identities.some((identity) => !FIXTURE_IDENTITIES.includes(identity))
    );
  });
  if (missing.length > 0) {
    throw new Error(
      `MATRIX_INVALID:class-empty-or-unknown-identity:${missing.join(",")}`,
    );
  }
  const exercised = new Set(
    CLASS_IDS.flatMap((id) => [...SPEC_IDENTITY_MATRIX[id]]),
  );
  const uncovered = FIXTURE_IDENTITIES.filter(
    (identity) => !exercised.has(identity),
  );
  if (uncovered.length > 0) {
    throw new Error(
      `MATRIX_INVALID:fixture-identity-in-no-class:${uncovered.join(",")}`,
    );
  }
}

/** The class an identity belongs to (an identity may sit in one class only). */
export function matrixClassOf(
  identity: FixtureIdentity,
): IdentityMatrixClassId {
  for (const id of CLASS_IDS) {
    if (SPEC_IDENTITY_MATRIX[id].includes(identity)) return id;
  }
  throw new Error(`MATRIX_IDENTITY_UNCLASSED:${identity}`);
}

// ---------------------------------------------------------------------------
// Matrix evidence plan
// ---------------------------------------------------------------------------

/** Where one side's evidence comes from, pinned to a matrix identity. */
export interface MatrixEvidenceRef {
  domain: IsolationDomain;
  scenarioId: string;
  /** The matrix identity this case executes as. */
  identity: FixtureIdentity;
  /** Which of the eight Spec classes that identity represents here. */
  matrixClass: IdentityMatrixClassId;
  /** Provider credentials that must exist for the scenario to be real. */
  requiresConfig?: readonly string[];
}

/** Per-entrance matrix evidence: both sides are mandatory. */
export interface MatrixEntrancePlan {
  positive: MatrixEvidenceRef;
  denial: MatrixEvidenceRef;
}

/** Entrance id (exact "METHOD path") -> required matrix evidence. */
export type MatrixPlan = Readonly<Record<string, MatrixEntrancePlan>>;

function validateMatrixRef(
  entranceId: string,
  side: EvidenceSide,
  ref: unknown,
): asserts ref is MatrixEvidenceRef {
  if (!ref || typeof ref !== "object") {
    throw new Error(`MATRIX_PLAN_INVALID:${entranceId}:${side}:not an object`);
  }
  const candidate = ref as Partial<MatrixEvidenceRef>;
  if (
    !(ISOLATION_DOMAINS as readonly string[]).includes(String(candidate.domain))
  ) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:unknown domain ${String(candidate.domain)}`,
    );
  }
  if (
    typeof candidate.scenarioId !== "string" ||
    !candidate.scenarioId.trim()
  ) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:scenarioId required`,
    );
  }
  if (candidate.domain === HARNESS_CONTROL_DOMAIN) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:harness control domain ${HARNESS_CONTROL_DOMAIN} is reserved for harness-internal self-checks`,
    );
  }
  if (candidate.scenarioId.startsWith("harness.")) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:harness-prefixed scenarioId is reserved for harness-internal self-checks`,
    );
  }
  if (!FIXTURE_IDENTITIES.includes(candidate.identity as FixtureIdentity)) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:identity ${String(candidate.identity)} is not a matrix identity`,
    );
  }
  if (!CLASS_IDS.includes(candidate.matrixClass as IdentityMatrixClassId)) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:unknown matrix class ${String(candidate.matrixClass)}`,
    );
  }
  if (
    !SPEC_IDENTITY_MATRIX[
      candidate.matrixClass as IdentityMatrixClassId
    ].includes(candidate.identity as FixtureIdentity)
  ) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:identity ${candidate.identity} does not belong to class ${String(candidate.matrixClass)}`,
    );
  }
  if (
    candidate.requiresConfig !== undefined &&
    (!Array.isArray(candidate.requiresConfig) ||
      candidate.requiresConfig.some(
        (key) => typeof key !== "string" || !key.trim(),
      ))
  ) {
    throw new Error(
      `MATRIX_PLAN_INVALID:${entranceId}:${side}:requiresConfig must be non-empty strings`,
    );
  }
}

/**
 * Validates a matrix evidence plan against the fixed matrix and the
 * inventory. Unlike the MT131 harness (where a planned half is legitimate),
 * a matrix entrance must cite BOTH sides — a named entrance with half the
 * evidence is a lie about coverage, not an honest gap.
 */
export function validateMatrixPlan(
  plan: MatrixPlan,
  inventory: CoverageInventory,
): void {
  validateIdentityMatrix();
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("MATRIX_PLAN_INVALID:not an object");
  }
  const known = new Set(inventory.entrances.map((entry) => entry.id));
  const unknown: string[] = [];
  for (const [entranceId, evidence] of Object.entries(plan)) {
    if (!known.has(entranceId)) {
      unknown.push(entranceId);
      continue;
    }
    for (const side of ["positive", "denial"] as const) {
      const ref = evidence?.[side];
      if (!ref) {
        throw new Error(`MATRIX_PLAN_SIDE_MISSING:${entranceId}:${side}`);
      }
      validateMatrixRef(entranceId, side, ref);
    }
    if (
      evidence.positive.domain === evidence.denial.domain &&
      evidence.positive.scenarioId === evidence.denial.scenarioId
    ) {
      // One scenario answers one question; citing it for both sides would
      // make the pair an always-green oracle.
      throw new Error(
        `MATRIX_PLAN_SIDES_IDENTICAL:${entranceId}:${evidence.positive.scenarioId}`,
      );
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `MATRIX_PLAN_ENTRANCE_UNKNOWN:${[...unknown].sort().join(",")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Isolation resolution
// ---------------------------------------------------------------------------

/** Where the runner runs: every value is dedicated and run-scoped. */
export interface MatrixIsolation {
  runId: string;
  databaseName: string;
  databaseHost: string;
  databasePort: number;
  restrictedRoles: readonly string[];
  externalNamespace: string;
  /** Namespaced directory that carries this run's `run-metadata.json`. */
  tempDir: string;
}

/**
 * Resolves (and refuses) the environment before anything connects — the same
 * validators the MT131 harness resolution uses. DATABASE_URL is never
 * consulted; a development database name or a mispointed restricted-role URL
 * is an explicit failure. No port is bound: unlike the harness this runner
 * has no HTTP status surface, so there is nothing to prove on that axis.
 */
export function resolveMatrixIsolation(
  environment: Record<string, string | undefined>,
  runIdInput?: string,
): MatrixIsolation {
  const runId = runIdInput ?? `r${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (!/^[a-z0-9-]{1,64}$/.test(runId)) {
    throw new Error(`MATRIX_RUN_ID_INVALID:${runId}`);
  }
  const setupUrlRaw = enterpriseTestDatabaseUrlFrom(environment);
  for (const role of RESTRICTED_ROLES) {
    enterpriseRuntimeDatabaseUrlFrom(role, environment);
  }
  const setupUrl = new URL(setupUrlRaw);
  return {
    runId,
    databaseName: enterpriseTestDatabaseNameFrom(setupUrlRaw),
    databaseHost: setupUrl.hostname,
    databasePort: Number(setupUrl.port || 5432),
    restrictedRoles: [...RESTRICTED_ROLES],
    externalNamespace: `${MATRIX_EXTERNAL_NAMESPACE_PREFIX}_${runId}`,
    tempDir: join(tmpdir(), "openbot-mt132-matrix", runId),
  };
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** One side's matrix evidence result for one entrance. */
export interface MatrixSideResult extends SideResult {
  identity?: FixtureIdentity;
  matrixClass?: IdentityMatrixClassId;
}

/** Per-entrance matrix coverage result. */
export interface MatrixEntranceResult {
  id: string;
  entrance: string;
  method: string;
  path: string;
  kind: string;
  type: string;
  businessClosure: string;
  ownerTicket: string | null;
  positive: MatrixSideResult;
  denial: MatrixSideResult;
  status: "covered" | "uncovered";
}

/** Per-identity-class usage facts (release-candidate consumption surface). */
export interface MatrixClassCoverage {
  id: IdentityMatrixClassId;
  label: string;
  identities: readonly FixtureIdentity[];
  /** Entrances whose evidence cited this class (either side). */
  entrancesExercised: number;
  /** Exercised entrances that ended up covered. */
  entrancesCovered: number;
}

/** One uncovered entrance, grouped with the reasons and its owner. */
export interface MatrixGap {
  entranceId: string;
  businessClosure: string;
  ownerTicket: string | null;
  reasons: string[];
}

/** The machine-readable coverage-status report. */
export interface MatrixCoverageReport {
  schemaVersion: number;
  runner: "mt132-identity-matrix";
  generatedAt: string;
  runId: string;
  isolation: MatrixIsolation;
  inventory: {
    schemaVersion: number;
    digest: string;
    generatedAt: string;
    totalEntrances: number;
    routeEntrances: number;
  };
  matrix: {
    /** True iff the fixed matrix validated against the Spec's eight classes. */
    complete: boolean;
    classes: MatrixClassCoverage[];
  };
  entrances: MatrixEntranceResult[];
  gaps: MatrixGap[];
  summary: {
    totalEntrances: number;
    coveredEntrances: number;
    uncoveredEntrances: number;
    entrancesWithMissingPositive: number;
    entrancesWithMissingDenial: number;
    entrancesWithFailedSides: number;
    entrancesWithScenarioErrors: number;
    entrancesWithEnvironmentGaps: number;
    identityClassesExercised: number;
    identityClassesTotal: number;
  };
  overall: "coverage-complete" | "coverage-incomplete";
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Options for `runMatrixCoverage`. The seams mirror the harness options. */
export interface RunMatrixOptions {
  environment?: Record<string, string | undefined>;
  plan?: MatrixPlan;
  /** Prebuilt inventory (the CLI always builds a fresh one). */
  inventory?: CoverageInventory;
  runId?: string;
  now?: () => Date;
  /** Detector override — used only by this runner's own self-verification. */
  evaluator?: typeof evaluateObservationSide;
}

async function runOneSide(
  side: EvidenceSide,
  ref: MatrixEvidenceRef,
  environment: Record<string, string | undefined>,
  evaluator: typeof evaluateObservationSide,
): Promise<MatrixSideResult> {
  const missingConfigKeys = (ref.requiresConfig ?? []).filter(
    (key) => !environment[key]?.trim(),
  );
  if (missingConfigKeys.length > 0) {
    return {
      status: "environment-gap",
      domain: ref.domain,
      scenarioId: ref.scenarioId,
      identity: ref.identity,
      matrixClass: ref.matrixClass,
      reasons: missingConfigKeys.map((key) => `missing-config:${key}`),
    };
  }
  try {
    const observation = await runIsolationScenario(ref.domain, ref.scenarioId);
    const verdict = evaluator(observation, side);
    return {
      status: verdict.verdict,
      domain: ref.domain,
      scenarioId: ref.scenarioId,
      identity: ref.identity,
      matrixClass: ref.matrixClass,
      reasons: verdict.reasons,
    };
  } catch (error) {
    // Unregistered domains, absent scenarios, adapter failures and
    // skip-shaped results are uncovered facts — never synthetic passes.
    return {
      status: "scenario-error",
      domain: ref.domain,
      scenarioId: ref.scenarioId,
      identity: ref.identity,
      matrixClass: ref.matrixClass,
      reasons: [messageOf(error), ...causeChainOf(error)],
    };
  }
}

/**
 * Runs the whole matrix pipeline: validate the fixed matrix, resolve the
 * isolated environment, validate the plan against the real inventory, then
 * execute both sides of every planned entrance and derive the per-entrance,
 * per-class and gap facts. Unplanned inventory entrances stay uncovered with
 * both sides missing — a brand-new entrance can therefore never look
 * covered.
 */
export async function runMatrixCoverage(
  options: RunMatrixOptions = {},
): Promise<MatrixCoverageReport> {
  const environment = options.environment ?? process.env;
  const runId =
    options.runId ?? `r${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  // The fixed matrix first: a drifted matrix invalidates everything below.
  validateIdentityMatrix();

  let isolation: MatrixIsolation;
  try {
    isolation = resolveMatrixIsolation(environment, runId);
  } catch (error) {
    throw new Error(`MATRIX_ENVIRONMENT_FAILED:${messageOf(error)}`);
  }
  await mkdir(isolation.tempDir, { recursive: true });
  try {
    await writeFile(
      join(isolation.tempDir, "run-metadata.json"),
      `${JSON.stringify(
        {
          schemaVersion: MATRIX_SCHEMA_VERSION,
          runner: "mt132-identity-matrix",
          runId,
          startedAt: (options.now?.() ?? new Date()).toISOString(),
          isolation,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    throw new Error(
      `MATRIX_TEMPDIR_UNAVAILABLE:${isolation.tempDir}:${messageOf(error)}`,
    );
  }

  const inventory: CoverageInventory =
    options.inventory ?? (await buildInventory({ environment }));
  const plan = options.plan ?? {};
  validateMatrixPlan(plan, inventory);
  const evaluator = options.evaluator ?? evaluateObservationSide;

  const entrances: MatrixEntranceResult[] = [];
  const classUsage = new Map<
    IdentityMatrixClassId,
    { exercised: number; covered: number }
  >();
  for (const id of CLASS_IDS) classUsage.set(id, { exercised: 0, covered: 0 });
  const bump = (matrixClass: IdentityMatrixClassId | undefined, covered: boolean) => {
    if (!matrixClass) return;
    const usage = classUsage.get(matrixClass);
    if (!usage) return;
    usage.exercised += 1;
    if (covered) usage.covered += 1;
  };

  for (const entry of inventory.entrances) {
    const planned = plan[entry.id];
    let sides: Record<EvidenceSide, MatrixSideResult>;
    if (!planned) {
      sides = {
        positive: {
          status: "missing",
          reasons: ["side-absent-from-evidence-plan"],
        },
        denial: {
          status: "missing",
          reasons: ["side-absent-from-evidence-plan"],
        },
      };
    } else {
      sides = {
        positive: await runOneSide(
          "positive",
          planned.positive,
          environment,
          evaluator,
        ),
        denial: await runOneSide(
          "denial",
          planned.denial,
          environment,
          evaluator,
        ),
      };
    }
    const status: MatrixEntranceResult["status"] =
      sides.positive.status === "pass" && sides.denial.status === "pass"
        ? "covered"
        : "uncovered";
    if (planned) {
      // Count the entrance once per class: both sides regularly cite the same
      // class, which double-counted the per-entrance coverage metric.
      const citedClasses = new Set<IdentityMatrixClassId>([
        planned.positive.matrixClass,
        planned.denial.matrixClass,
      ]);
      for (const matrixClass of citedClasses)
        bump(matrixClass, status === "covered");
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
      status,
    });
  }

  const gaps: MatrixGap[] = entrances
    .filter((entry) => entry.status === "uncovered")
    .map((entry) => ({
      entranceId: entry.id,
      businessClosure: entry.businessClosure,
      ownerTicket: entry.ownerTicket,
      reasons: [
        ...new Set([...entry.positive.reasons, ...entry.denial.reasons]),
      ],
    }));
  const coveredEntrances = entrances.length - gaps.length;
  const classes: MatrixClassCoverage[] = CLASS_IDS.map((id) => ({
    id,
    label: CLASS_LABELS[id],
    identities: [...SPEC_IDENTITY_MATRIX[id]],
    entrancesExercised: classUsage.get(id)?.exercised ?? 0,
    entrancesCovered: classUsage.get(id)?.covered ?? 0,
  }));
  const countWhere = (predicate: (entry: MatrixEntranceResult) => boolean) =>
    entrances.filter(predicate).length;

  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    runner: "mt132-identity-matrix",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    runId,
    isolation,
    inventory: {
      schemaVersion: inventory.schemaVersion,
      digest: inventory.digest,
      generatedAt: inventory.generatedAt,
      totalEntrances: entrances.length,
      routeEntrances: entrances.filter((entry) => entry.kind === "route")
        .length,
    },
    matrix: { complete: true, classes },
    entrances,
    gaps,
    summary: {
      totalEntrances: entrances.length,
      coveredEntrances,
      uncoveredEntrances: gaps.length,
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
      entrancesWithEnvironmentGaps: countWhere(
        (entry) =>
          entry.positive.status === "environment-gap" ||
          entry.denial.status === "environment-gap",
      ),
      identityClassesExercised: classes.filter(
        (entry) => entry.entrancesExercised > 0,
      ).length,
      identityClassesTotal: classes.length,
    },
    overall:
      coveredEntrances === entrances.length
        ? "coverage-complete"
        : "coverage-incomplete",
  };
}

/** Side status of one entrance in a produced report (consumption seam). */
export function matrixSideStatus(
  report: MatrixCoverageReport,
  entranceId: string,
  side: EvidenceSide,
): SideStatus | undefined {
  const entry = report.entrances.find((item) => item.id === entranceId);
  return entry?.[side].status;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  out?: string;
  pretty: boolean;
  plan?: string;
  runId?: string;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pretty") flags.pretty = true;
    else if (arg === "--out" || arg === "--plan" || arg === "--run-id") {
      index += 1;
      if (argv[index] === undefined) {
        throw new Error(`MATRIX_FLAG_MISSING_VALUE:${arg}`);
      }
      if (arg === "--out") flags.out = argv[index];
      else if (arg === "--plan") flags.plan = argv[index];
      else flags.runId = argv[index];
    } else {
      throw new Error(`MATRIX_FLAG_UNKNOWN:${arg}`);
    }
  }
  return flags;
}

/** Keeps stdout pure for the JSON report by replaying noisy module output. */
async function withCleanStdout<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((
    chunk: unknown,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    captured.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8"),
    );
    // Fire the writer's completion callback (if any): swallowing it would hang
    // callers that wait for flush confirmation.
    (typeof encoding === "function" ? encoding : callback)?.();
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
  let plan: MatrixPlan = {};
  if (flags.plan) {
    try {
      plan = JSON.parse(readFileSync(flags.plan, "utf8"));
    } catch (error) {
      throw new Error(
        `MATRIX_PLAN_UNREADABLE:${flags.plan}:${messageOf(error)}`,
      );
    }
  }
  const report = await withCleanStdout(() =>
    runMatrixCoverage({ plan, runId: flags.runId }),
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
    `mt132 matrix ${report.overall}: covered ${report.summary.coveredEntrances}/${report.summary.totalEntrances} entrances; identity classes exercised ${report.summary.identityClassesExercised}/${report.summary.identityClassesTotal}; gaps ${report.gaps.length}\n`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The nested `cause` chain, most likely carrying the adapter's real error. */
function causeChainOf(error: unknown, depth = 3): string[] {
  const causes: string[] = [];
  let current = error;
  for (let level = 0; level < depth; level += 1) {
    const cause = (current as { cause?: unknown })?.cause;
    if (!cause) break;
    causes.push(cause instanceof Error ? cause.message : String(cause));
    current = cause;
  }
  return causes;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`MATRIX_RUN_FAILED:${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
