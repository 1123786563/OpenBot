import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
// The ONE canonical JSON: the reply's idempotency id digests the exact
// payload the client posted, so the same reply replays to the same id.
import { canonicalJson } from "../ai-observability/datasets";
import type { AppVariables } from "../auth/public";
import type { PlatformScope } from "../enterprise/contracts";
import type {
  MastraContinuationInstall,
  MastraContinuationResumeResult,
} from "./approvals";
import {
  MASTRA_CONTINUATION_REFUSALS,
  type MastraContinuationRecord,
  MastraContinuationRefusal,
  type MastraContinuationStore,
} from "./continuation-store";

/*
 * ME06 (#478): the client-participation HTTP entry for durable frontend_tool
 * continuations — the surface that makes a suspension REAL end to end:
 *
 *   GET  /                — the workspace's suspension list (the waiting
 *                           state a refresh or another device reads; AC5).
 *   GET  /:continuationId — one suspension, scope-checked.
 *   POST /:continuationId/tool-result
 *                         — the browser's real tool result for a waiting
 *                           frontend_tool call. Idempotent on the reply's
 *                           own digest: the same reply replays to
 *                           `already_applied` (ME05 receipt reuse); a
 *                           different reply after the row finished refuses
 *                           with `alreadyFinished`. The decision re-rides
 *                           the production six-gate orchestrator — this
 *                           route adds authorization (scope) and shape
 *                           only, never a second resume path.
 *
 * Approval and question continuations keep their own product entries (the
 * approvals subsystem routes, out of this ticket's scope); a tool_result
 * decision against them refuses with the store's decision-shape gate.
 */

const log = getLogger("server");

