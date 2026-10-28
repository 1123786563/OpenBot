import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { createCredits } from "../src/billing/credits";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "../src/billing/credits-writer";
import type { SpeechGenerationResult } from "../src/billing/speech-settlement";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createSpeechSettlementService } from "../src/billing/speech-settlement";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, payerAccounts } from "../src/db/schema";
import {
  creditReservations,
  creditSpeechSettlementDetails,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  mapPriceDims,
  PRICE_DIMENSIONS,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
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
  environmentRate: {
    numerator: 100n,
    denominator: 1n,
  } satisfies ConversionRate,
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

/**
 * A minimal WAV container header whose own metadata states `seconds` — the `fmt ` byte
 * rate against the `data` size, the same two integers parseWavDurationSeconds reads. The
 * audio payload itself is not carried: the header's size word IS the artifact's statement.
 * `dataSizeOverride` pins the payload size word when the seconds string alone would round
 * to a different byte count (a non-terminating duration's own decimal, for one).
 */
function wavMetadataBase64(
  seconds: string,
  byteRate = 8000,
  dataSizeOverride?: number,
): string {
  const [whole, fraction = ""] = seconds.split(".");
  const dataSize =
    dataSizeOverride ??
    Number(whole) * byteRate +
      (fraction ? Math.round(Number(`0.${fraction}`) * byteRate) : 0);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1)
      header[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // the fmt chunk's own size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, byteRate, true); // sample rate
  view.setUint32(28, byteRate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return Buffer.from(header).toString("base64");
}

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
    requested: {
      inputCharacters: 100,
      voiceTier: "alloy",
      durationCapSeconds: 60,
    },
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
    requested: {
      inputCharacters: 100,
      voiceTier: "alloy",
      durationCapSeconds: 60,
    },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25.5",
      // The audio container's own statement, carried for the server to re-measure; the
      // reference names the server-side collection record the headers came from.
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-frac-artifact",
        metadata: {
          container: "wav",
          bytesBase64: [wavMetadataBase64("25.5")],
        },
      },
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
    requested: {
      inputCharacters: 100,
      voiceTier: "alloy",
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-sur" },
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
    requested: {
      inputCharacters: 100,
      voiceTier: "alloy",
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-cv" },
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
    kind: "speech",
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
      ref: {
        provider: world.provider,
        model: world.model,
        capability: "speech",
      },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-v1" },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    // A tampered settle surface carrying a cheaper per-second price than the lock holds.
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0001" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-tamper" },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "61",
      evidence: { kind: "provider_usage_report", reference: "tts-307-beyond" },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "unknown",
      reason: "stream cut before the audio payload",
    },
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
    requested: {
      inputCharacters: 120,
      voiceTier: null,
      durationCapSeconds: 60,
    },
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
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
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

test("a provider usage report without a reference is no evidence anyone may bill from", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  // A usage report nobody can trace is a label, not evidence (AC2): the result claims
  // synthesized, but nothing verifiable stands under it — the hold goes to unknown
  // (06.8), settles nothing, releases nothing. The reference is now REQUIRED by the
  // type; this hostile/legacy wire shape is constructed widened on purpose to pin the
  // runtime's graceful unknown answer instead of a crash.
  const hostileResult = {
    outcome: "synthesized",
    actualSeconds: "25",
    evidence: { kind: "provider_usage_report" },
  } as unknown as SpeechGenerationResult;
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: hostileResult,
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-noref`,
  });

  expect(outcome).toEqual({ status: "unknown", reservationId });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("artifact metadata that disagrees with the reported seconds is a conflict, never a bill", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  // The artifact's own container measures 25.5 seconds; the settle surface claims 30.
  // The measurement wins and the disagreement is a defect: refused as a conflict, no
  // rewrite to the measured number, the hold stays reserved for the real trail.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "30",
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-wav-mismatch",
        metadata: {
          container: "wav",
          bytesBase64: [wavMetadataBase64("25.5")],
        },
      },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-wav-mismatch`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "settlement_conflict",
    detail: { stage: "artifact_duration_mismatch" },
  });
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("artifact metadata that states no readable duration keeps the hold unknown", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-wav-garbage",
        metadata: {
          container: "wav",
          bytesBase64: [
            Buffer.from("certainly not a riff wave container").toString(
              "base64",
            ),
          ],
        },
      },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-wav-garbage`,
  });

  expect(outcome).toEqual({ status: "unknown", reservationId });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
});

test("a non-terminating duration at 44.1kHz is the collector's own 9-digit ceil — honest evidence settles", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  // 4096 bytes over an 88200 B/s byte rate is 0.046439909297052… s — non-terminating, so
  // the interrupted collector reports its documented 9-digit upward rounding, never the
  // exact rational. The settle surface re-measures EXACTLY and accepts that documented
  // ceil; strict double equality here was R1-H1's false settlement_conflict.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "0.04643991",
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-44k1-artifact",
        metadata: {
          container: "wav",
          bytesBase64: [wavMetadataBase64("0.04643991", 88200, 4096)],
        },
      },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-44k1`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.line.actualSeconds).toBe("0.04643991");
  // 100 × $0.000015 + 0.04643991 × $0.0005 = $0.001523219955 → 15.2322 scaled units:
  // the writer charges the whole units (15) and carries the fraction — the fraction is
  // never rounded into a bill.
  expect(outcome.chargedCredits).toBe(15);
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("settled");
});

