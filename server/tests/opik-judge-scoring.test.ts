import { describe, expect, test } from "bun:test";
import type { FrozenDatasetCase } from "../src/ai-observability/datasets";
import type { EvaluationModelCall } from "../src/ai-observability/execution-runner";
import type {
  EvaluationCaseContext,
  EvaluationCaseOutcome,
  EvaluationCaseRunner,
} from "../src/ai-observability/executions";
import { freezeExperimentConfig } from "../src/ai-observability/experiments";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  createEntranceModelCall,
  createJudgeScorer,
  createJudgeScoringCaseRunner,
  JUDGE_SCORER_VERSION,
  JUDGE_USAGE_CLIENT,
  judgeCaseUsageId,
} from "../src/ai-observability/scoring/judge";
import {
  CreditReservationConflictError,
  type CreditWriter,
} from "../src/billing/credits-writer";
import type { UsageOutbox } from "../src/billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../src/config";

/**
 * The controlled model judge (Issue #33 / DAG T27), unit-level: the admission list, the
 * fail-closed gate order, the verdict contract, and the rationale projection — all against
 * fakes, so every "zero provider calls" claim is a literal counter. The billing seams are
 * the same ones the evaluation call rides (T25); a real-database composition lives in the
 * integration suite.
 */

const scope = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const VERDICT = JSON.stringify({
  score: 0.9,
  rationale: "Covers the outage summary accurately.",
});

/** A canary the T05 policy denies wherever it sits. */
const CANARY = "sk-proj-canary0123456789abcdef";

const judgeConfigInput = (over: Record<string, unknown> = {}) => ({
  judge: {
    entrance: "approved",
    rubric: "Score the answer's agreement with the reference, 0 to 1.",
    ...over,
  },
});

const frozenConfig = (
  judgeConfig: Record<string, unknown> = judgeConfigInput(),
) =>
  freezeExperimentConfig({
    botConfig: {},
    prompt: "Answer the support question.",
    modelName: "gateway-model",
    modelParameters: { temperature: 0 },
    toolFixtures: {},
    judgeConfig,
    judgeVersion: JUDGE_SCORER_VERSION,
    readOnlyTools: [],
  });

const frozenCase: FrozenDatasetCase = {
  safeInput: { state: "projected", text: "Summarize the outage." },
  referenceOutput: { state: "projected", text: "A summary." },
  toolFixtures: { state: "projected", value: {} },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: null,
};

/** 1 scaled unit per input token, 2 per output token, a 1000-unit worst-case hold. */
const pricedModel: BillingModelCreditPolicyEntry = {
  input: {
    rate: { numerator: 1n, denominator: 1n },
    maximumTokens: 1000n,
    maximumCostUnits: 1000n,
  },
  output: {
    rate: { numerator: 2n, denominator: 1n },
    maximumTokens: 1000n,
    maximumCostUnits: 2000n,
  },
  maximumReservationUnits: 1000n,
};

const entrances = new Map([
  ["approved", { modelName: "judge-model" }],
  ["secretive", { modelName: "judge-model", apiKeyEnv: "JUDGE_KEY" }],
]);
const approvedVersions = new Set([JUDGE_SCORER_VERSION]);
const policy = new Map([["judge-model", pricedModel]]);

type ReserveAnswer =
  | { reserved: true; reservationId: string }
  | { reserved: false; availableCents: number };

/** The recording billing seam: every reserve and every outbox fact is counted. */
function fakeBilling(
  reserve: ReserveAnswer = {
    reserved: true,
    reservationId: "res-judge-1",
  },
) {
  const reserves: unknown[] = [];
  const records: unknown[] = [];
  return {
    reserves,
    records,
    creditWriter: {
      reserveCredits: async (input: unknown) => {
        reserves.push(input);
        return reserve;
      },
    } satisfies Pick<CreditWriter, "reserveCredits">,
    outbox: {
      record: async (input: unknown) => {
        records.push(input);
        return { inserted: true };
      },
    } satisfies Pick<UsageOutbox, "record">,
  };
}

