import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createSpeechSettlementService } from "../src/billing/speech-settlement";
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
  creditSpeechSettlementDetails,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #307 (13.2): the speech settlement, on a real PostgreSQL — the actual seconds
 * the result evidences (never the cap, never an estimate), priced at the tier the hold
 * locked, with the unsynthesized share handed back and the user's consumption detail
 * showing the speech line.
 *
 * THE FIXTURE WORLDS stand where 13.1's boundary put them: a speech cell whose
 * `audio_output` is KNOWN is a basis that prices every output second uniformly — the
 * vocabulary's own per-second slot — and the tier the admission certified carries both
 * sides (the per-character price has no vocabulary slot; 13.1's own unit-honesty). The
 * settlement corroborates the tier's per-second side against the LOCK before pricing, so
 * a tier nobody locked is refused, and a hold locked at v1 prices at v1 after v2 lands.
 *
 * What each scenario proves, in the ACs' own words: 结算金额按实际字符与音频时长计算，
 * 未使用部分释放 (cap 60 over actual 25 settles 25 — exactly, including the fractional
 * 25.5 case); 实际用量来源可验证 (provider usage and artifact metadata both, and no
 * evidence at all settles nothing); 重复上报同一结果只结算一次 (the replay answers the
 * first settlement); 用户明细显示语音时长/字符与金额 (the consumption entry carries the
 * speech line).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b9-307-${randomUUID().slice(0, 8)}`;
const writer = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const settleSpeech = createSpeechSettlementService({
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

type SpeechWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
  seedCredits: number;
};

/**
 * The dims of one priced speech cell: every wire dimension complete (03.2's own v1
 * mapping) with the reserved dimensions overlaid — `audio_output` known at
 * `perSecondUsd` (the per-second slot the settlement corroborates against), the other
 * reserved slots priced at "0" (free is a price), because the exact conversion prices
 * every dimension it is handed.
 */
function speechDimsOf(perSecondUsd: string): PriceSnapshotDims {
  const mapped = mapPriceDims({ pricing: COMPLETE_WIRE_PRICING });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_output"
        ? { status: "known", amount: perSecondUsd }
        : dimension === "audio_input" ||
            dimension === "video" ||
            dimension === "image_output" ||
            dimension === "surcharge_tool_call" ||
            dimension === "surcharge_a2a_call"
          ? { status: "known", amount: "0" }
          : mapped[dimension],
    ]),
  ) as PriceSnapshotDims;
}

/**
 * One speech world: a funded personal account and a speech cell whose snapshot prices
 * every wire dimension AND carries `audio_output` at `perSecondUsd` — the uniform
 * per-second price the locked tier's seconds side corroborates against.
 */
async function seedSpeechWorld(
  perSecondUsd: string,
  seedCredits = 100_000,
): Promise<SpeechWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `tts-b9-${n}`;

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
      ref: { provider, model, capability: "speech" },
      dims: speechDimsOf(perSecondUsd),
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

/**
 * The spec 13.1 certifies and every hold below freezes WITH its pricing lock — the
 * quantities the settle surface must re-carry exactly (13.2's two-side check): the
 * characters in, the tier, the duration cap, and both locked tier prices.
 */
const FROZEN_SPEC = {
  inputCharacters: 100,
  voiceTier: null as string | null,
  durationCapSeconds: 60,
  perInputCharacterUsd: "0.000015",
  perOutputSecondUsd: "0.0005",
};

/** One held speech reservation locked at the cell's current snapshot version. */
async function holdFor(
  world: SpeechWorld,
  maximumCents: number,
  spec: Partial<typeof FROZEN_SPEC> = {},
): Promise<string> {
  const frozen = { ...FROZEN_SPEC, ...spec };
  const snapshot = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "speech",
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
      capability: "speech",
      snapshotVersion: snapshot!.snapshotVersion,
      rateVersion: 0,
    },
    speechSpec: frozen,
  });
  expect(reserved.reserved).toBe(true);
  return reserved.reserved ? reserved.reservationId : "";
}

test("cap 60 over an actual 25 seconds settles 25 and hands the rest back", async () => {
  const world = await seedSpeechWorld("0.0005"); // $0.0005 per output second
  // 13.1's own ceiling for this world: 100 chars × $0.000015 + 60 s × $0.0005 = $0.0315
  // → 315 scaled units at the fixture rate.
  const reservationId = await holdFor(world, 315, { voiceTier: "alloy" });

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: "alloy", durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-a" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-a`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // 100 × 0.000015 + 25 × 0.0005 = $0.014 → 140 scaled units (×100 credits/USD ×100
  // ledger scale). The unsynthesized 35 seconds hand back: 315 − 140 = 175.
  expect(outcome.actualCost).toEqual({ numerator: "140", denominator: "1" });
  expect(outcome.chargedCredits).toBe(140);
  expect(outcome.releasedCredits).toBe(175);
  expect(outcome.line).toEqual({
    inputCharacters: 100,
    voiceTier: "alloy",
    cappedSeconds: 60,
    actualSeconds: "25",
    perInputCharacterUsd: "0.000015",
    perOutputSecondUsd: "0.0005",
  });

  // The money and the line landed together: one ledger row, one speech detail row keyed
  // by the reservation, and the account is down by exactly the spoken cost.
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.customerKey));
  expect(ledgerRows).toHaveLength(1);
  expect(ledgerRows[0].credits).toBe(140);
  expect(ledgerRows[0].requestId).toBe("tts-307-a");
  const [detail] = await database
    .select()
    .from(creditSpeechSettlementDetails)
    .where(eq(creditSpeechSettlementDetails.reservationId, reservationId));
  expect(detail).toBeDefined();
  expect(detail.ledgerId).toBe(ledgerRows[0].id);
  expect(detail.capability).toBe("speech");
  expect(detail.inputCharacters).toBe(100);
  expect(detail.cappedSeconds).toBe(60);
  expect(detail.actualSeconds).toBe("25");
  expect(detail.voiceTier).toBe("alloy");
  expect(await writer.availableBalance(world.customerKey)).toBe(
    world.seedCredits - 140,
  );

  // A replay of the same result answers the first settlement, not a second charge.
  const replay = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: "alloy", durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-a" },
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

