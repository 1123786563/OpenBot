import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
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
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
} from "../src/db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #284 (08.9): the evidenced settle-or-release disposal command, on a real
 * PostgreSQL (TEST_DATABASE_URL — the dedicated bf5 test database, never the live one).
 * The file name is the ticket's own verification command.
 *
 * WHAT THIS FILE PINS — the ticket's acceptance criteria, one scenario each:
 *
 * - a settle stands on a SPECIFIC evidence row whose conclusion is settled_evidence WITH
 *   its usage, and the amount charged is the evidence's own usage priced through the
 *   reservation's locked basis — the operator never sends a number (金额与证据一致，by
 *   construction);
 * - a release without no_charge_evidence is REFUSED and moves nothing — still_unknown is
 *   not release evidence (Q12: 查不到不等于没发生)， settled_evidence is the opposite of a
 *   no-charge proof — while a release that stands on no_charge_evidence releases the hold
 *   and resolves the item;
 * - expectedVersion mismatches refuse (version_conflict)， and a resolved item answers by
 *   its record: the SAME idempotency key replays the recorded outcome with no second
 *   ledger effect and no second audit row, a DIFFERENT command refuses
 *   (already_disposed);
 * - a non-administrator is refused (403) and the refusal is audited with its own event
 *   type, separate from the review surface's;
 * - the operator is the session's own actor: a body-supplied operatorId is overridden, so
 *   a command cannot forge its own trail;
 * - every landed disposal writes exactly one billing.recovery.disposed audit row carrying
 *   the action, the evidence id, the reservation, the version and the command key.
 *
 * The settle-able world (locked price basis, version-1 snapshots, environment rate)
 * mirrors the settle-idempotency suite's seeding; the recovery world (unknown hold named
 * by the scan, evidence rows) mirrors the settlement-review suite's.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const auditStore = createAuditStore(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const prefix = `b8-284-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100
/** The deployment's environment rate: version 0, 100 credits per USD. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

/** Version 1 prices, the settle-idempotency suite's amounts verbatim. */
const V1_AMOUNTS = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
} as const;

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

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
  customerKey: string;
  provider: string;
  model: string;
};

/** One world whose locked basis resolves and prices — the settle-idempotency seeding. */
async function seedWorld(): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Disposal Bot ${n}`,
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

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "chat",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await snapshotStore.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: dimsOf(V1_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "settlement-resolution fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({ id: GATEWAY_CATALOG_SYNC_STATE_ID, lastSuccessfulSyncAt: new Date() })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date() },
    });

  return { customerKey, provider, model };
}

/** One unknown hold with a LOCKED basis, named by the scan, with evidence attached. */
async function seedDisposalItem(
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
    lockedBasis: {
      provider: world.provider,
      model: world.model,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 0,
    },
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
  return { reservationId: reserved.reservationId, itemId: item.id, evidenceIds };
}

/** The disposal command as the wire carries it (operatorId is the route's own override). */
function disposalBody(
  _item: { itemId: string },
  overrides: {
    action: "settle" | "release";
    queryId: string;
    expectedVersion?: number;
    idempotencyKey?: string;
    operatorId?: string;
  },
) {
  return {
    action: overrides.action,
    evidence: { queryId: overrides.queryId },
    expectedVersion: overrides.expectedVersion ?? 1,
    idempotencyKey:
      overrides.idempotencyKey ?? `${prefix}-disposal-${randomUUID().slice(0, 8)}`,
    // A body-supplied operator is the forgery the route must override with the session.
    ...(overrides.operatorId !== undefined
      ? { operatorId: overrides.operatorId }
      : {}),
  };
}

async function postDisposal(
  actor: AuthenticatedActor | undefined,
  itemId: string,
  body: unknown,
) {
  const response = await appAs(actor).request(
    `/api/admin/billing/recovery-items/${itemId}/disposal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function ledgerCount(customerKey: string): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
  return Number(row?.n ?? 0);
}

async function disposedAuditRows(itemId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "billing.recovery.disposed"),
        eq(auditEvents.targetId, itemId),
      ),
    );
}

