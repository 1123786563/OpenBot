import { describe, expect, test } from "bun:test";
import type { SafeText, SafeValue } from "../../shared/ai-observability";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import {
  projectSafeFixture,
  projectSafeText,
} from "../src/ai-observability/redaction";
import {
  DEFAULT_EVALUATION_BUDGET,
  extractRuleSet,
  MAX_RULES_PER_SET,
  regexHasNestedQuantifiers,
  type ScoringRule,
  scoreRunOutput,
} from "../src/ai-observability/scoring/rules";

/**
 * Unit contract of the deterministic rule scorer (Issue #32 / DAG T26). Everything here is the
 * pure seam: rules come out of a really-frozen judge config (freezeExperimentConfig, never a
 * hand-drawn envelope), outputs arrive as real projection envelopes, and the assertions pin the
 * three failure classes, the freeze-tamper refusal, the canary doctrine (withheld content is
 * classified, never scored) and same-input-same-output determinism. No database, no LLM, no clock.
 */

/** Freeze a judge config through the real T22 pipeline and hand back just its envelope. */
function frozenJudgeConfig(raw: Record<string, unknown>): SafeValue {
  return freezeExperimentConfig({
    botConfig: {},
    prompt: "summarize",
    modelName: "test-model",
    modelParameters: {},
    toolFixtures: {},
    judgeConfig: raw,
    judgeVersion: "rules-1",
  }).judgeConfig;
}

/** A projected text output — what T23/T24 will hand the scorer after a run. */
const textOutput = (text: string): SafeText =>
  projectSafeText(text, { allowFreeText: true });

const RULE_SET = {
  rules: [
    {
      id: "exact",
      kind: "exact_match",
      expected: "Paris",
      caseSensitive: true,
    },
    { id: "ci", kind: "contains", expected: "PARIS", caseSensitive: false },
    { id: "re", kind: "regex", pattern: "^P\\w+s$", flags: "" },
    { id: "num", kind: "numeric", op: ">", expected: 10 },
    {
      id: "jp",
      kind: "json_path",
      path: "cities[0].name",
      assert: "equals",
      expected: "Paris",
    },
  ],
};

