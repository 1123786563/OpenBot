import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createRerankAdmission } from "../src/billing/rerank-admission";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import type { CreditReserveOutcome } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  PRICE_DIMENSIONS,
  WIRE_PRICED_DIMENSIONS,
  mapPriceDims,
  type PriceDimension,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { createEnterpriseGatewayPriceSnapshotStore } from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #299 (11.4): the rerank refusal path — the OpenBot half. The entry a rerank
 * dispatch lands on wires 11.3's enablement verdict in FIRST and short-circuits: a rerank
 * cell whose snapshot dims do not price the rerank's own billed dimensions refuses before
 * ANY reserve call (the account-side proof of 供应商调用数为 0 — a hold is the dispatch
 * commitment, and none forms), with the reason naming THE missing dimension so an
 * administrator can price exactly that. Once the basis completes, the SAME request admits:
 * counted tokens × the input price + documents × the flat price, held 足额 through 06.5's
 * own conversion.
 *
 * THE OTHER HALF is the pinned bifrost submodule's own gates (plugins/governance, the
 * short-circuit refusal machinery 07.3 delivered); this suite proves what the ACCOUNT must
 * hold — zero holds, zero ledger rows, the balance untouched — and that the refusal's
 * reason is 11.3's own answer (the dimension and its per-dimension reason), the same
 * words the general reserve door would carry.
 *
 * Isolation mirrors #297's recipe (embedding-refusal): every scenario seeds its own
 * bot/grant/provider prefixes, and the fixtures are deleted by the DERIVED account-key
 * prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b10-299-${randomUUID().slice(0, 8)}`;
const fixtureCreditWriter = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

let seedCounter = 0;
/** How many times the entry actually reached the reserve door — the short-circuit proof. */
let reserveCalls = 0;
const admission = createRerankAdmission({
  reserve: async (request) => {
    reserveCalls += 1;
    return reserveService.reserve(request);
  },
});

/** The counted reserve answer for tests that drive the door directly. */
async function rawReserve(request: unknown): Promise<CreditReserveOutcome> {
  return reserveService.reserve(request);
}

/**
 * The v1-wire reality of a rerank cell: upstream bills per search unit and the v1 pricing
 * object carries no field for it — `prompt` (input tokens) and `request` (the flat side)
 * both have no source, and 03.2 records every other wire-priced dimension unknown too.
 */
const RERANK_V1_PRICING = {} as const;

/** The completed basis: every wire dimension priced, input and flat sides at real prices. */
const RERANK_COMPLETE_PRICING = {
  prompt: "0.00000002",
  completion: "0",
  internal_reasoning: "0",
  image: "0",
  input_cache_read: "0",
  input_cache_write: "0",
  web_search: "0",
  request: "0.0001",
} as const;

/** One rerank wire request, the shape the entry receives. */
const RERANK_REQUEST = {
  model: "rerank-b10",
  query: "what is the input bound of a rerank call?",
  documents: [
    "the input bound is the counted tokens of the query and every document",
    "documents are the payload; a batch cannot smuggle entries past the counter",
    { text: "an entry may carry its text under text — both wire shapes count" },
  ],
};

type RerankWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
  grantId: string;
};

/** One rerank world: a Bot, its grant, a funded personal account, an OPEN rerank cell. */
async function seedRerankWorld(seedCredits = 10_000): Promise<RerankWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `rerank-b10-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Rerank refusal Bot ${n}`,
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
    totalCents: seedCredits,
    expiresAt: new Date(Date.now() + 24 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "rerank",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "rerank",
    state: "open",
    reason: "rerank-refusal fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date() },
    });

  return {
    userId,
    customerKey: payerKey({ kind: "personal", id: userId }),
    provider,
    model,
    grantId,
  };
}

/**
 * The dimensions the v1 wire has no field for, as THIS fixture writes them out by hand: free
 * is a price, so the completed basis prices every one of them at an explicit "0". The list is
 * deliberately literal — that is what lets `assertReservedDimCoverage` below mean something,
 * because a vocabulary expansion that adds another wire-less dimension cannot be silently
 * missed here.
 */
const FIXTURE_RESERVED_DIMENSIONS: readonly PriceDimension[] = [
  "image_output",
  "audio_input",
  "audio_output",
  "video",
  "video_input",
  "surcharge_tool_call",
  "surcharge_a2a_call",
];

/**
 * Check the fixture's hand-written reserved list against 03.2's own module — the complement of
 * `WIRE_PRICED_DIMENSIONS` is the authoritative set of dimensions the v1 wire cannot price.
 * Both directions are compared so a vocabulary that GROWS (a dimension this fixture never
 * heard of) or SHRINKS (a dimension the wire now prices) is a red with the diff named, instead
 * of the fixture quietly mispricing the basis.
 */
function assertReservedDimCoverage(covered: readonly PriceDimension[]): void {
  const coveredSet = new Set<string>(covered);
  const expected = new Set<string>(
    PRICE_DIMENSIONS.filter(
      (dimension) => !WIRE_PRICED_DIMENSIONS.includes(dimension),
    ),
  );
  const missing = [...expected].filter((dim) => !coveredSet.has(dim)).sort();
  const unexpected = [...coveredSet].filter((dim) => !expected.has(dim)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "rerank fixture reserved-dimension coverage drifted from price-snapshot.ts: " +
        `missing [${missing.join(", ")}], ` +
        `unexpected [${unexpected.join(", ")}]`,
    );
  }
}

/**
 * The dims one rerank snapshot carries: the raw wire pricing through 03.2's own mapping,
 * with the reserved dimensions (no wire field in v1, ever) overlaid at an explicit "0" —
 * free is a price, so the completed basis prices every dimension of the vocabulary. Every
 * build re-checks the hand-written reserved list against `price-snapshot.ts`'s derived set
 * (R2-F1), so the fixture cannot fall behind the vocabulary unnoticed.
 */
function rerankDimsOf(pricing: Record<string, string>): PriceSnapshotDims {
  assertReservedDimCoverage(FIXTURE_RESERVED_DIMENSIONS);
  const mapped = mapPriceDims({ pricing });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      FIXTURE_RESERVED_DIMENSIONS.includes(dimension)
        ? { status: "known" as const, amount: "0" }
        : mapped[dimension],
    ]),
  ) as PriceSnapshotDims;
}

/** Append one snapshot version for the world's cell from a raw upstream pricing object. */
async function appendSnapshot(
  world: RerankWorld,
  pricing: Record<string, string>,
): Promise<number> {
  const { appended } = await snapshotStore.appendSnapshots([
    {
      ref: {
        provider: world.provider,
        model: world.model,
        capability: "rerank",
      },
      dims: rerankDimsOf(pricing),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  expect(appended).toBe(1);
  const after = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "rerank",
  });
  return after!.snapshotVersion;
}

/**
 * The admission request, as the rerank entry carries it for one wire request. The dims
 * are the ones THE named snapshot version carries — the entry prices the basis it locks,
 * so the v1 world refuses on v1's own dims and the v2 world admits on v2's.
 */
function admissionInput(
  world: RerankWorld,
  snapshotVersion: number,
  pricing: Record<string, string>,
) {
  return {
    request: { ...RERANK_REQUEST, model: world.model },
    grantId: world.grantId,
    payer: { kind: "personal" as const, id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "rerank" as const,
    },
    snapshotVersion,
    rateVersion: 0,
    dims: rerankDimsOf(pricing),
    rate: { numerator: 100n, denominator: 1n },
    idempotencyKey: `${prefix}-idem-${snapshotVersion}`,
  };
}

/** The account-side "the refusal never reached the provider": nothing held, nothing owed. */
async function expectUntouchedAccount(customerKey: string) {
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.externalCustomerId, customerKey)),
  ).toHaveLength(0);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, customerKey)),
  ).toHaveLength(0);
}

test("a rerank cell missing its billed dimensions refuses at the entry, naming the dimension", async () => {
  const world = await seedRerankWorld();
  const v1 = await appendSnapshot(world, RERANK_V1_PRICING);
  const callsBefore = reserveCalls;

  const outcome = await admission.admit(admissionInput(world, v1, RERANK_V1_PRICING));

  // The entry's own refusal: 11.3's verdict verbatim — the FIRST missing billed
  // dimension (input, closed precedence) with its per-dimension reason, so an
  // administrator prices exactly that. No reserve call was made at all.
  expect(outcome).toEqual({
    status: "refused",
    stage: "enablement",
    reasonCode: "rerank_price_unknown",
    detail: { dimension: "input", reason: "price_dim_no_source" },
  });
  expect(reserveCalls).toBe(callsBefore);
  await expectUntouchedAccount(world.customerKey);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    10_000,
  );

  // And the general door agrees on its own: the same basis refused at the reserve
  // boundary too (03.3's classification carrying the missing-dimension list) — a
  // caller that bypassed the entry still cannot form the dispatch commitment.
  const door = await rawReserve({
    grantId: world.grantId,
    payer: { kind: "personal", id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "rerank",
    },
    snapshotVersion: v1,
    rateVersion: 0,
    boundEvidence: [{ kind: "self_enforced_input_refusal", maximumTokens: 60_000 }],
    maximumCredits: 500,
    idempotencyKey: `${prefix}-door-${v1}`,
  });
  expect(door).toMatchObject({
    status: "refused",
    reasonCode: "price_unknown",
    detail: {
      missingDimensions: expect.arrayContaining([
        { dimension: "input", reason: "price_dim_no_source" },
      ]),
    },
  });
  await expectUntouchedAccount(world.customerKey);
});

test("the same request admits once the price basis completes", async () => {
  const world = await seedRerankWorld();
  await appendSnapshot(world, RERANK_V1_PRICING); // v1: the refused world above
  const v2 = await appendSnapshot(world, RERANK_COMPLETE_PRICING);

  const outcome = await admission.admit(admissionInput(world, v2, RERANK_COMPLETE_PRICING));

  expect(outcome.status).toBe("admitted");
  if (outcome.status !== "admitted") return;
  expect(outcome.snapshotVersion).toBe(v2);
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, outcome.reservationId));
  expect(reservation.status).toBe("reserved");
  // The hold is the ceiling the entry certified — counted tokens × input price +
  // documents × flat price, 足额: it covers the exact worst case and never rounds below.
  expect(outcome.maximumCredits).toBe(reservation.maximum);
  expect(outcome.maximumCredits).toBeGreaterThanOrEqual(
    Math.ceil(
      (outcome.inputTokens * 0.00000002 + RERANK_REQUEST.documents.length * 0.0001) *
        100 *
        100,
    ),
  );
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    10_000 - reservation.maximum,
  );
});

test("an uncountable shape refuses before any price is consulted", async () => {
  const world = await seedRerankWorld();
  const v2 = await appendSnapshot(world, RERANK_COMPLETE_PRICING);
  const callsBefore = reserveCalls;

  const outcome = await admission.admit({
    ...admissionInput(world, v2, RERANK_COMPLETE_PRICING),
    request: { model: world.model, query: "a query with no documents" },
  });

  expect(outcome).toEqual({
    status: "refused",
    stage: "enablement",
    reasonCode: "rerank_input_uncountable",
    detail: { shape: "documents_not_array" },
  });
  expect(reserveCalls).toBe(callsBefore);
  await expectUntouchedAccount(world.customerKey);

  // The precedence the verdict itself carries: an uncountable input never reaches the
  // price table — even on the v1 basis (every dimension missing) the shape answers first.
  const v1World = await seedRerankWorld();
  const v1 = await appendSnapshot(v1World, RERANK_V1_PRICING);
  const shapeFirst = await admission.admit({
    ...admissionInput(v1World, v1, RERANK_V1_PRICING),
    request: { model: v1World.model, query: 42, documents: ["a document"] },
  });
  expect(shapeFirst).toMatchObject({
    status: "refused",
    reasonCode: "rerank_input_uncountable",
    detail: { shape: "query_not_string" },
  });
});

test("an enabled verdict over an empty account still dispatches nothing", async () => {
  // The basis is complete, the shape counts — but the account holds less than the
  // ceiling. The reserve door refuses insufficient_credits, and the entry passes the
  // refusal through: no hold, no ledger, the provider was never sent anything.
  const world = await seedRerankWorld(3);
  const v2 = await appendSnapshot(world, RERANK_COMPLETE_PRICING);

  const outcome = await admission.admit(admissionInput(world, v2, RERANK_COMPLETE_PRICING));

  expect(outcome).toMatchObject({
    status: "refused",
    stage: "reserve",
    reasonCode: "insufficient_credits",
  });
  await expectUntouchedAccount(world.customerKey);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(3);
});

afterAll(async () => {
  await database
    .delete(creditReservations)
    .where(
      like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
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
  await database.$client.close();
});
