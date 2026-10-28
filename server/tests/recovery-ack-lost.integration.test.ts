import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import {
  REPLAY_RESOLVED_REASON_ACK_RECOVERED,
  createRecoveryReplay,
} from "../src/billing/recovery-replay";
import { createCreditUsageTarget } from "../src/billing/usage-delivery";
import {
  createUsageOutbox,
  type UsageOutboxRecord,
} from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryItems,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #278 (08.3): the ledger-settled-but-ack-lost branch of the recovery replay, on a
 * real PostgreSQL (TEST_DATABASE_URL — the dedicated bf6 database, never the live one).
 *
 * THE CRASH SHAPE THIS HANDLES. The PostLLM settlement's delivery DID land: the credit
 * writer settled the hold, the ledger row exists at the exact rational, the grants were
 * drawn — and the process died before the delivery could ACK the outbox row. The 08.1 scan
 * names the hold a RecoveryItem (it is still `unknown`); the 08.2 handler picks it up and
 * finds the persisted result whose credits target is still `pending`.
 *
 * THE CONTRACT (the ticket's four AC). The recovery for THIS branch is a READ-ONLY
 * convergence: verify the hold's recorded settlement IS the persisted result's own
 * rational (金额与首次结算完全一致), backfill the ack, close the item — and invoke the
 * Settle effect ZERO times (恢复动作不触发第二次 Settle, asserted by a spy that fails
 * the test the moment it fires). The ledger keeps exactly ONE entry at the original amount
 * (恢复后仍只有一笔结算), and the item's resolution — state, reason code, claim
 * attribution, the acked outbox row — is the durable, auditable record of what recovery
 * did (RecoveryItem 在补记 ack 后关闭并可审计).
 *
 * The sibling shapes stay owned by 08.2 (recovery-unacked-replay.integration.test.ts): an
 * OPEN hold replays through the effect, a settled hold with a DIFFERENT actual is retained
 * as a counted conflict, never acked.
 *
 * Isolation mirrors that suite: per-scenario user/bot/grant prefixes, fixtures deleted by
 * the DERIVED account-key prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b6-278-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

type World = {
  userId: string;
  grantId: string;
  customerKey: string;
};

let seedCounter = 0;

/** A customer with one live grant, a payer mapping, an access grant, nothing else. */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Ack-lost Bot ${n}`,
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
  return { userId, grantId, customerKey };
}

/** One hold of `maximum` over the world's account; expires in one hour. */
async function reserve(world: World, maximum: number) {
  const result = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-${randomUUID().slice(0, 8)}`,
    maximumCents: maximum,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!result.reserved) {
    throw new Error(`fixture reserve refused: ${JSON.stringify(result)}`);
  }
  return result.reservationId;
}

/** The persisted result (07.8) whose delivery settled but whose ack was lost. */
async function persistResult(input: {
  eventId: string;
  reservationId: string;
  customerKey: string;
  numerator: string;
  denominator: string;
}) {
  await outbox.record({
    eventId: input.eventId,
    source: "llm",
    externalCustomerId: input.customerKey,
    transactionId: input.eventId,
    inputTokens: 1200,
    outputTokens: 340,
    model: "gpt-4.1",
    client: "web",
    occurredAt: new Date("2026-10-18T08:00:00.000Z"),
    reservationId: input.reservationId,
    actualCostNumerator: input.numerator,
    actualCostDenominator: input.denominator,
  });
}

async function recoveryItemRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reservationId))
    .limit(1);
  return row ?? null;
}

async function reservationRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  return row ?? null;
}

