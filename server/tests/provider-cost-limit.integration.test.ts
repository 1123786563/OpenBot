import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  lagoUsageEvents,
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #106: the pilot provider-cost ceiling is acquired atomically with the user
 * reservation, survives user release while the provider result is unknown, and
 * is replaced by verified cost or booked at the bound.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const routeId = "pilot-cost";
// maxCharge = ceil((10 × 500 000 + 2 × 0) / 1e6) = 5 microcredits per hold.
const routeSpec = {
  provider: "fixture-cost",
  model: "model-cost",
  gatewayRevision: "cost-r1",
  meteringRevision: "cost-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 500_000, outputPerMillion: 0 },
};
const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
const drafted = configure(emptyCatalog, {
  harnessImage,
  routes: { [routeId]: routeSpec },
});
const proposed = drafted.routes[routeId];
if (!proposed) throw new Error("fixture route missing");
const { catalog } = publish(
  verify(drafted, routeId, fixtureTraceReport(harnessImage, proposed), "test"),
  [routeId],
  routeId,
  "test",
);

let clockOffsetMs = 0;
const ledger = createTestCreditLedger(
  database,
  () => new Date(Date.now() + clockOffsetMs),
);
const identities = [crypto.randomUUID(), crypto.randomUUID()].map(
  (subject) => ({
    issuer: `provider-cost-${subject}`,
    subject,
  }),
);
const batchIds: string[] = [];
const winners: {
  identity: (typeof identities)[number];
  operationId: string;
  permit: string;
}[] = [];

let originalCatalog: { value: unknown } | undefined;

beforeAll(async () => {
  [originalCatalog] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  await database
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value: catalog })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: catalog },
    });
  for (const identity of identities) {
    const batchId = crypto.randomUUID();
    batchIds.push(batchId);
    await ledger.enroll({ identity, batchId, amount: 1_000n });
    await ledger.claim(identity, batchId);
  }
  await ledger.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 10n,
    by: "administrator",
  });
});

afterAll(async () => {
  await database.transaction(async (tx) => {
    const accounts = tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          identities.map(({ issuer }) => issuer),
        ),
      );
    await tx
      .delete(testCreditEvidence)
      .where(inArray(testCreditEvidence.accountId, accounts));
    await tx
      .delete(lagoUsageEvents)
      .where(inArray(lagoUsageEvents.accountId, accounts));
    await tx
      .delete(testCreditOperations)
      .where(inArray(testCreditOperations.accountId, accounts));
    await tx
      .delete(pilotProviderCostHolds)
      .where(inArray(pilotProviderCostHolds.accountId, accounts));
    await tx
      .delete(testCreditEnrollments)
      .where(inArray(testCreditEnrollments.accountId, accounts));
    await tx
      .delete(testCreditAccounts)
      .where(inArray(testCreditAccounts.id, accounts));
    await tx
      .delete(pilotProviderCostLimits)
      .where(eq(pilotProviderCostLimits.path, routeId));
    await tx
      .delete(pilotProviderCostLimitEvents)
      .where(eq(pilotProviderCostLimitEvents.path, routeId));
    for (const batchId of batchIds) {
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    }
  });
  if (originalCatalog) {
    await database
      .update(enterpriseSettings)
      .set({ value: originalCatalog.value })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  } else {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  }
  await database.$client.close();
});

async function quoteVersion() {
  const quote = await ledger.quote();
  if (!quote) throw new Error("no active quote");
  return quote;
}

async function accountIdOf(identity: (typeof identities)[number]) {
  const [row] = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(eq(testCreditAccounts.issuer, identity.issuer));
  if (!row) throw new Error("account missing");
  return row.id;
}

