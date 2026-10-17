import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  REDACTION_POLICY_VERSION,
  type SafeText,
  type SafeValue,
} from "../../../shared/ai-observability";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { aiObservationDatasetVersions } from "../db/schema/ai-observability-datasets";
import { aiObservationExperiments } from "../db/schema/ai-observability-experiments";
import type { ObservationScope } from "./contracts";
import { canonicalJson } from "./datasets";
import {
  denyReason,
  projectSafeFixture,
  projectSafeName,
  projectSafeText,
} from "./redaction";
import { notPendingDeletion } from "./retention";
import { assertObservationScope } from "./scope";

/**
 * The experiment configuration freeze (Issue #28 / DAG T22).
 *
 * An experiment is a submitted configuration, not a folder of settings: the dataset version it
 * evaluates against (T19's key), the Bot configuration snapshot, the prompt, the model and its
 * parameters, the tool fixtures and the judge/scorer configuration with its version. Submitting
 * freezes all of it at once — every field is projected through the T05 pipeline before it is
 * hashed or stored, so no path here can freeze a credential into an evaluation configuration
 * even if a caller claims the content is safe.
 *
 * Identity is content, exactly like T19's versions: the canonical JSON of the projected
 * configuration under the current redaction policy hashes to the `config_hash` that, with the
 * scope, is the frozen experiment's uniqueness key. A retried submit — same configuration,
 * whatever name it arrives under — hits the experiment that already exists; the database
 * decides the replay, and a retry cannot produce a second experiment.
 *
 * The state vocabulary is two words, fail-closed: `draft` rows are mutable while the
 * configuration is being composed, and the one legal transition is draft → frozen at submit.
 * A frozen row is immutable as a database fact (migration 0126's trigger), so submitting a
 * different configuration under a frozen experiment's name is refused, not merged.
 */

export type ExperimentErrorCode =
  | "EXPERIMENT_INPUT_INVALID"
  | "EXPERIMENT_DATASET_VERSION_NOT_FOUND"
  | "EXPERIMENT_STATE_INVALID";

export class ExperimentStoreError extends Error {
  constructor(
    public code: ExperimentErrorCode,
    public status: 400 | 404 | 409,
  ) {
    super(code);
  }
}

/** The experiment configuration as the caller submits it: everything a freeze must pin. */
export type ExperimentConfigInput = {
  /** Snapshot of the Bot's non-sensitive configuration. */
  botConfig: Record<string, unknown>;
  /** The prompt — or its version fingerprint — the evaluated runs are given. */
  prompt: string;
  /** The model the evaluated runs run on. */
  modelName: string;
  /** The model parameters: temperature and friends. */
  modelParameters: Record<string, unknown>;
  /** Tool fixtures: the structured stand-ins evaluation replays instead of live tools. */
  toolFixtures: Record<string, unknown>;
  /** The judge/scorer configuration. */
  judgeConfig: Record<string, unknown>;
  /** The judge/scorer version — the scoring code this experiment is pinned to. */
  judgeVersion: string;
  /**
   * The read-only tool whitelist (Issue #29 / T23): the only tool names evaluation
   * execution may even consider calling. Every name outside it — including any tool
   * the model invents — is refused in the evaluation context. Optional at input; a
   * freeze without one is an empty whitelist, which refuses everything.
   */
  readOnlyTools?: readonly string[];
};

/** The same configuration as a freeze holds it: projected fields, nothing raw. */
export type FrozenExperimentConfig = Readonly<{
  botConfig: SafeValue;
  prompt: SafeText;
  modelName: SafeText;
  modelParameters: SafeValue;
  toolFixtures: SafeValue;
  judgeConfig: SafeValue;
  judgeVersion: SafeText;
  /** Sorted, deduplicated, projected: the whitelist is part of the hashed identity. */
  readOnlyTools: readonly SafeText[];
}>;

export const MAX_EXPERIMENT_NAME_BYTES = 128;
/** How many tool names one whitelist may hold — a list longer than any Bot's reach. */
export const MAX_READ_ONLY_TOOLS = 64;

export type ObservationExperiment =
  typeof aiObservationExperiments.$inferSelect;

export type SaveExperimentInput = {
  name: string;
  datasetVersionId: string;
  config: ExperimentConfigInput;
};

