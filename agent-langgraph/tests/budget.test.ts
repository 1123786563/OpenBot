// The budget contract this endpoint enforces (R3-02), unit level.
//
// The receipt this file pins has three independent implementations: the ledger here, the
// server's check (`server/src/ai-observability/remote-run.ts`), and the signing literal this
// suite asserts against. The real process behind both ends is in `budget-contract.test.ts`.

import { createHmac } from "node:crypto";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  BUDGET_RECEIPT_EVENT,
  type BudgetContract,
  BudgetContractInvalidError,
  BudgetExceededError,
  estimateTokens,
  RunBudgetLedger,
  readBudgetContract,
  receiptSigningInput,
  signReceipt,
} from "../src/budget";

const caps = {
  modelSteps: 3,
  inputTokens: 500,
  outputTokens: 200,
  totalTokens: 600,
};

const contract = (
  overrides: Partial<BudgetContract["caps"]> = {},
): BudgetContract => ({
  v: 1,
  runId: "run-1",
  caps: { ...caps, ...overrides },
});

const input = (budget: unknown, runId = "run-1") =>
  ({
    runId,
    threadId: "thread-1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: budget === undefined ? {} : { openbotBudget: budget },
  }) as Parameters<typeof readBudgetContract>[0];

describe("reading the contract out of the run request", () => {
  test("absent means an unbudgeted caller, not an error", () => {
    expect(readBudgetContract(input(undefined))).toBeNull();
    expect(readBudgetContract(input(null))).toBeNull();
  });

  test("a contract this process cannot read is refused rather than guessed at", () => {
    expect(() => readBudgetContract(input("nope"))).toThrow(
      BudgetContractInvalidError,
    );
    expect(() => readBudgetContract(input({ v: 2, runId: "r", caps }))).toThrow(
      /version/,
    );
    expect(() => readBudgetContract(input({ v: 1, caps }))).toThrow(/run id/);
    expect(() =>
      readBudgetContract(input({ v: 1, runId: "r", caps: {} })),
    ).toThrow(/modelSteps/);
    expect(() =>
      readBudgetContract(
        input({ v: 1, runId: "r", caps: { ...caps, inputTokens: -1 } }),
      ),
    ).toThrow(/inputTokens/);
  });

  test("a well-formed contract arrives intact", () => {
    expect(readBudgetContract(input(contract()))).toEqual(contract());
  });
});

