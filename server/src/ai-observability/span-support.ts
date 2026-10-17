/**
 * Span-building support shared by the model-span and tool-step recorders (OCR
 * R4-20): the SafeText→SafeValue renaming, the honest nanosecond timestamps,
 * the W3C id shapes and the recorder-asserted content projection used to live
 * VERBATIM in both builders — ~60 lines of security-relevant logic kept in
 * lockstep by discipline alone (the F4/N1-class fixes were historically applied
 * file by file). Extracted so the two recorders share one copy. Behavior is
 * moved, not changed; each recorder's own suite pins that.
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

/** The W3C id shapes the OTLP wire format admits. */
export const W3C_TRACE_ID = /^[0-9a-f]{32}$/;
export const W3C_SPAN_ID = /^[0-9a-f]{16}$/;

/** Span content: the recorder's own assertion that this IS the span's product — the
 * deny patterns still run first and always win. */
export function projectSpanContent(
  text: string | null | undefined,
): SafeValue | null {
  if (text === null || text === undefined) return null;
  return asValue(projectSafeText(text, { allowFreeText: true }));
}
