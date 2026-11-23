import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import {
  createTestCreditLedger,
  type VerifiedBillingIdentity,
} from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  lagoUsageEvents,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  testCreditResumePoints,
} from "../src/db/schema";
import { createManagedModel } from "../src/managed-model-trial";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * OpenBot's own model call against the real ledger (#86: every charged step
 * goes through the same reservation and dispatch entry). The adapter wired
 * into the server, the ledger's routes and a stub executor, end to end: what
 * it reserves settles once, its bill names OpenBot, a call out of Test
 * credits is refused, and nothing of that waits as a resume point.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ledger = createTestCreditLedger(database);
const paid = createPaidCreditLedger(database);
const routeId = "managed-model";
const routeSpec = {
  provider: "fixture-managed",
  model: "model-managed",
  gatewayRevision: "managed-r1",
  meteringRevision: "managed-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
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

const identities: Record<string, VerifiedBillingIdentity> = {};
const dispatched: string[] = [];
const batchIds: string[] = [];
// The ledger's entry as a deployment mounts it: the service credential names
// the person, and the controlled executor is behind it.
const api = createTestCreditRoutes({
  ledger,
  authenticate: async (request, intent) =>
    intent === "execution"
      ? identities[request.headers.get("authorization") ?? ""]
      : undefined,
  execute: async ({ messages }) => {
    const first = messages[0];
    if (!first) throw new Error("no message to answer");
    dispatched.push(first.content);
    return {
      text: `Answer to: ${first.content}`,
      usage: { inputTokens: 7, outputTokens: 0 },
    };
  },
});
const entry = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => api.fetch(request),
});

let originalCatalog: { value: unknown } | undefined;

async function enrolled(tag: string, testGrant: bigint) {
  const identity: VerifiedBillingIdentity = {
    issuer: `managed-model-routes-${tag}`,
    subject: crypto.randomUUID(),
  };
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({ identity, batchId, amount: testGrant });
  await ledger.claim(identity, batchId);
  // The adapter presents its token as a bearer credential.
  const credential = `${tag}-token`;
  identities[`Bearer ${credential}`] = identity;
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
  return { identity, accountId: row.id, credential };
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
});

afterAll(async () => {
  await entry.stop(true);
  await database.transaction(async (tx) => {
    // By issuer prefix, so orphaned rows from a crashed run clean up too.
    const rows = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          ["funded", "empty"].map((tag) => `managed-model-routes-${tag}`),
        ),
      );
    const ids = rows.map(({ id }) => id);
    if (ids.length > 0) {
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
        .delete(testCreditResumePoints)
        .where(inArray(testCreditResumePoints.accountId, ids));
      await tx
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, ids));
      await tx
        .delete(testCreditAccounts)
        .where(inArray(testCreditAccounts.id, ids));
    }
    if (batchIds.length > 0)
      await tx
        .delete(testCreditBatches)
        .where(inArray(testCreditBatches.id, batchIds));
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

const scope = (personId: string) => ({
  source: "direct-chat" as const,
  personId,
  runId: "run-1",
  conversationId: "conversation-1",
  botId: "bot-1",
});
const call = {
  step: "direct-chat-answer",
  route: routeId,
  messages: [{ role: "user" as const, content: "One question" }],
};

test("OpenBot's own model call goes through the ledger's entry, settles once and names OpenBot on the bill", async () => {
  const { identity, accountId, credential } = await enrolled("funded", 40n);
  const model = createManagedModel({
    url: new URL(entry.url.href),
    token: credential,
  });
  const input = { ...call, scope: scope(identity.subject) };

  expect(await model.complete(input)).toEqual({
    state: "completed",
    text: "Answer to: One question",
  });
  expect(dispatched).toEqual(["One question"]);
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "33",
    reservedMicrocredits: "0",
    chargedMicrocredits: "7",
  });
  const [operation] = await database
    .select()
    .from(testCreditOperations)
    .where(
      and(
        eq(testCreditOperations.accountId, accountId),
        eq(testCreditOperations.state, "settled"),
      ),
    );
  expect(operation).toMatchObject({
    applicationId: "openbot",
    charged: 7n,
    inputTokens: 7n,
  });
  expect(await paid.bill(accountId)).toEqual([
    expect.objectContaining({
      operationId: operation?.id,
      applicationId: "openbot",
      source: "test",
      amountMicrocredits: "7",
    }),
  ]);

  // The same call again asks as the same operation: it is answered from the
  // record, and nothing is dispatched or charged a second time.
  expect(await model.complete(input)).toEqual({ state: "settled" });
  expect(dispatched).toHaveLength(1);
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "33",
    chargedMicrocredits: "7",
  });

  // A credential the entry does not know reaches nothing.
  const stranger = createManagedModel({
    url: new URL(entry.url.href),
    token: "no-such-token",
  });
  expect(await stranger.complete(input)).toEqual({ state: "unavailable" });
  expect(dispatched).toHaveLength(1);
});

test("a call out of Test credits is refused and, since nothing retries it, waits nowhere", async () => {
  const { identity, credential } = await enrolled("empty", 2n);
  const model = createManagedModel({
    url: new URL(entry.url.href),
    token: credential,
  });
  expect(
    await model.complete({ ...call, scope: scope(identity.subject) }),
  ).toEqual({ state: "insufficient_credits" });
  expect(dispatched).toHaveLength(1);
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "2",
    reservedMicrocredits: "0",
  });
  // A chat turn is retried by the person sending again, as a new operation,
  // so the refused one must not wait under Paused tasks.
  expect(await ledger.resumePoints(identity)).toEqual([]);

  // A runner that does retry the same operation still gets its resume point.
  const quote = await ledger.quote();
  if (!quote) throw new Error("the route is not quoted");
  expect(
    await ledger.reserve(identity, {
      operationId: "resumable-step",
      route: routeId,
      priceVersion: quote.priceVersion,
    }),
  ).toEqual({ state: "denied", reason: "insufficient_credits" });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    { operationId: "resumable-step", reason: "insufficient_credits" },
  ]);
});
