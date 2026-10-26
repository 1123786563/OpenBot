/**
 * The enforceable budget contract for a run OpenBot's server dials through (R3-02).
 *
 * WHY THIS EXISTS: a remote Bot's model lives in THIS process, so the only place its
 * consumption can be genuinely bounded is here, at the model call — the same seat the
 * built-in path's admission wraps. A hold OpenBot's server takes covers the run's worst
 * case; this module is what makes that worst case real rather than nominal: the dial
 * carries caps, the loop refuses to START a call that would go past them, and the run's
 * closing event reports exactly what was spent, signed with the token this process and
 * its deployment share. An endpoint that cannot or will not enforce the contract simply
 * never gets one (OpenBot's resolver refuses the endpoint before the dial), and this
 * process runs unbounded only for callers that did not ask it to run bounded.
 *
 * THE CONTRACT'S HONEST LIMITS, stated once so nobody has to reverse them:
 *
 * - `modelSteps` is a hard pre-call cap: a step is counted before it begins, so the
 *   count in any receipt never exceeds the cap.
 * - Output is capped by the provider itself (`maxTokens`/`maxOutputTokens` on the call
 *   the remaining budget sized), so one call cannot emit more output than the contract
 *   had left.
 * - Input cannot be capped at a provider — there is no such knob — so it is guarded
 *   twice: a conservative estimate refuses to START a call whose input is projected
 *   past what remains, and the call's exact reported usage is accounted afterwards and
 *   stops the loop the moment a cap is crossed. The receipt of a run that stopped this
 *   way may therefore show input past its cap — that is the enforced stop, not a
 *   breach; the caller treats `status: "budget_exceeded"` accordingly.
 * - A model call that reports no usage at all stops the run: a budget this process
 *   cannot measure is a budget it cannot enforce, and guessing is not accounting.
 */
