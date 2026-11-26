import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
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
  const published = publish(
    catalog,
    ["text", "rank"],
    "text",
    "fixture",
  ).catalog;
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
      expect(reply.receipt).toMatchObject({
        state: "settled",
        applicationId: "weknora",
        route: entry.route,
        chargedMicrocredits: entry.cost,
        reservedMicrocredits: entry.kind === "rerank" ? "12" : "16",
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
      expect(requests).toHaveLength(6);
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
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    await db.transaction(async (tx) => {
      const accounts = tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .where(eq(testCreditAccounts.subject, subject));
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
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, accounts));
      await tx
        .delete(testCreditAccounts)
        .where(eq(testCreditAccounts.subject, subject));
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
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
