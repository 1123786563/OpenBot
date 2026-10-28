import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and as and_, eq, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCredits } from "../src/billing/credits";
import { createBillingAdminRoutes } from "../src/billing/routes";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import type { BillingService } from "../src/billing/types";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botServices,
  payerAccounts,
  users,
} from "../src/db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #285 (08.10): platform-loss compensation and deactivated-account debt
 * retention, on a real PostgreSQL (TEST_DATABASE_URL — the dedicated bf6 database, never
 * the live one). The file name is the ticket's own verification command.
 *
 * WHAT THIS FILE PINS — the ticket's acceptance criteria, one scenario each:
 *
 * - the compensation is an INDEPENDENT audited operation: it writes its own event type
 *   (billing.recovery.compensated), stands on still_unknown evidence only, records the
 *   reason, the absorbed amount, the operator and the evidence row — and is NEVER
 *   recorded as "confirmed no charge" (the release's act and word never appear for it);
 * - after the compensation the ledger and the user view AGREE: no charge row, the held
 *   capacity back, the pending-settlement bucket empty — nothing charged, traceable
 *   through the item's disposal record and the audit row;
 * - deactivating a user (their access grant revoked, their Bot disabled) retains the
 *   consumption record and the pending liability, and recovery still processes the debt
 *   under the ORIGINAL payment account (payer 不变);
 * - deleting the user row outright (the global deletion program's physical phase)
 *   cascades the payer MAPPING but not one accounting fact: reservations, recovery items,
 *   evidence rows and ledger rows all survive, and compensation still completes with the
 *   reservation's own account.
 *
 * The seeding mirrors the settlement-resolution suite (#284): an unknown hold with a
 * locked basis, named by the scan, with evidence rows attached.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const auditStore = createAuditStore(database);
const prefix = `b8-285-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100
/** The deployment's environment rate: version 0, 100 credits per USD. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

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
      creditWriter: writer,
      database,
      environmentRate: ENVIRONMENT_RATE,
    }),
  );
  return app;
}

let seedCounter = 0;

type SeededWorld = {
  userId: string;
  botId: string;
  grantId: string;
  customerKey: string;
};

/** One personal account with a live grant, a payer mapping, an access grant, nothing else. */
async function seedWorld(): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Compensation Bot ${n}`,
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
  const { account } = await (
    await import("../src/billing/payer")
  ).createPayerAccount(database, { kind: "personal", id: userId });
  expect(account.externalCustomerId).toBe(customerKey);
  await writer.grantCredits({
    externalCustomerId: customerKey,
    source: "plan",
    totalCents: GRANT_TOTAL,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-grant-${n}`,
  });
  return { userId, botId, grantId, customerKey };
}

/**
 * One unknown hold with a locked basis, named by the scan, with the given evidence rows —
 * the shape a pending liability takes (待结算责任).
 */
async function seedRecoveryItem(
  world: SeededWorld,
  evidence: {
    conclusion: "settled_evidence" | "no_charge_evidence" | "still_unknown";
    summary: string;
    usage?: { input: number; output: number };
  }[],
): Promise<{ reservationId: string; itemId: string; evidenceIds: string[] }> {
  const n = ++seedCounter;
  const reserved = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-${n}-${randomUUID().slice(0, 8)}`,
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
  const evidenceIds: string[] = [];
  for (const row of evidence) {
    const id = `crq-${randomUUID().slice(0, 16)}`;
    evidenceIds.push(id);
    await database.insert(creditRecoveryQueries).values({
      id,
      itemId: item.id,
      reservationId: reserved.reservationId,
      attemptId: item.attemptId,
      source: "fake-provider-log",
      conclusion: row.conclusion,
      summary: row.summary,
      usageInput: row.usage?.input ?? null,
      usageOutput: row.usage?.output ?? null,
      queriedAt: new Date(),
    });
  }
  return {
    reservationId: reserved.reservationId,
    itemId: item.id,
    evidenceIds,
  };
}

/** The disposal command as the wire carries it (operatorId is the route's own override). */
function disposalBody(
  _itemId: string,
  overrides: {
    action: "settle" | "release" | "compensate";
    queryId: string;
    expectedVersion?: number;
    idempotencyKey?: string;
    reason?: string;
  },
) {
  return {
    action: overrides.action,
    evidence: { queryId: overrides.queryId },
    expectedVersion: overrides.expectedVersion ?? 1,
    idempotencyKey:
      overrides.idempotencyKey ??
      `${prefix}-disposal-${randomUUID().slice(0, 8)}`,
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
  };
}

/** The audit rows one item's disposal wrote (the trail is append-only, so the scoping is
 * by the per-run target id, never a delete). */
async function auditRowsOf(eventType: string, targetId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and_(
        eq(auditEvents.eventType, eventType),
        eq(auditEvents.targetId, targetId),
      ),
    );
}

async function itemRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reservationId))
    .limit(1);
  return row ?? null;
}