test("a claim below the measured duration is a conflict in the other direction", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  // The same 88200 B/s header, claimed SHORT of what the container states: the ceil
  // window is one-directional (the reporter's rounding, never a discount).
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "0.04",
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-44k1-short",
        metadata: {
          container: "wav",
          bytesBase64: [wavMetadataBase64("0.04643991", 88200, 4096)],
        },
      },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-44k1-short`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "settlement_conflict",
    detail: { stage: "artifact_duration_mismatch" },
  });
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("a row carrying only a voice tier is refused by the database, not laundered", async () => {
  const world = await seedSpeechWorld("0.0005");
  // A half-broken frozen spec: the tier alone, no certified quantities. The CHECK is
  // all-or-nothing INCLUDING the tier — a tier without its four columns is not a spec,
  // and the database is the one place that can refuse it before any reader sees it.
  // (Drizzle builders are thenable, not native promises, so the rejection is captured
  // through the builder's own rejection handler.)
  const error = await database
    .insert(creditReservations)
    .values({
      id: `${prefix}-half-spec`,
      externalCustomerId: world.customerKey,
      idempotencyKey: `${prefix}-half-spec`,
      maximum: 100,
      expiresAt: new Date(Date.now() + 60_000),
      specVoiceTier: "alloy",
    })
    .then(
      () => null,
      (rejection: unknown) => rejection,
    );
  expect(error).toBeInstanceOf(Error);
  // Drizzle wraps the driver failure: the constraint name rides the cause's message.
  const cause = (error as { cause?: unknown }).cause;
  expect(String((cause as Error | undefined)?.message)).toMatch(
    /credit_reservations_speech_spec_check/,
  );
});

test("self-attested artifact bytes without a server-side reference settle nothing", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  // OCR r2 security: the carried header bytes are the CALLER's — without a reference to
  // the server-side collection record they came from, a fabricated WAV header
  // "re-measures" perfectly and bills whatever it claims. Unknown (06.8), full capacity
  // occupied; the internal collector path carries the reference it minted and is
  // unaffected.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: {
        kind: "artifact_metadata",
        metadata: {
          container: "wav",
          bytesBase64: [wavMetadataBase64("25")],
        },
      },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-self-attested`,
  });

  expect(outcome).toEqual({ status: "unknown", reservationId });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("a null metadata blob is a malformed request, not a server fault", async () => {
  const world = await seedSpeechWorld("0.0005");
  const reservationId = await holdFor(world, 315);

  // OCR r2 bug: `"metadata": null` passed the `!== undefined` guard and crashed the
  // settle on a null property read — an external 500 for what the contract answers as
  // request_invalid.
  const outcome = await settleSpeech.settle({
    reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: {
        kind: "artifact_metadata",
        reference: "tts-307-null-meta",
        metadata: null,
      } as unknown as SpeechGenerationResult,
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-null-meta`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
  });
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("a frozen per-second price the settle surface contradicts is refused", async () => {
  const world = await seedSpeechWorld("0.0005");
  const snapshot = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "speech",
  });
  expect(snapshot).toBeDefined();
  // A direct-writer hold whose frozen per-second price deliberately contradicts the
  // cell's locked dims — the shape of a corrupt admission. The carried price matches the
  // LOCK (so the lock corroboration passes); the frozen spec is the second authority
  // that must refuse it, or the column is dead data pretending to be a check.
  const reserved = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-hold-frozen-second`,
    maximumCents: 315,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    lockedBasis: {
      provider: world.provider,
      model: world.model,
      capability: "speech",
      snapshotVersion: snapshot!.snapshotVersion,
      rateVersion: 0,
    },
    speechSpec: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
      perInputCharacterUsd: "0.000015",
      perOutputSecondUsd: "0.0009",
    },
  });
  expect(reserved.reserved).toBe(true);
  if (!reserved.reserved) return;

  const outcome = await settleSpeech.settle({
    reservationId: reserved.reservationId,
    requested: {
      inputCharacters: 100,
      voiceTier: null,
      durationCapSeconds: 60,
    },
    priced: { perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.0005" },
    result: {
      outcome: "synthesized",
      actualSeconds: "25",
      evidence: { kind: "provider_usage_report", reference: "tts-307-second" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-frozen-second`,
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
      .where(eq(creditReservations.id, reserved.reservationId)),
  ).toMatchObject([{ status: "reserved" }]);
});

test("a spec quantity beyond the int4 column bound is a caller bug, refused at the seam", async () => {
  const world = await seedSpeechWorld("0.0005");
  // OCR r2 bug: 2^31 is a safe integer, so the shape check passed and the INSERT died
  // on the database's integer bound mid-transaction. The seam refuses it first, with
  // the same explicit TypeError the ceiling amount gets.
  await expect(
    writer.reserveCredits({
      externalCustomerId: world.customerKey,
      idempotencyKey: `${prefix}-hold-int4`,
      maximumCents: 315,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      speechSpec: {
        inputCharacters: 2_147_483_648,
        voiceTier: null,
        durationCapSeconds: 60,
        perInputCharacterUsd: "0.000015",
        perOutputSecondUsd: "0.0005",
      },
    }),
  ).rejects.toThrow(TypeError);
});

test("a replayed reserve carrying a different speech spec is a conflict, not a stale hold", async () => {
  const world = await seedSpeechWorld("0.0005");
  const key = `${prefix}-hold-replay-spec`;
  const first = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: key,
    maximumCents: 315,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    speechSpec: { ...FROZEN_SPEC },
  });
  expect(first.reserved).toBe(true);

  // Same key, different certified spec: answering the original hold would freeze the
  // original spec and doom the settle to spec_not_corroborated with a hold only
  // recovery could free. The replay is a conflict, like a different amount.
  await expect(
    writer.reserveCredits({
      externalCustomerId: world.customerKey,
      idempotencyKey: key,
      maximumCents: 315,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      speechSpec: { ...FROZEN_SPEC, inputCharacters: 120 },
    }),
  ).rejects.toThrow(CreditReservationConflictError);
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
  await database.$client.close();
});
