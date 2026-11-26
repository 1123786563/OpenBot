import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  loadPilotTarget,
  runPilotTargetLegs,
} from "../scripts/pilot-matrix-target";
import { runWeKnoraWorkLive } from "../scripts/weknora-work-live";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createPilotSignoffs } from "../src/billing/pilot-signoffs";
import { createTestCreditLedger } from "../src/billing/test-credit";
import {
  createTestCreditRoutes,
  type TestCreditExecutor,
} from "../src/billing/test-credit-routes";
import { loadWeKnoraBilling } from "../src/billing/weknora-config";
import { createWeKnoraRoutes } from "../src/billing/weknora-routes";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  billingPilotSignoffs,
  enterpriseSettings,
  lagoUsageEvents,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  personalSaasAccounts,
  personalWorkspaceSuspensions,
  personalWorkspaces,
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { createAccountAccess } from "../src/personal-saas/account-access";
import { suspensionRoutes } from "../src/personal-saas/workspace-suspension";
import {
  fixtureEmbeddingReport,
  fixtureTraceReport,
} from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("WeKnora resource paths dispatch independently and deny invalid authority before the gateway", async () => {
  const db = createDatabase(testDatabaseUrl(), TEST_POOL);
  const now = Date.now();
  let clock = now;
  const pilot = {
    evidence: "fixture" as const,
    deploymentId: "fixture",
    buildVersion: "fixture-weknora-work",
    imageDigest: `sha256:${"d".repeat(64)}`,
  };
  const ledger = createTestCreditLedger(db, () => new Date(clock), pilot);
  const issuer = "https://casdoor.example.test";
  const subject = crypto.randomUUID();
  const identity = { issuer, subject };
  const serviceToken = "fixture-weknora-service-token-only";
  const resourceId = "weknora:tenant:1:kb:kb-1";
  const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
  const route = {
    provider: "fixture",
    model: "text",
    gatewayRevision: "g",
    meteringRevision: "m",
    maxInputTokens: 12,
    maxOutputTokens: 4,
    tools: false,
    price: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 },
  };
  let catalog = configure(emptyCatalog, {
    harnessImage,
    routes: {
      text: route,
      rank: {
        ...route,
        purpose: "rerank",
        model: "rank",
        maxOutputTokens: 0,
        price: { ...route.price, outputPerMillion: 0 },
      },
    },
  });
  const textRoute = catalog.routes.text;
  const rankRoute = catalog.routes.rank;
  if (!textRoute || !rankRoute) throw new Error("Missing fixture routes");
  const textProof = fixtureTraceReport(harnessImage, textRoute);
  const rankProof = fixtureEmbeddingReport(harnessImage, rankRoute);
  const { vectors, ...rankTrace } = rankProof.completed.gateway;
  catalog = verify(catalog, "text", textProof, "fixture");
  catalog = verify(
    catalog,
    "rank",
    {
      ...rankProof,
      kind: "rerank",
      completed: {
        ...rankProof.completed,
        gateway: { ...rankTrace, scores: vectors },
      },
    },
    "fixture",
  );
  const { release, catalog: published } = publish(
    catalog,
    ["text", "rank"],
    "text",
    "fixture",
  );
  const [original] = await db
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const [previousApplication] = await db
    .select()
    .from(billingApplications)
    .where(eq(billingApplications.id, "weknora"));
  const options = {
    OPENBOT_TEST_CREDIT_WEKNORA: "enabled",
    OPENBOT_WEKNORA_SERVICE_TOKEN: serviceToken,
    OPENBOT_WEKNORA_CHAT_ROUTE: "text",
    OPENBOT_WEKNORA_RERANK_ROUTE: "rank",
    OPENBOT_WEKNORA_MAINTENANCE_ROUTE: "text",
    TEST_CREDIT_CASDOOR_ISSUER: issuer,
    TEST_CREDIT_CASDOOR_PROVIDER_ID: "fixture-casdoor",
    TEST_CREDIT_GATEWAY_IMAGE_DIGEST: textProof.gatewayImageDigest,
    TEST_CREDIT_GATEWAY_REVISION: "g",
    TEST_CREDIT_METERING_REVISION: "m",
    TEST_CREDIT_BIFROST_TOKEN: "fixture-gateway",
    TEST_CREDIT_INPUT_METER_TOKEN: "fixture-meter",
  };
  let duringMeter: (() => Promise<void>) | undefined;
  let duringGateway: (() => Promise<void>) | undefined;
  const requests: { model: string; operation: string | null }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const operation = request.headers.get("x-openbot-operation-id");
      if (new URL(request.url).pathname === "/meter") {
        expect(request.headers.get("authorization")).toBe(
          "Bearer fixture-meter",
        );
        await duringMeter?.();
        return Response.json({
          requestId: request.headers.get("x-request-id"),
          requestSha256: createHash("sha256").update(body).digest("hex"),
          gatewayRevision: "g",
          meteringRevision: "m",
          inputTokenUpperBound: 5,
        });
      }
      expect(request.headers.get("authorization")).toBe(
        "Bearer fixture-gateway",
      );
      if (body.includes("fixture-account-cutoff")) await duringGateway?.();
      const data = JSON.parse(body);
      requests.push({ model: data.model, operation });
      if (body.includes("fixture-gateway-failure"))
        return new Response(null, { status: 502 });
      if (data.model === "fixture/rank") {
        return Response.json({
          model: data.model,
          usage: { prompt_tokens: 3 },
          results: data.documents.map((_: unknown, index: number) => ({
            index,
            relevance_score: 0.9 - index / 10,
          })),
        });
      }
      expect(data.max_completion_tokens).toBe(4);
      return Response.json({
        model: data.model,
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Fixture answer from OpenBot." },
          },
        ],
      });
    },
  });
  const runtime = loadWeKnoraBilling({
    ...options,
    TEST_CREDIT_BIFROST_URL: new URL("/v1/chat/completions", upstream.url).href,
    TEST_CREDIT_RERANK_BIFROST_URL: new URL("/v1/rerank", upstream.url).href,
    TEST_CREDIT_INPUT_METER_URL: new URL("/meter", upstream.url).href,
  });
  if (!runtime) throw new Error("Missing WeKnora runtime");
  const api = createWeKnoraRoutes({ ...runtime, ledger });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: api.fetch,
  });
  const taskId = "wiki-maintenance";
  const authorization = async (
    kind: "chat" | "rerank" | "maintenance",
    limit = 100n,
    creditType: "test" | "paid" = "test",
  ) => {
    const authorizationId = crypto.randomUUID();
    expect(
      await ledger.authorize(identity, {
        authorizationId,
        applicationId: "weknora",
        creditType,
        kind: kind === "maintenance" ? "background" : "online",
        taskId: kind === "maintenance" ? taskId : undefined,
        expiresAt: new Date(now + 60_000),
        resourcePrefix: `${resourceId}:${kind}`,
        limitMicrocredits: limit,
      }),
    ).toMatchObject({ state: "authorized" });
    return authorizationId;
  };
  const messages = [{ role: "user", content: "Read the fixture." }];
  const send = (body: Record<string, unknown>, token = serviceToken) =>
    api.request("/work", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject,
        resourceId,
        operationId: crypto.randomUUID(),
        ...body,
      }),
    });
  const batchId = crypto.randomUUID();
  const productCode = `work-pack-${batchId}`;
  const platformIdentity = {
    issuer: "openbot:platform",
    subject: "weknora-maintenance",
  };
  const platformBatchId = crypto.randomUUID();
  let personalAccountId: string | undefined;
  try {
    await db
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: published })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: published },
      });
    expect((await ledger.resolveQuote({})).options.map(({ id }) => id)).toEqual(
      ["text"],
    );
    await ledger.registerApplication({
      id: "weknora",
      name: "WeKnora",
      operator: "platform",
      resourcePrefix: previousApplication?.resourcePrefix ?? "weknora:",
    });
    await ledger.approveApplication("weknora", "fixture");
    await ledger.enroll({ identity, batchId, amount: 1000n });
    await ledger.claim(identity, batchId);
    const chart = [
      {
        kind: "chat" as const,
        input: { kind: "chat", messages },
        route: "text",
        cost: "5",
      },
      {
        kind: "rerank" as const,
        input: { kind: "rerank", query: "q", documents: ["x", "y"] },
        route: "rank",
        cost: "3",
      },
      {
        kind: "maintenance" as const,
        input: { kind: "maintenance", messages },
        route: "text",
        cost: "5",
      },
    ];
    for (const entry of chart) {
      const authorizationId = await authorization(entry.kind);
      const operationId = crypto.randomUUID();
      const body = {
        input: entry.input,
        operationId,
        authorizationId,
        taskId: entry.kind === "maintenance" ? taskId : undefined,
      };
      expect((await send(body, "wrong-service")).status).toBe(401);
      expect((await send({ ...body, subject: "someone-else" })).status).toBe(
        403,
      );
      expect(
        (await send({ ...body, resourceId: `${resourceId}-other` })).status,
      ).toBe(403);
      const cap = await send({
        ...body,
        operationId: crypto.randomUUID(),
        authorizationId: await authorization(entry.kind, 1n),
      });
      expect(cap.status).toBe(429);
      expect(await cap.json()).toMatchObject({ code: "execution_limit" });
      const response = await send(body);
      const reply = await response.json();
      if (response.status !== 200)
        throw new Error(
          `${entry.kind}: ${response.status} ${JSON.stringify(reply)}`,
        );
      const selected = release.routes.find(({ id }) => id === entry.route);
      if (!selected) throw new Error("Published fixture route missing");
      expect(reply.receipt).toMatchObject({
        state: "settled",
        applicationId: "weknora",
        route: entry.route,
        priceVersion: release.id,
        chargedMicrocredits: entry.cost,
        reservedMicrocredits: selected.maxChargeMicrocredits,
        inputTokens: "3",
        outputTokens: entry.kind === "rerank" ? "0" : "2",
      });
      console.log("WeKnora receipt", {
        path: entry.kind,
        route: reply.receipt.route,
        heldAtAdmission: reply.receipt.reservedMicrocredits,
        inputTokens: reply.receipt.inputTokens,
        outputTokens: reply.receipt.outputTokens,
        chargedMicrocredits: reply.receipt.chargedMicrocredits,
      });
      const replay = await send(body);
      expect(await replay.json()).toEqual(reply);
      expect(
        requests.filter((row) => row.operation === operationId),
      ).toHaveLength(1);
      expect(requests.at(-1)?.model).toBe(
        entry.kind === "rerank" ? "fixture/rank" : "fixture/text",
      );
    }
    const chatGrant = await authorization("chat");
    for (const crossPath of [
      {
        kind: "rerank" as const,
        input: { kind: "rerank", query: "q", documents: ["x"] },
      },
      {
        kind: "maintenance" as const,
        input: { kind: "maintenance", messages },
      },
    ]) {
      const crossRequests = requests.length;
      const reply = await send({
        taskId: crossPath.kind === "maintenance" ? taskId : undefined,
        input: crossPath.input,
        authorizationId: chatGrant,
      });
      expect(reply.status).toBe(403);
      expect(await reply.json()).toMatchObject({ code: "not_authorized" });
      expect(requests).toHaveLength(crossRequests);
    }
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: "987",
    });
    const maintenance = { kind: "maintenance", messages };
    expect((await send({ taskId, input: maintenance })).status).toBe(400);
    expect(
      (
        await send({
          taskId,
          input: maintenance,
          authorizationId: await authorization("maintenance", 1n),
        })
      ).status,
    ).toBe(429);
    const revoked = await authorization("maintenance");
    duringMeter = async () => {
      await ledger.revokeAuthorization(identity, revoked);
    };
    expect(
      (await send({ taskId, input: maintenance, authorizationId: revoked }))
        .status,
    ).toBe(403);
    duringMeter = undefined;
    const expired = await authorization("maintenance");
    clock = now + 60_001;
    expect(
      (await send({ taskId, input: maintenance, authorizationId: expired }))
        .status,
    ).toBe(410);
    clock = now;
    expect(requests).toHaveLength(3);
    console.log(
      "Rejected requests did not reach the gateway: service credential, subject, resource, cap, missing grant, revoked grant, expired grant.",
    );

    // A periodic maintenance run may charge a platform budget instead of a
    // person's grant (#110 平台预算). A missing or spent budget pauses the
    // charged step before the gateway, and the charge lands on the platform
    // account.
    const platformBudgetId = "issue-110-maintenance";
    await ledger.enroll({
      identity: platformIdentity,
      batchId: platformBatchId,
      amount: 100n,
    });
    await ledger.claim(platformIdentity, platformBatchId);
    const platformRuntime = loadWeKnoraBilling({
      ...options,
      TEST_CREDIT_BIFROST_URL: new URL("/v1/chat/completions", upstream.url)
        .href,
      TEST_CREDIT_RERANK_BIFROST_URL: new URL("/v1/rerank", upstream.url).href,
      TEST_CREDIT_INPUT_METER_URL: new URL("/meter", upstream.url).href,
      TEST_CREDIT_WEKNORA_MAINTENANCE_BUDGET_ID: platformBudgetId,
    });
    if (!platformRuntime) throw new Error("Missing platform WeKnora runtime");
    const platformApi = createWeKnoraRoutes({ ...platformRuntime, ledger });
    const sendPlatform = (body: Record<string, unknown>) =>
      platformApi.request("/work", {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject: platformIdentity.subject,
          resourceId,
          operationId: crypto.randomUUID(),
          ...body,
        }),
      });
    const gatewayCalls = requests.length;
    const unfunded = await sendPlatform({ taskId, input: maintenance });
    expect(unfunded.status).toBe(429);
    expect(await unfunded.json()).toMatchObject({ code: "execution_limit" });
    expect(
      (await sendPlatform({ input: { kind: "chat", messages } })).status,
    ).toBe(403);
    await ledger.createBudget(platformIdentity, {
      budgetId: platformBudgetId,
      creditType: "test",
      limitMicrocredits: 16n,
    });
    const replayOperationId = crypto.randomUUID();
    const fundedBody = {
      taskId,
      input: maintenance,
      operationId: replayOperationId,
    };
    const funded = await sendPlatform(fundedBody);
    expect(funded.status).toBe(200);
    const fundedReply = await funded.json();
    expect(fundedReply.receipt).toMatchObject({
      state: "settled",
      applicationId: "weknora",
      budgetId: platformBudgetId,
      route: "text",
      reservedMicrocredits: "16",
      chargedMicrocredits: "5",
      inputTokens: "3",
      outputTokens: "2",
    });
    const replayed = await sendPlatform(fundedBody);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(fundedReply);
    const spent = await sendPlatform({ taskId, input: maintenance });
    expect(spent.status).toBe(429);
    expect(await spent.json()).toMatchObject({ code: "execution_limit" });
    expect(requests).toHaveLength(gatewayCalls + 1);
    expect(
      requests.find(({ operation }) => operation === replayOperationId),
    ).toBeDefined();
    expect(await ledger.balance(platformIdentity)).toMatchObject({
      chargedMicrocredits: "5",
      reservedMicrocredits: "0",
    });
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: "987",
    });

    const binary = process.env.WEKNORA_110_TEST_BINARY;
    if (binary) {
      const proc = Bun.spawn(
        [binary, "-test.run", "^TestOpenBotJointWork$", "-test.v"],
        {
          env: {
            ...process.env,
            OPENBOT_WEKNORA_WORK_URL: new URL("/work", server.url).href,
            OPENBOT_WEKNORA_SERVICE_TOKEN: serviceToken,
            OPENBOT_WEKNORA_OIDC_ISSUER: issuer,
            OPENBOT_110_SUBJECT: subject,
            OPENBOT_110_CHAT_GRANT: await authorization("chat"),
            OPENBOT_110_RERANK_GRANT: await authorization("rerank"),
            OPENBOT_WEKNORA_MAINTENANCE_GRANT:
              await authorization("maintenance"),
            OPENBOT_WEKNORA_MAINTENANCE_RESOURCE: resourceId,
            OPENBOT_WEKNORA_MAINTENANCE_TASK: taskId,
            OPENBOT_WEKNORA_MAINTENANCE_SUBJECT: subject,
          },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      expect(await proc.exited).toBe(0);
      expect(requests).toHaveLength(7);
      expect(await ledger.balance(identity)).toMatchObject({
        availableMicrocredits: "974",
      });
    }
    const lost = {
      input: {
        kind: "chat",
        messages: [{ role: "user", content: "fixture-gateway-failure" }],
      },
      operationId: crypto.randomUUID(),
      authorizationId: await authorization("chat"),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(lost);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "reconciling" });
    }
    expect(
      requests.filter((row) => row.operation === lost.operationId),
    ).toHaveLength(1);
    const accountId = await ledger.accountOf(identity);
    if (!accountId) throw new Error("Paid fixture account missing.");
    const paid = createPaidCreditLedger(db);
    await db.insert(paidProducts).values({
      code: productCode,
      kind: "credit_pack",
      version: 1,
      priceCents: 100,
      creditsMicrocredits: 100n,
      active: true,
    });
    const order = await paid.createOrder({
      accountId,
      productCode,
      channel: "alipay",
    });
    expect(
      (
        await paid.verifyOrder({
          orderId: order.id,
          channel: "alipay",
          channelOrderRef: `fixture:${order.id}`,
          amountCents: 100,
          paidAt: new Date(now),
        })
      ).claimed,
    ).toBe(true);
    await ledger.setPilotProviderCostLimit({
      limitMicrocredits: 1_000_000n,
      by: subject,
    });
    for (const path of ["text", "rank"]) {
      await ledger.setProviderCostLimit({
        path,
        limitMicrocredits: 1000n,
        by: subject,
      });
    }
    const signed = {
      ...pilot,
      kind: "application",
      id: "weknora",
      approvedBy: subject,
      pauseOwner: subject,
      accountIds: [accountId],
      deploymentRef: "fixture:deployment",
      pathRef: "fixture:weknora",
      rampRef: "fixture:ramp",
      sharedSupplierCapMicrocredits: "1000000",
    };
    const paidPaths = chart.map(({ kind, route }) => ({
      id: route,
      revision: route === "rank" ? rankRoute.revision : textRoute.revision,
      provider: "fixture",
      resourceType: kind,
      pathRef: `fixture:weknora:${kind}`,
      reconciliationWindowSeconds: kind === "rerank" ? 3600 : 7200,
      reconciliationRef: `fixture:reconciliation:${kind}`,
      supplierCapMicrocredits: "1000",
      maxOperationMicrocredits: "16",
    }));
    const previousCount = requests.length;
    const previousTrialBalance = await ledger.balance(identity);
    const signoffs = createPilotSignoffs(db);
    await signoffs.record({
      ...signed,
      routes: paidPaths.filter(({ resourceType }) => resourceType === "chat"),
    });
    for (const entry of chart) {
      const reply = await send({
        input: entry.input,
        authorizationId: await authorization(entry.kind, 100n, "paid"),
        taskId: entry.kind === "maintenance" ? taskId : undefined,
      });
      expect(reply.status).toBe(entry.kind === "chat" ? 200 : 503);
      expect(await reply.json()).toMatchObject(
        entry.kind === "chat"
          ? { receipt: { creditType: "paid", chargedMicrocredits: "5" } }
          : { code: "route_unavailable" },
      );
    }
    expect(requests).toHaveLength(previousCount + 1);
    await signoffs.record({ ...signed, routes: paidPaths });
    for (const entry of chart.filter(({ kind }) => kind !== "chat")) {
      const reply = await send({
        input: entry.input,
        authorizationId: await authorization(entry.kind, 100n, "paid"),
        taskId: entry.kind === "maintenance" ? taskId : undefined,
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({
        receipt: { creditType: "paid", chargedMicrocredits: entry.cost },
      });
    }
    expect(requests).toHaveLength(previousCount + 3);
    expect(await ledger.balance(identity)).toEqual(previousTrialBalance);
    expect(await paid.paidBalance(accountId)).toMatchObject({
      availableMicrocredits: "87",
    });
    // One signed resource can pause without stopping the other two (#110 每路径暂停).
    await signoffs.record({
      ...signed,
      routes: paidPaths,
      pausedResources: ["rerank"],
    });
    const beforePause = requests.length;
    // The pause holds on both entries: Test Credit and paid.
    const pausedTestRerank = await send({
      input: chart.find(({ kind }) => kind === "rerank")?.input,
      authorizationId: await authorization("rerank"),
    });
    expect(pausedTestRerank.status).toBe(503);
    expect(await pausedTestRerank.json()).toEqual({
      code: "route_unavailable",
    });
    const pausedRerank = await send({
      input: chart.find(({ kind }) => kind === "rerank")?.input,
      authorizationId: await authorization("rerank", 100n, "paid"),
    });
    expect(pausedRerank.status).toBe(503);
    expect(await pausedRerank.json()).toEqual({ code: "route_unavailable" });
    for (const entry of chart.filter(({ kind }) => kind !== "rerank")) {
      const reply = await send({
        input: entry.input,
        authorizationId: await authorization(entry.kind, 100n, "paid"),
        taskId: entry.kind === "maintenance" ? taskId : undefined,
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({
        receipt: { creditType: "paid", chargedMicrocredits: entry.cost },
      });
    }
    expect(requests).toHaveLength(beforePause + 2);
    expect(requests.slice(beforePause).map(({ model }) => model)).toEqual([
      "fixture/text",
      "fixture/text",
    ]);
    expect(await ledger.balance(identity)).toEqual(previousTrialBalance);
    expect(await paid.paidBalance(accountId)).toMatchObject({
      availableMicrocredits: "77",
    });

    const dispatchCount = requests.length;
    // 971 = 1000 granted - 13 charged - 16 held by the reconciling request.
    const beforeHarness = await ledger.balance(identity);
    if (!beforeHarness) throw new Error("Missing payer balance.");
    expect(beforeHarness).toMatchObject({ availableMicrocredits: "971" });
    const live = await runWeKnoraWorkLive(
      {
        ...options,
        TEST_CREDIT_BIFROST_URL: new URL("/v1/chat/completions", upstream.url)
          .href,
        TEST_CREDIT_RERANK_BIFROST_URL: new URL("/v1/rerank", upstream.url)
          .href,
        TEST_CREDIT_INPUT_METER_URL: new URL("/meter", upstream.url).href,
        WEKNORA_WORK_ISSUER: issuer,
        WEKNORA_WORK_SUBJECT: subject,
        WEKNORA_WORK_RESOURCE_ID: resourceId,
        WEKNORA_WORK_SESSION_ID: "fixture-session",
        WEKNORA_WORK_QUESTION: "Read the fixture.",
        WEKNORA_WORK_QUERY: "shared",
        WEKNORA_WORK_CHAT_AUTHORIZATION_ID: await authorization("chat"),
        WEKNORA_WORK_SEARCH_AUTHORIZATION_ID: await authorization("rerank"),
      },
      testDatabaseUrl(),
      db,
    );
    expect(live.paths.chat).toMatchObject({
      endpoint: "/api/v1/knowledge-chat/fixture-session",
      status: 200,
      response: {
        result: { text: "Fixture answer from OpenBot." },
        receipt: {
          state: "settled",
          applicationId: "weknora",
          creditType: "test",
          route: "text",
          priceVersion: release.id,
          reservedMicrocredits: "16",
          chargedMicrocredits: "5",
          inputTokens: "3",
          outputTokens: "2",
        },
      },
    });
    expect(live.paths.search).toMatchObject({
      endpoint: "/api/v1/knowledge-search",
      status: 200,
      response: {
        result: { scores: [{ index: 0, relevance_score: 0.9 }] },
        receipt: {
          state: "settled",
          applicationId: "weknora",
          creditType: "test",
          route: "rank",
          priceVersion: release.id,
          reservedMicrocredits: "12",
          chargedMicrocredits: "3",
          inputTokens: "3",
          outputTokens: "0",
        },
      },
    });
    expect(live.denials).toEqual([
      { path: "chat", status: 403, response: { code: "not_authorized" } },
      { path: "search", status: 403, response: { code: "not_authorized" } },
    ]);
    expect(requests).toHaveLength(dispatchCount + 2);
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: (
        BigInt(beforeHarness.availableMicrocredits) - 8n
      ).toString(),
    });

    // 与 #69 联验：仅 OpenBot Workspace Suspension 时账户仍活跃，WeKnora 按
    // 其授权范围照常工作；Casdoor 停用后新预留和新派发被拒，已派发的调用按
    // 原预留结算。
    const [personal] = await db
      .insert(personalSaasAccounts)
      .values({
        ...identity,
        email: "weknora-work@example.test",
        status: {
          source: "active",
          observedAt: clock,
          confirmedAt: clock,
          epoch: 0,
          disablements: [],
        },
      })
      .returning();
    if (!personal) throw new Error("Missing personal account fixture");
    personalAccountId = personal.id;
    const personalWorkspaceId = crypto.randomUUID();
    await db
      .insert(personalWorkspaces)
      .values({ id: personalWorkspaceId, ownerId: personal.id });
    const operator = { id: "fixture-operator", token: crypto.randomUUID() };
    const paused = await suspensionRoutes(db, operator, () => clock).request(
      `/api/operator/workspaces/${personalWorkspaceId}/suspension`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${operator.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "pause", reason: "fixture" }),
      },
    );
    expect(paused.status).toBe(201);
    const beforeSuspendedWork = requests.length;
    const duringSuspension = await send({
      input: { kind: "chat", messages },
      authorizationId: await authorization("chat"),
    });
    expect(duringSuspension.status).toBe(200);
    expect(await duringSuspension.json()).toMatchObject({
      receipt: { state: "settled", chargedMicrocredits: "5" },
    });
    expect(requests).toHaveLength(beforeSuspendedWork + 1);

    // A reservation made while the account is active, dispatched after the
    // Casdoor cutoff, gives its hold back and never reaches the gateway.
    const waitingGrant = await authorization("chat");
    const waitingOperationId = crypto.randomUUID();
    const waiting = await ledger.reserve(
      identity,
      {
        operationId: waitingOperationId,
        route: "text",
        priceVersion: release.id,
        applicationId: "weknora",
        authorizationId: waitingGrant,
        resourceId: `${resourceId}:chat`,
        creditType: "test",
        resumable: false,
      },
      { weknoraWork: "chat" },
    );
    if (waiting.state !== "reserved")
      throw new Error("Expected the pre-cutoff reservation");

    let casdoorActive = true;
    const casdoor = createAccountAccess(
      db,
      async () => ({
        ...identity,
        observedAt: clock + 1_000,
        active: casdoorActive,
        disablements: casdoorActive
          ? []
          : [{ id: "casdoor-disablement", effectiveAt: clock + 1_000 }],
      }),
      () => clock + 1_000,
    );
    duringGateway = async () => {
      casdoorActive = false;
      expect(await casdoor.check(identity)).toBe(false);
    };
    const alreadyDispatched = await send({
      input: {
        kind: "chat",
        messages: [{ role: "user", content: "fixture-account-cutoff" }],
      },
      authorizationId: await authorization("chat"),
    });
    duringGateway = undefined;
    expect(alreadyDispatched.status).toBe(200);
    expect(await alreadyDispatched.json()).toMatchObject({
      receipt: { state: "settled", chargedMicrocredits: "5" },
    });

    const settledGatewayCalls = requests.length;
    const refusedOperationId = crypto.randomUUID();
    const refused = await send({
      input: { kind: "chat", messages },
      authorizationId: await authorization("chat"),
      operationId: refusedOperationId,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "not_authorized" });
    expect(requests).toHaveLength(settledGatewayCalls);
    // The cutoff refuses the reservation itself, so no operation row exists.
    expect(await ledger.receipt(identity, refusedOperationId)).toBeUndefined();
    expect(
      await ledger.beginDispatch(identity, {
        operationId: waitingOperationId,
        permit: waiting.permit,
        authorizationId: waitingGrant,
      }),
    ).toEqual({ state: "denied", reason: "not_authorized" });
    expect(await ledger.receipt(identity, waitingOperationId)).toMatchObject({
      state: "released",
      reservedMicrocredits: "16",
      releasedMicrocredits: "16",
      chargedMicrocredits: null,
    });
    expect(await ledger.balance(identity)).toMatchObject({
      availableMicrocredits: "953",
      chargedMicrocredits: "31",
    });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    await db.transaction(async (tx) => {
      const accounts = tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .where(
          inArray(testCreditAccounts.subject, [
            subject,
            platformIdentity.subject,
          ]),
        );
      await tx
        .delete(lagoUsageEvents)
        .where(inArray(lagoUsageEvents.accountId, accounts));
      await tx
        .delete(testCreditEvidence)
        .where(inArray(testCreditEvidence.accountId, accounts));
      await tx
        .delete(pilotProviderCostHolds)
        .where(inArray(pilotProviderCostHolds.accountId, accounts));
      await tx
        .delete(pilotProviderCostLimitEvents)
        .where(eq(pilotProviderCostLimitEvents.by, subject));
      await tx
        .delete(pilotProviderCostLimits)
        .where(eq(pilotProviderCostLimits.updatedBy, subject));
      await tx
        .delete(paidCreditAllocations)
        .where(inArray(paidCreditAllocations.accountId, accounts));
      await tx
        .delete(paidEntitlements)
        .where(inArray(paidEntitlements.accountId, accounts));
      await tx
        .delete(paidOrders)
        .where(inArray(paidOrders.accountId, accounts));
      await tx.delete(paidProducts).where(eq(paidProducts.code, productCode));
      await tx
        .delete(billingPilotSignoffs)
        .where(
          and(
            eq(billingPilotSignoffs.id, "weknora"),
            eq(billingPilotSignoffs.evidence, "fixture"),
            sql`${billingPilotSignoffs.record}->>'approvedBy' = ${subject}`,
          ),
        );
      await tx
        .delete(testCreditOperations)
        .where(inArray(testCreditOperations.accountId, accounts));
      await tx
        .delete(testCreditBudgets)
        .where(inArray(testCreditBudgets.accountId, accounts));
      await tx
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, accounts));
      await tx
        .delete(testCreditAccounts)
        .where(
          inArray(testCreditAccounts.subject, [
            subject,
            platformIdentity.subject,
          ]),
        );
      await tx
        .delete(testCreditBatches)
        .where(inArray(testCreditBatches.id, [batchId, platformBatchId]));
      if (personalAccountId) {
        await tx
          .delete(personalWorkspaceSuspensions)
          .where(eq(personalWorkspaceSuspensions.accountId, personalAccountId));
        await tx
          .delete(personalWorkspaces)
          .where(eq(personalWorkspaces.ownerId, personalAccountId));
        await tx
          .delete(personalSaasAccounts)
          .where(eq(personalSaasAccounts.id, personalAccountId));
      }
      if (previousApplication) {
        const { id, ...stored } = previousApplication;
        await tx
          .update(billingApplications)
          .set(stored)
          .where(eq(billingApplications.id, id));
      } else {
        await tx
          .delete(billingApplications)
          .where(eq(billingApplications.id, "weknora"));
      }
    });
    if (original)
      await db
        .update(enterpriseSettings)
        .set({ value: original.value })
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await db
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    await db.$client.close();
  }
}, 120_000);

