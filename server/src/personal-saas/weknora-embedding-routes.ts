import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import type { TestCreditLedger } from "../billing/test-credit";
import { UnsentBifrostRequest } from "../billing/test-credit-bifrost";

const payload = z.strictObject({
  subject: z.string().min(1).max(256),
  authorizationId: z.uuid(),
  resourceId: z.string().min(1).max(256),
  operationId: z.uuid(),
  input: z.array(z.string().min(1)).min(1).max(32),
});
const digest = (value: string) => createHash("sha256").update(value).digest();

type Usage = { inputTokens: number; outputTokens: 0 };
export type WeKnoraEmbeddingExecutor = (request: {
  route: ReleasedBifrostRoute;
  input: readonly string[];
  operationId: string;
  beforeDispatch: (proof: { requestId: string }) => Promise<boolean>;
}) => Promise<
  | { outcome: "complete"; usage: Usage; vectors: number[][] }
  | { outcome: "partial"; usage: Usage }
>;

export function weknoraEmbeddingRoutes({
  issuer,
  serviceToken,
  routeId,
  execute,
  ledger,
}: {
  issuer: string;
  serviceToken: string;
  routeId: string;
  execute: WeKnoraEmbeddingExecutor;
  ledger: TestCreditLedger;
}) {
  const routes = new Hono();
  const expected = digest(`Bearer ${serviceToken}`);
  routes.use(async (context, next) => {
    const credential = context.req.header("authorization");
    if (!credential || !timingSafeEqual(expected, digest(credential)))
      return context.json({ error: "service_authentication_required" }, 401);
    await next();
  });
  routes.use(bodyLimit({ maxSize: 256 * 1024 }));
  routes.post("/", async (context) => {
    context.header("Cache-Control", "no-store");
    const parsed = payload.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "invalid_embedding_request" }, 400);
    const { subject, authorizationId, resourceId, operationId, input } =
      parsed.data;
    const identity = { issuer, subject };
    const scope = {
      application: "weknora" as const,
      authorizationId,
      resourceId,
    };
    const inputDigest = digest(JSON.stringify(input)).toString("hex");
    const replay = () =>
      ledger.embeddingReplay(identity, { scope, operationId, inputDigest });
    const previous = await replay();
    if (previous?.state === "completed")
      return context.json({
        vectors: previous.vectors,
        receipt: previous.receipt,
      });
    if (previous) return context.json({ error: "operation_conflict" }, 409);

    const available = await ledger.embeddingRoute(routeId);
    if (!available) return context.json({ error: "route_unavailable" }, 503);
    const { route, priceVersion } = available;
    const binding = { scope, operationId, embeddingInputDigest: inputDigest };
    const admission = await ledger.reserve(identity, {
      ...binding,
      route: route.id,
      priceVersion,
    });
    if (admission.state === "denied") {
      const status =
        admission.reason === "insufficient_credits"
          ? 402
          : admission.reason === "not_authorized"
            ? 403
            : 503;
      return context.json({ error: admission.reason }, status);
    }
    if (!admission.permit) {
      const concurrent = await replay();
      if (concurrent?.state === "completed")
        return context.json({
          vectors: concurrent.vectors,
          receipt: concurrent.receipt,
        });
      return context.json({ error: "operation_conflict" }, 409);
    }
    const permit = admission.permit;
    let dispatch: { accountId: string; evidenceId: string } | undefined;
    let blocked:
      | "not_authorized"
      | "route_unavailable"
      | "operation_conflict"
      | undefined;
    try {
      const result = await execute({
        route,
        input,
        operationId,
        async beforeDispatch({ requestId }) {
          const result = await ledger.beginDispatch(identity, {
            ...binding,
            permit,
          });
          if (result.state !== "dispatch") {
            blocked =
              result.state === "existing"
                ? "operation_conflict"
                : result.reason === "not_authorized"
                  ? "not_authorized"
                  : "route_unavailable";
            return false;
          }
          dispatch = { accountId: result.accountId, evidenceId: requestId };
          return true;
        },
      });
      if (!dispatch) return context.json({ error: "route_unavailable" }, 503);
      const receipt = await ledger.settleEmbedding(
        dispatch.accountId,
        operationId,
        {
          evidenceId: dispatch.evidenceId,
          inputTokens: BigInt(result.usage.inputTokens),
          ...(result.outcome === "complete" && { vectors: result.vectors }),
        },
      );
      if (!receipt)
        return context.json({ error: "embedding_outcome_uncertain" }, 409);
      if (result.outcome === "partial")
        return context.json({ error: "incomplete_embedding", receipt }, 502);
      return context.json({ vectors: result.vectors, receipt });
    } catch (error) {
      if (blocked) {
        const concurrent = await replay();
        if (concurrent?.state === "completed")
          return context.json({
            vectors: concurrent.vectors,
            receipt: concurrent.receipt,
          });
        const status =
          blocked === "operation_conflict"
            ? 409
            : blocked === "not_authorized"
              ? 403
              : 503;
        return context.json({ error: blocked }, status);
      }
      if (error instanceof UnsentBifrostRequest && !dispatch)
        return context.json(
          { error: error.reason },
          error.reason === "execution_limit" ? 413 : 503,
        );
      return context.json(
        {
          error: dispatch ? "embedding_outcome_uncertain" : "route_unavailable",
        },
        dispatch ? 409 : 503,
      );
    }
  });
  return routes;
}
