import type { SafeText, SafeValue } from "../../../../shared/ai-observability";
import { canonicalJson } from "../datasets";

/**
 * The deterministic rule scorer (Issue #32 / DAG T26).
 *
 * An experiment's rule set lives inside the frozen judge config (T22): the submitter composes
 * it, `freezeExperimentConfig` projects it, and the database freezes it. This module never sees
 * raw content on either side — rules arrive as the projected `judgeConfig` envelope, outputs
 * arrive as projection envelopes (T05/T19) — so there is no code path that scores a secret: a
 * withheld or cut value is classified, never read as text. The one doctrine: only fully
 * projected content is scored; everything else is an explicit error, never a 0.
 *
 * ## Operators (the closed, documented set)
 *
 * Every rule is a flat object — the freeze's depth cap (4) forbids structured rule fields, so
 * the shape below is not a convention, it is what can survive the freeze at all.
 *
 * | kind          | fields                                            | passes when… |
 * |---------------|---------------------------------------------------|--------------|
 * | exact_match   | expected: string, caseSensitive?: boolean         | the output text (a structured output is scored as its canonical JSON, keys sorted) equals expected |
 * | contains      | expected: string, caseSensitive?: boolean         | expected is a substring of the output text |
 * | regex         | pattern: string, flags?: subset of "imsu"         | pattern matches the output text; `g`/`y` are refused — they carry per-call state |
 * | numeric       | op: ">" ">=" "<" "<=" "==" "!=", expected: number | the whole output parses as one finite number (text: trimmed; structured: a number at the root) and the comparison holds |
 * | json_path     | path, assert, expected?                           | the path resolves in the output and the assertion holds |
 *
 * `path` grammar: `key.key2[0].key3` — keys `[A-Za-z0-9_-]+`, indexes `[0-9]+`, at most 16
 * segments / 128 bytes. `assert` ∈ exists | equals | contains | gt | gte | lt | lte; `expected`
 * is a primitive required by every assert except `exists`. A text output is parsed as JSON; a
 * structured output is walked through its projection envelopes.
 *
 * ## Failure taxonomy (Issue #32 AC4 — a failure is never a score of 0)
 *
 * - `RULE_SYNTAX_INVALID` (per rule): the rule is unscorable — bad regex/flags, bad path, bad
 *   op, missing or mistyped operand. The other rules still score.
 * - `EVALUATION_TIMEOUT` (run level, rest of the rules): the deterministic evaluation budget
 *   ran out. Same inputs spend it identically — the "clock" is a byte-derived cost model, not
 *   wall time, so determinism holds. A native regex call that has already been afforded cannot
 *   be interrupted; hard wall-clock kills belong to the execution orchestrator (T23/T24).
 * - `OUTPUT_MISSING` (run level or per rule): no scoreable output — absent, withheld by the
 *   redaction policy, truncated, or not a projection envelope at all. For structured outputs a
 *   `json_path` rule that resolves into a withheld leaf is a per-rule error; unaffected paths
 *   still score.
 *
 * A rule that evaluates to false is `failed` with an explicit reason (not_equal, non_numeric,
 * path_missing, …) — data-shaped facts, not system failures, so 0 is truthful for them.
 *
 * Extraction (`extractRuleSet`) is the provenance gate: it refuses anything that is not an
 * intact frozen rule set (envelope not fully projected anywhere in the `rules` subtree, rules
 * absent / not an array / past the freeze's 64-item array cap, unknown or structured rule
 * fields) and answers deep-frozen rules, so runtime mutation cannot quietly rewrite a score.
 */

/** Aligned with the projection's array cap — a longer rule set cannot freeze intact anyway. */
export const MAX_RULES_PER_SET = 64;
export const MAX_REGEX_PATTERN_BYTES = 512;
export const MAX_RULE_ID_BYTES = 128;
export const MAX_PATH_BYTES = 128;
export const MAX_PATH_SEGMENTS = 16;
/**
 * The deterministic budget, in byte-derived cost units. Every operator application costs the
 * subject's byte length (regex ×8, json_path +8 per path segment); an operator is only started
 * when the budget affords it, so budget exhaustion is a function of the inputs alone.
 */
export const DEFAULT_EVALUATION_BUDGET = 1_000_000;
export const REGEX_COST_MULTIPLIER = 8;

