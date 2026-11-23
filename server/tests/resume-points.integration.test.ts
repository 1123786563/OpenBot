import { afterAll, beforeAll, expect, test } from "bun:test";
import { EventType, type Message } from "@ag-ui/client";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { tap } from "rxjs";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createAgentProfileStore } from "../src/agents/profile-store";
import {
  backgroundModelOperationId,
  createBackgroundModel,
} from "../src/billing/background-model";
import { budgetedTurn } from "../src/billing/background-model-turn";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import {
  createTestCreditRoutes,
  createTrialAdminRoutes,
} from "../src/billing/test-credit-routes";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  enterpriseSettings,
  lagoUsageEvents,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  proactiveSettings,
  proactiveSuggestions,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  users,
  workItems,
} from "../src/db/schema";
import { createRoutineRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { createTaskRunner } from "../src/tasks/runner";
import { createTaskStore } from "../src/tasks/store";
import { createTaskTurn } from "../src/tasks/turn";
import { createWorkQueue } from "../src/work/queue";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #107's safe resume point: a step that stops for want of credits or budget
 * room holds nothing, waits as a resume point, and reserves again only once
 * the person has confirmed a budget. Its bill line names the app it ran for,
 * and a reservation that never runs gives its paid hold back.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const routeId = "resume-point";
const routeSpec = {
  provider: "fixture-resume",
  model: "model-resume",
  gatewayRevision: "resume-r1",
  meteringRevision: "resume-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
};
const harnessImage = `agent-langgraph-agui@sha256:${"e".repeat(64)}`;
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

const ledger = createTestCreditLedger(database);
const paidAt = new Date("2026-02-15T04:30:00.000Z");
const paidLedger = createPaidCreditLedger(database, () => paidAt);
const run = crypto.randomUUID().slice(0, 8);
const batchIds: string[] = [];

let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";

async function enrolled(tag: string, testGrant: bigint) {
  const identity = {
    issuer: `resume-point-${tag}`,
    subject: crypto.randomUUID(),
  };
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({ identity, batchId, amount: testGrant });
  await ledger.claim(identity, batchId);
  const [row] = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      and(
        eq(testCreditAccounts.issuer, identity.issuer),
        eq(testCreditAccounts.subject, identity.subject),
      ),
    );
  if (!row) throw new Error(`no Billing Account for the ${tag} identity`);
  return { identity, accountId: row.id };
}

async function boughtPack(accountId: string, credits: bigint, ref: string) {
  await paidLedger.upsertProduct({
    code: "pack-resume",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: credits,
  });
  const order = await paidLedger.createOrder({
    accountId,
    productCode: "pack-resume",
    channel: "alipay",
  });
  await paidLedger.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: ref,
    amountCents: 9_900,
    paidAt,
  });
  return order;
}

async function budgetOf(
  identity: { issuer: string; subject: string },
  input: Parameters<typeof ledger.createBudget>[1],
) {
  const budget = await ledger.createBudget(identity, input);
  if (!budget) throw new Error("budget was not created");
  return budget;
}

async function operationRow(accountId: string, id: string) {
  const [row] = await database
    .select()
    .from(testCreditOperations)
    .where(
      and(
        eq(testCreditOperations.accountId, accountId),
        eq(testCreditOperations.id, id),
      ),
    );
  return row;
}

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
  priceVersion = (await ledger.quote())?.priceVersion ?? "";
});

