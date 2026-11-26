import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import {
  createTestCreditLedger,
  type TestCreditLedger,
} from "../src/billing/test-credit";
import {
  createWeKnoraIngestionBilling,
  WEKNORA_APPLICATION_ID,
} from "../src/billing/weknora-ingestion";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  billingSpendingAuthorizations,
  enterpriseSettings,
  lagoUsageEvents,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
  testCreditResumePoints,
} from "../src/db/schema";
import { fixtureEmbeddingReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The WeKnora ingestion adapter spends the same durable Spending
 * Authorizations as the ledger's other paths (#111): a grant lives in the
 * database, needs an approved application, and reports revocation and expiry
 * through its state while the adapter keeps its own denial codes.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const issuer = "https://casdoor.example.test";
const resourceId = "weknora:tenant:1:kb:kb-1";
const otherResource = "weknora:tenant:1:kb:kb-2";
const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
const routeId = "ingestion-embed";
// 4 input tokens at 1 credit per token: every reservation holds 4 credits.
const configured = configure(emptyCatalog, {
  harnessImage,
  routes: {
    [routeId]: {
      purpose: "embedding",
      provider: "fixture-embed",
      model: "embed-model",
      gatewayRevision: "gateway-r1",
      meteringRevision: "meter-r1",
      maxInputTokens: 4,
      maxOutputTokens: 0,
      tools: false,
      price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
    },
  },
});
const route = configured.routes[routeId];
if (!route) throw new Error("Missing fixture embedding route");
const { catalog } = publish(
  verify(
    configured,
    routeId,
    fixtureEmbeddingReport(harnessImage, route),
    "fixture",
  ),
  [routeId],
  null,
  "fixture",
);
const originalCatalog = await database
  .select()
  .from(enterpriseSettings)
  .where(eq(enterpriseSettings.key, pilotCatalogKey));
const suffix = crypto.randomUUID().slice(0, 8);
const cleanup = { subjects: [] as string[], batches: [] as string[] };

type Scope = {
  applicationId?: string;
  authorizationId: string;
  resourceId?: string;
};
const scope = (subject: string, input: Scope) => ({
  applicationId: input.applicationId ?? WEKNORA_APPLICATION_ID,
  authorizationId: input.authorizationId,
  issuer,
  subject,
  resourceId: input.resourceId ?? resourceId,
});
const reserve = (subject: string, input: Scope & { operationId: string }) => ({
  ...scope(subject, input),
  operationId: input.operationId,
});

/** A fresh Billing Account, and the adapter built before any grant exists. */
async function setup(amount: bigint) {
  let now = new Date("2026-11-21T00:00:00.000Z");
  const ledger = createTestCreditLedger(database, () => now);
  const identity = await prepare(ledger, amount);
  const verified: string[] = [];
  const service = createWeKnoraIngestionBilling({
    ledger,
    routeId,
    verifyApplication: async (id) => {
      verified.push(`app:${id}`);
      return id === WEKNORA_APPLICATION_ID;
    },
    verifyUser: async ({ subject }) => {
      verified.push(
        subject === identity.subject ? "user:uploader" : "user:other",
      );
      return subject === identity.subject;
    },
  });
  return {
    ledger,
    identity,
    service,
    verified,
    advance: (at: string) => {
      now = new Date(at);
    },
  };
}

async function prepare(ledger: TestCreditLedger, amount: bigint) {
  const subject = `ingest-${crypto.randomUUID()}`;
  const identity = { issuer, subject };
  const batchId = crypto.randomUUID();
  cleanup.subjects.push(subject);
  cleanup.batches.push(batchId);
  await ledger.enroll({ identity, batchId, amount });
  await ledger.claim(identity, batchId);
  return identity;
}

/** The person's durable grant: one background task over one knowledge base. */
async function grant(
  ledger: TestCreditLedger,
  identity: { issuer: string; subject: string },
  input: {
    limitMicrocredits: bigint;
    expiresAt?: Date;
    kind?: "online" | "background";
  },
) {
  const authorizationId = crypto.randomUUID();
  expect(
    await ledger.authorize(identity, {
      authorizationId,
      applicationId: WEKNORA_APPLICATION_ID,
      kind: input.kind ?? "background",
      taskId: input.kind === "online" ? undefined : authorizationId,
      resourcePrefix: resourceId,
      expiresAt: input.expiresAt ?? new Date("2030-01-01T00:00:00.000Z"),
      limitMicrocredits: input.limitMicrocredits,
    }),
  ).toMatchObject({ state: "authorized" });
  return authorizationId;
}

beforeAll(async () => {
  await database
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value: catalog })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: catalog },
    });
  await database
    .insert(billingApplications)
    .values({
      id: WEKNORA_APPLICATION_ID,
      name: "WeKnora",
      operator: "platform",
      resourcePrefix: "weknora:",
      approvedAt: new Date("2026-01-01T00:00:00.000Z"),
      approvedBy: "fixture",
    })
    .onConflictDoUpdate({
      target: billingApplications.id,
      set: {
        approvedAt: new Date("2026-01-01T00:00:00.000Z"),
        approvedBy: "fixture",
      },
    });
});