export type NumericComparison = ">" | ">=" | "<" | "<=" | "==" | "!=";
export type JsonPathAssertion =
  | "exists"
  | "equals"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export const RULE_KINDS = [
  "exact_match",
  "contains",
  "regex",
  "numeric",
  "json_path",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** The field vocabulary a frozen rule may carry; anything else refuses extraction. */
const RULE_FIELDS = new Set([
  "id",
  "kind",
  "expected",
  "caseSensitive",
  "pattern",
  "flags",
  "op",
  "path",
  "assert",
]);

const NUMERIC_COMPARISONS = new Set([">", ">=", "<", "<=", "==", "!="]);
const JSON_PATH_ASSERTIONS = new Set([
  "exists",
  "equals",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
]);
/** `g` and `y` keep call state in `lastIndex` — nondeterminism, refused. */
const REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

export type ScoringRule = Readonly<
  | {
      id: string;
      kind: "exact_match";
      expected: string;
      caseSensitive?: boolean;
    }
  | { id: string; kind: "contains"; expected: string; caseSensitive?: boolean }
  | { id: string; kind: "regex"; pattern: string; flags?: string }
  | { id: string; kind: "numeric"; op: NumericComparison; expected: number }
  | {
      id: string;
      kind: "json_path";
      path: string;
      assert: JsonPathAssertion;
      expected?: string | number | boolean | null;
    }
>;

/** The rule set exactly as `extractRuleSet` answers it — the only provenance T23 should pass on. */
export type ExtractedRuleSet = Readonly<{ rules: readonly ScoringRule[] }>;

export type RuleSetErrorCode = "RULESET_UNAVAILABLE";

export type ExtractRuleSetResult =
  | { ok: true; rules: readonly ScoringRule[] }
  | { ok: false; code: RuleSetErrorCode; message: string };

export type ScoringFailureCode =
  | "RULE_SYNTAX_INVALID"
  | "EVALUATION_TIMEOUT"
  | "OUTPUT_MISSING";

/** Data-shaped facts: the assertion ran and did not hold. A 0 here is truthful. */
export type ScoringFailReason =
  | "not_equal"
  | "not_contained"
  | "no_match"
  | "comparison_false"
  | "non_numeric"
  | "output_not_json"
  | "path_missing"
  | "not_a_string";

export type RuleScore =
  | { id: string; index: number; status: "passed" }
  | { id: string; index: number; status: "failed"; reason: ScoringFailReason }
  | {
      id: string;
      index: number;
      status: "error";
      code: ScoringFailureCode;
      message: string;
    };

export type ScoringRunError = Readonly<{
  code: "OUTPUT_MISSING" | "EVALUATION_TIMEOUT";
  message: string;
}>;

export type ScoringRunResult = Readonly<{
  /** One row per rule, in rule order — every rule answers, errored or not. */
  results: readonly RuleScore[];
  /** Present only when the run could not be evaluated as a whole. */
  error?: ScoringRunError;
}>;

/** What a run's projection answers: text or structured, or nothing scoreable. */
export type ScoredOutput = SafeText | SafeValue | null | undefined;

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

function isEnvelopeShape(node: unknown): node is SafeValue | SafeText {
  if (!node || typeof node !== "object") return false;
  const state: unknown = (node as { state?: unknown }).state;
  return state === "projected" || state === "omitted" || state === "truncated";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function unavailable(message: string): ExtractRuleSetResult {
  return { ok: false, code: "RULESET_UNAVAILABLE", message };
}

/**
 * Pull the rule set out of a frozen judge config. Fail-closed: one withheld or cut leaf
 * anywhere in the `rules` subtree means the frozen config is not what was submitted, and the
 * answer is a refusal — a rule set the redaction policy edited is a rule set this scorer will
 * not score. The returned rules are deep-frozen; strict-mode mutation attempts throw.
 */
export function extractRuleSet(judgeConfig: SafeValue): ExtractRuleSetResult {
  if (judgeConfig.state !== "projected") {
    return unavailable(
      `judge config is ${judgeConfig.state}, not projected: no intact rule set exists`,
    );
  }
  const root = judgeConfig.value;
  if (!isPlainObject(root)) {
    return unavailable(
      "judge config holds no rule set: value is not an object",
    );
  }
  const rulesNode = root.rules;
  if (!isEnvelopeShape(rulesNode)) {
    return unavailable("judge config holds no rule set: rules field missing");
  }
  if (rulesNode.state !== "projected") {
    return unavailable(
      `rules field is ${rulesNode.state}: the freeze did not keep it intact`,
    );
  }
  if (!("value" in rulesNode)) {
    return unavailable(
      "rules field is a text projection, not a structured one",
    );
  }
  const rulesArray = rulesNode.value;
  if (!Array.isArray(rulesArray)) {
    return unavailable("rules field is not an array");
  }
  if (rulesArray.length > MAX_RULES_PER_SET) {
    return unavailable(
      `rule set has ${rulesArray.length} rules, more than the freeze keeps intact (${MAX_RULES_PER_SET})`,
    );
  }

  const rules: ScoringRule[] = [];
  for (let i = 0; i < rulesArray.length; i++) {
    const element = rulesArray[i];
    if (!isEnvelopeShape(element)) {
      return unavailable(`rule ${i} is not a projection envelope`);
    }
    if (element.state !== "projected") {
      return unavailable(
        `rule ${i} is ${element.state} in the frozen config — the rule set was not kept intact`,
      );
    }
    if (!("value" in element)) {
      return unavailable(
        `rule ${i} is a text projection, not a structured one`,
      );
    }
    const rawRule = element.value;
    if (!isPlainObject(rawRule)) {
      return unavailable(`rule ${i} is not an object`);
    }
    const rule: Record<string, unknown> = {};
    for (const [field, fieldEnvelope] of Object.entries(rawRule)) {
      if (!RULE_FIELDS.has(field)) {
        return unavailable(
          `rule ${i} has unknown field ${JSON.stringify(field)}`,
        );
      }
      if (
        !isEnvelopeShape(fieldEnvelope) ||
        fieldEnvelope.state !== "projected" ||
        !("value" in fieldEnvelope)
      ) {
        return unavailable(
          `rule ${i} field ${field} is not intact in the frozen config`,
        );
      }
      const value: unknown = fieldEnvelope.value;
      if (!isPrimitive(value)) {
        return unavailable(
          `rule ${i} field ${field} is not a primitive — structured rule fields cannot survive the freeze`,
        );
      }
      rule[field] = value;
    }
    rules.push(rule as ScoringRule);
    Object.freeze(rule);
  }
  return { ok: true, rules: Object.freeze(rules) };
}

type PathTokens = readonly (string | number)[];

const PATH_PART = /^([A-Za-z0-9_-]*)((?:\[\d+\])*)$/;

/** `a.b[0].c` → ["a","b",0,"c"]; anything the grammar does not name is a syntax error. */
function parsePath(
  path: unknown,
): { ok: true; tokens: PathTokens } | { ok: false; message: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, message: "path must be a non-empty string" };
  }
  if (utf8Bytes(path) > MAX_PATH_BYTES) {
    return { ok: false, message: `path exceeds ${MAX_PATH_BYTES} bytes` };
  }
  const tokens: (string | number)[] = [];
  for (const part of path.split(".")) {
    const match = PATH_PART.exec(part);
    if (!match || (!match[1] && !match[2])) {
      return {
        ok: false,
        message: `path segment ${JSON.stringify(part)} is invalid`,
      };
    }
    if (match[1]) tokens.push(match[1]);
    for (const index of match[2].match(/\[\d+\]/g) ?? []) {
      tokens.push(Number(index.slice(1, -1)));
    }
  }
  if (tokens.length === 0 || tokens.length > MAX_PATH_SEGMENTS) {
    return {
      ok: false,
      message: `path must have 1..${MAX_PATH_SEGMENTS} segments`,
    };
  }
  return { ok: true, tokens };
}