function fakeJudgeModel(
  answer:
    | { output: string; inputTokens?: number; outputTokens?: number }
    | { throws: Error },
) {
  const calls: Parameters<EvaluationModelCall>[0][] = [];
  const callModel = (async (request: Parameters<EvaluationModelCall>[0]) => {
    calls.push(request);
    if ("throws" in answer) throw answer.throws;
    return answer;
  }) satisfies EvaluationModelCall;
  return { calls, callModel };
}

type ScorerInput = Parameters<ReturnType<typeof createJudgeScorer>>[0];

function inputFor(
  over: Partial<{
    config: ReturnType<typeof frozenConfig>;
    frozenCase: FrozenDatasetCase;
    output: unknown;
    executionId: string;
    caseIndex: number;
  }> = {},
): ScorerInput {
  return {
    executionId: over.executionId ?? "exec-1",
    caseIndex: over.caseIndex ?? 0,
    scope,
    judgeVersion: (over.config ?? frozenConfig()).judgeVersion,
    judgeConfig: (over.config ?? frozenConfig()).judgeConfig,
    sample: {
      input: (over.frozenCase ?? frozenCase).safeInput,
      reference: (over.frozenCase ?? frozenCase).referenceOutput,
    },
    output: "output" in over ? over.output : "the answer",
  };
}

function scorerFor(
  answer: Parameters<typeof fakeJudgeModel>[0],
  billing = fakeBilling(),
  admission = { entrances, approvedVersions, policy },
) {
  const model = fakeJudgeModel(answer);
  const judge = createJudgeScorer({
    callModel: model.callModel,
    admission,
    billing: {
      creditWriter: billing.creditWriter,
      outbox: billing.outbox,
      externalCustomerId: "customer-1",
    },
  });
  return { judge, model, billing };
}

test("the judge scores a case through the approved entrance and settles its own charge fact", async () => {
  const { judge, model, billing } = scorerFor({
    output: VERDICT,
    inputTokens: 12,
    outputTokens: 34,
  });

  const record = await judge(inputFor());

  expect(record).not.toBeNull();
  expect(record).toMatchObject({
    status: "scored",
    score: 0.9,
    scorerVersion: JUDGE_SCORER_VERSION,
    entranceId: "approved",
    usage: { inputTokens: 12, outputTokens: 34 },
  });
  expect(record?.status === "scored" && record.rationale).toEqual({
    state: "projected",
    text: "Covers the outage summary accurately.",
  });

  // One controlled call: the approved entrance's model — never the evaluated model, never
  // an Opik default — with the rubric in the system message and only reviewed sample,
  // reference and output in the user message.
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]?.modelName).toBe("judge-model");
  expect(model.calls[0]?.system).toContain(
    "Score the answer's agreement with the reference",
  );
  expect(model.calls[0]?.user).toContain("Summarize the outage.");
  expect(model.calls[0]?.user).toContain("A summary.");
  expect(model.calls[0]?.user).toContain("the answer");

  // The hold precedes the call: reserved under the natural key, worst-case ceiling.
  expect(billing.reserves).toEqual([
    {
      externalCustomerId: "customer-1",
      idempotencyKey: `usage:${judgeCaseUsageId("exec-1", 0)}`,
      maximumCents: 1000,
      expiresAt: expect.any(Date),
    },
  ]);

  // One charge fact of the judge's own: the T25 settlement seam, a judge client.
  expect(billing.records).toHaveLength(1);
  expect(billing.records[0]).toMatchObject({
    eventId: judgeCaseUsageId("exec-1", 0),
    client: JUDGE_USAGE_CLIENT,
    reservationId: "res-judge-1",
    inputTokens: 12,
    outputTokens: 34,
    botId: scope.botId,
    ownerUserId: scope.actorId,
  });
});