afterAll(async () => {
  if (originalCatalog[0])
    await database
      .update(enterpriseSettings)
      .set({ value: originalCatalog[0].value })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      and(
        eq(testCreditAccounts.issuer, issuer),
        inArray(testCreditAccounts.subject, cleanup.subjects),
      ),
    );
  const accountIds = accounts.map(({ id }) => id);
  if (accountIds.length) {
    await database
      .delete(lagoUsageEvents)
      .where(inArray(lagoUsageEvents.accountId, accountIds));
    await database
      .delete(testCreditEvidence)
      .where(inArray(testCreditEvidence.accountId, accountIds));
    await database
      .delete(testCreditOperations)
      .where(inArray(testCreditOperations.accountId, accountIds));
    await database
      .delete(testCreditResumePoints)
      .where(inArray(testCreditResumePoints.accountId, accountIds));
    await database
      .delete(testCreditBudgets)
      .where(inArray(testCreditBudgets.accountId, accountIds));
    await database
      .delete(testCreditEnrollments)
      .where(inArray(testCreditEnrollments.accountId, accountIds));
    await database
      .delete(billingSpendingAuthorizations)
      .where(inArray(billingSpendingAuthorizations.accountId, accountIds));
  }
  await database
    .delete(testCreditAccounts)
    .where(inArray(testCreditAccounts.id, accountIds));
  await database
    .delete(testCreditBatches)
    .where(inArray(testCreditBatches.id, cleanup.batches));
  // The approved "weknora" application is a shared fixture: other billing
  // suites register it too, and a grant they leave behind must not crash this
  // cleanup.
});

test("ingestion reserves and settles through a durable grant on the uploader's account", async () => {
  // The service is built before the grant exists: nothing is registered into it.
  const { ledger, identity, service, verified } = await setup(200n);
  const authorizationId = await grant(ledger, identity, {
    limitMicrocredits: 40n,
  });
  await expect(
    service.preflight(scope(identity.subject, { authorizationId })),
  ).resolves.toMatchObject({
    creditType: "test",
    maxChargeMicrocredits: "4",
    applicationId: WEKNORA_APPLICATION_ID,
  });
  const operationId = `${suffix}-ok`;
  const reserved = await service.reserve(
    reserve(identity.subject, { authorizationId, operationId }),
  );
  expect(reserved.state).toBe("reserved");
  expect(reserved.authorizationId).toBe(authorizationId);
  expect(
    await ledger.beginDispatch(
      identity,
      { operationId, permit: reserved.permit ?? "", authorizationId },
      { embedding: true },
    ),
  ).toMatchObject({ state: "dispatch" });
  await expect(
    service.settle({
      operationId,
      authorizationId,
      uploaderAccount: identity,
      inputTokens: 12n,
      outputTokens: 0n,
    }),
  ).resolves.toMatchObject({
    state: "settled",
    applicationId: WEKNORA_APPLICATION_ID,
    chargedMicrocredits: "4",
  });
  expect(
    (await ledger.authorizationSummary(WEKNORA_APPLICATION_ID, authorizationId))
      ?.spentMicrocredits,
  ).toBe("4");
  expect(verified).toEqual([
    "app:weknora",
    "user:uploader",
    "app:weknora",
    "user:uploader",
  ]);
});

