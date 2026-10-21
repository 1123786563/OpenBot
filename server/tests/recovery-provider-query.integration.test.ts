import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  createProviderQueryRecovery,
  QUERY_REASON,
  type ProviderFinalStateAnswer,
  type ProviderFinalStateSource,
} from "../src/billing/recovery-provider-query";
import {
  createRecoveryScanner,
  type RecoveryItem,
} from "../src/billing/recovery-scan";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #280 (08.5): the provider final-state query for an unknown-dispatch recovery
 * item, on a real PostgreSQL (TEST_DATABASE_URL — the dedicated test database, never the
 * live one).
 *
 * WHAT THIS FILE PINS — the ticket's acceptance criteria, one scenario each:
 *
 * - a provider that CONFIRMS completion answers settled-evidence: the conclusion is
 *   written back to the item, the query's evidence row (time, source, raw summary, usage)
 *   is durable and admin-readable — and the hold is STILL occupied: this module never
 *   settles, that is the evidenced disposal's (08.9) action;
 * - a provider that CONFIRMS nothing was billed answers no-charge-evidence: the only
 *   conclusion that may enter the release path, and even then the hold is still occupied
 *   here — the actual release is 08.9's;
 * - a provider with NO RECORD of the request answers still-unknown: the hold stays
 *   occupied (查不到不等于没发生), the item's failure count grows, and the evidence row
 *   says so;
 * - a source that throws (unreachable/timeout) is still-unknown with the failure counted
 *   — an unreachable witness is not evidence of anything;
 * - a source answer outside the closed vocabulary is still-unknown BY CONSTRUCTION, never
 *   an optimistic read;
 * - an item whose result was persisted-but-unacked is handed back untouched: that lane
 *   belongs to 08.2's replay, whose settle is exact and idempotent;
 * - the failure count moves ONLY on still-unknown: a successful query is not a failure
 *   whatever it concluded.
 *
 * ISOLATION. Every scenario seeds its own world prefix; each item is claimed BY ID and
 * processed one at a time, and an item a scenario hands back to pending is PARKED (claimed
 * once more, never processed) so later batches cannot pick it up — the replay suite's
 * discipline for exactly the same reason. The batch entry runs last, over worlds that
 * exist only for it.
 *
 * The provider is a fake by design (the ticket's own "fake provider"): no real provider
 * is callable from a deterministic test, and a fake here proves the PROTOCOL, not a
 * vendor. The fake is test-only scaffolding, never a production fallback.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b8-280-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

type World = { userId: string; grantId: string; customerKey: string };

let seedCounter = 0;

/** A customer with one live grant and nothing else (the replay suite's seeding shape). */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Provider Query Bot ${n}`,
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

/** One unknown hold over the world's account: reserved, marked unknown (06.8), named by
 * the scan (08.1). That is the crash shape the provider query exists for. */
async function seedUnknownItem(world: World) {
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
  return {
    reservationId: reserved.reservationId,
    itemId: item.id,
    attemptId: item.attemptId,
  };
}

/** Claim the seeded item by id for the scenario's worker, so no sibling item can drift
 * into the script. Throws if the claim lost a race — a fixture failure, not a skip. */
async function claimById(
  itemId: string,
  workerId: string,
): Promise<RecoveryItem> {
  const item = await scanner.claimRecoveryItem(itemId, workerId);
  if (!item) {
    throw new Error(`fixture claim lost the item ${itemId}`);
  }
  return item;
}

let parkCounter = 0;

/** Park a handed-back item: claimed once more and never processed, invisible to later
 * batches. The comment the replay suite leaves at its own park applies verbatim: later
 * scenarios must not claim it. */
async function parkItem(itemId: string): Promise<void> {
  const parked = await scanner.claimRecoveryItem(
    itemId,
    `${prefix}-park-${++parkCounter}`,
  );
  if (!parked) {
    throw new Error(`fixture park lost the item ${itemId}`);
  }
}

/** A source whose answers and failures the scenario scripts; it records every ask so the
 * tests can assert the right attempt was asked about. */
function scriptedSource(
  script: (ProviderFinalStateAnswer | Error)[],
): ProviderFinalStateSource & { asked: string[] } {
  const asked: string[] = [];
  let next = 0;
  return {
    name: "fake-provider-log",
    get asked() {
      return asked;
    },
    async queryFinalState(item) {
      asked.push(item.attemptId);
      const answer = script[next];
      next += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer === undefined) {
        throw new Error("script exhausted");
      }
      return answer;
    },
  };
}

async function itemRow(itemId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, itemId))
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

/** The whole evidence trail for one item — the read 08.8's admin view and 08.9's disposal
 * make; nothing here is beyond a plain table read. */
async function evidenceRows(itemId: string) {
  return database
    .select()
    .from(creditRecoveryQueries)
    .where(eq(creditRecoveryQueries.itemId, itemId))
    .orderBy(creditRecoveryQueries.queriedAt);
}

async function ledgerCount(customerKey: string) {
  const rows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
  return rows.length;
}

/** Run one scripted answer against one seeded item: claim by id, process, park. The
 * returned item row is the post-processing, PRE-PARK snapshot — parking is isolation
 * mechanics for later scenarios, not part of the semantics under assertion. */
async function runOne(
  itemId: string,
  script: (ProviderFinalStateAnswer | Error)[],
  workerN: number,
): Promise<{
  source: ReturnType<typeof scriptedSource>;
  item: Awaited<ReturnType<typeof itemRow>>;
}> {
  const source = scriptedSource(script);
  const recovery = createProviderQueryRecovery({ database, source });
  const claimed = await claimById(itemId, `${prefix}-w${workerN}`);
  await recovery.processClaimedItem(claimed, `${prefix}-w${workerN}`);
  const item = await itemRow(itemId);
  await parkItem(itemId);
  return { source, item };
}

afterAll(async () => {
  // The cascade does the work: items take their evidence, reservations take their
  // allocations; the rest is this suite's own rows, deleted by prefix.
  // The customer keys carry the deployment's personal-account prefix
  // (`openbot-personal-<userId>`), so the suite prefix matches INSIDE the key, not at
  // its start — an anchored LIKE here is how debris survived afterAll in early runs.
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

test("a confirmed completion is settled-evidence: written back, durable, and the hold STAYS occupied", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);
  const beforeLedger = await ledgerCount(world.customerKey);

  const { item } = await runOne(
    itemId,
    [
      {
        conclusion: "settled_evidence",
        usage: { input: 1200, output: 340 },
        summary: "job j-1 completed; provider usage 1200 in / 340 out",
      },
    ],
    1,
  );

  // The item carries the conclusion's stable code, is back to pending for the disposal
  // (08.9), and a SUCCESSFUL query is not a failure.
  expect(item?.state).toBe("pending");
  expect(item?.lastReason).toBe(QUERY_REASON.settledEvidence);
  expect(item?.failureCount).toBe(0);

  // The evidence row: the trail 08.8 shows and 08.9 acts on — source, bounded raw
  // summary, the query's own time, and the usage pair the provider reported.
  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  expect(trail[0]?.conclusion).toBe("settled_evidence");
  expect(trail[0]?.source).toBe("fake-provider-log");
  expect(trail[0]?.summary).toContain("j-1 completed");
  expect(trail[0]?.usageInput).toBe(1200);
  expect(trail[0]?.usageOutput).toBe(340);
  expect(trail[0]?.queriedAt).toBeInstanceOf(Date);

  // AND THE HOLD IS STILL OCCUPIED: settling is the disposal's action, not the query's.
  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("unknown");
  expect(await ledgerCount(world.customerKey)).toBe(beforeLedger);
});

test("a confirmed no-charge is the only release-path conclusion — and even it does not release here", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);

  const { item: item2 } = await runOne(
    itemId,
    [
      {
        conclusion: "no_charge_evidence",
        summary: "provider refused before dispatch: no units billed",
      },
    ],
    2,
  );

  expect(item2?.state).toBe("pending");
  expect(item2?.lastReason).toBe(QUERY_REASON.noChargeEvidence);
  expect(item2?.failureCount).toBe(0);

  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  expect(trail[0]?.conclusion).toBe("no_charge_evidence");
  expect(trail[0]?.usageInput).toBeNull();
  expect(trail[0]?.usageOutput).toBeNull();

  // The actual release is 08.9's: the hold is untouched, unknown and occupying.
  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("unknown");
});

test("no record of the request is still-unknown: the hold stays, the failure count grows", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);

  const { item: item3 } = await runOne(
    itemId,
    [
      {
        conclusion: "still_unknown",
        summary: "provider has no log of the request",
      },
    ],
    3,
  );

  expect(item3?.state).toBe("pending");
  expect(item3?.lastReason).toBe(QUERY_REASON.stillUnknown);
  expect(item3?.failureCount).toBe(1);

  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  expect(trail[0]?.conclusion).toBe("still_unknown");

  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("unknown");
});

test("an unreachable source is still-unknown with the failure counted, and the handler survives it as an outcome", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);

  const { item } = await runOne(itemId, [new Error("connect ECONNREFUSED")], 4);

  expect(item?.failureCount).toBe(1);
  expect(item?.lastReason).toBe(QUERY_REASON.stillUnknown);
  expect(item?.state).toBe("pending");

  // The evidence row names the query failure without carrying driver details as gospel:
  // the conclusion is what the trail needs, the error text stays out of it.
  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  expect(trail[0]?.conclusion).toBe("still_unknown");
  expect(trail[0]?.summary).toContain("provider_query_failed");

  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("unknown");
});

test("an answer outside the closed vocabulary is still-unknown by construction, never optimistic", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world);

  // A source that answers a shape the vocabulary cannot hold — the defect the classifier
  // exists for. A typed cast stands in for a misbehaving implementation.
  const { item: item5 } = await runOne(
    itemId,
    [{ conclusion: "probably_free" } as unknown as ProviderFinalStateAnswer],
    5,
  );

  expect(item5?.failureCount).toBe(1);
  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  expect(trail[0]?.conclusion).toBe("still_unknown");
  expect(trail[0]?.summary).toContain("unmappable_source_answer");
});

test("an item with a persisted-but-unacked result is handed back untouched: that lane is 08.2's replay", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);

  // The persisted result the crash lost the ack for: an outbox row on this reservation.
  const eventId = `${prefix}-evt-${randomUUID().slice(0, 8)}`;
  await database.insert(usageOutbox).values({
    eventId,
    source: "llm",
    externalCustomerId: world.customerKey,
    transactionId: eventId,
    inputTokens: 100,
    outputTokens: 20,
    model: "gpt-4.1",
    client: "web",
    occurredAt: new Date("2026-10-18T08:00:00.000Z"),
    reservationId,
    actualCostNumerator: "150",
    actualCostDenominator: "100",
  });

  const { source, item: item6 } = await runOne(
    itemId,
    [{ conclusion: "settled_evidence", summary: "should never be asked" }],
    6,
  );

  expect(source.asked).toHaveLength(0); // never asked: this server holds a better witness
  expect(item6?.state).toBe("pending");
  expect(item6?.lastReason).toBe(QUERY_REASON.replayLane);
  expect(item6?.failureCount).toBe(0);
  expect(await evidenceRows(itemId)).toHaveLength(0);
});

test("a repeated still-unknown accumulates failures and evidence, and nothing is released", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world);

  const source = scriptedSource([
    { conclusion: "still_unknown", summary: "provider log store unavailable" },
    { conclusion: "still_unknown", summary: "provider has no record yet" },
  ]);
  const recovery = createProviderQueryRecovery({ database, source });

  const first = await claimById(itemId, `${prefix}-w7a`);
  await recovery.processClaimedItem(first, `${prefix}-w7a`);
  const second = await claimById(itemId, `${prefix}-w7b`);
  await recovery.processClaimedItem(second, `${prefix}-w7b`);
  await parkItem(itemId);

  const item = await itemRow(itemId);
  expect(item?.failureCount).toBe(2);
  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(2);

  const hold = await reservationRow(reservationId);
  expect(hold?.status).toBe("unknown");
});

test("the batch entry claims, classifies, and counts — and an unwired capability refuses outright", async () => {
  // The batch form, over two fresh items nothing else can claim: each answer is keyed to
  // the item it was asked about, so a shared test database's older pending items (this
  // suite's own crashed runs) cannot swap the conclusions between the seeds.
  const worldA = await seedWorld();
  const seededA = await seedUnknownItem(worldA);
  const worldB = await seedWorld();
  const seededB = await seedUnknownItem(worldB);

  const answers = new Map<string, ProviderFinalStateAnswer>([
    [
      seededA.attemptId,
      {
        conclusion: "settled_evidence",
        summary: "completed with usage unreported",
      },
    ],
    [
      seededB.attemptId,
      {
        conclusion: "still_unknown",
        summary: "provider has no record of the request",
      },
    ],
  ]);
  const askedInBatch: string[] = [];
  const source: ProviderFinalStateSource = {
    name: "fake-provider-log",
    async queryFinalState(item) {
      askedInBatch.push(item.attemptId);
      return (
        answers.get(item.attemptId) ?? {
          conclusion: "still_unknown",
          summary: "not this suite's seed",
        }
      );
    },
  };
  const recovery = createProviderQueryRecovery({ database, source });
  const batch = await recovery.queryFinalStates(`${prefix}-wbatch`, 10);

  expect(batch.claimed).toBeGreaterThanOrEqual(2);
  expect(batch.settledEvidence).toBeGreaterThanOrEqual(1);
  expect(batch.stillUnknown).toBeGreaterThanOrEqual(1);
  expect(askedInBatch).toContain(seededA.attemptId);
  expect(askedInBatch).toContain(seededB.attemptId);

  // Each seed's own conclusion landed on its own item and evidence, whatever order the
  // claim handed them over in.
  const itemA = await itemRow(seededA.itemId);
  expect(itemA?.lastReason).toBe(QUERY_REASON.settledEvidence);
  const itemB = await itemRow(seededB.itemId);
  expect(itemB?.lastReason).toBe(QUERY_REASON.stillUnknown);
  expect((await evidenceRows(seededA.itemId)).length).toBeGreaterThanOrEqual(1);
  expect((await evidenceRows(seededB.itemId)).length).toBeGreaterThanOrEqual(1);

  // Both holds are untouched, whatever the provider said.
  expect((await reservationRow(seededA.reservationId))?.status).toBe("unknown");
  expect((await reservationRow(seededB.reservationId))?.status).toBe("unknown");

  // An unwired capability must refuse: no source, no handler — never still_unknown from
  // nothing, and never a source without its ask function.
  expect(() =>
    createProviderQueryRecovery({
      database,
      source: undefined as unknown as ProviderFinalStateSource,
    }),
  ).toThrow(/source/);
  expect(() =>
    createProviderQueryRecovery({
      database,
      source: {
        name: "x",
        queryFinalState: null,
      } as unknown as ProviderFinalStateSource,
    }),
  ).toThrow(/queryFinalState/);
});

test("the evidence trail is a plain admin-readable read: item, source, conclusion, times", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world);

  await runOne(
    itemId,
    [
      {
        conclusion: "settled_evidence",
        summary: "completed with usage unreported",
      },
    ],
    9,
  );

  // What 08.8's view will show: every row for one item, the facts an administrator
  // verifies a disposal against — no join beyond the item itself, no side effects.
  const trail = await evidenceRows(itemId);
  expect(trail).toHaveLength(1);
  const row = trail[0];
  expect(row?.itemId).toBe(itemId);
  expect(row?.source).toBe("fake-provider-log");
  expect(row?.conclusion).toBe("settled_evidence");
  expect(row?.queriedAt).toBeInstanceOf(Date);
  expect(row?.recordedAt).toBeInstanceOf(Date);
  expect(row?.summary).toContain("completed");
});
