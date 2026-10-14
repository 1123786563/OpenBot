/**
 * Projection, not masking.
 *
 * Every value that reaches the observability store, an evaluation sample, a Judge prompt or an
 * export passes through here first. The rule is an allowlist: content is projected when it is
 * known-safe, and omitted otherwise. There is no "scrub the patterns we thought of" mode, because
 * a masker that rewrites the literals it was tested with passes its own test and leaks the next
 * credential shape.
 *
 * Free text is the hard case. Unreviewed prose is omitted (metrics only) unless the caller
 * explicitly asserts it handled the content — `allowFreeText` is that assertion, and even it does
 * not license a credential: the deny patterns run first and always win.
 */
import { type OmitReason, type SafeText } from "../../../shared/ai-observability";

export const MAX_SAFE_TEXT_BYTES = 8_192;
const MAX_SAFE_NAME_BYTES = 128;

/** Deny patterns. Ordered so the most specific reason wins. */
const DENY: ReadonlyArray<{ reason: OmitReason; pattern: RegExp }> = [
  { reason: "connection_string", pattern: /\b(?:postgresql|postgres|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/\S+/i },
  { reason: "credential", pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/i },
  { reason: "credential", pattern: /\bsk-(?:live|test|proj)-[A-Za-z0-9._\-]{16,}/ },
  { reason: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "credential", pattern: /\b-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "credential", pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*(?:secret|password|passwd|pwd))/i },
  { reason: "account_identifier", pattern: /\bacct_[A-Za-z0-9]{12,}\b/ },
  { reason: "account_identifier", pattern: /\bcus_[A-Za-z0-9]{12,}\b/ },
  { reason: "internal_capability", pattern: /\bopenbot\.internal\.[\w./-]+/i },
  { reason: "reasoning_content", pattern: /<\s*reasoning\s*>/i },
];

function denyReason(input: string): OmitReason | undefined {
  for (const { reason, pattern } of DENY) {
    if (pattern.test(input)) return reason;
  }
  return undefined;
}

/** Cut on a UTF-8 byte budget without splitting a character or emitting U+FFFD. */
function cutToBytes(input: string, budget: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= budget) return input;
  let text = input;
  // Binary-search the longest prefix that fits, then drop a trailing partial code point.
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  text = input.slice(0, low);
  return text.replace(/�$/, "");
}

function project(input: string, budget: number): SafeText {
  const bytes = new TextEncoder().encode(input).length;
  if (bytes <= budget) return { state: "projected", text: input };
  return { state: "truncated", text: cutToBytes(input, budget), originalBytes: bytes };
}

/**
 * Body text. `allowFreeText` is the caller's explicit assertion that this content was reviewed
 * (a saved dataset case, a curated synthetic sample). Without it, unreviewed prose is metrics-only.
 */
export function projectSafeText(
  input: string | null | undefined,
  opts: { allowFreeText?: boolean } = {},
): SafeText {
  if (input === null || input === undefined) return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!opts.allowFreeText) return { state: "omitted", reason: "unhandled_free_text" };
  return project(input, MAX_SAFE_TEXT_BYTES);
}

/**
 * URLs. A private raw-file link with a signature is an attachment, not a reference: following it
 * would hand the reader content the projection just refused. Query and fragment are dropped from
 * what survives, because that is where signatures and account ids live.
 */
export function projectSafeUrl(input: string | null | undefined): SafeText {
  if (input === null || input === undefined || input.trim() === "") {
    return { state: "projected", text: "" };
  }
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { state: "omitted", reason: "unhandled_free_text" };
  }
  if (url.username || url.password) return { state: "omitted", reason: "credential" };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { state: "omitted", reason: "unhandled_free_text" };
  }
  const isRawFile = /\/(?:files|attachments|download)\//i.test(url.pathname);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (isRawFile || isLoopback) return { state: "omitted", reason: "raw_attachment" };
  return project(`${url.protocol}//${url.host}${url.pathname}`, MAX_SAFE_TEXT_BYTES);
}

/** Span, tool and model names: short, structured, and a favourite hiding place for capability names. */
export function projectSafeName(input: string | null | undefined): SafeText {
  if (input === null || input === undefined) return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!/^[\w.:/@ -]*$/u.test(input)) return { state: "omitted", reason: "unhandled_free_text" };
  return project(input, MAX_SAFE_NAME_BYTES);
}