/** The reply digest an idempotent re-apply converges on. */
export function frontendToolResultReceiptId(input: {
  continuationId: string;
  toolCallId: string;
  result: unknown;
}): string {
  return `frt_${createHash("sha256")
    .update(
      canonicalJson({
        continuationId: input.continuationId,
        toolCallId: input.toolCallId,
        result: input.result ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * The named refusal → HTTP status map (the contract surfaces branch here).
 * Exported for the unit assertion of the unwired-dependency mapping (the
 * route's own onError path is the only production consumer).
 */
export function statusForRefusal(
  code: string,
): 400 | 403 | 404 | 409 | 500 | 503 {
  switch (code) {
    case MASTRA_CONTINUATION_REFUSALS.notFound:
      return 404;
    case MASTRA_CONTINUATION_REFUSALS.argsMismatch:
    case MASTRA_CONTINUATION_REFUSALS.decisionIncompatible:
    case MASTRA_CONTINUATION_REFUSALS.payloadInvalid:
      return 400;
    case MASTRA_CONTINUATION_REFUSALS.grantRevoked:
      return 403;
    case MASTRA_CONTINUATION_REFUSALS.revisionConflict:
    case MASTRA_CONTINUATION_REFUSALS.claimExpired:
    case MASTRA_CONTINUATION_REFUSALS.alreadyFinished:
    case MASTRA_CONTINUATION_REFUSALS.claimLost:
    case MASTRA_CONTINUATION_REFUSALS.generationStale:
    case MASTRA_CONTINUATION_REFUSALS.fingerprintIncompatible:
    case MASTRA_CONTINUATION_REFUSALS.driveUnsupported:
    case MASTRA_CONTINUATION_REFUSALS.storageMissing:
    case MASTRA_CONTINUATION_REFUSALS.resuspensionUnsupported:
    case MASTRA_CONTINUATION_REFUSALS.operationIdMismatch:
      return 409;
    // Fix-round-1 (F7, ME10): the ONE remaining UNWIRED composition refusal
    // is a configuration boundary, minted at the production assembly
    // (`MASTRA_CONTINUATIONS_UNWIRED` — copilot.ts resumeFromApprovalDecision)
    // and re-thrown to this route as a MastraContinuationRefusal. It is not
    // a caller mistake (4xx would blame the request) and not a state race
    // (409 would invite a retry of the same call): the very same request
    // against a fully wired deployment succeeds. 503 says exactly that —
    // the dependency (durable install) is unavailable here. The
    // `MASTRA_RESUME_LOOP_MODEL_UNWIRED` mapping this switch used to carry
    // was a stale ME09 leftover: that placeholder refusal no longer exists
    // (the resumed loop's governed re-binding is wired), and an unmapped
    // code can never be minted again.
    case "MASTRA_CONTINUATIONS_UNWIRED":
      return 503;
    default:
      return 500;
  }
}

/** What the list endpoint returns for one row (never the token hash). */
function publicRecord(record: MastraContinuationRecord) {
  return {
    continuationId: record.ref.continuationId,
    revision: record.ref.revision,
    status: record.status,
    claimExpired: record.claimExpired,
    decisionId: record.decisionId,
    outcome: record.outcome,
    kind: record.payload.kind,
    toolCallId: record.payload.toolCallId,
    toolName: record.payload.toolName,
    argsDigest: record.payload.argsDigest,
    operationId: record.operationId,
    botId: record.binding.botId,
    runId: record.binding.runId,
    attemptId: record.binding.attemptId,
    generation: record.binding.generation,
    threadId: record.binding.threadId ?? null,
  };
}

const toolResultBody = z.strictObject({
  /** The suspended call this reply answers (must be the row's own call). */
  toolCallId: z.string().min(1).max(200),
  /** The browser's real tool result, verbatim. */
  result: z.unknown().optional(),
});

export function createMastraContinuationRoutes(deps: {
  install: MastraContinuationInstall;
  store: MastraContinuationStore;
  /** The server-resolved scope of THIS request (never a client field). */
  resolveScope: (request: Request) => Promise<PlatformScope>;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof SyntaxError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof MastraContinuationRefusal) {
      return context.json(
        { error: error.code, message: error.message },
        statusForRefusal(error.code),
      );
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    // The unexpected branch never echoes the error text: a store or driver fault carries
    // SQL fragments and internal addresses. It is logged here in full and answered with a
    // bare code, so nothing implementation-specific leaves the process.
    log.error(
      { err: error, route: context.req.path },
      "A continuation route failed unexpectedly.",
    );
    return context.json(
      { error: "MASTRA_CONTINUATION_ROUTE_FAILED" },
      500,
    );
  });

  routes.get("/", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const url = new URL(context.req.raw.url);
    const status = url.searchParams.get("status");
    const records = await deps.store.listContinuations(scope, {
      ...(status === "waiting" || status === "claimed" || status === "finished"
        ? { status }
        : {}),
    });
    return context.json({ suspensions: records.map(publicRecord) });
  });

  routes.get("/:continuationId", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const record = await deps.store.getContinuation(
      scope,
      context.req.param("continuationId"),
    );
    // A foreign scope reads as absence — the same denial shape as every
    // other foreign-resource read.
    if (!record) return context.json({ error: "NOT_FOUND" }, 404);
    return context.json({ suspension: publicRecord(record) });
  });

  routes.post("/:continuationId/tool-result", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const continuationId = context.req.param("continuationId");
    const input = toolResultBody.parse(await context.req.json());
    // The fresh record: its identity is what the reply must match, and its
    // revision is the ref the orchestrator re-reads past anyway (F5) —
    // supplied as a courtesy so a stale caller sees a precise 409.
    const record = await deps.store.getContinuation(scope, continuationId);
    if (!record) return context.json({ error: "NOT_FOUND" }, 404);
    if (record.payload.kind !== "frontend_tool") {
      return context.json(
        {
          error: "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
          message: `A ${record.payload.kind} continuation is not resumed by a client tool result.`,
        },
        400,
      );
    }
    if (record.payload.toolCallId !== input.toolCallId) {
      return context.json({ error: "MASTRA_CONTINUATION_ARGS_MISMATCH" }, 400);
    }
    const receiptId = frontendToolResultReceiptId({
      continuationId,
      toolCallId: input.toolCallId,
      result: input.result,
    });
    const result: MastraContinuationResumeResult = await deps.install.resume({
      scope,
      ref: { continuationId, revision: record.ref.revision },
      decision: { kind: "tool_result", receiptId, result: input.result },
    });
    return context.json({ result });
  });

  return routes;
}
