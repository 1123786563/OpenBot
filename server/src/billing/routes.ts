/**
 * The billing module's whole HTTP surface: three factories, one per audience.
 *
 * The webhook factory mounts nothing but the provider's delivery endpoint — no session, because the
 * caller is the provider, whose whole credential is the signature the service verifies against the
 * raw body (the same shape as the delivery lane's webhook routes). The person-facing factory mounts
 * the entitlement read behind `requireUser`. The admin factory mounts the snapshot and the sync
 * behind `requireUser` *and* an in-handler `requireAdmin`, the same double layer as
 * `/api/admin/package`: the enterprise gate passes an unmatched `/api/admin/billing` path straight
 * through (admin/gate.ts), and `requireAdmin` alone would read `context.var.actor.role` on a request
 * that never authenticated — a TypeError and a 500, not a 401.
 *
 * Error answers are built from the seam's sentinel codes, never from an error's own message: a
 * `BillingError` carries its code and nothing else by construction, and the fallbacks here keep that
 * property on the paths the seam does not own (a parse failure, an unexpected throw), so no URL, no
 * status line and no credential can reach a response body through this file.
 */

import { createHash } from "node:crypto";
import { asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/public";
import type { Database } from "../db/client";
import { auditEvents, users } from "../db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
} from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import type { Credits } from "./credits";
import type { CreditWriter } from "./credits-writer";
import {
  findForeignAccountIdentity,
  PayerCrossAccountAccessError,
  resolvePayerForPersonalUser,
  resolvePersonalPayerAccount,
} from "./payer-personal";
import type { PaymentOrderReadScope } from "./payments/types";
// MOD10（Issue #630）：组内公开门面的能力面类型（仅类型；运行时零依赖）。
import type {
  BillingAccountQuery,
  BillingEntitlementDelivery,
  BillingResolvePayer,
} from "./public";
import type { RealtimeUsageReader } from "./realtime-usage";
// The reasons list is used only as a type here (`typeof` for the status map's key union).
import type { DISPOSAL_REFUSAL_REASONS } from "./recovery-disposal";
import {
  createRecoveryDisposal,
  DISPOSAL_REFUSAL_SENTENCES,
} from "./recovery-disposal";
import {
  REWARD_TYPES,
  type RewardGranter,
  rewardDefinitions,
  rewardPeriodOfDay,
} from "./rewards";
import type { BillingStatements } from "./statements";
import { BillingError, type BillingService } from "./types";
import type {
  AsyncJobDisplayState,
  AsyncJobsViewReader,
} from "./async-jobs-view";

/** The shape `requireAdmin` takes in auth/guards.ts: a refusal answer, or nothing to add. */
type RequireAdmin = (
  context: Context<{ Variables: AppVariables }>,
) => Response | undefined;

export function billingReadScopeOf(
  context: Context<{ Variables: AppVariables }>,
  // MOD10（Issue #630）C1：可选经公开门面的 `resolvePayer.personal`（薄委托同一
  // 纯函数）；缺省回退直用内件——两条臂行为等价（双路先例：MOD06 conversation
  // routes、MOD05 team-bots routes）。Payer 解析仍是纯函数，不打开映射行。
  resolvePayer?: Pick<BillingResolvePayer, "personal">,
): PaymentOrderReadScope {
  // The reading actor's own personal PayerRef, resolved from the session — never from a
  // request field (AC14/Q27). Order reads filter on the order's owner columns against this
  // ref, so another person's order — and any quarantined or pre-attribution row — is simply
  // not in the answer.
  const personal = resolvePayer?.personal ?? resolvePayerForPersonalUser;
  return { actorPayerRef: personal(context.var.actor) };
}

/**
 * The provider's deliveries. One route, no session, no body-parsing middleware: the service reads
 * the raw request itself, exactly once and capped, because a signature is over the bytes that
 * arrived.
 */
export function createBillingWebhookRoutes(deps: { service: BillingService }) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/lago", (context) =>
    deps.service.handleWebhook(context.req.raw),
  );
  return routes;
}

/**
 * What a signed-in person may ask about their deployment's billing state.
 *
 * The entitlements answer carries the plan code, the plan's entries and the subscription's own
 * status and period — the facts 套餐与积分 renders. The provider's metered-usage reads that used to
 * ride beside it (`/usage`, `/usage/events`, `/usage/daily`) went with the old 用量 screens: no
 * page asks them any more, so the surface does not carry them.
 */
export function createBillingRoutes(deps: {
  service: BillingService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * MOD10（Issue #630）C2：权益交付门面（可选）。生产装配注入
   * `entitlementDelivery` 后本 handler 经门面读；缺省回退直用 `service`
   * （存量两参调用方与两臂行为等价——双路先例）。
   */
  entitlementDelivery?: Pick<BillingEntitlementDelivery, "entitlements">;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    // Same contract as the sibling factories: an outage is a fixed sentence, never a stack.
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });
  routes.get("/entitlements", async (context) => {
    const entitlements = await (
      deps.entitlementDelivery ?? deps.service
    ).entitlements();
    return context.json({
      active: entitlements.active,
      ...(entitlements.planCode !== undefined
        ? { planCode: entitlements.planCode }
        : {}),
      codes: entitlements.codes,
      subscription: entitlements.subscription ?? null,
    });
  });
  return routes;
}