test("concurrent requests across accounts share one ceiling atomically", async () => {
  const quote = await quoteVersion();
  const attempts = await Promise.all(
    identities.flatMap((identity, index) =>
      [0, 1].map((n) =>
        ledger
          .reserve(identity, {
            operationId: `cost-race-${index}-${n}`,
            route: routeId,
            priceVersion: quote.priceVersion,
          })
          .then((result) => ({
            identity,
            operationId: `cost-race-${index}-${n}`,
            result,
          })),
      ),
    ),
  );
  for (const attempt of attempts) {
    if (attempt.result.state === "reserved" && attempt.result.permit)
      winners.push({
        identity: attempt.identity,
        operationId: attempt.operationId,
        permit: attempt.result.permit,
      });
  }
  const denied = attempts.filter(
    ({ result }) =>
      result.state === "denied" && result.reason === "route_unavailable",
  );
  expect(winners).toHaveLength(2);
  expect(denied).toHaveLength(2);
  expect(await ledger.providerCost(routeId)).toMatchObject({
    limitMicrocredits: 10n,
    updatedBy: "administrator",
    holds: 2,
    outstandingMicrocredits: "10",
    remainingMicrocredits: "0",
  });
});

test("unknown provider result keeps the share after the user reservation releases", async () => {
  const winner = winners[0];
  if (!winner) throw new Error("no reserved winner");
  const dispatch = await ledger.beginDispatch(winner.identity, {
    operationId: winner.operationId,
    permit: winner.permit,
  });
  expect(dispatch.state).toBe("dispatch");
  clockOffsetMs = 24 * 60 * 60_000 + 2_000;
  // Any ledger call sweeps the account's due cutoffs.
  await ledger.balance(winner.identity);
  clockOffsetMs = 0;
  const [hold] = await database
    .select()
    .from(pilotProviderCostHolds)
    .where(eq(pilotProviderCostHolds.operationId, winner.operationId));
  // The user side released; the cost share booked at its upper bound.
  expect(hold).toMatchObject({
    state: "booked",
    boundMicrocredits: 5n,
    costMicrocredits: 5n,
  });
  expect(await ledger.providerCost(routeId)).toMatchObject({
    outstandingMicrocredits: "10",
    remainingMicrocredits: "0",
  });
});

test("verified late cost replaces the booked bound and is audited", async () => {
  await ledger.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 6n,
    by: "second-admin",
  });
  const winner = winners[0];
  if (!winner) throw new Error("no reserved winner");
  const accountId = await accountIdOf(winner.identity);
  await ledger.settle(accountId, winner.operationId, {
    inputTokens: 2n,
    outputTokens: 0n,
  });
  // 1 µc verified + 5 µc still held by the other winner.
  expect(await ledger.providerCost(routeId)).toMatchObject({
    limitMicrocredits: 6n,
    updatedBy: "second-admin",
    outstandingMicrocredits: "6",
  });
  const events = await database
    .select()
    .from(pilotProviderCostLimitEvents)
    .where(eq(pilotProviderCostLimitEvents.path, routeId));
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    fromLimitMicrocredits: 10n,
    toLimitMicrocredits: 6n,
    by: "second-admin",
  });
});

test("re-reserving and replaying settlement never double-counts cost", async () => {
  const winner = winners[0];
  if (!winner) throw new Error("no reserved winner");
  const before = await ledger.providerCost(routeId);
  const quote = await quoteVersion();
  const replay = await ledger.reserve(winner.identity, {
    operationId: winner.operationId,
    route: routeId,
    priceVersion: quote.priceVersion,
  });
  expect(replay.state).toBe("existing");
  const accountId = await accountIdOf(winner.identity);
  await ledger.settle(accountId, winner.operationId, {
    inputTokens: 2n,
    outputTokens: 0n,
  });
  const after = await ledger.providerCost(routeId);
  expect(after.outstandingMicrocredits).toBe(before.outstandingMicrocredits);
  expect(after.holds).toBe(before.holds);
});

test("an uncapped path reserves without any cost limit", async () => {
  await database
    .delete(pilotProviderCostLimits)
    .where(eq(pilotProviderCostLimits.path, routeId));
  const quote = await quoteVersion();
  const reserved = await ledger.reserve(identities[1], {
    operationId: "cost-uncapped",
    route: routeId,
    priceVersion: quote.priceVersion,
  });
  expect(reserved.state).toBe("reserved");
  expect((await ledger.providerCost(routeId)).limitMicrocredits).toBeNull();
});
