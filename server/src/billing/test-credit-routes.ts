import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import { UnsentBifrostRequest } from "./test-credit-bifrost";

const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const operation = z.strictObject({ operationId });
const reserve = operation.extend({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
  rerunOfOperationId: operationId.optional(),
});
const messages = z
  .array(
    z.strictObject({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  )
  .min(1);
const dispatch = operation.extend({ permit: z.uuid(), messages });
const usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const result = z.union([
  z.object({
    outcome: z.literal("completed").optional(),
    text: z.string().trim().min(1),
    usage,
  }),
  z.object({
    outcome: z.enum(["partial", "cancelled", "platform_failure", "zero_cost"]),
    usage,
  }),
]);

type Dependencies = {
  ledger: TestCreditLedger;
  // Resolve from an authorized session or an attested execution identity. Never from JSON.
  authenticate(
    request: Request,
    intent: "account" | "execution",
  ): Promise<VerifiedBillingIdentity | undefined>;
  // The controlled executor must enforce the frozen route's caps before sending and must never retry.
  execute(input: {
    operationId: string;
    accountId: string;
    route: ReleasedBifrostRoute;
    messages: z.infer<typeof messages>;
    recheckRoute(): Promise<boolean>;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

export type TestCreditExecutor = Dependencies["execute"];

export async function dispatchTestCredit({
  ledger,
  execute,
  identity,
  input,
  maySend,
  signal,
}: {
  ledger: TestCreditLedger;
  execute: TestCreditExecutor;
  identity: VerifiedBillingIdentity;
  input: z.infer<typeof dispatch>;
  maySend?: () => Promise<boolean>;
  signal?: AbortSignal;
}) {
  const admission = await ledger.beginDispatch(identity, input);
  if (admission.state === "denied") return admission;
  if (admission.state === "existing") {
    return {
      state: "existing",
      operation: admission.operation,
    } as const;
  }
  try {
    const completed = result.parse(
      await execute({
        accountId: admission.accountId,
        operationId: input.operationId,
        route: admission.route,
        async recheckRoute() {
          return (
            (await ledger.routeStillEligible(admission.route)) &&
            (!maySend || (await maySend()))
          );
        },
        messages: input.messages,
        signal,
      }),
    );
    const recorded = await ledger.recordEvidence(
      admission.accountId,
      input.operationId,
      {
        evidenceId: "inline-completion",
        outcome: completed.outcome ?? "completed",
        inputTokens: BigInt(completed.usage.inputTokens),
        outputTokens: BigInt(completed.usage.outputTokens),
      },
    );
    const receipt =
      recorded &&
      (await ledger.settleRecorded(admission.accountId, input.operationId));
    if (receipt && "text" in completed)
      return {
        state: "completed",
        text: completed.text,
        operation: receipt,
      } as const;
    if (receipt) return { state: receipt.state, operation: receipt };
  } catch (error) {
    if (error instanceof UnsentBifrostRequest) {
      await ledger.releaseUnsent(admission.accountId, input.operationId);
      return { state: "denied", reason: error.reason } as const;
    }
    // The permit was consumed durably. A retry must never resend this operation.
  }
  return { state: "reconciling" } as const;
}

export function createTestCreditRoutes({
  ledger,
  authenticate,
  execute,
}: Dependencies) {
  const api = new Hono<{ Variables: { identity: VerifiedBillingIdentity } }>();
  api.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  api.use("*", bodyLimit({ maxSize: 262_144 }));
  const authorize =
    (
      intent: "account" | "execution",
    ): MiddlewareHandler<{
      Variables: { identity: VerifiedBillingIdentity };
    }> =>
    async (context, next) => {
      const identity = await authenticate(context.req.raw, intent);
      if (!identity)
        return context.json({ error: "Verified identity required." }, 401);
      context.set("identity", identity);
      await next();
    };
  api.use("/v1/*", authorize("execution"));
  api.use("/quote", authorize("account"));
  api.use("/balance", authorize("account"));
  api.use("/claim", authorize("account"));
  api.use("/operations/*", authorize("account"));
  api.onError((_error, context) =>
    context.json({ error: "Test Credit service unavailable." }, 503),
  );

  api.get("/quote", async (context) => {
    const quote = await ledger.quote();
    return quote
      ? context.json(quote)
      : context.json({ error: "Model route unavailable." }, 404);
  });

  api.get("/balance", async (context) => {
    const balance = await ledger.balance(context.var.identity);
    return balance
      ? context.json(balance)
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  api.post("/claim", async (context) => {
    const input = z
      .strictObject({ batchId: z.uuid() })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success)
      return context.json({ error: "Invalid batch claim." }, 400);
    const claim = await ledger.claim(context.var.identity, input.data.batchId);
    return claim
      ? context.json(claim)
      : context.json({ error: "Batch unavailable." }, 404);
  });

  api.get("/operations/:id", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    if (!id.success)
      return context.json({ error: "Invalid operation ID." }, 400);
    const receipt = await ledger.receipt(context.var.identity, id.data);
    return receipt
      ? context.json(receipt)
      : context.json({ error: "Operation unavailable." }, 404);
  });

  api.post("/v1/reserve", async (context) => {
    const input = reserve.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid reservation." }, 400);
    return context.json(await ledger.reserve(context.var.identity, input.data));
  });

  api.post("/v1/dispatch", async (context) => {
    const input = dispatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid dispatch." }, 400);
    return context.json(
      await dispatchTestCredit({
        ledger,
        execute,
        identity: context.var.identity,
        input: input.data,
      }),
    );
  });

  api.post("/v1/reconcile", async (context) => {
    const input = operation.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid reconciliation." }, 400);
    const receipt = await ledger.reconcile(
      context.var.identity,
      input.data.operationId,
    );
    return context.json({
      state:
        receipt?.state === "reserved"
          ? "pending"
          : (receipt?.state ?? "absent"),
      operation: receipt,
    });
  });

  return api;
}
