import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import { UnsentBifrostRequest } from "./test-credit-bifrost";
import type { createBifrostEmbeddingExecutor } from "./test-credit-embedding-bifrost";
import { WEKNORA_APPLICATION_ID as applicationId } from "./weknora-ingestion";

import { weknoraResourceId, weknoraWorkResource } from "./weknora-scope";

import {
  type createWeKnoraWorkExecutor,
  workInput,
  workResult,
} from "./weknora-work";

const id = z.uuid();
// Periodic maintenance charges this platform Billing Account's execution
// budget when the deployment funds it without a person's grant (#110 平台预算).
const platformMaintenanceIdentity = {
  issuer: "openbot:platform",
  subject: "weknora-maintenance",
} satisfies VerifiedBillingIdentity;
const scope = z.strictObject({
  subject: z.string().min(1).max(256),
  authorizationId: id,
  resourceId: weknoraResourceId,
  taskId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
});
const payload = scope.extend({
  operationId: id,
  priceVersion: id.optional(),
  input: z.array(z.string().min(1)).min(1).max(16),
});
const vectors = z.array(z.array(z.number()).min(1)).min(1);

const digest = (value: string) => createHash("sha256").update(value).digest();

type Receipt = NonNullable<
  Awaited<ReturnType<TestCreditLedger["authorizedOperation"]>>
>;
function publicReceipt({
  resultText: _result,
  stepId: _binding,
  ...receipt
}: Receipt) {
  return receipt;
}

function replayVectors(receipt: Receipt) {
  if (
    receipt.state !== "settled" ||
    receipt.outcome !== "completed" ||
    !receipt.resultText
  )
    return undefined;
  const result = vectors.safeParse(JSON.parse(receipt.resultText));
  return result.success ? result.data : undefined;
}

export type WeKnoraRuntime = {
  issuer: string;
  serviceToken: string;
  routeId?: string;
  maintenanceBudgetId?: string;
  execute?: ReturnType<typeof createBifrostEmbeddingExecutor>;
  work?: Partial<
    Record<
      z.infer<typeof workInput>["kind"],
      { routeId: string; execute: ReturnType<typeof createWeKnoraWorkExecutor> }
    >
  >;
};