test("the pilot matrix routes execution and account requests through the product HTTP entries", async () => {
  const db = createDatabase(testDatabaseUrl(), TEST_POOL);
  const run = crypto.randomUUID().slice(0, 8);
  const issuer = `pilot-target-casdoor-${run}`;
  const identityA = { issuer, subject: crypto.randomUUID() };
  const identityB = { issuer, subject: crypto.randomUUID() };
  const identityC = { issuer, subject: crypto.randomUUID() };
  const tokens = {
    A: `fixture-target-a-${run}`,
    B: `fixture-target-b-${run}`,
    C: `fixture-target-c-${run}`,
  };
  const sessionCookies = {
    A: `pilot_session=a-${run}`,
    B: `pilot_session=b-${run}`,
    C: `pilot_session=c-${run}`,
  };
  const serviceToken = `fixture-weknora-service-${run}`;
  const operatorToken = `fixture-operator-${run}`;
  const workspaceId = crypto.randomUUID();
  const resourceId = "weknora:tenant:1:kb:kb-1";
  const harnessImage = `agent-langgraph-agui@sha256:${"e".repeat(64)}`;
  const ledger = createTestCreditLedger(db);
  const paid = createPaidCreditLedger(db);
  const [original] = await db
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));

  const route = {
    provider: "fixture-pilot",
    model: "pilot-target",
    gatewayRevision: "pilot-g",
    meteringRevision: "pilot-m",
    maxInputTokens: 10,
    maxOutputTokens: 2,
    tools: false,
    price: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 },
  };
  const drafted = configure(emptyCatalog, {
    harnessImage,
    routes: {
      "route-a": { ...route, provider: "fixture-pilot-a" },
      "route-b": { ...route, provider: "fixture-pilot-b", model: "route-b" },
      "local-bge": {
        purpose: "embedding",
        provider: "openai",
        model: "BAAI/bge-small-en-v1.5",
        gatewayRevision: "pilot-g",
        meteringRevision: "pilot-m",
        maxInputTokens: 10,
        maxOutputTokens: 0,
        tools: false,
        price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
      },
    },
  });
  let catalog = drafted;
  for (const id of ["route-a", "route-b", "local-bge"]) {
    const proposed = drafted.routes[id];
    if (!proposed) throw new Error(`fixture route ${id} missing`);
    catalog = verify(
      catalog,
      id,
      proposed.purpose === "embedding"
        ? fixtureEmbeddingReport(harnessImage, proposed)
        : fixtureTraceReport(harnessImage, proposed),
      "test",
    );
  }
  const published = publish(
    catalog,
    ["route-a", "route-b", "local-bge"],
    "route-a",
    "test",
  ).catalog;

  const batches: string[] = [];
  let dispatches = 0;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await db
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: published })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: published },
      });
    for (const [identity, amount] of [
      [identityA, 100_000n],
      [identityB, 100_000n],
      [identityC, 24n], // exactly two chat reservations
    ] as const) {
      const batchId = crypto.randomUUID();
      batches.push(batchId);
      await ledger.enroll({ identity, batchId, amount });
      await ledger.claim(identity, batchId);
    }
    await ledger.registerApplication({
      id: "weknora",
      name: "WeKnora",
      operator: "platform",
      resourcePrefix: "weknora:",
    });
    await ledger.approveApplication("weknora", "matrix-fixture");

    const identities = new Map([
      [tokens.A, identityA],
      [tokens.B, identityB],
      [tokens.C, identityC],
    ]);
    const sessions = new Map([
      [sessionCookies.A, identityA],
      [sessionCookies.B, identityB],
      [sessionCookies.C, identityC],
    ]);
    const execute: TestCreditExecutor = async ({
      bindGatewayRequest,
      messages,
    }) => {
      dispatches += 1;
      const bound = await bindGatewayRequest({
        requestId: crypto.randomUUID(),
        digest: "a".repeat(64),
      });
      if (!bound) throw new Error("gateway request was not bound");
      const first = messages[0];
      return {
        text: `Answer to: ${first && "content" in first ? first.content : "nothing"}`,
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    };
    const embed: NonNullable<
      Parameters<typeof createWeKnoraRoutes>[0]["execute"]
    > = async ({ input, beforeDispatch }) => {
      if (
        !(await beforeDispatch({
          requestId: crypto.randomUUID(),
          requestSha256: "b".repeat(64),
          inputTokenUpperBound: 3,
        }))
      )
        throw new Error("embedding was not admitted");
      return {
        outcome: "complete",
        vectors: input.map(() => [0.1, 0.2, 0.3]),
        usage: { inputTokens: 3, outputTokens: 0 },
      };
    };
    const accountA = await ledger.accountOf(identityA);
    if (!accountA) throw new Error("missing Billing Account A");

    const root = new Hono();
    root.route(
      "/billing",
      createTestCreditRoutes({
        ledger,
        authenticate: async (request, intent) =>
          intent === "execution"
            ? identities.get(
                (request.headers.get("authorization") ?? "").replace(
                  /^Bearer /,
                  "",
                ),
              )
            : sessions.get(request.headers.get("cookie") ?? ""),
        paid: { ledger: paid },
        execute,
      }),
    );
    root.route(
      "/weknora",
      createWeKnoraRoutes({
        issuer,
        serviceToken,
        routeId: "local-bge",
        execute: embed,
        ledger,
      }),
    );
    root.post("/operator/workspaces/:id/suspension", async (context) => {
      if (context.req.header("authorization") !== `Bearer ${operatorToken}`)
        return context.json({ error: "suspension_permission_required" }, 403);
      const body = (await context.req.json()) as { action?: string };
      await paid.suspendAccount(accountA, body.action === "pause");
      return context.json({ operationId: crypto.randomUUID() }, 201);
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => root.fetch(request),
    });
    const origin = server.url.origin;

    // The default target is the local fixture deployment.
    expect(loadPilotTarget({}).evidence).toBe("fixture");
    // A deployment target must name its product entry, credential and
    // provenance, and must not point back at loopback.
    expect(() => loadPilotTarget({ PILOT_EVIDENCE: "deployment" })).toThrow();
    expect(() =>
      loadPilotTarget({
        PILOT_EVIDENCE: "deployment",
        PILOT_TARGET_URL: "http://127.0.0.1:3000/api/billing",
        PILOT_TARGET_TOKEN: tokens.A,
        PILOT_DEPLOYMENT_ID: "target-1",
        PILOT_BUILD_VERSION: "build-1",
        PILOT_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
        PILOT_GATEWAY_URL: "https://gateway.example/v1/chat/completions",
        PILOT_GATEWAY_REVISION: "target-g",
      }),
    ).toThrow("loopback");
    const target = loadPilotTarget({
      PILOT_EVIDENCE: "fixture",
      PILOT_TARGET_URL: `${origin}/billing`,
      PILOT_TARGET_TOKEN: tokens.A,
      PILOT_WEKNORA_URL: `${origin}/weknora`,
      PILOT_ACCOUNT_STATUS_URL: `${origin}/operator`,
      PILOT_WORKSPACE_ID: workspaceId,
    });

    const legs = await runPilotTargetLegs({
      target,
      tokens,
      sessionCookies,
      routes: { A: "route-a", B: "route-b" },
      weknora: {
        serviceToken,
        subject: identityA.subject,
        resourceId,
        createGrant: true,
      },
      suspension: { token: operatorToken, workspaceId },
    });
    for (const leg of legs)
      if (leg.outcome === "fail")
        throw new Error(`${leg.scenario}: ${leg.error}`);
    expect(legs.map(({ scenario }) => scenario)).toEqual([
      "target-model-switch",
      "target-cross-app-isolation",
      "target-concurrent-budgets",
      "target-failures-refusals",
      "target-weknora-ingest-after-signout",
      "target-account-status-suspension",
    ]);
    expect(legs.every(({ outcome }) => outcome === "pass")).toBe(true);
    // The model switch reserved a named route per call; the refusals never
    // reached the executor.
    expect(legs[0]).toMatchObject({
      outcome: "pass",
      detail: { routeA: "route-a", routeB: "route-b" },
    });
    expect(legs[3]).toMatchObject({
      outcome: "pass",
      detail: { forged: "not_authorized", unknownRoute: "route_unavailable" },
    });
    // Cross-app isolation read A's unchanged balance after B's charge.
    expect(legs[1]).toMatchObject({
      outcome: "pass",
      detail: { chargedA: "10", chargedB: "5" },
    });
    // The settled receipt and balance survive the target's suspension while
    // new work is refused.
    expect(legs[5]).toMatchObject({
      outcome: "pass",
      detail: { receipt: "settled" },
    });
    expect(dispatches).toBe(4);
  } finally {
    await server?.stop(true);
    await db.transaction(async (tx) => {
      // Account C's rows are reached by its own subject plus the batch join.
      const subjectAccounts = tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .where(
          inArray(testCreditAccounts.subject, [
            identityA.subject,
            identityB.subject,
            identityC.subject,
          ]),
        );
      await tx
        .delete(lagoUsageEvents)
        .where(inArray(lagoUsageEvents.accountId, subjectAccounts));
      await tx
        .delete(testCreditEvidence)
        .where(inArray(testCreditEvidence.accountId, subjectAccounts));
      await tx
        .delete(pilotProviderCostHolds)
        .where(inArray(pilotProviderCostHolds.accountId, subjectAccounts));
      await tx
        .delete(testCreditOperations)
        .where(inArray(testCreditOperations.accountId, subjectAccounts));
      await tx
        .delete(testCreditBudgets)
        .where(inArray(testCreditBudgets.accountId, subjectAccounts));
      await tx
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, subjectAccounts));
      await tx
        .delete(testCreditAccounts)
        .where(
          inArray(testCreditAccounts.subject, [
            identityA.subject,
            identityB.subject,
            identityC.subject,
          ]),
        );
      await tx
        .delete(testCreditBatches)
        .where(inArray(testCreditBatches.id, batches));
    });
    if (original)
      await db
        .update(enterpriseSettings)
        .set({ value: original.value })
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await db
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    await db.$client.close();
  }
}, 180_000);
