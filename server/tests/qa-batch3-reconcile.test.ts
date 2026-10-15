import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import { createReconciler } from "../src/billing/reconcile";
import {
  createBillingAdminRoutes,
} from "../src/billing/routes";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createBillingService } from "../src/billing/service";
import { BillingError } from "../src/billing/types";
import { createDatabase } from "../src/db/client";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-3 probes (a)(b)(c)(d) for the reconciliation skeleton (T7):
 *
 *   (a) the reconcile admin route's guards and audit row — non-admin 403, unsigned-in 401,
 *       the audit event typed billing.reconciled with the counts and finding codes.
 *   (b) the READ-ONLY contract, proven by row counts before/after a pass over seeded
 *       disagreeing data: the reconciler must not repair what it finds — the findings stay
 *       for an operator, and no money row appears or changes.
 *   (c) the credit identity's subject scoping: customer A's broken identity does not leak a
 *       finding for customer B, and a multi-grant/multi-ledger agreeing customer stays silent.
 *   (d) the seam's honest refusal: service.reconcile() with NO reconciler injected still
 *       throws the unsupported sentinel (an assembly that predates the skeleton).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const creditWriter = createCreditWriter(database);
const prefix = `qa3-${randomUUID().slice(0, 8)}`;
const deploymentKey = `${prefix}-deployment`;

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

const ADMIN: AuthenticatedActor = {
  id: "user-admin",
  email: "admin@openbot.test",
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};

function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

function recordingAudit() {
  const events: Array<Record<string, unknown>> = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event as Record<string, unknown>);
    },
  };
  return { store, events };
}

/** The billing service with an INJECTED reconciler, the way index.ts assembles it. */
function serviceWithReconciler() {
  return createBillingService({
    config: { externalCustomerKey: deploymentKey, webhookMode: "hmac" },
    client: {
      async getCustomer() {
        return { status: 404, body: null };
      },
      async postCustomer() {
        return { status: 201, body: null };
      },
      async listSubscriptions() {
        return { status: 200, body: [] };
      },
      async getSubscription() {
        return { status: 404, body: null };
      },
      async postSubscription() {
        return { status: 201, body: null };
      },
      async getUsage() {
        return { status: 405, body: null };
      },
      async postEvent() {
        return { status: 200, body: null };
      },
      async listEvents() {
        return { status: 404, body: null };
      },
    },
    store: {
      async upsertCustomer() {},
      async ensureCustomerRow() {},
      async upsertSubscription() {},
      async readSubscriptions() {
        return [];
      },
      async hasWebhookEvent() {
        return false;
      },
      async recordWebhookEvent() {},
    },
    verifier: undefined,
    reconciler: createReconciler(database, deploymentKey),
    planEntitlements: new Map(),
  });
}

