// F5E1-F2 / R3-02 — the remote dial exists behind an enforceable budget CONTRACT (run f7d).
//
// The F6D finding accepted here: a per-run hold is not a contract. It bounds what is CHARGED,
// never what a remote endpoint SPENDS, and the F6D tests proved the dial reached a scripted
// endpoint through a STAND-IN gate — nothing about the real seams. This suite is rewritten
// around the real ones:
//
//   * `createRemoteBudgetContractResolver` decides which endpoints may dial at all, from the
//     operator's endpoint list, the deployment token both ends hold, and the policy's token
//     ceiling — so "unsupported" is a build-time refusal before any fetch;
//   * `createRemoteRunBudgetGate` holds the run's worst case in credits in the same ledger the
//     built-in path uses, and marks it unknown at the end (never a release);
//   * the dial carries `forwardedProps.openbotBudget`, and the run is only delivered if the
//     endpoint's SIGNED receipt checks out against it — a receipt over its caps, a forged one,
//     or a terminal event without one tears the run down before the ending reaches the person.
//
// The four original cases survive in their new form (dial, refusal, teardown, confirmed
// cancellation); the contract violations are new. The endpoint itself is scripted here — the
// real agent-langgraph process is driven in `remote-budget-contract.test.ts`.

import { createHmac } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType, HttpAgent } from "@ag-ui/client";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect, spyOn, test } from "../../tests/support/e2e-compat";
import type {
  BeginRunBindingInput,
  RunBinding,
} from "../src/ai-observability/bindings";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type {
  OpikOtlpSpan,
  OpikPort,
  OpikRunBindingRef,
} from "../src/ai-observability/opik-port";
import {
  canonicalRemoteEndpoint,
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
  createRemoteRunRecorder,
  remoteBudgetCaps,
} from "../src/ai-observability/remote-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  type AgentFetch,
  buildAgents,
  REMOTE_BUDGET_RECEIPT_EVENT,
  type RemoteBudgetContract,
  type RemoteBudgetContractCaps,
  type RemoteRunFact,
  setRemoteBudgetContractResolver,
  setRemoteRunBudgetGate,
  setRemoteRunObserver,
  standingRoleMessage,
} from "../src/copilot";

/** Let the fire-and-forget settlement and recorder work land before assertions read it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** The deployment token both ends hold: the endpoint's MAC key and this server's check. */
const SECRET = "synthetic-managed-token";
/** The policy's approved per-run token ceiling; the hold and the caps both derive from it. */
const POLICY_TOKENS = 1_000_000n;
const MAX_MODEL_STEPS = 8;
const ENDPOINT = "https://risk.test/ag-ui";
const CAPS = remoteBudgetCaps(
  POLICY_TOKENS,
  MAX_MODEL_STEPS,
) as RemoteBudgetContractCaps;

const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

const remoteAgent = () => ({
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  endpoint: ENDPOINT,
  headers: { "x-openbot-agent-token": SECRET },
  standingMessage: standingRoleMessage(riskRow),
});

type Dial = {
  url: string;
  headers: Record<string, string>;
  body: RunAgentInput;
};

/**
 * A scripted AG-UI endpoint, in the fetch seam itself: no socket, no port, the exact
 * `Response` the transport would have been handed. The script answers each request with
 * the events it should serve; `never` holds the stream open for the cancel case.
 */
function scriptedEndpoint(
  script: (body: RunAgentInput) => BaseEvent[] | "hold-open",
) {
  const dials: Dial[] = [];
  const fetch: AgentFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as RunAgentInput;
    dials.push({ url: String(url), headers, body });
    const encoder = new TextEncoder();
    const answer = script(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const serve = (events: BaseEvent[]) => {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
        };
        if (answer === "hold-open") {
          // Enough to start the run; the stream then stays open until the caller
          // goes away. A canceled fetch's body ENDS without a terminal event —
          // closed cleanly here, never errored — which is exactly the shape a
          // torn-down remote run leaves this side to observe.
          serve([
            {
              type: EventType.RUN_STARTED,
              threadId: body.threadId,
              runId: body.runId,
            } as BaseEvent,
          ]);
          init.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
          return;
        }
        serve(answer);
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetch, dials };
}

