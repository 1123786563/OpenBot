/**
 * The production experiment execution assembly (the T-routes closure ticket, Scope B).
 *
 * This is the boot-ready composition the production process starts: the experiment
 * execution worker whose case runner IS the billed runner (T25) with the judge (T27)
 * wrapped outside it, so every real evaluation case is admitted by a credit
 * reservation before its gateway call and settled through the deployment's one usage
 * outbox afterwards — and a judge wired from the deployment's entrance configuration,
 * never from a frozen experiment's imagination.
 *
 * Three deployment facts meet here, each loaded once:
 *
 *  - the billing seam (credit writer, usage outbox, priced-model policy, external
 *    customer) — supplied by the boot file, which already owns the deployment's one
 *    credit machinery;
 *  - the judge admission list (approved entrances + approved scorer versions), read
 *    from the environment here, fail-closed: a list this process cannot parse is an
 *    inert judge, never a half-approved one;
 *  - live authorization for the worker's per-case re-derivation, through the same
 *    resolveActor + manage-gate + live-epoch seam the export worker uses.
 *
 * The evaluation tool surface answers from the catalogue (FREV-04): the whitelist's
 * names are resolved once per execution against the deployment's own `mcp_tools` rows
 * and classified with the same `classifyTool` the store's `callTool` classifies a real
 * call with, so the model is offered production schemas and the gate's read/write
 * answer matches production's for the same tool. What this deliberately does NOT do is
 * execute anything: the schemas are declared, the effect decides, and every call still
 * replays a frozen fixture or is refused. `evaluationToolClassifier` stays the
 * fail-closed floor — a name the catalogue does not know is still a write.
 */
import { inArray } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import type { CreditWriter } from "../billing/credits-writer";
import type { UsageOutbox } from "../billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../config";
import type { Database } from "../db/client";
import { mcpTools } from "../db/schema/plugins";
import { catalogueEntry, classifyTool } from "../plugins/catalogue";
import { refFromToolName } from "../plugins/store";
import type { BotManagementCheck } from "./context";
import { createBilledEvaluationCaseRunner } from "./execution-billing";
import {
  createGatewayModelCall,
  type EvaluationModelCall,
  type EvaluationModelCallObserver,
} from "./execution-runner";
import {
  createObservationExecutionWorker,
  type EvaluationToolClassifier,
  type EvaluationToolSurface,
  type EvaluationToolSurfaceResolver,
} from "./executions";
import {
  createEntranceModelCall,
  createJudgeScorer,
  createJudgeScoringCaseRunner,
  JUDGE_SCORER_VERSION,
  type JudgeEntranceList,
} from "./scoring/judge";
import { createExportReauthorization } from "./wiring";

/** The minimal env surface, injectable so tests never touch process.env. */
type EnvSource = Readonly<Record<string, string | undefined>>;

/** The env name carrying the approved judge entrances as one JSON object. */
const ENTRANCES_ENV = "OPIK_JUDGE_ENTRANCES";
/** The env name carrying the approved scorer versions, comma-separated. */
const VERSIONS_ENV = "OPIK_JUDGE_APPROVED_VERSIONS";

/**
 * The judge admission list from the deployment environment. `OPIK_JUDGE_ENTRANCES` is
 * a JSON object keyed by entrance id, each entry `{modelName, apiKeyEnv?, baseURL?}`;
 * anything else — malformed JSON, an array, an entry without a model name — is
 * skipped, and a list with nothing left answers an empty map, which makes the judge
 * answer `JUDGE_ENTRANCE_NOT_APPROVED` per case: an honest, recorded refusal, never a
 * partially approved entrance. The approved scorer versions default to exactly the
 * version this build implements; a deployment may pin them narrower, never wider than
 * what shipped.
 */
export function judgeAdmissionFromEnv(env: EnvSource): {
  entrances: JudgeEntranceList;
  approvedVersions: ReadonlySet<string>;
} {
  const entrances = new Map<
    string,
    {
      modelName: string;
      apiKeyEnv?: string;
      baseURL?: string;
    }
  >();
  const raw = env[ENTRANCES_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, entry] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
          }
          const modelName = (entry as Record<string, unknown>).modelName;
          if (typeof modelName !== "string" || modelName.trim() === "") {
            continue;
          }
          const apiKeyEnv = (entry as Record<string, unknown>).apiKeyEnv;
          const baseURL = (entry as Record<string, unknown>).baseURL;
          entrances.set(id, {
            modelName,
            ...(typeof apiKeyEnv === "string" && apiKeyEnv.trim() !== ""
              ? { apiKeyEnv }
              : {}),
            ...(typeof baseURL === "string" && baseURL.trim() !== ""
              ? { baseURL }
              : {}),
          });
        }
      }
    } catch {
      // Malformed configuration: the judge stays inert, nothing is guessed.
    }
  }
  const rawVersions = env[VERSIONS_ENV]?.trim();
  const versions =
    rawVersions === undefined || rawVersions === ""
      ? [JUDGE_SCORER_VERSION]
      : rawVersions
          .split(",")
          .map((one) => one.trim())
          .filter((one) => one !== "");
  return {
    entrances,
    approvedVersions: new Set(
      versions.length > 0 ? versions : [JUDGE_SCORER_VERSION],
    ),
  };
}

