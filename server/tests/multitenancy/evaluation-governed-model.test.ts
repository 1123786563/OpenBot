import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  createJudgeEntranceCall,
  EXECUTION_WORKER_LEASE_MS,
  evaluationToolClassifier,
  judgeAdmissionFromEnv,
} from "../../src/ai-observability/execution-boot";
import type {
  EvaluationModelCall,
  EvaluationToolClassifier,
} from "../../src/ai-observability/execution-runner";
import { GATEWAY_CALL_TIMEOUT_MS } from "../../src/ai-observability/execution-runner";
import { createEvaluationGovernedModelArm } from "../../src/ai-observability/integration";
import {
  createJudgeScorer,
  JUDGE_SCORER_VERSION,
  JUDGE_USAGE_CLIENT,
  judgeCaseUsageId,
} from "../../src/ai-observability/scoring/judge";
import { CreditReservationConflictError } from "../../src/billing/credits-writer";
import { USAGE_IDEMPOTENCY_KEY_PREFIX as BILLING_USAGE_PREFIX } from "../../src/billing/types";
import type { BillingModelCreditPolicyEntry } from "../../src/config";
import type { ModelBudgetCreditCollaborator } from "../../src/enterprise/models/public";

/**
 * The governed evaluation model and judge (MOD18, Issue #638): the cross-module
 * billing faces ride public exits, the supplier dial is collected behind one named
 * arm, and none of that moves a single semantic — same holds, same settlement, same
 * fail-closed tool gate, same frozen keys. D7 (the seven existing evaluation suites,
 * two-sided BASE/IMPL through the bun-suites driver) is gate-side evidence in the
 * run report, not an in-file test: a suite cannot assert its own regression twin.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const projectedText = (text: string) => ({ state: "projected", text }) as const;
const projectedValue = (value: unknown) =>
  ({ state: "projected", value }) as const;

const policyEntry: BillingModelCreditPolicyEntry = {
  input: {
    rate: { numerator: 1n, denominator: 100n },
    maximumTokens: 1_000_000n,
    maximumCostUnits: 100n,
  },
  output: {
    rate: { numerator: 3n, denominator: 100n },
    maximumTokens: 1_000_000n,
    maximumCostUnits: 100n,
  },
  maximumReservationUnits: 10_000n,
};

type HoldAnswer =
  | { reserved: true; reservationId: string }
  | { reserved: false; availableCents: number };

/**
 * A credit collaborator shaped by MOD09's public contract whose reserveCredits
 * answers from a script. The release/mark spies stay EMPTY in every judge path —
 * that emptiness is the unknown-cost-retained assertion (the judge holds no
 * release face at all, and never fabricates one).
 */
function scriptedWriter(script: Array<HoldAnswer | Error>): {
  collaborator: ModelBudgetCreditCollaborator;
  calls: Array<{
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }>;
  released: unknown[];
  markedUnknown: unknown[];
} {
  const calls: Array<{
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }> = [];
  const released: unknown[] = [];
  const markedUnknown: unknown[] = [];
  const collaborator: ModelBudgetCreditCollaborator = {
    async reserveCredits(input) {
      calls.push({ ...input });
      const answer = script[calls.length - 1] ?? {
        reserved: true,
        reservationId: `res-${calls.length}`,
      };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async releaseReservation(...args) {
      released.push(args);
    },
    async markReservationUnknown(...args) {
      markedUnknown.push(args);
    },
  };
  return { collaborator, calls, released, markedUnknown };
}

const outboxDouble = () => {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async record(row: Record<string, unknown>) {
      rows.push(row);
      return { inserted: true };
    },
  };
};

const answeringCall: EvaluationModelCall = async () => ({
  output: JSON.stringify({ score: 0.75, rationale: "grounded answer" }),
  inputTokens: 100,
  outputTokens: 200,
});

