import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  mapPriceDims,
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
 * Bifrost #297 (11.2): the embedding refusal path, the OpenBot half. The full chain the
 * gateway's admission walks for an embeddings dispatch lands here as the wire question the
 * door answers: an embedding cell whose snapshot dims do not price completely refuses with
 * the price-unknown code whose detail IS 03.3's classification (the status, the reason, the
 * missing dimensions), holding nothing; the SAME request against a completed basis
 * reserves. The evidence kind the embeddings call attests — the counted-in-full input
 * bound, refused over the ceiling, never truncated (a batch's entries are the payload) —
 * joins the closed bound-evidence vocabulary here, and estimates stay outside it.
 *
 * THE OTHER HALF lives in the bifrost submodule (plugins/governance/embeddingrefusal_test.go,
 * `go test -run EmbeddingRefusal ./...`): the pipeline's own gates — the vector output
 * needing no cap record, the input counted in full, the refusal before any provider is
 * reached. The two suites meet at the wire contract: this file proves what the ACCOUNT must
 * hold — no hold and no ledger row for a refused request, which is the SQL side of
 * "供应商调用数为 0" — and that the refusal's reason is the classification's own answer.
 *
 * Isolation mirrors #275's recipe (e2e-strict-billing-text): every scenario seeds its own
 * bot/grant/provider prefixes, and the fixtures are deleted by the DERIVED account-key
 * prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b8-297-${randomUUID().slice(0, 8)}`;
const fixtureCreditWriter = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

let seedCounter = 0;

/**
 * The v1-wire pricing an embedding model actually carries: the per-input-token price and
 * the flat per-request surcharge — and nothing else. `mapPriceDims` (03.2) turns this into
 * the dims the door reads: input and surcharge known, every other wire-priced dimension
 * unknown for having no source, which is exactly the embedding snapshot of today.
 */
const EMBEDDING_V1_PRICING = {
  prompt: "0.00000002",
  request: "0.0001",
} as const;

/** Every wire-priced dimension priced — the basis a completed v2 carries; `completion` at "0" is a price. */
const COMPLETE_PRICING = {
  prompt: "0.00000002",
  completion: "0",
  internal_reasoning: "0",
  image: "0",
  input_cache_read: "0",
  input_cache_write: "0",
  web_search: "0",
  request: "0.0001",
} as const;

type EmbeddingWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
  grantId: string;
};

/** One embeddings world: a Bot, its grant, a funded personal account, an OPEN embedding cell. */
async function seedEmbeddingWorld(): Promise<EmbeddingWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `text-embedding-b8-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Embedding refusal Bot ${n}`,
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
    totalCents: 10_000,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "embedding",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "embedding",
    state: "open",
    reason: "embedding-refusal fixture",
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

/** Append one snapshot version for the world's cell from a raw upstream pricing object. */
async function appendSnapshot(
  world: EmbeddingWorld,
  pricing: Record<string, string>,
): Promise<number> {
  const dims = mapPriceDims({ pricing });
  const before = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "embedding",
  });
  const { appended } = await snapshotStore.appendSnapshots([
    {
      ref: {
        provider: world.provider,
        model: world.model,
        capability: "embedding",
      },
      dims,
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
    capability: "embedding",
  });
  expect(after?.snapshotVersion).toBe((before?.snapshotVersion ?? 0) + 1);
  return after!.snapshotVersion;
}

/** The reserve request an embeddings dispatch sends: the refusal-kind input bound, no cap. */
function embeddingReserveRequest(
  world: EmbeddingWorld,
  snapshotVersion: number,
  extra: Partial<{
    boundEvidence: { kind: string; maximumTokens: number }[];
    idempotencyKey: string;
  }> = {},
) {
  return {
    grantId: world.grantId,
    payer: { kind: "personal", id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "embedding",
    },
    snapshotVersion,
    rateVersion: 0,
    boundEvidence: extra.boundEvidence ?? [
      { kind: "self_enforced_input_refusal", maximumTokens: 60_000 },
    ],
    maximumCredits: 500,
    idempotencyKey: extra.idempotencyKey ?? `${prefix}-idem-${snapshotVersion}`,
  };
}

/** The account-side "provider was never called": no hold, no charge, nothing dangling. */
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
  expect(await fixtureCreditWriter.availableBalance(customerKey)).toBe(10_000);
}

test("an embedding cell whose dims do not price completely refuses with the classification's own reason", async () => {
  const world = await seedEmbeddingWorld();
  // The v1 wire reality: the embedding entry prices input and the surcharge, nothing else —
  // 03.2 records every other wire-priced dimension unknown, and 03.3 classifies the cell
  // unknown. That classification, verbatim, is what the refusal must carry.
  const v1 = await appendSnapshot(world, EMBEDDING_V1_PRICING);

  const outcome = await reserveService.reserve(
    embeddingReserveRequest(world, v1),
  );

  expect(outcome).toEqual({
    status: "refused",
    reasonCode: "price_unknown",
    detail: {
      priceStatus: "unknown",
      priceReasonCode: "price_status_dims_missing",
      missingDimensions: expect.arrayContaining([
        { dimension: "output", reason: "price_dim_no_source" },
      ]),
      snapshotVersion: v1,
    },
  });
  await expectUntouchedAccount(world.customerKey);
});

test("the same request reserves once the price basis completes", async () => {
  const world = await seedEmbeddingWorld();
  await appendSnapshot(world, EMBEDDING_V1_PRICING); // v1: unknown — the world above
  const v2 = await appendSnapshot(world, COMPLETE_PRICING); // v2: every wire dim priced

  const outcome = await reserveService.reserve(
    embeddingReserveRequest(world, v2, { idempotencyKey: `${prefix}-idem-v2` }),
  );

  expect(outcome.status).toBe("reserved");
  if (outcome.status !== "reserved") return;
  expect(outcome.snapshotVersion).toBe(v2);
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, outcome.reservationId));
  expect(reservation.status).toBe("reserved");
  expect(reservation.maximum).toBe(500);
  // The hold persists the basis it was admitted against (06.5), and the available balance
  // carries it: the refusal world above held nothing, this one holds what it admitted.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    10_000 - 500,
  );
});

test("the embeddings input bound is a closed evidence kind, and estimates still are not evidence", async () => {
  const world = await seedEmbeddingWorld();
  const v2 = await appendSnapshot(world, COMPLETE_PRICING);

  // The refusal-kind bound is a mechanism the vocabulary carries (the reserved world above
  // proves it); an estimate-shaped entry proves nothing and refuses as such — the
  // discipline that admits the embeddings kind is the same one that keeps estimates out.
  const estimate = await reserveService.reserve(
    embeddingReserveRequest(world, v2, {
      boundEvidence: [
        { kind: "conservative_token_estimate", maximumTokens: 60_000 },
      ],
      idempotencyKey: `${prefix}-idem-estimate`,
    }),
  );
  expect(estimate).toMatchObject({
    status: "refused",
    reasonCode: "bound_evidence_not_enforceable",
  });
  await expectUntouchedAccount(world.customerKey);
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
