import { addRational, type Rational, reduceRational } from "./rational";
import {
  SPEECH_EVIDENCE_MAX_WAV_CONTAINERS,
  SPEECH_EVIDENCE_MAX_WAV_HEADER_BYTES,
  type SpeechSettlementOutcome,
  type SpeechSettleRequest,
} from "./speech-settlement";
import { readWavDurationSecondsExact } from "./transcription-pricing";

/*
 * The speech interruption path (Bifrost 13.3, #308): what a playback or stream cut owes,
 * collected from what the SERVER held and settled exactly once.
 *
 * "客户端断开=无费用" IS THE WRONG DEFAULT. The audio the server buffered before the cut
 * states its own duration chunk by chunk — a WAV's `fmt ` byte rate against its `data`
 * size, the same measured-not-believed meter 14.1 reads — so the interruption's confirmed
 * usage is EVIDENCE, not an estimate: the collector sums the buffered chunks' own stated
 * durations in exact rationals and hands 13.2's settle an exact decimal string. A buffer
 * with NO readable chunk (the cut arrived before anything measurable, or one piece is
 * unreadable) confirms nothing, and nothing confirmed is not a zero cost: the settle
 * carries outcome unknown and the hold keeps its FULL capacity (06.8), because an
 * unconfirmable tail is exactly what recovery disposes of, never a release.
 *
 * SETTLED ONCE. The interruption settles through 13.2's own service — the same idempotent
 * writer, the same version-locked pricing, the same speech line (0181) — so the second
 * event about the same cut (a client disconnect firing after the stream error already
 * settled) is a REPLAY that answers the first settlement, and a buffer whose chunks sum
 * beyond the certified cap meets 13.2's own defect refusal (`actual_exceeds_certified_
 * spec`): the module never clamps the sum down to the cap, because a clamped number is a
 * fabricated one. The bill can therefore never exceed the hold: the charge is priced over
 * seconds the cap already certified, at the versions the hold already locked.
 *
 * NO SECOND DISPATCH. This module has no dispatch handle at all — an interruption cannot
 * ask the provider for more audio, and the type says so. A resumption is a NEW request
 * that needs its own admission (07.5's rule), which is another module's door; the one
 * thing this path can do with the reservation is finish it.
 *
 * WHO CALLS THIS. The deployment's speech streaming/playback supervision — the point
 * where a client disconnect or a severed stream is observed, holding the server-side
 * buffer of already-received audio. The settle caller is injected (13.2's service in
 * production); the collector is pure and exports for the interruption surface's own
 * deterministic tests.
 */

/** What the interruption's own evidence confirms, as 13.2's settle result stands on it. */
export type InterruptedSpeechUsage =
  | {
      outcome: "confirmed";
      /** The confirmed seconds — an exact decimal string, summed from chunk metadata. */
      actualSeconds: string;
      /** The buffered-audio evidence, in the settle result's own closed vocabulary —
       * carrying each chunk's own container header so the settle surface can RE-MEASURE
       * the same statements (13.2's tightened evidence rule: measured, not believed). */
      evidence: {
        kind: "artifact_metadata";
        reference: string;
        metadata: { container: "wav"; bytesBase64: string[] };
      };
    }
  | {
      outcome: "unconfirmed";
      /** Why nothing could be confirmed — displayable, never a guess instead. */
      reason: string;
    };

/**
 * Collect the confirmed usage from the server-held buffer at the interruption point.
 * Pure: the buffer's own container metadata is the only input, chunk by chunk, summed in
 * exact BigInt rationals — never a float, never the input characters, never the cap.
 */
export function collectInterruptedSpeechUsage(input: {
  /** The audio chunks the server buffered before the cut, in arrival order. */
  chunks: readonly Uint8Array[];
}): InterruptedSpeechUsage {
  if (input.chunks.length === 0) {
    return {
      outcome: "unconfirmed",
      reason: "no buffered audio before the interruption",
    };
  }
  // Exact rational sum: each chunk contributes dataSize/byteRate in lowest BigInt terms;
  // one unreadable chunk makes the whole total uncertifiable, because a confirmed total
  // is only as good as every piece of it. The parse and the sum are the SHARED tools
  // (rational.ts / readWavDurationSecondsExact) the settle surface re-measures with —
  // one arithmetic on both ends of the evidence.
  let sum: Rational = { numerator: 0n, denominator: 1n };
  const containerHeaders: string[] = [];
  // The evidence-carrying budget, single-sourced with the settle surface's own shape
  // validation (R1-M1): a buffer past it confirms nothing — unknown (06.8) at the settle,
  // never an over-budget request the settle surface must refuse as malformed.
  if (input.chunks.length > SPEECH_EVIDENCE_MAX_WAV_CONTAINERS) {
    return {
      outcome: "unconfirmed",
      reason: "more buffered chunks than the settle evidence can carry",
    };
  }
  for (const chunk of input.chunks) {
    const measured = readWavDurationSecondsExact(chunk);
    if (measured === null) {
      return {
        outcome: "unconfirmed",
        reason: "a buffered chunk is not a readable audio container",
      };
    }
    if (measured.headerEnd > SPEECH_EVIDENCE_MAX_WAV_HEADER_BYTES) {
      return {
        outcome: "unconfirmed",
        reason:
          "a buffered chunk's container header exceeds the settle evidence's carry budget",
      };
    }
    sum = addRational(sum, {
      numerator: measured.numerator,
      denominator: measured.denominator,
    });
    // The chunk's own container header rides the evidence: the settle surface re-measures
    // the very statements this sum was built from, never a number it must take on faith.
    containerHeaders.push(
      Buffer.from(chunk.subarray(0, measured.headerEnd)).toString("base64"),
    );
  }
  const reduced = sum;
  return {
    outcome: "confirmed",
    actualSeconds: terminatingDecimal(reduced),
    evidence: {
      kind: "artifact_metadata",
      reference: `interrupted-buffer:${input.chunks.length} chunks`,
      metadata: { container: "wav", bytesBase64: containerHeaders },
    },
  };
}

