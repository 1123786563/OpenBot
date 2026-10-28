/**
 * Span-building support shared by the model-span and tool-step recorders (OCR
 * R4-20): the SafeText→SafeValue renaming, the honest nanosecond timestamps,
 * the W3C id shapes and the recorder-asserted content projection used to live
 * VERBATIM in both builders — ~60 lines of security-relevant logic kept in
 * lockstep by discipline alone (the F4/N1-class fixes were historically applied
 * file by file). Extracted so the two recorders share one copy. Behavior is
 * moved, not changed, each recorder's own suite pins that — until FREV-01, which
 * added the approval-gated body projection the model spans now use.
 */
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import { projectSafeText } from "./redaction";

/** SafeText → SafeValue: same tri-state, `text` leaves renamed to `value`. */
export function asValue(text: SafeText): SafeValue {
  if (text.state === "projected")
    return { state: "projected", value: text.text };
  if (text.state === "truncated") {
    return {
      state: "truncated",
      value: text.text,
      originalBytes: text.originalBytes,
    };
  }
  return text;
}

export function nanos(date: Date): string | undefined {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

/**
 * Times degrade honestly (OCR m157): the fallback of last resort for a span
 * whose every carried timestamp is unprovable — a fresh now beats filing the
 * span in 1970 under "0".
 */
export function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

/** The W3C id shapes the OTLP wire format admits. All-zero ids are invalid — W3C
 * Trace Context rejects them, so a zero id answers false like a malformed one. */
export const W3C_TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
export const W3C_SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;

/**
 * Span-body approval and issuance (FREV-01).
 *
 * A span body is unreviewed prose until something vouches for it. The recorder's
 * own say-so is not a voucher — that is the hole the final review drove the email +
 * short-password counterexample through — so free text in a span now needs an
 * approval minted from a Bot's configured security policy. Trust is process-internal
 * and WeakSet-recorded, exactly like an ObservationScope: only the frozen objects
 * this module actually minted answer the check, so a wire value, a spread copy or a
 * hand-built lookalike projects nothing. The run wiring resolves the policy verdict
 * and carries the minted approval on the observation; this module never guesses one.
 */
export type SpanContentPolicy = Readonly<{
  /** The policy surface that answered. */
  readonly source: "bot_security_policy";
  /** Stable, human-checkable reference of the policy version that approved. */
  readonly policyRef: string;
  /** Whether this Bot's policy approves free-text span bodies at all. */
  readonly allowFreeText: boolean;
}>;

export type SpanContentApproval = Readonly<{
  readonly source: "bot_security_policy";
  readonly policyRef: string;
}>;

const issuedApprovals = new WeakSet<object>();

/** The only minter: a policy that does not approve, or cannot name itself, mints nothing. */
export function approveSpanContent(
  policy: SpanContentPolicy,
): SpanContentApproval | null {
  if (!policy.allowFreeText) return null;
  const policyRef = policy.policyRef.trim();
  if (policyRef === "") return null;
  const approval: SpanContentApproval = Object.freeze({
    source: policy.source,
    policyRef,
  });
  issuedApprovals.add(approval);
  return approval;
}

/** Verify the token at runtime, never trust the static type: see approveSpanContent. */
function isIssuedApproval(value: unknown): value is SpanContentApproval {
  return (
    typeof value === "object" && value !== null && issuedApprovals.has(value)
  );
}

/**
 * The one verdict every governance gate reads (FREV-01, F5A1-R1-F1): the carried
 * approval, if — and only if — this module minted it, else null. Body projection and
 * the span's audit attribute must share this verdict; a truthiness test on the carried
 * token would let a forged or spread-copied approval name a policy for bodies that
 * were withheld, so the span would claim an approval that never happened.
 */
export function issuedSpanContentApproval(
  approval: SpanContentApproval | null | undefined,
): SpanContentApproval | null {
  return isIssuedApproval(approval) ? approval : null;
}

/**
 * Span body behind the FREV-01 gate: the deny patterns still run first and always
 * win, and without a minted approval the body is omitted as unhandled free text —
 * metrics survive, prose does not. `null` text still projects no attribute at all.
 */
export function projectApprovedSpanContent(
  text: string | null | undefined,
  approval: SpanContentApproval | null | undefined,
): SafeValue | null {
  if (text === null || text === undefined) return null;
  return asValue(
    projectSafeText(text, { allowFreeText: isIssuedApproval(approval) }),
  );
}

/** Span content on the recorder's own assertion — the deny patterns still run first
 * and always win. FREV-01 closed this door for model spans (see
 * projectApprovedSpanContent); this recorder-asserted variant is TEST-ONLY now —
 * the tool-step builders that used it migrated to the approved path, and only
 * opik-span-support.test.ts / opik-tool-steps.test.ts still pin its shape (OCR
 * R5). Removing it means removing those pins; keeping it live is the cheaper lie
 * no production caller pays for. */
export function projectSpanContent(
  text: string | null | undefined,
): SafeValue | null {
  if (text === null || text === undefined) return null;
  return asValue(projectSafeText(text, { allowFreeText: true }));
}
