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
import type {
  OmitReason,
  SafeText,
  SafeValue,
} from "../../../shared/ai-observability";

export const MAX_SAFE_TEXT_BYTES = 8_192;
const MAX_SAFE_NAME_BYTES = 128;

/** Deny patterns. Ordered so the most specific reason wins. */
const DENY: ReadonlyArray<{ reason: OmitReason; pattern: RegExp }> = [
  {
    reason: "connection_string",
    pattern:
      /\b(?:postgresql|postgres|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/\S+/i,
  },
  { reason: "credential", pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/i },
  {
    reason: "credential",
    pattern: /\bsk-(?:live|test|proj)-[A-Za-z0-9._\-]{16,}/,
  },
  { reason: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // No \b here: a PEM block sits at the start of a field or after a newline, colon or space —
  // positions where a word boundary never holds. `-----BEGIN` is specific enough alone.
  { reason: "credential", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    // Context may sit on either side of the token: `aws_secret_access_key=<40 chars>` is the
    // form every real config file and env dump uses, and a forward-only lookahead misses it.
    // A bare 40-char token stays projected on purpose: rejecting those would flag every hash,
    // and unreviewed text is metrics-only anyway (`allowFreeText` is the gate).
    reason: "credential",
    pattern:
      /\b[A-Za-z0-9/+=]{40}\b(?=.*(?:secret|password|passwd|pwd))|(?:secret|password|passwd|pwd)[^\n]{0,64}[A-Za-z0-9/+=]{40}/i,
  },
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
  // Binary-search the longest prefix that fits the budget.
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  // The fitting prefix can still end on the high half of a surrogate pair: as a string that is
  // a lone surrogate, not a U+FFFD character, so scrubbing U+FFFD from the text never caught it.
  // Drop it at the source, where the split actually happened, instead of patching the bytes.
  while (
    low > 0 &&
    input.charCodeAt(low - 1) >= 0xd800 &&
    input.charCodeAt(low - 1) <= 0xdbff
  ) {
    low -= 1;
  }
  return input.slice(0, low);
}

function project(input: string, budget: number): SafeText {
  const bytes = new TextEncoder().encode(input).length;
  if (bytes <= budget) return { state: "projected", text: input };
  return {
    state: "truncated",
    text: cutToBytes(input, budget),
    originalBytes: bytes,
  };
}

/**
 * Body text. `allowFreeText` is the caller's explicit assertion that this content was reviewed
 * (a saved dataset case, a curated synthetic sample). Without it, unreviewed prose is metrics-only.
 */
export function projectSafeText(
  input: string | null | undefined,
  opts: { allowFreeText?: boolean } = {},
): SafeText {
  if (input === null || input === undefined)
    return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!opts.allowFreeText)
    return { state: "omitted", reason: "unhandled_free_text" };
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
  if (url.username || url.password)
    return { state: "omitted", reason: "credential" };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { state: "omitted", reason: "unhandled_free_text" };
  }
  const isRawFile = /\/(?:files|attachments|download)\//i.test(url.pathname);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (isRawFile || isLoopback)
    return { state: "omitted", reason: "raw_attachment" };
  return project(
    `${url.protocol}//${url.host}${url.pathname}`,
    MAX_SAFE_TEXT_BYTES,
  );
}

/** Span, tool and model names: short, structured, and a favourite hiding place for capability names. */
export function projectSafeName(input: string | null | undefined): SafeText {
  if (input === null || input === undefined)
    return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!/^[\w.:/@ -]*$/u.test(input))
    return { state: "omitted", reason: "unhandled_free_text" };
  return project(input, MAX_SAFE_NAME_BYTES);
}

export const MAX_SAFE_RECORD_KEYS = 64;
export const MAX_SAFE_RECORD_DEPTH = 4;

/**
 * Metadata an SDK captures automatically is the least reviewed content in the system, so its
 * allowlist is deliberately tiny and contains no free-text field: a key named `input` or `content`
 * would make the allowlist a doorway for exactly what the body projection refuses.
 */
