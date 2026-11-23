import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import {
  type CoordinationToolSpec,
  coordinationCalls,
} from "./coordination-model-call";
import { createCreditPackCheckout } from "./credit-pack-checkout";
import type { CreditPackTestChannel } from "./credit-pack-test-channel";
import type { PaidCreditLedger } from "./paid-ledger";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import { UnsentBifrostRequest } from "./test-credit-bifrost";
import { WEKNORA_APPLICATION_ID } from "./weknora-ingestion";
import { weknoraResourceId } from "./weknora-routes";

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
  // An application's step runs under the person's Spending Authorization for
  // it, within the resource it names, and for a background one its task (#111).
  authorizationId: operationId.optional(),
  resourceId: z.string().min(1).max(512).optional(),
  taskId: operationId.optional(),
  // False for a caller that will not retry this operation by its ID, so an
  // out-of-credits refusal leaves no resume point behind.
  resumable: z.boolean().optional(),
});
const messages = z
  .array(
    z.strictObject({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  )
  .min(1);
// An application dispatches and reconciles through the authorization it reserved under.
const under = operation.extend({ authorizationId: operationId.optional() });
const dispatch = under.extend({ permit: z.uuid(), messages });
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
    calls: coordinationCalls,
    usage,
  }),
  z.object({
    outcome: z.enum(["partial", "cancelled", "platform_failure", "zero_cost"]),
    usage,
  }),
]);

type Variables = {
  identity: VerifiedBillingIdentity;
  // The application an execution call is authenticated as (#111). Absent for
  // a first-party caller.
  application?: string;
};

type Dependencies = {
  ledger: TestCreditLedger;
  // Resolve from an authorized session or an attested execution identity. Never from JSON.
  authenticate(
    request: Request,
    intent: "account" | "execution",
  ): Promise<VerifiedBillingIdentity | undefined>;
  execute?: TestCreditExecutor;
  weknoraRouteId?: string;
  // The paid ledger's read views (#107): absent, `/paid/*` answers 503.
  paid?: {
    ledger: PaidCreditLedger;
    creditPackTestChannel?: CreditPackTestChannel;
  };
  // Whether the caller holds an application's own credential (#111). Absent,
  // a call that names an application answers 503.
  authenticateApplication?(
    request: Request,
    applicationId: string,
  ): Promise<boolean>;
};