async function ledgerRows(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

async function outboxRow(eventId: string) {
  const [row] = await database
    .select()
    .from(usageOutbox)
    .where(eq(usageOutbox.eventId, eventId))
    .limit(1);
  return row ?? null;
}

/**
 * The replay with a Settle SPY that fails the scenario the moment the effect fires: for
 * THIS branch the count must stay zero, so the spy does not even delegate — an invocation
 * is itself the defect under test.
 */
function makeAckOnlyReplay() {
  let settleCalls = 0;
  const replay = createRecoveryReplay({
    database,
    outbox,
    settle: async () => {
      settleCalls += 1;
      throw new Error(
        "the settled-but-ack-lost branch must not invoke the Settle effect",
      );
    },
  });
  return { replay, settleCalls: () => settleCalls };
}

/** The replay with the PRODUCTION delivery effect, for the branch-ordering regression. */
function makeProductionReplay() {
  let settleCalls = 0;
  const productionEffect = createCreditUsageTarget(writer);
  const replay = createRecoveryReplay({
    database,
    outbox,
    settle: async (record: UsageOutboxRecord) => {
      settleCalls += 1;
      await productionEffect(record);
    },
  });
  return { replay, settleCalls: () => settleCalls };
}

/**
 * Park an item this scenario deliberately leaves retained: claiming it for another owner
 * takes it off the pending queue, so later scenarios' batches claim exactly their own slice.
 */
async function parkRetainedItem(reservationId: string, owner: string) {
  const item = await recoveryItemRow(reservationId);
  if (!item) throw new Error(`fixture item missing for ${reservationId}`);
  const parked = await scanner.claimRecoveryItem(item.id, owner);
  if (!parked) throw new Error(`fixture park refused for ${item.id}`);
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
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

// ── The settled-but-ack-lost shape: ack backfilled, Settle never invoked ─────────────

test("a settlement that landed before a lost ack recovers with zero Settle calls", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-ack-lost`;

  // The persisted result: 45/1 exact (45 scaled units).
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "45",
    denominator: "1",
  });
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();
  expect((await recoveryItemRow(reservationId))?.state).toBe("pending");

  // The first delivery's SETTLE landed; only the ack was lost.
  const record = await outboxRow(eventId);
  if (!record) throw new Error("fixture outbox row missing");
  await createCreditUsageTarget(writer)(record);
  expect((await reservationRow(reservationId))?.status).toBe("settled");
  expect((await outboxRow(eventId))?.creditsStatus).toBe("pending");
  const firstLedger = await ledgerRows(world.customerKey);
  expect(firstLedger).toHaveLength(1);

  const { replay, settleCalls } = makeAckOnlyReplay();
  const batch = await replay.replayUnackedResults("worker-ack", 10);

  // AC1+AC2: no second settlement, no Settle invocation at all.
  expect(batch).toMatchObject({
    claimed: 1,
    settledAckRecovered: 1,
    replayed: 0,
    failed: 0,
  });
  expect(settleCalls()).toBe(0);

  // AC4: the amount is the FIRST settlement's, byte for byte — one ledger entry at 45,
  // tied to the event by its requestId, and the hold's recorded rational unchanged.
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(45);
  expect(ledger[0]?.requestId).toBe(eventId);
  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("settled");
  expect(hold?.actualNumerator).toBe("45");
  expect(hold?.actualDenominator).toBe("1");
  expect(hold?.charged).toBe(45);

  // AC3: the ack is backfilled and the item closes, with the durable trail recovery
  // leaves behind — the resolution reason, the claim's attribution, the acked row.
  expect((await outboxRow(eventId))?.creditsStatus).toBe("delivered");
  const resolved = await recoveryItemRow(reservationId);
  expect(resolved?.state).toBe("resolved");
  expect(resolved?.lastReason).toBe(REPLAY_RESOLVED_REASON_ACK_RECOVERED);
  expect(resolved?.claimedBy).toBe("worker-ack");
  expect(resolved?.claimedAt).not.toBeNull();
});

// ── A settlement at a different amount is not this record converging ─────────────────

test("a hold settled at a different actual is retained as a counted conflict, never acked", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-conflict`;

  // The persisted result says 67/2 …
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "67",
    denominator: "2",
  });
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();

  // … but the hold was settled at a DIFFERENT actual (someone else's evidenced disposal).
  await writer.settleReservation({
    reservationId,
    actual: { numerator: 10n, denominator: 1n },
    title: "evidenced disposal settle",
    requestId: `${prefix}-other-disposal`,
  });
  expect((await reservationRow(reservationId))?.status).toBe("settled");

  const { replay, settleCalls } = makeAckOnlyReplay();
  const batch = await replay.replayUnackedResults("worker-conflict", 10);

  expect(batch).toMatchObject({
    claimed: 1,
    failed: 1,
    settledAckRecovered: 0,
  });
  expect(settleCalls()).toBe(0);

  // The ack was NOT backfilled against a settlement it cannot name; the item is retained
  // with the conflict counted and its stable kind as the reason.
  expect((await outboxRow(eventId))?.creditsStatus).toBe("pending");
  const retained = await recoveryItemRow(reservationId);
  expect(retained?.state).toBe("pending");
  expect(retained?.failureCount).toBe(1);
  expect(retained?.lastReason).toBe("settled_with_different_actual");
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(10);

  // Park the deliberately-retained item so the next scenario claims only its own.
  await parkRetainedItem(reservationId, "worker-conflict-park");
});

// ── Branch ordering: an OPEN hold still replays through the effect ───────────────────

test("an unsettled hold is not captured by the ack-only branch: it replays through the effect", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-open`;

  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "45",
    denominator: "1",
  });
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  await scanner.scanOnce();

  const { replay, settleCalls } = makeProductionReplay();
  const batch = await replay.replayUnackedResults("worker-open", 10);

  // The 08.2 shape is unchanged: the open hold replays through the Settle effect once.
  expect(batch).toMatchObject({
    claimed: 1,
    replayed: 1,
    settledAckRecovered: 0,
  });
  expect(settleCalls()).toBe(1);
  expect((await reservationRow(reservationId))?.status).toBe("settled");
  expect((await outboxRow(eventId))?.creditsStatus).toBe("delivered");
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(45);
});