export type ObservationExperimentStore = {
  /** Save or update the draft under (scope, name). A frozen experiment's name refuses it. */
  saveDraft(
    scope: ObservationScope,
    input: SaveExperimentInput,
  ): Promise<ObservationExperiment>;
  /**
   * Freeze the submitted configuration: one immutable experiment per canonical config inside
   * the scope. Submitting what is already frozen hits that experiment — `replayed` — whoever
   * the name says it belongs to; submitting different content under a frozen name is refused.
   */
  submit(
    scope: ObservationScope,
    input: SaveExperimentInput,
  ): Promise<{
    experiment: ObservationExperiment;
    replayed: boolean;
    canaryFindings: number;
  }>;
  /** Read one experiment inside the caller's scope. Another scope's id is simply not found. */
  getExperiment(
    scope: ObservationScope,
    id: string,
  ): Promise<ObservationExperiment | null>;
};

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400);
  }
  return value;
}

/** A structured field: an object, never null and never an array pretending to be one. */
function structure(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400);
  }
  return value;
}

function validateInput(input: SaveExperimentInput) {
  const name = reference(input.name);
  if (new TextEncoder().encode(name).length > MAX_EXPERIMENT_NAME_BYTES) {
    throw new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400);
  }
  // The id-links precedent, applied to the one field the freeze pipeline never
  // projected: the name is a frozen row column and an audit-payload fact, the row
  // is immutable (no UPDATE can clean it) and the trail is append-only — so a name
  // matching a credential class is refused before anything is stored. The audit
  // payload below reads `result.experiment.name` from that same validated row, so
  // this one refusal covers the trail too.
  if (denyReason(name) !== undefined) {
    throw new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400);
  }
  reference(input.datasetVersionId);
  const config = input.config;
  structure(config.botConfig);
  reference(config.prompt);
  reference(config.modelName);
  structure(config.modelParameters);
  structure(config.toolFixtures);
  structure(config.judgeConfig);
  reference(config.judgeVersion);
  const tools = config.readOnlyTools ?? [];
  if (
    !Array.isArray(tools) ||
    tools.length > MAX_READ_ONLY_TOOLS ||
    tools.some((name) => typeof name !== "string" || name.trim() === "")
  ) {
    throw new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400);
  }
  return name;
}

/** Project the submitted configuration into the frozen form; the deny scan always wins. */
export function freezeExperimentConfig(
  config: ExperimentConfigInput,
): FrozenExperimentConfig {
  return {
    botConfig: projectSafeFixture(structure(config.botConfig)),
    prompt: projectSafeText(config.prompt, { allowFreeText: true }),
    modelName: projectSafeText(config.modelName, { allowFreeText: true }),
    modelParameters: projectSafeFixture(structure(config.modelParameters)),
    toolFixtures: projectSafeFixture(structure(config.toolFixtures)),
    judgeConfig: projectSafeFixture(structure(config.judgeConfig)),
    judgeVersion: projectSafeText(config.judgeVersion, { allowFreeText: true }),
    // Sorted and deduplicated so the whitelist is a set in canonical form: submitting
    // the same tools in another order is the same configuration, the same hash, the
    // same experiment. Each name is projected, so a name the redaction policy refuses
    // drops out (it can never match a call) rather than widening what may run.
    readOnlyTools: [...new Set(config.readOnlyTools ?? [])]
      .sort()
      .map((name) => projectSafeName(name)),
  };
}

/** The experiment identity of a frozen configuration over one dataset version. */
export function experimentConfigHash(
  datasetVersionId: string,
  frozen: FrozenExperimentConfig,
  policyVersion: string = REDACTION_POLICY_VERSION,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        policy: policyVersion,
        datasetVersionId,
        config: frozen as unknown,
      }),
    )
    .digest("hex");
}

/**
 * How many places the deny patterns refused — the canary the submitter must see. Unlike the
 * case review's per-case count, configuration denial is nested (a fixture holding a token, a
 * threshold shaped like a key), so the walk counts every omitted state in the tree, however
 * deep. Truncation is a size decision, not a refusal, and does not count.
 */
export function countExperimentCanaryFindings(
  frozen: FrozenExperimentConfig,
): number {
  const walk = (node: SafeValue | SafeText): number => {
    if (node.state === "omitted") return 1;
    // Truncated is a size decision, not a denial, and SafeText carries no children.
    if (node.state !== "projected" || !("value" in node)) return 0;
    const value: unknown = node.value;
    if (Array.isArray(value)) {
      return value.reduce<number>(
        (sum, one) => sum + walk(one as SafeValue),
        0,
      );
    }
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).reduce<number>(
        (sum, one) => sum + walk(one as SafeValue),
        0,
      );
    }
    return 0;
  };
  // readOnlyTools is a SafeText list, not a SafeValue tree — the generic walk
  // above sees one non-projected node at most, never the refused names inside it
  // (OCR m136). Each refused whitelist entry is its own canary: the evaluation's
  // callable-tool set silently narrowed, and the submitter must see that.
  const refusedTools = frozen.readOnlyTools.filter(
    (one) => one.state === "omitted",
  ).length;
  const walked = [
    frozen.botConfig,
    frozen.prompt,
    frozen.modelName,
    frozen.modelParameters,
    frozen.toolFixtures,
    frozen.judgeConfig,
    frozen.judgeVersion,
  ].reduce((sum, one) => sum + walk(one), 0);
  return refusedTools + walked;
}

