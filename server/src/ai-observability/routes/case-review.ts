/**
 * The creator's case review and save routes (Issue #26 / DAG T20).
 *
 * Mounted at routes/index.ts under the prefix below — the integration seam that T33
 * owned and the OCR round-1 fix ticket closed:
 *
 *   routes.route("/bots/:botId/case-review", createCaseReviewRoutes({ ... }))
 *
 * inside createAiObservabilityRoutes, which puts the endpoints at
 * POST /api/ai-observability/bots/:botId/case-review/review and
 * POST /api/ai-observability/bots/:botId/case-review/save behind the root
 * requireUser. Absent deps stay unmounted — the same "absent = not mounted"
 * contract as every other sub-router there.
 *
 * Authorization is the management question (resolveObservationBot) and the scope is
 * derived from the authenticated context plus the injected ownership epoch, exactly
 * like the T10/T11 seams: the body contributes run references, reviewed fragments and
 * a dataset name, and nothing else — no forged actor, bot, scope, locator or upstream
 * filter can steer a review or a save. The run itself is answered per request through
 * the T07 binding table, so a transfer or revocation is effective on the very next
 * call. Errors keep the house convention: the code is the contract.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/profile-types";
import type { AuditStore } from "../../audit";
import type { AppVariables } from "../../auth/guards";
import type { RunBindingStore } from "../bindings";
import { RunBindingError } from "../bindings";
import {
  type CaseFragment,
  CaseReviewError,
  createCaseReviewService,
} from "../case-review";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import { ObservationScopeError } from "../contracts";
import type { ObservationDatasetStore } from "../datasets";
import { DatasetStoreError } from "../datasets";
import { resolveObservationScope } from "../scope";

export type CaseReviewRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** T07's authoritative ownership seam (Issue #13), injected. */
  bindings: Pick<RunBindingStore, "latestAttempt">;
  /** The T19 freeze pipeline (Issue #25), injected. */
  datasets: Pick<ObservationDatasetStore, "saveVersion">;
  /** The audit seam every review action is recorded through. */
  audit: Pick<AuditStore, "insert">;
}>;

const CASE_REVIEW_INPUT_INVALID = "CASE_REVIEW_INPUT_INVALID";

/** Reads the fragments by whitelist; unknown fields — however forged — are ignored. */
function parseFragments(raw: unknown): CaseFragment[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
  }
  return raw.map((one) => {
    if (typeof one !== "object" || one === null) {
      throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
    }
    const record = one as Record<string, unknown>;
    const fragment: Record<string, unknown> = {};
    for (const field of ["input", "referenceOutput"] as const) {
      if (typeof record[field] !== "string") {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      fragment[field] = record[field];
    }
    if (
      typeof record.toolFixtures !== "object" ||
      record.toolFixtures === null ||
      Array.isArray(record.toolFixtures)
    ) {
      throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
    }
    fragment.toolFixtures = record.toolFixtures;
    if (record.attemptId !== undefined) {
      if (typeof record.attemptId !== "string") {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      fragment.attemptId = record.attemptId;
    }
    return fragment as CaseFragment;
  });
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
  }
  return body as Record<string, unknown>;
}

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 402 | 403 | 404 | 409 | 502 | 503;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof CaseReviewError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof RunBindingError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof DatasetStoreError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

export function createCaseReviewRoutes(
  deps: CaseReviewRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const service = createCaseReviewService({
    bindings: deps.bindings,
    datasets: deps.datasets,
    audit: deps.audit,
  });

  /** The shared authorization block, exactly like the T10/T11 seams: manage-gate, then scope. */
  const scopeFor = async (context: {
    var: { actor: AgentActor };
    req: { param: (name: string) => string };
  }): Promise<
    { scope: ReturnType<typeof resolveObservationScope> } | Response
  > => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
    }
    const actor = context.var.actor;
    // Explicit, never inferred (OCR h10/m182): a caller the seam refuses to mint
    // for is answered with the same unified not-found the manage gate uses.
    const ownership = explicitObservationOwnership(actor, access.profile);
    if (ownership === null) {
      return Response.json(
        { error: OBSERVATION_BOT_NOT_FOUND },
        { status: 404 },
      );
    }
    // The epoch is injected wiring, never a body value.
    const epoch = await deps.scopeEpoch(actor, access.botId);
    return {
      scope: resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      }),
    };
  };

  routes.post("/review", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const raw = parseBody(await context.req.json().catch(() => undefined));
      if (typeof raw.runId !== "string" || typeof raw.decision !== "string") {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      // The seam states the vocabulary itself instead of trusting the service's
      // fallback to keep an arbitrary string out of the typed field.
      if (raw.decision !== "approved" && raw.decision !== "rejected") {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      if (raw.note !== undefined && typeof raw.note !== "string") {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      const outcome = await service.review(resolved.scope, {
        runId: raw.runId,
        decision: raw.decision as "approved" | "rejected",
        cases: parseFragments(raw.cases),
        note: raw.note,
      });
      return context.json(outcome);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.post("/save", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const raw = parseBody(await context.req.json().catch(() => undefined));
      if (
        typeof raw.datasetName !== "string" ||
        typeof raw.runId !== "string"
      ) {
        throw new CaseReviewError(CASE_REVIEW_INPUT_INVALID, 400);
      }
      const saved = await service.saveReviewed(resolved.scope, {
        datasetName: raw.datasetName,
        runId: raw.runId,
        cases: parseFragments(raw.cases),
      });
      // The wire answer is the shared contract's flat projection, not the service's
      // store rows: what a person reads (ids, name, hash, policy version, counts),
      // never the scope key, the storage locator or the actor id the full rows carry.
      // The T21 page is the consumer of exactly this shape.
      return context.json({
        datasetId: saved.dataset.id,
        datasetName: saved.dataset.name,
        version: {
          id: saved.version.id,
          contentHash: saved.version.contentHash,
          redactionPolicyVersion: saved.version.redactionPolicyVersion,
          caseCount: saved.version.cases.length,
          createdAt: saved.version.createdAt.toISOString(),
        },
        replayed: saved.replayed,
        canaryFindings: saved.canaryFindings,
      });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}
