import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import type { AgentProfile } from "../src/agents/profile-types";
import { type AuditVocabulary, createAuditAskRoutes } from "../src/audit-ask";
import type { AppVariables } from "../src/auth/guards";
import { createPilotAuxiliaryModel } from "../src/billing/auxiliary-model";
import { createCasdoorBillingIdentity } from "../src/billing/direct-chat-test-credit";
import { loadDirectChatTestCredit } from "../src/billing/direct-chat-test-credit-config";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import {
  createTestCreditLedger,
  type VerifiedBillingIdentity,
} from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  enterpriseSettings,
  lagoUsageEvents,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  testCreditResumePoints,
  users,
} from "../src/db/schema";
import { createManagedModel } from "../src/managed-model-trial";
import { createIntentRouter } from "../src/routing/classify";
import { createRoutingRoutes } from "../src/routing/routes";
import { createCoworkerRoutingService } from "../src/routing/service";
import auditFixture from "./fixtures/audit-ask-recorded.json";
import auditDeployment from "./fixtures/audit-ask-vocabulary.json";
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
const fixtureAccountIds: string[] = [];
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
    if (first?.role !== "user") throw new Error("no user message to answer");
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

async function enrolled(
  tag: string,
  testGrant: bigint,
  identity: VerifiedBillingIdentity = {
    issuer: `managed-model-routes-${tag}`,
    subject: crypto.randomUUID(),
  },
) {
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
  fixtureAccountIds.push(row.id);
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
    const ids = fixtureAccountIds;
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
        .delete(testCreditBudgets)
        .where(inArray(testCreditBudgets.accountId, ids));
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

  expect(await model.complete(input)).toEqual({
    state: "completed",
    text: "Answer to: One question",
  });
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

test("routing and Audit Ask settle against their own accounts and refuse unbillable dispatch", async () => {
  const casdoor = {
    issuer: "https://casdoor.example.test",
    providerId: "fixture",
  };
  const personId = crypto.randomUUID();
  const person = await enrolled("aux-user", 40n, {
    issuer: casdoor.issuer,
    subject: crypto.randomUUID(),
  });
  await database.insert(users).values({
    id: personId,
    email: `${personId}@example.test`,
    name: "Pilot person",
  });
  await database.insert(accounts).values({
    id: crypto.randomUUID(),
    userId: personId,
    providerId: casdoor.providerId,
    issuer: casdoor.issuer,
    accountId: person.identity.subject,
  });
  const platform = await enrolled("aux-platform", 40n, {
    issuer: "openbot:platform",
    subject: "audit-ask",
  });
  const budgetId = "issue-96-audit";

  const gatewayIds: string[] = [];
  const meterIds: string[] = [];
  let meterAvailable = true;
  const recording = auditFixture.answered;
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const operationId = request.headers.get("x-openbot-operation-id") ?? "";
      if (new URL(request.url).pathname === "/meter") {
        meterIds.push(operationId);
        if (!meterAvailable) return new Response(null, { status: 503 });
        return Response.json({
          gatewayRevision: routeSpec.gatewayRevision,
          meteringRevision: routeSpec.meteringRevision,
          inputTokenUpperBound: 7,
          requestId: request.headers.get("x-request-id"),
          requestSha256: Bun.CryptoHasher.hash(
            "sha256",
            await request.text(),
            "hex",
          ),
        });
      }
      gatewayIds.push(operationId);
      const { messages } = await request.json();
      const prompt = messages[0].content;
      const content = prompt.includes("<question>")
        ? recording.writer[0]
        : prompt.includes("You read one set of filters")
          ? recording.reader
          : '{"agentId":"specialist","confidence":1}';
      return Response.json({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      });
    },
  });
  const settings = loadDirectChatTestCredit({
    OPENBOT_TEST_CREDIT_CONVERSATIONS: "enabled",
    TEST_CREDIT_CASDOOR_ISSUER: casdoor.issuer,
    TEST_CREDIT_CASDOOR_PROVIDER_ID: casdoor.providerId,
    TEST_CREDIT_BIFROST_URL: new URL("/v1/chat/completions", gateway.url).href,
    TEST_CREDIT_BIFROST_TOKEN: "fixture-gateway",
    TEST_CREDIT_GATEWAY_REVISION: routeSpec.gatewayRevision,
    TEST_CREDIT_GATEWAY_IMAGE_DIGEST: fixtureTraceReport(harnessImage, proposed)
      .gatewayImageDigest,
    TEST_CREDIT_INPUT_METER_URL: new URL("/meter", gateway.url).href,
    TEST_CREDIT_INPUT_METER_TOKEN: "fixture-meter",
    TEST_CREDIT_METERING_REVISION: routeSpec.meteringRevision,
  });
  if (!settings) throw new Error("Expected pilot settings");
  let ledgerAvailable = true;
  const metered = createPilotAuxiliaryModel({
    ledger: {
      ...ledger,
      async reserve(...args) {
        if (!ledgerAvailable) throw new Error("ledger offline");
        return ledger.reserve(...args);
      },
    },
    execute: settings.execute,
    identityOf: createCasdoorBillingIdentity(database, settings.casdoor),
    platformBudgetId: budgetId,
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: personId,
      email: "person@openbot.test",
      role: "admin",
    });
    await next();
  };
  const roster: AgentProfile[] = ["general", "specialist"].map((id) => ({
    id,
    name: id,
    title: id,
    roleDescription: id,
    avatarSeed: id,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    isolated: false,
    ownerUserId: personId,
    systemOwned: false,
    visibility: "public",
  }));
  const app = new Hono()
    .route(
      "/api/route",
      createRoutingRoutes(
        createCoworkerRoutingService({
          store: { list: async () => roster },
          router: createIntentRouter({
            complete: (prompt, options) => metered(prompt, undefined, options),
          }),
        }),
        requireUser,
      ),
    )
    .route(
      "/api/admin/audit-events",
      createAuditAskRoutes({
        requireUser,
        complete: metered,
        platformBudgetId: budgetId,
        vocabulary: async () => auditDeployment.vocabulary as AuditVocabulary,
        now: () => new Date(auditDeployment.asked.now),
      }),
    );
  const post = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const routingRequestId = crypto.randomUUID();
  const publishedQuote = await ledger.quote();
  if (!publishedQuote) throw new Error("Routing quote missing");
  const confirmation = {
    route: publishedQuote.route,
    priceVersion: publishedQuote.priceVersion,
  };
  const route = (
    requestId = crypto.randomUUID(),
    confirmed?: typeof confirmation,
  ) =>
    post("/api/route", {
      text: "Review this policy.",
      requestId,
      confirmation: confirmed,
    });
  const ask = () =>
    post("/api/admin/audit-events/ask", {
      question: recording.text,
      timeZone: auditDeployment.asked.timeZone,
    });
  try {
    const preview = await route(routingRequestId);
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({
      quote: { ...confirmation, creditType: "test" },
    });
    expect(
      (
        await route(routingRequestId, {
          ...confirmation,
          priceVersion: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(meterIds).toHaveLength(0);
    expect(gatewayIds).toHaveLength(0);
    expect(await ledger.balance(person.identity)).toMatchObject({
      chargedMicrocredits: "0",
      reservedMicrocredits: "0",
    });
    expect(
      await (await route(routingRequestId, confirmation)).json(),
    ).toMatchObject({
      agentId: "specialist",
      fallback: false,
    });
    expect(
      await (await route(routingRequestId, confirmation)).json(),
    ).toMatchObject({
      agentId: "specialist",
      fallback: false,
    });
    expect(gatewayIds).toHaveLength(1);
    const personalAfterRouting = await ledger.balance(person.identity);
    expect(personalAfterRouting).toMatchObject({ chargedMicrocredits: "7" });
    expect((await ask()).status).toBe(502);
    expect(meterIds).toHaveLength(1);
    await ledger.createBudget(platform.identity, {
      budgetId,
      creditType: "test",
      limitMicrocredits: 17n,
    });
    expect((await ask()).status).toBe(200);
    expect(await ledger.balance(person.identity)).toEqual(personalAfterRouting);
    expect(await ledger.balance(platform.identity)).toMatchObject({
      chargedMicrocredits: "14",
      reservedMicrocredits: "0",
    });
    expect(new Set(gatewayIds).size).toBe(3);
    expect(meterIds).toEqual(gatewayIds);
    for (const [account, ids] of [
      [person, gatewayIds.slice(0, 1)],
      [platform, gatewayIds.slice(1)],
    ] as const) {
      const bill = await paid.bill(account.accountId);
      expect(bill.map((line) => line.operationId).sort()).toEqual(
        [...ids].sort(),
      );
      const evidence = await database
        .select()
        .from(testCreditEvidence)
        .where(eq(testCreditEvidence.accountId, account.accountId));
      expect(evidence.map((row) => row.operationId).sort()).toEqual(
        [...ids].sort(),
      );
    }

    expect((await ask()).status).toBe(502); // platform budget exhausted
    expect(meterIds).toHaveLength(3);
    ledgerAvailable = false;
    expect(
      await (await route(crypto.randomUUID(), confirmation)).json(),
    ).toMatchObject({
      undecided: "unreachable",
    });
    expect(meterIds).toHaveLength(3);
    ledgerAvailable = true;
    meterAvailable = false;
    expect(
      await (await route(crypto.randomUUID(), confirmation)).json(),
    ).toMatchObject({
      undecided: "unreachable",
    });
    expect(meterIds).toHaveLength(4);
    expect(gatewayIds).toHaveLength(3);
    expect(await ledger.balance(person.identity)).toEqual(personalAfterRouting);
  } finally {
    await gateway.stop(true);
    await database.delete(accounts).where(eq(accounts.userId, personId));
    await database.delete(users).where(eq(users.id, personId));
  }
});
