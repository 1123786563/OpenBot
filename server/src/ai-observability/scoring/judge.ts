import type { SafeText, SafeValue } from "../../../../shared/ai-observability";
import { getLogger } from "../../../../shared/logger";
import {
  CreditReservationConflictError,
  type CreditWriter,
} from "../../billing/credits-writer";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "../../billing/types";
import { createUsageEvidenceRecorder } from "../../billing/usage-evidence";
import type { UsageOutbox } from "../../billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../../config";
import {
  calculateExactModelUsageCharge,
  UsageChargeError,
} from "../../workshop/metering";
import type { ObservationScope } from "../contracts";
import {
  createGatewayModelCall,
  type EvaluationModelCall,
} from "../execution-runner";
import type {
  EvaluationCaseOutcome,
  EvaluationCaseRunner,
} from "../executions";
import { projectSafeText } from "../redaction";

/**
 * The controlled model judge (Issue #33 / DAG T27).
 *
 * A judge score is money before it is a number. This module is the model side of
 * scoring — T26's rules are the free side — and every path here treats one judge
 * call exactly like T25 treats one evaluated call: the deployment's ONE credit
 * machinery answers for it (the same `reserveCredits`, the same usage outbox, the
 * same credits delivery), with an event vocabulary of its own so the two calls of
 * one case are two facts, never one. There is no second ledger and no
 * SDK-supplied score shortcut: the Opik SDK judges nothing here (its default
 * model is never dialed), and a score the provider returned without a usage
 * report settles nothing — `usage_missing` evidence, hold retained.
 *
 * ## The admission list (AC1)
 *
 * The frozen experiment can only NAME things; it cannot address them. The
 * judge spec carries an entrance id, and a deployment-level map resolves that
 * id to the approved model and its credential environment — a caller-supplied
 * provider address or key has no field to live in, and a name the map does not
 * carry is refused before anything is dialed. The scorer version is the same
 * shape: this module implements exactly `JUDGE_SCORER_VERSION`, and the
 * deployment's approved-version set is the second key a frozen experiment must
 * turn. Fail-closed everywhere: an unapproved judge is a per-sample scoring
 * failure (its own display class, T28's vocabulary), never a silently skipped
 * one, and never a fallback to some default model.
 *
 * ## The projection boundary (AC3)
 *
 * The prompt is assembled from projected envelopes only — the reviewed sample,
 * its reference, the rubric the freeze kept intact. A withheld input or
 * reference means there is nothing safe to judge and the judge refuses; a
 * rubric the redaction policy refused (a secret typed into it) means the spec
 * itself is invalid. The rationale — free text from a model — is projected
 * through T05 before it reaches any record, so a canary in a verdict is
 * omitted, never echoed. The judge call never touches the Opik port at all:
 * structurally, nothing here can send SDK auto-tracing upstream.
 *
 * ## Failure taxonomy (AC4, along T28's classes)
 *
 * A judge failure is a scoring failure, distinct from the case's execution
 * outcome: the wrapper below only judges completed cases, and a failed judge
 * leaves the case's own outcome standing. A failure is never a score of 0 —
 * each code names what actually happened, and money already spent still
 * settles (an unparseable verdict is worthless, but the tokens it burned were
 * real work that the outbox records). One attempt, no auto-rerun: the judge
 * rides the case-runner seam, so the T24 task rules — write-ahead rows,
 * takeover, revocation at case boundaries — govern it unchanged.
 */

/** The scorer code version this module implements; a frozen experiment must pin exactly this. */
export const JUDGE_SCORER_VERSION = "judge/1";

/** How the judge's usage facts name their surface — the evaluation call's sibling. */
export const JUDGE_USAGE_CLIENT = "opik_judge";

/** Mirrors the evaluation call's hold window (T25): a lease plus a bounded call fits inside. */
const DEFAULT_RESERVATION_WINDOW_MS = 15 * 60_000;

/** The T24 write-ahead row's natural key, in the judge's own event vocabulary. */
export function judgeCaseUsageId(
  executionId: string,
  caseIndex: number,
): string {
  return `opik-judge-case:${executionId}:${caseIndex}`;
}

/**
 * One approved judge entrance (AC1): the model the judge dials and the credential
 * environment that dials it. Deployment config — the frozen experiment names the
 * entrance by id and nothing else.
 */