/**
 * The statement reads: 套餐用量 and the bill list.
 *
 * Mounted on the same `/api/billing` prefix as the entitlement read, under the same session, and
 * registered BEFORE any parametric segment that could swallow them — the same ordering fact the
 * payment group's header records. `plan-usage` and `invoices` are static paths on a group whose
 * only other segment is static too, but the next person to add `/invoices/:id` will be glad the
 * shape was already right.
 *
 * The window is the caller's, the page size is not: `from`/`to`/`page` come from the query, 20
 * bills at a time do not. A bad date is a 400 with a sentence of ours; a page past the end is an
 * empty page, because a pager that walked off the end is not a client that misbehaved.
 */
const statementQueryInput = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** Exported for the route tests, which assert the window's own grammar. */
export { statementQueryInput };

export function createBillingStatementRoutes(deps: {
  statements: BillingStatements;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * MOD10（Issue #630）C3：账务查询门面的 statements 三读（可选）。注入后
   * 三 handler 经门面；缺省回退直用 `statements`（两臂行为等价）。
   */
  accountQuery?: Pick<BillingAccountQuery, "planUsage" | "invoices" | "invoice">;
  /** MOD10 C1 双路：读作用域的 Payer 解析经门面 `resolvePayer.personal`。 */
  resolvePayer?: Pick<BillingResolvePayer, "personal">;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });

  routes.get("/plan-usage", async (context) => {
    return context.json(
      await (deps.accountQuery ?? deps.statements).planUsage(),
    );
  });

  routes.get("/invoices", async (context) => {
    const parsed = statementQueryInput.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
      page: context.req.query("page") ?? "1",
    });
    if (!parsed.success) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json(
      await (deps.accountQuery ?? deps.statements).invoices(
        {
          from: parsed.data.from ? new Date(parsed.data.from) : null,
          to: parsed.data.to ? new Date(parsed.data.to) : null,
          page: parsed.data.page,
        },
        billingReadScopeOf(context, deps.resolvePayer),
      ),
    );
  });

  routes.get("/invoices/:id", async (context) => {
    const invoice = await (deps.accountQuery ?? deps.statements).invoice(
      context.req.param("id"),
      billingReadScopeOf(context, deps.resolvePayer),
    );
    if (!invoice) {
      return context.json({ error: "No such bill." }, 404);
    }
    return context.json({ invoice });
  });

  return routes;
}

/**
 * The credit-ledger reads: 套餐与积分.
 *
 * Mounted on the same `/api/billing` prefix under the same session, in the same spirit as the
 * statement reads beside it — but from a different source: the local credit ledger, not the
 * provider's reader and not the payment order table.
 *
 * Every read answers ONE account: the signed-in user's own, resolved server-side from the
 * authenticated identity through the payer resolution module (ticket 02.6). No route below takes
 * an account parameter and none falls back to the deployment key: `/credits/summary` is the
 * personal balance read — account type, available/consumed/expired and held, every grant with
 * its derived life, and the pending-settlement placeholders (constant zeros behind an explicit
 * not-enabled marker until group 06) — while `grants` is the reward list and `consumption` the
 * ledger with the same window/page grammar as the bill list. The path is read-only by
 * construction: resolution is the payer module's pure function (no mapping row is opened by a
 * read) and every query beneath it is a SELECT.
 *
 * One refusal comes before any read (ticket 02.4): a request that carries an account identity
 * (`userId`, `externalCustomerId`, `payerId`, `accountId`, `companyId`, `tenantId`, any casing)
 * is answered 400, never an empty result — the account these reads answer is decided server-side
 * from the session, so a client naming an account is a forgery attempt, not a filter.
 * Authentication still wins: the identity check sits behind `requireUser`, so an unauthenticated
 * caller sees 401.
 */