const judgeInput = (over: Record<string, unknown> = {}) => ({
  executionId: "exec-1",
  caseIndex: 2,
  scope: { actorId: "actor-1", botId: "bot-1" },
  judgeVersion: projectedText(JUDGE_SCORER_VERSION),
  judgeConfig: projectedValue({
    judge: projectedValue({
      entrance: projectedValue("judge-main"),
      rubric: projectedValue("Score the output"),
    }),
  }),
  sample: {
    input: projectedText("sample in"),
    reference: projectedText("reference out"),
  },
  output: "model answer",
  ...over,
});

const judgeDeps = (
  writer: ModelBudgetCreditCollaborator,
  box: ReturnType<typeof outboxDouble>,
  callModel: EvaluationModelCall = answeringCall,
  logs: string[] = [],
) => ({
  callModel,
  admission: {
    entrances: new Map([["judge-main", { modelName: "judge-model" }]]),
    approvedVersions: new Set([JUDGE_SCORER_VERSION]),
    policy: new Map([["judge-model", policyEntry]]),
  },
  billing: { creditWriter: writer, outbox: box, externalCustomerId: "cust-1" },
  log: (message: string) => {
    logs.push(message);
  },
});

/** Repo-root-relative source read for the source-level pins. */
const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// ---------------------------------------------------------------------------
// D1 — delegation equivalence: the M06-typed hold face and the named dial arm
// answer exactly what the direct injection answered, and real billing error
// instances pass through unchanged.
// ---------------------------------------------------------------------------

describe("judge billing faces ride the public collaborator contract (D1)", () => {
  test("a refused hold refuses the judge and the writer saw the exact same parameters", async () => {
    const { collaborator, calls } = scriptedWriter([
      { reserved: false, availableCents: 12 },
    ]);
    const box = outboxDouble();
    const judge = createJudgeScorer(judgeDeps(collaborator, box));

    const record = await judge(judgeInput());
    expect(record).toEqual({
      status: "failed",
      code: "JUDGE_BUDGET_REFUSED",
      message: "the balance cannot cover the judge hold",
    });
    expect(calls).toEqual([
      {
        externalCustomerId: "cust-1",
        idempotencyKey: `usage:${judgeCaseUsageId("exec-1", 2)}`,
        maximumCents: 10_000,
        expiresAt: calls[0]?.expiresAt,
      },
    ]);
    expect(box.rows).toEqual([]);
  });

  test("a real CreditReservationConflictError instance lands as the same refusal, logged by its own code", async () => {
    const { collaborator } = scriptedWriter([
      new CreditReservationConflictError("replayed", "usage:opik-judge-case:x"),
    ]);
    const logs: string[] = [];
    const judge = createJudgeScorer(
      judgeDeps(collaborator, outboxDouble(), answeringCall, logs),
    );

    const record = await judge(judgeInput());
    expect(record).toEqual({
      status: "failed",
      code: "JUDGE_BUDGET_REFUSED",
      message: "the credit gate refused the judge call",
    });
    expect(logs.some((one) => one.includes("code=reservation_conflict"))).toBe(
      true,
    );
  });

  test("a generic gate error keeps the generic code — the discrimination never widens", async () => {
    const { collaborator } = scriptedWriter([new Error("boom")]);
    const logs: string[] = [];
    const judge = createJudgeScorer(
      judgeDeps(collaborator, outboxDouble(), answeringCall, logs),
    );

    await judge(judgeInput());
    expect(logs.some((one) => one.includes("code=credit_gate_failed"))).toBe(
      true,
    );
  });

  test("the named arm's dial honors entranceId dispatch and per-entrance fail-closed refusals identically", async () => {
    const entrances = new Map([
      ["judge-a", { modelName: "shared", apiKeyEnv: "MOD18_ARM_A_KEY" }],
      ["judge-b", { modelName: "shared", apiKeyEnv: "MOD18_ARM_B_KEY" }],
    ]);
    const arm = createEvaluationGovernedModelArm({ entrances });
    const direct = createJudgeEntranceCall(entrances);

    const request = {
      modelName: "shared",
      modelParameters: {},
      system: "s",
      user: "u",
    };
    const answerOf = async (
      call: EvaluationModelCall,
      entranceId?: string,
    ): Promise<string> =>
      call({
        ...request,
        ...(entranceId === undefined ? {} : { entranceId }),
      }).then(
        () => "dialed",
        (error: unknown) => String(error),
      );

    for (const entranceId of ["judge-a", "judge-b"]) {
      expect(await answerOf(arm.dial, entranceId)).toBe(
        await answerOf(direct, entranceId),
      );
    }
    // The entrance identity rides the request; a name no entrance carries is the
    // deployment gateway's question, not a guessed re-dispatch (③ stays the
    // boot assembly's own fact, pinned by opik-execution-boot.test.ts).
    expect(await answerOf(arm.dial, "nope")).toBe(
      await answerOf(direct, "nope"),
    );
  });

  test("the arm's hold doors are the injected M06 contract, not a re-implementation", () => {
    const { collaborator } = scriptedWriter([]);
    const arm = createEvaluationGovernedModelArm({
      entrances: new Map(),
      credits: collaborator,
    });
    expect(arm.holds).toBe(collaborator);
    expect(arm.classifyTool).toBe(evaluationToolClassifier);
  });
});