export type ApprovedJudgeEntrance = Readonly<{
  modelName: string;
  /** The env var holding this entrance's key; resolved here, never caller-supplied. */
  apiKeyEnv?: string;
  /** The deployment-pinned base URL; absent means the deployment's default gateway. */
  baseURL?: string;
}>;

export type JudgeEntranceList = ReadonlyMap<string, ApprovedJudgeEntrance>;

/** The judge spec exactly as `extractJudgeSpec` answers it. */
export type JudgeSpec = Readonly<{ entranceId: string; rubric: string }>;

export type ExtractJudgeSpecResult =
  /** No judge subtree: a rules-only experiment, not an error — T26's rules stand alone. */
  | { kind: "disabled" }
  | { kind: "enabled"; spec: JudgeSpec }
  | { kind: "invalid"; message: string };

function isEnvelope(node: unknown): node is SafeValue | SafeText {
  return (
    !!node &&
    typeof node === "object" &&
    ((node as { state?: unknown }).state === "projected" ||
      (node as { state?: unknown }).state === "omitted" ||
      (node as { state?: unknown }).state === "truncated")
  );
}

/**
 * Pull the judge spec out of a frozen judge config, fail-closed the way T26 pulls
 * rules: the `judge` subtree must be fully projected — a rubric the redaction
 * policy refused means the freeze did not keep the spec intact, and a spec the
 * policy edited is a spec this judge will not run.
 */
export function extractJudgeSpec(
  judgeConfig: SafeValue,
): ExtractJudgeSpecResult {
  if (judgeConfig.state !== "projected") {
    return {
      kind: "invalid",
      message: `judge config is ${judgeConfig.state}, not projected`,
    };
  }
  const root = judgeConfig.value;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { kind: "invalid", message: "judge config is not an object" };
  }
  if (!("judge" in (root as Record<string, unknown>))) {
    return { kind: "disabled" };
  }
  const node = (root as Record<string, unknown>).judge;
  if (!isEnvelope(node)) {
    return {
      kind: "invalid",
      message: "judge field is not a projection envelope",
    };
  }
  if (node.state !== "projected" || !("value" in node)) {
    return {
      kind: "invalid",
      message: `judge field is ${node.state} — the freeze did not keep it intact`,
    };
  }
  const spec = node.value;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { kind: "invalid", message: "judge spec is not an object" };
  }
  const fields = spec as Record<string, unknown>;
  // Inside the frozen fixture, string leaves are SafeValue-shaped ({state, value}) —
  // the freeze projected this tree through `projectSafeFixture`, not `projectSafeText`.
  const projectedString = (
    node: unknown,
    label: string,
  ): { ok: true; text: string } | { ok: false; message: string } => {
    if (!isEnvelope(node)) {
      return {
        ok: false,
        message: `judge ${label} is not a projection envelope`,
      };
    }
    if (
      node.state !== "projected" ||
      !("value" in node) ||
      typeof node.value !== "string" ||
      node.value.length === 0
    ) {
      return {
        ok: false,
        message: `judge ${label} is ${node.state} — not an intact projected string`,
      };
    }
    return { ok: true, text: node.value };
  };
  const entrance = projectedString(fields.entrance, "entrance");
  if (!entrance.ok) return { kind: "invalid", message: entrance.message };
  const rubric = projectedString(fields.rubric, "rubric");
  if (!rubric.ok) return { kind: "invalid", message: rubric.message };
  return {
    kind: "enabled",
    spec: { entranceId: entrance.text, rubric: rubric.text },
  };
}

/**
 * The judge's failure codes — one vocabulary, each an independently displayable
 * scoring failure (T28 consumes these; a judge failure never renders as a score).
 */
export type JudgeFailureCode =
  | "JUDGE_SPEC_INVALID"
  | "JUDGE_ENTRANCE_NOT_APPROVED"
  | "JUDGE_VERSION_NOT_APPROVED"
  | "JUDGE_MODEL_NOT_PRICED"
  | "JUDGE_BUDGET_REFUSED"
  /**
   * The task was cancelled or its authorization withdrawn before this judge call
   * could start, or the call was aborted in flight (FREV-05). A new billed call is
   * never spent on withdrawn eligibility; the record says so instead of leaving the
   * judge silently absent.
   */
  | "JUDGE_CANCELLED"
  | "JUDGE_INPUT_UNAVAILABLE"
  | "JUDGE_OUTPUT_MISSING"
  | "JUDGE_OUTPUT_UNSAFE"
  | "JUDGE_CALL_FAILED"
  | "JUDGE_VERDICT_INVALID"
  | "JUDGE_SETTLEMENT_ERROR";