export function createTestCreditRoutes({
  ledger,
  authenticate,
  execute,
  paid,
  authenticateApplication,
  weknoraRouteId,
}: Dependencies) {
  const api = new Hono<{ Variables: Variables }>();
  api.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  api.use("*", bodyLimit({ maxSize: 262_144 }));
  const authorize =
    (
      intent: "account" | "execution",
    ): MiddlewareHandler<{ Variables: Variables }> =>
    async (context, next) => {
      const identity = await authenticate(context.req.raw, intent);
      if (!identity)
        return context.json({ error: "Verified identity required." }, 401);
      context.set("identity", identity);
      await next();
    };
  const execution = authorize("execution");
  // A call that names an application (#111) is admitted by that application's
  // own credential and acts only through authorizations granted to it. Any
  // other execution call is a first-party runner's.
  api.use("/v1/*", async (context, next) => {
    const named = context.req.header("x-openbot-application");
    if (named === undefined) return execution(context, next);
    if (!authenticateApplication)
      return context.json({ error: "Application access unavailable." }, 503);
    const id = operationId.safeParse(named);
    if (
      !id.success ||
      !(await authenticateApplication(context.req.raw, id.data))
    )
      return context.json({ error: "Verified application required." }, 401);
    context.set("application", id.data);
    await next();
  });
  api.use("/quote", authorize("account"));
  api.use("/weknora/preview", authorize("account"));
  api.use("/balance", authorize("account"));
  api.use("/claim", authorize("account"));
  api.use("/operations/*", authorize("account"));
  api.use("/paid/*", authorize("account"));
  api.use("/budgets", authorize("account"));
  api.use("/budgets/*", authorize("account"));
  api.use("/resume-points", authorize("account"));
  api.use("/resume-points/*", authorize("account"));
  api.use("/applications", authorize("account"));
  api.use("/authorizations", authorize("account"));
  api.use("/authorizations/*", authorize("account"));
  if (paid?.creditPackTestChannel)
    api.route(
      "/",
      createCreditPackCheckout({
        channel: paid.creditPackTestChannel,
        ledger,
        paid: paid.ledger,
      }),
    );

  api.onError((_error, context) =>
    context.json({ error: "Test Credit service unavailable." }, 503),
  );

  api.get("/budgets", async (context) =>
    context.json(await ledger.budgets(context.var.identity)),
  );

  api.post("/budgets/preview", async (context) => {
    const input = z
      .strictObject({
        creditType: z.enum(["test", "paid"]),
        limitMicrocredits: z.string().regex(/^[1-9]\d{0,17}$/),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success)
      return context.json({ error: "Invalid execution budget." }, 400);
    const [account, quote] = await Promise.all([
      ledger.accountOf(context.var.identity),
      ledger.quote(),
    ]);
    return account && quote
      ? context.json({
          ...quote,
          ...input.data,
          usageDisclosure:
            "Interrupted, cancelled, or failed requests may still use Credits.",
        })
      : context.json({ error: "Billing quote unavailable." }, 404);
  });

  api.post("/budgets", async (context) => {
    const input = z
      .strictObject({
        budgetId: operationId,
        creditType: z.enum(["test", "paid"]),
        limitMicrocredits: z.string().regex(/^[1-9]\d*$/),
        childOf: z
          .strictObject({
            budgetId: operationId,
            kind: z.enum(["delegation", "subagent"]),
            botId: z.string().min(1).max(256),
          })
          .optional(),
        confirmed: z.boolean().optional(),
        modelQuote: z
          .strictObject({
            route: z.string().min(1).max(64),
            priceVersion: z.uuid(),
          })
          .optional(),
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

  api.get("/weknora/preview", async (context) => {
    const quote =
      weknoraRouteId && (await ledger.embeddingQuote(weknoraRouteId));
    if (!quote) return context.json({ code: "route_unavailable" }, 503);
    const grants = await ledger.authorizations(context.var.identity);
    if (!grants)
      return context.json({ code: "billing_account_unavailable" }, 404);
    const authorizationId = context.req.query("authorizationId");
    const authorization = grants.find(
      (grant) =>
        grant.authorizationId === authorizationId &&
        grant.applicationId === WEKNORA_APPLICATION_ID,
    );
    if (authorizationId && !authorization)
      return context.json({ code: "authorization_unavailable" }, 404);
    return context.json({ ...quote.quote, authorization });
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
      .strictObject({
        budgetId: operationId,
        authorizationId: z.uuid().optional(),
        limitMicrocredits: z
          .string()
          .regex(/^[1-9]\d{0,18}$/)
          .refine((limit) => BigInt(limit) <= 9_223_372_036_854_775_807n)
          .optional(),
      })
      .refine(
        ({ authorizationId, limitMicrocredits }) =>
          limitMicrocredits === undefined || authorizationId !== undefined,
      )
      .safeParse(await context.req.json().catch(() => undefined));
    if (!id.success || !body.success)
      return context.json({ error: "Invalid resume confirmation." }, 400);
    const confirmed = await ledger.confirmResumePoint(
      context.var.identity,
      id.data,
      body.data.budgetId,
      body.data.authorizationId,
      body.data.limitMicrocredits === undefined
        ? undefined
        : BigInt(body.data.limitMicrocredits),
    );
    if (!confirmed)
      return context.json({ error: "Resume point unavailable." }, 404);
    return confirmed.state === "confirmed"
      ? context.json(confirmed)
      : context.json({ error: "That budget cannot continue this step." }, 409);
  });

  // The applications that can be given a Spending Authorization (#111).
  api.get("/applications", async (context) =>
    context.json(await ledger.applications()),
  );

  api.get("/authorizations", async (context) => {
    const held = await ledger.authorizations(context.var.identity);
    return held
      ? context.json(held)
      : context.json({ error: "Billing Account unavailable." }, 404);
  });

  // The person's explicit grant to an application (#111).
  api.post("/authorizations", async (context) => {
    const input = z
      .strictObject({
        authorizationId: operationId,
        applicationId: operationId,
        kind: z.enum(["online", "background"]),
        taskId: operationId.optional(),
        resourcePrefix: z.string().min(1).max(512).optional(),
        expiresAt: z.iso.datetime(),
        limitMicrocredits: z.string().regex(/^[1-9]\d*$/),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (
      !input.success ||
      (input.data.applicationId === WEKNORA_APPLICATION_ID &&
        (input.data.kind !== "background" ||
          !z.uuid().safeParse(input.data.authorizationId).success ||
          !weknoraResourceId.safeParse(input.data.resourcePrefix).success))
    )
      return context.json({ error: "Invalid Spending Authorization." }, 400);
    const granted = await ledger.authorize(context.var.identity, {
      ...input.data,
      expiresAt: new Date(input.data.expiresAt),
      limitMicrocredits: BigInt(input.data.limitMicrocredits),
    });
    if (!granted)
      return context.json({ error: "Billing Account unavailable." }, 404);
    return granted.state === "denied"
      ? context.json(
          { error: "That application can't be authorized for this." },
          409,
        )
      : context.json(granted.authorization);
  });

  api.post("/authorizations/:id/revoke", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    if (!id.success)
      return context.json({ error: "Invalid Spending Authorization." }, 400);
    const revoked = await ledger.revokeAuthorization(
      context.var.identity,
      id.data,
    );
    return revoked
      ? context.json(revoked)
      : context.json({ error: "Spending Authorization unavailable." }, 404);
  });

  // Raising a limit or extending an authorization is the person's own doing.
  api.post("/authorizations/:id/amend", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    const body = z
      .strictObject({
        limitMicrocredits: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        expiresAt: z.iso.datetime().optional(),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!id.success || !body.success)
      return context.json({ error: "Invalid Spending Authorization." }, 400);
    const amended = await ledger.amendAuthorization(
      context.var.identity,
      id.data,
      {
        ...(body.data.limitMicrocredits === undefined
          ? {}
          : { limitMicrocredits: BigInt(body.data.limitMicrocredits) }),
        ...(body.data.expiresAt === undefined
          ? {}
          : { expiresAt: new Date(body.data.expiresAt) }),
      },
    );
    if (!amended)
      return context.json(
        { error: "Spending Authorization unavailable." },
        404,
      );
    return amended.state === "amended"
      ? context.json(amended.authorization)
      : context.json(
          { error: "A Spending Authorization can only be raised or extended." },
          409,
        );
  });

  // The publication an execution caller pins its reservation to (#107).
  api.get("/v1/quote", async (context) => {
    const quote = await ledger.quote();
    return quote
      ? context.json(quote)
      : context.json({ error: "Model route unavailable." }, 404);
  });

  // An application acts for the person who granted it the authorization it
  // names, and only as that application (#111).
  const actingAs = async (
    context: Context<{ Variables: Variables }>,
    authorizationId: string | undefined,
  ) => {
    const application = context.var.application;
    if (application === undefined)
      return { state: "identity" as const, identity: context.var.identity };
    if (!authorizationId)
      return { state: "refused" as const, status: 400 as const };
    const identity = await ledger.authorizationIdentity(
      application,
      authorizationId,
    );
    return identity
      ? { state: "identity" as const, identity }
      : { state: "refused" as const, status: 401 as const };
  };
  const refused = (
    context: Context<{ Variables: Variables }>,
    status: 400 | 401,
  ) =>
    status === 400
      ? context.json({ error: "Invalid request." }, 400)
      : context.json({ error: "Verified identity required." }, 401);

  api.post("/v1/reserve", async (context) => {
    const input = reserve.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid reservation." }, 400);
    const acting = await actingAs(context, input.data.authorizationId);
    if (acting.state === "refused") return refused(context, acting.status);
    return context.json(
      await ledger.reserve(
        acting.identity,
        context.var.application === undefined
          ? input.data
          : { ...input.data, applicationId: context.var.application },
      ),
    );
  });

  // What an application may read: only through its own authorizations (#111).
  api.get("/v1/spending-authorizations/:id", async (context) => {
    const id = operationId.safeParse(context.req.param("id"));
    const summary =
      id.success && context.var.application !== undefined
        ? await ledger.authorizationSummary(context.var.application, id.data)
        : undefined;
    return summary
      ? context.json(summary)
      : context.json({ error: "Spending Authorization unavailable." }, 404);
  });

  api.get(
    "/v1/spending-authorizations/:id/operations/:operationId",
    async (context) => {
      const id = operationId.safeParse(context.req.param("id"));
      const operation = operationId.safeParse(context.req.param("operationId"));
      const receipt =
        id.success &&
        operation.success &&
        context.var.application !== undefined &&
        (await ledger.authorizedOperation(
          context.var.application,
          id.data,
          operation.data,
        ));
      return receipt
        ? context.json(receipt)
        : context.json({ error: "Operation unavailable." }, 404);
    },
  );

  api.post("/v1/dispatch", async (context) => {
    const input = dispatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid dispatch." }, 400);
    const acting = await actingAs(context, input.data.authorizationId);
    if (acting.state === "refused") return refused(context, acting.status);
    // A read-only mount cannot transition a reservation to pending.
    const outcome = await dispatchTestCredit({
      ledger,
      execute,
      identity: acting.identity,
      input: input.data,
    });
    return outcome.state === "executor_unavailable"
      ? context.json({ error: "Execution unavailable." }, 503)
      : context.json(outcome);
  });

  api.post("/v1/reconcile", async (context) => {
    const input = under.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json({ error: "Invalid reconciliation." }, 400);
    const acting = await actingAs(context, input.data.authorizationId);
    if (acting.state === "refused") return refused(context, acting.status);
    const receipt = await ledger.reconcile(
      acting.identity,
      input.data.operationId,
      input.data.authorizationId,
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

export type TestCreditExecutor = (input: {
  operationId: string;
  accountId: string;
  route: ReleasedBifrostRoute;
  messages: z.infer<typeof messages>;
  coordinationTools?: readonly CoordinationToolSpec[];
  recheckRoute(): Promise<boolean>;
  bindGatewayRequest(request: {
    requestId: string;
    digest: string;
  }): Promise<boolean>;
}) => Promise<unknown>;

export async function dispatchTestCredit({
  ledger,
  execute,
  identity,
  input,
  authorizeDispatch,
  coordinationTools,
}: {
  ledger: TestCreditLedger;
  execute?: TestCreditExecutor;
  identity: VerifiedBillingIdentity;
  input: z.infer<typeof dispatch>;
  authorizeDispatch?: () => Promise<boolean>;
  coordinationTools?: readonly CoordinationToolSpec[];
}) {
  const admission = await ledger.beginDispatch(identity, input, {
    executorAvailable: execute !== undefined,
  });
  if (admission.state === "denied" || admission.state === "existing")
    return admission;
  if (admission.state === "executor_unavailable" || !execute)
    return { state: "executor_unavailable" } as const;
  try {
    const completed = result.parse(
      await execute({
        accountId: admission.accountId,
        operationId: input.operationId,
        route: admission.route,
        recheckRoute: () => ledger.routeStillEligible(admission.route),
        bindGatewayRequest: async (request) => {
          if (
            authorizeDispatch &&
            !(await authorizeDispatch().catch(() => false))
          )
            throw new UnsentBifrostRequest("route_unavailable");
          const bound = await ledger.bindGatewayRequest(
            admission.accountId,
            input.operationId,
            request,
            { recheckAdmission: authorizeDispatch !== undefined },
          );
          if (!bound && authorizeDispatch)
            throw new UnsentBifrostRequest("route_unavailable");
          return bound;
        },
        messages: input.messages,
        coordinationTools,
      }),
    );
    const recorded = await ledger.recordEvidence(
      admission.accountId,
      input.operationId,
      {
        evidenceId: "inline-completion",
        outcome:
          "outcome" in completed
            ? (completed.outcome ?? "completed")
            : "completed",
        inputTokens: BigInt(completed.usage.inputTokens),
        outputTokens: BigInt(completed.usage.outputTokens),
        resultText: "text" in completed ? completed.text : undefined,
        resultCalls:
          coordinationTools?.length && "calls" in completed
            ? completed.calls
            : undefined,
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