afterAll(async () => {
  // The family teardown: reservations cascade items→evidence/alerts and allocations; the
  // rest is this suite's own rows, deleted by prefix. Append-only worlds (snapshots,
  // catalog refs) key on the unique prefix and stay; audit rows are append-only by
  // trigger and keyed to this run's unique ids.
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `%${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
});


test("settle: 引用具体证据，金额来自证据的用量按锁定基价计价，一次审计", async () => {
  const world = await seedWorld();
  const usage = { input: 1000, output: 2000 };
  const item = await seedDisposalItem(world, [
    { conclusion: "still_unknown", summary: "queried too early, no record yet" },
    {
      conclusion: "settled_evidence",
      summary: "provider confirms completion with usage",
      usage,
    },
  ]);
  const evidenceId = item.evidenceIds[1];
  const idempotencyKey = `${prefix}-settle-${randomUUID().slice(0, 8)}`;

  const { response, body } = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, { action: "settle", queryId: evidenceId, idempotencyKey }),
  );
  expect(response.status).toBe(200);
  expect(body.status).toBe("disposed");
  expect(body.action).toBe("settle");
  expect(body.evidenceId).toBe(evidenceId);
  expect(body.version).toBe(2);

  // The reservation settled, charged exactly the evidence's usage priced through the
  // locked v1 basis: 1000×$0.000001 + 2000×$0.000002 = $0.005 → 0.5 credits = ×100 → 50.
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId));
  expect(reservation.status).toBe("settled");
  expect(reservation.charged).toBe(50);
  expect(body.chargedCredits).toBe(50);

  // The item's disposal record: complete, naming the evidence and the SESSION's operator.
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, item.itemId));
  expect(row.state).toBe("resolved");
  expect(row.version).toBe(2);
  expect(row.resolvedAction).toBe("settle");
  expect(row.resolvedBy).toBe(ADMIN.id);
  expect(row.resolutionEvidenceId).toBe(evidenceId);
  expect(row.resolutionIdempotencyKey).toBe(idempotencyKey);

  // Exactly one audit row for the act, carrying the whole command.
  const audits = await disposedAuditRows(item.itemId);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.actorUserId).toBe(ADMIN.id);
  expect(audits[0]?.payload).toMatchObject({
    action: "settle",
    evidenceId,
    reservationId: item.reservationId,
    expectedVersion: 1,
    idempotencyKey,
  });
});

test("settle: 证据无用量或结论不是 settled_evidence 时拒绝且分文不动", async () => {
  const world = await seedWorld();
  const item = await seedDisposalItem(world, [
    { conclusion: "settled_evidence", summary: "completed, usage unrecorded" },
    { conclusion: "still_unknown", summary: "no record on the provider side" },
  ]);

  // settled_evidence without usage: no number to settle from.
  const noUsage = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, { action: "settle", queryId: item.evidenceIds[0] }),
  );
  expect(noUsage.response.status).toBe(409);
  expect(noUsage.body.code).toBe("evidence_mismatch");

  // still_unknown is not settle evidence either.
  const notSettled = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, { action: "settle", queryId: item.evidenceIds[1] }),
  );
  expect(notSettled.response.status).toBe(409);
  expect(notSettled.body.code).toBe("evidence_mismatch");

  // Nothing moved: the hold stays unknown-occupied, the item unresolved, no audit.
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, item.reservationId));
  expect(reservation.status).toBe("unknown");
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, item.itemId));
  expect(row.state).not.toBe("resolved");
  expect(await disposedAuditRows(item.itemId)).toHaveLength(0);
  expect(await ledgerCount(world.customerKey)).toBe(0);
});

test("release: 无未计费证据的释放被拒绝；有 no_charge_evidence 时释放并留痕", async () => {
  const world = await seedWorld();
  const refused = await seedDisposalItem(world, [
    { conclusion: "still_unknown", summary: "no record on the provider side" },
  ]);
  const released = await seedDisposalItem(world, [
    { conclusion: "no_charge_evidence", summary: "provider confirms never billed" },
  ]);

  // still_unknown is NOT release evidence (Q12: 查不到不等于没发生).
  const attempt = await postDisposal(
    ADMIN,
    refused.itemId,
    disposalBody(refused, {
      action: "release",
      queryId: refused.evidenceIds[0],
    }),
  );
  expect(attempt.response.status).toBe(409);
  expect(attempt.body.code).toBe("evidence_mismatch");
  const [refusedReservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, refused.reservationId));
  expect(refusedReservation.status).toBe("unknown");

  // With the provider's own never-billed confirmation, the release lands.
  const ok = await postDisposal(
    ADMIN,
    released.itemId,
    disposalBody(released, {
      action: "release",
      queryId: released.evidenceIds[0],
    }),
  );
  expect(ok.response.status).toBe(200);
  expect(ok.body).toMatchObject({
    status: "disposed",
    action: "release",
    version: 2,
    releasedCredits: 5_00,
  });
  const [releasedReservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, released.reservationId));
  expect(releasedReservation.status).toBe("released");
  expect(releasedReservation.released).toBe(5_00);
  expect(releasedReservation.releaseReason).toBe(
    `recovery_disposal:${released.evidenceIds[0]}`,
  );
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, released.itemId));
  expect(row.resolvedAction).toBe("release");
  const audits = await disposedAuditRows(released.itemId);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.payload).toMatchObject({ action: "release" });
});

test("版本不匹配拒绝：expectedVersion 过期或超前都不产生账务效果", async () => {
  const world = await seedWorld();
  const item = await seedDisposalItem(world, [
    {
      conclusion: "no_charge_evidence",
      summary: "provider confirms never billed",
    },
  ]);

  const stale = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, {
      action: "release",
      queryId: item.evidenceIds[0],
      expectedVersion: 2,
    }),
  );
  expect(stale.response.status).toBe(409);
  expect(stale.body.code).toBe("version_conflict");

  // A bogus tiny version is a shape refusal, and still nothing moved.
  const bogus = await postDisposal(ADMIN, item.itemId, {
    action: "release",
    evidence: { queryId: item.evidenceIds[0] },
    expectedVersion: 0,
    idempotencyKey: `${prefix}-bogus`,
  });
  expect(bogus.response.status).toBe(400);
  expect(bogus.body.code).toBe("request_invalid");

  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, item.itemId));
  expect(row.state).not.toBe("resolved");
  expect(row.version).toBe(1);
});

test("重复处置幂等：同键重放记录的答案，无第二次账务效果与审计", async () => {
  const world = await seedWorld();
  const item = await seedDisposalItem(world, [
    {
      conclusion: "settled_evidence",
      summary: "provider confirms completion with usage",
      usage: { input: 500, output: 500 },
    },
  ]);
  const idempotencyKey = `${prefix}-retry-${randomUUID().slice(0, 8)}`;
  const first = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, {
      action: "settle",
      queryId: item.evidenceIds[0],
      idempotencyKey,
    }),
  );
  expect(first.response.status).toBe(200);
  const ledgerAfterFirst = await ledgerCount(world.customerKey);
  expect(ledgerAfterFirst).toBe(1);

  // The transport retry of the SAME command reads its own recorded answer.
  const replay = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, {
      action: "settle",
      queryId: item.evidenceIds[0],
      idempotencyKey,
    }),
  );
  expect(replay.response.status).toBe(200);
  expect(replay.body.status).toBe("replayed");
  expect(replay.body.action).toBe("settle");
  expect(replay.body.idempotencyKey).toBe(idempotencyKey);

  // No second effect of any kind: ledger, version, audit.
  expect(await ledgerCount(world.customerKey)).toBe(ledgerAfterFirst);
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, item.itemId));
  expect(row.version).toBe(2);
  expect(await disposedAuditRows(item.itemId)).toHaveLength(1);

  // A DIFFERENT command against the resolved item is the conflict the ticket refuses.
  const other = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, {
      action: "release",
      queryId: item.evidenceIds[0],
      idempotencyKey: `${idempotencyKey}-other`,
    }),
  );
  expect(other.response.status).toBe(409);
  expect(other.body.code).toBe("already_disposed");
  expect(await ledgerCount(world.customerKey)).toBe(ledgerAfterFirst);
});

test("非管理员被拒绝且留有独立的拒绝审计；body 无法伪造操作者", async () => {
  const world = await seedWorld();
  const item = await seedDisposalItem(world, [
    {
      conclusion: "settled_evidence",
      summary: "provider confirms completion with usage",
      usage: { input: 100, output: 100 },
    },
  ]);

  const denied = await postDisposal(
    MEMBER,
    item.itemId,
    disposalBody(item, {
      action: "settle",
      queryId: item.evidenceIds[0],
      operatorId: `forged-operator-${prefix}`,
    }),
  );
  expect(denied.response.status).toBe(403);

  // The refusal has its OWN event type — the money decision's gate is not the review's.
  const denials = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "billing.recovery.disposal_denied"),
        eq(auditEvents.actorUserId, MEMBER.id),
      ),
    );
  expect(denials).toHaveLength(1);
  expect(denials[0]?.payload).toEqual({
    path: "/api/admin/billing/recovery-items/:itemId/disposal",
  });
  expect(await disposedAuditRows(item.itemId)).toHaveLength(0);

  // The admin's landed disposal records the SESSION actor, never the body's forgery.
  const landed = await postDisposal(
    ADMIN,
    item.itemId,
    disposalBody(item, {
      action: "settle",
      queryId: item.evidenceIds[0],
      operatorId: `forged-operator-${prefix}`,
    }),
  );
  expect(landed.response.status).toBe(200);
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, item.itemId));
  expect(row.resolvedBy).toBe(ADMIN.id);
  expect(row.resolvedBy).not.toBe(`forged-operator-${prefix}`);
});

test("不存在的处置对象与不存在的工作台都拒绝，不猜测", async () => {
  const missing = await postDisposal(
    ADMIN,
    `cri-${randomUUID().slice(0, 16)}`,
    disposalBody({ itemId: "whatever" }, {
      action: "release",
      queryId: `crq-${randomUUID().slice(0, 16)}`,
    }),
  );
  expect(missing.response.status).toBe(404);
  expect(missing.body.code).toBe("no_such_item");
});