describe("the ledger: what may start, what must stop", () => {
  const messages = (text: string) => [new HumanMessage(text)];
  const call = (inputTokens: number, outputTokens: number) =>
    new AIMessage({
      content: "ok",
      usage_metadata: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    });

  test("a step past the cap never starts", () => {
    const ledger = new RunBudgetLedger(contract());
    expect(ledger.beginModelStep(messages("hi"))).toBe(200);
    ledger.recordModelCall(call(10, 5));
    ledger.beginModelStep(messages("hi"));
    ledger.recordModelCall(call(10, 5));
    // Third call allowed, fourth refused before the model is dialled.
    ledger.beginModelStep(messages("hi"));
    ledger.recordModelCall(call(10, 5));
    expect(() => ledger.beginModelStep(messages("hi"))).toThrow(
      BudgetExceededError,
    );
    expect(ledger.usage.modelSteps).toBe(3);
    expect(ledger.status).toBe("budget_exceeded");
  });

  test("a call whose input is projected past the cap is refused before it is made", () => {
    const ledger = new RunBudgetLedger(contract({ inputTokens: 20 }));
    // 8 ASCII characters estimate to ~3 tokens, the message overhead another 4 — anything
    // much larger than the cap refuses up front rather than after the provider billed it.
    expect(() => ledger.beginModelStep(messages("x".repeat(600)))).toThrow(
      BudgetExceededError,
    );
    expect(ledger.usage.modelSteps).toBe(0); // never started
  });

  test("the output cap reserves this call's projected input out of the total", () => {
    // Total 10 with a ~5-token projected input ("hi" = 1 + 4 overhead): the provider's
    // output knob can only be the 5 tokens of headroom that remain, or the call's own
    // input plus its full knob would cross the total and the run would be stopped from
    // outside a contract it was told it could spend.
    const ledger = new RunBudgetLedger(
      contract({ inputTokens: 100, outputTokens: 100, totalTokens: 10 }),
    );
    expect(ledger.beginModelStep(messages("hi"))).toBe(5);
  });

  test("the per-call output cap is the REMAINING budget, and shrinks", () => {
    const ledger = new RunBudgetLedger(contract());
    expect(ledger.beginModelStep(messages("hi"))).toBe(200);
    ledger.recordModelCall(call(10, 150));
    expect(ledger.beginModelStep(messages("hi"))).toBe(50);
    ledger.recordModelCall(call(10, 45));
    // Five output tokens still fit, so a fifth call STARTS — capped to those five by the
    // provider, which is the point of returning the remaining budget rather than the cap.
    expect(ledger.beginModelStep(messages("hi"))).toBe(5);
    ledger.recordModelCall(call(10, 5));
    // And with nothing left, the next call cannot be sized, so it cannot start.
    expect(() => ledger.beginModelStep(messages("hi"))).toThrow(
      BudgetExceededError,
    );
  });

  test("exact usage past a cap stops the loop with the crossing recorded", () => {
    const ledger = new RunBudgetLedger(contract({ inputTokens: 100 }));
    ledger.beginModelStep(messages("hi"));
    expect(() => ledger.recordModelCall(call(600, 5))).toThrow(
      BudgetExceededError,
    );
    // The receipt reports what was actually spent — past the cap, with the stop named.
    expect(ledger.usage.inputTokens).toBe(600);
    expect(ledger.status).toBe("budget_exceeded");
  });

  test("a call that reports no usage stops the run rather than running unmeasured", () => {
    const ledger = new RunBudgetLedger(contract());
    ledger.beginModelStep(messages("hi"));
    expect(() =>
      ledger.recordModelCall(new AIMessage({ content: "ok" })),
    ).toThrow(/budget/i);
  });

  test("the receipt echoes the contract and reports the stop", () => {
    const ledger = new RunBudgetLedger(contract());
    ledger.beginModelStep(messages("hi"));
    ledger.recordModelCall(call(120, 30));
    expect(ledger.receiptBody()).toEqual({
      kind: BUDGET_RECEIPT_EVENT,
      v: 1,
      runId: "run-1",
      caps,
      usage: {
        modelSteps: 1,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
      status: "ok",
    });
  });
});

describe("the estimate: conservative in both directions that matter", () => {
  test("a CJK character is a whole token; Latin is three characters to one", () => {
    const wide = estimateTokens([new HumanMessage("你好世界")]);
    const narrow = estimateTokens([new HumanMessage("abcdefgh")]);
    // 4 CJK chars plus the per-message overhead, versus ceil(8/3)+4.
    expect(wide).toBe(4 + 4);
    expect(narrow).toBe(3 + 4);
    expect(estimateMessages("你好世界")).toBeLessThan(
      estimateMessages("abcd".repeat(12)),
    );
  });

  test("a non-text part is a block, never free", () => {
    const message = new AIMessage({
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,xxxx" } },
      ],
    });
    expect(estimateTokens([message])).toBeGreaterThanOrEqual(2_000);
  });

  test("string and unrecognised parts of a content array are never free", () => {
    // A bare string part and a null would both have been skipped as 0 tokens; the estimate
    // must never be the optimist in the room, so text counts as text and the rest as a block.
    const message = new AIMessage({
      content: ["abcdefgh", null] as unknown as AIMessage["content"],
    });
    // ceil(8/3) text tokens + a 2_000 block + overhead.
    expect(estimateTokens([message])).toBe(3 + 2_000 + 4);
  });

  test("tool call arguments are part of the next call's input", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        { name: "search", args: { q: "x".repeat(90) }, id: "call-1" },
      ],
    });
    expect(estimateTokens([message])).toBeGreaterThan(30);
  });
});

function estimateMessages(text: string): number {
  return estimateTokens([new SystemMessage(text)]);
}

describe("the receipt's signature, pinned", () => {
  const body = {
    runId: "run-9",
    caps,
    usage: {
      modelSteps: 2,
      inputTokens: 310,
      outputTokens: 40,
      totalTokens: 350,
    },
    status: "budget_exceeded" as const,
  };

  test("the signing input is the literal both ends build", () => {
    expect(receiptSigningInput(body)).toBe(
      [
        "openbot-budget-receipt",
        "v=1",
        "runId=run-9",
        "caps=3|500|200|600",
        "usage=2|310|40|350",
        "status=budget_exceeded",
      ].join("\n"),
    );
  });

  test("the MAC is the HMAC of that literal under the shared token", () => {
    expect(signReceipt(body, "shared")).toBe(
      createHmac("sha256", "shared")
        .update(receiptSigningInput(body))
        .digest("hex"),
    );
  });
});
