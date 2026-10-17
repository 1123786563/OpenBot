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
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { Credits } from "./credits";
import type { CreditWriter } from "./credits-writer";
import {
  findForeignAccountIdentity,
  PayerCrossAccountAccessError,
  resolvePayerForPersonalUser,
  resolvePersonalPayerAccount,
} from "./payer-personal";
import type { PaymentOrderReadScope } from "./payments/types";
import type { BillingStatements } from "./statements";
import { BillingError, type BillingService } from "./types";

/** The shape `requireAdmin` takes in auth/guards.ts: a refusal answer, or nothing to add. */
type RequireAdmin = (
  context: Context<{ Variables: AppVariables }>,
) => Response | undefined;

export function billingReadScopeOf(
  context: Context<{ Variables: AppVariables }>,
): PaymentOrderReadScope {
  // The reading actor's own personal PayerRef, resolved from the session — never from a
  // request field (AC14/Q27). Order reads filter on the order's owner columns against this
  // ref, so another person's order — and any quarantined or pre-attribution row — is simply
  // not in the answer.
  return { actorPayerRef: resolvePayerForPersonalUser(context.var.actor) };
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
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.get("/entitlements", async (context) => {
    const entitlements = await deps.service.entitlements();
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
    return context.json(await deps.statements.planUsage());
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
      await deps.statements.invoices(
        {
          from: parsed.data.from ? new Date(parsed.data.from) : null,
          to: parsed.data.to ? new Date(parsed.data.to) : null,
          page: parsed.data.page,
        },
        billingReadScopeOf(context),
      ),
    );
  });

  routes.get("/invoices/:id", async (context) => {
    const invoice = await deps.statements.invoice(
      context.req.param("id"),
      billingReadScopeOf(context),
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
}) {
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
    return context.json({ error: "Billing is unavailable. Try again." }, 503);
  });

  routes.get("/catalog", async (context) => {
    return context.json(Object.fromEntries(deps.credits.catalog));
  });

  routes.get("/credits/summary", async (context) => {
    // The account is the session's own personal payer, resolved from the authenticated identity —
    // pure, parameter-free, and a read that cannot open a mapping row.
    const payer = resolvePayerForPersonalUser(context.var.actor);
    return context.json(await deps.credits.personalBalance(payer));
  });

  routes.get("/credits/grants", async (context) => {
    const payer = resolvePayerForPersonalUser(context.var.actor);
    return context.json({ grants: await deps.credits.grants(payer) });
  });

  routes.get("/credits/consumption", async (context) => {
    const payer = resolvePayerForPersonalUser(context.var.actor);
    const parsed = statementQueryInput.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
      page: context.req.query("page") ?? "1",
    });
    if (!parsed.success) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    return context.json(
      await deps.credits.consumption(
        {
          from: parsed.data.from ? new Date(parsed.data.from) : null,
          to: parsed.data.to ? new Date(parsed.data.to) : null,
          page: parsed.data.page,
        },
        payer,
      ),
    );
  });

  return routes;
}

/** A sync request: one field, spelled the way the plan was spelled at the provider. */
const syncInput = z.strictObject({
  planCode: z.string().trim().min(1).max(200),
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
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
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
  return routes;
}