// ---------------------------------------------------------------------------
// D2 — the frozen keys do not drift: entrances, approved versions, and the
// implemented scorer version are three separate locks on the same spec.
// ---------------------------------------------------------------------------

describe("frozen dataset/config/version keys (D2)", () => {
  test("an absent admission list is inert and the approved set is exactly this build's version", () => {
    const { entrances, approvedVersions } = judgeAdmissionFromEnv({});
    expect(entrances.size).toBe(0);
    expect(approvedVersions).toEqual(new Set([JUDGE_SCORER_VERSION]));
    expect(JUDGE_SCORER_VERSION).toBe("judge/1");
  });

  test("a version the deployment did not approve is refused before any hold or dial", async () => {
    const { collaborator, calls } = scriptedWriter([]);
    const box = outboxDouble();
    const judge = createJudgeScorer(judgeDeps(collaborator, box));
    const record = await judge(
      judgeInput({ judgeVersion: projectedText("judge/0") }),
    );
    expect(record).toMatchObject({
      status: "failed",
      code: "JUDGE_VERSION_NOT_APPROVED",
    });
    expect(calls).toEqual([]);
    expect(box.rows).toEqual([]);
  });

  test("an env-configured approved list loads verbatim — config, not code, widens it", () => {
    const { approvedVersions } = judgeAdmissionFromEnv({
      OPIK_JUDGE_APPROVED_VERSIONS: " judge/1 , judge/0 ",
    });
    expect(approvedVersions).toEqual(new Set(["judge/1", "judge/0"]));
  });

  test("a model the price map does not name is not admissible", async () => {
    const { collaborator, calls } = scriptedWriter([]);
    const deps = judgeDeps(collaborator, outboxDouble());
    const judge = createJudgeScorer({
      ...deps,
      admission: {
        ...deps.admission,
        entrances: new Map([["judge-other", { modelName: "unpriced" }]]),
      },
    });
    const record = await judge(
      judgeInput({
        judgeConfig: projectedValue({
          judge: projectedValue({
            entrance: projectedValue("judge-other"),
            rubric: projectedValue("Score"),
          }),
        }),
      }),
    );
    expect(record).toMatchObject({
      status: "failed",
      code: "JUDGE_MODEL_NOT_PRICED",
    });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D3 — the judge call actually walks budget → settlement, and an unknown cost
// keeps the hold with an evidence row; the idempotency prefix stays one fact
// across both sources (same-source pin).
// ---------------------------------------------------------------------------

describe("budget, settlement and unknown-cost retention (D3)", () => {
  test("a scored call reserves with the usage-prefixed judge key and settles the exact rational charge", async () => {
    const { collaborator, calls } = scriptedWriter([]);
    const box = outboxDouble();
    const judge = createJudgeScorer(judgeDeps(collaborator, box));

    const record = await judge(judgeInput());
    expect(record).toMatchObject({
      status: "scored",
      score: 0.75,
      scorerVersion: "judge/1",
      entranceId: "judge-main",
      usage: { inputTokens: 100, outputTokens: 200 },
    });
    expect(calls[0]?.idempotencyKey).toBe(
      `${BILLING_USAGE_PREFIX}opik-judge-case:exec-1:2`,
    );
    expect(calls[0]?.maximumCents).toBe(10_000);
    // 100·1/100 + 200·3/100 = 7 whole units.
    expect(box.rows).toEqual([
      {
        eventId: "opik-judge-case:exec-1:2",
        source: "llm",
        externalCustomerId: "cust-1",
        model: "judge-model",
        client: JUDGE_USAGE_CLIENT,
        occurredAt: (box.rows[0] as { occurredAt: Date }).occurredAt,
        transactionId: "opik-judge-case:exec-1:2",
        inputTokens: 100,
        outputTokens: 200,
        reservationId: "res-1",
        actualCostNumerator: "7",
        actualCostDenominator: "1",
        botId: "bot-1",
        ownerUserId: "actor-1",
      },
    ]);
    expect(box.rows[0]?.occurredAt).toBeInstanceOf(Date);
  });

  test("a score without usage keeps the hold occupied behind an evidence row — nothing releases it", async () => {
    const { collaborator, calls, released, markedUnknown } = scriptedWriter([]);
    const box = outboxDouble();
    const judge = createJudgeScorer(
      judgeDeps(collaborator, box, async () => ({
        output: JSON.stringify({ score: 0.5, rationale: "no usage reported" }),
      })),
    );

    const record = await judge(judgeInput());
    expect(record).toEqual({
      status: "scored",
      score: 0.5,
      rationale: { state: "projected", text: "no usage reported" },
      scorerVersion: "judge/1",
      entranceId: "judge-main",
      usage: { usageUnknown: true },
    });
    expect(calls).toHaveLength(1);
    expect(box.rows).toEqual([
      expect.objectContaining({
        eventId: "opik-judge-case:exec-1:2",
        reservationId: null,
        actualCostNumerator: null,
        actualCostDenominator: null,
        status: "usage_missing",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(released).toEqual([]);
    expect(markedUnknown).toEqual([]);
  });

  test("the idempotency prefix is the same literal in billing and in the M11 exit (same-source pin)", () => {
    expect(BILLING_USAGE_PREFIX).toBe("usage:");
    const billing = sourceOf("../../src/billing/types.ts");
    const exit = sourceOf("../../src/ai-observability/public.ts");
    const declaration = 'export const USAGE_IDEMPOTENCY_KEY_PREFIX = "usage:";';
    expect(billing).toContain(declaration);
    expect(exit).toContain(declaration);
  });
});

// ---------------------------------------------------------------------------
// D4 — the isolated tool gate stays fail-closed and no production credential
// path reaches the judge or the arm.
// ---------------------------------------------------------------------------

describe("isolated tool gate and zero production credential path (D4)", () => {
  test("the production classifier refuses every name as a write", () => {
    const classifier: EvaluationToolClassifier = evaluationToolClassifier;
    for (const name of ["search", "kb_search", "", "gmail.list", "read_file"]) {
      expect(classifier(name)).toBe("write");
    }
  });

  test("the classifier is wired through the reviewed fail-closed seam (source pin)", () => {
    const boot = sourceOf("../../src/ai-observability/execution-boot.ts");
    expect(boot).toContain("classifyTool(null, toolName, false)");
  });

  test("judge and arm read no deployment-gateway credential (source pin)", () => {
    const judge = sourceOf("../../src/ai-observability/scoring/judge.ts");
    const arm = sourceOf("../../src/ai-observability/integration.ts");
    // The judge resolves only the entrance's DECLARED env (process.env[envName],
    // fail-closed); the gateway's own key never rides a judge request. Doc
    // comments may NAME the fallback they refuse — a read is what must not exist.
    expect(judge).not.toContain("process.env.OPENAI_API_KEY");
    expect(judge).not.toContain("process.env.OPENAI_BASE_URL");
    for (const source of [judge, arm]) {
      expect(source).not.toContain("createOpenAI");
      expect(source).not.toContain("apiKey: process.env");
    }
    expect(arm).not.toContain("OPENAI_API_KEY");
    expect(arm).not.toContain("OPENAI_BASE_URL");
  });
});

// ---------------------------------------------------------------------------
// D5 — lease, one-attempt dialing and per-sample re-authorization keep their
// existing contract.
// ---------------------------------------------------------------------------

describe("lease, retry and per-sample re-authorization contract (D5)", () => {
  test("the worker lease is exactly three gateway call timeouts", () => {
    expect(EXECUTION_WORKER_LEASE_MS).toBe(3 * GATEWAY_CALL_TIMEOUT_MS);
    expect(EXECUTION_WORKER_LEASE_MS).toBe(180_000);
  });

  test("a thrown provider call is one attempt: evidence, retained hold, failed record", async () => {
    const { collaborator, calls, released, markedUnknown } = scriptedWriter([]);
    const box = outboxDouble();
    let dials = 0;
    const judge = createJudgeScorer(
      judgeDeps(collaborator, box, async () => {
        dials += 1;
        throw new Error("gateway down");
      }),
    );

    const record = await judge(judgeInput());
    expect(record).toEqual({
      status: "failed",
      code: "JUDGE_CALL_FAILED",
      message: "the judge provider call threw",
    });
    expect(dials).toBe(1);
    expect(calls).toHaveLength(1);
    expect(box.rows).toEqual([
      expect.objectContaining({
        status: "provider_error",
        reservationId: null,
      }),
    ]);
    expect(released).toEqual([]);
    expect(markedUnknown).toEqual([]);
  });

  test("the boot wires live re-authorization and the lease together (source pin)", () => {
    const boot = sourceOf("../../src/ai-observability/execution-boot.ts");
    expect(boot).toContain("createExportReauthorization({");
    expect(boot).toContain("leaseMs: EXECUTION_WORKER_LEASE_MS");
  });
});

// ---------------------------------------------------------------------------
// D6 — negative: the exits add no scorer, no provider face, no second billing
// vocabulary.
// ---------------------------------------------------------------------------

describe("no new scorer or provider capability through the exits (D6)", () => {
  test("the arm references no provider SDK and no scorer construction (source pin)", () => {
    const arm = sourceOf("../../src/ai-observability/integration.ts");
    expect(arm).not.toContain("generateText");
    expect(arm).not.toContain("createJudgeScorer(");
    expect(arm).not.toMatch(/from "(openai|@ai-sdk)/);
  });

  test("judge's cross-module imports are exactly the two registered survivors plus the exits", () => {
    const judge = sourceOf("../../src/ai-observability/scoring/judge.ts");
    expect(judge.match(/from "\.\.\/\.\.\/billing\//g)?.length).toBe(1);
    expect(judge.match(/from "\.\.\/\.\.\/workshop\//g)?.length).toBe(1);
    expect(judge).toContain('from "../../enterprise/models/public"');
    expect(judge).toContain('from "../public"');
  });

  test("the M11 exit adds no cross-module import of its own (source pin)", () => {
    const exit = sourceOf("../../src/ai-observability/public.ts");
    expect(exit).not.toMatch(
      /from "\.\.\/\.\.\/(billing|workshop|agents|auth)\//,
    );
    expect(exit).not.toContain("openai");
  });
});
