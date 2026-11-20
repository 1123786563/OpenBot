import { expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createBifrostCreditExecutor } from "../src/billing/test-credit-bifrost";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { createManagedModel, type ModelOperation } from "../src/managed-model";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("pilot routes isolate accounts and settle one of two concurrent admissions exactly once", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  let now = Date.UTC(2026, 0, 1);
  const ledger = createTestCreditLedger(database, () => new Date(now));
  const issuer = `https://casdoor.example.test/${crypto.randomUUID()}`;
  const first = { issuer, subject: crypto.randomUUID() };
  const second = { issuer, subject: crypto.randomUUID() };
  const batchId = crypto.randomUUID();
  const firstToken = crypto.randomUUID();
  let token = firstToken;
  const secondToken = crypto.randomUUID();
  let sends = 0;
  const sent: { model: string; max_tokens: number }[] = [];
  const externalGateway = process.env.OPENBOT_TEST_BIFROST_FIXTURE_URL;
  let lastOperationId: string | null = null;
  let lastDispatchAccountId: string | undefined;
  let duringMetering: (() => Promise<void>) | undefined;
  let afterAlternateDispatch: (() => Promise<void>) | undefined;
  const gateway = Bun.serve({
    hostname: externalGateway ? "0.0.0.0" : "127.0.0.1",
    port: externalGateway ? 33139 : 0,
    async fetch(request) {
      const input = await request.json();
      sent.push(input);
      sends++;
      if (!externalGateway)
        expect(request.headers.get("x-openbot-operation-id")).toBe(
          lastOperationId,
        );
      if (sends === 2) return new Response(null, { status: 502 });
      return Response.json({
        id: "fixture-completion",
        object: "chat.completion",
        created: 1,
        model: input.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "answer" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 4 },
      });
    },
  });
  const execute = createBifrostCreditExecutor({
    endpoint: new URL("/v1/chat/completions", externalGateway ?? gateway.url),
    gatewayRevision: "a",
    meteringRevision: "a",
    countInputTokens: async (_route, messages) => {
      if (messages[0]?.content === "withdraw-while-metering")
        await duringMetering?.();
      return messages[0]?.content === "oversized" ? 4 : 1;
    },
  });
  const api = createTestCreditRoutes({
    ledger,
    authenticate: async (request, intent) => {
      if (
        intent === "execution" &&
        request.headers.get("authorization") === "Bearer account-only"
      )
        return undefined;
      switch (request.headers.get("authorization")) {
        case "Bearer account-only":
        case `Bearer ${firstToken}`:
          return first;
        case `Bearer ${secondToken}`:
          return second;
        default:
          return undefined;
      }
    },
    async execute(input) {
      lastOperationId = input.operationId;
      lastDispatchAccountId = input.accountId;
      switch (input.messages[0]?.content) {
        case "zero":
          return {
            outcome: "zero_cost",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        case "failure":
          return {
            outcome: "platform_failure",
            usage: { inputTokens: 8, outputTokens: 0 },
          };
        case "cancel":
          return {
            outcome: "cancelled",
            usage: { inputTokens: 16, outputTokens: 0 },
          };
        default: {
          const result = await execute(input);
          if (input.route.id === "alternate") await afterAlternateDispatch?.();
          return result;
        }
      }
    },
  });
  const request = async (path: string, body?: object, key: string = token) => {
    const response = await api.request(path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: api.fetch,
  });
  const originalCatalog = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const saveCatalog = async (value: typeof emptyCatalog) => {
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value })
      .onConflictDoUpdate({ target: enterpriseSettings.key, set: { value } });
  };
  try {
    const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
    const route = {
      provider: "fixture-a",
      model: "model-a",
      gatewayRevision: "a",
      meteringRevision: "a",
      maxInputTokens: 3,
      maxOutputTokens: 16,
      tools: false,
      price: { inputPerMillion: 250_000, outputPerMillion: 78_125 },
    };
    const catalog = configure(emptyCatalog, {
      harnessImage,
      routes: {
        pilot: route,
        alternate: { ...route, provider: "fixture-b", model: "model-b" },
      },
    });
    const verified = verify(
      catalog,
      "pilot",
      {
        revision: catalog.routes.pilot?.revision,
        harnessImage,
        provider: route.provider,
        model: route.model,
        gatewayRevision: "a",
        meteringRevision: "a",
        source: "live-provider",
        artifactDigest: `sha256:${"c".repeat(64)}`,
        gatewayImageDigest: `sha256:${"d".repeat(64)}`,
        retryCount: 0,
        fallbacks: [],
        stream: {
          requestId: "stream",
          upstreamRequestId: "upstream",
          outputChunks: 2,
          inputTokens: 1,
          outputTokens: 4,
        },
        cancellation: {
          requestId: "cancel",
          upstreamRequestId: "upstream-cancel",
          upstreamOutcome: "cancelled",
        },
        limits: {
          requestId: "limits",
          upstreamRequestId: "upstream-limits",
          rejectedRequestId: "rejected",
          inputCap: 3,
          outputCap: 16,
          oversizedInput: "rejected-before-upstream",
          outputStop: "length",
        },
      },
      "fixture",
    );
    const primaryEvidence = verified.routes.pilot?.verification?.report;
    const alternate = verified.routes.alternate;
    if (!primaryEvidence || !alternate)
      throw new Error("Missing fixture route");
    const bothVerified = verify(
      verified,
      "alternate",
      {
        ...primaryEvidence,
        revision: alternate.revision,
        provider: alternate.provider,
        model: alternate.model,
      },
      "fixture",
    );
    const { catalog: published, release } = publish(
      bothVerified,
      ["pilot", "alternate"],
      "pilot",
      "fixture",
    );
    await saveCatalog(published);
    const pick = { id: "alternate", revision: alternate.revision };
    expect(await ledger.resolveQuote({})).toMatchObject({
      source: "harness",
      quote: { route: "pilot" },
    });
    expect(await ledger.resolveQuote({ bot: pick })).toMatchObject({
      source: "bot",
      quote: { route: "alternate", provider: "fixture-b", model: "model-b" },
    });
    expect(
      await ledger.resolveQuote({
        bot: pick,
        conversation: { id: "pilot", revision: primaryEvidence.revision },
      }),
    ).toMatchObject({ source: "conversation", quote: { route: "pilot" } });
    expect(
      await ledger.resolveQuote({
        bot: pick,
        conversation: { ...pick, revision: crypto.randomUUID() },
      }),
    ).toMatchObject({
      source: "conversation",
      reason: expect.stringContaining("Choose another"),
    });
    await Promise.all([
      ledger.enroll({ identity: first, batchId, amount: 2n }),
      ledger.enroll({ identity: second, batchId, amount: 2n }),
    ]);
    await expect(
      ledger.enroll({ identity: first, batchId, amount: 3n }),
    ).rejects.toThrow("batch amount differs");
    expect((await request("/balance", undefined, "unverified")).status).toBe(
      401,
    );
    expect(
      (await request("/claim", { batchId, subject: second.subject })).status,
    ).toBe(400);
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => request("/claim", { batchId })),
    );
    expect(claims.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect((await request("/balance")).body.availableMicrocredits).toBe("2");
    expect(
      (await request("/balance", undefined, secondToken)).body
        .availableMicrocredits,
    ).toBe("0");
    expect((await request("/quote")).body).toMatchObject({
      creditType: "test",
      priceVersion: release.id,
      maxChargeMicrocredits: "2",
      usageDisclosure: expect.stringContaining("Interrupted"),
      price: route.price,
    });

    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const reserve = (operationId: string) =>
      request("/v1/reserve", {
        operationId,
        route: "pilot",
        priceVersion: release.id,
      });
    expect((await request("/balance", undefined, "account-only")).status).toBe(
      200,
    );
    expect(
      (
        await request(
          "/v1/reserve",
          {
            operationId: crypto.randomUUID(),
            route: "pilot",
            priceVersion: release.id,
          },
          "account-only",
        )
      ).status,
    ).toBe(401);
    const admissions = await Promise.all(ids.map(reserve));
    expect(admissions.map(({ body }) => body.state).sort()).toEqual([
      "denied",
      "reserved",
    ]);
    const index = admissions.findIndex(({ body }) => body.state === "reserved");
    const operationId = ids[index] ?? "";
    const consumed = {
      operationId,
      permit: admissions[index]?.body.permit,
      messages: [{ role: "user", content: "question" }],
    };
    expect((await reserve(operationId)).body).toMatchObject({
      state: "existing",
      permit: consumed.permit,
      operation: { state: "reserved" },
    });
    expect(
      (await request("/v1/dispatch", consumed, secondToken)).body.reason,
    ).toBe("not_authorized");
    const repriced = publish(
      configure(verified, {
        harnessImage,
        routes: {
          pilot: {
            ...route,
            price: { inputPerMillion: 600_000, outputPerMillion: 125_000 },
          },
        },
      }),
      ["pilot"],
      "pilot",
      "fixture",
    );
    await saveCatalog(repriced.catalog);
    expect(await ledger.resolveQuote({})).toMatchObject({
      quote: { priceVersion: repriced.release.id, maxChargeMicrocredits: "4" },
    });
    expect((await reserve(crypto.randomUUID())).body.reason).toBe(
      "route_unavailable",
    );
    const dispatches = await Promise.all([
      request("/v1/dispatch", consumed),
      request("/v1/dispatch", consumed),
    ]);
    expect(dispatches.some(({ body }) => body.state === "completed")).toBe(
      true,
    );
    expect(sends).toBe(1);
    expect((await reserve(operationId)).body.state).toBe("existing");
    expect((await request(`/operations/${operationId}`)).body).toMatchObject({
      state: "settled",
      priceVersion: release.id,
      price: route.price,
      reservedMicrocredits: "2",
      chargedMicrocredits: "1",
      releasedMicrocredits: "1",
    });
    expect(
      (await request(`/operations/${operationId}`, undefined, secondToken))
        .status,
    ).toBe(404);
    expect(
      (await request("/v1/reconcile", { operationId }, secondToken)).body.state,
    ).toBe("absent");

    await request("/claim", { batchId }, secondToken);
    token = secondToken;
    await saveCatalog(published);
    const executionHeaders = async () => ({
      authorization: `Bearer ${secondToken}`,
    });
    const client = createManagedModel({ url: listener.url, executionHeaders });
    const workerOperation: ModelOperation = {
      scope: {
        source: "learning",
        personId: "persisted-person",
        conversationId: "persisted-conversation",
        botId: "persisted-bot",
        runId: "persisted-run",
      },
      step: "extract",
    };
    const input = {
      ...workerOperation,
      route: "pilot",
      priceVersion: release.id,
      messages: [{ role: "user", content: "question" }],
    } satisfies Parameters<typeof client.complete>[0];
    expect(await client.complete(input)).toEqual({ state: "reconciling" });
    const restartedWorker = createManagedModel({
      url: listener.url,
      executionHeaders,
    });
    expect(await restartedWorker.complete(input)).toEqual({
      state: "reconciling",
    });
    expect(await restartedWorker.reconcile(workerOperation)).toBe("pending");
    const originalId = lastOperationId;
    const originalAccountId = lastDispatchAccountId;
    if (!originalId || !originalAccountId)
      throw new Error("Fixture dispatch lacked correlation");
    const originalReceipt = () =>
      request(`/operations/${originalId}`, undefined, secondToken);
    expect((await originalReceipt()).body).toMatchObject({
      state: "pending",
      outcome: "unknown",
    });
    expect((await request("/balance")).body).toMatchObject({
      availableMicrocredits: "0",
      reservedMicrocredits: "2",
    });
    expect(sends).toBe(2);
    expect(await ledger.sweepCutoffs()).toBe(0);

    token = firstToken;
    const releaseBatch = crypto.randomUUID();
    await ledger.enroll({ identity: first, batchId: releaseBatch, amount: 1n });
    await request("/claim", { batchId: releaseBatch });
    const interrupted = async () => {
      const operationId = crypto.randomUUID();
      const { body } = await reserve(operationId);
      now += 60_000;
      const dispatched = await ledger.beginDispatch(first, {
        operationId,
        permit: body.permit,
      });
      if (dispatched.state !== "dispatch")
        throw new Error("Fixture dispatch denied");
      return { accountId: dispatched.accountId, operationId };
    };
    const timely = await interrupted();
    const partial = {
      evidenceId: "fixture-partial",
      outcome: "partial",
      inputTokens: 2n,
      outputTokens: 0n,
    } as const;
    now += 24 * 60 * 60_000 - 1;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        ledger.recordEvidence(timely.accountId, timely.operationId, partial),
      ),
    );
    expect(
      (await request(`/operations/${timely.operationId}`)).body,
    ).toMatchObject({ state: "pending", heldMicrocredits: "2" });
    now++;
    // Inspect storage before making any request that would itself apply the cutoff.
    const persisted = async (accountId: string, id: string) => {
      const [row] = await database
        .select({
          state: testCreditOperations.state,
          hold: testCreditOperations.cutoffHold,
        })
        .from(testCreditOperations)
        .where(
          and(
            eq(testCreditOperations.accountId, accountId),
            eq(testCreditOperations.id, id),
          ),
        );
      return row;
    };
    expect(await persisted(originalAccountId, originalId)).toEqual({
      state: "pending",
      hold: null,
    });
    expect(await persisted(timely.accountId, timely.operationId)).toEqual({
      state: "pending",
      hold: null,
    });
    await database.transaction(async (tx) => {
      await tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.id, originalAccountId))
        .for("update");
      expect(await ledger.sweepCutoffs(1)).toBe(0);
    });
    expect(await ledger.sweepCutoffs(1)).toBe(1);
    expect(await persisted(originalAccountId, originalId)).toEqual({
      state: "released",
      hold: 0n,
    });
    expect(await persisted(timely.accountId, timely.operationId)).toEqual({
      state: "pending",
      hold: null,
    });
    const parallelLedger = createTestCreditLedger(
      database,
      () => new Date(now),
    );
    const swept = await Promise.all([
      ledger.sweepCutoffs(1),
      parallelLedger.sweepCutoffs(1),
    ]);
    expect(swept.sort()).toEqual([0, 1]);
    expect(await persisted(timely.accountId, timely.operationId)).toEqual({
      state: "pending",
      hold: 1n,
    });
    expect(await ledger.sweepCutoffs(1)).toBe(0);
    expect(sends).toBe(2);
    const cutoff = await Promise.all([
      request(`/operations/${timely.operationId}`),
      request("/balance"),
      ledger.recordEvidence(timely.accountId, timely.operationId, {
        evidenceId: "fixture-late",
        outcome: "cancelled",
        inputTokens: 12n,
        outputTokens: 0n,
      }),
    ]);
    expect(cutoff[0].body).toMatchObject({
      state: "pending",
      heldMicrocredits: "1",
      releasedMicrocredits: "1",
    });
    expect(cutoff[1].body).toMatchObject({ reservedMicrocredits: "1" });
    const replays = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("/v1/reconcile", { operationId: timely.operationId }),
      ),
    );
    for (const { body } of replays)
      expect(body).toMatchObject({
        state: "settled",
        operation: { outcome: "partial", chargedMicrocredits: "1" },
      });
    expect(
      await ledger.recordEvidence(
        timely.accountId,
        timely.operationId,
        partial,
      ),
    ).toMatchObject({ platformMicrocredits: "2" });
    expect(await restartedWorker.complete(input)).toEqual({
      state: "released",
    });
    expect((await originalReceipt()).body).toMatchObject({
      state: "released",
      outcome: "unknown",
      chargedMicrocredits: null,
      releasedMicrocredits: "2",
    });
    const secondBalance = await ledger.balance(second);
    expect(
      await ledger.recordEvidence(originalAccountId, originalId, {
        ...partial,
        inputTokens: 8n,
      }),
    ).toMatchObject({ platformMicrocredits: "2" });
    expect(await ledger.balance(second)).toEqual(secondBalance);
    await expect(
      ledger.recordEvidence(timely.accountId, timely.operationId, {
        ...partial,
        inputTokens: 6n,
      }),
    ).rejects.toThrow("differs on replay");
    expect(
      await restartedWorker.complete({ ...input, rerunOf: workerOperation }),
    ).toEqual({
      state: "not_authorized",
    });
    expect(sends).toBe(2);
    const rerun = {
      ...input,
      rerunOf: workerOperation,
      step: "extract-explicit-rerun",
    };
    expect(
      await Promise.all([
        restartedWorker.complete(rerun),
        client.complete(rerun),
      ]),
    ).toContainEqual({ state: "completed", text: "answer" });
    expect(await restartedWorker.complete(rerun)).toEqual({ state: "settled" });
    expect(sends).toBe(3);
    expect(lastOperationId).not.toBe(originalId);
    expect(
      (await request(`/operations/${lastOperationId}`, undefined, secondToken))
        .body,
    ).toMatchObject({
      rerunOfOperationId: originalId,
      state: "settled",
      reservedMicrocredits: "2",
    });
    const extraBatch = crypto.randomUUID();
    await ledger.enroll({ identity: first, batchId: extraBatch, amount: 1n });
    await request("/claim", { batchId: extraBatch });
    const oversizedOperationId = crypto.randomUUID();
    const oversized = await reserve(oversizedOperationId);
    expect(
      (
        await request("/v1/dispatch", {
          operationId: oversizedOperationId,
          permit: oversized.body.permit,
          messages: [{ role: "user", content: "oversized" }],
        })
      ).body,
    ).toEqual({ state: "denied", reason: "execution_limit" });
    expect(
      (await request(`/operations/${oversizedOperationId}`)).body,
    ).toMatchObject({ state: "released", releasedMicrocredits: "2" });
    expect(sends).toBe(3);
    const withdrawnOperationId = crypto.randomUUID();
    const reserved = await reserve(withdrawnOperationId);
    await saveCatalog(configure(published, { harnessImage, routes: {} }));
    expect(await ledger.resolveQuote({ conversation: pick })).toMatchObject({
      source: "conversation",
      reason: expect.stringContaining("no longer verified"),
    });
    expect(
      (
        await request("/v1/dispatch", {
          ...consumed,
          operationId: withdrawnOperationId,
          permit: reserved.body.permit,
        })
      ).body.reason,
    ).toBe("route_unavailable");
    expect(
      (await request(`/operations/${withdrawnOperationId}`)).body,
    ).toMatchObject({
      state: "released",
      releasedMicrocredits: "2",
    });
    expect((await request(`/operations/${operationId}`)).body.state).toBe(
      "settled",
    );
    expect((await request("/quote")).status).toBe(404);
    await saveCatalog(published);
    const fixtureOutcomes = [
      {
        message: "zero",
        outcome: "zero_cost",
        state: "released",
        charged: null,
        released: "2",
      },
      {
        message: "failure",
        outcome: "platform_failure",
        state: "released",
        charged: null,
        released: "2",
      },
      {
        message: "cancel",
        outcome: "cancelled",
        state: "settled",
        charged: "2",
        released: "0",
      },
    ];
    token = firstToken;
    for (const fixture of fixtureOutcomes) {
      const operationId = crypto.randomUUID();
      const { body: reservation } = await reserve(operationId);
      const { body } = await request("/v1/dispatch", {
        operationId,
        permit: reservation.permit,
        messages: [{ role: "user", content: fixture.message }],
      });
      expect(
        await ledger.reconciliationCost(timely.accountId, operationId),
      ).toEqual(fixture.message === "zero" ? "0" : "2");
      expect(body).toMatchObject({
        state: fixture.state,
        operation: {
          outcome: fixture.outcome,
          chargedMicrocredits: fixture.charged,
          releasedMicrocredits: fixture.released,
        },
      });
    }
    const linked = crypto.randomUUID();
    token = secondToken;
    expect(
      (
        await request("/v1/reserve", {
          operationId: linked,
          rerunOfOperationId: originalId,
          route: "pilot",
          priceVersion: release.id,
        })
      ).body.reason,
    ).toBe("insufficient_credits");
    token = firstToken;
    expect(
      (
        await request("/v1/reserve", {
          operationId: linked,
          rerunOfOperationId: originalId,
          route: "pilot",
          priceVersion: release.id,
        })
      ).body.reason,
    ).toBe("not_authorized");
    const finalBatch = crypto.randomUUID();
    await ledger.enroll({ identity: first, batchId: finalBatch, amount: 2n });
    await request("/claim", { batchId: finalBatch });
    // A write failure after the balance and quote checks must leave no operation or dispatch.
    await database.execute(sql`alter table test_credit_operations
      add constraint fixture_reject_admission check (state <> 'reserved') not valid`);
    try {
      const blockedId = crypto.randomUUID();
      expect((await reserve(blockedId)).status).toBe(503);
      expect((await request(`/operations/${blockedId}`)).status).toBe(404);
      expect((await request(`/operations/${operationId}`)).body.state).toBe(
        "settled",
      );
    } finally {
      await database.execute(
        sql`alter table test_credit_operations drop constraint fixture_reject_admission`,
      );
    }
    expect(sends).toBe(3);
    await saveCatalog(published);
    const selected = await ledger.resolveQuote({ bot: pick });
    if (!selected.quote) throw new Error(selected.reason);
    const updatedAlternatePrice = {
      inputPerMillion: 500_000,
      outputPerMillion: 250_000,
    };
    const updatedAlternate = publish(
      configure(bothVerified, {
        harnessImage,
        routes: {
          pilot: route,
          alternate: {
            ...route,
            provider: alternate.provider,
            model: alternate.model,
            price: updatedAlternatePrice,
          },
        },
      }),
      ["pilot", "alternate"],
      "pilot",
      "fixture",
    );
    afterAlternateDispatch = () => saveCatalog(updatedAlternate.catalog);
    const alternateId = crypto.randomUUID();
    const reservedAlternate = await request("/v1/reserve", {
      operationId: alternateId,
      route: selected.quote.route,
      priceVersion: selected.quote.priceVersion,
    });
    expect(
      (
        await request("/v1/dispatch", {
          ...consumed,
          operationId: alternateId,
          permit: reservedAlternate.body.permit,
        })
      ).body,
    ).toMatchObject({
      state: "completed",
      operation: {
        route: "alternate",
        provider: "fixture-b",
        model: "model-b",
        priceVersion: release.id,
        price: route.price,
        reservedMicrocredits: "2",
        chargedMicrocredits: "1",
      },
    });
    expect(await ledger.resolveQuote({ bot: pick })).toMatchObject({
      quote: {
        priceVersion: updatedAlternate.release.id,
        price: updatedAlternatePrice,
        maxChargeMicrocredits: "6",
      },
    });
    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatchObject({
      model: externalGateway ? "model-a" : "fixture-a/model-a",
      [externalGateway ? "max_completion_tokens" : "max_tokens"]: 16,
    });
    expect(sent[3]).toMatchObject({
      model: externalGateway ? "model-b" : "fixture-b/model-b",
      [externalGateway ? "max_completion_tokens" : "max_tokens"]: 16,
    });
    const emergencyBatch = crypto.randomUUID();
    await ledger.enroll({
      identity: first,
      batchId: emergencyBatch,
      amount: 2n,
    });
    await request("/claim", { batchId: emergencyBatch });
    const emergencyId = crypto.randomUUID();
    const heldDuringMetering = await request("/v1/reserve", {
      operationId: emergencyId,
      route: "pilot",
      priceVersion: updatedAlternate.release.id,
    });
    expect(heldDuringMetering.body.state).toBe("reserved");
    duringMetering = () =>
      saveCatalog(
        configure(updatedAlternate.catalog, { harnessImage, routes: {} }),
      );
    expect(
      (
        await request("/v1/dispatch", {
          operationId: emergencyId,
          permit: heldDuringMetering.body.permit,
          messages: [{ role: "user", content: "withdraw-while-metering" }],
        })
      ).body,
    ).toEqual({ state: "denied", reason: "route_unavailable" });
    expect(sends).toBe(4);
    expect((await request(`/operations/${emergencyId}`)).body).toMatchObject({
      state: "released",
      dispatchedAt: null,
      releasedMicrocredits: "2",
    });
    expect(await createTestCreditLedger(database).balance(first)).toEqual(
      await ledger.balance(first),
    );
  } finally {
    await listener.stop(true);
    await gateway.stop(true);
    const [original] = originalCatalog;
    if (original)
      await database
        .update(enterpriseSettings)
        .set(original)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    try {
      await database.transaction(async (tx) => {
        const accountIds = tx
          .select({ id: testCreditAccounts.id })
          .from(testCreditAccounts)
          .where(eq(testCreditAccounts.issuer, issuer));
        await tx
          .delete(testCreditEvidence)
          .where(inArray(testCreditEvidence.accountId, accountIds));
        await tx
          .delete(testCreditOperations)
          .where(inArray(testCreditOperations.accountId, accountIds));
        const removedEnrollments = await tx
          .delete(testCreditEnrollments)
          .where(inArray(testCreditEnrollments.accountId, accountIds))
          .returning({ batchId: testCreditEnrollments.batchId });
        await tx
          .delete(testCreditAccounts)
          .where(eq(testCreditAccounts.issuer, issuer));
        await tx.delete(testCreditBatches).where(
          inArray(
            testCreditBatches.id,
            removedEnrollments.map(({ batchId }) => batchId),
          ),
        );
      });
    } finally {
      await database.$client.close();
    }
  }
});
