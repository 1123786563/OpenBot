// The endpoint's half of the budget contract, against the REAL process (R3-02).
//
// A scripted provider stands behind `buildModel` — the OpenAI integration really streams from
// it, LangChain really parses its usage chunk, and the graph's own tool loop really turns — so
// what these cases pin is the endpoint's enforcement itself: a step past the cap never dials
// the provider, a call past the token cap stops the loop with what it spent, and every
// contracted run closes with one signed receipt in front of its terminal event.
//
// The OpenBot half — the same receipts checked, the dial refused without a contract — is in
// `server/tests/remote-budget-dial.test.ts` and `server/tests/remote-budget-smoke.test.ts`.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { createServer } from "node:net";
import { expect, test } from "../../tests/support/e2e-compat";
import { BUDGET_RECEIPT_EVENT } from "../src/budget";

type ProviderScript = (request: {
  messages: unknown[];
  tools?: unknown;
  max_tokens?: number;
}) => {
  delta:
    | { role: "assistant"; content: string }
    | {
        role: "assistant";
        tool_calls: {
          index: number;
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }[];
      };
  finish: "stop" | "tool_calls";
  usage: { prompt_tokens: number; completion_tokens: number };
};

/**
 * A scripted OpenAI-style streaming provider: chat-completions SSE with the final usage chunk
 * LangChain reads `usage_metadata` from. `script` decides each turn's answer, so a case can make
 * the model keep calling tools until the budget stops it.
 */
function scriptedProvider(script: ProviderScript) {
  const calls: {
    messages: unknown[];
    tools: unknown;
    max_tokens?: number;
    max_completion_tokens?: number;
  }[] = [];
  /*
   * Plain `node:http`, not `Bun.serve`: this suite runs on the Node runner, and a served
   * handler through the Bun compatibility shim never finished the model's own streaming
   * request back to the endpoint. The script answers the same chat-completions SSE either
   * way — and `server.address().port` is read after `listen` resolves, so the URL below is
   * the port that was actually bound.
   */
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as {
        model: string;
        messages: unknown[];
        tools?: unknown;
        max_tokens?: number;
        max_completion_tokens?: number;
      };
      calls.push({
        messages: body.messages,
        tools: body.tools,
        max_tokens: body.max_tokens,
        max_completion_tokens: body.max_completion_tokens,
      });
      const answer = script(body);
      const base = {
        id: `chatcmpl-${calls.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
      };
      const chunks = [
        {
          ...base,
          choices: [{ index: 0, delta: answer.delta, finish_reason: null }],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: answer.finish }],
        },
        // The usage chunk: empty choices, the numbers the ledger's exact accounting reads.
        {
          ...base,
          choices: [],
          usage: {
            ...answer.usage,
            total_tokens:
              answer.usage.prompt_tokens + answer.usage.completion_tokens,
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
      );
    });
  });
  return {
    calls,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port =
            typeof address === "object" && address !== null ? address.port : 0;
          resolve(`http://127.0.0.1:${port}/v1`);
        });
      }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A port nothing is using yet.
 *
 * Probed with `node:net` rather than a served reservation: the compat layer's `serve` reports
 * its port before the listener is up, so a port-0 reservation can hand back the 0 it was asked
 * for — which the endpoint refuses to boot on, and rightly so.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

type AguiEvent = { type: string } & Record<string, unknown>;

/** One run against the real process, answered as the events it actually sent. */
async function runAgainstEndpoint(
  port: number,
  input: { budget?: unknown; deploymentTools?: string[] },
): Promise<{ events: AguiEvent[]; status: number }> {
  const runId = `run-${crypto.randomUUID()}`;
  const response = await fetch(`http://127.0.0.1:${port}/ag-ui`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": "synthetic-managed-token",
    },
    body: JSON.stringify({
      threadId: "thread-budget",
      runId,
      messages: [{ id: "m1", role: "user", content: "Look up the answer." }],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
      context: [],
      state: {},
      forwardedProps: {
        openbotDeploymentTools: input.deploymentTools ?? [],
        ...(input.budget === undefined ? {} : { openbotBudget: input.budget }),
      },
    }),
  });
  const text = await response.text();
  const events = text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as AguiEvent);
  return { events, status: response.status };
}