type PathResolution =
  | { resolved: unknown }
  | { missing: true }
  | { unavailable: string };

/** Walk a projection envelope tree; a withheld or cut node on the path is unavailable. */
function walkEnvelopes(root: SafeValue, tokens: PathTokens): PathResolution {
  let node: SafeValue | SafeText = root;
  for (const token of tokens) {
    if (node.state !== "projected") return { unavailable: node.state };
    if (!("value" in node)) return { unavailable: "malformed" };
    const current = node.value;
    if (typeof token === "string") {
      if (!isPlainObject(current) || !Object.hasOwn(current, token)) {
        return { missing: true };
      }
      const next: unknown = current[token];
      if (!isEnvelopeShape(next)) return { unavailable: "malformed" };
      node = next;
    } else {
      if (!Array.isArray(current) || token >= current.length) {
        return { missing: true };
      }
      const next: unknown = current[token];
      if (!isEnvelopeShape(next)) return { unavailable: "malformed" };
      node = next;
    }
  }
  if (node.state !== "projected") return { unavailable: node.state };
  if (!("value" in node)) return { unavailable: "malformed" };
  return { resolved: node.value };
}

/** Walk the plain JSON a text output parsed into. */
function walkPlain(value: unknown, tokens: PathTokens): PathResolution {
  let current: unknown = value;
  for (const token of tokens) {
    if (typeof token === "string") {
      if (!isPlainObject(current) || !Object.hasOwn(current, token)) {
        return { missing: true };
      }
      current = current[token];
    } else {
      if (!Array.isArray(current) || token >= current.length) {
        return { missing: true };
      }
      current = current[token];
    }
  }
  return { resolved: current };
}