describe("extractRuleSet refuses anything that is not an intact frozen rule set", () => {
  test("a real freeze of the five operators round-trips into plain rules", () => {
    const res = extractRuleSet(frozenJudgeConfig(RULE_SET));
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    expect(res.rules).toEqual(RULE_SET.rules);
    // Extra judge settings outside `rules` are not the scorer's business.
    const withExtra = extractRuleSet(
      frozenJudgeConfig({ ...RULE_SET, llmJudge: { model: "x" } }),
    );
    expect(withExtra).toMatchObject({ ok: true });
  });

  test("an omitted or truncated judge config envelope is unavailable, never empty rules", () => {
    expect(
      extractRuleSet({ state: "omitted", reason: "credential" }),
    ).toMatchObject({ ok: false, code: "RULESET_UNAVAILABLE" });
    expect(
      extractRuleSet({ state: "truncated", value: null, originalBytes: 99 }),
    ).toMatchObject({ ok: false, code: "RULESET_UNAVAILABLE" });
  });

  test("rules absent, not an array, or past the freeze's array cap refuse", () => {
    expect(extractRuleSet(frozenJudgeConfig({}))).toMatchObject({
      ok: false,
      code: "RULESET_UNAVAILABLE",
    });
    expect(extractRuleSet(frozenJudgeConfig({ rules: "nope" }))).toMatchObject({
      ok: false,
      code: "RULESET_UNAVAILABLE",
    });
    const tooMany = {
      rules: Array.from({ length: MAX_RULES_PER_SET + 1 }, (_, i) => ({
        id: `r${i}`,
        kind: "contains",
        expected: "x",
      })),
    };
    // 65 rules cannot survive the freeze intact (it truncates at 64), so the real pipeline
    // already answers truncated — and extraction must refuse either way.
    const frozen = frozenJudgeConfig(tooMany);
    const rulesNode = (frozen.value as Record<string, SafeValue>).rules;
    expect(rulesNode.state).toBe("truncated");
    expect(extractRuleSet(frozen)).toMatchObject({
      ok: false,
      code: "RULESET_UNAVAILABLE",
    });
  });

  test("a secret frozen into a rule withholds the leaf — the whole set is refused (canary)", () => {
    const res = extractRuleSet(
      frozenJudgeConfig({
        rules: [
          {
            id: "leak",
            kind: "contains",
            expected: "sk-live-abcdefghijklmnop1234",
          },
        ],
      }),
    );
    expect(res).toMatchObject({ ok: false, code: "RULESET_UNAVAILABLE" });
  });

  test("unknown fields and structured rule fields are refused, not ignored", () => {
    expect(
      extractRuleSet(
        frozenJudgeConfig({
          rules: [{ id: "x", kind: "contains", expected: "a", weight: 2 }],
        }),
      ),
    ).toMatchObject({ ok: false, code: "RULESET_UNAVAILABLE" });
    expect(
      extractRuleSet(
        frozenJudgeConfig({
          rules: [{ id: "x", kind: "contains", expected: { deep: 1 } }],
        }),
      ),
    ).toMatchObject({ ok: false, code: "RULESET_UNAVAILABLE" });
  });

  test("an empty rule set is legal — it scores nothing and reports no error", () => {
    const res = extractRuleSet(frozenJudgeConfig({ rules: [] }));
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    const scored = scoreRunOutput(res, textOutput("anything"));
    expect(scored.results).toEqual([]);
    expect(scored.error).toBeUndefined();
  });

  test("extracted rules are deep-frozen: mutation attempts throw and change nothing", () => {
    const res = extractRuleSet(frozenJudgeConfig(RULE_SET));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rules = res.rules as readonly ScoringRule[];
    expect(() => {
      (rules[0] as { expected: string }).expected = "tampered";
    }).toThrow();
    expect(() => {
      (rules as unknown as unknown[]).push({
        id: "x",
        kind: "contains",
        expected: "x",
      });
    }).toThrow();
    const before = scoreRunOutput(res, textOutput("Paris"));
    const after = scoreRunOutput(res, textOutput("Paris"));
    expect(after).toEqual(before);
  });
});

