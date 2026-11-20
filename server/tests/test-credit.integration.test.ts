import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import { createManagedModel, type ModelOperation } from "../src/managed-model";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("pilot routes isolate accounts and settle one of two concurrent admissions exactly once", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const ledger = createTestCreditLedger(database);
  const issuer = "https://casdoor.example.test";
  const first = { issuer, subject: crypto.randomUUID() };
  const second = { issuer, subject: crypto.randomUUID() };
  const batchId = crypto.randomUUID();
  const firstToken = crypto.randomUUID();
  let token = firstToken;
  const secondToken = crypto.randomUUID();
  let sends = 0;
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
    execute: async () => {
      sends++;
      if (sends === 2) throw new Error("response lost");
      return { text: "answer", usage: { inputTokens: 1, outputTokens: 1 } };
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
      provider: "openai",
      model: "fixture-a",
      gatewayRevision: "a",
      meteringRevision: "a",
      maxInputTokens: 3,
      maxOutputTokens: 3,
      tools: false,
      price: { inputPerMillion: 250_000, outputPerMillion: 250_000 },
    };
    const catalog = configure(emptyCatalog, {
      harnessImage,
      routes: { pilot: route },
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
          outputTokens: 1,
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
          outputCap: 3,
          oversizedInput: "rejected-before-upstream",
          outputStop: "length",
        },
      },
      "fixture",
    );
    const { catalog: published, release } = publish(
      verified,
      ["pilot"],
      "pilot",
      "fixture",
    );
    await saveCatalog(published);
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
            price: { inputPerMillion: 600_000, outputPerMillion: 600_000 },
          },
        },
      }),
      ["pilot"],
      "pilot",
      "fixture",
    );
    await saveCatalog(repriced.catalog);
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
    expect((await request("/balance")).body).toMatchObject({
      availableMicrocredits: "0",
      reservedMicrocredits: "2",
    });
    expect(sends).toBe(2);

    token = firstToken;
    const releaseBatch = crypto.randomUUID();
    await ledger.enroll({ identity: first, batchId: releaseBatch, amount: 1n });
    await request("/claim", { batchId: releaseBatch });
    const withdrawnOperationId = crypto.randomUUID();
    const reserved = await reserve(withdrawnOperationId);
    await saveCatalog(configure(published, { harnessImage, routes: {} }));
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
    expect(sends).toBe(2);
  } finally {
    await listener.stop(true);
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
    await database.$client.close();
  }
});