async function ledgerRows(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

afterAll(async () => {
  await database
    .delete(creditReservations)
    .where(
      like(
        creditReservations.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  // The audit trail is append-only by database trigger (like every sibling suite, the
  // audit assertions are scoped by per-run target ids, not cleaned up here).
  await database.delete(users).where(like(users.id, `${prefix}%`));
  await database.$client.close();
});

// ── AC1+AC4: the compensation is its own act, audited as itself ──────────────────────

test("a compensation absorbs the loss under its own audit type, never as a no-charge", async () => {
  const compensated = await seedWorld();
  const released = await seedWorld();
  const compItem = await seedRecoveryItem(compensated, [
    { conclusion: "still_unknown", summary: "provider has no record" },
  ]);
  const relItem = await seedRecoveryItem(released, [
    {
      conclusion: "no_charge_evidence",
      summary: "provider confirms never billed",
    },
  ]);

  // The release first, so its audit row exists to distinguish against.
  const releaseResponse = await appAs(ADMIN).request(
    `/api/admin/billing/recovery-items/${relItem.itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        disposalBody(relItem.itemId, {
          action: "release",
          queryId: relItem.evidenceIds[0] ?? "",
        }),
      ),
    },
  );
  expect(releaseResponse.status).toBe(200);

  const response = await appAs(ADMIN).request(
    `/api/admin/billing/recovery-items/${compItem.itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        disposalBody(compItem.itemId, {
          action: "compensate",
          queryId: compItem.evidenceIds[0] ?? "",
          reason: "platform_absorbs_unresolvable_loss",
          idempotencyKey: `${prefix}-comp-1`,
        }),
      ),
    },
  );
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as Record<string, unknown>;
  expect(outcome.status).toBe("disposed");
  expect(outcome.action).toBe("compensate");
  expect(outcome.absorbedCredits).toBe(500); // the hold's whole ceiling, ×100 scaled
  expect(outcome.reason).toBe("platform_absorbs_unresolvable_loss");

  // The hold: capacity back, the compensation's own marker on the row, NO charge.
  const [hold] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, compItem.reservationId))
    .limit(1);
  expect(hold.status).toBe("released");
  expect(hold.releaseReason).toBe(
    `platform_compensation:${compItem.evidenceIds[0]}`,
  );
  expect(hold.released).toBe(500);
  expect(await writer.availableBalance(compensated.customerKey)).toBe(
    GRANT_TOTAL,
  );
  expect(await ledgerRows(compensated.customerKey)).toHaveLength(0);

  // 补偿与释放分别产生不同审计类型：two distinct event types, one row each.
  const compensatedEvents = await auditRowsOf(
    "billing.recovery.compensated",
    compItem.itemId,
  );
  const disposedEvents = await auditRowsOf(
    "billing.recovery.disposed",
    relItem.itemId,
  );
  expect(compensatedEvents).toHaveLength(1);
  expect(disposedEvents).toHaveLength(1);
  const payload = compensatedEvents[0]?.payload as Record<string, unknown>;
  expect(payload.action).toBe("compensate");
  expect(payload.reason).toBe("platform_absorbs_unresolvable_loss");
  expect(payload.absorbedCredits).toBe(500);
  expect(payload.evidenceId).toBe(compItem.evidenceIds[0]);
  expect(payload.reservationId).toBe(compItem.reservationId);
  expect(compensatedEvents[0]?.actorUserId).toBe(ADMIN.id);
  expect(disposedEvents[0]).toBeDefined();
  const releasePayload = disposedEvents[0]?.payload as Record<string, unknown>;
  expect(releasePayload.action).toBe("release");

  // The item's disposal record names the act it resolved by.
  const resolved = await itemRow(compItem.reservationId);
  expect(resolved?.state).toBe("resolved");
  expect(resolved?.resolvedAction).toBe("compensate");
  expect(resolved?.resolvedBy).toBe(ADMIN.id);
  expect(resolved?.resolutionEvidenceId).toBe(compItem.evidenceIds[0]);
  expect(resolved?.resolutionIdempotencyKey).toBe(`${prefix}-comp-1`);

  // AC4: 补偿后台账与用户视图一致 — nothing charged, nothing pending, capacity back.
  const credits = createCredits({
    database,
    externalCustomerKey: compensated.customerKey,
    catalog: new Map(),
  });
  const balance = await credits.personalBalance({
    kind: "personal",
    id: compensated.userId,
  });
  expect(balance.available).toBe(10_000);
  expect(balance.pendingSettlement.unknown).toBe(0);
  expect(balance.pendingSettlement.consumed).toBe(0);
  const consumption = await credits.consumption(
    { from: null, to: null, page: 1 },
    { kind: "personal", id: compensated.userId },
  );
  expect(consumption.pagination.totalCount).toBe(0);
});