test("identity, resource scope and task binding are refused before anything is held", async () => {
  const { ledger, identity, service } = await setup(200n);
  const stranger = await prepare(ledger, 200n);
  const authorizationId = await grant(ledger, identity, {
    limitMicrocredits: 40n,
  });
  const online = await grant(ledger, identity, {
    limitMicrocredits: 40n,
    kind: "online",
  });
  const foreign = await grant(ledger, stranger, { limitMicrocredits: 40n });
  for (const [label, who, input] of [
    ["other subject", stranger.subject, { authorizationId }],
    [
      "unknown grant",
      identity.subject,
      { authorizationId: crypto.randomUUID() },
    ],
    [
      "other resource",
      identity.subject,
      { authorizationId, resourceId: otherResource },
    ],
    [
      "other application",
      identity.subject,
      { authorizationId, applicationId: "other-app" },
    ],
    ["online grant", identity.subject, { authorizationId: online }],
    ["other account's grant", identity.subject, { authorizationId: foreign }],
  ] as const) {
    await expect(
      service.reserve(
        reserve(who, { ...input, operationId: `${suffix}-${label}` }),
      ),
      label,
    ).rejects.toMatchObject({ code: "not_authorized" });
  }
  const accountId = await ledger.accountOf(identity);
  if (!accountId) throw new Error("No Billing Account for the uploader");
  const held = await database
    .select({ id: testCreditOperations.id })
    .from(testCreditOperations)
    .where(eq(testCreditOperations.accountId, accountId));
  expect(held).toHaveLength(0);
  // The same request on its own grant is admitted: every refusal above is
  // the mismatch it names, not a missing grant.
  await expect(
    service.reserve(
      reserve(identity.subject, {
        authorizationId,
        operationId: `${suffix}-valid`,
      }),
    ),
  ).resolves.toMatchObject({
    state: "reserved",
    applicationId: WEKNORA_APPLICATION_ID,
  });
});

test("revoked and expired durable states keep the adapter's distinct denial codes", async () => {
  const { ledger, identity, service, advance } = await setup(200n);
  const revoked = await grant(ledger, identity, { limitMicrocredits: 40n });
  const expired = await grant(ledger, identity, {
    limitMicrocredits: 40n,
    expiresAt: new Date("2026-11-30T00:00:00.000Z"),
  });
  const operationId = `${suffix}-held`;
  const reserved = await service.reserve(
    reserve(identity.subject, { authorizationId: revoked, operationId }),
  );
  expect(reserved.state).toBe("reserved");
  expect(await ledger.revokeAuthorization(identity, revoked)).toMatchObject({
    state: "revoked",
  });
  await expect(
    service.preflight(scope(identity.subject, { authorizationId: revoked })),
  ).rejects.toMatchObject({ code: "authorization_revoked" });
  await expect(
    service.reserve(
      reserve(identity.subject, {
        authorizationId: revoked,
        operationId: `${suffix}-after`,
      }),
    ),
  ).rejects.toMatchObject({ code: "authorization_revoked" });
  // Revocation stops the reservation already made, and releases its hold.
  expect(
    await ledger.beginDispatch(
      identity,
      { operationId, permit: reserved.permit ?? "", authorizationId: revoked },
      { embedding: true },
    ),
  ).toMatchObject({ state: "denied", reason: "not_authorized" });
  expect(
    await ledger.authorizationSummary(WEKNORA_APPLICATION_ID, revoked),
  ).toMatchObject({ state: "revoked", spentMicrocredits: "0" });
  await expect(
    service.preflight(scope(identity.subject, { authorizationId: expired })),
  ).resolves.toBeDefined();
  advance("2026-12-01T00:00:00.000Z");
  await expect(
    service.reserve(
      reserve(identity.subject, {
        authorizationId: expired,
        operationId: `${suffix}-late`,
      }),
    ),
  ).rejects.toMatchObject({ code: "authorization_expired" });
});