afterAll(async () => {
  await database.transaction(async (tx) => {
    // By issuer tags, so orphaned rows from a crashed run clean up too.
    const rows = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          [
            "pause",
            "limit",
            "hold",
            "paid-limit",
            "background",
            "runner",
            "late-auth",
          ].map((tag) => `resume-point-${tag}`),
        ),
      );
    const ids = rows.map(({ id }) => id);
    if (ids.length > 0) {
      await tx
        .delete(paidCreditAllocations)
        .where(inArray(paidCreditAllocations.accountId, ids));
      await tx
        .delete(paidEntitlements)
        .where(inArray(paidEntitlements.accountId, ids));
      await tx.delete(paidOrders).where(inArray(paidOrders.accountId, ids));
      await tx
        .delete(lagoUsageEvents)
        .where(inArray(lagoUsageEvents.accountId, ids));
      await tx
        .delete(testCreditEvidence)
        .where(inArray(testCreditEvidence.accountId, ids));
      await tx
        .delete(testCreditOperations)
        .where(inArray(testCreditOperations.accountId, ids));
      await tx
        .delete(testCreditBudgets)
        .where(inArray(testCreditBudgets.accountId, ids));
      await tx
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, ids));
      await tx
        .delete(testCreditAccounts)
        .where(inArray(testCreditAccounts.id, ids));
    }
    for (const batchId of batchIds)
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    await tx.delete(paidProducts).where(eq(paidProducts.code, "pack-resume"));
  });
  if (originalCatalog) {
    await database
      .update(enterpriseSettings)
      .set({ value: originalCatalog.value as Record<string, unknown> })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  } else {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  }
  await database.$client.close();
});

test("a step out of trial credits pauses there and continues only on a budget the person confirmed", async () => {
  const { identity, accountId } = await enrolled("pause", 6n);
  await boughtPack(accountId, 100n, `ali-resume-1-${run}`);

  // The runner's next step asks for the trial entry. Six cannot cover ten.
  const request = {
    operationId: "resume-op-1",
    route: routeId,
    priceVersion,
    creditType: "test" as const,
    applicationId: "weknora",
  };
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    {
      operationId: "resume-op-1",
      applicationId: "weknora",
      reason: "insufficient_credits",
      budgetId: null,
      creditType: null,
    },
  ]);
  // A paused step holds nothing, on either side.
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
    availableMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });

  // Trying again changes nothing until the person confirms. The pack stays
  // untouched, though it could cover the step.
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });
  expect(await paidLedger.paidBalance(accountId)).toMatchObject({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
  });

  // The confirmation is the person's own budget, confirmed, and a step that
  // ran out of credits continues on paid credits only.
  const trial = await budgetOf(identity, {
    budgetId: "resume-trial-budget",
    creditType: "test",
    limitMicrocredits: 50n,
  });
  const unconfirmed = await budgetOf(identity, {
    budgetId: "resume-unconfirmed",
    creditType: "paid",
    limitMicrocredits: 50n,
    confirmed: false,
  });
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", trial.budgetId),
  ).toEqual({ state: "denied" });
  expect(
    await ledger.confirmResumePoint(
      identity,
      "resume-op-1",
      unconfirmed.budgetId,
    ),
  ).toEqual({ state: "denied" });
  expect(
    await ledger.confirmResumePoint(
      identity,
      "no-such-step",
      unconfirmed.budgetId,
    ),
  ).toBeUndefined();
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });

  const paid = await budgetOf(identity, {
    budgetId: "resume-paid-budget",
    creditType: "paid",
    limitMicrocredits: 50n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", paid.budgetId),
  ).toMatchObject({
    state: "confirmed",
    operationId: "resume-op-1",
    budgetId: "resume-paid-budget",
    creditType: "paid",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    {
      operationId: "resume-op-1",
      budgetId: "resume-paid-budget",
      creditType: "paid",
    },
  ]);

  // The runner asks exactly as it did. The step reserves on the confirmed
  // budget, from paid sources, and leaves the waiting list.
  const reserved = await ledger.reserve(identity, request);
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("the confirmed step did not reserve");
  expect(await operationRow(accountId, "resume-op-1")).toMatchObject({
    budgetId: "resume-paid-budget",
    paidHoldMicrocredits: 10n,
    applicationId: "weknora",
  });
  expect(await ledger.resumePoints(identity)).toEqual([]);
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
    availableMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "90",
    reservedMicrocredits: "10",
    chargedMicrocredits: "0",
  });
  // A replay of the same request still answers with the reservation.
  expect(await ledger.reserve(identity, request)).toMatchObject({
    state: "existing",
    permit: reserved.permit,
  });
  // The step is under way: there is nothing left to confirm for it.
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", paid.budgetId),
  ).toBeUndefined();

  // A paid budget dispatches, and the charge is the paid side's alone.
  expect(
    await ledger.beginDispatch(identity, {
      operationId: "resume-op-1",
      permit: reserved.permit,
    }),
  ).toMatchObject({ state: "dispatch" });
  expect(
    (
      await ledger.settle(accountId, "resume-op-1", {
        inputTokens: 7n,
        outputTokens: 0n,
      })
    )?.state,
  ).toBe("settled");
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "6",
    chargedMicrocredits: "0",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "93",
    reservedMicrocredits: "0",
    chargedMicrocredits: "7",
  });

  // A step that names no app draws the trial balance first and the pack for
  // the rest, so each Credit type pays its own share.
  const mixed = await ledger.reserve(identity, {
    operationId: "resume-op-2",
    route: routeId,
    priceVersion,
  });
  if (mixed.state !== "reserved" || !mixed.permit)
    throw new Error("the mixed step did not reserve");
  await ledger.beginDispatch(identity, {
    operationId: "resume-op-2",
    permit: mixed.permit,
  });
  await ledger.settle(accountId, "resume-op-2", {
    inputTokens: 7n,
    outputTokens: 0n,
  });
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "0",
    chargedMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "92",
    reservedMicrocredits: "0",
    chargedMicrocredits: "8",
  });

  // Every bill line names the app its step ran for.
  const bill = await paidLedger.bill(accountId);
  expect(bill).toHaveLength(3);
  expect(bill).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationId: "resume-op-1",
        source: "credit_pack",
        applicationId: "weknora",
        amountMicrocredits: "7",
      }),
      expect.objectContaining({
        operationId: "resume-op-2",
        source: "test",
        applicationId: null,
        amountMicrocredits: "6",
      }),
      expect.objectContaining({
        operationId: "resume-op-2",
        source: "credit_pack",
        applicationId: null,
        amountMicrocredits: "1",
      }),
    ]),
  );
});

