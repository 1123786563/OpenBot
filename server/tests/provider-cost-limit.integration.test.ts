import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { run } from "../scripts/billing-paths";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
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
const secondRouteId = "pilot-cost-second";
const sharedScope = "@pilot";
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
  routes: {
    [routeId]: routeSpec,
    [secondRouteId]: {
      ...routeSpec,
      provider: "fixture-cost-second",
      model: "model-cost-second",
    },
  },
});
function verifyRoute(draft: typeof drafted, id: string) {
  const proposed = draft.routes[id];
  if (!proposed) throw new Error("fixture route missing");
  return verify(draft, id, fixtureTraceReport(harnessImage, proposed), "test");
}
const qualified = verifyRoute(verifyRoute(drafted, routeId), secondRouteId);
const { catalog } = publish(
  qualified,
  [routeId, secondRouteId],
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
      .where(
        inArray(pilotProviderCostLimits.path, [
          routeId,
          secondRouteId,
          sharedScope,
        ]),
      );
    await tx
      .delete(pilotProviderCostLimitEvents)
      .where(
        inArray(pilotProviderCostLimitEvents.path, [
          routeId,
          secondRouteId,
          sharedScope,
        ]),
      );
    for (const batchId of batchIds) {
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    }
  });
  if (originalCatalog) {
    await database
      .update(enterpriseSettings)
      .set({
        value: originalCatalog.value as Record<string, unknown>,
      })
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

test("the shared pilot ceiling follows confirmed and unknown cost across routes", async () => {
  const ledgers = { credit: ledger, paid: createPaidCreditLedger(database) };
  const setLimit = (amount: string, by: string) =>
    run(
      ["provider-cost", "set", "--microcredits", amount, "--by", by],
      ledgers,
    );
  const baseline = BigInt(
    (await ledger.pilotProviderCost()).outstandingMicrocredits,
  );
  const exposure = (added: bigint) => (baseline + added).toString();
  await setLimit(exposure(5n), "pilot-lead");
  expect(await run(["provider-cost"], ledgers)).toMatchObject({
    outstandingMicrocredits: exposure(0n),
    remainingMicrocredits: "5",
  });

  const quote = await quoteVersion();
  const inputs = identities.map((identity, index) => ({
    identity,
    operationId: `shared-cost-${index}`,
    route: index === 0 ? routeId : secondRouteId,
    priceVersion: quote.priceVersion,
  }));
  const before = await Promise.all(
    identities.map((identity) => ledger.balance(identity)),
  );
  const attempts = await Promise.all(
    inputs.map(async ({ identity, ...input }) => ({
      ...input,
      identity,
      result: await ledger.reserve(identity, input),
    })),
  );
  const winner = attempts.find(({ result }) => result.state === "reserved");
  const loser = attempts.find(({ result }) => result.state === "denied");
  if (!winner || !loser || winner.result.state !== "reserved")
    throw new Error("Expected one reservation and one refusal");
  expect(loser.result).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  expect(await ledger.balance(loser.identity)).toEqual(
    before[identities.indexOf(loser.identity)],
  );
  const beforeWinner = before[identities.indexOf(winner.identity)];
  if (!beforeWinner) throw new Error("Expected balance before reserve");
  expect(await ledger.balance(winner.identity)).toMatchObject({
    reservedMicrocredits: (
      BigInt(beforeWinner.reservedMicrocredits) + 5n
    ).toString(),
  });
  const { identity, operationId } = winner;
  const accountId = await accountIdOf(identity);
  expect(
    await ledger.receipt(loser.identity, loser.operationId),
  ).toBeUndefined();
  expect(await ledger.pilotProviderCost()).toMatchObject({
    outstandingMicrocredits: exposure(5n),
    remainingMicrocredits: "0",
  });

  // An older writer has no app-level shared-cap check.
  await expect(
    (async () =>
      database.execute(sql`
    insert into test_credit_operations (account_id, id, price_version, route, reserved, state)
    select account_id, 'legacy-writer', price_version, route, reserved, 'reserved'
    from test_credit_operations where account_id = ${accountId} and id = ${operationId}
  `))(),
  ).rejects.toHaveProperty(
    "cause.constraint",
    "shared_pilot_provider_cost_limit",
  );

  expect(
    await ledger.beginDispatch(identity, {
      operationId,
      permit: winner.result.permit,
    }),
  ).toMatchObject({ state: "dispatch" });
  const requestId = crypto.randomUUID();
  expect(
    await ledger.bindGatewayRequest(accountId, operationId, {
      requestId,
      digest: "c".repeat(64),
    }),
  ).toBe(true);

  const day = 24 * 60 * 60_000;
  const afterCutoff = createTestCreditLedger(
    database,
    () => new Date(Date.now() + day + 2_000),
  );
  expect(await afterCutoff.receipt(identity, operationId)).toMatchObject({
    state: "released",
  });
  expect(await afterCutoff.pilotProviderCost()).toMatchObject({
    outstandingMicrocredits: exposure(5n),
  });

  const pausedCatalog = publish(
    qualified,
    [loser.route],
    loser.route,
    "pilot-lead",
  ).catalog;
  await database
    .update(enterpriseSettings)
    .set({ value: pausedCatalog })
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const afterRestartDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
  try {
    const afterRestart = createTestCreditLedger(
      afterRestartDatabase,
      () => new Date(Date.now() + day + 2_000),
    );
    expect(await afterRestart.pilotProviderCost()).toMatchObject({
      outstandingMicrocredits: exposure(5n),
    });
    expect(
      await afterRestart.recordEvidence(accountId, operationId, {
        evidenceId: "fixture-gateway-verified",
        gatewayRequestId: requestId,
        outcome: "completed",
        inputTokens: 2n,
        outputTokens: 0n,
      }),
    ).toBeDefined();
    await afterRestart.settleRecorded(accountId, operationId);
    expect(await afterRestart.pilotProviderCost()).toMatchObject({
      outstandingMicrocredits: exposure(1n),
    });
  } finally {
    await afterRestartDatabase.$client.close();
  }

  await setLimit(exposure(6n), "second-admin");
  const events = await database
    .select()
    .from(pilotProviderCostLimitEvents)
    .where(eq(pilotProviderCostLimitEvents.path, sharedScope));
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        by: "pilot-lead",
        fromLimitMicrocredits: null,
        toLimitMicrocredits: baseline + 5n,
      }),
      expect.objectContaining({
        by: "second-admin",
        fromLimitMicrocredits: baseline + 5n,
        toLimitMicrocredits: baseline + 6n,
      }),
    ]),
  );

  const activeQuote = await quoteVersion();
  const terminalInput = {
    operationId: "shared-terminal",
    route: loser.route,
    priceVersion: activeQuote.priceVersion,
  };
  expect(
    await ledger.reserve(loser.identity, {
      ...terminalInput,
      operationId: "paused-route",
      route: winner.route,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });

  // A route cap can independently deny a reservation that fits the pilot.
  await ledger.setProviderCostLimit({
    path: loser.route,
    limitMicrocredits: 0n,
    by: "pilot-lead",
  });
  expect(await ledger.reserve(loser.identity, terminalInput)).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  await ledger.setProviderCostLimit({
    path: loser.route,
    limitMicrocredits: 5n,
    by: "pilot-lead",
  });
  const terminal = await ledger.reserve(loser.identity, terminalInput);
  if (terminal.state !== "reserved") throw new Error("Expected a reservation");
  const terminalAccount = await accountIdOf(loser.identity);
  expect(
    await ledger.beginDispatch(loser.identity, {
      operationId: terminalInput.operationId,
      permit: terminal.permit,
    }),
  ).toMatchObject({ state: "dispatch" });
  const terminalRequest = crypto.randomUUID();
  expect(
    await ledger.bindGatewayRequest(
      terminalAccount,
      terminalInput.operationId,
      {
        requestId: terminalRequest,
        digest: "d".repeat(64),
      },
    ),
  ).toBe(true);

  const afterRetention = createTestCreditLedger(
    database,
    () => new Date(Date.now() + 8 * day),
  );
  expect(
    await afterRetention.receipt(loser.identity, terminalInput.operationId),
  ).toMatchObject({
    state: "released",
  });
  expect(await afterRetention.claimGatewayEvidenceChecks()).toEqual([]);
  expect(
    await afterRetention.recordEvidence(
      terminalAccount,
      terminalInput.operationId,
      {
        evidenceId: "expired-gateway-record",
        gatewayRequestId: terminalRequest,
        outcome: "completed",
        inputTokens: 2n,
        outputTokens: 0n,
      },
    ),
  ).toBeUndefined();
  expect(await ledger.reserve(loser.identity, terminalInput)).toMatchObject({
    state: "existing",
  });
  expect(await ledger.pilotProviderCost()).toMatchObject({
    outstandingMicrocredits: exposure(6n),
    remainingMicrocredits: "0",
  });

  await setLimit(exposure(11n), "second-admin");
  await ledger.setProviderCostLimit({
    path: loser.route,
    limitMicrocredits: 10n,
    by: "pilot-lead",
  });
  const settlingInput = { ...terminalInput, operationId: "shared-settling" };
  const settling = await ledger.reserve(loser.identity, settlingInput);
  if (settling.state !== "reserved") throw new Error("Expected a reservation");
  expect(
    await ledger.beginDispatch(loser.identity, {
      operationId: settlingInput.operationId,
      permit: settling.permit,
    }),
  ).toMatchObject({ state: "dispatch" });

  const nextCatalog = publish(
    qualified,
    [winner.route],
    winner.route,
    "pilot-lead",
  ).catalog;
  await database
    .update(enterpriseSettings)
    .set({ value: nextCatalog })
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const settle = () =>
    ledger.settle(terminalAccount, settlingInput.operationId, {
      inputTokens: 4n,
      outputTokens: 0n,
    });
  const settlements = await Promise.all([settle(), settle()]);
  for (const settled of settlements)
    expect(settled).toMatchObject({
      state: "settled",
      chargedMicrocredits: "2",
    });
  expect(await ledger.pilotProviderCost()).toMatchObject({
    outstandingMicrocredits: exposure(8n),
    remainingMicrocredits: "3",
  });
});