test("an entrance the deployment never approved refuses with zero provider calls", async () => {
  const { judge, model, billing } = scorerFor({ output: VERDICT });
  const config = frozenConfig(judgeConfigInput({ entrance: "not-approved" }));

  const record = await judge(inputFor({ config }));

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_ENTRANCE_NOT_APPROVED",
  });
  expect(model.calls).toHaveLength(0);
  expect(billing.reserves).toHaveLength(0);
  expect(billing.records).toHaveLength(0);
});

test("a scorer version that is not the implemented, approved one refuses", async () => {
  const { judge, model } = scorerFor({ output: VERDICT });
  const otherVersion = freezeExperimentConfig({
    botConfig: {},
    prompt: "p",
    modelName: "gateway-model",
    modelParameters: {},
    toolFixtures: {},
    judgeConfig: judgeConfigInput(),
    judgeVersion: "judge/2",
    readOnlyTools: [],
  });

  const unimplemented = await judge(inputFor({ config: otherVersion }));
  expect(unimplemented).toMatchObject({
    status: "failed",
    code: "JUDGE_VERSION_NOT_APPROVED",
  });

  const unapproved = createJudgeScorer({
    callModel: model.callModel,
    admission: {
      entrances,
      approvedVersions: new Set(["judge/9"]),
      policy,
    },
    billing: {
      creditWriter: fakeBilling().creditWriter,
      outbox: fakeBilling().outbox,
      externalCustomerId: "customer-1",
    },
  });
  const refused = await unapproved(inputFor());
  expect(refused).toMatchObject({
    status: "failed",
    code: "JUDGE_VERSION_NOT_APPROVED",
  });
  expect(model.calls).toHaveLength(0);
});

test("a judge model with no configured price refuses before the call", async () => {
  const { judge, model, billing } = scorerFor(
    { output: VERDICT },
    fakeBilling(),
    { entrances, approvedVersions, policy: new Map() },
  );

  const record = await judge(inputFor());

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_MODEL_NOT_PRICED",
  });
  expect(model.calls).toHaveLength(0);
  expect(billing.reserves).toHaveLength(0);
});

test("a balance that cannot cover the judge hold refuses before the provider, and a settled replay is fenced", async () => {
  const broke = scorerFor(
    { output: VERDICT },
    fakeBilling({
      reserved: false,
      availableCents: 3,
    }),
  );
  const refused = await broke.judge(inputFor());
  expect(refused).toMatchObject({
    status: "failed",
    code: "JUDGE_BUDGET_REFUSED",
  });
  expect(broke.model.calls).toHaveLength(0);

  // The replay fence: a terminal hold answers a conflict, and the judge reads it as a
  // refusal — a settled judge call can never be dialed (or charged) again.
  const conflict = scorerFor(
    { output: VERDICT },
    fakeBilling({
      reserved: true,
      reservationId: "res-x",
    }),
  );
  (
    conflict.billing.creditWriter as {
      reserveCredits: unknown;
    }
  ).reserveCredits = async () => {
    throw new CreditReservationConflictError("replay");
  };
  const replay = await conflict.judge(inputFor());
  expect(replay).toMatchObject({
    status: "failed",
    code: "JUDGE_BUDGET_REFUSED",
  });
  expect(conflict.model.calls).toHaveLength(0);
});

test("a rubric the redaction policy refused freezes to a spec this judge will not run", async () => {
  const config = frozenConfig(
    judgeConfigInput({ rubric: `Judge well. Key: ${CANARY}` }),
  );
  const { judge, model, billing } = scorerFor({ output: VERDICT });

  const record = await judge(inputFor({ config }));

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_SPEC_INVALID",
  });
  expect(model.calls).toHaveLength(0);
  expect(billing.reserves).toHaveLength(0);
  // The canary itself never reaches the record, the prompt, or the failure message.
  expect(JSON.stringify(record)).not.toContain(CANARY);
});