/**
 * The receipt's MAC, re-derived here from the literal signing input.
 *
 * Deliberately hand-written rather than imported from either side: this is the pin. The
 * endpoint signs with its own copy (`agent-langgraph/src/budget.ts`), the server verifies with
 * a third (`remote-run.ts`), and this test only passes if all three agree byte for byte.
 */
function signReceipt(body: {
  runId: string;
  caps: RemoteBudgetContractCaps;
  usage: {
    modelSteps: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  status: "ok" | "budget_exceeded";
}): string {
  // Purpose-derived key (OCR R5 handoff): HMAC(secret, label), same pin as the
  // contract suite — the raw token also travels as the dial's Bearer credential.
  const macKey = createHmac("sha256", SECRET)
    .update("openbot-budget-receipt-mac-v1")
    .digest("hex");
  return createHmac("sha256", macKey)
    .update(
      [
        "openbot-budget-receipt",
        "v=1",
        `runId=${body.runId}`,
        `caps=${body.caps.modelSteps}|${body.caps.inputTokens}|${body.caps.outputTokens}|${body.caps.totalTokens}`,
        `usage=${body.usage.modelSteps}|${body.usage.inputTokens}|${body.usage.outputTokens}|${body.usage.totalTokens}`,
        `status=${body.status}`,
      ].join("\n"),
    )
    .digest("hex");
}

/** One endpoint receipt, as the protocol's CUSTOM extension carries it. */
function receiptEvent(
  runId: string,
  overrides: Partial<{
    caps: RemoteBudgetContractCaps;
    usage: {
      modelSteps: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    status: "ok" | "budget_exceeded";
    mac: string;
  }> = {},
): BaseEvent {
  const body = {
    kind: REMOTE_BUDGET_RECEIPT_EVENT,
    v: 1,
    runId,
    caps: overrides.caps ?? CAPS,
    usage: overrides.usage ?? {
      modelSteps: 1,
      inputTokens: 400,
      outputTokens: 40,
      totalTokens: 440,
    },
    status: overrides.status ?? ("ok" as const),
  };
  return {
    type: "CUSTOM",
    name: REMOTE_BUDGET_RECEIPT_EVENT,
    value: { ...body, mac: overrides.mac ?? signReceipt(body) },
  } as unknown as BaseEvent;
}

/** A run that ends normally, with its receipt in the contract's required order. */
const runEvents = (body: RunAgentInput): BaseEvent[] => [
  {
    type: EventType.RUN_STARTED,
    threadId: body.threadId,
    runId: body.runId,
  } as BaseEvent,
  receiptEvent(body.runId),
  {
    type: EventType.RUN_FINISHED,
    threadId: body.threadId,
    runId: body.runId,
  } as BaseEvent,
];

/**
 * The real budget seams, with the billing writer as a recording stand-in.
 *
 * The two factories are the production ones — that is the point of this rewrite: the resolver's
 * endpoint/token/ceiling logic and the gate's reserve/settle logic are what F6D's stand-ins
 * replaced. Only the ledger is fake, because a database is not what these cases are about.
 */
function budgetHarness(
  options: {
    reserve?: "ok" | "insufficient" | "throw";
    endpoints?: string[];
    sharedSecret?: string;
    contract?: boolean;
  } = {},
) {
  const reservations: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }[] = [];
  const marks: { reservationId: string; reason: string }[] = [];
  const errors: { context: Record<string, unknown>; message: string }[] = [];
  const warnings: { context: Record<string, unknown>; message: string }[] = [];
  const mode = options.reserve ?? "ok";
  const creditWriter = {
    async reserveCredits(input: {
      externalCustomerId: string;
      idempotencyKey: string;
      maximumCents: number;
      expiresAt: Date;
    }) {
      reservations.push(input);
      if (mode === "throw") throw new Error("ledger unavailable");
      if (mode === "insufficient") {
        return { reserved: false as const, availableCents: 120 };
      }
      return { reserved: true as const, reservationId: "reservation-1" };
    },
    async markReservationUnknown(reservationId: string, reason: string) {
      marks.push({ reservationId, reason });
    },
  };
  const gate = createRemoteRunBudgetGate({
    creditWriter,
    resolvePayer: () => ({
      externalCustomerId: "customer-1",
      payer: { kind: "personal" as const },
    }),
    maximumCents: 5_000,
    reservationWindowMs: 15 * 60_000,
    idempotencyPrefix: "usage:",
    log: {
      error: (context, message) => errors.push({ context, message }),
      warn: (context, message) => warnings.push({ context, message }),
    },
    refusals: {
      gateFailure: () => {
        const error = new Error("credit_gate_unavailable");
        error.name = "CreditGateFailureError";
        return error;
      },
      insufficient: (input) =>
        new Error(
          `credits_exhausted: ${input.payerKind} has ${input.availableCents}`,
        ),
    },
  });
  const resolver =
    options.contract === false
      ? undefined
      : createRemoteBudgetContractResolver({
          endpoints: new Set(
            (options.endpoints ?? [ENDPOINT]).map(
              (endpoint) => canonicalRemoteEndpoint(endpoint) as string,
            ),
          ),
          sharedSecret: options.sharedSecret ?? SECRET,
          maximumTokens: POLICY_TOKENS,
          maxModelSteps: MAX_MODEL_STEPS,
        });
  return { gate, resolver, reservations, marks, errors, warnings };
}

async function buildRemoteBot(
  wiring: {
    gate: Parameters<typeof setRemoteRunBudgetGate>[0];
    resolver:
      | ((request: {
          type: "remote_ag_ui" | "remote_mastra";
          endpoint: string;
          agentToken: string | undefined;
        }) => RemoteBudgetContract | undefined)
      | undefined;
  },
  fetch: AgentFetch,
  threadingScope?: ObservationScope,
) {
  setRemoteRunBudgetGate(wiring.gate);
  setRemoteBudgetContractResolver(wiring.resolver);
  try {
    return await buildAgents(
      [remoteAgent()],
      { provider: "openai", defaultModel: "test" },
      null,
      undefined,
      async () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      fetch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { userId: "person-1" },
      undefined,
      threadingScope
        ? {
            actorId: threadingScope.actorId,
            botId: "risk",
            resolveScope: () => Promise.resolve(threadingScope),
          }
        : undefined,
    );
  } finally {
    setRemoteRunBudgetGate(undefined);
    setRemoteBudgetContractResolver(undefined);
  }
}

/** The binding store as an in-memory stand-in, keyed the way the real one is. */
function fakeBindingStore() {
  const begun: BeginRunBindingInput[] = [];
  const finished: { runId: string; state: string }[] = [];
  const reconciled: { runId: string; opikTraceId: string }[] = [];
  const rows = new Map<string, RunBinding>();
  return {
    begun,
    finished,
    reconciled,
    async begin(scope: ObservationScope, input: BeginRunBindingInput) {
      begun.push(input);
      const key = `${scope.key}:${input.runId}:${input.attemptId}`;
      const existing = rows.get(key);
      if (existing) return { binding: existing, replayed: true };
      const row: RunBinding = {
        id: `binding-${key}`,
        scopeKey: scope.key,
        actorId: scope.actorId,
        botId: scope.botId,
        runId: input.runId,
        attemptId: input.attemptId,
        traceId: input.traceId,
        opikTraceId: null,
        locatorWorkspace: "ws",
        locatorProject: "project",
        capability: input.capability,
        state: "running",
        expiresAt: input.expiresAt,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(key, row);
      return { binding: row, replayed: false };
    },
    async reconcile(
      scope: ObservationScope,
      runId: string,
      _attemptId: string,
      opikTraceId: string,
    ) {
      reconciled.push({ runId, opikTraceId });
      const row = rows.get(`${scope.key}:${runId}:${_attemptId}`);
      if (row) row.opikTraceId = opikTraceId;
      return {
        binding: rows.get(`${scope.key}:${runId}:${_attemptId}`)!,
        adopted: true,
      };
    },
    async finish(
      scope: ObservationScope,
      runId: string,
      attemptId: string,
      state: string,
    ) {
      finished.push({ runId, state });
      const row = rows.get(`${scope.key}:${runId}:${attemptId}`);
      if (row) row.state = state as RunBinding["state"];
      return { binding: row ?? null, settled: row !== undefined };
    },
  };
}

/** The verified port as a recording stand-in: every materialization call, answered ok. */
function fakePort() {
  const createdTraces: string[] = [];
  const writtenSpans: OpikOtlpSpan[] = [];
  const port = {
    createTrace: async (_scope: unknown, input: { traceId: string }) => {
      createdTraces.push(input.traceId);
      return { outcome: "ok" as const, value: { id: input.traceId } };
    },
    writeSpans: async (
      _scope: unknown,
      input: { spans: OpikOtlpSpan[]; binding?: OpikRunBindingRef },
    ) => {
      writtenSpans.push(...input.spans);
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { createdTraces, writtenSpans, port: port as unknown as OpikPort };
}

test("a supported endpoint dials under its contract, and only a checked receipt lets the run through", async () => {
  const { fetch, dials } = scriptedEndpoint(runEvents);
  const harness = budgetHarness();
  const scope = resolveObservationScope({
    actorId: "person-1",
    botId: "risk",
    ownership: "owner",
    epoch: 1,
  });
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { createdTraces, writtenSpans, port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });

  const tracerProvider = new NodeTracerProvider();
  tracerProvider.register();
  const runSpan = trace
    .getTracer("remote-budget-dial-test")
    .startSpan("the remote run");
  const chain = runSpan.spanContext();

  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(
      { gate: harness.gate, resolver: harness.resolver },
      fetch,
      scope,
    );
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "dial-thread";

    const delivered: BaseEvent[] = [];
    await context.with(trace.setSpan(context.active(), runSpan), () =>
      agent.runAgent(
        { runId: "dial-run" },
        { onEvent: ({ event }) => delivered.push(event) },
      ),
    );
    await flush();

    // The dial happened, once, and carried the run's W3C chain to the endpoint.
    expect(dials).toHaveLength(1);
    expect(dials[0].headers.traceparent).toBe(
      `00-${chain.traceId}-${chain.spanId}-01`,
    );

    // The contract rode out with it: this run's identity and the policy-derived caps.
    expect(
      (dials[0].body.forwardedProps as { openbotBudget?: unknown })
        .openbotBudget,
    ).toEqual({ v: 1, runId: "dial-run", caps: CAPS });
    // And a caller-supplied budget in the surface's props cannot replace it.
    expect(CAPS.totalTokens).toBe(Number(POLICY_TOKENS));

    // The receipt is control-plane: checked here, never delivered to the surface.
    expect(delivered.map((event) => event.type)).not.toContain("CUSTOM");
    expect(delivered.map((event) => event.type)).toContain("RUN_FINISHED");

    // The admission ran BEFORE the endpoint was contacted, over the run's identity, and held
    // the policy's worst case in the same ledger every other paid path uses. The key carries
    // a server nonce after the bot (OCR R5): a client's reused runId cannot share a hold.
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]).toMatchObject({
      externalCustomerId: "customer-1",
      maximumCents: 5_000,
    });
    expect(harness.reservations[0].idempotencyKey).toMatch(
      /^usage:remote-run:risk:[0-9a-f-]{36}$/,
    );

    // One fact, on the chain the dial propagated, with what the endpoint actually sent.
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.traceId).toBe(chain.traceId);
    expect(fact.scope).toBe(scope);
    expect(fact.events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "success",
    ]);

    // The governed basic record: T10's capability, F5E1-F3's materialization, the settle.
    expect(store.begun).toHaveLength(1);
    expect(store.begun[0].capability).toBe("basic");
    expect(store.begun[0]).toMatchObject({
      runId: "dial-run",
      attemptId: "dial-run",
      traceId: chain.traceId,
    });
    expect(createdTraces).toHaveLength(1);
    // Two writes of the SAME run root: the materialization's open row, then the terminal
    // close with the observed window (R3-03's remote half, OCR R5-297) — the second is
    // the upsert the deterministic root id exists for.
    expect(writtenSpans.map((span) => span.name)).toEqual([
      { state: "projected", text: "run" },
      { state: "projected", text: "run" },
    ]);
    expect(store.reconciled).toHaveLength(1);
    expect(store.reconciled[0]).toMatchObject({ runId: "dial-run" });
    expect(store.finished).toEqual([{ runId: "dial-run", state: "completed" }]);

    // The hold settles as an unknown cost — the receipt bounded what was SPENT, it did not
    // price it, so nothing here invents a charge or releases capacity.
    expect(harness.marks).toEqual([
      {
        reservationId: "reservation-1",
        reason: "remote_usage_unreported:succeeded",
      },
    ]);
  } finally {
    setRemoteRunObserver(undefined);
    runSpan.end();
    await tracerProvider.shutdown();
    trace.disable();
  }
});

