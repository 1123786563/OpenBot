/**
 * Lago metering for code runs, from one source: the `code_runs` row itself.
 *
 * The gateway's onUsage hook hands this the row's dimensions at the settle point; this module
 * turns them into exactly one provider event per run, keyed by the run id — the provider's
 * event id and transaction id are both `code-run:<runId>`, so a double report records identical
 * immutable facts in the usage outbox and the delivery worker settles it once downstream.
 *
 * The workshop's `usage` column is a DISPLAY COPY for the browser (F6 renders it); it is never
 * read here and never reported. If `code_runs` and the display ever disagree, `code_runs` wins
 * because it is the only thing this pipeline reads.
 *
 * A deployment without billing (no service) calls nothing and drops nothing: the `code_runs`
 * row is still written by the gateway — metering is a downstream observer, not a participant.
 */
import type { UsageOutbox } from "../billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../config";

export class UsageChargeError extends Error {
  constructor(
    readonly code:
      | "usage_invalid_tokens"
      | "usage_over_token_max"
      | "usage_over_reservation",
  ) {
    super(`Usage charge failed (${code}).`);
    this.name = "UsageChargeError";
  }
}

export type ExactCharge = { numerator: bigint; denominator: bigint };

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

function reduce(numerator: bigint, denominator: bigint): ExactCharge {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function add(left: ExactCharge, right: ExactCharge): ExactCharge {
  return reduce(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(
  tokens: bigint,
  rate: { numerator: bigint; denominator: bigint },
): ExactCharge {
  return reduce(tokens * rate.numerator, rate.denominator);
}

function compareWhole(amount: ExactCharge, whole: bigint): number {
  const scaledWhole = whole * amount.denominator;
  if (amount.numerator < scaledWhole) return -1;
  if (amount.numerator > scaledWhole) return 1;
  return 0;
}

function wholeTokens(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new UsageChargeError("usage_invalid_tokens");
  }
  return value;
}

export function calculateExactModelUsageCharge(
  policy: BillingModelCreditPolicyEntry,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  },
): {
  inputTokens: number;
  outputTokens: number;
  actual: ExactCharge;
} {
  const inputTokens = wholeTokens(usage.inputTokens);
  const outputTokens = wholeTokens(usage.outputTokens);
  if (
    BigInt(inputTokens) > policy.input.maximumTokens ||
    BigInt(outputTokens) > policy.output.maximumTokens
  ) {
    throw new UsageChargeError("usage_over_token_max");
  }
  const actual = add(
    multiply(BigInt(inputTokens), policy.input.rate),
    multiply(BigInt(outputTokens), policy.output.rate),
  );
  if (compareWhole(actual, policy.maximumReservationUnits) > 0) {
    throw new UsageChargeError("usage_over_reservation");
  }
  return { inputTokens, outputTokens, actual };
}

export type CodeRunUsageInput = {
  runId: string;
  status: string;
  sessionId: string | null;
  botId: string;
  ownerUserId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  occurredAt: Date;
};

/** The provider's metric code for a code run's token usage, one constant so both sides agree. */
export const CODE_RUN_METRIC = "code_run_tokens";

/**
 * Record one run's usage in the durable outbox. Returns true when a write was attempted, false
 * when there was nothing meterable or no outbox to write to — both are silent on purpose.
 */
export async function reportCodeRunUsage(
  outbox: Pick<UsageOutbox, "record"> | null | undefined,
  input: CodeRunUsageInput & { externalCustomerId: string },
): Promise<boolean> {
  if (!outbox) return false; // Unconfigured: silent, and the code_runs row already stands.
  if (input.inputTokens <= 0 && input.outputTokens <= 0) return false; // Nothing meterable.
  await outbox.record({
    eventId: `code-run:${input.runId}`,
    source: "code_run",
    externalCustomerId: input.externalCustomerId,
    transactionId: `code-run:${input.runId}`,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    model: input.modelId,
    client: "web",
    occurredAt: input.occurredAt,
    runId: input.runId,
    botId: input.botId,
    ownerUserId: input.ownerUserId,
    sessionId: input.sessionId,
    status: input.status,
  });
  return true;
}