export function createBillingCreditRoutes(deps: {
  credits: Credits;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** The reward claim's write side (10.4): absent answers 503, never a fallback. */
  rewards?: RewardGranter;
  audit?: AuditStore;
  /** The claim clock — the period is this answer, never a client field. */
  now?: () => Date;
  /**
   * 15.8's realtime session consumption read (the 套餐与积分 page's realtime rows).
   * Absent answers 503, never a fallback — the same rule the reward claim keeps.
   */
  realtimeUsage?: RealtimeUsageReader;
  /**
   * 17.8's async jobs read (the person's own jobs with status, reason and amounts).
   * Absent answers 503, never a fallback — the same rule every optional read here keeps.
   */
  asyncJobsView?: AsyncJobsViewReader;
  /**
   * MOD10（Issue #630）C4/C5：账务查询门面（可选）。生产装配注入后六读 handler
   * 改经门面；缺省回退直用 `credits`/`realtimeUsage`/`asyncJobsView`（存量
   * 调用方与两臂行为等价，双路先例）。503 准入检查仍读上面的原件缺席，
   * 逐字节不动。
   */
  accountQuery?: Pick<
    BillingAccountQuery,
    | "catalog"
    | "personalBalance"
    | "grants"
    | "consumption"
    | "realtimeSessionsForPayer"
    | "asyncJobsForPayer"
  >;
  /** MOD10 C1 双路：Payer 解析经门面 `resolvePayer.personal`。 */
  resolvePayer?: Pick<BillingResolvePayer, "personal">;
}) {
  // OCR r2 M-4：门面回退常量在工厂顶解一次，五条路由共用同一解析臂（行为等价）。
  const resolvePersonalPayer =
    deps.resolvePayer?.personal ?? resolvePayerForPersonalUser;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.use("*", async (context, next) => {
    const identity = findForeignAccountIdentity(context.req.query());
    if (identity !== null) {
      throw new PayerCrossAccountAccessError(
        `Credits are resolved server-side; the "${identity}" parameter names an account and is not accepted.`,
      );
    }
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof PayerCrossAccountAccessError) {
      return context.json({ error: error.message }, 400);
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof SyntaxError) {
      // A body that is not JSON is the caller's mistake — the admin group's rule.
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });

  routes.get("/catalog", async (context) => {
    return context.json(
      Object.fromEntries((deps.accountQuery ?? deps.credits).catalog),
    );
  });

  routes.get("/credits/summary", async (context) => {
    // The account is the session's own personal payer, resolved from the authenticated identity —
    // pure, parameter-free, and a read that cannot open a mapping row.
    const payer = resolvePersonalPayer(context.var.actor);
    return context.json(
      await (deps.accountQuery ?? deps.credits).personalBalance(payer),
    );
  });

  routes.get("/credits/grants", async (context) => {
    const payer = resolvePersonalPayer(context.var.actor);
    return context.json({
      grants: await (deps.accountQuery ?? deps.credits).grants(payer),
    });
  });

  routes.get("/credits/consumption", async (context) => {
    const payer = resolvePersonalPayer(context.var.actor);
    const parsed = statementQueryInput.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
      page: context.req.query("page") ?? "1",
    });
    if (!parsed.success) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json(
      await (deps.accountQuery ?? deps.credits).consumption(
        {
          from: parsed.data.from ? new Date(parsed.data.from) : null,
          to: parsed.data.to ? new Date(parsed.data.to) : null,
          page: parsed.data.page,
        },
        payer,
      ),
    );
  });

  /*
   * The realtime session consumption read (15.8, AC3/AC4): the person's own realtime
   * sessions with per-session consumption, the amount still awaiting settlement, and the
   * abnormal-state reason the doors themselves wrote (15.5's stop, 15.6's close). The same
   * shape the reads above keep: the account is the session's own personal payer, resolved
   * server-side — no route parameter names an account, so another person's sessions are
   * never in the question, and the forged-parameter middleware above already answers a
   * client that tries. Amounts stay the ledger's own ×100 integers.
   */
  routes.get("/credits/realtime-sessions", async (context) => {
    // 503 准入读原件、读走门面：原件与 accountQuery 须成对注入（见 public.ts）。
    if (!deps.realtimeUsage) {
      return context.json(
        { error: "Realtime usage is unavailable. Try again." },
        503,
      );
    }
    const payer = resolvePersonalPayer(context.var.actor);
    return context.json({
      sessions: await (
        deps.accountQuery ?? deps.realtimeUsage
      ).realtimeSessionsForPayer(payer),
    });
  });

  /*
   * The person's own async jobs (17.8, AC1/AC3): status in the code table the money lanes
   * hold, the reason a waiting state waits for, and the amounts in the ledger's own ×100
   * integers — the same shape the reads above keep. The account is the session's own payer,
   * resolved server-side; no route parameter names an account, so another person's jobs are
   * never in the question (他人任务不可见), and the attribution shown is the job row's own
   * frozen grant/payer — a key that expired after the submit changes nothing (归属不变).
   */
  routes.get("/credits/async-jobs", async (context) => {
    // 503 准入读原件、读走门面：原件与 accountQuery 须成对注入（见 public.ts）。
    if (!deps.asyncJobsView) {
      return context.json(
        { error: "Async jobs are unavailable. Try again." },
        503,
      );
    }
    const payer = resolvePersonalPayer(context.var.actor);
    return context.json({
      jobs: await (
        deps.accountQuery ?? deps.asyncJobsView
      ).asyncJobsForPayer(payer),
    });
  });

  /*
   * The reward claim (ticket 10.4, AC14): the session user claims a reward into THEIR OWN
   * personal account, once per reward period. The attribution is structural, the same shape the
   * reads above keep: the account is `grantReward`'s resolution of `context.var.actor` — the
   * claim body has no account field to abuse, and `strictObject` turns a smuggled one into the
   * 400 the query middleware already hands a forged parameter. The period is the deployment
   * clock's answer (`now`), so "same period" in the once-per-period rule is never a client
   * choice; the amount and lifetime come from the server's reward definition, never the
   * request. A replay answers the original grant (`inserted: false`) — the ledger's unique
   * `reward:<type>:<period>:<user>` key is the fence, so a double-tapped check-in button is a
   * no-op rather than a second allowance.
   */
  routes.post("/credits/rewards/claim", async (context) => {
    if (!deps.rewards) {
      // Configured without the granter, asked to claim: a refusal, not a silent no-op — the
      // caller believes a reward landed, and it did not (the admin grant route's rule).
      return context.json(
        { error: "Rewards are unavailable. Try again." },
        503,
      );
    }
    const input = rewardClaimInput.parse(await context.req.json());
    const now = (deps.now ?? (() => new Date()))();
    const period = rewardPeriodOfDay(now);
    const definition = rewardDefinitions[input.rewardType];
    const claim = await deps.rewards.grantReward({
      // THE only attribution input: the authenticated identity. Everything else is policy.
      user: context.var.actor,
      rewardType: input.rewardType,
      period,
      totalCents: definition.totalCents,
      expiresAt: new Date(now.getTime() + definition.ttlDays * 86_400_000),
      reason: definition.reason,
    });
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.credits.reward_claimed",
        targetType: "billing",
        targetId: claim.grant.id,
        actorUserId: context.var.actor.id,
        payload: {
          userId: context.var.actor.id,
          rewardType: input.rewardType,
          period,
          totalCents: definition.totalCents,
          payerAccountId: claim.account.id,
          externalCustomerId: claim.account.externalCustomerId,
          inserted: claim.inserted,
        },
      });
    }
    return context.json({
      inserted: claim.inserted,
      period,
      grant: claim.grant,
      account: claim.account,
    });
  });

  return routes;
}

