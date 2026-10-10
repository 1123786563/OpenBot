import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { buildAgents } from "../../src/copilot";
import {
  buildCandidate,
  candidateHeaders,
  collectEvents,
  type Candidate,
  EXECUTION_PATH,
  httpAgentFor,
  PROBE_APPROVAL_TEXT,
  PROBE_RECEIPT_TEXT,
  PROBE_STREAM_TEXT,
  PROBE_SLOW_READER_TEXT,
  PROBE_TOOL_TEXT,
  runInput,
  runWaitState,
  satisfiesEventContract,
  slowReaderAnswer,
  startCandidate,
  startFakeModel,
  startToolPlane,
  startValidationPlane,
  textOf,
} from "../../scripts/enterprise-runtime-probe";

/*
 * The Go runtime candidate's protocol contract, as one reusable assertion.
 *
 * `assertEventContract` is the whole definition of "a complete run" the
 * orchestrator (server/scripts/enterprise-runtime-probe.ts) and these tests
 * share: a run OPENS with exactly one RUN_STARTED, CLOSES with exactly one
 * terminal event, and the terminal event is the LAST thing on the stream.
 * Anything else — an empty stream above all — is not a successful run, so it
 * must throw rather than be counted.
 *
 * The events compared here are the real `@ag-ui/client` (1.0.1) BaseEvents the
 * HttpAgent decodes off the wire; no 0.x-era API notes are copied as contract.
 */
export type ContractEvent = Pick<BaseEvent, "type"> & {
  runId?: string;
  threadId?: string;
};

export function assertEventContract(
  events: Array<{ type: string; runId?: string; threadId?: string }>,
): void {
  expect(events[0]?.type).toBe("RUN_STARTED");
  expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(1);
  expect(
    events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"),
  ).toHaveLength(1);
  expect(["RUN_FINISHED", "RUN_ERROR"]).toContain(events.at(-1)?.type);
}

