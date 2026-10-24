import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createImageSettlementService } from "../src/billing/image-settlement";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCredits } from "../src/billing/credits";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  PRICE_DIMENSIONS,
  mapPriceDims,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { createEnterpriseGatewayPriceSnapshotStore } from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  payerAccounts,
} from "../src/db/schema";
import {
  creditReservations,
  creditSettlementDetails,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #303 (12.2): the image-generation settlement, on a real PostgreSQL — the actual
 * the provider reported, priced at the version the hold locked, with the ungenerated share
 * of the hold handed back and the user's consumption detail showing the image line.
 *
 * THE FIXTURE WORLDS stand where 12.1's boundary put them: a snapshot whose `image_output`
 * is KNOWN is a basis that prices every generated image uniformly (the wildcard tier row —
 * the one source a snapshot can carry until the wire grows per-tier fields), and a pure v1
 * snapshot (no generated-image field) leaves the tier table empty, which the settlement
 * refuses as price_unknown — the honest answer, never the input-image price or an estimate.
 * Reservations are seeded through the credit writer with the LOCKED basis an image
 * admission would persist (the gateway's image dispatch evidence is 12.1's own module;
 * the settlement's contract here is the lock, the actual, and the line).
 *
 * What each scenario proves, in the ACs' own words: 结算金额按实际生成张数与规格计算
 * (3 of 4 settles 3); 未生成部分不被收费 (the fourth's share releases); 结算使用预留时
 * 锁定的价格版本 (a v2 price mid-flight bills at the hold's v1); 用户明细显示图像规格、
 * 数量与金额 (the consumption entry carries the line); 无证据的结果进入 unknown (the hold
 * keeps its full capacity occupied for recovery, per 06.8).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b8-303-${randomUUID().slice(0, 8)}`;
const writer = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const settleImage = createImageSettlementService({
  database,
  environmentRate: { numerator: 100n, denominator: 1n } satisfies ConversionRate,
});

let seedCounter = 0;

/** The wire-priced dims every world carries complete, so classification never blocks. */
const COMPLETE_WIRE_PRICING = {
  prompt: "0",
  completion: "0",
  internal_reasoning: "0",
  image: "0.005",
  input_cache_read: "0",
  input_cache_write: "0",
  web_search: "0",
  request: "0",
} as const;

type ImageWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
  seedCredits: number;
};

/**
 * The dims of one priced cell, built the way a source that CAN price the generated image
 * would record them: every wire dimension complete (03.2's own v1 mapping over a complete
 * pricing object) with the reserved dimensions overlaid — `image_output` known at
 * `imageOutputUsd` (or left as the v1 mapping's unknown, the no-price scenario), and the
 * audio/video slots a complete basis prices at "0" (free is a price), because 06.5's
 * conversion prices every dimension of the vocabulary and refuses any unknown one.
 * (`mapPriceDims` alone can never produce a known `image_output` — the v1 wire has no
 * field for it.)
 */
function imageDimsOf(imageOutputUsd: string | null): PriceSnapshotDims {
  const mapped = mapPriceDims({ pricing: COMPLETE_WIRE_PRICING });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "image_output"
        ? imageOutputUsd === null
          ? mapped[dimension]
          : { status: "known", amount: imageOutputUsd }
        : dimension === "audio_input" ||
            dimension === "audio_output" ||
            dimension === "video" ||
            dimension === "video_input" ||
            dimension === "surcharge_tool_call" ||
            dimension === "surcharge_a2a_call"
          ? { status: "known", amount: "0" }
          : mapped[dimension],
    ]),
  ) as PriceSnapshotDims;
}

/**
 * One image world: a funded personal account and an image cell whose v1 snapshot prices
 * every wire dimension AND carries `image_output` at `imageOutputUsd` — the uniform
 * per-generated-image price the wildcard tier row reads (null keeps it unknown: the pure
 * v1 shape, an unpriced generated image).
 */
async function seedImageWorld(
  imageOutputUsd: string | null,
  seedCredits = 100_000,
): Promise<ImageWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `image-b8-${n}`;

  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await writer.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: seedCredits,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  const { appended } = await snapshotStore.appendSnapshots([
    {
      ref: { provider, model, capability: "image" },
      dims: imageDimsOf(imageOutputUsd),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  expect(appended).toBe(1);

  return {
    userId,
    customerKey: payerKey({ kind: "personal", id: userId }),
    provider,
    model,
    seedCredits,
  };
}

/** One held image reservation locked at the cell's current snapshot version. */
async function holdFor(
  world: ImageWorld,
  maximumCents: number,
): Promise<string> {
  const snapshot = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "image",
  });
  expect(snapshot).toBeDefined();
  const reserved = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-hold-${world.model}-${randomUUID().slice(0, 8)}`,
    maximumCents,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    lockedBasis: {
      provider: world.provider,
      model: world.model,
      capability: "image",
      snapshotVersion: snapshot!.snapshotVersion,
      rateVersion: 0,
    },
  });
  expect(reserved.reserved).toBe(true);
  return reserved.reserved ? reserved.reservationId : "";
}

test("3 of 4 requested settles the 3 that came back and hands the fourth's share back", async () => {
  const world = await seedImageWorld("0.04"); // $0.04 per generated image
  const reservationId = await holdFor(world, 1600); // 4 × $0.04 × 100 × 100 = 1600

  const outcome = await settleImage.settle({
    reservationId,
    requested: {
      count: 4,
      size: "1024x1024",
      quality: "standard",
      inputImages: 0,
    },
    result: {
      outcome: "generated",
      count: 3,
      evidence: { kind: "provider_usage_report", reference: "gen-303-a" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-a`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // The exact cost of three images: 3 × 0.04 USD × 100 credits/USD × 100 scale = 1200.
  expect(outcome.actualCost).toEqual({ numerator: "1200", denominator: "1" });
  expect(outcome.chargedCredits).toBe(1200);
  expect(outcome.releasedCredits).toBe(1600 - 1200);
  expect(outcome.line).toEqual({
    size: "1024x1024",
    quality: "standard",
    requestedCount: 4,
    generatedCount: 3,
    unitPriceUsd: "0.04",
  });

  // The money and the line landed together: one ledger row, one detail row keyed by the
  // reservation, and the account is back down by exactly the three images' cost.
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.customerKey));
  expect(ledgerRows).toHaveLength(1);
  expect(ledgerRows[0].credits).toBe(1200);
  expect(ledgerRows[0].requestId).toBe("gen-303-a");
  const [detail] = await database
    .select()
    .from(creditSettlementDetails)
    .where(eq(creditSettlementDetails.reservationId, reservationId));
  expect(detail).toBeDefined();
  expect(detail.ledgerId).toBe(ledgerRows[0].id);
  expect(detail.capability).toBe("image");
  expect(detail.requestedCount).toBe(4);
  expect(detail.generatedCount).toBe(3);
  expect(detail.size).toBe("1024x1024");
  expect(detail.quality).toBe("standard");
  expect(detail.unitPriceUsd).toBe("0.04");
  expect(await writer.availableBalance(world.customerKey)).toBe(
    world.seedCredits - 1200,
  );

  // A replay of the same result answers the first settlement, not a second charge.
  const replay = await settleImage.settle({
    reservationId,
    requested: {
      count: 4,
      size: "1024x1024",
      quality: "standard",
      inputImages: 0,
    },
    result: {
      outcome: "generated",
      count: 3,
      evidence: { kind: "provider_usage_report", reference: "gen-303-a" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-a-replay`,
  });
  expect(replay.status).toBe("settled");
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(1);
});

test("the user's consumption detail shows the image spec, count and amount", async () => {
  const world = await seedImageWorld("0.04");
  const reservationId = await holdFor(world, 800);
  await database.insert(botServices).values({
    botId: `${prefix}-bot-cv`,
    displayName: "Image settle view Bot",
    kind: "external",
    capabilities: ["chat"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId: `${prefix}-grant-cv`,
    userId: world.userId,
    botId: `${prefix}-bot-cv`,
    externalIdentity: `${prefix}:ext:cv`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });

  const settled = await settleImage.settle({
    reservationId,
    requested: {
      count: 2,
      size: "1024x1792",
      quality: "hd",
      inputImages: 0,
    },
    result: { outcome: "generated", count: 2, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-cv`,
  });
  expect(settled.status).toBe("settled");

  const view = await createCredits({
    database,
    externalCustomerKey: world.customerKey,
    catalog: new Map(),
  }).consumption({ from: null, to: null, page: 1 });
  expect(view.entries).toHaveLength(1);
  const entry = view.entries[0];
  expect(entry.credits).toBe(8); // 2 × $0.04 × 100 credits/USD = 8.00 whole credits
  expect(entry.lineDetail).toEqual({
    capability: "image",
    image: {
      size: "1024x1792",
      quality: "hd",
      requestedCount: 2,
      generatedCount: 2,
    },
  });
});

test("a hold locked at v1 prices at v1 even after v2 lands; a v2 hold prices at v2", async () => {
  const world = await seedImageWorld("0.04");
  const v1Hold = await holdFor(world, 400); // locked at snapshot version 1

  // The price moves: version 2 prices the same cell's generated images at $0.08.
  const { appended } = await snapshotStore.appendSnapshots([
    {
      ref: { provider: world.provider, model: world.model, capability: "image" },
      dims: imageDimsOf("0.08"),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  expect(appended).toBe(1);
  const v2Hold = await holdFor(world, 800); // locked at version 2

  const v1Outcome = await settleImage.settle({
    reservationId: v1Hold,
    requested: { count: 1, size: null, quality: null, inputImages: 0 },
    result: { outcome: "generated", count: 1, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-v1`,
  });
  const v2Outcome = await settleImage.settle({
    reservationId: v2Hold,
    requested: { count: 1, size: null, quality: null, inputImages: 0 },
    result: { outcome: "generated", count: 1, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-v2`,
  });
  expect(v1Outcome.status).toBe("settled");
  expect(v2Outcome.status).toBe("settled");
  if (v1Outcome.status !== "settled" || v2Outcome.status !== "settled") return;
  expect(v1Outcome.actualCost).toEqual({ numerator: "400", denominator: "1" });
  expect(v1Outcome.line.unitPriceUsd).toBe("0.04");
  expect(v2Outcome.actualCost).toEqual({ numerator: "800", denominator: "1" });
  expect(v2Outcome.line.unitPriceUsd).toBe("0.08");
});

test("a result nobody can read settles nothing and keeps the hold occupied as unknown", async () => {
  const world = await seedImageWorld("0.04");
  const reservationId = await holdFor(world, 400);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await settleImage.settle({
    reservationId,
    requested: { count: 1, size: null, quality: null, inputImages: 0 },
    result: { outcome: "unknown", reason: "stream cut before the image payload" },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-unk`,
  });

  expect(outcome).toEqual({ status: "unknown", reservationId });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  // Full capacity still occupied (06.8: an unconfirmed result is not a zero cost), and
  // nothing settled: no ledger row, no line, no release.
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("a pure v1 basis (no generated-image price) refuses the settlement as price_unknown", async () => {
  const world = await seedImageWorld(null); // image_output unknown: the v1 wire shape
  const reservationId = await holdFor(world, 400);

  const outcome = await settleImage.settle({
    reservationId,
    requested: { count: 1, size: null, quality: null, inputImages: 0 },
    result: { outcome: "generated", count: 1, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-noprice`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "price_unknown",
    detail: { dimension: "image_output", reason: "price_dim_no_source" },
  });
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("input images ride the input-image dimension; a report beyond the spec is a defect", async () => {
  const world = await seedImageWorld("0.02"); // $0.02 per generated image
  const reservationId = await holdFor(world, 900); // 1×0.02 + 2×0.005 → 300; hold generous

  const settled = await settleImage.settle({
    reservationId,
    requested: { count: 1, size: null, quality: null, inputImages: 2 },
    result: { outcome: "generated", count: 1, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-edit`,
  });
  expect(settled.status).toBe("settled");
  if (settled.status !== "settled") return;
  // 1 × $0.02 (generated) + 2 × $0.005 (input images) = $0.03 → 300 scaled units.
  expect(settled.actualCost).toEqual({ numerator: "300", denominator: "1" });

  // A provider reporting more images than the spec certified is a defect, never a bill:
  const defect = await settleImage.settle({
    reservationId: `${reservationId}-none`,
    requested: { count: 1, size: null, quality: null, inputImages: 0 },
    result: { outcome: "generated", count: 5, evidence: { kind: "provider_usage_report" } },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-defect`,
  });
  expect(defect).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
    detail: { field: "result.count", reason: "actual_exceeds_certified_spec" },
  });
});

afterAll(async () => {
  // The line details key on reservation ids (cr-…), not the prefix: remove them through
  // the customer's own reservations, before those reservations go.
  await database.execute(
    sql`DELETE FROM credit_settlement_details WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`})`,
  );
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
  await database.$client.close();
});