/** Start the endpoint process behind the scripted provider, and stop it after. */
async function withEndpoint(
  providerUrl: string,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  /*
   * `process.execPath` when this suite itself runs under Bun (it spawns Bun then), the
   * PATH's `bun` otherwise — the same resolution the Bun compatibility layer performs, read
   * here because this file drives its child directly.
   */
  const bun = process.execPath.includes("bun")
    ? process.execPath
    : (process.env.BUN_PATH ?? "bun");
  const child = spawn(bun, ["--no-env-file", "src/index.ts"], {
    cwd: new URL(".", import.meta.url).pathname.replace(/tests\/$/, ""),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PORT: String(port),
      MANAGED_AGENT_TOKEN: "synthetic-managed-token",
      BOT_PROVIDER: "openai",
      BOT_MODEL: "gpt-4.1-mini",
      OPENAI_API_KEY: "synthetic-provider-key",
      OPENAI_BASE_URL: providerUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const ready = await fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) {
        throw new Error(
          `endpoint never became ready; stderr: ${stderr.join("")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await run(port);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
  }
}

/** The receipt's payload, as these assertions read it back. */
type ReceiptValue = {
  status: string;
  runId: string;
  mac?: string;
  usage: Record<string, number>;
  caps: Record<string, number>;
};

/** The receipt inside the CUSTOM event, with its MAC re-derived here. */
function receiptOf(
  events: AguiEvent[],
): (Record<string, unknown> | undefined)[] {
  return events
    .filter(
      (event) => event.type === "CUSTOM" && event.name === BUDGET_RECEIPT_EVENT,
    )
    .map((event) => event.value as Record<string, unknown>);
}

function expectedMac(value: Record<string, unknown>): string {
  const caps = value.caps as Record<string, number>;
  const usage = value.usage as Record<string, number>;
  // Purpose-derived key (OCR R5 handoff): HMAC(secret, label), same pin as
  // the other budget suites — the token also travels as the dial's Bearer.
  const macKey = createHmac("sha256", "synthetic-managed-token")
    .update("openbot-budget-receipt-mac-v1")
    .digest("hex");
  return createHmac("sha256", macKey)
    .update(
      [
        BUDGET_RECEIPT_EVENT,
        "v=1",
        `runId=${String(value.runId)}`,
        `caps=${caps.modelSteps}|${caps.inputTokens}|${caps.outputTokens}|${caps.totalTokens}`,
        `usage=${usage.modelSteps}|${usage.inputTokens}|${usage.outputTokens}|${usage.totalTokens}`,
        `status=${String(value.status)}`,
      ].join("\n"),
    )
    .digest("hex");
}

test("a run past its model-step cap never dials the provider again", async () => {
  const { calls, start, stop } = scriptedProvider(() => ({
    // Keep asking for the one tool the deployment runs, until the budget stops it.
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call-${calls.length}`,
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    },
    finish: "tool_calls",
    usage: { prompt_tokens: 40, completion_tokens: 5 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    const { events } = await runAgainstEndpoint(port, {
      deploymentTools: ["lookup"],
      budget: {
        v: 1,
        runId: "run-step-cap",
        caps: {
          modelSteps: 2,
          inputTokens: 4_000,
          outputTokens: 500,
          totalTokens: 4_500,
        },
      },
    });

    // Two model calls happened; the third was refused before it was made.
    expect(calls).toHaveLength(2);

    const error = events.find((event) => event.type === "RUN_ERROR");
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("budget");

    const receipts = receiptOf(events);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0] as unknown as ReceiptValue;
    expect(receipt.status).toBe("budget_exceeded");
    expect(receipt.usage).toEqual({
      modelSteps: 2,
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 90,
    });
    expect(receipt.mac).toBe(expectedMac(receipt));

    // The contract's order: the receipt is the LAST event before the terminal.
    const receiptAt = events.findIndex(
      (event) => event.type === "CUSTOM" && event.name === BUDGET_RECEIPT_EVENT,
    );
    expect(events[receiptAt + 1]?.type).toBe("RUN_ERROR");
  });
  await stop();
}, 30_000);