test("a step over its budget continues on a new budget the person confirms", async () => {
  const { identity, accountId } = await enrolled("limit", 40n);
  const small = await budgetOf(identity, {
    budgetId: "limit-small",
    creditType: "test",
    limitMicrocredits: 12n,
  });
  const step = (operationId: string) => ({
    operationId,
    route: routeId,
    priceVersion,
    budgetId: small.budgetId,
  });
  const first = await ledger.reserve(identity, step("limit-op-1"));
  if (first.state !== "reserved" || !first.permit)
    throw new Error("the first step did not reserve");
  await ledger.beginDispatch(identity, {
    operationId: "limit-op-1",
    permit: first.permit,
  });
  await ledger.settle(accountId, "limit-op-1", {
    inputTokens: 7n,
    outputTokens: 0n,
  });

  // Ten of the twelve are spoken for: the next step has no room.
  expect(await ledger.reserve(identity, step("limit-op-2"))).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    { operationId: "limit-op-2", reason: "execution_limit" },
  ]);
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
  });

  // A budget with no room for the step cannot continue it. The step waits
  // again, with nothing confirmed, so the person can pick another.
  const tiny = await budgetOf(identity, {
    budgetId: "limit-tiny",
    creditType: "test",
    limitMicrocredits: 5n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "limit-op-2", tiny.budgetId),
  ).toMatchObject({ state: "confirmed" });
  expect(await ledger.reserve(identity, step("limit-op-2"))).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    { operationId: "limit-op-2", reason: "execution_limit", budgetId: null },
  ]);

  // A step that ran out of budget room continues on a budget of either type.
  const roomier = await budgetOf(identity, {
    budgetId: "limit-roomier",
    creditType: "test",
    limitMicrocredits: 40n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "limit-op-2", roomier.budgetId),
  ).toMatchObject({ state: "confirmed", creditType: "test" });
  expect((await ledger.reserve(identity, step("limit-op-2"))).state).toBe(
    "reserved",
  );
  expect(await operationRow(accountId, "limit-op-2")).toMatchObject({
    budgetId: "limit-roomier",
    paidHoldMicrocredits: 0n,
  });
  expect(await ledger.resumePoints(identity)).toEqual([]);
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "0",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });
});