export const DEFAULT_METADATA_ALLOWLIST: readonly string[] = [
  "thread_id",
  "bot_id",
  "run_id",
  "attempt_id",
  "deployment_version",
  "prompt_version",
  "model",
  "provider",
  "environment",
  "capability",
  "duration_ms",
  "tokens_input",
  "tokens_output",
];

export type SafeRecord = Record<string, SafeValue>;

function projectLeaf(value: unknown): SafeValue {
  if (value === null || value === undefined)
    return { state: "projected", value: null };
  if (typeof value === "number" || typeof value === "boolean") {
    return { state: "projected", value };
  }
  if (typeof value === "string") {
    const denied = denyReason(value);
    if (denied) return { state: "omitted", reason: denied };
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > MAX_SAFE_TEXT_BYTES) {
      return {
        state: "truncated",
        value: cutToBytes(value, MAX_SAFE_TEXT_BYTES),
        originalBytes: bytes,
      };
    }
    return { state: "projected", value };
  }
  // Functions, symbols, class instances: no reliable projection, so metrics only.
  return { state: "omitted", reason: "unhandled_free_text" };
}

function projectDeep(value: unknown, depth: number): SafeValue {
  if (depth > MAX_SAFE_RECORD_DEPTH)
    return { state: "omitted", reason: "unhandled_free_text" };
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_SAFE_RECORD_KEYS)
      .map((item) => projectDeep(item, depth + 1));
    // `projected` claims nothing was dropped, so a cut container must say `truncated`.
    // For containers originalBytes is the original item count.
    if (value.length > MAX_SAFE_RECORD_KEYS)
      return { state: "truncated", value: items, originalBytes: value.length };
    return { state: "projected", value: items };
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    // Null-prototype accumulator: an own `__proto__` key (JSON input gives you those) must
    // stay an own key, not trigger the setter on a plain object.
    const out: Record<string, SafeValue> = Object.create(null);
    for (const key of keys.slice(0, MAX_SAFE_RECORD_KEYS)) {
      out[key] = projectDeep(source[key], depth + 1);
    }
    if (keys.length > MAX_SAFE_RECORD_KEYS)
      return { state: "truncated", value: out, originalBytes: keys.length };
    return { state: "projected", value: out };
  }
  return projectLeaf(value);
}

/** Allowlist first: a key that is not listed is dropped outright, never rendered as `omitted`. */
export function projectSafeRecord(
  record: unknown,
  allowlist: readonly string[],
): SafeRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  const source = record as Record<string, unknown>;
  // Null prototype + own-property lookup: inherited names produce no phantom keys, and an own
  // `__proto__` key stays data instead of hijacking the accumulator's prototype.
  const out: SafeRecord = Object.create(null);
  // Requested keys are caller code, so none is dropped silently: the item cap bounds the data
  // side (arrays, nested objects), not the caller's own key list.
  for (const key of allowlist) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value === "string") {
      out[key] = projectLeaf(value);
      continue;
    }
    out[key] = projectDeep(value, 1);
  }
  return out;
}

export function projectSafeMetadata(
  metadata: unknown,
  allowlist: readonly string[] = DEFAULT_METADATA_ALLOWLIST,
): SafeRecord {
  return projectSafeRecord(metadata, allowlist);
}

/**
 * Exceptions. The stack trace never leaves the process: it is full of file paths, connection
 * strings and occasionally the argument values that caused the failure. A non-Error answers with
 * its class name, because "what kind of thing failed" is safe and its content is not.
 */
export function projectSafeException(error: unknown): SafeText {
  if (error instanceof Error) {
    // Use the constructor name, not error.name: a subclass that never assigns this.name still
    // inherits "Error", and its type name is exactly the safe structural fact worth keeping.
    const ctor = error.constructor?.name || error.name;
    const name = ctor === "Error" ? "" : `${ctor}: `;
    const message = `${name}${error.message}`;
    const denied = denyReason(message);
    if (denied) return { state: "omitted", reason: denied };
    return project(message, MAX_SAFE_TEXT_BYTES);
  }
  if (error === null || error === undefined)
    return { state: "projected", text: "null" };
  const kind =
    typeof error === "object"
      ? ((error as object).constructor?.name ?? "Object")
      : (error.constructor?.name ?? typeof error);
  return { state: "projected", text: kind };
}