describe("operator truth tables", () => {
  const rules = (list: unknown[]) =>
    extractRuleSet(frozenJudgeConfig({ rules: list }));

  test("exact_match: equality, case fold, and mismatch", () => {
    const rs = rules([
      { id: "cs", kind: "exact_match", expected: "Paris", caseSensitive: true },
      {
        id: "ci",
        kind: "exact_match",
        expected: "paris",
        caseSensitive: false,
      },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(rs, textOutput("Paris")).results;
    expect(out[0]).toMatchObject({ id: "cs", status: "passed" });
    expect(out[1]).toMatchObject({ id: "ci", status: "passed" });
    const miss = scoreRunOutput(rs, textOutput("paris")).results;
    expect(miss[0]).toMatchObject({
      id: "cs",
      status: "failed",
      reason: "not_equal",
    });
    expect(miss[1]).toMatchObject({ id: "ci", status: "passed" });
  });

  test("contains: substring and case fold", () => {
    const rs = rules([
      { id: "c", kind: "contains", expected: "answer", caseSensitive: true },
      { id: "ci", kind: "contains", expected: "ANSWER", caseSensitive: false },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const hit = scoreRunOutput(rs, textOutput("The answer is 42.")).results;
    expect(hit[0]).toMatchObject({ status: "passed" });
    expect(hit[1]).toMatchObject({ status: "passed" });
    const miss = scoreRunOutput(rs, textOutput("The ANSWER is 42.")).results;
    expect(miss[0]).toMatchObject({
      status: "failed",
      reason: "not_contained",
    });
    expect(miss[1]).toMatchObject({ status: "passed" });
  });

  test("regex: match, no-match, i flag", () => {
    const rs = rules([
      { id: "m", kind: "regex", pattern: "^P\\w+s$", flags: "" },
      { id: "i", kind: "regex", pattern: "^paris$", flags: "i" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const hit = scoreRunOutput(rs, textOutput("Paris")).results;
    expect(hit[0]).toMatchObject({ status: "passed" });
    expect(hit[1]).toMatchObject({ status: "passed" });
    const miss = scoreRunOutput(rs, textOutput("Lyons")).results;
    expect(miss[0]).toMatchObject({ status: "failed", reason: "no_match" });
    expect(miss[1]).toMatchObject({ status: "failed", reason: "no_match" });
  });

  test("numeric: every comparison, trim, floats, negatives", () => {
    const rs = rules([
      { id: "gt", kind: "numeric", op: ">", expected: 10 },
      { id: "ge", kind: "numeric", op: ">=", expected: 10 },
      { id: "lt", kind: "numeric", op: "<", expected: 10 },
      { id: "le", kind: "numeric", op: "<=", expected: 10 },
      { id: "eq", kind: "numeric", op: "==", expected: 10 },
      { id: "ne", kind: "numeric", op: "!=", expected: 10 },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const ten = scoreRunOutput(rs, textOutput(" 10 ")).results;
    expect(ten.map((r) => r.status)).toEqual([
      "failed",
      "passed",
      "failed",
      "passed",
      "passed",
      "failed",
    ]);
    expect(ten[0]).toMatchObject({ reason: "comparison_false" });
    const neg = scoreRunOutput(rs, textOutput("-0.5")).results;
    expect(neg.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "passed",
      "passed",
      "failed",
      "passed",
    ]);
    const f = scoreRunOutput(rs, textOutput("10.0001")).results;
    expect(f[0]).toMatchObject({ status: "passed" });
    expect(f[2]).toMatchObject({
      status: "failed",
      reason: "comparison_false",
    });
  });

  test("numeric: non-numeric output is an explicit failed reason, never a silent 0", () => {
    const rs = rules([{ id: "n", kind: "numeric", op: ">", expected: 1 }]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    expect(scoreRunOutput(rs, textOutput("42abc")).results[0]).toMatchObject({
      status: "failed",
      reason: "non_numeric",
    });
    expect(scoreRunOutput(rs, textOutput("Infinity")).results[0]).toMatchObject(
      {
        reason: "non_numeric",
      },
    );
    // A structured output is compared at its root: a number scores, an object does not.
    expect(scoreRunOutput(rs, projectSafeFixture(42)).results[0]).toMatchObject(
      { status: "passed" },
    );
    expect(
      scoreRunOutput(rs, projectSafeFixture({ a: 1 })).results[0],
    ).toMatchObject({ reason: "non_numeric" });
  });

  test("numeric: text parses only under the strict number grammar — implicit coercions never compare", () => {
    const rs = rules([{ id: "eq", kind: "numeric", op: "==", expected: 0 }]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    // Number("") === 0 and Number("0x10") === 16 — the loose conversions must not reach a
    // comparison; an empty or hex-literal text is honestly non_numeric.
    for (const text of ["", "   ", "0x10"]) {
      expect(scoreRunOutput(rs, textOutput(text)).results[0]).toMatchObject({
        status: "failed",
        reason: "non_numeric",
      });
    }
    // Strict grammar still accepts trimmed decimal, negative, float and exponent forms.
    const rs2 = rules([
      { id: "t", kind: "numeric", op: "==", expected: 10 },
      { id: "e", kind: "numeric", op: "==", expected: 1000 },
    ]);
    expect(rs2.ok).toBe(true);
    if (!rs2.ok) return;
    expect(scoreRunOutput(rs2, textOutput(" 10 ")).results[0]).toMatchObject({
      status: "passed",
    });
    expect(scoreRunOutput(rs2, textOutput("10.0")).results[0]).toMatchObject({
      status: "passed",
    });
    expect(scoreRunOutput(rs2, textOutput("1e3")).results[1]).toMatchObject({
      status: "passed",
    });
    expect(scoreRunOutput(rs2, textOutput("-5")).results[0]).toMatchObject({
      status: "failed",
      reason: "comparison_false",
    });
  });

  test("numeric: grammar-legal overflow literals stay non_numeric — finite is part of the contract", () => {
    // M2 (T26-rev2): "1e400" passes the strict grammar but Number() overflows to Infinity.
    // The isFinite gate must survive the grammar switch in both directions — and the `!=`
    // direction, where an unparseable output would otherwise earn a passing score.
    const rs = rules([
      { id: "gt", kind: "numeric", op: ">", expected: 5 },
      { id: "lt", kind: "numeric", op: "<", expected: -1e308 },
      { id: "ne", kind: "numeric", op: "!=", expected: 5 },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    for (const text of ["1e400", "-1e999", "9".repeat(400)]) {
      const rows = scoreRunOutput(rs, textOutput(text)).results;
      expect(rows[0]).toMatchObject({
        status: "failed",
        reason: "non_numeric",
      });
      expect(rows[1]).toMatchObject({
        status: "failed",
        reason: "non_numeric",
      });
      expect(rows[2]).toMatchObject({
        status: "failed",
        reason: "non_numeric",
      });
    }
    // Symmetry with the structured side: the same overflow (Number("1e400") is Infinity)
    // as a projected number root is already refused by its isFinite gate.
    expect(
      scoreRunOutput(rs, projectSafeFixture(Infinity)).results[0],
    ).toMatchObject({ status: "failed", reason: "non_numeric" });
  });

  test("json_path: deep nesting, every assert, arrays", () => {
    const rs = rules([
      {
        id: "deep",
        kind: "json_path",
        path: "a.b[0].c.d[2]",
        assert: "equals",
        expected: 42,
      },
      { id: "ex", kind: "json_path", path: "a.b[0].c.d", assert: "exists" },
      {
        id: "str",
        kind: "json_path",
        path: "a.b[0].name",
        assert: "contains",
        expected: "ari",
      },
      {
        id: "gt",
        kind: "json_path",
        path: "a.b[0].score",
        assert: "gt",
        expected: 0.5,
      },
      {
        id: "le",
        kind: "json_path",
        path: "a.b[0].score",
        assert: "lte",
        expected: 0.87,
      },
      {
        id: "nul",
        kind: "json_path",
        path: "a.b[0].note",
        assert: "equals",
        expected: null,
      },
      {
        id: "bool",
        kind: "json_path",
        path: "a.b[0].ok",
        assert: "equals",
        expected: true,
      },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(
      rs,
      textOutput(
        JSON.stringify({
          a: {
            b: [
              {
                name: "Paris",
                score: 0.87,
                note: null,
                ok: true,
                c: { d: [0, 1, 42] },
              },
            ],
          },
        }),
      ),
    ).results;
    expect(out.map((r) => r.status)).toEqual(Array(7).fill("passed"));
  });

  test("json_path: missing path, non-JSON output, non-string contains, non-numeric compare", () => {
    const rs = rules([
      { id: "miss", kind: "json_path", path: "a.x", assert: "exists" },
      {
        id: "eq",
        kind: "json_path",
        path: "a.x",
        assert: "equals",
        expected: 1,
      },
      {
        id: "c",
        kind: "json_path",
        path: "a.n",
        assert: "contains",
        expected: "x",
      },
      { id: "g", kind: "json_path", path: "a.n", assert: "gt", expected: 10 },
      { id: "gs", kind: "json_path", path: "a.s", assert: "gte", expected: 1 },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(
      rs,
      textOutput(JSON.stringify({ a: { n: 7, s: "seven" } })),
    ).results;
    expect(out[0]).toMatchObject({ status: "failed", reason: "path_missing" });
    expect(out[1]).toMatchObject({ status: "failed", reason: "path_missing" });
    expect(out[2]).toMatchObject({ status: "failed", reason: "not_a_string" });
    // 7 does not exceed 10 — a data-shaped fact, honestly a failed comparison.
    expect(out[3]).toMatchObject({
      status: "failed",
      reason: "comparison_false",
    });
    // "seven" is not a number to compare — an explicit failed reason, never a silent 0.
    expect(out[4]).toMatchObject({ status: "failed", reason: "non_numeric" });
    expect(
      scoreRunOutput(rs, textOutput("just prose, not JSON")).results[0],
    ).toMatchObject({ status: "failed", reason: "output_not_json" });
  });

  test("json_path walks the structured envelope directly; withheld leaves are per-rule errors", () => {
    const rs = rules([
      {
        id: "ok",
        kind: "json_path",
        path: "meta.lang",
        assert: "equals",
        expected: "fr",
      },
      {
        id: "score",
        kind: "json_path",
        path: "score",
        assert: "gt",
        expected: 0.5,
      },
      { id: "secret", kind: "json_path", path: "token", assert: "exists" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const output = projectSafeFixture({
      meta: { lang: "fr" },
      score: 0.87,
      token: "sk-live-abcdefghijklmnop1234",
    });
    const out = scoreRunOutput(rs, output).results;
    expect(out[0]).toMatchObject({ status: "passed" });
    expect(out[1]).toMatchObject({ status: "passed" });
    // The canary: the withheld leaf is never read as a value — it is classified.
    expect(out[2]).toMatchObject({ status: "error", code: "OUTPUT_MISSING" });
  });

  test("text operators score a structured output as its canonical JSON", () => {
    const rs = rules([
      { id: "exact", kind: "exact_match", expected: '{"a":1,"b":2}' },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    expect(
      scoreRunOutput(rs, projectSafeFixture({ b: 2, a: 1 })).results[0],
    ).toMatchObject({ status: "passed" });
    expect(
      scoreRunOutput(rs, projectSafeFixture({ b: 2, a: 3 })).results[0],
    ).toMatchObject({ status: "failed", reason: "not_equal" });
  });
});

describe("the three failure classes are explicit, never a 0", () => {
  const rules = (list: unknown[]) =>
    extractRuleSet(frozenJudgeConfig({ rules: list }));

  test("rule syntax errors hit only their rule; the rest still score", () => {
    const rs = rules([
      { id: "good", kind: "contains", expected: "Paris" },
      { id: "badre", kind: "regex", pattern: "(", flags: "" },
      { id: "badflag", kind: "regex", pattern: "x", flags: "g" },
      { id: "badpath", kind: "json_path", path: "a..b", assert: "exists" },
      { id: "negidx", kind: "json_path", path: "a[-1]", assert: "exists" },
      { id: "badop", kind: "numeric", op: "=>", expected: 1 },
      { id: "noexp", kind: "contains" },
      { id: "wrongtype", kind: "contains", expected: 5 },
      { kind: "contains", expected: "x" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(rs, textOutput("Paris")).results;
    expect(out[0]).toMatchObject({ status: "passed" });
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      expect(out[i]).toMatchObject({
        status: "error",
        code: "RULE_SYNTAX_INVALID",
      });
    }
    // A rule without a usable id still gets a stable, addressed result row.
    expect(out[8]).toMatchObject({
      id: "rule[8]",
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
    // No run-level error: the run itself evaluated fine.
    expect(scoreRunOutput(rs, textOutput("Paris")).error).toBeUndefined();
  });

  test("every operator with an expected operand type-checks it before it can score", () => {
    // regex has no expected operand (pattern/flags are checked separately), so the four
    // expected-bearing kinds each get one mistyped operand here.
    const rs = rules([
      { id: "exact", kind: "exact_match", expected: 7 },
      { id: "cont", kind: "contains", expected: null },
      { id: "numstr", kind: "numeric", op: ">", expected: "10" },
      { id: "numbool", kind: "numeric", op: "<=", expected: true },
      {
        id: "jpc",
        kind: "json_path",
        path: "a.s",
        assert: "contains",
        expected: null,
      },
      {
        id: "jpgt",
        kind: "json_path",
        path: "a.n",
        assert: "gt",
        expected: true,
      },
      {
        id: "jpgte",
        kind: "json_path",
        path: "a.n",
        assert: "gte",
        expected: "0.5",
      },
      {
        id: "jplt",
        kind: "json_path",
        path: "a.n",
        assert: "lt",
        expected: null,
      },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(rs, textOutput("anything")).results;
    for (const row of out) {
      expect(row).toMatchObject({
        status: "error",
        code: "RULE_SYNTAX_INVALID",
      });
    }
  });

  test("json_path: a mistyped expected is a syntax error, never a coercion-passed score", () => {
    // The review's G2 pair: `includes(null)` stringifies to "null", `2 > true` numericizes
    // true to 1 — both must be refused as unscorable, not passed.
    const rs = rules([
      {
        id: "g21",
        kind: "json_path",
        path: "a.s",
        assert: "contains",
        expected: null,
      },
      {
        id: "g22",
        kind: "json_path",
        path: "a.n",
        assert: "gt",
        expected: true,
      },
      {
        id: "ok",
        kind: "json_path",
        path: "a.n",
        assert: "equals",
        expected: "7",
      },
      {
        id: "nul",
        kind: "json_path",
        path: "a.z",
        assert: "equals",
        expected: null,
      },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(
      rs,
      textOutput(
        JSON.stringify({ a: { s: "null pointer deref", n: 2, z: null } }),
      ),
    ).results;
    expect(out[0]).toMatchObject({
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
    expect(out[1]).toMatchObject({
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
    // equals keeps its strict-primitive contract: the string "7" is legal and strictly is
    // not the number 7; null stays a legitimate expected.
    expect(out[2]).toMatchObject({ status: "failed", reason: "not_equal" });
    expect(out[3]).toMatchObject({ status: "passed" });
  });

  test("pattern and path size caps are syntax errors", () => {
    const rs = rules([
      { id: "long", kind: "regex", pattern: "a".repeat(513), flags: "" },
      {
        id: "deep",
        kind: "json_path",
        path: Array.from({ length: 17 }, (_, i) => `k${i}`).join("."),
        assert: "exists",
      },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(rs, textOutput("aaa")).results;
    expect(out[0]).toMatchObject({
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
    expect(out[1]).toMatchObject({
      status: "error",
      code: "RULE_SYNTAX_INVALID",
    });
  });

  test("a nested-quantifier pattern is refused before it can run (OCR h9)", () => {
    const rs = rules([
      { id: "catastrophic", kind: "regex", pattern: "^(a+)+$", flags: "" },
      {
        id: "catastrophic-star",
        kind: "regex",
        pattern: "(\\w+)*x",
        flags: "",
      },
      {
        id: "catastrophic-count",
        kind: "regex",
        pattern: "(a{2,})+b",
        flags: "",
      },
      {
        id: "fine",
        kind: "regex",
        pattern: "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$",
        flags: "i",
      },
      { id: "plain-group", kind: "regex", pattern: "^(ab)+$", flags: "" },
      { id: "bounded", kind: "regex", pattern: "(a+){2}", flags: "" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const out = scoreRunOutput(rs, textOutput("user@example.com")).results;
    // The exponential-backtracking shapes are per-rule syntax errors — controlled
    // refusals, the other rules still score. The rule never reaches RegExp.test.
    for (const i of [0, 1, 2]) {
      expect(out[i]).toMatchObject({
        status: "error",
        code: "RULE_SYNTAX_INVALID",
      });
      expect(
        out[i].status === "error" &&
          /nested unbounded quantifier/i.test(String(out[i].message)),
      ).toBe(true);
    }
    // Ordinary patterns — bounded repetition, plain groups, the classic email
    // shape — are untouched (the email rule matches the subject; the others don't).
    expect(out[3]).toMatchObject({ status: "passed" });
    expect(out[4]).toMatchObject({ status: "failed", reason: "no_match" });
    expect(out[5]).toMatchObject({ status: "failed", reason: "no_match" });
  });

  test("a quantified character class inside a group counts as nested (R2-41)", () => {
    // The class atom's text must be sliced relative to the class's own start —
    // slicing from the pattern start made `(?:[a-z]+)+` look like a group whose
    // body never runs an unbounded single-char quantifier, so the classic ReDoS
    // shapes slipped past the static gate.
    for (const pattern of [
      "(?:[a-z]+)+",
      "([a-z0-9]+)*",
      "([abc]+)+",
      "([a-f0-9]+)+",
      // Regression guards: the shapes the gate already caught stay caught.
      "(\\d+)+",
      "^(a+)+$",
    ]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(true);
    }
    // Safe shapes stay accepted — the fix only tightens, it must not miskill:
    // a single-layer class quantifier, a group with no quantifier, a group
    // with an unbounded inner but no outer quantifier.
    for (const pattern of ["[a-z]+", "(?:abc)", "(a+)"]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(false);
    }
  });

  test("a lookbehind header does not swallow the rest of the pattern (R3-30)", () => {
    // R3-30: the (?< branch scanned straight to `>` without first telling a
    // lookbehind (`(?<=`, `(?<!` — never followed by `>`) from a named group,
    // so the scan ran past the end of the pattern and every atom after the
    // lookbehind was never parsed. `(?<=x)(a+)+` parsed as a lone lookbehind
    // and the static ReDoS gate answered false on a classic catastrophic shape.
    for (const pattern of [
      "(?<=x)(a+)+",
      "(?<!x)(\\w+)*",
      "(?<=x)(?:[a-z]+)+",
    ]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(true);
    }
    // Honest negatives: a lookbehind is a zero-width guard, not a consuming
    // group — patterns with a lookbehind but no nested quantifier stay false,
    // and a named group still finds its `>` and reports its own body.
    for (const pattern of [
      "(?<=a)b",
      "(?<!a)b",
      "(?<=a)b+",
      "(?<=^)(a+)",
      "(?<!a)(b+)",
      "(?<name>a+)",
    ]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(false);
    }
    // The `>` search is for named groups only — and their dangerous bodies
    // still count, before or after a lookbehind.
    expect(regexHasNestedQuantifiers("(?<name>a+)+")).toBe(true);
    expect(regexHasNestedQuantifiers("(?<=x)y(?<!z)(\\d+)*")).toBe(true);
  });

  test("a group quantified unboundedly propagates its danger to the owner (R5-37)", () => {
    // R5-37: unboundedSingle was only recorded when the unbounded quantifier
    // sat directly on a single-char atom, and never propagated through a
    // quantified GROUP — so the classic grouping-chain shapes `^((a)*)+$`,
    // `((a)+)+`, `((?:ab)*)+`, `(((a)*)+)+` all answered gate=false and ran:
    // the accepted `^((a)*)+$` was measured hanging exponentially (1093ms at
    // n=26, vs 195ms for the caught `(a+)+` at the same length). The verdict
    // condition itself is unchanged — an unbounded quantifier over a group
    // whose body contains an unbounded single-char quantifier — the group
    // merely tells its owner what its quantified body now is, so an
    // ENCLOSING unbounded quantifier sees the same danger the flat shapes did.
    // Full triage shape table, bypass rows first:
    for (const pattern of [
      "((a)*)+",
      "((a)+)+",
      "((?:ab)*)+",
      "^((a)*)+$",
      "(((a)*)+)+",
    ]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(true);
    }
    // The shapes the gate already caught stay caught.
    for (const pattern of ["(a+)+", "(?:[a-z]+)+", "(a*)+"]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(true);
    }
    // Safe controls stay accepted — no enclosing unbounded quantifier, no
    // verdict: a flat single-char quantifier, a class quantifier, a group
    // quantifier over a multi-char literal.
    for (const pattern of ["(a)+", "[a-z]+", "(?:abc)+"]) {
      expect(regexHasNestedQuantifiers(pattern)).toBe(false);
    }
  });

  test("evaluation timeout: budget exhaustion marks the unaffordable rules, deterministically", () => {
    const rs = rules([
      { id: "cheap", kind: "exact_match", expected: "Paris" },
      { id: "costly", kind: "regex", pattern: "P", flags: "" },
      { id: "after", kind: "contains", expected: "Paris" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    // exact_match on "Paris" costs 10; regex costs (5+1)*8 = 48 — a 20-unit budget affords
    // the first rule and nothing after it.
    const run = scoreRunOutput(rs, textOutput("Paris"), { budget: 20 });
    expect(run.results[0]).toMatchObject({ status: "passed" });
    expect(run.results[1]).toMatchObject({
      status: "error",
      code: "EVALUATION_TIMEOUT",
    });
    expect(run.results[2]).toMatchObject({
      status: "error",
      code: "EVALUATION_TIMEOUT",
    });
    expect(run.error).toMatchObject({ code: "EVALUATION_TIMEOUT" });
    // Same inputs, same classification — the budget is spent deterministically.
    expect(scoreRunOutput(rs, textOutput("Paris"), { budget: 20 })).toEqual(
      run,
    );
    // A budget that cannot afford even the first rule times out everything.
    const none = scoreRunOutput(rs, textOutput("Paris"), { budget: 1 });
    expect(none.results.every((r) => r.status === "error")).toBe(true);
    // The default budget is generous enough that this suite's outputs never trip it.
    expect(DEFAULT_EVALUATION_BUDGET).toBeGreaterThan(100_000);
  });

  test("an output subject over the scoring ceiling refuses at the entrance — no operator ever scans it (OCR R4-22)", () => {
    // Ambiguous alternation the static detector deliberately does not flag: once a
    // test() has started, neither this module's byte budget nor anything on the GET
    // results read path can interrupt it — the engine's cost there is subject-size
    // and pattern dependent (~0.3s for one 8K a-run on this engine, growing with the
    // subject). The subject below is one the honest settle pipeline CAN store intact
    // (a projected record of 8KiB leaves; only its canonical text is huge), so the
    // entrance refuses any subject past the capture ceiling before the first
    // operator runs: the read path never scans more text than the capture pipeline
    // would keep as one span input (the 64Ki precedent).
    expect(regexHasNestedQuantifiers('"leaf0":"(a|aa)+x')).toBe(false);
    const overSubject: SafeValue = {
      state: "projected",
      value: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `leaf${i}`,
          { state: "projected", value: "a".repeat(8_192) },
        ]),
      ),
    };
    const rs = rules([
      {
        id: "ambiguous",
        kind: "regex",
        pattern: '"leaf0":"(a|aa)+x',
        flags: "",
      },
      { id: "plain", kind: "contains", expected: "needle" },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const run = scoreRunOutput(rs, overSubject);

    expect(run.error).toMatchObject({ code: "OUTPUT_MISSING" });
    expect(run.results).toHaveLength(2);
    expect(run.results.every((r) => r.status === "error")).toBe(true);
    expect(run.results.every((r) => r.code === "OUTPUT_MISSING")).toBe(true);
    expect(run.results[0]?.message).toContain("scoring ceiling");

    // A subject inside the ceiling scores normally — the cap narrows only what the
    // capture pipeline could never hand over as one scan.
    const inside = scoreRunOutput(
      rules([{ id: "plain", kind: "contains", expected: "needle" }]),
      textOutput("the answer mentions a needle"),
    );
    expect(inside.error).toBeUndefined();
    expect(inside.results[0]).toMatchObject({ status: "passed" });
  });

  test("missing output: absent, withheld, truncated and unprojected are OUTPUT_MISSING for every rule", () => {
    const rs = rules([
      { id: "a", kind: "contains", expected: "x" },
      { id: "b", kind: "numeric", op: ">", expected: 1 },
    ]);
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    for (const output of [
      undefined,
      null,
      { state: "omitted", reason: "credential" } as SafeText,
      { state: "truncated", text: "x", originalBytes: 99 } as SafeText,
      {
        state: "truncated",
        value: null,
        originalBytes: 99,
      } as unknown as SafeValue,
      // Raw, unprojected content must never be scored, whatever a caller passes.
      "raw secret text" as unknown as SafeText,
      42 as unknown as SafeValue,
    ]) {
      const run = scoreRunOutput(rs, output);
      expect(run.error).toMatchObject({ code: "OUTPUT_MISSING" });
      expect(run.results.every((r) => r.status === "error")).toBe(true);
      expect(run.results.every((r) => r.status !== "failed")).toBe(true);
    }
  });
});

describe("determinism and purity", () => {
  test("the same inputs answer identically, call after call", () => {
    const rs = extractRuleSet(frozenJudgeConfig(RULE_SET));
    expect(rs.ok).toBe(true);
    if (!rs.ok) return;
    const output = textOutput("Paris");
    const first = scoreRunOutput(rs, output);
    for (let i = 0; i < 50; i++) {
      expect(scoreRunOutput(rs, output)).toEqual(first);
    }
    expect(first.error).toBeUndefined();
  });

  test("two independently frozen copies of one config score identically", () => {
    const a = extractRuleSet(frozenJudgeConfig(RULE_SET));
    const b = extractRuleSet(frozenJudgeConfig(RULE_SET));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(scoreRunOutput(b, textOutput("Paris"))).toEqual(
      scoreRunOutput(a, textOutput("Paris")),
    );
  });
});