/**
 * The production tool classifier: fail-closed write for every name, through the
 * reviewed classifier itself — an unadvertised name is a write, and a name the
 * catalogue resolver did not answer keeps this word (see
 * {@link createCatalogueToolSurface} for the answer that precedes it). Kept exported
 * as the floor every deployment has, even the one with no plugin catalogue at all.
 */
export const evaluationToolClassifier: EvaluationToolClassifier = (toolName) =>
  classifyTool(null, toolName, false);

/** One frozen name, resolved onto the deployment's tool rows (FREV-04). */
type ResolvedName = Readonly<{
  /** The frozen spelling, which is the key the answer is filed under. */
  name: string;
  /** The server half, when the spelling carried one; null for a bare tool name. */
  serverId: string | null;
  /** The tool half — what the `mcp_tools` row is keyed by. */
  toolName: string;
}>;

/**
 * A frozen tool name onto the two spellings the deployment uses: the model-facing
 * `mcp__server__tool` (what `toolNameFor` mints, and what a submitter copying from a
 * run's transcript would write) and the grant/ref `server/tool`. Anything else is a
 * bare tool name, which only resolves when exactly one advertised tool carries it —
 * ambiguity is a reason to answer nothing, never to pick a row.
 */
function resolveName(name: string): ResolvedName {
  const ref = refFromToolName(name);
  if (ref !== null) {
    const separator = ref.indexOf("/");
    return {
      name,
      serverId: ref.slice(0, separator),
      toolName: ref.slice(separator + 1),
    };
  }
  const separator = name.indexOf("/");
  if (separator > 0) {
    return {
      name,
      serverId: name.slice(0, separator),
      toolName: name.slice(separator + 1),
    };
  }
  return { name, serverId: null, toolName: name };
}

/**
 * The deployment's answer for the frozen whitelist (FREV-04): description and JSON
 * Schema from the `mcp_tools` row — the same columns the runtime's granted-tool
 * listing hands a Bot — and the read/write effect from `classifyTool` over that row
 * and its catalogue entry, exactly as `callTool` computes it. A name with no row, or
 * one several servers share, is absent from the map: the fail-closed classifier then
 * says "write" and the gate refuses, which is the assembly's existing word for a tool
 * it cannot attest.
 *
 * Read-only and inert by construction: no credential, no network, no grant check — it
 * describes tools, it never reaches one.
 */
export function createCatalogueToolSurface(
  database: Database,
): EvaluationToolSurfaceResolver {
  return async (names) => {
    const surfaces = new Map<string, EvaluationToolSurface>();
    const candidates = names
      .map(resolveName)
      .filter((one) => one.toolName !== "");
    const toolNames = [...new Set(candidates.map((one) => one.toolName))];
    if (toolNames.length === 0) return surfaces;
    const rows = await database
      .select({
        serverId: mcpTools.serverId,
        name: mcpTools.name,
        description: mcpTools.description,
        inputSchema: mcpTools.inputSchema,
        effect: mcpTools.effect,
      })
      .from(mcpTools)
      .where(inArray(mcpTools.name, toolNames));
    for (const candidate of candidates) {
      const matches = rows.filter(
        (row) =>
          row.name === candidate.toolName &&
          (candidate.serverId === null || row.serverId === candidate.serverId),
      );
      // One row or nothing: a bare name two servers advertise is not resolved, and a
      // name the catalogue never listed stays absent rather than invented.
      if (matches.length !== 1) continue;
      const row = matches[0];
      if (row === undefined) continue;
      const schema: unknown = row.inputSchema;
      surfaces.set(candidate.name, {
        description: row.description,
        parameters:
          schema !== null &&
          typeof schema === "object" &&
          !Array.isArray(schema)
            ? (schema as Record<string, unknown>)
            : {},
        effect: classifyTool(
          catalogueEntry(row.serverId),
          row.name,
          true,
          row.effect,
        ),
      });
    }
    return surfaces;
  };
}

/**
 * The judge's controlled model call, wired from the approved entrances: the judge asks
 * for an entrance by id, and this dispatch honors exactly that entrance — its own base
 * URL and its own credential environment (T27's `createEntranceModelCall`), resolved
 * lazily and only for entrances the list approved. The entrance id rides the request
 * (OCR R4-23), so when two approved entrances share a model name, the entrance the
 * judge's record names is the entrance actually dialed — admission, dispatch and
 * provenance stay one fact instead of diverging on map order. A request without an
 * entrance id keeps the legacy modelName dispatch (first entrance loaded wins); a name
 * no entrance carries falls to the deployment's default gateway, where it was priced
 * anyway.
 */
