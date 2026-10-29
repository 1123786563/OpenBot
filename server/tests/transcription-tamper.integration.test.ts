import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createTranscriptionSettlementService } from "../src/billing/transcription-settlement";
import { createCreditWriter } from "../src/billing/credits-writer";
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
import { auditEvents } from "../src/db/schema/core";
import { payerAccounts } from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #311 (14.2): the transcription settlement's tamper armor, on a real PostgreSQL —
 * a forged client claim can lower nothing, the bill stands on the server's own measurement
 * and the provider's real usage, a disagreeing claim is an auditable fact, and a usage the
 * measurement cannot confirm moves the hold to unknown instead of guessing.
 *
 * THE FIXTURE WORLDS stand where 14.1's boundary put them: a transcription cell whose
 * `audio_input` and `output` are KNOWN (the vocabulary slots transcription prices ride
 * exactly — measured seconds on `audio_input`, transcript tokens on `output`), with the
 * measurement carried by the trusted settle stage the way 12.2's image path carries its
 * frozen spec. $0.0006 per input second, $0.00001 per output token, wire surcharge $0.
 *
 * What each scenario proves, in the ACs' own words: 伪造或篡改音频元数据不能降低计费金额
 * (a claim of 1s over 2s of measured audio bills 2s — MORE than the forgery aimed at, never
 * less); 声明与测量不一致时产生可审计异常记录 (the audit row carries the claim, the
 * measurement, the difference and the source, keyed to the reservation); 计费以服务端可信
 * 测量与真实 usage 为准 (usage above the measurement bills its own larger figure);
 * 测量与 usage 冲突且无法确认时进入 unknown，保持预留 (usage of 0.5s over 2s measured
 * keeps the hold's full capacity occupied).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b9-311-${randomUUID().slice(0, 8)}`;
const writer = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const settleTranscription = createTranscriptionSettlementService({
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
  completion: "0.00001",
  internal_reasoning: "0",
  image: "0.005",
  input_cache_read: "0",
  input_cache_write: "0",
  web_search: "0",
  request: "0",
} as const;

type TranscriptionWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
  seedCredits: number;
};

/** The dims of one priced transcription cell: the wire's own fields plus the audio slots
 * a complete basis prices — `audio_input` per input second, the rest of the reserved
 * vocabulary explicitly free. */
function transcriptionDimsOf(perInputSecondUsd: string): PriceSnapshotDims {
  const mapped = mapPriceDims({ pricing: COMPLETE_WIRE_PRICING });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_input"
        ? { status: "known", amount: perInputSecondUsd }
        : dimension === "audio_output" ||
            dimension === "video" ||
            dimension === "video_input" ||
            dimension === "image_output" ||
            dimension === "surcharge_tool_call" ||
            dimension === "surcharge_a2a_call"
          ? { status: "known", amount: "0" }
          : mapped[dimension],
    ]),
  ) as PriceSnapshotDims;
}

/** One transcription world: a funded personal account and a priced transcription cell. */
async function seedTranscriptionWorld(
  perInputSecondUsd = "0.0006",
  seedCredits = 100_000,
): Promise<TranscriptionWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `asr-b9-${n}`;

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
      ref: { provider, model, capability: "transcription" },
      dims: transcriptionDimsOf(perInputSecondUsd),
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

/** One held transcription reservation locked at the cell's current snapshot version. */
async function holdFor(
  world: TranscriptionWorld,
  maximumCents: number,
): Promise<string> {
  const snapshot = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "transcription",
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
      capability: "transcription",
      snapshotVersion: snapshot!.snapshotVersion,
      rateVersion: 0,
    },
  });
  expect(reserved.reserved).toBe(true);
  return reserved.reserved ? reserved.reservationId : "";
}

