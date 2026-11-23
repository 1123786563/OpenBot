import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { TestCreditLedger } from "./test-credit";
import { UnsentBifrostRequest } from "./test-credit-bifrost";
import type { createBifrostEmbeddingExecutor } from "./test-credit-embedding-bifrost";
import { WEKNORA_APPLICATION_ID as applicationId } from "./weknora-ingestion";

const id = z.uuid();
export const weknoraResourceId = z
  .string()
  .regex(/^weknora:tenant:[0-9]+:kb:[a-zA-Z0-9_-]{1,128}$/);
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
  routeId: string;
  execute: ReturnType<typeof createBifrostEmbeddingExecutor>;
};

export function createWeKnoraRoutes({
  issuer,
  serviceToken,
  routeId,
  execute,
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

    const selected = await ledger.embeddingQuote(routeId);
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
        creditType: "test",
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
  return api;
}