test("fractional seconds price exactly — artifact metadata is a verifiable source", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25.5",
      evidence: { kind: "artifact_metadata" }, // the audio container's own statement
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-frac`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // 100 × 0.000015 + 25.5 × 0.0005 = $0.01425 → 142.5 scaled units — exactly 285/2 in
  // lowest terms, no float anywhere in the chain. The writer charges the whole units
  // (142) and CARRIES the 0.5 to the customer's remainder — the fraction is never lost
  // and never rounded into a bill, which is 06.9's own money semantics.
  expect(outcome.actualCost).toEqual({ numerator: "285", denominator: "2" });
  expect(outcome.chargedCredits).toBe(142);
  expect(outcome.remainder).toEqual({ numerator: "1", denominator: "2" });
  expect(outcome.line.actualSeconds).toBe("25.5");
});

test("the per-request surcharge rides the locked dims into the charge", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 325, { voiceTier: "alloy" });

  // This world's wire prices the flat request side at $0 (free is a price): the
  // settlement prices the surcharge from the LOCK — the wire's own field, never anything
  // the settle request carries — so the charge is the two-sided cost alone.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: "alloy", durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-sur`,
  });
  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.actualCost.numerator).toBe("140"); // surcharge is $0 on this wire
});

test("the user's consumption detail shows the speech characters, seconds and amount", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315, { voiceTier: "alloy" });
  await database.insert(botServices).values({
    botId: `${prefix}-bot-cv`,
    displayName: "Speech settle view Bot",
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

  const settled = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: "alloy", durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report" },
    },
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
  expect(entry.credits).toBe(1.4); // $0.014 × 100 credits/USD = 1.40 whole credits
  expect(entry.lineDetail).toEqual({
    capability: "speech",
    speech: {
      inputCharacters: 100,
      voiceTier: "alloy",
      cappedSeconds: 60,
      actualSeconds: "25",
    },
  });
});

test("a hold locked at v1 prices at v1 even after v2 lands", async () => {
  const world = await seedSpeechWorld("0.0005");
  const v1Hold = await holdFor(world, 315); // locked at snapshot version 1

  // The per-second price moves: version 2 prices the same cell's seconds at $0.0008.
  const { appended } = await snapshotStore.appendSnapshots([
    {
      ref: { provider: world.provider, model: world.model, capability: "speech" },
      dims: speechDimsOf("0.0008"),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  expect(appended).toBe(1);

  const v1Outcome = await settleSpeech.settle({
    reservationId: v1Hold,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-v1`,
  });
  expect(v1Outcome.status).toBe("settled");
  if (v1Outcome.status !== "settled") return;
  expect(v1Outcome.actualCost).toEqual({ numerator: "140", denominator: "1" });
  expect(v1Outcome.line.perOutputSecondUsd).toBe("0.0005");
});

test("a tier the lock cannot corroborate is refused, never priced", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    // A tampered settle surface carrying a cheaper per-second price than the lock holds.
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0001" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-tamper`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "price_basis_not_found",
    detail: { stage: "tier_not_corroborated" },
  });
  // Nothing moved: no ledger row, no line, the hold still reserved.
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("an actual beyond the certified cap is a defect, never a bill", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "61",
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-beyond`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
    detail: {
      field: "result.actualSeconds",
      reason: "actual_exceeds_certified_spec",
    },
  });
});

test("no evidence anyone may bill from keeps the hold occupied as unknown", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: { outcome: "unknown", reason: "stream cut before the audio payload" },
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
  // nothing settled: no ledger row, no line, no release. The characters are never an
  // estimate of the duration — that substitution is the forbidden shortcut, not a bill.
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("a settle whose characters are not the frozen spec's is refused, never adopted", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  // The settle surface re-carries 120 characters where the hold froze 100: not the work
  // the hold was certified against, so not a bill — and never a rewrite to the caller's
  // number. Same two-side semantics the per-second price already had.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 120, voiceTier: null, durationCapSeconds: 60 },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-chars" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-spec-chars`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "price_basis_not_found",
    detail: { stage: "spec_not_corroborated" },
  });
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("a character price the hold did not freeze is refused, never adopted", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: { inputCharacters: 100, voiceTier: null, durationCapSeconds: 60 },
    // A tampered settle surface carrying a dearer per-character price than the frozen spec.
    priced: { perInputCharacterUsd: "0.00002", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-price" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-spec-price`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "price_basis_not_found",
    detail: { stage: "spec_not_corroborated" },
  });
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

afterAll(async () => {
  // The line details key on reservation ids (cr-…), not the prefix: remove them through
  // the customer's own reservations, before those reservations go.
  await database.execute(
    sql`DELETE FROM credit_speech_settlement_details WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`})`,
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