/** A sync request: one field, spelled the way the plan was spelled at the provider. */
const syncInput = z.strictObject({
  planCode: z.string().trim().min(1).max(200),
});

/**
 * A reward claim (ticket 10.4): the ONE field a claim names is the reward type. No user id, no
 * customer key, no period, no amount — each of those is either the session's own identity or a
 * server-owned policy value, and `strictObject` is what makes a client attempt to supply any of
 * them a shape error instead of a redirect.
 */
const rewardClaimInput = z.strictObject({
  rewardType: z.enum(REWARD_TYPES),
});

/**
 * A manual grant: the operator's campaign or check-in reward, in scaled credit units (×100),
 * with an optional expiry (ISO-8601) and the operator's own reason for the trail. `source`
 * refuses `plan` on purpose — the plan allowance is paid out by the payment activation, never
 * by hand; what an operator hands out is a promo or a signin reward.
 */
const grantInput = z.strictObject({
  source: z.enum(["promo", "signin"]),
  totalCents: z.number().int().positive().max(1_000_000_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * A manual grant to a NAMED PERSONAL account (ticket 02.8): the target is a USER, and the
 * account is whatever the payer layer resolves from that user — so a bare
 * `externalCustomerId` has no field to arrive in and `strictObject` turns one into a 400.
 * Everything else mirrors the deployment-level grant above; `source` defaults to `promo`
 * because the hand that reaches for this route is handing out a reward, and an explicit key
 * is optional because the derived rule below makes a keyless replay safe.
 */
const personalGrantInput = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  source: z.enum(["promo", "signin"]).default("promo"),
  totalCents: z.number().int().positive().max(1_000_000_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/**
 * The keyless replay's answer, derived — never random. The digest binds the operator and the
 * request's identity fields (user, source, amount, the expiry AS THE REQUEST SPELLED IT, the
 * reason), so resubmitting the same request converges on the first grant it produced, while two
 * intentional grants differ in at least one field or ride explicit keys. The raw expiry string
 * is hashed rather than the applied default, so a second request an hour later — whose default
 * expiry would differ — still names the same occurrence, and the first grant's expiry stands.
 */
function personalGrantDerivedKey(
  actorId: string,
  input: {
    userId: string;
    source: "promo" | "signin";
    totalCents: number;
    expiresAt?: string;
    reason?: string;
  },
): string {
  const digest = createHash("sha256")
    .update(
      [
        actorId,
        input.userId,
        input.source,
        input.totalCents,
        input.expiresAt ?? "none",
        input.reason ?? "none",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 40);
  return `admin-personal:derived:${digest}`;
}

/** The sentinel codes, as HTTP numbers: the two 503s might pass on a retry, the two 400s will not. */
function billingStatus(error: BillingError): 503 | 400 {
  return error.code === "unreachable" || error.code === "unconfigured"
    ? 503
    : 400;
}

function countFindingCodes(
  findings: readonly { code: string }[],
): Record<string, number> {
  return findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * The administrator's snapshot and sync.
 *
 * `requireUser` is mounted for the whole group and `requireAdmin` is checked again inside each
 * handler, because the admin check is a plain function of the actor the first one established — see
 * the file header for why the layering is not optional.
 *
 * The sync is idempotent by construction (read-before-create in the service), and audited: the plan
 * asked for is the whole payload, since the receipt's identifiers are the provider's own words and
 * the trail has no use for them.
 */
export function createBillingAdminRoutes(deps: {
  service: BillingService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireAdmin: RequireAdmin;
  /** Present on a deployment with the audit store; absent skips the trail, as everywhere else. */
  audit?: AuditStore;
  /** The deployment's customer key, already derived (service.ts `deploymentExternalCustomerId`). */
  externalCustomerKey: string;
  /** What the provider's customer record calls this deployment. */
  customerName: string;
  /**
   * The credit writer, when the deployment built one. Present → the grant routes mount; absent →
   * the routes answer 503 rather than pretending a ledger that was never wired accepted a grant.
   */
  creditWriter?: CreditWriter;
  /**
   * The deployment's own database, where the personal grant route resolves the target user and
   * their payer account (ticket 02.8). Like the writer it only backs the grant surfaces: absent
   * there too, the personal route answers 503 — resolution needs the mapping tables, and a
   * route that cannot resolve must not fall back to a caller-named key.
   */
  database?: Database;
  /**
   * The deployment's environment conversion rate (the value a version-0 price lock names),
   * threaded to the disposal's settle path exactly as the protocol surfaces take it. Absent
   * leaves version-0 locks unsettleable there too — the same refusal, never a fallback rate.
   */
  environmentRate?: ConversionRate;
  /**
   * 17.8's async jobs review read (the task dimension beside 08.8's anomaly queue).
   * Absent answers 503 — a review that cannot read says so, never an empty answer.
   */
  asyncJobsView?: AsyncJobsViewReader;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  /*
   * The disposal command's service (08.9): built once where the ledger it commands exists,
   * with the audit store and environment rate the deployment wired. A route that could not
   * build it answers 503 — a disposal is a money decision, never best-effort.
   */
  const disposal =
    deps.database && deps.creditWriter
      ? createRecoveryDisposal({
          database: deps.database,
          ...(deps.environmentRate !== undefined
            ? { environmentRate: deps.environmentRate }
            : {}),
          ...(deps.audit ? { audit: deps.audit } : {}),
        })
      : undefined;
  routes.onError((error, context) => {
    // A body that is not JSON, or JSON of the wrong shape, is the caller's mistake — answered with a
    // sentence of ours, not the parser's, and never the parsed fragment of anything.
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    if (error instanceof BillingError) {
      return context.json({ error: error.message }, billingStatus(error));
    }
    // Nothing else is a person's decision: a fixed sentence, no detail from the throw.
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });
  routes.get("/", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    return context.json(await deps.service.snapshot());
  });
  routes.post("/sync", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const input = syncInput.parse(await context.req.json());
    await deps.service.ensureCustomer({
      externalId: deps.externalCustomerKey,
      name: deps.customerName,
    });
    await deps.service.ensureSubscription({
      externalCustomerId: deps.externalCustomerKey,
      // Deterministic, so the same plan on the same customer is the same subscription at the
      // provider however many times the button is pressed.
      externalSubscriptionId: `${deps.externalCustomerKey}-${input.planCode}`,
      planCode: input.planCode,
    });
    /*
     * The sync just changed what the deployment is subscribed to; the entitlement reader would
     * otherwise keep answering the pre-sync cached value for up to its 10-minute TTL (and its
     * stale-while-revalidate returns the old answer even past expiry). Dropping the cache here is
     * what makes the next purchase's one-subscription gate — and the page's plan name — see the
     * world the sync just wrote.
     */
    deps.service.invalidateEntitlementCache();
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.synced",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: { planCode: input.planCode },
      });
    }
    return context.json({ synced: true });
  });
  routes.post("/credits/grants", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const input = grantInput.parse(await context.req.json());
    if (!deps.creditWriter) {
      // Configured without the writer, asked to grant: a refusal, not a silent no-op — the
      // caller is an operator who believes the credits landed, and they did not.
      return context.json(
        { error: "Credits are unavailable. Try again." },
        503,
      );
    }
    const expiresAt =
      input.expiresAt !== undefined
        ? new Date(input.expiresAt)
        : // No expiry named: the grant lives a year, long enough for a campaign reward and short
          // enough that an forgotten row cannot sit on the balance forever. The operator can
          // always name the exact date they want.
          new Date(Date.now() + 365 * 24 * 3600_000);
    if (Number.isNaN(expiresAt.getTime())) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    const { grant } = await deps.creditWriter.grantCredits({
      externalCustomerId: deps.externalCustomerKey,
      source: input.source,
      totalCents: input.totalCents,
      expiresAt,
      reason: input.reason ?? null,
      // Keyless on purpose: two presses of the promo button mean two grants (a campaign paid
      // out twice is a decision, not a retry). The writer derives a random `auto:` key so the
      // column stays NOT NULL while each press stays its own grant.
      idempotencyKey: null,
    });
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.credits.granted",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: {
          source: input.source,
          totalCents: input.totalCents,
          grantId: grant.id,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    }
    return context.json({ grant });
  });

  /*
   * The personal grant (ticket 02.8): the administrator names a USER, and the account is the
   * payer layer's answer for that user — resolved here, server-side, and nowhere else. The
   * complement the strictness lives in is the schema: `strictObject` gives a bare
   * `externalCustomerId` (or any other account identity) no field to arrive in, so a request
   * that tries to name the account itself is a shape error, not a grant onto the named key.
   *
   * The route answers 404 for a user who does not exist: a typo'd id must not mint credits into
   * a phantom account with an audit row praising it. Idempotency rides the writer's unique
   * index (the ticket's rule): an explicit request key lands as `admin-personal:explicit:<key>`
   * — the admin UI mints one per form session, so a retry re-enters nothing — and a keyless
   * request derives `admin-personal:derived:<digest>` from the operator and the request's
   * identity fields, which makes a replayed request converge on the first grant it produced.
   *
   * The audit row is answered per REQUEST, not per landed grant: a replay reads `inserted:
   * false`, so the trail shows both the double press and the fact that the books entered it
   * once. Every payload field names ids, amounts and reasons — never a key's plaintext (AC19).
   */
  routes.post("/credits/personal-grants", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    if (!deps.creditWriter || !deps.database) {
      // Configured without the writer or the database the resolution needs, asked to grant:
      // a refusal, not a silent no-op — and never a fallback to a caller-named account key.
      return context.json(
        { error: "Credits are unavailable. Try again." },
        503,
      );
    }
    const input = personalGrantInput.parse(await context.req.json());

    // The target must be a person this deployment knows: resolution of a ghost would otherwise
    // open a real payer account for a fiction.
    const [user] = await deps.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) {
      return context.json({ error: "No such user." }, 404);
    }

    // THE resolution: the account comes from the payer layer's mapping for this user id, the
    // same branch a person's own reads resolve through (02.4). No caller-named key is read.
    const account = await resolvePersonalPayerAccount(deps.database, {
      id: input.userId,
    });
    const expiresAt =
      input.expiresAt !== undefined
        ? new Date(input.expiresAt)
        : // No expiry named: the grant lives a year, the same default the deployment-level
          // grant above applies.
          new Date(Date.now() + 365 * 24 * 3600_000);
    if (Number.isNaN(expiresAt.getTime())) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    const source = input.source;
    const idempotencyKey =
      input.idempotencyKey !== undefined
        ? `admin-personal:explicit:${input.idempotencyKey}`
        : personalGrantDerivedKey(context.var.actor.id, {
            userId: input.userId,
            source,
            totalCents: input.totalCents,
            expiresAt: input.expiresAt,
            reason: input.reason,
          });

    const { grant, inserted } = await deps.creditWriter.grantCredits({
      externalCustomerId: account.externalCustomerId,
      source,
      totalCents: input.totalCents,
      expiresAt,
      reason: input.reason ?? null,
      idempotencyKey,
    });

    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.credits.personal_granted",
        targetType: "billing",
        targetId: grant.id,
        actorUserId: context.var.actor.id,
        payload: {
          userId: input.userId,
          payerAccountId: account.id,
          externalCustomerId: account.externalCustomerId,
          source,
          totalCents: input.totalCents,
          ...(input.reason ? { reason: input.reason } : {}),
          idempotency:
            input.idempotencyKey !== undefined ? "explicit" : "derived",
          inserted,
        },
      });
    }
    return context.json({ grant, account, inserted });
  });

  /*
   * The reconciliation pass, on demand (T7): POST because it is an action with a side-effect
   * trail (the audit row and the service's log line), read-only in its books. The answer IS
   * the report — counts first, findings with their codes, including distinct pending-vs-blocked
   * usage-delivery backlog evidence — so an operator reads the books' agreement in one round
   * trip. No scheduler: v1 reconciles when asked.
   */
  routes.post("/reconcile", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    const report = await deps.service.reconcile();
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.reconciled",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        // The trail carries the checked counts and a compact code histogram, not the full
        // findings array: enough to answer "when did we last look, and what kinds of drift
        // existed" without duplicating a potentially large event-id list into the audit log.
        // Usage backlog findings keep pending and blocked distinct here too; the operator can
        // tell retryable drift from manual-review drift, and `checked.usageFindings` says when
        // the report itself omitted additional event ids.
        payload: {
          checked: report.checked,
          findingCounts: countFindingCodes(report.findings),
        },
      });
    }
    return context.json(report);
  });
  /*
   * The legacy cleanup execution report (Bifrost 21.7): a read over the audit trail, for the
   * administrator who must be able to SEE what the authorized cleanup deleted and what the
   * post-execution verification found. The trail is the one durable record — the engine
   * writes its deletion receipt in the same transaction as the deletions and appends the
   * verification verdicts once the reads finished — so this route replays the newest
   * execution's rows and answers them as one report. An execution whose verification has not
   * landed yet (a crash between receipt and verdict) answers honestly as pending rather than
   * pretending the books were checked. Mounted always, answered only where the deployment's
   * own database exists: a report read with nothing to read from is 503, not a silent empty.
   */
  routes.get("/cleanup/execution", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) return denied;
    if (!deps.database) {
      return context.json(
        { error: "The cleanup execution report is unavailable. Try again." },
        503,
      );
    }
    const rows = await deps.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "billing.cleanup.executed"))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(50);
    if (rows.length === 0) return context.json({ execution: null });
    // The newest row names the newest execution; gather that execution's phases.
    const newest = rows[0];
    if (!newest?.targetId) return context.json({ execution: null });
    const executionId = newest.targetId;
    const ofExecution = rows.filter((row) => row.targetId === executionId);
    const executed = ofExecution.find(
      (row) => (row.payload as Record<string, unknown>).phase === "executed",
    );
    if (!executed) return context.json({ execution: null });
    const receipt = executed.payload as Record<string, unknown>;
    const verified = ofExecution.find(
      (row) =>
        (row.payload as Record<string, unknown>).phase === "post_verified",
    );
    const verifiedReport = verified
      ? ((verified.payload as Record<string, unknown>).report as Record<
          string,
          unknown
        >)
      : undefined;
    return context.json({
      execution: {
        executionId,
        executedAt: receipt.executedAt,
        authorizedBy: receipt.authorizedBy,
        verificationPending: !verifiedReport,
        report: verifiedReport ?? receipt,
      },
    });
  });

  /*
   * The administrator's settlement-anomaly review (Bifrost 08.8, #283): every unresolved
   * recovery item with the evidence 08.5 gathered for it, sorted by state and dwell. THIS
   * ROUTE READS, IT NEVER DISPOSES: settling and releasing are 08.9's evidenced, separately
   * authorized actions — a review surface that could act would put a money decision one
   * click away from the judgment that is supposed to precede it. There is no write method
   * on this path and there must never grow one (the tests hold the route set to exactly
   * that).
   *
   * The refusal is audited (the ticket's rule): a non-administrator probing the anomaly
   * queue is itself a fact worth a row. The payload names the path only — the caller saw
   * nothing, so the trail carries no account data either. What the route answers is
   * already redacted by construction: account refs are the payer layer's opaque keys, the
   * recent reason is the item's stable code, and the evidence summaries are the bounded
   * excerpts 08.5 recorded — never a credential, never another account's row.
   */
  routes.get("/recovery-items", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) {
      if (deps.audit) {
        await recordAuditEvent(deps.audit, {
          eventType: "billing.recovery.review_denied",
          targetType: "billing",
          actorUserId: context.var.actor.id,
          payload: { path: "/api/admin/billing/recovery-items" },
        });
      }
      return denied;
    }
    if (!deps.database) {
      // No deployment database wired: the anomaly queue is not "empty", it is unreadable.
      return context.json(
        { error: "The settlement review is unavailable. Try again." },
        503,
      );
    }

    // Unresolved items, in-flight (claimed) before waiting (pending), oldest dwell first —
    // the queue's own reading order (the ticket's 按状态与停留时长排序).
    const items = await deps.database
      .select()
      .from(creditRecoveryItems)
      .where(ne(creditRecoveryItems.state, "resolved"))
      .orderBy(
        asc(creditRecoveryItems.state),
        asc(creditRecoveryItems.detectedAt),
      )
      .limit(200);

    // The evidence 08.5 gathered, newest first, bounded per item: the trail an operator
    // reads before 08.9 acts. Older history stays in the table for the disposal's own
    // evidence needs; a review reads the recent window.
    const EVIDENCE_PER_ITEM = 5;
    const evidenceByItem = new Map<
      string,
      {
        conclusion: string;
        source: string;
        summary: string;
        usageInput: number | null;
        usageOutput: number | null;
        queriedAt: string;
      }[]
    >();
    if (items.length > 0) {
      const rows = await deps.database
        .select()
        .from(creditRecoveryQueries)
        .where(
          inArray(
            creditRecoveryQueries.itemId,
            items.map((item) => item.id),
          ),
        )
        .orderBy(
          desc(creditRecoveryQueries.queriedAt),
          desc(creditRecoveryQueries.id),
        );
      for (const row of rows) {
        const list = evidenceByItem.get(row.itemId) ?? [];
        if (list.length < EVIDENCE_PER_ITEM) {
          list.push({
            conclusion: row.conclusion,
            source: row.source,
            summary: row.summary,
            usageInput: row.usageInput,
            usageOutput: row.usageOutput,
            queriedAt: row.queriedAt.toISOString(),
          });
          evidenceByItem.set(row.itemId, list);
        }
      }
    }

    const generatedAt = new Date();
    return context.json({
      generatedAt: generatedAt.toISOString(),
      items: items.map((item) => ({
        itemId: item.id,
        attemptId: item.attemptId,
        reservationId: item.reservationId,
        accountRef: item.externalCustomerId,
        payerKind: item.payerKind,
        payerId: item.payerId,
        provider: item.provider,
        model: item.model,
        maximumCredits: item.maximum,
        failureCount: item.failureCount,
        lastReason: item.lastReason,
        state: item.state,
        // The disposal's optimistic-concurrency anchor (08.9): the version an operator's
        // expectedVersion must quote, so a command built from a stale review refuses.
        version: item.version,
        detectedAt: item.detectedAt.toISOString(),
        dwellSeconds: Math.max(
          0,
          Math.floor(
            (generatedAt.getTime() - item.detectedAt.getTime()) / 1000,
          ),
        ),
        evidence: evidenceByItem.get(item.id) ?? [],
      })),
    });
  });

  /*
   * The async jobs review read (Bifrost 17.8): every payer's async jobs with the SAME
   * status/reason/amounts projection the user page renders, plus the money lanes' own
   * current facts, filtered by the task dimensions (jobId prefix, status in the code
   * table, payer). THIS ROUTE READS, IT NEVER DISPOSES — the recovery review's own rule,
   * held to the route set exactly as 08.8's tests hold theirs. 管理员访问走审计路径: both
   * the denied probe (08.8's own trail) and the read itself land one audit row, so the
   * trail answers WHO reviewed WHAT window — the payload carries the filters and the
   * result count, never another account's rows.
   */
  routes.get("/async-jobs", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) {
      if (deps.audit) {
        await recordAuditEvent(deps.audit, {
          eventType: "billing.async_jobs.review_denied",
          targetType: "billing",
          actorUserId: context.var.actor.id,
          payload: { path: "/api/admin/billing/async-jobs" },
        });
      }
      return denied;
    }
    if (!deps.asyncJobsView) {
      return context.json(
        { error: "The async jobs review is unavailable. Try again." },
        503,
      );
    }
    const statusParam = context.req.query("status");
    let status: AsyncJobDisplayState | undefined;
    if (statusParam !== undefined) {
      const allowed: AsyncJobDisplayState[] = [
        "queued",
        "running",
        "pending-settlement",
        "settled",
        "refused",
        "cancelled",
      ];
      if (!allowed.includes(statusParam as AsyncJobDisplayState)) {
        return context.json({ error: "Supply a valid status filter." }, 400);
      }
      status = statusParam as AsyncJobDisplayState;
    }
    const filter = {
      jobId: context.req.query("jobId") ?? undefined,
      status,
      payerId: context.req.query("payerId") ?? undefined,
    };
    const jobs = await deps.asyncJobsView.asyncJobsForReview(filter);
    if (deps.audit) {
      await recordAuditEvent(deps.audit, {
        eventType: "billing.async_jobs.review_read",
        targetType: "billing",
        actorUserId: context.var.actor.id,
        payload: {
          path: "/api/admin/billing/async-jobs",
          filters: {
            ...(filter.jobId !== undefined ? { jobId: filter.jobId } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(filter.payerId !== undefined ? { payerId: filter.payerId } : {}),
          },
          resultCount: jobs.length,
        },
      });
    }
    return context.json({ generatedAt: new Date().toISOString(), jobs });
  });

  /*
   * The evidenced disposal (Bifrost 08.9, #284): the settle-or-release COMMAND, on its own
   * path and under its own authorization — the read surface above stays write-free forever,
   * and this route never reuses its guard silently: it runs requireAdmin in ITS handler and
   * answers a probe with its OWN refusal trail (billing.recovery.disposal_denied), so the
   * judgment (the review) and the money decision (this command) cannot collapse into one
   * click. The operator is the session's own actor — the command body never names one, or a
   * command could forge its own trail.
   *
   * WHAT THE BODY MAY SAY: the action, the evidence row it stands on, the expectedVersion
   * the operator read with the item, and the command's idempotency key. Everything else —
   * the account, the amount, the pricing — is the database's to say; the service derives
   * the settle's usage from the evidence row itself, so a disposal can never quote a
   * number the evidence does not carry (金额与证据一致，by construction).
   */
  routes.post("/recovery-items/:itemId/disposal", async (context) => {
    const denied = deps.requireAdmin(context);
    if (denied) {
      if (deps.audit) {
        await recordAuditEvent(deps.audit, {
          eventType: "billing.recovery.disposal_denied",
          targetType: "billing",
          actorUserId: context.var.actor.id,
          payload: {
            path: "/api/admin/billing/recovery-items/:itemId/disposal",
          },
        });
      }
      return denied;
    }
    if (!deps.database || !disposal) {
      // No ledger wired: there is nothing to dispose against, and a 503 says so — never a
      // pretend success against a ledger nobody configured.
      return context.json(
        { error: "The disposal command is unavailable. Try again." },
        503,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { error: DISPOSAL_REFUSAL_SENTENCES.request_invalid },
        400,
      );
    }
    const outcome = await disposal.dispose({
      ...(typeof body === "object" && body !== null ? body : {}),
      recoveryItemId: context.req.param("itemId"),
      // The one field the body must not own: who is commanding. The session answers.
      operatorId: context.var.actor.id,
    });
    if (outcome.status === "disposed" || outcome.status === "replayed") {
      return context.json(outcome, 200);
    }
    const statusByReason = {
      request_invalid: 400,
      no_such_item: 404,
      version_conflict: 409,
      already_disposed: 409,
      evidence_mismatch: 409,
      settle_refused: 422,
      release_refused: 422,
      compensate_refused: 422,
    } as const satisfies Record<
      (typeof DISPOSAL_REFUSAL_REASONS)[number],
      400 | 404 | 409 | 422
    >;
    return context.json(
      {
        error: DISPOSAL_REFUSAL_SENTENCES[outcome.reasonCode],
        code: outcome.reasonCode,
        detail: outcome.detail,
      },
      statusByReason[outcome.reasonCode],
    );
  });

  return routes;
}
