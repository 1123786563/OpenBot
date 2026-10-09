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
  httpAgentFor,
  PROBE_STREAM_TEXT,
  runInput,
  startCandidate,
  startFakeModel,
  startValidationPlane,
  satisfiesEventContract,
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
 * The integration half: a REAL Go runtime candidate, built and started as a
 * child process by the same coordinator the R4 probe uses, consumed through
 * the locked @ag-ui/client (1.0.1) HttpAgent — no hand-rolled SSE echo
 * anywhere in the loop.
 */
describe("the Go runtime candidate over real HTTP", () => {
  const SERVICE_CREDENTIAL = "test-service-credential-not-a-real-one";
  let candidate: Candidate;
  let model: ReturnType<typeof startFakeModel>;
  let validation: ReturnType<typeof startValidationPlane>;

  beforeAll(async () => {
    model = startFakeModel();
    validation = startValidationPlane(SERVICE_CREDENTIAL);
    candidate = await startCandidate({
      binary: await buildCandidate(),
      serviceCredential: SERVICE_CREDENTIAL,
      modelBaseUrl: model.url,
      validationEndpoint: validation.validationEndpoint,
    });
  }, 180_000);

  afterAll(async () => {
    await candidate?.kill();
    model?.server.stop(true);
    validation?.server.stop(true);
  });

  const headers = (minted: { capability: string; invocation: string }) =>
    candidateHeaders({
      serviceCredential: SERVICE_CREDENTIAL,
      capability: minted.capability,
      invocation: minted.invocation,
    });

  test("an unverified request never reaches the framework", async () => {
    const creds = validation.mint("run_refused", "thread_refused", PROBE_STREAM_TEXT);
    const input = runInput({
      runId: "run_refused",
      threadId: "thread_refused",
      text: PROBE_STREAM_TEXT,
    });
    const bare = await fetch(`${candidate.baseUrl}/agui/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const forged = await fetch(`${candidate.baseUrl}/agui/`, {
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

    const recorder = new LLMock();
    const fakeUrl = await recorder.start();
    let exampleEvents: BaseEvent[];
    let goEvents: BaseEvent[];
    let compareCandidate: Candidate | undefined;
    const previousBase = process.env.OPENAI_BASE_URL;
    try {
      recorder.onMessage(/.*/, { type: "text", content: "protocol-comparison-ok" });
      process.env.OPENAI_BASE_URL = fakeUrl;
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
});