/** A complete, well-formed run for the behaviour tests below. */
function wellFormed(): ContractEvent[] {
  return [
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT" },
    { type: "TEXT_MESSAGE_END" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r" },
  ];
}

describe("the AG-UI event contract assertion", () => {
  test("empty stream cannot count as a successful run", () => {
    expect(() => assertEventContract([])).toThrow();
  });

  test("a well-formed stream passes", () => {
    expect(() => assertEventContract(wellFormed())).not.toThrow();
  });

  test("a stream that never opened is refused", () => {
    // Model output without the run envelope: not a run, whatever it contains.
    expect(() =>
      assertEventContract([
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT" },
        { type: "RUN_FINISHED", threadId: "t", runId: "r" },
      ]),
    ).toThrow();
  });

  test("two RUN_STARTED events are refused", () => {
    // A retried or re-opened stream concatenated into one: the consumer saw
    // the envelope twice, so it cannot be counted as one clean run.
    expect(() =>
      assertEventContract([
        ...wellFormed(),
        { type: "RUN_STARTED", threadId: "t", runId: "r" },
        { type: "RUN_FINISHED", threadId: "t", runId: "r" },
      ]),
    ).toThrow();
  });

  test("a stream with no terminal event is refused", () => {
    const events = wellFormed().slice(0, -1);
    expect(() => assertEventContract(events)).toThrow();
  });

  test("a terminal event that is not the last event is refused", () => {
    // RUN_FINISHED followed by trailing content: the terminal state was
    // announced before the stream actually ended, which no honest run does.
    expect(() =>
      assertEventContract([
        ...wellFormed(),
        { type: "TEXT_MESSAGE_CONTENT" },
      ]),
    ).toThrow();
  });

  test("a stream ending in RUN_ERROR is a complete (failed) run, not a broken one", () => {
    // The contract counts finished AND errored runs: an error terminal state
    // is a real answer the consumer must see, not a dropped stream.
    expect(() =>
      assertEventContract([
        { type: "RUN_STARTED", threadId: "t", runId: "r" },
        { type: "RUN_ERROR", threadId: "t", runId: "r" },
      ]),
    ).not.toThrow();
  });

  test("two terminal events are refused", () => {
    expect(() =>
      assertEventContract([
        ...wellFormed(),
        { type: "RUN_ERROR", threadId: "t", runId: "r" },
      ]),
    ).toThrow();
  });
});

/*
 * The integration half: the REAL runtime binary (runtime-go's cmd/runtime,
 * built and started as a child process by the same coordinator the R4 probe
 * uses), consumed through the locked @ag-ui/client (1.0.1) HttpAgent against
 * the real /internal/enterprise/v1/runtime/execution route — no hand-rolled
 * SSE echo anywhere in the loop.
 */
describe("the Go runtime candidate over real HTTP", () => {
  const SERVICE_CREDENTIAL = "test-service-credential-not-a-real-one";
  let candidate: Candidate;
  let model: ReturnType<typeof startFakeModel>;
  let validation: ReturnType<typeof startValidationPlane>;
  let toolPlane: ReturnType<typeof startToolPlane>;

  beforeAll(async () => {
    model = startFakeModel();
    validation = startValidationPlane(SERVICE_CREDENTIAL);
    toolPlane = startToolPlane(validation, SERVICE_CREDENTIAL);
    candidate = await startCandidate({
      binary: await buildCandidate(),
      serviceCredential: SERVICE_CREDENTIAL,
      modelBaseUrl: model.url,
      validationEndpoint: validation.validationEndpoint,
      callbackEndpoint: toolPlane.toolPlaneEndpoint,
    });
  }, 180_000);

  afterAll(async () => {
    await candidate?.kill();
    model?.server.stop(true);
    validation?.server.stop(true);
    toolPlane?.server.stop(true);
  });

  const headers = (minted: { capability: string; invocation: string }) =>
    candidateHeaders({
      serviceCredential: SERVICE_CREDENTIAL,
      capability: minted.capability,
      invocation: minted.invocation,
    });

  test("the real binary turns itself ready once fully configured", async () => {
    // The REAL main's readiness: listener bound, authentication configured,
    // not draining — and it never probes the paid model provider to say so.
    const ready = await fetch(`${candidate.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(model.requests).toHaveLength(0);
  }, 30_000);

  test("an unverified request never reaches the framework", async () => {
    const creds = validation.mint("run_refused", "thread_refused", PROBE_STREAM_TEXT);
    const input = runInput({
      runId: "run_refused",
      threadId: "thread_refused",
      text: PROBE_STREAM_TEXT,
    });
    const bare = await fetch(`${candidate.baseUrl}${EXECUTION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const forged = await fetch(`${candidate.baseUrl}${EXECUTION_PATH}`, {
      method: "POST",
      headers: candidateHeaders({
        serviceCredential: SERVICE_CREDENTIAL,
        capability: "forged-capability-signed-by-nobody",
        invocation: creds.invocation,
      }),
      body: JSON.stringify(input),
    });
    expect(bare.status).toBe(401);
    expect(forged.status).toBe(401);
    // The refusals are the whole story: nothing may have reached the provider.
    expect(model.requests).toHaveLength(0);
  }, 30_000);

  test("the candidate's real event stream satisfies the contract", async () => {
    const creds = validation.mint("run_stream", "thread_stream", PROBE_STREAM_TEXT);
    const events = await collectEvents(
      httpAgentFor(candidate.baseUrl, headers(creds)),
      runInput({ runId: "run_stream", threadId: "thread_stream", text: PROBE_STREAM_TEXT }),
    );
    assertEventContract(events);
    // The wire carried the verified run's own coordinates, not somebody else's.
    expect(events[0]).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: "thread_stream",
      runId: "run_stream",
    });
    expect(textOf(events)).toBe("probe-stream-ok");
    expect(satisfiesEventContract(events)).toBe(true);
  }, 30_000);

  test("matches the existing example agent's event semantics on the same fake provider", async () => {
    /*
     * The existing example Agent (src/copilot's buildAgents, the built-in Bot
     * every deployment already runs) and the Go candidate both talk to the
     * SAME fake provider — LLMock, the fake this repository's own tests
     * already point the example agent at — so what is compared is protocol
     * semantics (envelope, ordering, terminal state, run coordinates), never
     * either side's model randomness.
     */
    const recorder = new LLMock();
    const fakeUrl = await recorder.start();
    let exampleEvents: BaseEvent[];
    let goEvents: BaseEvent[];
    let compareCandidate: Candidate | undefined;
    const previousBase = process.env.OPENAI_BASE_URL;
    try {
      recorder.onMessage(/.*/, { type: "text", content: "protocol-comparison-ok" });
      process.env.OPENAI_BASE_URL = fakeUrl;
      /*
       * Built AFTER the fake base URL is in the environment, because
       * src/copilot's runtimeModel freezes OPENAI_BASE_URL into the model
       * instance at construction time (a named base gets createOpenAI({baseURL});
       * only an absent base stays a string resolved later). Building earlier let
       * a deployment's real gateway (the .env a developer runs tests with)
       * capture the agent, so the comparison left the fake provider entirely.
       */
      const agents = await buildAgents(
        [
          {
            id: "example-agent",
            name: "Example Agent",
            type: "built_in" as const,
            systemPrompt: "Be terse.",
          },
        ],
        { provider: "openai" as const, defaultModel: "fixture-model" },
        "test-only",
      );
      const example = agents["example-agent"];
      if (!example) throw new Error('buildAgents returned no "example-agent" to run');
      exampleEvents = await collectEvents(
        example as AbstractAgent,
        runInput({
          runId: "run_example",
          threadId: "thread_example",
          text: "answer the protocol comparison",
        }),
      );
      compareCandidate = await startCandidate({
        binary: await buildCandidate(),
        serviceCredential: SERVICE_CREDENTIAL,
        modelBaseUrl: fakeUrl,
        validationEndpoint: validation.validationEndpoint,
      });
      const creds = validation.mint("run_compare", "thread_compare", "answer the protocol comparison");
      goEvents = await collectEvents(
        httpAgentFor(compareCandidate.baseUrl, candidateHeaders({
          serviceCredential: SERVICE_CREDENTIAL,
          capability: creds.capability,
          invocation: creds.invocation,
        })),
        runInput({
          runId: "run_compare",
          threadId: "thread_compare",
          text: "answer the protocol comparison",
        }),
      );
    } finally {
      if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBase;
      await compareCandidate?.kill();
      await recorder.stop();
    }
    assertEventContract(exampleEvents);
    assertEventContract(goEvents);

    const semantics = (events: BaseEvent[]) => ({
      opensWithRunStarted: events[0]?.type === EventType.RUN_STARTED,
      terminalCount:
        events.filter((e) => e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR)
          .length,
      terminalIsLast:
        events.at(-1)?.type === EventType.RUN_FINISHED ||
        events.at(-1)?.type === EventType.RUN_ERROR,
      hasTextEnvelope: [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
      ].every((type) => events.some((e) => e.type === type)),
      echoesCoordinates:
        events[0] !== undefined &&
        (events[0] as { threadId?: string; runId?: string }).threadId !== undefined &&
        (events[0] as { threadId?: string; runId?: string }).runId !== undefined,
    });
    expect(semantics(goEvents)).toEqual(semantics(exampleEvents));
    expect(semantics(goEvents)).toEqual({
      opensWithRunStarted: true,
      terminalCount: 1,
      terminalIsLast: true,
      hasTextEnvelope: true,
      echoesCoordinates: true,
    });
  }, 60_000);

  test("message and tool-call lifecycles stay paired and ordered across the run", async () => {
    /*
     * R4-A 文本/工具生命周期: every TEXT_MESSAGE_CONTENT/END carries the id
     * of the open TEXT_MESSAGE_START (never a second or unknown id), the
     * same for TOOL_CALL_ARGS/END against their TOOL_CALL_START, and the
     * interleaved governed call's events attribute to their own tool call.
     * TOOL_CALL_END is protocol bookkeeping, never business success: the run
     * only ends on its terminal event after the model's own final answer.
     */
    const creds = validation.mint("run_lifecycle", "thread_lifecycle", PROBE_STREAM_TEXT);
    const events = await collectEvents(
      httpAgentFor(candidate.baseUrl, headers(creds)),
      runInput({ runId: "run_lifecycle", threadId: "thread_lifecycle", text: PROBE_STREAM_TEXT }),
    );
    assertEventContract(events);
    // Text lifecycle: one start, contents and end under ITS messageId.
    const textStart = events.find((e) => e.type === EventType.TEXT_MESSAGE_START) as unknown as { messageId: string };
    expect(textStart).toBeDefined();
    for (const e of events) {
      if (e.type === EventType.TEXT_MESSAGE_CONTENT || e.type === EventType.TEXT_MESSAGE_END) {
        expect((e as unknown as { messageId: string }).messageId).toBe(textStart.messageId);
      }
    }
    expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_END)).toHaveLength(1);
    // Start strictly before its first content, end strictly after the last.
    const indexOf = (predicate: (e: BaseEvent) => boolean) => events.findIndex(predicate);
    expect(indexOf((e) => e.type === EventType.TEXT_MESSAGE_START)).toBeLessThan(
      indexOf((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
    );
    expect(events.findLastIndex?.((e: BaseEvent) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBeLessThan(
      indexOf((e) => e.type === EventType.TEXT_MESSAGE_END),
    );
    // A text-only run carries no tool-call lifecycle at all.
    expect(events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
  }, 30_000);

  test("tool-call events pair with their own tool call id across the governed roundtrip", async () => {
    const creds = validation.mint("run_tool_lifecycle", "thread_tool_lifecycle", PROBE_TOOL_TEXT);
    const events = await collectEvents(
      httpAgentFor(candidate.baseUrl, headers(creds)),
      runInput({ runId: "run_tool_lifecycle", threadId: "thread_tool_lifecycle", text: PROBE_TOOL_TEXT }),
    );
    assertEventContract(events);
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START) as unknown as Array<{ toolCallId: string }>;
    expect(starts).toHaveLength(1);
    const toolCallId = starts[0].toolCallId;
    for (const e of events) {
      if (e.type === EventType.TOOL_CALL_ARGS || e.type === EventType.TOOL_CALL_END) {
        expect((e as unknown as { toolCallId: string }).toolCallId).toBe(toolCallId);
      }
    }
    // TOOL_CALL_END is not the run's end: the terminal comes later, after the
    // model read the receipt and answered.
    expect(events.findLastIndex?.((e: BaseEvent) => e.type === EventType.TOOL_CALL_END)).toBeLessThan(
      events.findLastIndex?.((e: BaseEvent) => e.type === EventType.RUN_FINISHED),
    );
    expect(textOf(events)).toBe("callback-observed");
  }, 30_000);

  test("a run that waits on a human approval ends on the locked interrupt outcome", async () => {
    /*
     * R4-A 等待输入/审批: the governed call the fake plane answers
     * "requires approval" on must end the run WAITING on the locked
     * protocol's verified fields — RUN_FINISHED with outcome.type
     * "interrupt", the frozen operation as the interrupt id, the wire tool
     * call id attached — so the platform mapping (runWaitState) reads
     * waiting_approval and NEVER succeeded. The events asserted on are the
     * @ag-ui/client HttpAgent's own decoded events, so this also proves the
     * locked client's schema pipeline preserves the outcome field.
     */
    const creds = validation.mint("run_wait", "thread_wait", PROBE_APPROVAL_TEXT);
    const events = await collectEvents(
      httpAgentFor(candidate.baseUrl, headers(creds)),
      runInput({ runId: "run_wait", threadId: "thread_wait", text: PROBE_APPROVAL_TEXT }),
    );
    assertEventContract(events);
    const terminal = events.at(-1) as unknown as {
      type: string;
      outcome?: { type: string; interrupts: Array<{ id: string; reason: string; toolCallId?: string }> };
    };
    expect(terminal.type).toBe(EventType.RUN_FINISHED);
    expect(terminal.outcome?.type).toBe("interrupt");
    const interrupt = terminal.outcome?.interrupts?.[0];
    const operation = toolPlane.state.operations.find((op) => op.run_id === "run_wait");
    const toolCallId = (events.find((e) => e.type === EventType.TOOL_CALL_START) as unknown as { toolCallId?: string })
      ?.toolCallId;
    expect(interrupt?.reason).toBe("tool_approval");
    expect(interrupt?.id).toBe(operation?.operation_id);
    expect(interrupt?.toolCallId).toBe(toolCallId);
    // The frozen platform mapping: a WAIT is not a success, and a plain
    // RUN_FINISHED (no interrupt outcome) is not a wait.
    expect(runWaitState(events)).toBe("waiting_approval");
    // Nothing executed while waiting: this operation has no receipt, never
    // left "proposed", and the model was asked exactly once.
    expect(toolPlane.state.receipts.find((r) => r.operation_id === operation?.operation_id)).toBeUndefined();
    expect(operation?.status).toBe("proposed");
    expect(model.requests.filter((r) => r.userText.includes(PROBE_APPROVAL_TEXT))).toHaveLength(1);
  }, 30_000);

  test("a run whose governed receipt stays submitted suspends for reconciliation", async () => {
    /*
     * R4-A 等待输入/审批, the other frozen reason: an execution whose receipt
     * is NOT final (submitted — the spend may or may not have taken effect)
     * must end the run SUSPENDED on the same locked interrupt outcome, reason
     * operation_receipt_pending, the frozen operation as the interrupt id —
     * so the platform mapping (runWaitState) reads suspended_reconciliation,
     * never succeeded and never failed. The spend DID cross the plane (the
     * receipt exists, status submitted), the operation is frozen at submitted
     * (not spent twice), and the model was asked exactly once — a pending
     * receipt is the plane's to settle, not the model's to retry.
     */
    const creds = validation.mint("run_receipt", "thread_receipt", PROBE_RECEIPT_TEXT);
    const events = await collectEvents(
      httpAgentFor(candidate.baseUrl, headers(creds)),
      runInput({ runId: "run_receipt", threadId: "thread_receipt", text: PROBE_RECEIPT_TEXT }),
    );
    assertEventContract(events);
    const terminal = events.at(-1) as unknown as {
      type: string;
      outcome?: { type: string; interrupts: Array<{ id: string; reason: string; toolCallId?: string }> };
    };
    expect(terminal.type).toBe(EventType.RUN_FINISHED);
    expect(terminal.outcome?.type).toBe("interrupt");
    const interrupt = terminal.outcome?.interrupts?.[0];
    const operation = toolPlane.state.operations.find((op) => op.run_id === "run_receipt");
    const toolCallId = (events.find((e) => e.type === EventType.TOOL_CALL_START) as unknown as { toolCallId?: string })
      ?.toolCallId;
    expect(interrupt?.reason).toBe("operation_receipt_pending");
    expect(interrupt?.id).toBe(operation?.operation_id);
    expect(interrupt?.toolCallId).toBe(toolCallId);
    // The frozen platform mapping: an unresolved receipt is a suspension.
    expect(runWaitState(events)).toBe("suspended_reconciliation");
    // The spend crossed the plane and froze: one submitted receipt, the
    // operation held at submitted (never spent twice), the model asked once.
    expect(toolPlane.state.receipts.find((r) => r.operation_id === operation?.operation_id)?.status).toBe("submitted");
    expect(operation?.status).toBe("submitted");
    expect(model.requests.filter((r) => r.userText.includes(PROBE_RECEIPT_TEXT))).toHaveLength(1);
  }, 30_000);

  test("a deliberately slow consumer gets every byte, receipt and terminal back", async () => {
    /*
     * R4-A 慢消费者: the run crosses the governed tool first, then streams a
     * 2 MiB deterministic answer while THIS consumer reads 64 KiB and stalls.
     * The runtime must push the slowness back (bounded queue; the in-process
     * mechanism proof lives in runtime-go's adapter tests) and lose nothing:
     * after catching up, the joined deltas are byte-identical to the fixture,
     * the tool-call events and its receipt's answer flow are intact, and
     * exactly one terminal arrives, last.
     */
    const creds = validation.mint("run_slow_reader", "thread_slow_reader", PROBE_SLOW_READER_TEXT);
    const response = await fetch(`${candidate.baseUrl}${EXECUTION_PATH}`, {
      method: "POST",
      headers: headers(creds),
      body: JSON.stringify(
        runInput({ runId: "run_slow_reader", threadId: "thread_slow_reader", text: PROBE_SLOW_READER_TEXT }),
      ),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let seen = 0;
    while (seen < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      seen += value.byteLength;
    }
    await Bun.sleep(2_000); // the stall: read nothing while the producer pushes
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(merged);
    const events: Array<{ type: string; delta?: string; toolCallId?: string }> = [];
    for (const frame of text.split("\n\n")) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        events.push(JSON.parse(payload));
      }
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.filter((t) => t === "RUN_STARTED")).toHaveLength(1);
    expect(types.filter((t) => t === "RUN_FINISHED" || t === "RUN_ERROR")).toHaveLength(1);
    expect(["RUN_FINISHED", "RUN_ERROR"]).toContain(types.at(-1));
    // Every delta byte arrived, in order, exactly once.
    const joined = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta ?? "").join("");
    expect(joined).toBe(slowReaderAnswer());
    // The receipt's events survived the stall with it.
    const toolStarts = events.filter((e) => e.type === "TOOL_CALL_START");
    expect(toolStarts).toHaveLength(1);
    const operation = toolPlane.state.operations.find((op) => op.run_id === "run_slow_reader");
    expect(toolPlane.state.receipts.find((r) => r.operation_id === operation?.operation_id)?.status).toBe("succeeded");
    expect(model.requests.filter((r) => r.userText.includes(PROBE_SLOW_READER_TEXT))).toHaveLength(2);
  }, 60_000);
});
