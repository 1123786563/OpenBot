import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createBillingAdminRoutes } from "../src/billing/routes";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import type { BillingService } from "../src/billing/types";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botServices,
  usageOutbox,
} from "../src/db/schema";
import {
  creditRecoveryAlerts,
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #283 (08.8): the administrator's read-only settlement-anomaly review, against a
 * real PostgreSQL. The file name carries the family's `.integration` suffix (the route
 * reads the recovery queue, which lives in the database); the ticket's
 * `admin-settlement-review.test.ts` names the same suite.
 *
 * WHAT THIS FILE PINS — the ticket's acceptance criteria, one scenario each:
 *
 * - an administrator sees every unresolved anomaly with its ownership, ceiling, dwell,
 *   failure count and the evidence 08.5 gathered — sorted by state, then dwell;
 * - the view is STRICTLY read-only: through the read, not one money table moves (the
 *   hold stays unknown-occupied, the ledger and outbox gain nothing, not even the
 *   alerting table does), and the path answers 404 for every write verb — there is no
 *   route to grow a button on;
 * - a non-administrator is refused AND the refusal is audited (the trail names who
 *   probed, and nothing else); an unauthenticated request never reaches the gate;
 * - nothing credential-shaped appears in the answer — the fields are opaque ids, stable
 *   reason codes and the bounded evidence excerpts 08.5 recorded.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const auditStore = createAuditStore(database);
const prefix = `b8-283-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

const ADMIN: AuthenticatedActor = {
  id: `admin-${prefix}`,
  email: `admin-${prefix}@openbot.test`,
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: `member-${prefix}`,
  email: `member-${prefix}@openbot.test`,
  role: "user",
};

const stubService = {} as BillingService;

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

function appAs(actor: AuthenticatedActor | undefined) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/billing",
    createBillingAdminRoutes({
      service: stubService,
      requireUser: requireUserAs(actor),
      requireAdmin,
      audit: auditStore,
      externalCustomerKey: `openbot-deployment-${prefix}`,
      customerName: `OpenBot deployment ${prefix}`,
      database,
    }),
  );
  return app;
}

let seedCounter = 0;

async function seedWorld() {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;
  await database.insert(botServices).values({
    botId,
    displayName: `Settlement Review Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:ext:${n}`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });
  await writer.grantCredits({
    externalCustomerId: customerKey,
    source: "plan",
    totalCents: GRANT_TOTAL,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-grant-${n}`,
  });
  return { userId, botId, grantId, customerKey };
}

/** One unknown hold named by the scan, with 08.5-shaped evidence rows attached. */
async function seedReviewedItem(
  world: Awaited<ReturnType<typeof seedWorld>>,
  options?: {
    detectedMsAgo?: number;
    failures?: number;
    evidence?: {
      conclusion: "settled_evidence" | "no_charge_evidence" | "still_unknown";
      summary: string;
      usage?: { input: number; output: number };
    }[];
  },
) {
  const reserved = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-${randomUUID().slice(0, 8)}`,
    maximumCents: 5_00,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!reserved.reserved) {
    throw new Error(`fixture reserve refused: ${JSON.stringify(reserved)}`);
  }
  await writer.markReservationUnknown(
    reserved.reservationId,
    "dispatch_result_unknown",
  );
  await scanner.scanOnce();
  const [item] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reserved.reservationId))
    .limit(1);
  if (!item) {
    throw new Error("fixture scan did not name the unknown hold");
  }
  if (options?.detectedMsAgo) {
    const detectedAt = new Date(Date.now() - options.detectedMsAgo);
    await database
      .update(creditRecoveryItems)
      .set({ detectedAt })
      .where(eq(creditRecoveryItems.id, item.id));
  }
  if (options?.failures) {
    await database
      .update(creditRecoveryItems)
      .set({ failureCount: options.failures })
      .where(eq(creditRecoveryItems.id, item.id));
  }
  for (const [i, evidence] of (options?.evidence ?? []).entries()) {
    await database.insert(creditRecoveryQueries).values({
      id: `crq-${randomUUID().slice(0, 16)}`,
      itemId: item.id,
      reservationId: reserved.reservationId,
      attemptId: item.attemptId,
      source: "fake-provider-log",
      conclusion: evidence.conclusion,
      summary: evidence.summary,
      usageInput: evidence.usage?.input ?? null,
      usageOutput: evidence.usage?.output ?? null,
      queriedAt: new Date(
        Date.now() - ((options?.evidence?.length ?? 1) - i) * 60_000,
      ),
    });
  }
  return { reservationId: reserved.reservationId, itemId: item.id };
}

type ReviewResponse = {
  generatedAt: string;
  items: {
    itemId: string;
    attemptId: string;
    reservationId: string;
    accountRef: string;
    payerKind: string | null;
    payerId: string | null;
    provider: string | null;
    model: string | null;
    maximumCredits: number;
    failureCount: number;
    lastReason: string | null;
    state: string;
    detectedAt: string;
    dwellSeconds: number;
    evidence: {
      conclusion: string;
      source: string;
      summary: string;
      usageInput: number | null;
      usageOutput: number | null;
      queriedAt: string;
    }[];
  }[];
};

async function getReview(actor: AuthenticatedActor | undefined) {
  const response = await appAs(actor).request(
    "/api/admin/billing/recovery-items",
  );
  const body = (await response.json()) as unknown;
  return { response, body: body as ReviewResponse };
}

afterAll(async () => {
  // The family teardown: reservations cascade items→evidence/alerts and allocations; the
  // rest is this suite's own rows, deleted by prefix (the inside-the-key match included).
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `%${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
  // The refusal audit row stays: audit events are append-only by trigger, and the row is
  // keyed to this run's unique member id — residue in the dedicated test database, the
  // same deal every audited admin route's suite lives with.
});

