import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  collectInterruptedSpeechUsage,
  settleInterruptedSpeech,
} from "../src/billing/speech-interruption";
import { createSpeechSettlementService } from "../src/billing/speech-settlement";
import { createDatabase } from "../src/db/client";
import { payerAccounts } from "../src/db/schema";
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
 * Bifrost #308 (13.3): the interruption tail — what a playback/stream cut owes, settled
 * EXACTLY once. The client stopping playback or dropping the connection is not a release
 * of the money already spent: the server-held buffer of received audio states its own
 * duration chunk by chunk (the same measured-not-believed meter 14.1 reads), the
 * CONFIRMED share settles through 13.2's own path once, and what no evidence confirms
 * keeps the hold in unknown (06.8) with its FULL capacity occupied — "客户端断开=无费用"
 * is the wrong default this file exists to refuse.
 *
 * SETTLED ONCE, IN BOTH DIRECTIONS. A playback interruption can fire twice (the client
 * disconnect and the stream error are two events about one cut): the second settle of the
 * same confirmed usage is a REPLAY, and the writer's own idempotency answers the first
 * settlement — one ledger row, one line, the first charge, forever. And the tail never
 * re-dispatches: this module has no dispatch handle at all (an interruption cannot ask
 * the provider for more audio), and the account's reservation count stays exactly one —
 * a second synthesis would need a second admission, which is 07.5's rule, not this
 * module's to wave through.
 *
 * THE BILL NEVER EXCEEDS THE HOLD. The confirmed seconds are capped by the same spec the
 * hold certified: a buffer whose chunks sum beyond the certified cap is a defect of the
 * cutoff (13.2's own refusal), never a bill — and never a silent clamp down to the cap
 * either, because a fabricated number is not evidence.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b10-308-${randomUUID().slice(0, 8)}`;
const writer = createCreditWriter(database);
const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const environmentRate = {
  numerator: 100n,
  denominator: 1n,
} satisfies ConversionRate;
const settleSpeech = createSpeechSettlementService({
  database,
  environmentRate,
});

let seedCounter = 0;

const COMPLETE_WIRE_PRICING = {
  prompt: "0",
  completion: "0",
  internal_reasoning: "0",
  image: "0",
  input_cache_read: "0",
  input_cache_write: "0",
  web_search: "0",
  request: "0",
} as const;

/** The dims of one priced speech cell, every dimension known, audio_output at perSecondUsd. */
function speechDimsOf(perSecondUsd: string): PriceSnapshotDims {
  const mapped = mapPriceDims({ pricing: COMPLETE_WIRE_PRICING });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_output"
        ? { status: "known" as const, amount: perSecondUsd }
        : mapped[dimension].status === "known"
          ? mapped[dimension]
          : { status: "known" as const, amount: "0" },
    ]),
  ) as PriceSnapshotDims;
}

type SpeechWorld = {
  userId: string;
  customerKey: string;
  provider: string;
  model: string;
};

/** One speech world: a funded personal account and a priced speech cell. */
async function seedSpeechWorld(
  perSecondUsd = "0.0005",
  seedCredits = 100_000,
): Promise<SpeechWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `tts-b10-${n}`;

  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await writer.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: seedCredits,
    expiresAt: new Date(Date.now() + 24 * 60 * 1000),
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
  };
}

/** One held speech reservation locked at the cell's current snapshot version. */
async function holdFor(
  world: SpeechWorld,
  maximumCents: number,
): Promise<string> {
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
    // 13.2's frozen spec: the quantities the interruption settle below re-carries.
    speechSpec: {
      inputCharacters: 100,
      voiceTier: "alloy",
      durationCapSeconds: 60,
      perInputCharacterUsd: "0.000015",
      perOutputSecondUsd: "0.0005",
    },
  });
  expect(reserved.reserved).toBe(true);
  return reserved.reserved ? reserved.reservationId : "";
}

/**
 * Synthesize one WAV chunk of an exact duration: 16-bit mono PCM at 8000 Hz (byte rate
 * 16000/s), its `data` chunk sized to the requested duration — a container whose OWN
 * metadata states its length.
 */
function wavOf(durationSeconds: number): Uint8Array {
  const byteRate = 16000;
  const dataSize = Math.round(durationSeconds * byteRate);
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

/** The interruption settle the stages share: collect from the buffer, settle once. */
function interrupt(
  reservationId: string,
  chunks: Uint8Array[] | "no-buffer",
  idempotencyKey: string,
) {
  return settleInterruptedSpeech(
    { settle: (request) => settleSpeech.settle(request) },
    {
      reservationId,
      requested: {
        inputCharacters: 100,
        voiceTier: "alloy",
        durationCapSeconds: 60,
      },
      priced: {
        perInputCharacterUsd: "0.000015",
        perOutputSecondUsd: "0.0005",
      },
      // The interruption point's own evidence: the server-held buffer, or its absence.
      ...(chunks === "no-buffer" ? {} : { chunks }),
      ...(chunks === "no-buffer"
        ? { interruptionReason: "client disconnected before any audio arrived" }
        : {}),
      settledBy: "bifrost-playback",
      idempotencyKey,
    },
  );
}

// ── the usage collector: measured, never estimated ──

test("the collector sums the buffered chunks' own stated durations exactly", () => {
  const chunks = [wavOf(10), wavOf(10), wavOf(5)];
  const usage = collectInterruptedSpeechUsage({ chunks });
  // The evidence carries each chunk's own container header (everything up to and
  // including the data size word): the settle surface re-measures the very statements
  // this sum was built from, never a number it must take on faith.
  expect(usage.outcome).toBe("confirmed");
  expect(usage.outcome === "confirmed" && usage.actualSeconds).toBe("25");
  expect(usage.outcome === "confirmed" && usage.evidence.metadata).toEqual({
    container: "wav",
    bytesBase64: chunks.map((chunk) =>
      Buffer.from(chunk.subarray(0, 44)).toString("base64"),
    ),
  });

  // Fractional tails stay exact: 10 + 10 + 5.5 = 25.5, never a float.
  const fractional = collectInterruptedSpeechUsage({
    chunks: [wavOf(10), wavOf(10), wavOf(5.5)],
  });
  expect(fractional).toMatchObject({
    outcome: "confirmed",
    actualSeconds: "25.5",
  });
});

test("an empty or unreadable buffer confirms nothing", () => {
  expect(collectInterruptedSpeechUsage({ chunks: [] })).toMatchObject({
    outcome: "unconfirmed",
  });
  // One unreadable chunk makes the whole sum uncertifiable — the confirmed total is only
  // as good as every piece of it (measured-not-believed, all the way down).
  expect(
    collectInterruptedSpeechUsage({ chunks: [wavOf(10), new Uint8Array(0)] }),
  ).toMatchObject({ outcome: "unconfirmed" });
});

// ── the settle flows, on the real database ──

test("a mid-playback interruption settles the confirmed tail exactly once", async () => {
  const world = await seedSpeechWorld();
  // 13.1's own ceiling for this world: 100 chars × $0.000015 + 60 s × $0.0005 = 315.
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  // Playback cut after 25 confirmed seconds of a 60-second cap, buffered in 3 chunks.
  const outcome = await interrupt(
    reservationId,
    [wavOf(10), wavOf(10), wavOf(5)],
    `${prefix}-cut-a`,
  );

  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  // 100 × 0.000015 + 25 × 0.0005 = $0.014 → 140 scaled units — the confirmed tail, in
  // full, and never more than the hold (140 ≤ 315).
  expect(outcome.chargedCredits).toBe(140);
  expect(outcome.releasedCredits).toBe(175);
  // The hold's unsynthesized share handed back with the settle: available = held
  // (99 685) + released (175) — the charge came out of the hold, not on top of it.
  expect(await writer.availableBalance(world.customerKey)).toBe(held + 175);

  // One ledger row, one speech line carrying the interrupted tail's own seconds.
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.customerKey));
  expect(ledgerRows).toHaveLength(1);
  const [detail] = await database
    .select()
    .from(creditSpeechSettlementDetails)
    .where(eq(creditSpeechSettlementDetails.reservationId, reservationId));
  expect(detail.actualSeconds).toBe("25");

  // The SECOND event about the same cut (the client disconnect firing after the stream
  // error already settled): a replay, not a second bill — same row count, same charge.
  const replay = await interrupt(
    reservationId,
    [wavOf(10), wavOf(10), wavOf(5)],
    `${prefix}-cut-a-replay`,
  );
  expect(replay.status).toBe("settled");
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(1);
  expect(
    await database
      .select()
      .from(creditSpeechSettlementDetails)
      .where(eq(creditSpeechSettlementDetails.reservationId, reservationId)),
  ).toHaveLength(1);

  // And no second dispatch ever happened: one reservation for this account, total —
  // a second synthesis would have had to be admitted, and nothing was.
  const reservations = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, world.customerKey));
  expect(reservations).toHaveLength(1);
  expect(reservations[0].status).toBe("settled");
});

test("an interruption with nothing confirmable keeps the hold unknown at full capacity", async () => {
  const world = await seedSpeechWorld();
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  const outcome = await interrupt(
    reservationId,
    "no-buffer",
    `${prefix}-cut-b`,
  );

  expect(outcome).toMatchObject({ status: "unknown", reservationId });
  const [reservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(reservation.status).toBe("unknown");
  // Full capacity still occupied, nothing settled, no line, no ledger — 06.8.
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
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
      .where(eq(creditReservations.externalCustomerId, world.customerKey)),
  ).toHaveLength(1);
});

test("a buffer beyond the certified cap is a defect, never a bill and never a clamp", async () => {
  const world = await seedSpeechWorld();
  const reservationId = await holdFor(world, 315);
  const held = await writer.availableBalance(world.customerKey);

  // The cutoff failed: 61 confirmed seconds against a 60-second certified cap. 13.2's
  // own refusal answers (actual_exceeds_certified_spec) — the module does NOT clamp the
  // buffer down to the cap to make the numbers work.
  const outcome = await interrupt(
    reservationId,
    [wavOf(30), wavOf(31)],
    `${prefix}-cut-c`,
  );

  expect(outcome).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
    detail: {
      field: "result.actualSeconds",
      reason: "actual_exceeds_certified_spec",
    },
  });
  expect(await writer.availableBalance(world.customerKey)).toBe(held);
  expect(
    await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey)),
  ).toHaveLength(0);
});

afterAll(async () => {
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
  await database.$client.close();
});