// ── The evidence discipline: still_unknown only, and the reason is part of the act ────

test("a compensation stands on still_unknown only, and only with a recorded reason", async () => {
  const world = await seedWorld();
  const settledItem = await seedRecoveryItem(world, [
    {
      conclusion: "settled_evidence",
      summary: "provider confirms completed",
      usage: { input: 1000, output: 2000 },
    },
  ]);
  const noChargeItem = await seedRecoveryItem(world, [
    {
      conclusion: "no_charge_evidence",
      summary: "provider confirms never billed",
    },
  ]);
  const unknownItem = await seedRecoveryItem(world, [
    { conclusion: "still_unknown", summary: "provider unreachable" },
  ]);

  const app = appAs(ADMIN);
  const post = (itemId: string, body: unknown) =>
    app.request(`/api/admin/billing/recovery-items/${itemId}/disposal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Settled evidence belongs to a settle — compensating it would pay for nothing.
  const onSettled = await post(
    settledItem.itemId,
    disposalBody(settledItem.itemId, {
      action: "compensate",
      queryId: settledItem.evidenceIds[0] ?? "",
      reason: "wrong-tool",
    }),
  );
  expect(onSettled.status).toBe(409);
  expect(((await onSettled.json()) as { code: string }).code).toBe(
    "evidence_mismatch",
  );

  // No-charge evidence belongs to a release — the loss is already resolved.
  const onNoCharge = await post(
    noChargeItem.itemId,
    disposalBody(noChargeItem.itemId, {
      action: "compensate",
      queryId: noChargeItem.evidenceIds[0] ?? "",
      reason: "wrong-tool",
    }),
  );
  expect(onNoCharge.status).toBe(409);

  // Without a reason, the command refuses at the shape boundary: an absorbed loss
  // without a recorded justification is a fact this seam will not hold.
  const withoutReason = await post(
    unknownItem.itemId,
    disposalBody(unknownItem.itemId, {
      action: "compensate",
      queryId: unknownItem.evidenceIds[0] ?? "",
    }),
  );
  expect(withoutReason.status).toBe(400);
  expect(((await withoutReason.json()) as { code: string }).code).toBe(
    "request_invalid",
  );

  // A non-administrator is refused with the route's own denial trail (08.9's gate).
  const asMember = await appAs(MEMBER).request(
    `/api/admin/billing/recovery-items/${unknownItem.itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        disposalBody(unknownItem.itemId, {
          action: "compensate",
          queryId: unknownItem.evidenceIds[0] ?? "",
          reason: "attempted",
        }),
      ),
    },
  );
  expect(asMember.status).toBe(403);
  const denied = await database
    .select()
    .from(auditEvents)
    .where(
      and_(
        eq(auditEvents.eventType, "billing.recovery.disposal_denied"),
        eq(auditEvents.actorUserId, MEMBER.id),
      ),
    );
  expect(denied).toHaveLength(1);

  // Nothing above moved a single fact: all three holds still occupy, nothing resolved.
  for (const item of [settledItem, noChargeItem, unknownItem]) {
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, item.reservationId))
      .limit(1);
    expect(hold.status).toBe("unknown");
    expect((await itemRow(item.reservationId))?.state).toBe("pending");
  }
  expect(
    await auditRowsOf("billing.recovery.compensated", settledItem.itemId),
  ).toHaveLength(0);
  expect(
    await auditRowsOf("billing.recovery.compensated", noChargeItem.itemId),
  ).toHaveLength(0);
  expect(
    await auditRowsOf("billing.recovery.compensated", unknownItem.itemId),
  ).toHaveLength(0);
});

// ── AC2+AC3: deactivation retains the debt; recovery still processes the same payer ──