export type JudgeScoreRecord =
  | {
      status: "scored";
      /** 0..1, the verdict contract the prompt pins. */
      score: number;
      /** The rationale as the T05 projection answers it — never raw model text. */
      rationale: SafeText;
      /** The scorer version that produced this score (the frozen judgeVersion). */
      scorerVersion: string;
      /** The approved entrance actually dialed — provenance. */
      entranceId: string;
      /** The provider's own usage, or an explicit unknown — never a guessed zero. */
      usage:
        | { inputTokens: number; outputTokens: number }
        | { usageUnknown: true };
    }
  | { status: "failed"; code: JudgeFailureCode; message: string };

/** What one judge invocation needs — frozen content, the case's identity, and its output. */
export type JudgeScoringInput = Readonly<{
  executionId: string;
  caseIndex: number;
  scope: Pick<ObservationScope, "actorId" | "botId">;
  judgeVersion: SafeText;
  judgeConfig: SafeValue;
  sample: Readonly<{ input: SafeText; reference: SafeText }>;
  /** The evaluated case's produced output. */
  output: unknown;
  /**
   * The task's cancellation signal (FREV-05), threaded to the judge's own dial: an
   * abort interrupts a judge call already in flight, and its cost stays an unknown
   * (evidence row, hold kept) rather than a confirmed no-cost.
   */
  signal?: AbortSignal;
}>;

/** `null` means no judge is configured — a rules-only experiment, not a failure. */
export type JudgeScorer = (
  input: JudgeScoringInput,
) => Promise<JudgeScoreRecord | null>;

/**
 * The approved entrance's controlled model call: the credential is resolved from the
 * entrance's own environment here, so the frozen experiment never carries one. Built
 * lazily — deployments that never judge never pay for the client.
 */
export function createEntranceModelCall(
  entrance: ApprovedJudgeEntrance,
): EvaluationModelCall {
  const envName = entrance.apiKeyEnv;
  // Fail closed per entrance (OCR m224): a declared credential missing from the
  // environment refuses THIS entrance — createGatewayModelCall's OPENAI_API_KEY
  // fallback would otherwise ship the deployment gateway's key to this entrance's
  // baseURL, whoever operates it. The refusal is per-call, so one misconfigured
  // entrance answers as a failed judge record and the worker stays up.
  if (envName !== undefined && !process.env[envName]) {
    return () =>
      Promise.reject(
        new Error(
          `judge entrance refused: credential env ${envName} is not set`,
        ),
      );
  }
  // R4-27, the m224 doctrine extended to the base URL: an entrance pinned to a
  // non-default baseURL must declare the credential that dials it. With no
  // apiKeyEnv the call would fall back to OPENAI_API_KEY — shipping the deployment
  // gateway's key to whatever host the entrance names. The entrance is refused
  // per-call instead of guessed: declare an apiKeyEnv for this baseURL, or drop
  // the baseURL to ride the deployment's own gateway, which that key belongs to.
  if (entrance.baseURL !== undefined && envName === undefined) {
    return () =>
      Promise.reject(
        new Error(
          "judge entrance refused: a non-default baseURL requires a declared apiKeyEnv — the deployment gateway key is never forwarded to a third-party endpoint",
        ),
      );
  }
  return createGatewayModelCall({
    apiKey: envName === undefined ? undefined : process.env[envName],
    baseURL: entrance.baseURL,
  });
}

const failed = (code: JudgeFailureCode, message: string): JudgeScoreRecord => ({
  status: "failed",
  code,
  message,
});

/**
 * The judge's verdict JSON, recovered from the shapes models actually answer in
 * (OCR m226): a fenced block, a fenced block inside prose, or a balanced object
 * with a prose prefix. The strict whole-string parse stays the first candidate —
 * these widen what is ACCEPTED, never what the verdict contract admits.
 */
const firstBalancedObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === undefined) return null;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
};

const verdictJsonCandidates = (text: string): readonly string[] => {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.unshift(fenced[1].trim());
  const balanced = firstBalancedObject(trimmed);
  if (balanced !== null) candidates.unshift(balanced);
  return candidates;
};

/** The strict verdict contract: one JSON object, a finite 0..1 score, a rationale. */
function parseVerdict(
  text: string,
): { score: number; rationale: string } | null {
  for (const candidate of verdictJsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      continue;
    const { score, rationale } = parsed as Record<string, unknown>;
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      continue;
    }
    if (typeof rationale !== "string" || rationale.length === 0) continue;
    return { score, rationale };
  }
  return null;
}