export function createObservationExperimentStore(
  db: Database,
): ObservationExperimentStore {
  /**
   * The pinned dataset version, read inside the caller's scope: a guessed id — or another
   * scope's real one — is simply not found, before any projection, audit row or freeze.
   */
  const pinnedVersion = async (scope: ObservationScope, versionId: string) => {
    const rows = await db
      .select()
      .from(aiObservationDatasetVersions)
      .where(
        and(
          eq(aiObservationDatasetVersions.id, versionId),
          eq(aiObservationDatasetVersions.scopeKey, scope.key),
          // A version hides with its dataset (OCR m137): the sibling reads already
          // answer this, and a pin channel that bypasses the visibility rule would
          // either block the deletion forever or freeze experiments onto a ghost.
          notPendingDeletion("dataset", aiObservationDatasetVersions.datasetId),
        ),
      );
    const version = rows[0];
    if (!version) {
      throw new ExperimentStoreError(
        "EXPERIMENT_DATASET_VERSION_NOT_FOUND",
        404,
      );
    }
    return version;
  };

  return {
    async saveDraft(scope, input) {
      assertObservationScope(scope);
      const name = validateInput(input);
      const version = await pinnedVersion(scope, input.datasetVersionId);
      const config = freezeExperimentConfig(input.config);

      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(aiObservationExperiments)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            name,
            datasetVersionId: version.id,
            datasetContentHash: version.contentHash,
            config,
            state: "draft",
          })
          .onConflictDoNothing({
            target: [
              aiObservationExperiments.scopeKey,
              aiObservationExperiments.name,
            ],
          })
          .returning();
        if (inserted[0]) return inserted[0];

        const found = await tx
          .select()
          .from(aiObservationExperiments)
          .where(
            and(
              eq(aiObservationExperiments.scopeKey, scope.key),
              eq(aiObservationExperiments.name, name),
            ),
          )
          .for("update");
        const existing = found[0];
        if (!existing) {
          throw new Error(
            "saveDraft conflicted but the experiment subject is absent",
          );
        }
        // A frozen experiment's name is taken for good: the trigger would refuse the UPDATE
        // below anyway, but the guard on state keeps the refusal a 409, not a driver error.
        if (existing.state === "frozen") {
          throw new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409);
        }
        const updated = await tx
          .update(aiObservationExperiments)
          .set({
            datasetVersionId: version.id,
            datasetContentHash: version.contentHash,
            config,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(aiObservationExperiments.id, existing.id),
              eq(aiObservationExperiments.state, "draft"),
            ),
          )
          .returning();
        if (updated[0]) return updated[0];
        throw new Error("saveDraft lost the draft it held for update");
      });
    },

    async submit(scope, input) {
      assertObservationScope(scope);
      const name = validateInput(input);
      const version = await pinnedVersion(scope, input.datasetVersionId);
      const config = freezeExperimentConfig(input.config);
      const hash = experimentConfigHash(version.id, config);
      const canaryFindings = countExperimentCanaryFindings(config);

      return db.transaction(async (tx) => {
        // Born frozen when the name is new: the insert carries every freeze fact in one
        // statement, and either unique index can refuse it — that refusal is the replay
        // decision, handled below.
        const inserted = await tx
          .insert(aiObservationExperiments)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            name,
            datasetVersionId: version.id,
            datasetContentHash: version.contentHash,
            config,
            configHash: hash,
            state: "frozen",
            frozenAt: new Date(),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) {
          return {
            experiment: inserted[0],
            replayed: false,
            canaryFindings,
          };
        }

        // The insert conflicted. On the name: the subject exists, and it is either the same
        // frozen configuration (a retry) or a frozen name carrying different content (refused).
        const found = await tx
          .select()
          .from(aiObservationExperiments)
          .where(
            and(
              eq(aiObservationExperiments.scopeKey, scope.key),
              eq(aiObservationExperiments.name, name),
            ),
          )
          .for("update");
        const existing = found[0];
        if (existing) {
          if (existing.state === "frozen") {
            if (existing.configHash === hash) {
              return { experiment: existing, replayed: true, canaryFindings };
            }
            throw new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409);
          }
          // A draft under this name: the same canonical configuration may already be frozen
          // elsewhere in the scope — that experiment is the answer, and the draft stays a
          // draft rather than minting a second frozen row for one configuration.
          const elsewhere = await tx
            .select()
            .from(aiObservationExperiments)
            .where(
              and(
                eq(aiObservationExperiments.scopeKey, scope.key),
                eq(aiObservationExperiments.configHash, hash),
                eq(aiObservationExperiments.state, "frozen"),
                // The replay channel is a reader too (OCR m138): a deletion-in-flight
                // experiment stays gone — a retry must not resurrect it as an
                // idempotent answer.
                notPendingDeletion("experiment", aiObservationExperiments.id),
              ),
            );
          if (elsewhere[0]) {
            return {
              experiment: elsewhere[0],
              replayed: true,
              canaryFindings,
            };
          }
          // The one legal transition, guarded on the UPDATE itself: only a draft row may
          // enter frozen, so a submit racing another submit freezes the row exactly once.
          const frozen = await tx
            .update(aiObservationExperiments)
            .set({
              datasetVersionId: version.id,
              datasetContentHash: version.contentHash,
              config,
              configHash: hash,
              state: "frozen",
              frozenAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(aiObservationExperiments.id, existing.id),
                eq(aiObservationExperiments.state, "draft"),
              ),
            )
            .returning();
          if (frozen[0]) {
            return { experiment: frozen[0], replayed: false, canaryFindings };
          }
          const raced = await tx
            .select()
            .from(aiObservationExperiments)
            .where(eq(aiObservationExperiments.id, existing.id));
          if (raced[0]?.state === "frozen" && raced[0].configHash === hash) {
            return { experiment: raced[0], replayed: true, canaryFindings };
          }
          throw new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409);
        }

        // Not by name, so the insert hit the configuration key: this scope already holds
        // this canonical configuration frozen, under another name. That experiment is the
        // idempotent answer — a retry does not mint a second experiment.
        const byHash = await tx
          .select()
          .from(aiObservationExperiments)
          .where(
            and(
              eq(aiObservationExperiments.scopeKey, scope.key),
              eq(aiObservationExperiments.configHash, hash),
              eq(aiObservationExperiments.state, "frozen"),
              // Same replay-channel visibility (OCR m138) as the draft branch above.
              notPendingDeletion("experiment", aiObservationExperiments.id),
            ),
          );
        if (byHash[0]) {
          return { experiment: byHash[0], replayed: true, canaryFindings };
        }
        throw new Error(
          "submit conflicted but neither the name nor the configuration explains it",
        );
      });
    },

    async getExperiment(scope, id) {
      assertObservationScope(scope);
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExperiments)
        .where(
          and(
            eq(aiObservationExperiments.id, id),
            eq(aiObservationExperiments.scopeKey, scope.key),
            // The M1a visibility rule: an experiment under retention deletion is
            // gone to readers from discovery on.
            notPendingDeletion("experiment", aiObservationExperiments.id),
          ),
        );
      return rows[0] ?? null;
    },
  };
}