/**
 * The exact-decimal string of a non-negative rational whose denominator terminates
 * (powers of 2 and 5 only); any other denominator is represented at nine fractional
 * digits rounded UP — the exact-decimal wire shape the settle contract reads, and the
 * one rounding direction strict billing allows (never below the measured value).
 */
function terminatingDecimal(value: Rational): string {
  let denominator = value.denominator;
  let twos = 0n;
  let fives = 0n;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1n;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1n;
  }
  if (denominator !== 1n) {
    // Not terminating: scale to nine fractional digits, rounding up.
    const scale = 10n ** 9n;
    const scaled = reduce(value.numerator * scale, value.denominator);
    const wholes = scaled.numerator / scaled.denominator;
    const roundUp = scaled.numerator % scaled.denominator === 0n ? 0n : 1n;
    const digits = (wholes + roundUp).toString().padStart(10, "0");
    return `${digits.slice(0, -9) || "0"}.${digits.slice(-9).replace(/0+$/, "")}`;
  }
  const digits = Number(twos > fives ? twos : fives);
  // n/d with d = 2^a·5^b and k = max(a,b): n·10^k/d is the exact integer the decimal
  // digits spell — the division is exact by construction, never a rounding.
  const scaled = (value.numerator * 10n ** BigInt(digits)) / value.denominator;
  const text = scaled.toString().padStart(digits + 1, "0");
  const dot = text.length - digits;
  return digits === 0 ? text : `${text.slice(0, dot)}.${text.slice(dot)}`;
}

/** The settle caller this path composes — 13.2's service in production. */
export type SpeechSettleCaller = (
  request: SpeechSettleRequest,
) => Promise<SpeechSettlementOutcome>;

/** One interruption settle: the frozen spec, the locked tier, and the buffer's evidence. */
export type SpeechInterruptionSettleInput = {
  reservationId: string;
  /** The spec 13.1 froze before dispatch — what the hold was certified against. */
  requested: SpeechSettleRequest["requested"];
  /** The locked tier the admission certified — both sides, exact decimal strings. */
  priced: SpeechSettleRequest["priced"];
  /** The server-held buffer at the cut; absent when nothing buffered is readable. */
  chunks?: readonly Uint8Array[];
  /** The interruption's own observation, when no buffer rides along to speak for it. */
  interruptionReason?: string;
  settledBy: string;
  idempotencyKey: string;
};

/** What the interruption settle answers, with the usage state it settled on the side. */
export type SpeechInterruptionOutcome = SpeechSettlementOutcome & {
  /** The collector's own answer — what the buffer confirmed, or why nothing. */
  usage: InterruptedSpeechUsage;
};

/**
 * Settle one interruption through 13.2's own service, exactly once per cut: the confirmed
 * buffer tail as the synthesized result's evidence, or the unconfirmable state as the
 * unknown outcome that keeps the hold's full capacity occupied. The settle's own
 * idempotency answers any replay of the same cut, and its own refusal answers a buffer
 * beyond the certified cap — both pass through with the usage state that produced them.
 */
export async function settleInterruptedSpeech(
  dependencies: { settle: SpeechSettleCaller },
  input: SpeechInterruptionSettleInput,
): Promise<SpeechInterruptionOutcome> {
  const usage =
    input.chunks !== undefined
      ? collectInterruptedSpeechUsage({ chunks: input.chunks })
      : {
          outcome: "unconfirmed" as const,
          reason:
            input.interruptionReason ??
            "no readable audio buffered before the interruption",
        };
  const outcome = await dependencies.settle({
    reservationId: input.reservationId,
    requested: input.requested,
    priced: input.priced,
    result:
      usage.outcome === "confirmed"
        ? {
            outcome: "synthesized",
            actualSeconds: usage.actualSeconds,
            evidence: usage.evidence,
          }
        : { outcome: "unknown", reason: usage.reason },
    settledBy: input.settledBy,
    idempotencyKey: input.idempotencyKey,
  });
  return { ...outcome, usage };
}