/**
 * The billed judge. The gate order is the whole contract: spec → entrance → version →
 * price → sample → output, all fail-closed with zero provider calls and zero
 * reservations, and only then the hold, and only then the dial.
 */
export function createJudgeScorer(
  deps: Readonly<{
    /** The controlled model call — the wiring builds this from an approved entrance. */
    callModel: EvaluationModelCall;
    admission: Readonly<{
      entrances: JudgeEntranceList;
      approvedVersions: ReadonlySet<string>;
      /** The frozen models' price ceilings; a model this map does not name is not admissible. */
      policy: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
    }>;
    billing: Readonly<{
      creditWriter: Pick<CreditWriter, "reserveCredits">;
      outbox: Pick<UsageOutbox, "record">;
      externalCustomerId: string;
    }>;
    reservationWindowMs?: number;
    log?: (message: string) => void;
  }>,
): JudgeScorer {
  const evidence = createUsageEvidenceRecorder(deps.billing.outbox, deps.log);
  const windowMs = deps.reservationWindowMs ?? DEFAULT_RESERVATION_WINDOW_MS;

  return async (input) => {
    const extracted = extractJudgeSpec(input.judgeConfig);
    if (extracted.kind === "disabled") return null;
    if (extracted.kind === "invalid") {
      return failed("JUDGE_SPEC_INVALID", extracted.message);
    }

    // AC1, three keys: the entrance the deployment approved, the scorer version it
    // approved (and this module implements), the price the billing seam will honor.
    const entrance = deps.admission.entrances.get(extracted.spec.entranceId);
    if (!entrance) {
      return failed(
        "JUDGE_ENTRANCE_NOT_APPROVED",
        `entrance ${JSON.stringify(extracted.spec.entranceId)} is not on the approved list`,
      );
    }
    const version =
      input.judgeVersion.state === "projected" && "text" in input.judgeVersion
        ? input.judgeVersion.text
        : null;
    if (
      version !== JUDGE_SCORER_VERSION ||
      !deps.admission.approvedVersions.has(version)
    ) {
      return failed(
        "JUDGE_VERSION_NOT_APPROVED",
        `scorer version ${JSON.stringify(version)} is neither implemented (${JUDGE_SCORER_VERSION}) nor approved`,
      );
    }
    const modelPolicy = deps.admission.policy.get(entrance.modelName);
    if (!modelPolicy) {
      return failed(
        "JUDGE_MODEL_NOT_PRICED",
        `judge model ${JSON.stringify(entrance.modelName)} has no configured price`,
      );
    }

    // AC3: only projected content enters the prompt. A withheld sample or reference
    // means there is nothing safe to judge; a truncation is still reviewed text.
    const textOf = (safe: SafeText): string | null =>
      "text" in safe ? safe.text : null;
    const sampleText = textOf(input.sample.input);
    const referenceText = textOf(input.sample.reference);
    if (sampleText === null || referenceText === null) {
      return failed(
        "JUDGE_INPUT_UNAVAILABLE",
        "the sample or reference is withheld by the redaction policy — nothing safe to judge",
      );
    }
    if (typeof input.output !== "string") {
      return failed(
        "JUDGE_OUTPUT_MISSING",
        "the case produced no scoreable output",
      );
    }
    // The raw output is projected before it joins the prompt (OCR m229): every
    // other string that reaches this module's surfaces rides a projection envelope,
    // and the judge's entrance may point at a third-party baseURL — a credential
    // the evaluated model echoed must not travel there verbatim. Free text is the
    // honest projection here (allowFreeText, like the rationale); an omitted value
    // means the refusal, not a stripped prompt.
    const outputEnvelope = projectSafeText(input.output, {
      allowFreeText: true,
    });
    if (outputEnvelope.state === "omitted") {
      return failed(
        "JUDGE_OUTPUT_UNSAFE",
        "the case output carries a credential-class value; it is refused, not forwarded",
      );
    }

    // The admission the judge's own call must pass — T25's seam, the judge's event id.
    const eventId = judgeCaseUsageId(input.executionId, input.caseIndex);
    let reservationId: string | undefined;
    try {
      const hold = await deps.billing.creditWriter.reserveCredits({
        externalCustomerId: deps.billing.externalCustomerId,
        idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}${eventId}`,
        maximumCents: Number(modelPolicy.maximumReservationUnits),
        expiresAt: new Date(Date.now() + windowMs),
      });
      if (!hold.reserved) {
        return failed(
          "JUDGE_BUDGET_REFUSED",
          "the balance cannot cover the judge hold",
        );
      }
      reservationId = hold.reservationId;
    } catch (error) {
      // A terminal hold's replay is a refusal: a settled judge call is never dialed again.
      deps.log?.(
        `billing: opik_judge_admission_failed event=${eventId} code=${
          error instanceof CreditReservationConflictError
            ? "reservation_conflict"
            : "credit_gate_failed"
        }`,
      );
      return failed(
        "JUDGE_BUDGET_REFUSED",
        "the credit gate refused the judge call",
      );
    }

    const base = {
      eventId,
      source: "llm" as const,
      externalCustomerId: deps.billing.externalCustomerId,
      model: entrance.modelName,
      client: JUDGE_USAGE_CLIENT,
      occurredAt: new Date(),
    };
    const settle = async (usage: {
      inputTokens?: number;
      outputTokens?: number;
    }): Promise<
      | { settled: true; usage: { inputTokens: number; outputTokens: number } }
      | { settled: false; code: string }
    > => {
      const inTokens = usage.inputTokens;
      const outTokens = usage.outputTokens;
      if (typeof inTokens === "number" && typeof outTokens === "number") {
        try {
          const charged = calculateExactModelUsageCharge(modelPolicy, {
            inputTokens: inTokens,
            outputTokens: outTokens,
          });
          await deps.billing.outbox.record({
            ...base,
            transactionId: eventId,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            reservationId: reservationId as string,
            actualCostNumerator: charged.actual.numerator.toString(),
            actualCostDenominator: charged.actual.denominator.toString(),
            botId: input.scope.botId,
            ownerUserId: input.scope.actorId,
          });
          return {
            settled: true,
            usage: {
              inputTokens: charged.inputTokens,
              outputTokens: charged.outputTokens,
            },
          };
        } catch (error) {
          const code =
            error instanceof UsageChargeError
              ? error.code
              : "usage_outbox_write_failed";
          await evidence({
            ...base,
            inputTokens: inTokens,
            outputTokens: outTokens,
            reason: code,
          });
          return { settled: false, code };
        }
      }
      // A score without usage is not budget evidence: the evidence row blocks for
      // review, the hold stays occupied, the usage fact answers an explicit unknown.
      await evidence({
        ...base,
        inputTokens: 0,
        outputTokens: 0,
        reason: "usage_missing",
      });
      return { settled: false, code: "usage_missing" };
    };

    let answer: Awaited<ReturnType<EvaluationModelCall>>;
    try {
      answer = await deps.callModel({
        modelName: entrance.modelName,
        // The entrance identity rides the request (OCR R4-23): the dispatch that
        // turns this request into a dial must honor the same entrance this record
        // names, even when another approved entrance carries the same model name.
        entranceId: extracted.spec.entranceId,
        modelParameters: {},
        system: [
          extracted.spec.rubric,
          'Answer with exactly one JSON object: {"score": <number 0..1>, "rationale": "<string>"}. Nothing else.',
        ].join("\n\n"),
        user: [
          "## Input",
          sampleText,
          "## Reference",
          referenceText,
          "## Output",
          outputEnvelope.text,
        ].join("\n\n"),
        signal: input.signal,
      });
    } catch {
      // FREV-05: an abort from the task's signal is a cancellation, not a provider
      // failure. The call may have been producing billable work when it was
      // stopped, so the evidence row answers `cancelled` — the unknown-cost word
      // that keeps the hold occupied (ADR-0003's pending settlement), never the
      // released `provider_error`.
      if (input.signal?.aborted) {
        await evidence({
          ...base,
          inputTokens: 0,
          outputTokens: 0,
          reason: "cancelled",
        });
        return failed(
          "JUDGE_CANCELLED",
          "the task was cancelled while the judge call was in flight",
        );
      }
      // One attempt, unknown cost: evidence row, hold retained — the T25 doctrine.
      await evidence({
        ...base,
        inputTokens: 0,
        outputTokens: 0,
        reason: "provider_error",
      });
      return failed("JUDGE_CALL_FAILED", "the judge provider call threw");
    }

    // Settle first: the tokens were spent whatever the verdict says.
    const settled = await settle({
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    });
    if (!settled.settled && settled.code !== "usage_missing") {
      return failed("JUDGE_SETTLEMENT_ERROR", settled.code);
    }

    const verdict = parseVerdict(answer.output);
    if (!verdict) {
      return failed(
        "JUDGE_VERDICT_INVALID",
        "the judge verdict does not satisfy the contract",
      );
    }
    return {
      status: "scored",
      score: verdict.score,
      rationale: projectSafeText(verdict.rationale, { allowFreeText: true }),
      scorerVersion: version,
      entranceId: extracted.spec.entranceId,
      usage: settled.settled ? settled.usage : { usageUnknown: true },
    };
  };
}

/**
 * The case-runner seam composition: the T25 billed runner (or any case runner) inside,
 * the judge beside it. Only completed cases are judged — a failed or unknown case has
 * nothing to score and the judge stays silent — and the judge's own record rides the
 * outcome's `judge` field, so the case's execution truth and its scoring truth are
 * separate facts for the results surface (T28) to show separately. The wrapper adds
 * no retries, no re-reads and no scope reach: everything it touches was already in
 * the case context.
 *
 * The explicit `Promise<EvaluationCaseOutcome>` is load-bearing: TypeScript 5.9 does
 * not excess-property-check an async arrow's returned literal against an inherited
 * contextual signature, so without the annotation a legacy `{status, detail}` shape
 * compiles green and the worker silently drops the judge record. With it, a shape
 * drift is a compile error, not a landing-channel loss.
 *
 * ## The admission re-check (FREV-05)
 *
 * The judge is a NEW billed call started after the evaluated call returns, and the
 * eligibility that admitted the case can be gone by then: a cancel or a revocation
 * settles the task while its model call is away, and the model still answers
 * completed. No new spend starts on withdrawn eligibility — the task's signal is
 * the cheap check, the context's re-check the authoritative re-query (row still
 * running + live authorization), and both fail closed: a re-check that cannot be
 * answered is not an admission. The withholder is a `JUDGE_CANCELLED` record, not
 * a silently missing judge: the case's own completed truth stands (its cost was
 * real and settles by the thrown-call doctrine), and the results surface shows
 * why there is no score.
 */
export function createJudgeScoringCaseRunner(
  deps: Readonly<{ inner: EvaluationCaseRunner; judge: JudgeScorer }>,
): EvaluationCaseRunner {
  return async (context): Promise<EvaluationCaseOutcome> => {
    const outcome = await deps.inner(context);
    if (outcome.status !== "completed") return outcome;
    // FREV-05: the re-check before the judge's own billed call — see the module
    // note above. Composition without a re-check seam (a unit fixture, a caller
    // that never heard of it) keeps the signal check alone; production's worker
    // always supplies both.
    if (
      context.signal?.aborted === true ||
      (context.recheckAdmission !== undefined &&
        !(await context.recheckAdmission().catch(() => false)))
    ) {
      return {
        ...outcome,
        judge: failed(
          "JUDGE_CANCELLED",
          "the task was cancelled or its authorization withdrawn before the judge call started",
        ),
      };
    }
    // The judge failing never unseats the case's own outcome (OCR m223): an escape
    // from the scorer — a seam throwing, a projection regressing — lands as a failed
    // judge record, so the completed case and its settled billing stay answerable
    // instead of being swallowed whole by CASE_EXECUTION_ERROR.
    let record: JudgeScoreRecord | null;
    try {
      record = await deps.judge({
        executionId: context.executionId,
        caseIndex: context.caseIndex,
        scope: context.scope,
        judgeVersion: context.config.judgeVersion,
        judgeConfig: context.config.judgeConfig,
        sample: {
          input: context.frozenCase.safeInput,
          reference: context.frozenCase.referenceOutput,
        },
        output: outcome.output,
        signal: context.signal,
      });
    } catch (error) {
      // R3-44: the record persists and renders on the results page, and a driver
      // error's own text can carry connection details — the usage-evidence
      // discipline ("no error message — a driver error can carry connection
      // details") applies here too. The record carries the static message; the
      // detail stays in the server log.
      getLogger("server").warn(
        {
          type: "opik-judge-scorer-threw",
          executionId: context.executionId,
          caseIndex: context.caseIndex,
          error: error instanceof Error ? error.message : String(error),
        },
        "opik-judge-scorer-threw — the judge record carries only the static message",
      );
      record = failed("JUDGE_CALL_FAILED", "the judge scorer threw");
    }
    if (record === null) return outcome;
    return { ...outcome, judge: record };
  };
}