test("a withheld sample or reference leaves nothing safe to judge", async () => {
  const { judge, model, billing } = scorerFor({ output: VERDICT });

  const noInput = await judge(
    inputFor({
      frozenCase: {
        ...frozenCase,
        safeInput: { state: "omitted", reason: "credential" },
      },
    }),
  );
  expect(noInput).toMatchObject({
    status: "failed",
    code: "JUDGE_INPUT_UNAVAILABLE",
  });

  const noReference = await judge(
    inputFor({
      frozenCase: {
        ...frozenCase,
        referenceOutput: { state: "omitted", reason: "credential" },
      },
    }),
  );
  expect(noReference).toMatchObject({
    status: "failed",
    code: "JUDGE_INPUT_UNAVAILABLE",
  });
  expect(model.calls).toHaveLength(0);
  expect(billing.reserves).toHaveLength(0);
});

test("a completed case with no scoreable output fails honestly", async () => {
  const { judge, model } = scorerFor({ output: VERDICT });

  const record = await judge(inputFor({ output: undefined }));

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_OUTPUT_MISSING",
  });
  expect(model.calls).toHaveLength(0);
});

test("a verdict that does not parse is a scoring failure, and the money it spent still settles", async () => {
  const { judge, model, billing } = scorerFor({
    output: "The answer looks good to me.",
    inputTokens: 5,
    outputTokens: 7,
  });

  const record = await judge(inputFor());

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_VERDICT_INVALID",
  });
  expect(model.calls).toHaveLength(1);
  // The call was real work: its charge fact stands even though the verdict is worthless.
  expect(billing.records[0]).toMatchObject({
    eventId: judgeCaseUsageId("exec-1", 0),
    reservationId: "res-judge-1",
    inputTokens: 5,
    outputTokens: 7,
  });
});

test("a verdict outside 0..1 or without a rationale is invalid, never coerced", async () => {
  const outOfRange = scorerFor({
    output: JSON.stringify({ score: 1.4, rationale: "Too generous." }),
    inputTokens: 1,
    outputTokens: 1,
  });
  expect(await outOfRange.judge(inputFor())).toMatchObject({
    status: "failed",
    code: "JUDGE_VERDICT_INVALID",
  });

  const noRationale = scorerFor({
    output: JSON.stringify({ score: 0.5 }),
    inputTokens: 1,
    outputTokens: 1,
  });
  expect(await noRationale.judge(inputFor())).toMatchObject({
    status: "failed",
    code: "JUDGE_VERDICT_INVALID",
  });
});

test("a rationale carrying a canary is omitted by the projection, never echoed", async () => {
  const { judge, billing } = scorerFor({
    output: JSON.stringify({
      score: 0.9,
      rationale: `It matches. Secret: ${CANARY}`,
    }),
    inputTokens: 3,
    outputTokens: 9,
  });

  const record = await judge(inputFor());

  expect(record).toMatchObject({ status: "scored", score: 0.9 });
  if (record?.status === "scored") {
    expect(record.rationale.state).toBe("omitted");
  }
  expect(JSON.stringify(record)).not.toContain(CANARY);
  expect(JSON.stringify(billing.records)).not.toContain(CANARY);
});