test("a forged short duration bills the measured seconds and is audited", async () => {
  const world = await seedTranscriptionWorld();
  // 14.1's hold for 2 measured seconds and a 200-token cap: 2 × $0.0006 + 200 × $0.00001
  // = $0.0032 → 32 scaled units.
  const reservationId = await holdFor(world, 32);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2, clientDeclaredSeconds: 1 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2, outputTokens: 100 },
      evidence: { kind: "provider_usage_report", reference: "asr-311-a" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-a`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // 2 × 0.0006 + 100 × 0.00001 = $0.0022 → 22 scaled units — the MEASURED 2 seconds, not
  // the claimed 1 (which would have been 16). The forgery bought nothing.
  expect(outcome.actualCost).toEqual({ numerator: "22", denominator: "1" });
  expect(outcome.chargedCredits).toBe(22);
  expect(outcome.billedSeconds).toBe(2);
  expect(outcome.clientClaimDisagrees).toBe(true);

  // The tamper attempt is an auditable fact: claim, measurement, difference, source —
  // keyed to the reservation, written by the deployment's own settle stage.
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "billing.audio_metadata_mismatch"),
        eq(auditEvents.targetId, reservationId),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(rows[0].targetType).toBe("credit_reservation");
  expect(rows[0].initiatorKind).toBe("deployment");
  expect(rows[0].payload).toMatchObject({
    capability: "transcription",
    claimedSeconds: 1,
    measuredSeconds: 2,
    differenceSeconds: 1,
    source: "client_declared_duration",
  });

  // The money landed once, at the measured figure.
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.customerKey));
  expect(ledgerRows).toHaveLength(1);
  expect(ledgerRows[0].credits).toBe(22);
  expect(await writer.availableBalance(world.customerKey)).toBe(
    world.seedCredits - 22,
  );

  // A replay of the same result answers the first settlement, not a second charge.
  const replay = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2, clientDeclaredSeconds: 1 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2, outputTokens: 100 },
      evidence: { kind: "provider_usage_report", reference: "asr-311-a" },
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

test("an agreeing claim writes no anomaly and changes nothing about the bill", async () => {
  const world = await seedTranscriptionWorld();
  const reservationId = await holdFor(world, 32);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2, clientDeclaredSeconds: 2 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2, outputTokens: 100 },
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-agree`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.clientClaimDisagrees).toBe(false);
  expect(outcome.chargedCredits).toBe(22); // the same bill the forged claim met
  expect(
    await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "billing.audio_metadata_mismatch"),
          eq(auditEvents.targetId, reservationId),
        ),
      ),
  ).toHaveLength(0);
  // No claim at all is fine too: the measurement never needed one (14.1's own rule).
  const world2 = await seedTranscriptionWorld();
  const reservation2 = await holdFor(world2, 32);
  const noClaim = await settleTranscription.settle({
    reservationId: reservation2,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2, outputTokens: 100 },
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-noclaim`,
  });
  expect(noClaim).toMatchObject({ status: "settled", chargedCredits: 22 });
});

test("usage below the measurement is a conflict nobody can confirm: unknown, hold kept", async () => {
  const world = await seedTranscriptionWorld();
  const reservationId = await holdFor(world, 32);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 0.5, outputTokens: 100 },
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-conflict`,
  });

  expect(outcome).toMatchObject({
    status: "unknown",
    reservationId,
    reason: expect.stringContaining("cannot confirm"),
  });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  // Full capacity still occupied (06.8) — min(usage, 测量) is exactly the discount this
  // path refuses to be — and nothing settled: no ledger row, no release.
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("usage above the measurement bills its own larger figure, 足额", async () => {
  const world = await seedTranscriptionWorld();
  const reservationId = await holdFor(world, 40);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2.4, outputTokens: 100 },
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-larger`,
  });

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // ceil(2.4) = 3 billed seconds: 3 × 0.0006 + 100 × 0.00001 = $0.0028 → 28.
  expect(outcome.billedSeconds).toBe(3);
  expect(outcome.actualCost).toEqual({ numerator: "28", denominator: "1" });
});

test("no result anyone may bill from keeps the hold occupied as unknown", async () => {
  const world = await seedTranscriptionWorld();
  const reservationId = await holdFor(world, 32);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2, clientDeclaredSeconds: 2 },
    result: { outcome: "unknown", reason: "stream cut before the transcript" },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-unk`,
  });

  expect(outcome).toMatchObject({
    status: "unknown",
    reservationId,
    reason: "stream cut before the transcript",
  });
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId)),
  ).toMatchObject([{ status: "unknown" }]);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

test("a transcript beyond the certified cap is a defect, never a bill", async () => {
  const world = await seedTranscriptionWorld();
  const reservationId = await holdFor(world, 32);

  const outcome = await settleTranscription.settle({
    reservationId,
    requested: { outputTokenCap: 200 },
    trusted: { measuredSeconds: 2 },
    result: {
      outcome: "transcribed",
      usage: { audioSeconds: 2, outputTokens: 500 },
      evidence: { kind: "provider_usage_report" },
    },
    settledBy: "bifrost",
    idempotencyKey: `${prefix}-settle-defect`,
  });

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
    detail: {
      field: "result.usage.outputTokens",
      reason: "actual_exceeds_certified_spec",
    },
  });
});

afterAll(async () => {
  // audit_events is append-only (its trigger refuses UPDATE/DELETE), so the anomaly rows
  // stay as the trail's own facts, keyed to reservations this run cleans up below — the
  // rows name only numbers and a source, never content.
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
  await database.$client.close();
});
