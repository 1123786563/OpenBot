import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import {
  RESERVE_REFUSAL_REASONS,
  createCreditReserveService,
  creditProtocolEndpoints,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #255 (06.4): the Reserve protocol's payer-tampering conflict semantics.
 *
 * The server resolves the payment account FROM the authorization (today: a personal grant
 * resolves to `personal/<grant.userId>`); the request's own `payer` is a claim the server
 * verifies, never an input. Three tamper classes must each refuse with the closed
 * `payer_conflict` code and write NOTHING — on the caller's account or on the forged
 * target's:
 *
 *   1. forging a company account onto a personal authorization (and the account is REAL
 *      and holds credits — the refusal must not depend on the target failing to resolve),
 *   2. forging another person's personal account (same real-account discipline),
 *   3. a bare self-reported account key (`externalCustomerId`, or any account-identity
 *      parameter) anywhere in the request — refused as a shape, never silently ignored.
 *
 * Every conflict is audited (`credit_reserve.payer_conflict`) so bypass attempts are
 * countable (22.2). Isolation: every scenario names its own unique prefixes; fixtures are
 * deleted by prefix in afterAll (price snapshot rows are append-only and stay).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-255-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds credit grants only; the unit under test builds its own over the transaction. */
const fixtureCreditWriter = createCreditWriter(database);
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

/** The one service under test, wired with the audit store exactly as production mounts it. */
const service = createCreditReserveService({ database, auditStore });

/** A priced catalog entry fixture: every wire-priced dimension carries an exact amount. */
const PRICED_RAW_ENTRY = {
  id: "fix/model",
  pricing: {
    prompt: "0.000001",
    completion: "0.000002",
    internal_reasoning: "0.000003",
    image: "0.01",
    input_cache_read: "0.0000001",
    input_cache_write: "0.0000015",
    web_search: "0.001",
    request: "0",
  },
};

type SeedOptions = {
  /**
   * Also create a REAL second payment account with credits, as the forgery target: the
   * conflict must fire because the grant does not authorize it, not because it is broken.
   */
  forgedTarget?: { kind: "company" | "personal"; id: string };
};

type SeededWorld = {
  userId: string;
  grantId: string;
  /** The account key the grant's own authorization resolves to. */
  ownKey: string;
  /** The forged target's account key, when the scenario seeded one. */
  forgedKey?: string;
  request: CreditReserveRequest;
};

let seedCounter = 0;

/**
 * One complete world where a reserve SHOULD succeed: an active personal grant, its
 * personal payer account with credits, an open cataloged ref whose price is fully known,
 * and a fresh catalog sync. Options add the forgery target the scenario aims at.
 */
async function seedWorld(options: SeedOptions = {}): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Tamper Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:ext:${n}`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });

  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureCreditWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 10_000_00, // 10 000 credits, ×100
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  let forgedKey: string | undefined;
  if (options.forgedTarget) {
    const { account: forged } = await createPayerAccount(database, {
      kind: options.forgedTarget.kind,
      id: options.forgedTarget.id,
    });
    await fixtureCreditWriter.grantCredits({
      externalCustomerId: forged.externalCustomerId,
      source: "plan",
      totalCents: 10_000_00,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idempotencyKey: `${prefix}-seed-forged-${n}`,
    });
    forgedKey = forged.externalCustomerId;
  }

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "chat",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  const store = createEnterpriseGatewayPriceSnapshotStore(database);
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: mapPriceDims(PRICED_RAW_ENTRY),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "reserve-payer-tampering fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000) },
    });

  const request: CreditReserveRequest = {
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability: "chat" },
    snapshotVersion: 1,
    rateVersion: 0,
    boundEvidence: [
      { kind: "provider_max_tokens", maximumTokens: 4096 },
      { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
    ],
    maximumCredits: 500, // 5 credits, ×100
    idempotencyKey: `${prefix}-idem-${n}`,
  };
  return {
    userId,
    grantId,
    ownKey: payerKey({ kind: "personal", id: userId }),
    forgedKey,
    request,
  };
}

/** Reservation rows that exist for one account key — the write a tampered reserve must never make. */
async function reservationCount(customerKey: string): Promise<number> {
  const rows = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
  return rows.length;
}

/** The payer-conflict audit rows for one claimed grant. */
async function payerConflictEvents(grantId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "credit_reserve.payer_conflict"),
        eq(auditEvents.targetId, grantId),
      ),
    );
}

/**
 * Assert one tamper refusal end to end: the `payer_conflict` code, zero reservation rows
 * on the caller's account AND on the forged target's, and an audit row recording the
 * bypass attempt.
 */
async function expectTamperRefusal(
  outcome: CreditReserveOutcome,
  world: SeededWorld,
): Promise<void> {
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("payer_conflict");
  expect(await reservationCount(world.ownKey)).toBe(0);
  if (world.forgedKey) expect(await reservationCount(world.forgedKey)).toBe(0);
  const events = await payerConflictEvents(world.grantId);
  expect(events.length).toBeGreaterThanOrEqual(1);
}

// ── Parameter non-existence: the caller can never name the account key ─────────────

/**
 * Compile-time proof: no account-key parameter exists on the request contract. If the
 * contract grows one, `Extract` yields that key and these lines stop compiling.
 */
type ForbiddenAccountKeyField =
  | "externalCustomerId"
  | "accountId"
  | "customerKey"
  | "payerId"
  | "userId"
  | "companyId"
  | "tenantId";
type IsNever<T> = [T] extends [never] ? true : false;
const requestContractHasNoAccountKeyField: IsNever<
  Extract<keyof CreditReserveRequest, ForbiddenAccountKeyField>
> = true;
void requestContractHasNoAccountKeyField;
const payerRefHasExactlyKindAndId: IsNever<
  Exclude<keyof CreditReserveRequest["payer"], "kind" | "id">
> = true;
void payerRefHasExactlyKindAndId;

test("the reserve request contract exposes no caller-specified account key", () => {
  expect(RESERVE_REFUSAL_REASONS).toContain("payer_conflict");
  const canonical: CreditReserveRequest = {
    grantId: "g",
    payer: { kind: "personal", id: "u" },
    model: { provider: "p", model: "m", capability: "chat" },
    snapshotVersion: 1,
    rateVersion: 0,
    boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 1 }],
    maximumCredits: 1,
    idempotencyKey: "k",
  };
  for (const field of [
    "externalCustomerId",
    "accountId",
    "customerKey",
    "payerId",
    "userId",
    "companyId",
    "tenantId",
  ] as const) {
    expect(field in canonical).toBe(false);
  }
  expect(Object.keys(canonical.payer).sort()).toEqual(["id", "kind"]);
});

// ── Tamper class 1: a company account forged onto a personal authorization ─────────

test("a company account forged onto a personal grant refuses as payer_conflict", async () => {
  const tenantId = `${prefix}-tenant-co`;
  const world = await seedWorld({
    forgedTarget: { kind: "company", id: tenantId },
  });
  const outcome = await service.reserve({
    ...world.request,
    payer: { kind: "company", id: tenantId },
  });
  await expectTamperRefusal(outcome, world);
  // The audit row names the attempt: the requested payer and the resolved one.
  const [event] = await payerConflictEvents(world.grantId);
  expect(event.payload).toMatchObject({
    requestedPayer: { kind: "company", id: tenantId },
    resolvedPayer: { kind: "personal", id: world.userId },
  });
});

// ── Tamper class 2: another person's personal account forged onto the grant ────────

test("another person's personal account forged onto the grant refuses as payer_conflict", async () => {
  const victimId = `${prefix}-user-victim`;
  const world = await seedWorld({
    forgedTarget: { kind: "personal", id: victimId },
  });
  const outcome = await service.reserve({
    ...world.request,
    payer: { kind: "personal", id: victimId },
  });
  await expectTamperRefusal(outcome, world);
  const [event] = await payerConflictEvents(world.grantId);
  expect(event.payload).toMatchObject({
    requestedPayer: { kind: "personal", id: victimId },
    resolvedPayer: { kind: "personal", id: world.userId },
  });
});

// ── Tamper class 3: a bare self-reported account key, in any shape ─────────────────

test("a payer object carrying a self-reported externalCustomerId refuses as payer_conflict", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve({
    ...world.request,
    payer: {
      kind: "personal",
      id: world.userId,
      externalCustomerId: world.ownKey,
    } as CreditReserveRequest["payer"],
  });
  // Even the CORRECT key spelled by the caller is a self-report: refused, not ignored.
  await expectTamperRefusal(outcome, world);
});

test("a top-level externalCustomerId or any account-identity parameter refuses as payer_conflict", async () => {
  const world = await seedWorld();
  for (const field of [
    "externalCustomerId",
    "accountId",
    "customerKey",
    "payerId",
    "userId",
    "companyId",
    "tenantId",
  ] as const) {
    const outcome = await service.reserve({
      ...world.request,
      [field]: world.ownKey,
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") continue;
    expect(outcome.reasonCode).toBe("payer_conflict");
    expect(await reservationCount(world.ownKey)).toBe(0);
  }
  const events = await payerConflictEvents(world.grantId);
  expect(events.length).toBeGreaterThanOrEqual(7);
});

// ── The honest path stays open, and writes no conflict audit ────────────────────────

test("the matching payer still reserves and writes no conflict audit", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("reserved");
  expect(await payerConflictEvents(world.grantId)).toHaveLength(0);
});

// ── The HTTP boundary carries the same conflict code ────────────────────────────────

let gatewaySecret: string | null = null;

test("the deployment's trusted credential is issued for the protocol surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

test("the endpoint maps a forged payer to a 422 with the payer_conflict code", async () => {
  const tenantId = `${prefix}-tenant-http`;
  const world = await seedWorld({
    forgedTarget: { kind: "company", id: tenantId },
  });
  const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
  protocolApp.route(
    "/api/credit-protocol",
    creditProtocolRoutes({
      authenticate,
      auditStore,
      endpoints: creditProtocolEndpoints({ service }),
    }),
  );
  const response = await protocolApp.request("/api/credit-protocol/reserve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: JSON.stringify({
      ...world.request,
      payer: { kind: "company", id: tenantId },
    }),
  });
  expect(response.status).toBe(422);
  const json = (await response.json()) as Record<string, unknown>;
  expect(json.code).toBe("payer_conflict");
  expect(await reservationCount(world.ownKey)).toBe(0);
  expect(
    await reservationCount(payerKey({ kind: "company", id: tenantId })),
  ).toBe(0);
});

afterAll(async () => {
  await database
    .delete(creditReservations)
    .where(
      like(
        creditReservations.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
    );
  await database
    .delete(creditReservations)
    .where(
      like(creditReservations.externalCustomerId, `openbot-company-${prefix}%`),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`} OR external_customer_id LIKE ${`openbot-company-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`} OR external_customer_id LIKE ${`openbot-company-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`} OR external_customer_id LIKE ${`openbot-company-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`} OR external_id LIKE ${`openbot-company-${prefix}%`}`,
  );
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  // audit_events and gateway_price_snapshots are append-only in the database (their own
  // triggers/constraints): rows are never deleted; every scenario above isolates itself
  // with its own unique prefix instead.
  await database.$client.close();
});