test("a thrown judge call is a single-attempt failure with an evidence row and no retry", async () => {
  const { judge, model, billing } = scorerFor({
    throws: new Error("gateway down"),
  });

  const record = await judge(inputFor());

  expect(record).toMatchObject({ status: "failed", code: "JUDGE_CALL_FAILED" });
  expect(model.calls).toHaveLength(1);
  // Unknown cost, never zero: the evidence row names the case, the hold stays occupied.
  expect(billing.records[0]).toMatchObject({
    eventId: judgeCaseUsageId("exec-1", 0),
    status: "provider_error",
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(
    (billing.records[0] as { reservationId?: string }).reservationId,
  ).toBeNull();
});

test("usage the judge provider never reported is an unknown cost, and a returned score is not budget evidence", async () => {
  const { judge, billing } = scorerFor({ output: VERDICT });

  const record = await judge(inputFor());

  expect(record).toMatchObject({
    status: "scored",
    score: 0.9,
    usage: { usageUnknown: true },
  });
  // No charge fact exists: the evidence row carries no reservation facts, so the credits
  // target blocks it for review while the hold stays occupied. A score is not a settlement.
  expect(billing.records).toHaveLength(1);
  expect(billing.records[0]).toMatchObject({
    status: "usage_missing",
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(
    (billing.records[0] as { reservationId?: string }).reservationId,
  ).toBeNull();
});

test("a charge the pricing refuses fails the scoring and leaves the hold retained with evidence", async () => {
  const { judge, billing } = scorerFor({
    output: VERDICT,
    inputTokens: 10,
    outputTokens: 2000, // past the policy's per-call output ceiling
  });

  const record = await judge(inputFor());

  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_SETTLEMENT_ERROR",
  });
  expect(billing.records[0]).toMatchObject({
    status: "usage_over_token_max",
    inputTokens: 10,
    outputTokens: 2000,
  });
  expect(
    (billing.records[0] as { reservationId?: string }).reservationId,
  ).toBeNull();
});

describe("the case-runner wrapper", () => {
  const context = (config = frozenConfig()): EvaluationCaseContext => ({
    executionId: "exec-1",
    experimentId: "experiment-1",
    caseIndex: 0,
    frozenCase,
    config,
    scope,
    callTool: async () => ({ outcome: "refused", reason: "not_whitelisted" }),
  });

  function wrappedCaseRunner(
    answer: Parameters<typeof fakeJudgeModel>[0],
    innerOutcome: EvaluationCaseOutcome,
  ) {
    const model = fakeJudgeModel(answer);
    const judge = createJudgeScorer({
      callModel: model.callModel,
      admission: { entrances, approvedVersions, policy },
      billing: {
        creditWriter: fakeBilling().creditWriter,
        outbox: fakeBilling().outbox,
        externalCustomerId: "customer-1",
      },
    });
    // The explicit annotation is the same blindspot guard the production wrapper
    // carries: an inner runner answering a stale shape must not compile green.
    const inner: EvaluationCaseRunner =
      async (): Promise<EvaluationCaseOutcome> => innerOutcome;
    const runner = createJudgeScoringCaseRunner({ inner, judge });
    return { runner, model };
  }

  test("a completed case carries its judge record beside its execution truth", async () => {
    const { runner, model } = wrappedCaseRunner(
      { output: VERDICT, inputTokens: 12, outputTokens: 34 },
      {
        status: "completed",
        output: "the answer",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    );

    const outcome = await runner(context());

    expect(outcome.status).toBe("completed");
    // The case's own truth is untouched; the judge record rides its own field.
    expect(outcome.output).toBe("the answer");
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(outcome.judge).toMatchObject({
      status: "scored",
      score: 0.9,
      scorerVersion: JUDGE_SCORER_VERSION,
    });
    expect(model.calls).toHaveLength(1);
  });

  test("a case that did not complete is never judged — no call, no reservation, no rerun", async () => {
    const { runner, model } = wrappedCaseRunner(
      { output: VERDICT },
      { status: "failed" },
    );

    const outcome = await runner(context());

    expect(outcome).toEqual({ status: "failed" });
    expect(model.calls).toHaveLength(0);
  });

  test("an experiment without a judge subtree runs rules-only and dials nothing", async () => {
    const { runner, model } = wrappedCaseRunner(
      { output: VERDICT },
      { status: "completed", output: "the answer" },
    );

    const outcome = await runner(context(frozenConfig({ rules: [] })));

    expect(outcome.judge).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  test("a refused judge admission fails the scoring, not the case", async () => {
    const { runner, model } = wrappedCaseRunner(
      { output: VERDICT, inputTokens: 1, outputTokens: 1 },
      { status: "completed", output: "the answer" },
    );

    const outcome = await runner(
      context(frozenConfig(judgeConfigInput({ entrance: "not-approved" }))),
    );

    // The case executed and completed; the judge's refusal is its own, separately shown
    // failure — exactly the split the results surface (T28) draws between execution
    // failure and scoring failure.
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("the answer");
    expect(outcome.judge).toMatchObject({
      status: "failed",
      code: "JUDGE_ENTRANCE_NOT_APPROVED",
    });
    expect(model.calls).toHaveLength(0);
  });
});

test("a verdict wrapped in a markdown fence or prose still parses (OCR m226)", async () => {
  const fenced = scorerFor({
    output: "```json\n" + VERDICT + "\n```",
    inputTokens: 3,
    outputTokens: 4,
  });
  expect(await fenced.judge(inputFor())).toMatchObject({
    status: "scored",
    score: 0.9,
  });

  const prosed = scorerFor({
    output: "Here is my verdict:\n" + VERDICT + "\nHope that helps.",
    inputTokens: 3,
    outputTokens: 4,
  });
  expect(await prosed.judge(inputFor())).toMatchObject({
    status: "scored",
    score: 0.9,
  });

  // The widening never admits a NON-verdict: no score, no rationale, no pass.
  const junk = scorerFor({
    output: 'Sure: {"score": "high"} — good luck parsing that.',
    inputTokens: 1,
    outputTokens: 1,
  });
  expect(await junk.judge(inputFor())).toMatchObject({
    status: "failed",
    code: "JUDGE_VERDICT_INVALID",
  });
});

test("the case output is projected before it joins the prompt, refused if it carries a credential (OCR m229)", async () => {
  const clean = scorerFor({ output: VERDICT });
  await clean.judge(inputFor());
  const prompt = clean.model.calls[0]?.user ?? "";
  // Free text rides (allowFreeText, like the rationale) — but through the projection.
  expect(prompt).toContain("## Output");

  const leaking = scorerFor({ output: VERDICT });
  const record = await leaking.judge(
    inputFor({ output: `The key is ${CANARY}, use it.` }),
  );
  expect(record).toMatchObject({
    status: "failed",
    code: "JUDGE_OUTPUT_UNSAFE",
  });
  // Refused before any money moved or any bytes left the process.
  expect(leaking.model.calls).toHaveLength(0);
  expect(leaking.billing.reserves).toHaveLength(0);
});

test("a scorer that throws leaves the case's own outcome standing (OCR m223)", async () => {
  const inner: EvaluationCaseRunner = async () => ({
    status: "completed",
    output: "the answer",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
  const exploding = (async () => {
    throw new Error("judge seam exploded");
  }) as unknown as Parameters<
    typeof createJudgeScoringCaseRunner
  >[0]["judge"];
  const runner = createJudgeScoringCaseRunner({
    inner,
    judge: exploding,
  });

  const outcome = await runner({
    executionId: "exec-1",
    caseIndex: 0,
    scope,
    config: frozenConfig(),
    frozenCase,
  });

  expect(outcome.status).toBe("completed");
  expect(outcome.output).toBe("the answer");
  expect(outcome.judge).toMatchObject({
    status: "failed",
    code: "JUDGE_CALL_FAILED",
    message: "judge seam exploded",
  });
});

test("an entrance whose declared credential env is missing refuses its own calls, never borrows the deployment key (OCR m224)", async () => {
  const call = createEntranceModelCall({
    modelName: "third-party-model",
    apiKeyEnv: "JUDGE_KEY_DEFINITELY_UNSET_8f3b",
    baseURL: "https://third-party.example",
  });
  await expect(
    call({
      modelName: "third-party-model",
      modelParameters: {},
      system: "s",
      user: "u",
    }),
  ).rejects.toThrow(/JUDGE_KEY_DEFINITELY_UNSET_8f3b/);
});