test("a cap pause waits at its operation until the person confirms a budget", async () => {
  const { ledger, identity, service } = await setup(200n);
  const authorizationId = await grant(ledger, identity, {
    limitMicrocredits: 4n,
  });
  const operationId = `${suffix}-paused`;
  expect(
    await service.reserve(
      reserve(identity.subject, {
        authorizationId,
        operationId: `${suffix}-first`,
      }),
    ),
  ).toMatchObject({
    state: "reserved",
    applicationId: WEKNORA_APPLICATION_ID,
  });
  await expect(
    service.reserve(
      reserve(identity.subject, { authorizationId, operationId }),
    ),
  ).rejects.toMatchObject({ code: "execution_limit" });
  expect(
    await ledger.ingestionPause(authorizationId, operationId),
  ).toMatchObject({ reason: "execution_limit", confirmedAt: null });
  const budgetId = `ingest-resume-${suffix}`;
  expect(
    await ledger.createBudget(identity, {
      budgetId,
      creditType: "test",
      limitMicrocredits: 8n,
    }),
  ).toMatchObject({ budgetId, confirmed: true });
  await expect(
    service.resume({
      ...reserve(identity.subject, { authorizationId, operationId }),
      budgetId,
      confirmedMaxMicrocredits: 8n,
    }),
  ).resolves.toMatchObject({ state: "reserved" });
  expect(
    await ledger.authorizationSummary(WEKNORA_APPLICATION_ID, authorizationId),
  ).toMatchObject({ limitMicrocredits: "8", spentMicrocredits: "8" });
  expect(
    await ledger.ingestionPause(authorizationId, operationId),
  ).toBeUndefined();
});

test("exhausted credits pause the step instead of refusing it", async () => {
  const { ledger, identity, service } = await setup(4n);
  const authorizationId = await grant(ledger, identity, {
    limitMicrocredits: 40n,
  });
  expect(
    await service.reserve(
      reserve(identity.subject, {
        authorizationId,
        operationId: `${suffix}-paid`,
      }),
    ),
  ).toMatchObject({ state: "reserved" });
  await expect(
    service.reserve(
      reserve(identity.subject, {
        authorizationId,
        operationId: `${suffix}-empty`,
      }),
    ),
  ).rejects.toMatchObject({ code: "insufficient_credits" });
  expect(
    await ledger.ingestionPause(authorizationId, `${suffix}-empty`),
  ).toMatchObject({ reason: "insufficient_credits" });
});

test("an application reads only operations under its own grant", async () => {
  const { ledger, identity, service } = await setup(200n);
  const stranger = await prepare(ledger, 200n);
  const authorizationId = await grant(ledger, identity, {
    limitMicrocredits: 40n,
  });
  const foreign = await grant(ledger, stranger, { limitMicrocredits: 40n });
  const operationId = `${suffix}-read`;
  expect(
    await service.reserve(
      reserve(identity.subject, { authorizationId, operationId }),
    ),
  ).toMatchObject({ state: "reserved" });
  await expect(
    service.operation(
      WEKNORA_APPLICATION_ID,
      authorizationId,
      operationId,
      identity.subject,
    ),
  ).resolves.toMatchObject({
    operationId,
    applicationId: WEKNORA_APPLICATION_ID,
  });
  await expect(
    service.operation(
      WEKNORA_APPLICATION_ID,
      authorizationId,
      operationId,
      stranger.subject,
    ),
  ).resolves.toBeUndefined();
  await expect(
    service.operation(
      WEKNORA_APPLICATION_ID,
      foreign,
      operationId,
      identity.subject,
    ),
  ).resolves.toBeUndefined();
  await expect(
    service.operation(
      "other-app",
      authorizationId,
      operationId,
      identity.subject,
    ),
  ).resolves.toBeUndefined();
  // Another account can neither widen, revoke nor settle through it.
  expect(
    await ledger.amendAuthorization(stranger, authorizationId, {
      limitMicrocredits: 100n,
    }),
  ).toBeUndefined();
  expect(
    await ledger.revokeAuthorization(stranger, authorizationId),
  ).toBeUndefined();
  expect(
    await ledger.authorizationSummary(WEKNORA_APPLICATION_ID, authorizationId),
  ).toMatchObject({ state: "active", limitMicrocredits: "40" });
  await expect(
    service.settle({
      operationId,
      authorizationId,
      uploaderAccount: stranger,
      inputTokens: 1n,
      outputTokens: 0n,
    }),
  ).rejects.toMatchObject({ code: "not_authorized" });
});