describe("probe a: the reconcile admin route", () => {
  function reconcileApp(actor: AuthenticatedActor | undefined) {
    const audit = recordingAudit();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/billing",
      createBillingAdminRoutes({
        service: serviceWithReconciler(),
        requireUser: requireUserAs(actor),
        requireAdmin,
        audit: audit.store,
        externalCustomerKey: deploymentKey,
        customerName: "QA deployment",
      }),
    );
    return { app, audit };
  }

  test("a non-administrator is refused 403 and no audit row is written", async () => {
    const { app, audit } = reconcileApp(MEMBER);
    const response = await app.request("/api/admin/billing/reconcile", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(audit.events).toHaveLength(0);
  });

  test("an unsigned-in request is refused 401, not 500", async () => {
    const { app } = reconcileApp(undefined);
    const response = await app.request("/api/admin/billing/reconcile", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  test("an administrator gets the report and the billing.reconciled audit row", async () => {
    const { app, audit } = reconcileApp(ADMIN);
    const response = await app.request("/api/admin/billing/reconcile", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      checked: Record<string, number>;
      findings: Array<{ code: string }>;
    };
    expect(report.checked).toHaveProperty("paidOrders");
    expect(Array.isArray(report.findings)).toBe(true);
    const findingCounts = Object.fromEntries(
      Object.entries(
        report.findings.reduce<Record<string, number>>((counts, finding) => {
          counts[finding.code] = (counts[finding.code] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([left], [right]) => left.localeCompare(right)),
    );

    expect(audit.events).toHaveLength(1);
    const event = audit.events[0];
    expect(event).toMatchObject({
      eventType: "billing.reconciled",
      targetType: "billing",
      actorUserId: ADMIN.id,
    });
    const payload = event.payload as Record<string, unknown>;
    expect(payload.checked).toEqual(report.checked);
    expect(payload.findingCounts).toEqual(findingCounts);
  });
});

describe("probe b: the pass is read-only — findings do not repair themselves", () => {
  test("a broken identity stays broken after N passes; no money row appears or changes", async () => {
    const customer = `${prefix}-ro`;
    // Seed an agreeing pair first (grant + a settled hold of the same size).
    await creditWriter.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "ro-seed",
      idempotencyKey: `${prefix}-ro-grant`,
    });
    const hold = await creditWriter.reserveCredits({
      externalCustomerId: customer,
      idempotencyKey: `${prefix}-ro-hold`,
      maximumCents: 400,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    if (!hold.reserved) throw new Error("expected the seed hold to reserve");
    await creditWriter.settleReservation({
      reservationId: hold.reservationId,
      actual: { numerator: 400n, denominator: 1n },
      title: "模型调用",
    });

    // Break the identity the way only manual surgery can: bump used without a ledger row.
    await database
      .update(creditGrants)
      .set({ used: 700 })
      .where(eq(creditGrants.idempotencyKey, `${prefix}-ro-grant`));

    const before = await database
      .select({ used: creditGrants.used, total: creditGrants.total })
      .from(creditGrants)
      .where(eq(creditGrants.externalCustomerId, customer));
    const ledgerBefore = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, customer));

    const reconciler = createReconciler(database, deploymentKey);
    const first = await reconciler.reconcile();
    const mine = first.findings.filter(
      (finding) => finding.subject === customer,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      category: "credits",
      code: "grants_ledger_divergence",
    });
    expect(mine[0].detail).toContain("300");

    // Two MORE passes: the finding persists, the books are untouched.
    await reconciler.reconcile();
    const third = await reconciler.reconcile();
    const still = third.findings.filter((f) => f.subject === customer);
    expect(still).toHaveLength(1);

    const after = await database
      .select({ used: creditGrants.used, total: creditGrants.total })
      .from(creditGrants)
      .where(eq(creditGrants.externalCustomerId, customer));
    const ledgerAfter = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, customer));
    expect(after).toEqual(before); // nothing repaired
    expect(ledgerAfter.length).toBe(ledgerBefore.length); // no rows added
  });
});

describe("probe c: the identity is per-customer — no cross-customer leak", () => {
  test("customer A broken, customer B agreeing (2 grants / 3 draws): one finding, A only", async () => {
    const broken = `${prefix}-a-broken`;
    const clean = `${prefix}-b-clean`;

    // A: a grant whose used was inflated by surgery — divergence.
    await creditWriter.grantCredits({
      externalCustomerId: broken,
      source: "promo",
      totalCents: 500,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: "broken",
      idempotencyKey: `${prefix}-a-g1`,
    });
    await database
      .update(creditGrants)
      .set({ used: 250 })
      .where(eq(creditGrants.idempotencyKey, `${prefix}-a-g1`));

    // B: 2 grants, 3 settled holds, all through the writer — the identity holds by construction.
    await creditWriter.grantCredits({
      externalCustomerId: clean,
      source: "promo",
      totalCents: 600,
      expiresAt: new Date(Date.now() + 20 * 3600_000),
      reason: "clean-1",
      idempotencyKey: `${prefix}-b-g1`,
    });
    await creditWriter.grantCredits({
      externalCustomerId: clean,
      source: "promo",
      totalCents: 400,
      expiresAt: new Date(Date.now() + 30 * 3600_000),
      reason: "clean-2",
      idempotencyKey: `${prefix}-b-g2`,
    });
    for (const [n, amount] of [100, 250, 300].entries()) {
      const hold = await creditWriter.reserveCredits({
        externalCustomerId: clean,
        idempotencyKey: `${prefix}-b-h${n}`,
        maximumCents: amount,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      if (!hold.reserved) throw new Error("expected a clean hold to reserve");
      await creditWriter.settleReservation({
        reservationId: hold.reservationId,
        actual: { numerator: BigInt(amount), denominator: 1n },
        title: "模型调用",
      });
    }

    const report = await createReconciler(database, deploymentKey).reconcile();
    const forBroken = report.findings.filter((f) => f.subject === broken);
    const forClean = report.findings.filter((f) => f.subject === clean);
    expect(forBroken).toHaveLength(1);
    expect(forClean).toHaveLength(0); // B stays silent: no leak from A's break

    // And B's arithmetic: Σused == Σapplied == 650 exactly (the holds span both grants).
    const grants = await database
      .select({ used: creditGrants.used })
      .from(creditGrants)
      .where(eq(creditGrants.externalCustomerId, clean));
    const draws = await database
      .select({ applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, clean));
    expect(grants.reduce((s, g) => s + g.used, 0)).toBe(650);
    expect(draws.reduce((s, d) => s + d.applied, 0)).toBe(650);
  });
});

describe("probe d: the seam's honest refusal", () => {
  test("service.reconcile() with no reconciler injected throws the unsupported sentinel", async () => {
    const service = createBillingService({
      config: { externalCustomerKey: deploymentKey, webhookMode: "hmac" },
      client: {
        async getCustomer() {
          return { status: 404, body: null };
        },
        async postCustomer() {
          return { status: 201, body: null };
        },
        async listSubscriptions() {
          return { status: 200, body: [] };
        },
        async getSubscription() {
          return { status: 404, body: null };
        },
        async postSubscription() {
          return { status: 201, body: null };
        },
        async getUsage() {
          return { status: 405, body: null };
        },
        async postEvent() {
          return { status: 200, body: null };
        },
        async listEvents() {
          return { status: 404, body: null };
        },
      },
      store: {
        async upsertCustomer() {},
        async ensureCustomerRow() {},
        async upsertSubscription() {},
        async readSubscriptions() {
          return [];
        },
        async hasWebhookEvent() {
          return false;
        },
        async recordWebhookEvent() {},
      },
      verifier: undefined,
      planEntitlements: new Map(),
      // No reconciler — the pre-skeleton assembly shape.
    });
    expect(service.reconcile()).rejects.toBeInstanceOf(BillingError);
    await expect(service.reconcile()).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});