import { createHmac } from "node:crypto";
import type { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

/** The one protocol event kind this contract travels in (`CustomEvent.name`). */
export const BUDGET_RECEIPT_EVENT = "openbot-budget-receipt";

/** The one version of the contract, so the two ends can refuse each other loudly. */
export const BUDGET_CONTRACT_VERSION = 1;

/** The caps one run's dial carries, exactly as OpenBot's policy derived them. */
export type BudgetCaps = {
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** The contract as it rides in the run request (`forwardedProps.openbotBudget`). */
export type BudgetContract = {
  v: typeof BUDGET_CONTRACT_VERSION;
  runId: string;
  caps: BudgetCaps;
};

/** What the run actually spent, as this process measured it. */
export type BudgetUsage = {
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** The receipt's payload before signing (`CustomEvent.value`). */
export type BudgetReceipt = {
  kind: typeof BUDGET_RECEIPT_EVENT;
  v: typeof BUDGET_CONTRACT_VERSION;
  runId: string;
  caps: BudgetCaps;
  usage: BudgetUsage;
  status: "ok" | "budget_exceeded";
  mac: string;
};

/** The run stopped at a cap. Carries the person-safe line the wire should show. */
export class BudgetExceededError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** A malformed contract is refused rather than guessed at: no caps, no run. */
export class BudgetContractInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetContractInvalidError";
  }
}

const positiveWhole = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= Number.MAX_SAFE_INTEGER;

/**
 * Read the contract out of the request it rode in.
 *
 * Absent (`null`) is a caller that did not ask for a bounded run — not an error, because
 * the deployment itself dials this endpoint for purposes of its own (its evidence
 * scripts, its tests) and the billed product path is the server that always sends one.
 * Present-but-wrong IS an error: a caller that sent caps this process cannot read is a
 * caller whose budget nobody can enforce.
 */
export function readBudgetContract(
  input: RunAgentInput,
): BudgetContract | null {
  const props = input.forwardedProps as { openbotBudget?: unknown } | undefined;
  const raw = props?.openbotBudget;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BudgetContractInvalidError(
      "The budget contract must be an object.",
    );
  }
  const contract = raw as {
    v?: unknown;
    runId?: unknown;
    caps?: Record<string, unknown>;
  };
  if (contract.v !== BUDGET_CONTRACT_VERSION) {
    throw new BudgetContractInvalidError(
      `Unsupported budget contract version ${JSON.stringify(contract.v)}.`,
    );
  }
  if (typeof contract.runId !== "string" || contract.runId.length === 0) {
    throw new BudgetContractInvalidError(
      "The budget contract carries no run id.",
    );
  }
  const caps = contract.caps;
  if (typeof caps !== "object" || caps === null) {
    throw new BudgetContractInvalidError(
      "The budget contract carries no caps.",
    );
  }
  for (const cap of [
    "modelSteps",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    if (!positiveWhole(caps[cap])) {
      throw new BudgetContractInvalidError(
        `The budget contract's ${cap} cap is not a whole positive number.`,
      );
    }
  }
  return {
    v: BUDGET_CONTRACT_VERSION,
    runId: contract.runId,
    caps: {
      modelSteps: caps.modelSteps as number,
      inputTokens: caps.inputTokens as number,
      outputTokens: caps.outputTokens as number,
      totalTokens: caps.totalTokens as number,
    },
  };
}

/*
 * The receipt's signing input, in the exact shape BOTH ends build it: OpenBot's server
 * re-derives this string from the parsed receipt to check the MAC, so every field the
 * signature covers is in it, in this order, with these separators. A test in each
 * package pins the literal so the two implementations cannot drift apart silently.
 */
export function receiptSigningInput(input: {
  runId: string;
  caps: BudgetCaps;
  usage: BudgetUsage;
  status: BudgetReceipt["status"];
}): string {
  return [
    BUDGET_RECEIPT_EVENT,
    `v=${BUDGET_CONTRACT_VERSION}`,
    `runId=${input.runId}`,
    `caps=${input.caps.modelSteps}|${input.caps.inputTokens}|${input.caps.outputTokens}|${input.caps.totalTokens}`,
    `usage=${input.usage.modelSteps}|${input.usage.inputTokens}|${input.usage.outputTokens}|${input.usage.totalTokens}`,
    `status=${input.status}`,
  ].join("\n");
}

/** HMAC-SHA256 over the signing input with the secret the deployment and this process share. */
export function signReceipt(
  input: Parameters<typeof receiptSigningInput>[0],
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(receiptSigningInput(input))
    .digest("hex");
}

/**
 * One run's ledger and its enforcement, in the order the docblock above promises.
 *
 * The caller drives it from the graph's model node — `beginModelStep` before the call,
 * `recordModelCall` after it — because that is the one place the loop can still decide
 * not to spend. Everything here is synchronous and in-memory: the caps were decided
 * before the run started, and the receipt is the durable half.
 */
export class RunBudgetLedger {
  /** The contract this run runs under, kept for the receipt it must echo. */
  readonly contract: BudgetContract;

  private callsStarted = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  /** The last call's exact input tokens: the measured half of the next call's projection. */
  private lastInputTokens = 0;
  /** How many messages the last call was sized against; everything after is new. */
  private countedMessages = 0;
  private stopReason: string | null = null;

  constructor(contract: BudgetContract) {
    this.contract = contract;
  }

  get usage(): BudgetUsage {
    return {
      modelSteps: this.callsStarted,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
    };
  }

  get status(): BudgetReceipt["status"] {
    return this.stopReason === null ? "ok" : "budget_exceeded";
  }

  /** The graph's own loop limit, sized so LangGraph's ceiling never fires before ours. */
  recursionLimit(): number {
    return this.contract.caps.modelSteps * 2 + 2;
  }

  /**
   * Decide whether the next model call may start, and size its output cap.
   *
   * Called with the full message list the call would see: the projected input is the
   * last call's measured input plus a conservative estimate of the messages added
   * since, which is why refusing happens here rather than after the provider has been
   * paid for the same prompt a second time.
   */
  beginModelStep(messages: readonly BaseMessage[]): number {
    if (this.stopReason !== null) {
      throw new BudgetExceededError(
        this.stopReason,
        "This run already stopped at its budget.",
      );
    }
    if (this.callsStarted >= this.contract.caps.modelSteps) {
      this.stop("model_steps", this.contract.caps.modelSteps);
    }
    const projectedInput =
      this.lastInputTokens +
      estimateTokens(messages.slice(this.countedMessages));
    if (this.inputTokens + projectedInput > this.contract.caps.inputTokens) {
      this.stop("input_tokens", this.contract.caps.inputTokens);
    }
    if (
      this.inputTokens + this.outputTokens + projectedInput >
      this.contract.caps.totalTokens
    ) {
      this.stop("total_tokens", this.contract.caps.totalTokens);
    }
    const outputCap = Math.min(
      this.contract.caps.outputTokens - this.outputTokens,
      this.contract.caps.totalTokens -
        this.inputTokens -
        this.outputTokens -
        projectedInput,
    );
    if (outputCap <= 0) {
      this.stop("output_tokens", this.contract.caps.outputTokens);
    }
    this.callsStarted += 1;
    this.countedMessages = messages.length;
    return outputCap;
  }

  /** Account one finished call from the usage the provider itself reported. */
  recordModelCall(message: AIMessage): void {
    if (this.stopReason !== null) return;
    const usage = message.usage_metadata;
    if (
      usage === undefined ||
      !Number.isSafeInteger(usage.input_tokens) ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.input_tokens < 0 ||
      usage.output_tokens < 0
    ) {
      // Unmeasurable is unenforceable: stop rather than carry a cap nobody counted.
      this.stop("usage_unreported", 0);
    }
    this.lastInputTokens = usage.input_tokens;
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    if (this.inputTokens > this.contract.caps.inputTokens) {
      this.stop("input_tokens", this.contract.caps.inputTokens);
    }
    if (this.outputTokens > this.contract.caps.outputTokens) {
      this.stop("output_tokens", this.contract.caps.outputTokens);
    }
    if (this.inputTokens + this.outputTokens > this.contract.caps.totalTokens) {
      this.stop("total_tokens", this.contract.caps.totalTokens);
    }
  }

  /** The run's closing receipt: what this run spent, signed with the shared secret. */
  receiptBody(): Omit<BudgetReceipt, "mac"> {
    return {
      kind: BUDGET_RECEIPT_EVENT,
      v: BUDGET_CONTRACT_VERSION,
      runId: this.contract.runId,
      caps: this.contract.caps,
      usage: this.usage,
      status: this.status,
    };
  }

  private stop(reason: string, cap: number): never {
    this.stopReason = reason;
    throw new BudgetExceededError(
      reason,
      cap > 0
        ? `This run stopped at the budget its deployment allows (${reason}, limit ${cap}).`
        : "This run stopped at the budget its deployment allows.",
    );
  }
}

/** The receipt as one protocol event, sent as the run's last pre-terminal event. */
export function budgetReceiptEvent(
  ledger: RunBudgetLedger,
  secret: string,
): BaseEvent {
  const body = ledger.receiptBody();
  const mac = signReceipt(body, secret);
  return {
    type: "CUSTOM" as EventType.CUSTOM,
    name: BUDGET_RECEIPT_EVENT,
    value: { ...body, mac },
  } as unknown as BaseEvent;
}

/*
 * The input estimate, deliberately conservative in both directions that matter.
 *
 * A CJK code point is counted as a full token (they tokenize at roughly one token per
 * character and never less); everything else at one token per three characters, which
 * over-counts ordinary Latin prose (closer to four) by design. Media and other
 * non-text parts are charged a flat block each, because their cost is in pixels rather
 * than characters and this estimate must never be the optimist in the room.
 */
const NON_TEXT_PART_TOKENS = 2_000;
const MESSAGE_OVERHEAD = 4;

function isCjkCodePoint(point: number): boolean {
  return (
    (point >= 0x2e80 && point <= 0x9fff) ||
    (point >= 0xac00 && point <= 0xd7af) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xff00 && point <= 0xffef) ||
    (point >= 0x20000 && point <= 0x3fffd)
  );
}

function estimateTextTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0) ?? 0)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 3);
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (typeof part === "string") {
        tokens += estimateTextTokens(part);
        continue;
      }
      if (typeof part !== "object" || part === null) {
        tokens += NON_TEXT_PART_TOKENS;
        continue;
      }
      const record = part as { type?: unknown; text?: unknown };
      tokens +=
        record.type === "text" && typeof record.text === "string"
          ? estimateTextTokens(record.text)
          : NON_TEXT_PART_TOKENS;
    }
    return tokens;
  }
  return NON_TEXT_PART_TOKENS;
}

export function estimateTokens(messages: readonly BaseMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += MESSAGE_OVERHEAD + estimateContentTokens(message.content);
    const calls = (
      message as unknown as {
        tool_calls?: { name?: string; args?: unknown }[];
      }
    ).tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        tokens += estimateTextTokens(call.name ?? "");
        tokens += estimateTextTokens(JSON.stringify(call.args ?? {}));
      }
    }
  }
  return tokens;
}