test("a paid step over its cap holds nothing and needs explicit continuation after a cap increase", async () => {
  const { identity, accountId } = await enrolled("paid-limit", 6n);
  await boughtPack(accountId, 100n, `ali-resume-4-${run}`);
  const budget = await budgetOf(identity, {
    budgetId: "paid-cap",
    creditType: "paid",
    limitMicrocredits: 5n,
  });
  const request = {
    operationId: "paid-cap-step",
    route: routeId,
    priceVersion,
    budgetId: budget.budgetId,
    creditType: "paid" as const,
  };
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await paidLedger.paidBalance(accountId)).toMatchObject({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
  });
  await ledger.confirmBudget(identity, budget.budgetId, 20n);
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(
    await ledger.confirmResumePoint(
      identity,
      request.operationId,
      budget.budgetId,
    ),
  ).toMatchObject({ state: "confirmed" });
  expect(await ledger.reserve(identity, request)).toMatchObject({
    state: "reserved",
  });
});

test("a reservation that is refused at dispatch gives its paid hold back", async () => {
  const { identity, accountId } = await enrolled("hold", 6n);
  await boughtPack(accountId, 100n, `ali-resume-3-${run}`);
  const budget = await budgetOf(identity, {
    budgetId: "hold-budget",
    creditType: "paid",
    limitMicrocredits: 100n,
  });
  let clock = new Date();
  const timed = createTestCreditLedger(database, () => clock);
  const reserved = await timed.reserve(identity, {
    operationId: "hold-op-1",
    route: routeId,
    priceVersion,
    creditType: "paid",
    budgetId: budget.budgetId,
  });
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("the paid reservation did not reserve");
  expect(await paidLedger.paidBalance(accountId)).toMatchObject({
    availableMicrocredits: "90",
    reservedMicrocredits: "10",
  });

  // The runner arrives after the reservation's five minutes, so it is too
  // old to run.
  clock = new Date(clock.getTime() + 6 * 60_000);
  expect(
    await timed.beginDispatch(identity, {
      operationId: "hold-op-1",
      permit: reserved.permit,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });
  expect(await operationRow(accountId, "hold-op-1")).toMatchObject({
    state: "released",
    paidHoldMicrocredits: 0n,
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });
});

test("a background execution keeps completed steps, waits for evidence, and applies one cumulative cap after continuation", async () => {
  const { identity, accountId } = await enrolled("background", 100n);
  const modelQuote = { route: routeId, priceVersion };
  await budgetOf(identity, {
    budgetId: "background-original",
    creditType: "test",
    limitMicrocredits: 17n,
    modelQuote,
  });
  const scope = {
    kind: "task" as const,
    personId: "fixture-person",
    executionId: "fixture-task",
    budgetId: "background-original",
  };
  const dispatched: string[] = [];
  const worker = () =>
    createBackgroundModel({
      ledger,
      identityOf: async () => identity,
      execute: async ({ operationId }) => {
        dispatched.push(operationId);
        if (operationId === backgroundModelOperationId(scope, "second"))
          throw new Error("The provider's reply was lost");
        return {
          text: "First result",
          usage: { inputTokens: 7, outputTokens: 0 },
        };
      },
    });
  const step = (name: string, previousSteps?: string[]) => ({
    step: name,
    previousSteps,
    messages: [{ role: "user" as const, content: name }],
    authorize: async () => {},
  });
  expect(await worker().complete(scope, step("first"))).toBe("First result");
  expect(await worker().complete(scope, step("first"))).toBe("First result");
  await expect(
    worker().complete(scope, step("second", ["first"])),
  ).rejects.toMatchObject({
    reason: "reconciling",
  });
  await expect(
    worker().complete(scope, step("third", ["first", "second"])),
  ).rejects.toMatchObject({
    reason: "reconciling",
  });
  const pending = backgroundModelOperationId(scope, "second");
  expect(
    await ledger.confirmResumePoint(identity, pending, scope.budgetId),
  ).toBeUndefined();
  await ledger.recordEvidence(accountId, pending, {
    evidenceId: "fixture-recovery",
    outcome: "completed",
    inputTokens: 5n,
    outputTokens: 0n,
    resultText: "Recovered second result",
  });
  expect(await worker().complete(scope, step("second", ["first"]))).toBe(
    "Recovered second result",
  );
  const third = backgroundModelOperationId(scope, "third");
  await expect(
    worker().complete(scope, step("third", ["first", "second"])),
  ).rejects.toMatchObject({
    operationId: third,
    reason: "execution_limit",
  });
  await budgetOf(identity, {
    budgetId: "background-continuation",
    creditType: "test",
    limitMicrocredits: 20n,
    modelQuote,
  });
  expect(
    await ledger.confirmResumePoint(identity, third, "background-continuation"),
  ).toMatchObject({
    state: "confirmed",
  });
  await expect(
    worker().complete(scope, step("third", ["first", "second"])),
  ).rejects.toMatchObject({
    reason: "execution_limit",
  });
  await ledger.confirmBudget(identity, "background-continuation", 22n);
  await expect(
    worker().complete(scope, step("third", ["first", "second"])),
  ).rejects.toMatchObject({
    reason: "execution_limit",
  });
  await ledger.confirmResumePoint(identity, third, "background-continuation");
  expect(
    await worker().complete(scope, step("third", ["first", "second"])),
  ).toBe("First result");
  expect(dispatched).toEqual([
    backgroundModelOperationId(scope, "first"),
    pending,
    third,
  ]);
});

test("a real Routine and Task keep their execution IDs and continue only after billing confirmation", async () => {
  const { identity, accountId } = await enrolled("runner", 100n);
  await boughtPack(accountId, 100n, `ali-runner-${run}`);
  const modelQuote = { route: routeId, priceVersion };
  for (const [budgetId, limitMicrocredits] of [
    ["runner-tiny", 5n],
    ["runner-raised", 30n],
  ] as const)
    await budgetOf(identity, {
      budgetId,
      limitMicrocredits,
      creditType: "test",
      modelQuote,
    });
  const owner = { id: crypto.randomUUID(), role: "user" as const };
  const calls: string[] = [];
  const model = createBackgroundModel({
    ledger,
    identityOf: async (id) => (id === owner.id ? identity : undefined),
    execute: async ({ operationId }) => {
      if (calls.length === 1) {
        expect(await paidLedger.paidBalance(accountId)).toMatchObject({
          availableMicrocredits: "90",
          reservedMicrocredits: "10",
          chargedMicrocredits: "0",
        });
        expect(await ledger.balance(identity)).toMatchObject({
          availableMicrocredits: "95",
          reservedMicrocredits: "0",
          chargedMicrocredits: "5",
        });
      }
      calls.push(operationId);
      return {
        text: "Fixture reply.",
        usage: { inputTokens: 2, outputTokens: 0 },
      };
    },
  });
  const history = new Map<string, Message[]>();
  const turnFor = (kind: "routine" | "task") =>
    budgetedTurn(
      model,
      kind,
      (agent) =>
        createTurnRunner({
          admission: async ({ signal }) =>
            signal ?? new AbortController().signal,
          buildAgentFor: async () => agent,
          intelligence: {
            getOrCreateThread: async ({ threadId }) => ({
              thread: { id: threadId },
              created: false,
            }),
            getThreadMessages: async ({ threadId }) => ({
              messages: (history.get(threadId) ?? []).map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
              })),
            }),
            ɵacquireThreadLock: async () => undefined,
            ɵrenewThreadLock: async () => undefined,
            ɵcleanupThreadLock: async () => {},
          },
          runner: {
            run: ({ agent, input, persistedInputMessages, threadId }) => {
              const messages = [
                ...(history.get(threadId) ?? []),
                ...(persistedInputMessages ?? []),
              ];
              history.set(threadId, messages);
              return agent.run(input).pipe(
                tap((event) => {
                  if (
                    event.type !== EventType.TEXT_MESSAGE_CONTENT ||
                    typeof event.messageId !== "string" ||
                    typeof event.delta !== "string"
                  )
                    return;
                  const reply = {
                    id: event.messageId,
                    role: "assistant" as const,
                    content: event.delta,
                  };
                  agent.messages = [...agent.messages, reply];
                  messages.push(reply);
                }),
              );
            },
            stop: async () => true,
          },
        }),
      async () => {},
      async () => {
        throw new Error("Budgeted work reached the legacy runner");
      },
    );
  await database.insert(users).values({
    id: owner.id,
    email: `${owner.id}@example.test`,
    name: "Billing fixture",
  });
  const profiles = createAgentProfileStore(
    database,
    new URL("https://fixture.example.test/ag-ui"),
  );
  const channelStore = createChannelStore(
    database,
    profiles,
    createThreadIdentity("billing-fixture"),
  );
  const routineStore = createRoutineStore(database);
  const taskStore = createTaskStore(database);
  const bot = await profiles.create(owner, {
    name: "Billing fixture Bot",
    title: "Fixture",
    roleDescription: "Return text",
    visibility: "private",
  });
  const channel = await channelStore.create(owner, [bot.id]);
  let taskRun: { id: string; channelId: string } | undefined;
  try {
    const routine = await routineStore.create({
      ownerUserId: owner.id,
      agentId: bot.id,
      channelId: channel.id,
      cron: "0 9 * * *",
      instruction: "Summarize today's notes.",
      budgetId: "runner-tiny",
    });
    const routineRunner = () =>
      createRoutineRunner({
        routineStore,
        channelStore,
        runTurn: turnFor("routine"),
      });
    const { runId } = await routineStore.insertRun(
      routine.id,
      "fixture-replayed-firing",
    );
    expect(
      await routineStore.insertRun(routine.id, "fixture-replayed-firing"),
    ).toEqual({ runId });
    await routineRunner().run(runId);
    expect(await routineStore.listRuns(owner.id, routine.id)).toMatchObject([
      { id: runId, status: "waiting" },
    ]);
    expect(calls).toHaveLength(0);
    const [routinePoint] = (await ledger.resumePoints(identity)) ?? [];
    if (!routinePoint) throw new Error("No Routine resume point");
    await ledger.confirmResumePoint(
      identity,
      routinePoint.operationId,
      "runner-raised",
    );
    await routineRunner().run(runId);
    expect(calls).toHaveLength(0);
    await routineRunner().run(runId, {
      ownerUserId: owner.id,
      routineId: routine.id,
    });
    await routineRunner().run(runId);
    expect(await routineStore.listRuns(owner.id, routine.id)).toMatchObject([
      { id: runId, status: "succeeded" },
    ]);
    expect(calls).toEqual([routinePoint.operationId]);

    const settingId = crypto.randomUUID();
    const suggestionId = crypto.randomUUID();
    await database.insert(proactiveSettings).values({
      id: settingId,
      ownerUserId: owner.id,
      agentId: bot.id,
      channelId: channel.id,
      threadId: crypto.randomUUID(),
    });
    const item = {
      id: suggestionId,
      agentId: bot.id,
      title: "Summarize my notes",
      detail: "Notes were updated.",
      sourceApp: "Fixture",
      sourceLink: null,
    };
    await database.insert(proactiveSuggestions).values({
      ...item,
      ownerUserId: owner.id,
      settingId,
      runId: "billing-fixture-checkin",
      sourceRef: "fixture/search",
    });
    const tasks = () =>
      createTaskRunner({
        database,
        store: taskStore,
        channels: channelStore,
        actorFor: async () => owner,
        queue: createWorkQueue(database),
        owner: "billing-fixture-task",
        scopeFor: async (ownerUserId, channelId, agentId) => {
          const found = await channelStore.get(owner, channelId);
          return found
            ? { ownerUserId, channelId, agentId, threadId: found.threadId }
            : null;
        },
        canStartBudget: model.canStart,
        runTask: createTaskTurn({
          channels: channelStore,
          actorFor: async () => owner,
          runTurn: turnFor("task"),
        }),
      });
    const inFlight = await ledger.reserve(identity, {
      operationId: "trial-in-flight",
      route: routeId,
      priceVersion,
      creditType: "test",
      applicationId: "openbot",
    });
    if (inFlight.state !== "reserved")
      throw new Error("Fixture reserve failed");
    await ledger.beginDispatch(identity, {
      operationId: "trial-in-flight",
      permit: inFlight.permit,
    });
    const endTrial = createTrialAdminRoutes(ledger, async (context, next) => {
      context.set("actor", {
        id: owner.id,
        email: `${owner.id}@example.test`,
        role: context.req.header("x-fixture-admin") ? "admin" : "user",
      });
      await next();
    });
    const endPath = `/trials/${accountId}/end`;
    expect((await endTrial.request(endPath, { method: "POST" })).status).toBe(
      403,
    );
    const end = () =>
      endTrial.request(endPath, {
        method: "POST",
        headers: { "x-fixture-admin": "yes" },
      });
    expect((await end()).status).toBe(200);
    expect((await end()).status).toBe(200);
    expect(await ledger.balance(identity)).toMatchObject({ trialEnded: true });
    const settled = await ledger.settle(accountId, "trial-in-flight", {
      inputTokens: 3n,
      outputTokens: 0n,
    });
    expect(settled).toMatchObject({ state: "settled", creditType: "test" });
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: "95",
      reservedMicrocredits: "0",
      chargedMicrocredits: "5",
    });

    const originalTaskWorker = tasks();
    const task = await originalTaskWorker.startFromItem({
      ownerUserId: owner.id,
      item,
      budgetId: "runner-raised",
    });
    taskRun = task;
    await originalTaskWorker.idle();
    const paused = await taskStore.get(owner.id, task.id);
    expect(paused.status).toBe("needs_input");
    if (!paused.billingOperationId) throw new Error("No Task resume point");
    expect(await ledger.resumePoints(identity)).toMatchObject([
      {
        operationId: paused.billingOperationId,
        reason: "trial_ended",
      },
    ]);
    const replacementTaskWorker = tasks();
    await replacementTaskWorker.sweep();
    expect(calls).toHaveLength(1);
    expect(await paidLedger.paidBalance(accountId)).toMatchObject({
      availableMicrocredits: "100",
      reservedMicrocredits: "0",
      chargedMicrocredits: "0",
    });
    expect(
      await ledger.confirmResumePoint(
        identity,
        paused.billingOperationId,
        "runner-raised",
      ),
    ).toEqual({ state: "denied" });
    const paidBudget = await budgetOf(identity, {
      budgetId: "runner-paid",
      limitMicrocredits: 30n,
      creditType: "paid",
      modelQuote,
    });
    expect(calls).toHaveLength(1);
    expect(
      await ledger.reserve(identity, {
        operationId: paused.billingOperationId,
        route: routeId,
        priceVersion,
        creditType: "paid",
        budgetId: paidBudget.budgetId,
        applicationId: "openbot",
      }),
    ).toEqual({ state: "denied", reason: "trial_ended" });
    const api = createTestCreditRoutes({
      ledger,
      paid: { ledger: paidLedger },
      authenticate: async () => identity,
    });
    const confirmation = await api.request(
      `/resume-points/${paused.billingOperationId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetId: paidBudget.budgetId }),
      },
    );
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toMatchObject({
      state: "confirmed",
      creditType: "paid",
    });
    await replacementTaskWorker.continueBudgeted(owner.id, task.id);
    await replacementTaskWorker.idle();
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      next: "Fixture reply.",
    });
    expect(calls).toEqual([
      routinePoint.operationId,
      paused.billingOperationId,
    ]);
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: "95",
      reservedMicrocredits: "0",
      chargedMicrocredits: "5",
    });
    expect(await paidLedger.paidBalance(accountId)).toMatchObject({
      availableMicrocredits: "98",
      reservedMicrocredits: "0",
      chargedMicrocredits: "2",
    });
    expect(
      await ledger.receipt(identity, paused.billingOperationId),
    ).toMatchObject({
      creditType: "paid",
      budgetId: paidBudget.budgetId,
    });
    const bill = await api.request("/paid/bill");
    expect(await bill.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "trial-in-flight",
          applicationId: "openbot",
          source: "test",
          amountMicrocredits: "3",
        }),
        expect.objectContaining({
          operationId: paused.billingOperationId,
          applicationId: "openbot",
          source: "credit_pack",
          amountMicrocredits: "2",
        }),
      ]),
    );
    await expect(
      paidLedger.requestRefund(batchIds.at(-1) ?? ""),
    ).rejects.toMatchObject({
      code: "order_unknown",
    });
  } finally {
    await database
      .delete(enterpriseSettings)
      .where(
        eq(enterpriseSettings.key, `billing.test-credit-ended.${accountId}`),
      );
    if (taskRun) {
      await database
        .delete(workItems)
        .where(sql`${workItems.payload}->>'taskId' = ${taskRun.id}`);
      await database.delete(channels).where(eq(channels.id, taskRun.channelId));
    }
    await database.delete(users).where(eq(users.id, owner.id));
    await database.delete(channels).where(eq(channels.id, channel.id));
    await database.delete(agents).where(eq(agents.id, bot.id));
  }
});

test("a revoked owner cannot send a reserved step after the input meter finishes", async () => {
  const { identity } = await enrolled("late-auth", 100n);
  const budget = await budgetOf(identity, {
    budgetId: "late-auth",
    modelQuote: { route: routeId, priceVersion },
    creditType: "test",
    limitMicrocredits: 20n,
  });
  const scope = {
    kind: "routine" as const,
    personId: "fixture-owner",
    executionId: "fixture-late-auth",
    budgetId: budget.budgetId,
  };
  let authorized = true;
  let sent = false;
  const makeWorker = () =>
    createBackgroundModel({
      ledger,
      identityOf: async () => identity,
      execute: async ({ bindGatewayRequest }) => {
        authorized = false;
        await bindGatewayRequest({
          requestId: crypto.randomUUID(),
          digest: "a".repeat(64),
        });
        sent = true;
        return {
          text: "Should not reach the provider",
          usage: { inputTokens: 2, outputTokens: 0 },
        };
      },
    });
  const step = {
    step: "reply",
    messages: [{ role: "user" as const, content: "Fixture prompt" }],
    authorize: async () => {
      if (!authorized) throw new Error("The owner's access expired");
    },
  };
  const operationId = backgroundModelOperationId(scope, step.step);
  await expect(makeWorker().complete(scope, step)).rejects.toMatchObject({
    reason: "route_unavailable",
  });
  expect(sent).toBe(false);
  expect(await ledger.receipt(identity, operationId)).toMatchObject({
    state: "released",
    dispatchedAt: null,
    heldMicrocredits: "0",
  });
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
  });
  authorized = true;
  await expect(makeWorker().complete(scope, step)).rejects.toMatchObject({
    reason: "route_unavailable",
  });
  expect(sent).toBe(false);
});