/** Unwrap a whole envelope tree to plain JSON for the text operators; fail on any imperfection. */
function unwrapWhole(
  node: SafeValue,
): { ok: true; value: unknown } | { ok: false } {
  if (node.state !== "projected") return { ok: false };
  const value = node.value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (!isEnvelopeShape(item) || !("value" in item)) return { ok: false };
      const unwrapped = unwrapWhole(item);
      if (!unwrapped.ok) return unwrapped;
      out.push(unwrapped.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (!isEnvelopeShape(child) || !("value" in child)) return { ok: false };
      const unwrapped = unwrapWhole(child);
      if (!unwrapped.ok) return unwrapped;
      out[key] = unwrapped.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

/** The only SafeValue variant prepareOutput answers — state is checked, not trusted. */
type ProjectedValue = Extract<SafeValue, { state: "projected" }>;

type PreparedOutput =
  | { kind: "text"; text: string }
  | { kind: "value"; value: ProjectedValue };

/**
 * Refuse anything that is not a fully projected envelope: absent, withheld, cut, or raw
 * unprojected content. Answers a message for run-level OUTPUT_MISSING, or the scoreable form.
 */
function prepareOutput(output: ScoredOutput): PreparedOutput | string {
  if (output === null || output === undefined) {
    return "the run produced no output";
  }
  if (!isEnvelopeShape(output)) {
    return "output is not a projection envelope — raw content is never scored";
  }
  if (output.state === "omitted") {
    return `output withheld by redaction policy (reason: ${output.reason})`;
  }
  if (output.state === "truncated") {
    return "output was truncated by the projection before scoring";
  }
  if ("text" in output) {
    return { kind: "text", text: output.text };
  }
  if ("value" in output) {
    return { kind: "value", value: output };
  }
  return "output is not a projection envelope — raw content is never scored";
}

/**
 * Score one run's projected output against an extracted rule set. Pure: same rule set, same
 * output envelope, same budget → the same result object tree, every call — no clock, no
 * randomness, no cross-call state (regex flags `g`/`y` are refused precisely because they
 * carry state). Data-shaped non-matches are `failed` with a reason; system-shaped failures are
 * `error` rows and, when they abort the run, a run-level `error`.
 */
export function scoreRunOutput(
  ruleSet: ExtractedRuleSet,
  output: ScoredOutput,
  opts: { budget?: number } = {},
): ScoringRunResult {
  const budget = opts.budget ?? DEFAULT_EVALUATION_BUDGET;
  const rules = ruleSet.rules ?? [];

  const rowId = (rule: unknown, index: number): string => {
    const maybeId = (rule as { id?: unknown } | null)?.id;
    return typeof maybeId === "string" && maybeId.length > 0
      ? maybeId
      : `rule[${index}]`;
  };
  const errorRows = (code: ScoringFailureCode, message: string): RuleScore[] =>
    rules.map((rule, index) => ({
      id: rowId(rule, index),
      index,
      status: "error" as const,
      code,
      message,
    }));

  // The canary gate: an output that is not a fully projected envelope is never scored.
  const prepared = prepareOutput(output);
  if (typeof prepared === "string") {
    return {
      results: errorRows("OUTPUT_MISSING", prepared),
      error: { code: "OUTPUT_MISSING", message: prepared },
    };
  }

  // The text subject, for exact_match/contains/regex: a structured output unwraps to its
  // canonical JSON (keys sorted — key order is not identity); any withheld or cut leaf makes
  // the whole text subject untrustworthy, which the text operators report per rule.
  const textSubject = (): { ok: true; text: string } | { ok: false } => {
    if (prepared.kind === "text") return { ok: true, text: prepared.text };
    const unwrapped = unwrapWhole(prepared.value);
    return unwrapped.ok
      ? { ok: true, text: canonicalJson(unwrapped.value) }
      : { ok: false };
  };
  const subject = textSubject();
  const subjectBytes = subject.ok ? utf8Bytes(subject.text) : 0;

  const results: RuleScore[] = [];
  let spent = 0;
  let timedOutAt: number | null = null;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index] as Record<string, unknown>;
    const id = rowId(rule, index);
    const syntaxError = (message: string): void => {
      results.push({
        id,
        index,
        status: "error",
        code: "RULE_SYNTAX_INVALID",
        message,
      });
    };

    // Validate syntax first — an unscorable rule never consumes budget.
    const kind = rule.kind;
    if (typeof kind !== "string" || !RULE_KINDS.includes(kind as RuleKind)) {
      syntaxError(`unknown kind ${JSON.stringify(kind)}`);
      continue;
    }
    if (
      typeof rule.id !== "string" ||
      rule.id.length === 0 ||
      utf8Bytes(rule.id) > MAX_RULE_ID_BYTES
    ) {
      syntaxError(
        `id must be a non-empty string of at most ${MAX_RULE_ID_BYTES} bytes`,
      );
      continue;
    }

    let cost: number;
    /** The validated json_path tokens — parsed once here, reused at evaluation below. */
    let pathTokens: PathTokens = [];
    switch (kind as RuleKind) {
      case "exact_match":
      case "contains": {
        if (typeof rule.expected !== "string") {
          syntaxError(`${kind} requires a string expected`);
          continue;
        }
        if (
          rule.caseSensitive !== undefined &&
          typeof rule.caseSensitive !== "boolean"
        ) {
          syntaxError("caseSensitive must be a boolean");
          continue;
        }
        cost = subjectBytes + utf8Bytes(rule.expected);
        break;
      }
      case "regex": {
        if (typeof rule.pattern !== "string" || rule.pattern.length === 0) {
          syntaxError("regex requires a non-empty string pattern");
          continue;
        }
        if (utf8Bytes(rule.pattern) > MAX_REGEX_PATTERN_BYTES) {
          syntaxError(`pattern exceeds ${MAX_REGEX_PATTERN_BYTES} bytes`);
          continue;
        }
        if (rule.flags !== undefined && typeof rule.flags !== "string") {
          syntaxError("flags must be a string");
          continue;
        }
        const flags = (rule.flags as string | undefined) ?? "";
        if (![...flags].every((flag) => REGEX_FLAGS.has(flag))) {
          syntaxError(
            `flags must be a subset of "imsu" (got ${JSON.stringify(flags)})`,
          );
          continue;
        }
        try {
          void new RegExp(rule.pattern, flags);
        } catch (cause) {
          syntaxError(`pattern does not compile: ${(cause as Error).message}`);
          continue;
        }
        cost = (subjectBytes + utf8Bytes(rule.pattern)) * REGEX_COST_MULTIPLIER;
        break;
      }
      case "numeric": {
        if (typeof rule.op !== "string" || !NUMERIC_COMPARISONS.has(rule.op)) {
          syntaxError(
            `op must be one of > >= < <= == != (got ${JSON.stringify(rule.op)})`,
          );
          continue;
        }
        if (
          typeof rule.expected !== "number" ||
          !Number.isFinite(rule.expected)
        ) {
          syntaxError("numeric requires a finite number expected");
          continue;
        }
        cost = subjectBytes;
        break;
      }
      case "json_path": {
        if (
          typeof rule.assert !== "string" ||
          !JSON_PATH_ASSERTIONS.has(rule.assert)
        ) {
          syntaxError(
            "assert must be one of exists equals contains gt gte lt lte",
          );
          continue;
        }
        const parsed = parsePath(rule.path);
        if (!parsed.ok) {
          syntaxError(parsed.message);
          continue;
        }
        if (rule.assert !== "exists" && rule.expected === undefined) {
          syntaxError(`assert ${rule.assert} requires expected`);
          continue;
        }
        pathTokens = parsed.tokens;
        cost = subjectBytes + parsed.tokens.length * 8;
        break;
      }
    }

    // Only start an operator the budget can afford — deterministically.
    if (spent + cost > budget) {
      timedOutAt = index;
      break;
    }
    spent += cost;

    // Evaluate. Every branch answers exactly one row.
    const evaluate = (): void => {
      const fold = (text: string): string =>
        rule.caseSensitive === false ? text.toLowerCase() : text;

      if (kind === "exact_match" || kind === "contains") {
        if (!subject.ok) {
          results.push({
            id,
            index,
            status: "error",
            code: "OUTPUT_MISSING",
            message:
              "structured output has a withheld or cut leaf — not scoreable as text",
          });
          return;
        }
        const haystack = fold(subject.text);
        const needle = fold(rule.expected as string);
        const passed =
          kind === "exact_match"
            ? haystack === needle
            : haystack.includes(needle);
        results.push(
          passed
            ? { id, index, status: "passed" }
            : {
                id,
                index,
                status: "failed",
                reason: kind === "exact_match" ? "not_equal" : "not_contained",
              },
        );
        return;
      }

      if (kind === "regex") {
        if (!subject.ok) {
          results.push({
            id,
            index,
            status: "error",
            code: "OUTPUT_MISSING",
            message:
              "structured output has a withheld or cut leaf — not scoreable as text",
          });
          return;
        }
        const passed = new RegExp(
          rule.pattern as string,
          (rule.flags as string | undefined) ?? "",
        ).test(subject.text);
        results.push(
          passed
            ? { id, index, status: "passed" }
            : { id, index, status: "failed", reason: "no_match" },
        );
        return;
      }

      if (kind === "numeric") {
        const number: number | null =
          prepared.kind === "text"
            ? Number.isFinite(Number(prepared.text.trim()))
              ? Number(prepared.text.trim())
              : null
            : typeof prepared.value.value === "number" &&
                Number.isFinite(prepared.value.value)
              ? prepared.value.value
              : null;
        if (number === null) {
          results.push({ id, index, status: "failed", reason: "non_numeric" });
          return;
        }
        const expected = rule.expected as number;
        const passed = {
          ">": number > expected,
          ">=": number >= expected,
          "<": number < expected,
          "<=": number <= expected,
          "==": number === expected,
          "!=": number !== expected,
        }[rule.op as NumericComparison];
        results.push(
          passed
            ? { id, index, status: "passed" }
            : { id, index, status: "failed", reason: "comparison_false" },
        );
        return;
      }

      // json_path: a text output is parsed as JSON; a structured one walks its envelopes.
      const tokens = pathTokens;
      let notJson = false;
      let resolution: PathResolution;
      if (prepared.kind === "text") {
        try {
          resolution = walkPlain(JSON.parse(prepared.text), tokens);
        } catch {
          notJson = true;
          resolution = { missing: true };
        }
      } else {
        resolution = walkEnvelopes(prepared.value, tokens);
      }

      if (notJson) {
        results.push({
          id,
          index,
          status: "failed",
          reason: "output_not_json",
        });
        return;
      }
      if ("missing" in resolution) {
        results.push({ id, index, status: "failed", reason: "path_missing" });
        return;
      }
      if ("unavailable" in resolution) {
        results.push({
          id,
          index,
          status: "error",
          code: "OUTPUT_MISSING",
          message: `path resolves into a ${resolution.unavailable} projection leaf — withheld or cut, never scored`,
        });
        return;
      }

      const assert = rule.assert as JsonPathAssertion;
      const value = resolution.resolved;
      if (assert === "exists") {
        results.push({ id, index, status: "passed" });
        return;
      }
      if (assert === "equals") {
        const passed = value === (rule.expected as unknown);
        results.push(
          passed
            ? { id, index, status: "passed" }
            : { id, index, status: "failed", reason: "not_equal" },
        );
        return;
      }
      if (assert === "contains") {
        const passed =
          typeof value === "string" && value.includes(rule.expected as string);
        results.push(
          passed
            ? { id, index, status: "passed" }
            : {
                id,
                index,
                status: "failed",
                reason:
                  typeof value === "string" ? "not_contained" : "not_a_string",
              },
        );
        return;
      }
      const passed =
        typeof value === "number" && Number.isFinite(value)
          ? {
              gt: value > (rule.expected as number),
              gte: value >= (rule.expected as number),
              lt: value < (rule.expected as number),
              lte: value <= (rule.expected as number),
            }[assert]
          : false;
      results.push(
        passed
          ? { id, index, status: "passed" }
          : {
              id,
              index,
              status: "failed",
              reason:
                typeof value === "number" ? "comparison_false" : "non_numeric",
            },
      );
    };
    evaluate();
  }

  if (timedOutAt !== null) {
    const message = `evaluation budget of ${budget} cost units exhausted before rule ${timedOutAt}`;
    for (let index = timedOutAt; index < rules.length; index++) {
      results.push({
        id: rowId(rules[index], index),
        index,
        status: "error",
        code: "EVALUATION_TIMEOUT",
        message,
      });
    }
    return { results, error: { code: "EVALUATION_TIMEOUT", message } };
  }
  return { results };
}