test("a call past its input-token cap stops the loop with the crossing recorded", async () => {
  const { calls, start, stop } = scriptedProvider(() => ({
    delta: { role: "assistant", content: "answer" },
    finish: "stop",
    usage: { prompt_tokens: 6_000, completion_tokens: 8 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    const { events } = await runAgainstEndpoint(port, {
      budget: {
        v: 1,
        runId: "run-token-cap",
        // The prompt's conservative estimate fits under the cap (the guard lets the call
        // start); the input the provider then REPORTS is three times past it.
        caps: {
          modelSteps: 4,
          inputTokens: 2_000,
          outputTokens: 500,
          totalTokens: 2_500,
        },
      },
    });

    expect(calls).toHaveLength(1);
    const error = events.find((event) => event.type === "RUN_ERROR");
    expect(String(error?.message)).toContain("budget");

    const [receipt] = receiptOf(events) as unknown as ReceiptValue[];
    // The honest crossing: input past the cap, the run stopped, nothing hidden.
    expect(receipt.status).toBe("budget_exceeded");
    expect(receipt.usage.inputTokens).toBe(6_000);
    expect(receipt.mac).toBe(expectedMac(receipt));
  });
  await stop();
}, 30_000);

test("a remaining budget past the model's own output ceiling is clamped before the provider", async () => {
  const { calls, start, stop } = scriptedProvider(() => ({
    delta: { role: "assistant", content: "the answer" },
    finish: "stop",
    usage: { prompt_tokens: 220, completion_tokens: 25 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    // A contract far larger than any provider's output limit (the server derives caps from
    // BILLING_CODE_RUN_MAX_RESERVATION_TOKENS, which can exceed the model's own ceiling).
    const { events } = await runAgainstEndpoint(port, {
      budget: {
        v: 1,
        runId: "run-clamped",
        caps: {
          modelSteps: 4,
          inputTokens: 200_000,
          outputTokens: 100_000,
          totalTokens: 300_000,
        },
      },
    });

    expect(calls).toHaveLength(1);
    // gpt-4.1-mini's ceiling, not the contract's 100_000 — a value the provider would
    // refuse outright. The clamp is physical guardrail only: the run still answers, and
    // the budget's own stop remains the accounting layer.
    expect(calls[0]?.max_tokens ?? calls[0]?.max_completion_tokens).toBe(32_768);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const [receipt] = receiptOf(events) as unknown as ReceiptValue[];
    expect(receipt.status).toBe("ok");
  });
  await stop();
}, 30_000);

test("a run inside its caps answers, caps its output per call, and signs its receipt", async () => {
  const { calls, start, stop } = scriptedProvider(() => ({
    delta: { role: "assistant", content: "the answer" },
    finish: "stop",
    usage: { prompt_tokens: 220, completion_tokens: 25 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    const { events } = await runAgainstEndpoint(port, {
      budget: {
        v: 1,
        runId: "run-ok",
        caps: {
          modelSteps: 4,
          inputTokens: 4_000,
          outputTokens: 200,
          totalTokens: 4_200,
        },
      },
    });

    expect(calls).toHaveLength(1);
    // The provider was handed THIS run's remaining output budget as its own cap, so one call
    // cannot emit more than the contract had left — the enforcement that happens on the
    // provider's side of the wire.
    expect(calls[0]?.max_tokens ?? calls[0]?.max_completion_tokens).toBe(200);

    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const [receipt] = receiptOf(events) as unknown as ReceiptValue[];
    expect(receipt).toMatchObject({
      status: "ok",
      runId: "run-ok",
      caps: {
        modelSteps: 4,
        inputTokens: 4_000,
        outputTokens: 200,
        totalTokens: 4_200,
      },
      usage: {
        modelSteps: 1,
        inputTokens: 220,
        outputTokens: 25,
        totalTokens: 245,
      },
    });
    expect(receipt.mac).toBe(expectedMac(receipt));
    const receiptAt = events.findIndex(
      (event) => event.type === "CUSTOM" && event.name === BUDGET_RECEIPT_EVENT,
    );
    expect(events[receiptAt + 1]?.type).toBe("RUN_FINISHED");
  });
  await stop();
}, 30_000);

test("a caller that sends no contract gets no contract: the run answers as it always did", async () => {
  const { start, stop } = scriptedProvider(() => ({
    delta: { role: "assistant", content: "plain answer" },
    finish: "stop",
    usage: { prompt_tokens: 30, completion_tokens: 5 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    const { events } = await runAgainstEndpoint(port, {});
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    // No receipt, because there was nothing to report: this is the deployment's own direct
    // caller, not a budgeted OpenBot dial.
    expect(receiptOf(events)).toEqual([]);
  });
  await stop();
}, 30_000);

test("a contract this process cannot read refuses the run rather than ignoring it", async () => {
  const { start, stop } = scriptedProvider(() => ({
    delta: { role: "assistant", content: "answer" },
    finish: "stop",
    usage: { prompt_tokens: 30, completion_tokens: 5 },
  }));
  const providerUrl = await start();
  await withEndpoint(providerUrl, async (port) => {
    const { events } = await runAgainstEndpoint(port, {
      budget: { v: 7, runId: "run-broken", caps: {} },
    });
    const error = events.find((event) => event.type === "RUN_ERROR");
    expect(String(error?.message)).toContain("budget_contract_invalid");
    expect(receiptOf(events)).toEqual([]);
  });
  await stop();
}, 30_000);
