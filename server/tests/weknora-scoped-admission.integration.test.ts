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
  personalSaasAccounts,
  personalWorkspaceSuspensions,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditExternalAuthorizations,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
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
        provider: "fixture-a",
        model: "model-a",
        gatewayRevision: "a",
        meteringRevision: "a",
        maxInputTokens: 3,
        maxOutputTokens: 16,
        tools: false,
        price: { inputPerMillion: 250_000, outputPerMillion: 78_125 },
      },
    },
  });
  const route = configured.routes.pilot;
  if (!route) throw new Error("Missing fixture route");
  const verified = verify(
    configured,
    "pilot",
    fixtureTraceReport(harnessImage, route),
    "fixture",
  );
  const { catalog, release } = publish(verified, ["pilot"], "pilot", "fixture");

  const batchId = crypto.randomUUID();
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

    await database.insert(personalWorkspaceSuspensions).values({
      workspaceId: crypto.randomUUID(),
      accountId: account.id,
      action: "pause",
      operator: "fixture",
      reason: "fixture",
      effectiveAt: new Date(now),
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
    await database
      .update(personalSaasAccounts)
      .set({
        status: {
          source: "disabled",
          observedAt: now,
          confirmedAt: now - 60_000,
          epoch: 1,
          disablements: [{ id: "casdoor-disablement", effectiveAt: now }],
        },
      })
      .where(eq(personalSaasAccounts.id, account.id));
    await expect(
      restarted.reserve(identity, reserve("disabled")),
    ).resolves.toEqual({
      state: "denied",
      reason: "not_authorized",
    });
    await expect(
      restarted.settle(dispatched.accountId, "first", {
        inputTokens: 3n,
        outputTokens: 4n,
      }),
    ).resolves.toMatchObject({
      state: "settled",
      chargedMicrocredits: "1",
    });
    now += 1_000;
    await database
      .update(personalSaasAccounts)
      .set({
        status: {
          source: "active",
          observedAt: now,
          confirmedAt: now,
          epoch: 1,
          disablements: [
            { id: "casdoor-disablement", effectiveAt: now - 1_000 },
          ],
        },
      })
      .where(eq(personalSaasAccounts.id, account.id));
    const secondDispatch = {
      operationId: "second",
      permit: second.permit,
      scope: grant,
    };
    await expect(
      restarted.beginDispatch(identity, secondDispatch),
    ).resolves.toEqual({ state: "denied", reason: "not_authorized" });
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
    await database
      .update(personalSaasAccounts)
      .set({
        status: {
          source: "active",
          observedAt: now,
          confirmedAt: now,
          epoch: 2,
          disablements: [],
        },
      })
      .where(eq(personalSaasAccounts.id, account.id));
    expect((await longReserve("replacement")).state).toBe("reserved");
    await expect(
      restarted.settle(lateDispatch.accountId, "late", {
        inputTokens: 3n,
        outputTokens: 16n,
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
