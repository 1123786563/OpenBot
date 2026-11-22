import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import type { PaidCreditLedger } from "./paid-ledger";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import { UnsentBifrostRequest } from "./test-credit-bifrost";

const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const operation = z.strictObject({ operationId });
const reserve = operation.extend({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
  rerunOfOperationId: operationId.optional(),
  budgetId: operationId.optional(),
  stepId: operationId.optional(),
  // Which entry the caller chose (#107); absent spans both Credit types.
  creditType: z.enum(["test", "paid"]).optional(),
  // The app the step runs for, kept on the operation and its bill lines.
  applicationId: operationId.optional(),
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
  // Absent, the execution endpoints answer 503: a deployment that only shows balances and budgets
  // mounts the views without one.
  execute?(input: {
    operationId: string;
    accountId: string;
    route: ReleasedBifrostRoute;
    messages: z.infer<typeof messages>;
    recheckRoute(): Promise<boolean>;
  }): Promise<unknown>;
  // The paid ledger's read views (#107): absent, `/paid/*` answers 503.
  paid?: { ledger: PaidCreditLedger };
};

export function createTestCreditRoutes({
  ledger,
  authenticate,
  execute,
  paid,
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
  api.use("/paid/*", authorize("account"));
  api.use("/budgets", authorize("account"));
  api.use("/budgets/*", authorize("account"));
  api.use("/resume-points", authorize("account"));
  api.use("/resume-points/*", authorize("account"));
  api.onError((_error, context) =>
    context.json({ error: "Test Credit service unavailable." }, 503),
  );

  api.get("/budgets", async (context) =>
    context.json(await ledger.budgets(context.var.identity)),
  );

  api.post("/budgets", async (context) => {
    const input = z
      .strictObject({
        budgetId: operationId,
        creditType: z.enum(["test", "paid"]),
        limitMicrocredits: z.string().regex(/^[1-9]\d*$/),
        confirmed: z.boolean().optional(),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success)
      return context.json({ error: "Invalid execution budget." }, 400);
    const budget = await ledger.createBudget(context.var.identity, {
      ...input.data,
      limitMicrocredits: BigInt(input.data.limitMicrocredits),
    });
    return budget
      ? context.json(budget)
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  api.post("/budgets/:id/confirm", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    const body = z
      .strictObject({
        limitMicrocredits: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!id.success || !body.success)
      return context.json(
        { error: "Invalid execution budget confirmation." },
        400,
      );
    const budget = await ledger.confirmBudget(
      context.var.identity,
      id.data,
      body.data.limitMicrocredits === undefined
        ? undefined
        : BigInt(body.data.limitMicrocredits),
    );
    return budget
      ? context.json(budget)
      : context.json({ error: "Execution budget unavailable." }, 404);
  });

  api.get("/budgets/:id", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    if (!id.success)
      return context.json({ error: "Invalid execution budget." }, 400);
    const budget = await ledger.budget(context.var.identity, id.data);
    return budget
      ? context.json(budget)
      : context.json({ error: "Execution budget unavailable." }, 404);
  });

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

  // The paid side of the bill (#107): per-source balances and the lines
  // booked against each source. Both stay separate from the Test Credit
  // balance above.
  api.get("/paid/sources", async (context) => {
    if (!paid) return context.json({ error: "Paid credits unavailable." }, 503);
    const accountId = await ledger.accountOf(context.var.identity);
    return accountId
      ? context.json(await paid.ledger.paidSources(accountId))
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  api.get("/paid/bill", async (context) => {
    if (!paid) return context.json({ error: "Paid credits unavailable." }, 503);
    const accountId = await ledger.accountOf(context.var.identity);
    return accountId
      ? context.json(await paid.ledger.bill(accountId))
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  api.get("/paid/balance", async (context) => {
    if (!paid) return context.json({ error: "Paid credits unavailable." }, 503);
    const accountId = await ledger.accountOf(context.var.identity);
    return accountId
      ? context.json(await paid.ledger.paidBalance(accountId))
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  // The steps paused for want of credits or a budget (#107 安全续做点). A
  // runner retries the same operation; it reserves on the confirmed budget.
  api.get("/resume-points", async (context) => {
    const points = await ledger.resumePoints(context.var.identity);
    return points
      ? context.json(points)
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  api.post("/resume-points/:operationId/confirm", async (context) => {
    const id = operationId.safeParse(context.req.param("operationId"));
    const body = z
      .strictObject({ budgetId: operationId })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!id.success || !body.success)
      return context.json({ error: "Invalid resume confirmation." }, 400);
    const confirmed = await ledger.confirmResumePoint(
      context.var.identity,
      id.data,
      body.data.budgetId,
    );
    if (!confirmed)
      return context.json({ error: "Resume point unavailable." }, 404);
    return confirmed.state === "confirmed"
      ? context.json(confirmed)
      : context.json({ error: "That budget cannot continue this step." }, 409);
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
    const admission = await ledger.beginDispatch(
      context.var.identity,
      input.data,
    );
    if (admission.state === "denied") return context.json(admission);
    if (admission.state === "existing") {
      return context.json({
        state: "existing",
        operation: admission.operation,
      });
    }
    if (!execute) return context.json({ error: "Execution unavailable." }, 503);
    try {
      const completed = result.parse(
        await execute({
          accountId: admission.accountId,
          operationId: input.data.operationId,
          route: admission.route,
          recheckRoute: () => ledger.routeStillEligible(admission.route),
          messages: input.data.messages,
        }),
      );
      if ("text" in completed)
        await ledger.recordResult(
          admission.accountId,
          input.data.operationId,
          completed.text,
        );
      const recorded = await ledger.recordEvidence(
        admission.accountId,
        input.data.operationId,
        {
          evidenceId: "inline-completion",
          outcome: completed.outcome ?? "completed",
          inputTokens: BigInt(completed.usage.inputTokens),
          outputTokens: BigInt(completed.usage.outputTokens),
        },
      );
      const receipt =
        recorded &&
        (await ledger.settleRecorded(
          admission.accountId,
          input.data.operationId,
        ));
      if (receipt && "text" in completed)
        return context.json({
          state: "completed",
          text: completed.text,
          operation: receipt,
        });
      if (receipt)
        return context.json({ state: receipt.state, operation: receipt });
    } catch (error) {
      if (error instanceof UnsentBifrostRequest) {
        await ledger.releaseUnsent(admission.accountId, input.data.operationId);
        return context.json({ state: "denied", reason: error.reason });
      }
      // The permit was consumed durably. A retry must never resend this operation.
    }
    return context.json({ state: "reconciling" });
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