/**
 * The submit seam with the audit trail (T20's layering: stores freeze, services audit).
 *
 * The audit row follows the freeze, and deliberately so: it records what the database now
 * holds — the configuration hash, the pinned dataset version, whether this submit replayed an
 * existing experiment. If the insert fails the experiment is still frozen — correctly,
 * immutably — and the retry of this call hits the same experiment and writes the missing row.
 * The payload holds references and counts, never configuration content: a secret typed into a
 * configuration is refused by the projection before anything here runs, and the trail carries
 * the canary count that says it happened.
 */
export type ExperimentSubmitService = Readonly<{
  submit(
    scope: ObservationScope,
    input: SaveExperimentInput,
  ): Promise<{
    experiment: ObservationExperiment;
    replayed: boolean;
    canaryFindings: number;
  }>;
}>;

export function createExperimentSubmitService(
  deps: Readonly<{
    experiments: Pick<ObservationExperimentStore, "submit">;
    audit: Pick<AuditStore, "insert">;
  }>,
): ExperimentSubmitService {
  return {
    async submit(scope, input) {
      assertObservationScope(scope);
      const result = await deps.experiments.submit(scope, input);
      await recordAuditEvent(deps.audit, {
        eventType: "opik.experiment_submitted",
        targetType: "ai_observation_experiment",
        targetId: result.experiment.id,
        actorUserId: scope.actorId,
        payload: {
          experimentId: result.experiment.id,
          name: result.experiment.name,
          datasetVersionId: result.experiment.datasetVersionId,
          datasetContentHash: result.experiment.datasetContentHash,
          configHash: result.experiment.configHash,
          canaryFindings: result.canaryFindings,
          replayed: result.replayed,
        },
      });
      return result;
    },
  };
}
