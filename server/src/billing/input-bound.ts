import { getLogger } from "../../../shared/logger";

const log = getLogger("server");

/**
 * The chat-completions input bound's conservative counter and self-enforcing fitter
 * (ADR-0001, docs/specs/2026-10-13-provable-input-bound-design.md).
 *
 * WHY BYTES, NOT A TOKENIZER. The provider behind an OpenAI-compatible gateway keeps its own
 * tokenizer; a local look-alike would disagree with it, and the contract a counted bound must
 * satisfy is not "exact" but "the provider cannot be SENT more than the configured ceiling by
 * our own measure". So the counter prices serialized bytes — deterministic, shape-tolerant,
 * tokenizer-free — with calibration constants chosen to sit ABOVE a typical tokenizer's
 * answer (the conservative direction), and the fitter drops the oldest non-system messages
 * until the count fits. A tokenizer that beats the calibration shows up at settlement as
 * `usage_over_bound` — a held reservation for reconciliation, never a silent charge.
 */

export const CONSERVATIVE_BYTES_PER_TOKEN_FLOOR = 2;
export const CONSERVATIVE_SAFETY_FACTOR = 1.25;
export const CONSERVATIVE_PER_MESSAGE_OVERHEAD_TOKENS = 4;

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function promptLength(params: unknown): number {
  const prompt = (params as { prompt?: unknown } | null | undefined)?.prompt;
  return Array.isArray(prompt) ? prompt.length : 1;
}

export function countChatInputTokens(params: unknown): number {
  const bytes = serializedBytes(params);
  if (bytes === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  const counted =
    Math.ceil(
      (bytes / CONSERVATIVE_BYTES_PER_TOKEN_FLOOR) *
        CONSERVATIVE_SAFETY_FACTOR,
    ) + promptLength(params) * CONSERVATIVE_PER_MESSAGE_OVERHEAD_TOKENS;
  return Number.isSafeInteger(counted) ? counted : Number.MAX_SAFE_INTEGER;
}

function leadingSystemCount(prompt: unknown[]): number {
  let count = 0;
  for (const entry of prompt) {
    if ((entry as { role?: unknown } | null)?.role === "system") count += 1;
    else break;
  }
  return count;
}

/**
 * Self-enforcement (spec decision 1b/3): return the request this call should actually send —
 * the oldest non-system messages dropped until the conservative count fits the ceiling, the
 * system block and the latest turn always kept. When even that does not fit (or the shape is
 * not a prompt array), the params come back untouched so admission refuses `input_over_limit`
 * rather than sending something uncounted.
 */
export function fitChatInputRequest(
  maximumTokens: bigint,
): (params: unknown) => unknown {
  const limit = Number(maximumTokens);
  return (params) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) return params;
    const prompt = (params as { prompt?: unknown } | null | undefined)?.prompt;
    if (!Array.isArray(prompt) || prompt.length <= 2) return params;
    const head = leadingSystemCount(prompt);
    const last = prompt.length - 1;
    for (let drop = 1; head + drop <= last; drop += 1) {
      const candidate = [...prompt.slice(0, head), ...prompt.slice(head + drop)];
      const fitted = { ...(params as object), prompt: candidate };
      if (countChatInputTokens(fitted) <= limit) {
        log.debug(
          {
            type: "billing-model-input-truncated",
            dropped: drop,
            kept: candidate.length,
          },
          "billing-model-input-truncated",
        );
        return fitted;
      }
    }
    return params;
  };
}