export function createJudgeEntranceCall(
  entrances: JudgeEntranceList,
): EvaluationModelCall {
  const byId = new Map<string, EvaluationModelCall>();
  const byModelName = new Map<string, EvaluationModelCall>();
  for (const [id, entrance] of entrances) {
    const call = createEntranceModelCall(entrance);
    byId.set(id, call);
    // Legacy modelName dispatch (requests without an entrance id): first loaded wins.
    if (!byModelName.has(entrance.modelName)) {
      byModelName.set(entrance.modelName, call);
    }
  }
  const fallback = createGatewayModelCall();
  return (request) => {
    if (request.entranceId !== undefined) {
      return (byId.get(request.entranceId) ?? fallback)(request);
    }
    return (byModelName.get(request.modelName) ?? fallback)(request);
  };
}

/** The billing seam the evaluation (and judge) calls are metered through. */
export type ExperimentExecutionBilling = Readonly<{
  creditWriter: Pick<CreditWriter, "reserveCredits" | "availableBalance">;
  outbox: Pick<UsageOutbox, "record">;
  /** The frozen models' price ceilings; a model this map does not name is not admissible. */
  policy: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
  externalCustomerId: string;
}>;

export type ExperimentExecutionBootDeps = Readonly<{
  database: Database;
  /** The governance channel: settles leave their trail, whatever ends them. */
  audit: Pick<AuditStore, "insert">;
  billing: ExperimentExecutionBilling;
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** An actorId back into an actor, for the worker's live re-authorization. */
  resolveActor: (actorId: string) => Promise<AgentActor | null>;
  /** The deployment environment: judge entrances, approved versions, gateway keys. */
  env: EnvSource;
  /** The evaluation call's model-span channel; absent means unobserved calls. */
  observe?: EvaluationModelCallObserver;
  /** Override for tests; production dials the deployment gateway resolved from env. */
  callModel?: EvaluationModelCall;
  /**
   * Override for tests; production reads the deployment's own `mcp_tools` rows
   * ({@link createCatalogueToolSurface}) so the evaluated model sees the schemas and
   * read/write effects production would give the same tools.
   */
  resolveToolSurface?: EvaluationToolSurfaceResolver;
  concurrency?: number;
  owner?: string;
}>;

/**
 * The worker production starts. Composition is the whole job: the billed runner
 * inside, the judge outside it, live authorization around both — and nothing else
 * invented here.
 */
/**
 * The production execution worker's work-item lease (OCR m131, R2-36): three
 * gateway call timeouts (execution-runner.ts's GATEWAY_CALL_TIMEOUT_MS = 60s).
 * The lease must strictly outlive the slowest single work item it covers —
 * renewal runs only before each case — and with the judge composed outside the
 * billed runner that worst case is no longer one gateway round trip: evaluation
 * call (60s) + judge call (60s) + settlement ≈ 120s, which is exactly where the
 * old 2× lease sat. Three times the per-call budget leaves the settle-and-renew
 * path a full call budget of headroom over the composed worst case.
 */
export const EXECUTION_WORKER_LEASE_MS = 180_000;

export function createExperimentExecutionWorkerBoot(
  deps: ExperimentExecutionBootDeps,
) {
  const { entrances, approvedVersions } = judgeAdmissionFromEnv(deps.env);
  const callModel = deps.callModel ?? createGatewayModelCall();
  const billedRunner = createBilledEvaluationCaseRunner({
    callModel,
    ...(deps.observe === undefined ? {} : { observe: deps.observe }),
    billing: deps.billing,
  });
  const judge = createJudgeScorer({
    callModel: createJudgeEntranceCall(entrances),
    admission: { entrances, approvedVersions, policy: deps.billing.policy },
    billing: deps.billing,
  });
  return createObservationExecutionWorker({
    database: deps.database,
    audit: deps.audit,
    classify: evaluationToolClassifier,
    // FREV-04: the catalogue surface the runner declares and the gate classifies
    // with, read once per execution. `evaluationToolClassifier` above stays the
    // fail-closed word for every name this resolver does not answer.
    resolveToolSurface:
      deps.resolveToolSurface ?? createCatalogueToolSurface(deps.database),
    runCase: createJudgeScoringCaseRunner({ inner: billedRunner, judge }),
    reauthorize: createExportReauthorization({
      canManageBot: deps.canManageBot,
      scopeEpoch: deps.scopeEpoch,
      resolveActor: deps.resolveActor,
    }),
    ...(deps.concurrency === undefined
      ? {}
      : { concurrency: deps.concurrency }),
    // The work-item lease must outlive the slowest single work item, not equal
    // one gateway round trip (OCR m131, R2-36): the runner's per-call budget is
    // GATEWAY_CALL_TIMEOUT_MS (60s), and renewal happens only before each case —
    // at the old 60s default a case at the full budget let the lease lapse at
    // the very moment the gateway gave up; at the 2× revision the judge's
    // composed worst case (evaluation call + judge call + settlement ≈ 120s)
    // landed exactly on the lease boundary. Three times the per-call budget
    // keeps the takeover from marking a real observation row unknown while a
    // case is still legitimately inside its own budget.
    leaseMs: EXECUTION_WORKER_LEASE_MS,
    ...(deps.owner === undefined ? {} : { owner: deps.owner }),
  });
}
