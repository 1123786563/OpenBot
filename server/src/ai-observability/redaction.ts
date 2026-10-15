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
  SafeRecord,
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
  // scheme://user:pass@host is a credential at every entrance, not just the URL one: an https
  // basic-auth endpoint pasted into prose, a span name or a metadata leaf used to leak as-is,
  // because it was not on the DB/MQ scheme list above (review finding F1).
  {
    reason: "credential",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@/,
  },
  { reason: "credential", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  {
    reason: "credential",
    pattern: /\bsk-(?:live|test|proj)-[A-Za-z0-9._-]{16,}/,
  },
  { reason: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // A PEM header is five dashes and BEGIN: it needs no word-character anchor. Real PEM sits at a
  // line start, after a newline, space or quote — exactly where a \b anchor never fires. Match
  // case-insensitively: some tools emit the lowercase form RFC 7468 forbids (review finding F7).
  {
    reason: "credential",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  },
  { reason: "account_identifier", pattern: /\bacct_[A-Za-z0-9]{12,}\b/ },
  { reason: "account_identifier", pattern: /\bcus_[A-Za-z0-9]{12,}\b/ },
  { reason: "internal_capability", pattern: /\bopenbot\.internal\.[\w./-]+/i },
  // Chain-of-thought markers: <reasoning> and the <think>/<thinking> family open models emit
  // inline. A lone close tag means the head was cut off, which is still reasoning content
  // (review finding F3).
  {
    reason: "reasoning_content",
    pattern: /<\s*\/?\s*(?:reasoning|think(?:ing)?)\s*>/i,
  },
];

// A 40-char base64 run is only a secret in credential context, but that context can be on either
// side at any distance: config files and env dumps put the label before the value with arbitrary
// filler between. A single regex can only look one direction, and the unbounded lookahead that
// looked forward was quadratic on adversarial input — one '=' every 41 characters manufactures a
// word-boundary candidate per chunk (review findings F2 and F5). Two single-pass tests instead:
// deny when a labelled context and a candidate run coexist in the same string. An unlabeled run
// stays projectable in reviewed text — it is indistinguishable from any other base64 run.
const SECRET_LABEL =
  /(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key)/i;
const SECRET_RUN = /\b[A-Za-z0-9/+=]{40}\b/;

function hasLabelledSecret(input: string): boolean {
  return SECRET_RUN.test(input) && SECRET_LABEL.test(input);
}

/**
 * The structural deny verdict for a whole string. Exported for the id-mapping store
 * (Issue #23/T17): an id that matches a credential class is refused before anything is
 * stored — the mapping's columns are identifiers, and a canary-shaped identifier is a
 * leak with an index on it.
 */
export function denyReason(input: string): OmitReason | undefined {
  for (const { reason, pattern } of DENY) {
    if (pattern.test(input)) return reason;
  }
  if (hasLabelledSecret(input)) return "credential";
  return undefined;
}

/** Cut on a UTF-8 byte budget without splitting a character or stranding a surrogate. */
function cutToBytes(input: string, budget: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= budget) return input;
  // Binary-search the longest prefix that fits the byte budget.
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  // The cut can land between a surrogate pair: the lone half is not the U+FFFD character, it only
  // *encodes* to those bytes, so the guard has to run on code units, not on the character.
  let end = low;
  const last = input.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return input.slice(0, end);
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
  // Normalize before matching: a trailing dot is the DNS root-label spelling of the same host
  // (`localhost.` resolves to 127.0.0.1) and walks past a plain string comparison (review
  // finding N1). Case, punycode and the IPv4 spellings are already normalized by the URL
  // parser — pinned by test — so stripping trailing dots is all that is ours to do.
  const hostname = url.hostname.replace(/\.+$/, "");
  const isLoopback = [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "::1",
    "0.0.0.0",
    // The URL parser normalizes the IPv4-mapped loopback to its canonical hex spelling.
    "[::ffff:7f00:1]",
  ].includes(hostname);
  // The link-local block: 169.254.169.254 answers anyone who asks with cloud credentials, and
  // following it hands the reader exactly what this projection refuses to carry (review finding F4).
  const isLinkLocal = /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (isRawFile || isLoopback || isLinkLocal)
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

export type { SafeRecord };

/**
 * Define an own enumerable property. A plain `out[key] = value` routes a `__proto__` key through
 * Object.prototype's setter and hijacks the accumulator's prototype instead of recording the key
 * (review finding T05-F5).
 */
function defineOwn(
  out: Record<string, SafeValue>,
  key: string,
  value: SafeValue,
): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasOwn(source: object, key: string): boolean {
  // The descriptor trap is attacker code as well: a throw reads as "not an own key" and the
  // entry is skipped, never propagated — the export loop must not crash on hostile records
  // (T05 review residual O2, closed in policy v5).
  try {
    return Object.hasOwn(source, key);
  } catch {
    return false;
  }
}

/**
 * Read an own property defensively: an accessor or Proxy trap that throws must degrade to an
 * omitted value, not abort the export loop — SDK auto-captured records are the least trusted
 * input in the system (review finding F6).
 */
function readOwn(
  source: Record<string, unknown>,
  key: string,
): { threw: boolean; value?: unknown } {
  try {
    return { threw: false, value: source[key] };
  } catch {
    return { threw: true };
  }
}

/** UTF-8 byte size of the JSON form; -1 when the value cannot be serialized (e.g. BigInt). */
function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return -1;
  }
}

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
    // An array is attacker code's surface too: slice and length run Proxy get traps the
    // readOwn guard below never sees, so a throw degrades to omitted instead of aborting
    // the caller's export loop (T05 review residual O1, closed in policy v5).
    let kept: SafeValue[];
    let length: number;
    try {
      kept = value
        .slice(0, MAX_SAFE_RECORD_KEYS)
        .map((item) => projectDeep(item, depth + 1));
      length = value.length;
    } catch {
      return { state: "omitted", reason: "unhandled_free_text" };
    }
    // A cap that drops items silently is a lie told as `projected` (review finding T05-F6).
    if (length > MAX_SAFE_RECORD_KEYS) {
      return {
        state: "truncated",
        value: kept,
        originalBytes: jsonBytes(value),
        dropped: length - MAX_SAFE_RECORD_KEYS,
      };
    }
    return { state: "projected", value: kept };
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    // Object.keys itself runs Proxy traps (ownKeys, getOwnPropertyDescriptor) — attacker code
    // that can throw past the readOwn guard or fabricate key names, where the value deny scan
    // never looks (review finding N3). Read the list defensively and drop deny-matching keys
    // outright: rendering them as omitted would echo the hostile key name into the output.
    let keys: string[];
    try {
      keys = Object.keys(source);
    } catch {
      return { state: "omitted", reason: "unhandled_free_text" };
    }
    const out: Record<string, SafeValue> = {};
    for (const key of keys.slice(0, MAX_SAFE_RECORD_KEYS)) {
      if (denyReason(key)) continue;
      const read = readOwn(source, key);
      defineOwn(
        out,
        key,
        read.threw
          ? { state: "omitted", reason: "unhandled_free_text" }
          : projectDeep(read.value, depth + 1),
      );
    }
    if (keys.length > MAX_SAFE_RECORD_KEYS) {
      return {
        state: "truncated",
        value: out,
        originalBytes: jsonBytes(value),
        dropped: keys.length - MAX_SAFE_RECORD_KEYS,
      };
    }
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
  // The allowlist is caller code, not data: a list longer than the cap is a defect to fix at the
  // call site, and silently slicing it would drop keys without a trace (review finding T05-F6).
  if (allowlist.length > MAX_SAFE_RECORD_KEYS) {
    throw new TypeError(
      `allowlist has ${allowlist.length} keys, more than MAX_SAFE_RECORD_KEYS (${MAX_SAFE_RECORD_KEYS}); refusing to silently drop the rest`,
    );
  }
  const source = record as Record<string, unknown>;
  const out: SafeRecord = {};
  for (const key of allowlist) {
    // Own keys only: `in` would let an allowlist entry naming "toString" fabricate a key.
    if (!hasOwn(source, key)) continue;
    const read = readOwn(source, key);
    if (read.threw) {
      defineOwn(out, key, { state: "omitted", reason: "unhandled_free_text" });
      continue;
    }
    if (typeof read.value === "string") {
      defineOwn(out, key, projectLeaf(read.value));
      continue;
    }
    defineOwn(out, key, projectDeep(read.value, 1));
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
 * Structured fixtures whose shape the case author defines (Issue #25). A dataset case's tool
 * fixture is not SDK metadata — its keys are not on any allowlist — but it is still content on
 * its way into a frozen, exportable snapshot, so it gets the deep projection: keys and values
 * through the deny scan, the record caps, and no assumption about what the author's shape is.
 */
export function projectSafeFixture(fixture: unknown): SafeValue {
  return projectDeep(fixture, 1);
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