export function createWeKnoraRoutes({
  issuer,
  serviceToken,
  routeId,
  maintenanceBudgetId,
  execute,
  work,
  ledger,
}: WeKnoraRuntime & { ledger: TestCreditLedger }) {
  const api = new Hono();
  const expected = digest(`Bearer ${serviceToken}`);
  api.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const credential = context.req.header("authorization");
    if (!credential || !timingSafeEqual(expected, digest(credential)))
      return context.json({ code: "service_authentication_required" }, 401);
    await next();
  });
  api.use("*", bodyLimit({ maxSize: 256 * 1024 }));
  api.onError((_error, context) => context.json({ code: "unavailable" }, 503));

  api.get("/authorizations/:id/operations/:operationId", async (context) => {
    const authorizationId = id.safeParse(context.req.param("id"));
    const operationId = id.safeParse(context.req.param("operationId"));
    if (!authorizationId.success || !operationId.success)
      return context.json({ code: "operation_unavailable" }, 404);
    const receipt = await ledger.authorizedOperation(
      applicationId,
      authorizationId.data,
      operationId.data,
    );
    if (receipt) return context.json(publicReceipt(receipt));
    const pause = await ledger.ingestionPause(
      authorizationId.data,
      operationId.data,
    );
    return pause
      ? context.json({
          operationId: operationId.data,
          state: pause.confirmedAt ? "confirmed" : "paused",
          code: pause.reason,
        })
      : context.json({ code: "operation_unavailable" }, 404);
  });

  api.post("/embeddings", async (context) => {
    if (!routeId || !execute)
      return context.json({ code: "route_unavailable" }, 503);
    const parsed = payload.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json({ code: "invalid_embedding_request" }, 400);
    const { subject, authorizationId, resourceId, operationId, input } =
      parsed.data;
    // The original worker persists one authorization ID with the upload payload.
    const taskId = parsed.data.taskId ?? authorizationId;
    const identity = await ledger.authorizationIdentity(
      applicationId,
      authorizationId,
    );
    if (identity?.issuer !== issuer || identity.subject !== subject)
      return context.json({ code: "not_authorized" }, 403);
    const grant = await ledger.authorizationSummary(
      applicationId,
      authorizationId,
    );
    if (
      grant?.kind !== "background" ||
      grant.taskId !== taskId ||
      grant.resourcePrefix !== resourceId
    )
      return context.json({ code: "not_authorized" }, 403);

    const stepId = digest(JSON.stringify([taskId, resourceId, input])).toString(
      "hex",
    );
    const replay = async () => {
      const receipt = await ledger.authorizedOperation(
        applicationId,
        authorizationId,
        operationId,
      );
      if (!receipt || receipt.state === "reserved") return undefined;
      if (receipt.stepId !== stepId)
        return context.json({ code: "operation_conflict" }, 409);
      const result = replayVectors(receipt);
      if (result)
        return context.json({
          vectors: result,
          receipt: publicReceipt(receipt),
        });
      return context.json(
        {
          code:
            receipt.state === "pending"
              ? "reconciling"
              : "operation_unavailable",
          receipt: publicReceipt(receipt),
        },
        409,
      );
    };
    const invalidAuthorization = (state: "revoked" | "expired") =>
      context.json({ code: `authorization_${state}` }, 410);
    const previous = await replay();
    if (previous) return previous;
    if (grant.state !== "active") return invalidAuthorization(grant.state);

    const selected = await ledger.weknoraQuote(routeId, "embedding");
    if (!selected) return context.json({ code: "route_unavailable" }, 503);
    const { route, quote } = selected;
    if (
      parsed.data.priceVersion &&
      parsed.data.priceVersion !== quote.priceVersion
    )
      return context.json({ code: "price_version_changed" }, 409);
    const binding = { authorizationId, operationId };
    const reservation = await ledger.reserve(
      identity,
      {
        ...binding,
        applicationId,
        resourceId,
        taskId,
        stepId,
        route: route.id,
        priceVersion: quote.priceVersion,
        creditType: grant.creditType,
        resumable: grant.creditType === "test",
      },
      { embedding: true },
    );
    if (reservation.state === "denied") {
      const { reason } = reservation;
      return context.json(
        { code: reason },
        reason === "not_authorized"
          ? 403
          : reason === "insufficient_credits"
            ? 402
            : reason === "execution_limit"
              ? 429
              : 503,
      );
    }
    const { permit } = reservation;
    if (!permit)
      return (
        (await replay()) ?? context.json({ code: "operation_conflict" }, 409)
      );

    let admission:
      | Awaited<ReturnType<TestCreditLedger["beginDispatch"]>>
      | undefined;
    try {
      const result = await execute({
        route,
        input,
        operationId,
        authorizationId,
        async beforeDispatch() {
          admission = await ledger.beginDispatch(
            identity,
            { ...binding, permit },
            { embedding: true },
          );
          return admission.state === "dispatch";
        },
      });
      if (admission?.state !== "dispatch")
        return context.json({ code: "route_unavailable" }, 503);
      const receipt = await ledger.settleEmbedding(
        admission.accountId,
        operationId,
        {
          evidenceId: "weknora-inline",
          outcome: result.outcome === "complete" ? "completed" : "partial",
          inputTokens: BigInt(result.usage.inputTokens),
          outputTokens: 0n,
        },
        result.outcome === "complete" ? result.vectors : undefined,
      );
      if (receipt?.state !== "settled")
        return context.json({ code: "reconciling" }, 409);
      if (result.outcome === "partial")
        return context.json(
          { code: "incomplete_embedding", receipt: publicReceipt(receipt) },
          502,
        );
      return context.json({
        vectors: result.vectors,
        receipt: publicReceipt(receipt),
      });
    } catch (error) {
      if (admission?.state === "existing")
        return (await replay()) ?? context.json({ code: "reconciling" }, 409);
      if (admission?.state === "denied") {
        if (admission.reason === "not_authorized") {
          const current = await ledger.authorizationSummary(
            applicationId,
            authorizationId,
          );
          if (current && current.state !== "active")
            return invalidAuthorization(current.state);
        }
        return context.json(
          { code: admission.reason },
          admission.reason === "not_authorized"
            ? 403
            : admission.reason === "execution_limit"
              ? 429
              : 503,
        );
      }
      if (admission?.state === "dispatch")
        return context.json({ code: "reconciling" }, 409);
      if (
        error instanceof UnsentBifrostRequest &&
        error.reason === "execution_limit"
      )
        return context.json({ code: "execution_limit" }, 413);
      return context.json({ code: "route_unavailable" }, 503);
    }
  });
  api.post("/work", async (context) => {
    const parsed =
      // Platform-funded maintenance omits the person's grant (#110 平台预算).
      (
        maintenanceBudgetId
          ? scope.extend({ authorizationId: id.optional() })
          : scope
      )
        .extend({ operationId: id, input: workInput })
        .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success)
      return context.json({ code: "invalid_work_request" }, 400);
    const { subject, authorizationId, taskId, operationId, input } =
      parsed.data;
    const { kind } = input;
    const path = work?.[kind];
    if (!path) return context.json({ code: "route_unavailable" }, 503);
    const resourceId = weknoraWorkResource(parsed.data.resourceId, kind);
    const platformBudgetId = authorizationId ? undefined : maintenanceBudgetId;
    const identity = authorizationId
      ? await ledger.authorizationIdentity(applicationId, authorizationId)
      : platformMaintenanceIdentity;
    const grant = authorizationId
      ? await ledger.authorizationSummary(applicationId, authorizationId)
      : undefined;
    if (authorizationId) {
      if (
        !identity ||
        identity.issuer !== issuer ||
        identity.subject !== subject ||
        !grant ||
        grant.resourcePrefix !== resourceId ||
        grant.kind !== (kind === "maintenance" ? "background" : "online") ||
        grant.taskId !== (taskId ?? null)
      )
        return context.json({ code: "not_authorized" }, 403);
      if (grant.state !== "active")
        return context.json({ code: `authorization_${grant.state}` }, 410);
    } else {
      // Only maintenance runs on the platform budget, and only when the
      // deployment funds one (#110 平台预算).
      if (kind !== "maintenance" || !platformBudgetId)
        return context.json({ code: "not_authorized" }, 403);
      if (identity.subject !== subject)
        return context.json({ code: "not_authorized" }, 403);
      // A missing budget pauses the charged step like a spent one.
      if (!(await ledger.budget(identity, platformBudgetId)))
        return context.json({ code: "execution_limit" }, 429);
    }
    const creditType: "test" | "paid" = grant ? grant.creditType : "test";

    const stepId = digest(
      JSON.stringify([kind, resourceId, taskId, input]),
    ).toString("hex");
    const replay = async () => {
      const receipt = authorizationId
        ? await ledger.authorizedOperation(
            applicationId,
            authorizationId,
            operationId,
          )
        : await ledger.reconcile(identity, operationId);
      if (!receipt || receipt.state === "reserved") return undefined;
      if (receipt.stepId !== stepId)
        return context.json({ code: "operation_conflict" }, 409);
      let saved: unknown;
      if (receipt.resultText) {
        if (kind === "rerank") {
          try {
            saved = JSON.parse(receipt.resultText);
          } catch {
            return context.json({ code: "operation_unavailable" }, 409);
          }
        } else {
          saved = { text: receipt.resultText };
        }
      }
      const result = workResult.safeParse(saved);
      if (
        receipt.state === "settled" &&
        receipt.outcome === "completed" &&
        result?.success
      )
        return context.json({
          result: result.data,
          receipt: publicReceipt(receipt),
        });
      return context.json(
        {
          code:
            receipt.state === "pending"
              ? "reconciling"
              : "operation_unavailable",
        },
        409,
      );
    };
    const previous = await replay();
    if (previous) return previous;
    const selected = await ledger.weknoraQuote(
      path.routeId,
      kind === "rerank" ? "rerank" : undefined,
    );
    if (!selected) return context.json({ code: "route_unavailable" }, 503);
    const binding = authorizationId
      ? { authorizationId, operationId }
      : { operationId };
    const reservation = await ledger.reserve(
      identity,
      {
        ...binding,
        applicationId,
        resourceId,
        taskId,
        stepId,
        route: selected.route.id,
        priceVersion: selected.quote.priceVersion,
        creditType,
        resumable: false,
        budgetId: platformBudgetId,
      },
      { weknoraWork: kind },
    );
    const deny = (reason: string) =>
      context.json(
        { code: reason },
        reason === "not_authorized"
          ? 403
          : reason === "insufficient_credits"
            ? 402
            : reason === "execution_limit"
              ? 429
              : 503,
      );
    if (reservation.state === "denied") return deny(reservation.reason);
    if (!reservation.permit)
      return (
        (await replay()) ?? context.json({ code: "operation_conflict" }, 409)
      );
    const held = { ...binding, permit: reservation.permit };
    let admission:
      | Awaited<ReturnType<TestCreditLedger["beginDispatch"]>>
      | undefined;
    let bound = false;
    try {
      const completed = await path.execute({
        route: selected.route,
        input,
        operationId,
        async bind(request) {
          admission = await ledger.beginDispatch(identity, held, {
            rerank: kind === "rerank",
          });
          if (admission.state !== "dispatch") return false;
          bound = await ledger.bindGatewayRequest(
            admission.accountId,
            operationId,
            request,
            // Without a grant there is nothing to recheck but the budget.
            authorizationId
              ? { recheckAuthorization: true }
              : { recheckAdmission: true },
          );
          return bound;
        },
      });
      if (admission?.state !== "dispatch" || !bound)
        throw new Error("Missing dispatch.");
      const { accountId } = admission;
      const recorded = await ledger.recordEvidence(accountId, operationId, {
        evidenceId: "weknora-inline",
        outcome: completed.result ? "completed" : "partial",
        inputTokens: completed.inputTokens,
        outputTokens: completed.outputTokens,
        resultText:
          completed.result &&
          ("text" in completed.result
            ? completed.result.text
            : JSON.stringify(completed.result)),
      });
      const receipt =
        recorded && (await ledger.settleRecorded(accountId, operationId));
      if (receipt?.state !== "settled")
        return context.json({ code: "reconciling" }, 409);
      return completed.result
        ? context.json({
            result: completed.result,
            receipt: publicReceipt(receipt),
          })
        : context.json(
            { code: "incomplete_work", receipt: publicReceipt(receipt) },
            502,
          );
    } catch (error) {
      if (bound) return context.json({ code: "reconciling" }, 409);
      if (admission?.state === "existing")
        return (await replay()) ?? context.json({ code: "reconciling" }, 409);
      if (admission?.state === "denied") return deny(admission.reason);
      if (admission?.state === "dispatch")
        await ledger.releaseUnsent(admission.accountId, operationId);
      else if (reservation.state === "reserved")
        await ledger.discardReservation(identity, held);
      return deny(
        error instanceof UnsentBifrostRequest
          ? error.reason
          : "route_unavailable",
      );
    }
  });
  return api;
}