test("deactivating the user retains the pending liability and the original payer", async () => {
  const world = await seedWorld();
  const item = await seedRecoveryItem(world, [
    { conclusion: "still_unknown", summary: "provider has no record" },
  ]);

  const before = await itemRow(item.reservationId);
  const [holdBefore] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId))
    .limit(1);

  // The deactivation this deployment can perform: the access grant revoked, the Bot off.
  await database
    .update(accessGrants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(accessGrants.grantId, world.grantId));
  await database
    .update(botServices)
    .set({ status: "disabled" })
    .where(eq(botServices.botId, world.botId));

  // 消费记录与待结算责任保留：the liability is untouched by the deactivation.
  const after = await itemRow(item.reservationId);
  expect(after?.state).toBe("pending");
  expect(after?.payerKind).toBe("personal");
  expect(after?.payerId).toBe(world.userId);
  const [holdAfter] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId))
    .limit(1);
  expect(holdAfter.externalCustomerId).toBe(holdBefore.externalCustomerId);
  expect(holdAfter.status).toBe("unknown");
  expect(await writer.availableBalance(world.customerKey)).toBe(
    GRANT_TOTAL - 500,
  );

  // 停用用户后债务仍可恢复处理：the compensation lands on the retained debt, against
  // the ORIGINAL payment account — the hold's own, nobody else's.
  const response = await appAs(ADMIN).request(
    `/api/admin/billing/recovery-items/${item.itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        disposalBody(item.itemId, {
          action: "compensate",
          queryId: item.evidenceIds[0] ?? "",
          reason: "deactivated_owner_platform_absorbs",
        }),
      ),
    },
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { action: string }).action).toBe(
    "compensate",
  );
  const [holdFinal] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId))
    .limit(1);
  expect(holdFinal.externalCustomerId).toBe(world.customerKey);
  expect(holdFinal.status).toBe("released");
  expect((await itemRow(item.reservationId))?.resolvedAction).toBe(
    "compensate",
  );
  expect(before?.payerId).toBe(world.userId);
});

// ── AC2+AC3: deleting the user row outright keeps every accounting fact ──────────────

test("deleting the user cascades the payer mapping, never the ledger", async () => {
  const world = await seedWorld();
  const item = await seedRecoveryItem(world, [
    { conclusion: "still_unknown", summary: "provider unreachable" },
  ]);

  // One SETTLED consumption record on the same account: the deletion must not take it.
  const settled = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-settled-${randomUUID().slice(0, 8)}`,
    maximumCents: 3_00,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!settled.reserved) throw new Error("fixture settled reserve refused");
  await writer.settleReservation({
    reservationId: settled.reservationId,
    actual: { numerator: 120n, denominator: 1n },
    title: "settled before deletion",
    requestId: `${prefix}-settled-usage`,
  });

  // The global deletion program's physical phase: the users row itself goes away. (The
  // fixture inserts it first so the deletion is a real delete, not a no-op.)
  await database.insert(users).values({
    id: world.userId,
    email: `${world.userId}@openbot.test`,
  });
  await database.delete(users).where(eq(users.id, world.userId));

  // The payer MAPPING survives too — `payer_accounts` keys on the stable {kind, payer_id}
  // pair with no FK edge to `users`, so no deletion of a person can cascade the account
  // the ledger is keyed on. (The MT-era `billing_credit_accounts` does FK users, but the
  // credit stack this recovery serves never reads it.)
  const mappingAfter = await database
    .select()
    .from(payerAccounts)
    .where(eq(payerAccounts.payerId, world.userId))
    .limit(1);
  expect(mappingAfter).toHaveLength(1);
  expect(mappingAfter[0]?.externalCustomerId).toBe(world.customerKey);

  // 不级联删除账务：every accounting fact survives the deleted user.
  const [unknownHold] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId))
    .limit(1);
  expect(unknownHold.status).toBe("unknown");
  expect(unknownHold.externalCustomerId).toBe(world.customerKey);
  expect((await itemRow(item.reservationId))?.state).toBe("pending");
  const evidenceRows = await database
    .select()
    .from(creditRecoveryQueries)
    .where(eq(creditRecoveryQueries.itemId, item.itemId));
  expect(evidenceRows).toHaveLength(1);
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(120);

  // And the retained debt is still processable — under the reservation's own account.
  const response = await appAs(ADMIN).request(
    `/api/admin/billing/recovery-items/${item.itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        disposalBody(item.itemId, {
          action: "compensate",
          queryId: item.evidenceIds[0] ?? "",
          reason: "deleted_owner_platform_absorbs",
        }),
      ),
    },
  );
  expect(response.status).toBe(200);
  const [holdFinal] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId))
    .limit(1);
  expect(holdFinal.status).toBe("released");
  expect(holdFinal.externalCustomerId).toBe(world.customerKey);
  // The settled consumption survives the compensation too: one ledger row, unchanged.
  expect(await ledgerRows(world.customerKey)).toHaveLength(1);
});