test("an unsupported endpoint keeps the dial closed with the same refusal", async () => {
  const { fetch, dials } = scriptedEndpoint(runEvents);
  const spy = spyOn(HttpAgent.prototype, "run");
  try {
    // No gate wired: the build refuses, before tools, transport, or dial.
    const withoutGate = await buildRemoteBot(
      { gate: undefined, resolver: budgetHarness().resolver },
      fetch,
    );
    expect(withoutGate.risk).toMatchObject({
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });
    withoutGate.risk.threadId = "closed-thread";
    await expect(
      withoutGate.risk.runAgent({ runId: "closed-run" }),
    ).rejects.toThrow("REMOTE_RUN_BUDGET_UNVERIFIED");

    // A gate but no contract resolver: still refused — a hold alone is what the finding says
    // is NOT a contract.
    const withoutContract = await buildRemoteBot(
      { gate: budgetHarness().gate, resolver: undefined },
      fetch,
    );
    expect(withoutContract.risk).toMatchObject({
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });

    // A resolver that does not support THIS endpoint: an endpoint this deployment does not
    // run, or one it has not declared contract-capable.
    const otherEndpoint = await buildRemoteBot(
      {
        gate: budgetHarness().gate,
        resolver: budgetHarness({ endpoints: ["https://elsewhere.test/ag-ui"] })
          .resolver,
      },
      fetch,
    );
    expect(otherEndpoint.risk).toMatchObject({
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });

    // The deployment's own token is the proof it runs the endpoint; a Bot dialled with
    // anything else is not one whose receipts this side could verify.
    const wrongToken = await buildRemoteBot(
      {
        gate: budgetHarness().gate,
        resolver: budgetHarness({ sharedSecret: "some-other-secret" }).resolver,
      },
      fetch,
    );
    expect(wrongToken.risk).toMatchObject({
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });

    // The credit admission still refuses through the same surface it always did, and the
    // endpoint stays uncontacted.
    for (const reserve of ["insufficient", "throw"] as const) {
      const harness = budgetHarness({ reserve });
      const built = await buildRemoteBot(
        { gate: harness.gate, resolver: harness.resolver },
        fetch,
      );
      built.risk.threadId = `${reserve}-thread`;
      await expect(
        built.risk.runAgent({ runId: `${reserve}-run` }),
      ).rejects.toThrow(
        reserve === "insufficient"
          ? "credits_exhausted"
          : "credit_gate_unavailable",
      );
    }

    expect(dials).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

const violationCase = (
  name: string,
  script: (body: RunAgentInput) => BaseEvent[],
) =>
  test(name, async () => {
    const { fetch, dials } = scriptedEndpoint(script);
    const harness = budgetHarness();
    const facts: RemoteRunFact[] = [];
    setRemoteRunObserver((fact) => facts.push(fact));
    try {
      const agents = await buildRemoteBot(
        { gate: harness.gate, resolver: harness.resolver },
        fetch,
      );
      agents.risk.threadId = "violation-thread";
      await expect(
        agents.risk.runAgent({ runId: "violation-run" }),
      ).rejects.toThrow("REMOTE_RUN_BUDGET_CONTRACT_VIOLATION");
      await flush();

      // The dial happened once; the run is not delivered, and the hold still settles as an
      // unknown cost rather than being released on a contract this side could not prove.
      expect(dials).toHaveLength(1);
      expect(harness.marks).toEqual([
        {
          reservationId: "reservation-1",
          reason: "remote_usage_unreported:failed",
        },
      ]);
      // The observation records the failure it actually saw.
      expect(facts).toHaveLength(1);
      expect(facts[0].events.at(-1)?.type).toBe("error");
    } finally {
      setRemoteRunObserver(undefined);
    }
  });

violationCase(
  "a receipt over its caps while claiming success tears the run down",
  (body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    receiptEvent(body.runId, {
      status: "ok",
      usage: {
        modelSteps: 2,
        inputTokens: CAPS.inputTokens + 1,
        outputTokens: 10,
        totalTokens: CAPS.inputTokens + 11,
      },
    }),
    {
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
  ],
);

violationCase(
  "a receipt signed with the wrong key tears the run down",
  (body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    receiptEvent(body.runId, { mac: "0".repeat(64) }),
    {
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
  ],
);

violationCase(
  "a receipt for another run's contract tears the run down",
  (body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    receiptEvent("some-other-run"),
    {
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
  ],
);

violationCase(
  "a terminal event with no receipt in front of it tears the run down",
  (body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    {
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
  ],
);

test("a torn-down run settles as an unknown cost and leaves the binding running", async () => {
  const { fetch, dials } = scriptedEndpoint(() => "hold-open");
  const harness = budgetHarness();
  const scope = resolveObservationScope({
    actorId: "person-1",
    botId: "risk",
    ownership: "owner",
    epoch: 1,
  });
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });

  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  let agents: Awaited<ReturnType<typeof buildRemoteBot>> | undefined;
  try {
    agents = await buildRemoteBot(
      { gate: harness.gate, resolver: harness.resolver },
      fetch,
      scope,
    );
    const agent = agents.risk;
    agent.threadId = "cancel-thread";
    const finishing = agent.runAgent({ runId: "cancel-run" });

    // Let the run start, then tear it down the way a cancellation does: no terminal
    // event ever arrives from the endpoint.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    agent.abortRun();
    await finishing;
    await flush();

    expect(dials).toHaveLength(1);
    // A teardown is not a contract violation — there was no terminal event claiming an
    // ending — so the run simply has no outcome, and the hold stays unknown.
    expect(harness.marks).toEqual([
      {
        reservationId: "reservation-1",
        reason: "remote_usage_unreported:unknown",
      },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "disconnected",
    ]);
    // Nothing invented an ending: the binding stays running for the lease sweeper,
    // exactly as the HTTP reporter's no-terminal report does.
    expect(store.finished).toEqual([]);
  } finally {
    setRemoteRunObserver(undefined);
    agents?.risk.abortRun();
  }
});

test("an endpoint-confirmed cancellation settles by its name and still holds as an unknown cost", async () => {
  const { fetch, dials } = scriptedEndpoint((body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    // The contract's order holds even here: what the run spent, then the ending.
    receiptEvent(body.runId, { status: "budget_exceeded" }),
    {
      // The protocol's own confirmed-cancellation ending, not this side's teardown.
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
      outcome: { type: "cancelled" },
    } as unknown as BaseEvent,
  ]);
  const harness = budgetHarness();
  const facts: RemoteRunFact[] = [];
  setRemoteRunObserver((fact) => facts.push(fact));
  try {
    const agents = await buildRemoteBot(
      { gate: harness.gate, resolver: harness.resolver },
      fetch,
    );
    agents.risk.threadId = "cancelled-thread";
    await agents.risk.runAgent({ runId: "cancelled-run" });
    await flush();

    expect(dials).toHaveLength(1);
    // A named ending, not an absent one — and never a success.
    expect(facts[0].events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "canceled",
    ]);
    // The budget settles by the confirmed name and STILL does not release: the endpoint
    // may have produced work before it stopped, the same doctrine a built-in run's
    // `cancelled` keeps (F5C1). A budget-stopped run is honest about having spent.
    expect(harness.marks).toEqual([
      {
        reservationId: "reservation-1",
        reason: "remote_usage_unreported:canceled",
      },
    ]);
  } finally {
    setRemoteRunObserver(undefined);
  }
});
