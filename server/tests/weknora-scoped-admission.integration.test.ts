import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
  personalSaasAccounts,
  personalWorkspaceSuspensions,
  personalWorkspaces,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditExternalAuthorizations,
  testCreditOperations,
} from "../src/db/schema";
import { createAccountAccess } from "../src/personal-saas/account-access";
import { weknoraEmbeddingRoutes } from "../src/personal-saas/weknora-embedding-routes";
import { suspensionRoutes } from "../src/personal-saas/workspace-suspension";
import { fixtureEmbeddingReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("a durable WeKnora grant gates new credit operations and preserves prior settlement across Casdoor cutoff", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  let now = Date.UTC(2026, 0, 1);
  const ledger = createTestCreditLedger(database, () => new Date(now));
  const identity = {
    issuer: "https://casdoor.example.test",
    subject: crypto.randomUUID(),
  };
  const grant = {
    authorizationId: crypto.randomUUID(),
    application: "weknora",
    resourceId: "tenant-1/document-1",
  } satisfies {
    authorizationId: string;
    application: "weknora";
    resourceId: string;
  };
  const [account] = await database
    .insert(personalSaasAccounts)
    .values({
      ...identity,
      email: "uploader@example.test",
      status: {
        source: "active",
        observedAt: now,
        confirmedAt: now,
        epoch: 0,
        disablements: [],
      },
    })
    .returning();
  if (!account) throw new Error("Missing fixture Casdoor account");

  const [originalCatalog] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
  const configured = configure(emptyCatalog, {
    harnessImage,
    routes: {
      pilot: {
        purpose: "embedding",
        provider: "fixture-a",
        model: "model-a",
        gatewayRevision: "a",
        meteringRevision: "a",
        maxInputTokens: 3,
        maxOutputTokens: 0,
        tools: false,
        price: { inputPerMillion: 500_000, outputPerMillion: 0 },
      },
    },
  });
  const route = configured.routes.pilot;
  if (!route) throw new Error("Missing fixture route");
  const verified = verify(
    configured,
    "pilot",
    fixtureEmbeddingReport(harnessImage, route),
    "fixture",
  );
  const { catalog, release } = publish(verified, ["pilot"], null, "fixture");

  const batchId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  try {
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: catalog })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: catalog },
      });
    await ledger.enroll({ identity, batchId, amount: 20n });
    await ledger.claim(identity, batchId);
    await expect(ledger.modelOptions()).resolves.toEqual([]);
    await expect(ledger.quote()).resolves.toBeUndefined();
    await expect(
      ledger.reserve(identity, {
        operationId: "unscoped",
        route: "pilot",
        priceVersion: release.id,
      }),
    ).resolves.toEqual({ state: "denied", reason: "route_unavailable" });
    const reserve = (operationId: string) => ({
      operationId,
      route: "pilot",
      priceVersion: release.id,
      scope: grant,
    });
    await expect(ledger.reserve(identity, reserve("first"))).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    await ledger.authorizeExternalSpending(identity, {
      ...grant,
      expiresAt: new Date(now + 120_000),
      maxMicrocredits: 6n,
    });

    const restarted = createTestCreditLedger(database, () => new Date(now));
    const first = await restarted.reserve(identity, reserve("first"));
    const second = await restarted.reserve(identity, reserve("second"));
    if (first.state !== "reserved" || second.state !== "reserved")
      throw new Error("Expected two durable reservations");
    await expect(
      restarted.reserve(identity, {
        ...reserve("different-document"),
        scope: { ...grant, resourceId: "tenant-1/document-2" },
      }),
    ).resolves.toEqual({ state: "denied", reason: "not_authorized" });
    await database
      .insert(personalWorkspaces)
      .values({ id: workspaceId, ownerId: account.id });
    const operator = { id: "fixture", token: crypto.randomUUID() };
    const suspension = await suspensionRoutes(
      database,
      operator,
      () => now,
    ).request(`/api/operator/workspaces/${workspaceId}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "pause", reason: "fixture" }),
    });
    expect(suspension.status).toBe(201);
    await expect(
      restarted.reserve(identity, reserve("first")),
    ).resolves.toMatchObject({
      state: "existing",
      permit: first.permit,
    });

    const competing = await Promise.all([
      restarted.reserve(identity, reserve("third")),
      restarted.reserve(identity, reserve("fourth")),
    ]);
    expect(competing.filter(({ state }) => state === "reserved")).toHaveLength(
      1,
    );
    expect(competing).toContainEqual({
      state: "denied",
      reason: "insufficient_credits",
    });
    const firstDispatch = { operationId: "first", permit: first.permit };
    await expect(
      restarted.beginDispatch(identity, firstDispatch),
    ).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    const dispatched = await restarted.beginDispatch(identity, {
      ...firstDispatch,
      scope: grant,
    });
    if (dispatched.state !== "dispatch")
      throw new Error(
        "Expected scoped dispatch after reconstructing the service",
      );

    now += 60_000;
    await expect(
      restarted.reserve(identity, reserve("third")),
    ).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    await expect(
      restarted.beginDispatch(identity, {
        operationId: "second",
        permit: second.permit,
        scope: grant,
      }),
    ).resolves.toEqual({ state: "denied", reason: "not_authorized" });
    const disablements = [{ id: "casdoor-disablement", effectiveAt: now }];
    let active = false;
    const casdoorAccess = createAccountAccess(
      database,
      async () => ({ ...identity, observedAt: now, active, disablements }),
      () => now,
    );
    expect(await casdoorAccess.check(identity)).toBe(false);
    await expect(
      restarted.reserve(identity, reserve("disabled")),
    ).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    await expect(
      restarted.settle(dispatched.accountId, "first", {
        inputTokens: 2n,
        outputTokens: 0n,
      }),
    ).resolves.toMatchObject({
      state: "settled",
      chargedMicrocredits: "1",
    });
    now += 1_000;
    active = true;
    expect(await casdoorAccess.check(identity)).toBe(true);
    const secondDispatch = {
      operationId: "second",
      permit: second.permit,
      scope: grant,
    };
    await expect(
      restarted.beginDispatch(identity, secondDispatch),
    ).resolves.toMatchObject({
      state: "existing",
      operation: {
        operationId: "second",
        state: "released",
        reservedMicrocredits: "2",
        releasedMicrocredits: "2",
        chargedMicrocredits: null,
      },
    });
    await expect(
      restarted.revokeExternalSpending(identity, grant),
    ).resolves.toBe(true);
    await expect(
      restarted.reserve(identity, reserve("after-revocation")),
    ).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    const freshScope = { ...grant, authorizationId: crypto.randomUUID() };
    const authorizeFresh = (scope: typeof freshScope) =>
      restarted.authorizeExternalSpending(identity, {
        ...scope,
        expiresAt: new Date(now + 26 * 3_600_000),
        maxMicrocredits: 2n,
      });
    await authorizeFresh(freshScope);
    const longReserve = (operationId: string) =>
      restarted.reserve(identity, {
        ...reserve(operationId),
        scope: freshScope,
      });
    const late = await longReserve("late");
    if (late.state !== "reserved")
      throw new Error("Expected late-evidence fixture reservation");
    const lateDispatch = await restarted.beginDispatch(identity, {
      operationId: "late",
      permit: late.permit,
      scope: freshScope,
    });
    if (lateDispatch.state !== "dispatch")
      throw new Error("Expected late-evidence fixture dispatch");
    now += 24 * 3_600_000;
    expect(await casdoorAccess.check(identity)).toBe(true);
    expect((await longReserve("replacement")).state).toBe("reserved");
    await expect(
      restarted.settle(lateDispatch.accountId, "late", {
        inputTokens: 3n,
        outputTokens: 0n,
      }),
    ).resolves.toMatchObject({ state: "released", chargedMicrocredits: null });
    await expect(
      restarted.reconciliationCost(lateDispatch.accountId, "late"),
    ).resolves.toBe("2");

    const raceScope = { ...grant, authorizationId: crypto.randomUUID() };
    await authorizeFresh(raceScope);
    const racing = await restarted.reserve(identity, {
      ...reserve("racing"),
      scope: raceScope,
    });
    if (racing.state !== "reserved")
      throw new Error("Expected racing fixture reservation");
    const consume = {
      operationId: "racing",
      permit: racing.permit,
      scope: raceScope,
    };
    const [revoked, ...admissions] = await Promise.all([
      restarted.revokeExternalSpending(identity, raceScope),
      restarted.beginDispatch(identity, consume),
      restarted.beginDispatch(identity, consume),
    ]);
    expect(revoked).toBe(true);
    expect(
      admissions.filter(({ state }) => state === "dispatch").length,
    ).toBeLessThanOrEqual(1);
    expect((await restarted.beginDispatch(identity, consume)).state).not.toBe(
      "dispatch",
    );
    const admitted = admissions.find(({ state }) => state === "dispatch");
    if (admitted) await restarted.releaseUnsent(admitted.accountId, "racing");
    const revokedHoldScope = { ...grant, authorizationId: crypto.randomUUID() };
    await authorizeFresh(revokedHoldScope);
    const revokedHold = await restarted.reserve(identity, {
      ...reserve("revoked-hold"),
      scope: revokedHoldScope,
    });
    if (revokedHold.state !== "reserved")
      throw new Error("Expected revoked-hold fixture reservation");
    await expect(
      restarted.revokeExternalSpending(identity, revokedHoldScope),
    ).resolves.toBe(true);
    await expect(
      restarted.beginDispatch(identity, {
        operationId: "revoked-hold",
        permit: revokedHold.permit,
        scope: revokedHoldScope,
      }),
    ).resolves.toEqual({ state: "denied", reason: "not_authorized" });
    await expect(
      restarted.receipt(identity, "revoked-hold"),
    ).resolves.toMatchObject({
      state: "released",
      reservedMicrocredits: "2",
      releasedMicrocredits: "2",
      chargedMicrocredits: null,
    });
    await expect(restarted.balance(identity)).resolves.toMatchObject({
      availableMicrocredits: "17",
    });
    const expiredHoldScope = {
      ...grant,
      authorizationId: crypto.randomUUID(),
    };
    await restarted.authorizeExternalSpending(identity, {
      ...expiredHoldScope,
      expiresAt: new Date(now + 1_000),
      maxMicrocredits: 2n,
    });
    const expiredHold = await restarted.reserve(identity, {
      ...reserve("expired-hold"),
      scope: expiredHoldScope,
    });
    if (expiredHold.state !== "reserved")
      throw new Error("Expected expired-hold fixture reservation");
    now += 2_000;
    await expect(
      restarted.beginDispatch(identity, {
        operationId: "expired-hold",
        permit: expiredHold.permit,
        scope: expiredHoldScope,
      }),
    ).resolves.toEqual({ state: "denied", reason: "not_authorized" });
    await expect(
      restarted.receipt(identity, "expired-hold"),
    ).resolves.toMatchObject({
      state: "released",
      reservedMicrocredits: "2",
      releasedMicrocredits: "2",
      chargedMicrocredits: null,
    });
    await expect(restarted.balance(identity)).resolves.toMatchObject({
      availableMicrocredits: "17",
    });
    const httpScope = { ...grant, authorizationId: crypto.randomUUID() };
    await authorizeFresh(httpScope);
    const serviceToken = crypto.randomUUID();
    const handle = (
      execute: Parameters<typeof weknoraEmbeddingRoutes>[0]["execute"],
    ) =>
      weknoraEmbeddingRoutes({
        issuer: identity.issuer,
        serviceToken,
        routeId: "pilot",
        ledger: createTestCreditLedger(database, () => new Date(now)),
        execute,
      });
    const body = {
      subject: identity.subject,
      resourceId: httpScope.resourceId,
      authorizationId: httpScope.authorizationId,
      operationId: crypto.randomUUID(),
      input: ["first"],
    };
    const request = (
      input: Omit<typeof body, "subject"> & { subject: string } = body,
      token: string = serviceToken,
    ) => ({
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let gatewayCalls = 0;
    const app = handle(async ({ beforeDispatch }) => {
      if (!(await beforeDispatch({ requestId: "trusted-provider-request" })))
        throw new Error("Fixture dispatch rejected");
      gatewayCalls++;
      started.resolve();
      await finish.promise;
      return {
        outcome: "complete",
        vectors: [[0.125, -0.25]],
        usage: { inputTokens: 2, outputTokens: 0 },
      };
    });
    expect((await app.request("/", request(body, "invalid"))).status).toBe(401);
    expect(
      (await app.request("/", request({ ...body, subject: "other" }))).status,
    ).toBe(403);
    const inFlight = Promise.resolve(app.request("/", request()));
    try {
      await Promise.race([
        started.promise,
        inFlight.then(async (response) => {
          throw new Error(`Expected dispatch, received ${response.status}`);
        }),
      ]);
      expect((await app.request("/", request())).status).toBe(409);
      const changed = { ...body, input: ["second"] };
      expect((await app.request("/", request(changed))).status).toBe(409);
      now += 60_000;
      const blocked = { ...body, operationId: crypto.randomUUID() };
      expect((await app.request("/", request(blocked))).status).toBe(403);
    } finally {
      finish.resolve();
    }
    const accepted = await inFlight;
    expect(accepted.status).toBe(200);
    const result: unknown = await accepted.json();
    expect(result).toMatchObject({
      vectors: [[0.125, -0.25]],
      receipt: { state: "settled", chargedMicrocredits: "1" },
    });
    const freshApp = handle(async () => {
      throw new Error("Replaying must not dispatch");
    });
    const replayed = await freshApp.request("/", request());
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(result);
    expect(gatewayCalls).toBe(1);
  } finally {
    await database.transaction(async (tx) => {
      const [billingAccount] = await tx
        .select({ id: testCreditAccounts.id })
        .from(testCreditAccounts)
        .where(
          and(
            eq(testCreditAccounts.issuer, identity.issuer),
            eq(testCreditAccounts.subject, identity.subject),
          ),
        );
      if (billingAccount) {
        await tx
          .delete(lagoUsageEvents)
          .where(eq(lagoUsageEvents.accountId, billingAccount.id));
        await tx
          .delete(testCreditEvidence)
          .where(eq(testCreditEvidence.accountId, billingAccount.id));
        await tx
          .delete(testCreditOperations)
          .where(eq(testCreditOperations.accountId, billingAccount.id));
        await tx
          .delete(testCreditExternalAuthorizations)
          .where(
            eq(testCreditExternalAuthorizations.accountId, billingAccount.id),
          );
        await tx
          .delete(testCreditEnrollments)
          .where(eq(testCreditEnrollments.accountId, billingAccount.id));
        await tx
          .delete(testCreditAccounts)
          .where(eq(testCreditAccounts.id, billingAccount.id));
      }
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
      await tx
        .delete(personalWorkspaceSuspensions)
        .where(eq(personalWorkspaceSuspensions.accountId, account.id));
      await tx
        .delete(personalWorkspaces)
        .where(eq(personalWorkspaces.id, workspaceId));
      await tx
        .delete(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, account.id));
    });
    if (originalCatalog)
      await database
        .update(enterpriseSettings)
        .set({ value: originalCatalog.value })
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    await database.$client.close();
  }
});
