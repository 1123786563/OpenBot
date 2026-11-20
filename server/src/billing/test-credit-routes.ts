import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";

const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const operation = z.strictObject({ operationId });
const reserve = operation.extend({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
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
const result = z.object({
  text: z.string().trim().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

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
  }): Promise<unknown>;
};

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
    try {
      const completed = result.parse(
        await execute({
          accountId: admission.accountId,
          operationId: input.data.operationId,
          route: admission.route,
          messages: input.data.messages,
        }),
      );
      const receipt = await ledger.settle(
        admission.accountId,
        input.data.operationId,
        {
          inputTokens: BigInt(completed.usage.inputTokens),
          outputTokens: BigInt(completed.usage.outputTokens),
        },
      );
      if (receipt)
        return context.json({
          state: "completed",
          text: completed.text,
          operation: receipt,
        });
    } catch {
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
    const receipt = await ledger.receipt(
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