describe("the administrator's settlement-anomaly review (Bifrost 08.8)", () => {
  test("an administrator sees the anomalies with ownership, ceiling, dwell, failures and evidence", async () => {
    const world = await seedWorld();
    const older = await seedReviewedItem(world, {
      detectedMsAgo: 3 * 60 * 60 * 1000,
      failures: 2,
      evidence: [
        {
          conclusion: "still_unknown",
          summary:
            "provider has no record of attempt; query timed out once before",
        },
        {
          conclusion: "settled_evidence",
          summary: "job j-9 completed on second look",
          usage: { input: 900, output: 210 },
        },
      ],
    });
    const newer = await seedReviewedItem(world, {
      detectedMsAgo: 30 * 60 * 1000,
      failures: 0,
    });

    const { response, body } = await getReview(ADMIN);
    expect(response.status).toBe(200);

    const mine = body.items.filter(
      (item) => item.accountRef === world.customerKey,
    );
    expect(mine).toHaveLength(2);

    // 按状态与停留时长排序: same state, the OLDER anomaly reads first.
    expect(mine.map((item) => item.itemId)).toEqual([
      older.itemId,
      newer.itemId,
    ]);

    const subject = mine[0];
    expect(subject.reservationId).toBe(older.reservationId);
    expect(subject.maximumCredits).toBe(5_00);
    expect(subject.failureCount).toBe(2);
    expect(subject.lastReason).toBe("dispatch_result_unknown");
    expect(subject.state).toBe("pending");
    expect(subject.dwellSeconds).toBeGreaterThanOrEqual(3 * 60 * 60 - 60);

    // The evidence 08.5 gathered, newest first.
    expect(subject.evidence.map((row) => row.conclusion)).toEqual([
      "settled_evidence",
      "still_unknown",
    ]);
    expect(subject.evidence[0]?.usageInput).toBe(900);
    expect(subject.evidence[0]?.usageOutput).toBe(210);
  });

  test("the review is strictly read-only: no money row moves, and no write verb has a route", async () => {
    const world = await seedWorld();
    const { reservationId, itemId } = await seedReviewedItem(world, {
      failures: 1,
      evidence: [
        {
          conclusion: "still_unknown",
          summary: "no record on the provider side",
        },
      ],
    });

    const [reservationBefore] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId));
    const [itemBefore] = await database
      .select()
      .from(creditRecoveryItems)
      .where(eq(creditRecoveryItems.id, itemId));
    const [ledgerBefore] = await database
      .select({ n: count() })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    const [outboxBefore] = await database
      .select({ n: count() })
      .from(usageOutbox)
      .where(eq(usageOutbox.reservationId, reservationId));
    const [alertsBefore] = await database
      .select({ n: count() })
      .from(creditRecoveryAlerts);

    const { response } = await getReview(ADMIN);
    expect(response.status).toBe(200);

    const [reservationAfter] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId));
    const [itemAfter] = await database
      .select()
      .from(creditRecoveryItems)
      .where(eq(creditRecoveryItems.id, itemId));
    const [ledgerAfter] = await database
      .select({ n: count() })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    const [outboxAfter] = await database
      .select({ n: count() })
      .from(usageOutbox)
      .where(eq(usageOutbox.reservationId, reservationId));
    const [alertsAfter] = await database
      .select({ n: count() })
      .from(creditRecoveryAlerts);

    // The hold stays unknown-occupied; the item, ledger, outbox and even the alert table
    // are untouched — a review that changed anything would be a disposal in disguise.
    expect(reservationAfter).toEqual(reservationBefore);
    expect(itemAfter).toEqual(itemBefore);
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(outboxAfter).toEqual(outboxBefore);
    expect(alertsAfter).toEqual(alertsBefore);

    // And there is no route to write through: every mutating verb on the path is a 404.
    const app = appAs(ADMIN);
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const attempted = await app.request("/api/admin/billing/recovery-items", {
        method: method.toUpperCase(),
      });
      expect(attempted.status).toBe(404);
    }
  });

  test("a non-administrator is refused and the refusal is audited; the unauthenticated never reach the gate", async () => {
    const { response } = await getReview(MEMBER);
    expect(response.status).toBe(403);

    // The trail names who probed — and carries no account data (they were answered with
    // nothing, so there is nothing of the queue to leak). The member id is unique to this
    // run, so earlier runs' append-only residue cannot answer for this one.
    const denied = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "billing.recovery.review_denied"),
          eq(auditEvents.actorUserId, MEMBER.id),
        ),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toEqual({
      path: "/api/admin/billing/recovery-items",
    });

    const anonymous = await appAs(undefined).request(
      "/api/admin/billing/recovery-items",
    );
    expect(anonymous.status).toBe(401);
  });

  test("nothing credential-shaped rides in the answer", async () => {
    const world = await seedWorld();
    await seedReviewedItem(world, {
      failures: 1,
      evidence: [
        {
          conclusion: "still_unknown",
          summary: "provider log lookup: no rows",
        },
      ],
    });

    const { response, body } = await getReview(ADMIN);
    expect(response.status).toBe(200);
    const wire = JSON.stringify(body);

    expect(wire).not.toContain("Bearer");
    expect(wire).not.toContain("sk-");
    expect(wire).not.toContain("Authorization");
    // The answer shows the opaque account ref (the operator's disposal pointer) and the
    // stable reason codes — by construction the only shapes this route reads.
    expect(wire).toContain(world.customerKey);
  });
});
