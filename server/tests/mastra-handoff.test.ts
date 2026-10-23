import { z } from "zod";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import { ThreadBusyError } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { HANDOFF_TOOL } from "../src/agents/handoff-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type {
  PlatformScope,
  RunDTO,
  RunFailureCode,
  RunnerRequestLease,
  RunService,
  TrustedRunAdmission,
} from "../src/enterprise/contracts";
import { createGovernedModelExecution } from "../src/enterprise/runs/governed-execution";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../src/enterprise/runs/model-route-catalog";
import { RunDomainError } from "../src/enterprise/runs/store";
import {
  createGovernedHandoffDelivery,
  governedHandoffSurfaceTools,
  HANDOFF_HOP_REFUSALS,
  HandoffTargetWaitingError,
  handoffSchedulingRecordFor,
} from "../src/mastra/handoff-delivery";
import {
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  GovernedHeadlessRefusal,
  governedFiringIntentKey,
} from "../src/mastra/headless";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { WorkQueue } from "../src/work/queue";

/*
 * ME11 (#483) unit suite: the handoff/reaper entry as a THIN assembly over the
 * SAME governed headless turn every other unattended entry runs (ME09/ME10).
 * The delivery half of a hop — running the Bot that was addressed and carrying
 * its answer back — moves off the Intelligence runner/socket onto the governed
 * turn, and every legacy guarantee rides along:
 *
 *   - the durable record is the queue's own hop row: a gone or already
 *     advanced hop refuses before anything is admitted (reaper redelivery
 *     never duplicates a run, a notice or a conversation);
 *   - the ONE advance intent is the hop key — stable across delivery
 *     redelivery, so the runs service converges a retry on the first advance;
 *   - a forward hop runs the addressed Bot on the hop's scratch conversation;
 *     a backwards hop (relay/notice) runs the asking Bot on the asking thread;
 *   - the addressed Bot's surface tools come from ITS OWN grants (never the
 *     parent's credentials, tools or personal memory), and the only
 *     Bot-to-Bot door is the desk-gated message_bot carrying the ORIGINAL
 *     signed depth — Mastra's own sub-agent rules substitute for nothing;
 *   - a waiting/failed/paused target is reported honestly: never a relay that
 *     says the target answered when it only accepted, waited or was refused.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  OPENAI_API_KEY: "sk-env-fallback",
};

const ROUTE: ModelRouteSnapshotInput = {
  agentId: "bot-b",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

async function trustedScopeFor(): Promise<PlatformScope> {
  const database = {
    execute: async () => [
      {
        current_user_matches: true,
        capability_attributes_ok: true,
        login_attributes_ok: true,
        login_has_expected_capability: true,
        capability_has_no_escalation_membership: true,
        login_has_no_other_memberships: true,
        no_protected_ownership: true,
        login_has_no_enterprise_privileges: true,
      },
    ],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: "tenant-x",
                principalId: "principal-x",
                tenantStatus: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
                status: "active",
              },
            ],
          };
          return query;
        },
      }),
  };
  const { verifyDirectoryDatabase } = await import(
    "../src/enterprise/tenancy/connections"
  );
  const { createScopeResolver } = await import(
    "../src/enterprise/tenancy/store"
  );
  const directory = await verifyDirectoryDatabase(database as never);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-x", entrypoint: "schedule" }),
    selectTenant: () => "tenant-x",
    selectWorkspace: () => "workspace-x",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

/** OpenAI SSE response built from raw chat-completion chunks. */
function sse(
  parts: {
    content?: string;
    toolCall?: { id: string; name: string; args: string };
    finish?: string | null;
    usage?: Record<string, unknown>;
  }[],
): Response {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && (part.content !== undefined || part.toolCall)) {
      delta.role = "assistant";
    }
    if (part.toolCall) {
      delta.tool_calls = [
        {
          index: 0,
          id: part.toolCall.id,
          type: "function",
          function: { name: part.toolCall.name, arguments: part.toolCall.args },
        },
      ];
    }
    if (part.content !== undefined) delta.content = part.content;
    return {
      id: "upstream-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "me01-model",
      choices: part.usage
        ? []
        : [{ index: 0, delta, finish_reason: part.finish ?? null }],
      ...(part.usage ? { usage: part.usage } : {}),
    };
  });
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const TEXT_TURN = () =>
  sse([
    { content: "the addressed Bot's answer" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

const WORDLESS_TURN = () =>
  sse([
    { finish: "stop" },
    { usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } },
  ]);

const forwardWork = (over: Partial<HandoffWork> = {}): HandoffWork => ({
  fromBotId: "bot-asker",
  toBotId: "bot-b",
  actorId: "actor-x",
  threadId: "asking-thread",
  runId: "origin-run",
  depth: 1,
  task: "the delegated task",
  toName: "Bot B",
  fromName: "Bot A",
  initiator: { kind: "handoff", id: "bot-asker", origin: { kind: "person" } },
  ...over,
});

const HOP_KEY = "hop:aaaa:bbbb";

interface RunsHarness {
  runs: RunService;
  starts: TrustedRunAdmission[];
  completes: number;
  failures: RunFailureCode[];
  suspensions: string[];
  releases: number;
}

function fakeRuns(
  options: {
    intentConflictKeys?: ReadonlySet<string>;
    startConflictKeys?: ReadonlySet<string>;
  } = {},
) {
  const harness: RunsHarness = {
    runs: undefined as never,
    starts: [],
    completes: 0,
    failures: [],
    suspensions: [],
    releases: 0,
  };
  let runSeq = 0;
  let capabilitySeq = 0;
  const minted = new Map<string, { runId: string }>();
  const routeRefBox: { current: string } = { current: "" };
  const service = {
    async start(_scope: PlatformScope, admission: TrustedRunAdmission) {
      harness.starts.push(admission);
      if (options.intentConflictKeys?.has(admission.input.clientMessageKey)) {
        throw new RunDomainError(
          "RUN_IDEMPOTENCY_CONFLICT",
          409,
          "This submitted message already has a run.",
        );
      }
      if (options.startConflictKeys?.has(admission.input.clientMessageKey)) {
        throw new RunDomainError(
          "ACTIVE_RUN_CONFLICT",
          409,
          "This conversation already has an active run.",
        );
      }
      runSeq += 1;
      const run: RunDTO = {
        run_id: `server-run-${runSeq}`,
        thread_id: admission.input.threadId,
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        finished_at: null,
      };
      return run;
    },
    async acquireRequestLease(
      _scope: PlatformScope,
      runId: string,
    ): Promise<RunnerRequestLease> {
      return {
        runId,
        attemptId: `attempt-${runId}`,
        generation: 1,
        ownerToken: `token-${runId}`,
        expiresAt: new Date(Date.now() + 30_000),
      };
    },
    async renewRequestLease(
      _scope: PlatformScope,
      lease: RunnerRequestLease,
    ): Promise<RunnerRequestLease> {
      return { ...lease, expiresAt: new Date(Date.now() + 30_000) };
    },
    async releaseRequestLease() {
      harness.releases += 1;
      return true;
    },
    async complete() {
      harness.completes += 1;
      return true;
    },
    async fail(_scope: PlatformScope, input: { errorCode: RunFailureCode }) {
      harness.failures.push(input.errorCode);
      return true;
    },
    async cancel() {
      return {} as RunDTO;
    },
    async markRunSuspended(_scope: PlatformScope, input: { status: string }) {
      harness.suspensions.push(input.status);
      return true;
    },
    async issueModelInvocationCapability(
      _scope: PlatformScope,
      input: {
        runId: string;
        attemptId: string;
        generation: number;
        modelRequestId: string;
        maximumTokens: number;
      },
    ) {
      capabilitySeq += 1;
      const capability = Buffer.alloc(32, capabilitySeq).toString("base64url");
      minted.set(capability, { runId: input.runId });
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(
      scope: PlatformScope,
      capability: string,
    ) {
      const entry = minted.get(capability);
      if (!entry) throw new Error("MODEL_CAPABILITY_INVALID");
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: entry.runId,
        attemptId: `attempt-${entry.runId}`,
        generation: 1,
        modelRouteRef: routeRefBox.current,
        maximumTokens: 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage() {},
    async markModelInvocationUnknown() {},
  };
  harness.runs = service as unknown as RunService;
  return { harness, publishRouteRef: (r: string) => (routeRefBox.current = r) };
}

interface HopHarnessOptions {
  fetch: () => Promise<Response> | Response;
  /** The record resolver's answer, or null for a gone/advanced hop. */
  record?: { work: HandoffWork; threadId: string } | null;
  intentConflictKeys?: ReadonlySet<string>;
  startConflictKeys?: ReadonlySet<string>;
  /** Surface tools, e.g. one that raises a suspension mid-turn. */
  surfaceTools?: GrantedTool[];
  /** An error the surface assembly throws, before anything is admitted. */
  surfaceError?: Error;
}

async function hopHarness(options: HopHarnessOptions) {
  const scope = await trustedScopeFor();
  const work = options.record?.work ?? forwardWork();
  const record =
    options.record === undefined
      ? { work, threadId: "hop-scratch-thread" }
      : options.record;
  const { harness: runsHarness, publishRouteRef } = fakeRuns({
    intentConflictKeys: options.intentConflictKeys,
    startConflictKeys: options.startConflictKeys,
  });
  const admitted = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    ROUTE,
    SECRET,
  );
  publishRouteRef(admitted.routeRef);
  const appends: { clientMessageKey: string; content: string }[] = [];
  let dial = 0;
  const runner = createGovernedTurnRunner({
    // The REAL record adapter: the harness stubs only the hop-row read, so
    // the instruction/thread/agent mapping under test is the production one.
    schedulingRecordFor: handoffSchedulingRecordFor(
      async () => record && { work: record.work, threadId: record.threadId },
    ),
    scopeFor: async () => scope,
    runs: runsHarness.runs,
    conversations: {
      append: async (_scope, input) => {
        appends.push({
          clientMessageKey: input.clientMessageKey,
          content: input.content,
        });
        return {} as never;
      },
    },
    expertVersionFor: async () => "expert-ref-1" as never,
    modelRouteFor: async () => ({
      routeRef: admitted.routeRef,
      maximumTokens: 1024,
    }),
    governedExecutionFor: ({ routeRef, ceiling }) =>
      createGovernedModelExecution({
        scope,
        agentId: "bot-b",
        routeRef,
        ceiling,
        runs: runsHarness.runs,
        catalog: {
          get: async (_scope, ref) =>
            ref === admitted.routeRef ? admitted : null,
        },
        currentRouteForAgent: async () => ROUTE,
        modelCapabilitySecret: SECRET,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        credentialReader: { readModelSecret: async () => null },
        environment: ENVIRONMENT,
        fetch: () => {
          dial += 1;
          return options.fetch() as never;
        },
      }),
    surfaceFor: async () => {
      if (options.surfaceError) throw options.surfaceError;
      return {
        instructions: ["You are the addressed Bot."],
        tools: options.surfaceTools ?? [],
        // The durable-suspension context the production surface composes
        // whenever the deployment wired ME05: without it an approval wait
        // has nowhere to park, which is exactly the waiting path under test.
        continuations: { onSuspension: async () => undefined },
      };
    },
    runtime: {
      loadExecutionInput: async (_scope, input) => input,
      persistExecutionMessages: async () => undefined,
    } as never,
  });
  const delivery = createGovernedHandoffDelivery({
    turn: runner,
    resolver: async () =>
      record && { work: record.work, threadId: record.threadId },
  });
  return {
    delivery,
    runner,
    runsHarness,
    appends,
    dialCount: () => dial,
    record,
  };
}

const deliverForward = (
  harness: Awaited<ReturnType<typeof hopHarness>>,
  work: HandoffWork = forwardWork(),
) =>
  harness.delivery.deliver({
    work,
    message: "the attributed message the runner composed",
    assertion: "the signed assertion",
    claim: { key: HOP_KEY, owner: "handoff-owner-1" },
  });

const CAPABILITY_REFUSAL = Object.assign(
  new Error("Use of Bots is switched off for this person."),
  { name: "CapabilityRefusedError" },
);

describe("ME11 handoff — the delivery half of a hop on the governed turn", () => {
  it("a_forward_hop_runs_the_addressed_bot_on_the_hop_identity_and_returns_the_answer", async () => {
    const harness = await hopHarness({ fetch: TEXT_TURN });
    const result = await deliverForward(harness);
    expect(result.answer).toBe("the addressed Bot's answer");
    // The ONE advance intent is the HOP identity (the queue row key), the
    // same stable business identity the desk offered under — a redelivery
    // derives the same key and converges on the first advance.
    const intentKey = governedFiringIntentKey(`handoff:${HOP_KEY}`, HOP_KEY);
    expect(harness.appends[0]!.clientMessageKey).toBe(intentKey);
    // The run was admitted for the ADDRESSED Bot, on the actor's behalf —
    // the record is the authority, never the queue payload's word alone.
    expect(harness.runsHarness.starts[0]!.agentId).toBe("bot-b");
    expect(harness.runsHarness.starts[0]!.input.threadId).toBe(
      "hop-scratch-thread",
    );
    expect(harness.runsHarness.completes).toBe(1);
    // The model was shown the attributed envelope, not the runner's own copy
    // of it: the record's instruction is what the conversation keeps.
    expect(harness.appends[0]!.content).toContain("the delegated task");
    expect(harness.appends[0]!.content).toContain("bot-asker has asked you");
  });

  it("a_backwards_hop_relays_on_the_asking_thread_without_a_scratch_conversation", async () => {
    const work = forwardWork({
      toBotId: "bot-asker",
      answerIn: "asking-thread",
      task: "You asked bot-b to help with this and it never answered: the platform answered 503.",
    });
    const harness = await hopHarness({
      fetch: TEXT_TURN,
      record: { work, threadId: "asking-thread" },
    });
    await harness.delivery.deliver({
      work,
      message: "the notice text",
      assertion: "the signed assertion",
      claim: { key: `notice:${HOP_KEY}`, owner: "handoff-owner-1" },
    });
    // The relay/notice turn runs IN the asking conversation: the answer lands
    // where the person is actually watching.
    expect(harness.appends[0]!.content).toContain("never answered");
    expect(harness.runsHarness.starts[0]!.input.threadId).toBe("asking-thread");
    expect(harness.runsHarness.starts[0]!.agentId).toBe("bot-asker");
  });

  it("a_redelivery_converges_on_the_first_advance_and_dials_nothing", async () => {
    const intentKey = governedFiringIntentKey(`handoff:${HOP_KEY}`, HOP_KEY);
    const first = await hopHarness({ fetch: TEXT_TURN });
    await deliverForward(first);
    expect(first.runsHarness.completes).toBe(1);
    const redelivery = await hopHarness({
      fetch: TEXT_TURN,
      intentConflictKeys: new Set([intentKey]),
    });
    let refused: GovernedHeadlessRefusal | undefined;
    try {
      await deliverForward(redelivery);
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refused = error;
    }
    expect(refused?.code).toBe(
      GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced,
    );
    expect(redelivery.dialCount()).toBe(0);
    expect(redelivery.runsHarness.completes).toBe(0);
  });

  it("a_gone_or_reaped_hop_delivers_nothing_and_names_why", async () => {
    const harness = await hopHarness({ fetch: TEXT_TURN, record: null });
    let error: Error | undefined;
    try {
      await deliverForward(harness);
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.name).toBe("GovernedHeadlessRefusal");
    expect((error as GovernedHeadlessRefusal | undefined)?.code).toBe(
      HANDOFF_HOP_REFUSALS.hopNotAdvanceable,
    );
    expect(harness.dialCount()).toBe(0);
    expect(harness.appends).toHaveLength(0);
    expect(harness.runsHarness.starts).toHaveLength(0);
  });

  it("a_wordless_turn_returns_no_answer_to_relay", async () => {
    const harness = await hopHarness({ fetch: WORDLESS_TURN });
    const result = await deliverForward(harness);
    // A turn of nothing but tool calls happened; there is nothing to carry
    // back, and the runner relays nothing rather than an invented answer.
    expect(result.answer).toBeNull();
    expect(harness.runsHarness.completes).toBe(1);
  });

  it("a_waiting_target_is_reported_as_waiting_never_as_answered", async () => {
    const waitingTool: GrantedTool = {
      name: "gated_thing",
      description: "Waits for an approval.",
      parameters: z.object({}),
      ref: "server/gated_thing",
      execute: async () => {
        throw new HeadlessToolSuspension(
          "This action is waiting for your approval.",
          { kind: "approval", approvalId: "approval-me11-1" },
        );
      },
    };
    // Dial 1 calls the gated tool; dial 2 would answer after the tool —
    // but the first one parks the turn, so only dial 1 ever happens.
    const askThenAnswer = () => {
      let call = 0;
      return () => {
        call += 1;
        return call === 1
          ? sse([
              {
                toolCall: {
                  id: "call_me11_1",
                  name: "gated_thing",
                  args: "{}",
                },
              },
              { finish: "tool_calls" },
              {
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 0,
                  total_tokens: 5,
                },
              },
            ])
          : sse([
              { content: "the addressed Bot's answer" },
              { finish: "stop" },
              {
                usage: {
                  prompt_tokens: 2,
                  completion_tokens: 1,
                  total_tokens: 3,
                },
              },
            ]);
      };
    };
    const harness = await hopHarness({
      fetch: askThenAnswer(),
      surfaceTools: [waitingTool],
    });
    let error: Error | undefined;
    try {
      await deliverForward(harness);
    } catch (cause) {
      error = cause as Error;
    }
    expect(error).toBeInstanceOf(HandoffTargetWaitingError);
    expect(error?.message).toContain("waiting");
    // The run parked durably — the wait is on record, not a silent success.
    expect(harness.runsHarness.suspensions).toEqual(["waiting_approval"]);
    expect(harness.runsHarness.completes).toBe(0);
    // And the second dial never happened: the park stopped the turn there.
    expect(harness.dialCount()).toBe(1);
  });

  it("a_busy_conversation_waits_rather_than_fails_the_hop", async () => {
    const intentKey = governedFiringIntentKey(`handoff:${HOP_KEY}`, HOP_KEY);
    const harness = await hopHarness({
      fetch: TEXT_TURN,
      startConflictKeys: new Set([intentKey]),
    });
    let error: Error | undefined;
    try {
      await deliverForward(harness);
    } catch (cause) {
      error = cause as Error;
    }
    // The same wait-not-fail semantics the platform lock gave a legacy hop:
    // the conversation is mid-run, so the hop is released for a quick retry.
    expect(error).toBeInstanceOf(ThreadBusyError);
    expect(harness.dialCount()).toBe(0);
  });

  it("a_refused_target_stays_a_final_refusal", async () => {
    // The deployment controls' refusal (Use Bots / model allowlist) surfaces
    // from the surface assembly exactly as the legacy delivery raised it —
    // same error name, so the runner's final-refusal branch recognises it.
    const harness = await hopHarness({
      fetch: TEXT_TURN,
      surfaceError: CAPABILITY_REFUSAL,
    });
    let error: Error | undefined;
    try {
      await deliverForward(harness);
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.name).toBe("CapabilityRefusedError");
    // The refusal settles the admitted run truthfully — never a hang, never
    // a silent success — and nothing dialed the model.
    expect(harness.runsHarness.starts).toHaveLength(1);
    expect(harness.runsHarness.failures).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(harness.dialCount()).toBe(0);
  });
});

describe("ME11 handoff — the record adapter and the surface tools", () => {
  it("the_record_adapter_maps_the_hop_row_onto_the_addressed_bot_s_turn", async () => {
    const work = forwardWork();
    const recordFor = handoffSchedulingRecordFor(async () => ({
      work,
      threadId: "hop-scratch-thread",
    }));
    const record = await recordFor(`handoff:${HOP_KEY}`);
    expect(record).toMatchObject({
      agentId: "bot-b",
      threadId: "hop-scratch-thread",
      enabled: true,
      frame: "none",
    });
    expect(record?.instruction).toContain("the delegated task");
    // A backwards hop keeps the asking thread and speaks the carried text.
    const backwardsFor = handoffSchedulingRecordFor(async () => ({
      work: forwardWork({
        toBotId: "bot-asker",
        answerIn: "asking-thread",
        task: "the notice text",
      }),
      threadId: "asking-thread",
    }));
    const backwards = await backwardsFor(`handoff:notice:${HOP_KEY}`);
    expect(backwards).toMatchObject({
      agentId: "bot-asker",
      threadId: "asking-thread",
    });
    expect(backwards?.instruction).toBe("the notice text");
  });

  it("the_record_adapter_refuses_a_gone_hop", async () => {
    const recordFor = handoffSchedulingRecordFor(async () => null);
    expect(await recordFor(`handoff:${HOP_KEY}`)).toBeNull();
  });

  it("the_delivery_surface_mounts_only_the_desk_gated_handoff_tool_at_the_carried_depth", async () => {
    const work = forwardWork({ depth: 2 });
    const seen: {
      run: { depth?: number; handoff?: { key: string; owner: string } };
    }[] = [];
    const messageBot: GrantedTool = {
      name: HANDOFF_TOOL,
      ref: `bot/${HANDOFF_TOOL}`,
      description: "Hand work to another Bot.",
      parameters: z.object({}),
      execute: async () => "handed over",
    };
    const askPerson: GrantedTool = {
      name: "ask_person",
      ref: "bot/ask_person",
      description: "Ask the person.",
      parameters: z.object({}),
      execute: async () => "asked",
    };
    const tools = governedHandoffSurfaceTools({
      workFor: async () => ({ work, claimedBy: "handoff-owner-1" }),
      toolsForDeliveryRun: async ({ run }) => {
        seen.push({ run });
        return [messageBot, askPerson];
      },
    });
    const scope = await trustedScopeFor();
    const mounted = await tools({
      scope,
      agentId: "bot-b",
      initiator: { kind: "handoff", id: "bot-asker" },
      threadId: "hop-scratch-thread",
      binding: {
        runId: "run-1",
        attemptId: "attempt-1",
        generation: 1,
        executionKey: "key-1",
        botId: "bot-b",
        threadId: "hop-scratch-thread",
      },
      routineId: `handoff:${HOP_KEY}`,
    });
    // ask_person is not mounted: the governed headless surface produces no
    // new person-question waits (the ME10 contract), and the ONE Bot-to-Bot
    // door is the desk's own tool.
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.name).toBe(HANDOFF_TOOL);
    // The run identity the desk will see carries the ORIGINAL signed depth
    // and the hop claim — the legacy cap arithmetic binds unchanged.
    expect(seen[0]!.run.depth).toBe(2);
    expect(seen[0]!.run.handoff).toEqual({
      key: HOP_KEY,
      owner: "handoff-owner-1",
    });
  });

  it("the_delivery_surface_mounts_nothing_for_a_gone_hop_or_a_foreign_entry", async () => {
    const tools = governedHandoffSurfaceTools({
      workFor: async () => null,
      toolsForDeliveryRun: async () => {
        throw new Error("must not be asked for a gone hop");
      },
    });
    const scope = await trustedScopeFor();
    expect(
      await tools({
        scope,
        agentId: "bot-b",
        initiator: { kind: "handoff", id: "bot-asker" },
        threadId: "hop-scratch-thread",
        binding: {
          runId: "run-1",
          attemptId: "attempt-1",
          generation: 1,
          executionKey: "key-1",
          botId: "bot-b",
          threadId: "hop-scratch-thread",
        },
        routineId: `handoff:${HOP_KEY}`,
      }),
    ).toEqual([]);
    // Another entry's routineId namespace never mounts handoff tools.
    const otherEntry = governedHandoffSurfaceTools({
      workFor: async () => {
        throw new Error("must not be asked for another entry");
      },
      toolsForDeliveryRun: async () => [],
    });
    expect(
      await otherEntry({
        scope,
        agentId: "bot-a",
        initiator: { kind: "routine", id: "r1" },
        threadId: "thread-1",
        binding: {
          runId: "run-1",
          attemptId: "attempt-1",
          generation: 1,
          executionKey: "key-1",
          botId: "bot-a",
          threadId: "thread-1",
        },
        routineId: "delivery:inbox-1",
      }),
    ).toEqual([]);
  });
});

/*
 * The runner side: the queue lease's claim travels with the delivery call
 * (the governed turn's stable identity comes from it), and a waiting target
 * is a FINAL outcome — the hop finishes and the asker is told, rather than
 * the queue retrying an advance that already happened.
 */
function fakeQueue() {
  const offered: {
    kind: string;
    key: string;
    payload: Record<string, unknown>;
  }[] = [];
  const finished: string[] = [];
  const released: { key: string; delayMs: number }[] = [];
  const claimedItems = {
    kind: "bot.message",
    key: HOP_KEY,
    owner: "handoff-owner-1",
    leaseUntil: new Date(Date.now() + 60_000),
    attempts: 1,
    payload: forwardWork(),
  };
  const queue: WorkQueue = {
    offer: async (item) => {
      offered.push({
        kind: item.kind,
        key: item.key,
        payload: item.payload ?? {},
      });
      return "queued";
    },
    claim: async () => [claimedItems],
    renew: async () => true,
    finish: async ({ key }) => {
      finished.push(key);
      return true;
    },
    release: async ({ key, delayMs }) => {
      released.push({ key, delayMs });
      return true;
    },
    purge: async () => 0,
  };
  return { queue, offered, finished, released };
}

const fakeAuditStore = () =>
  ({
    insert: async () => undefined,
  }) as never;

describe("ME11 handoff — the runner carries the claim and reports waits", () => {
  it("the_runner_hands_the_hop_claim_to_the_delivery", async () => {
    const { queue } = fakeQueue();
    const claims: { key?: string; owner?: string }[] = [];
    const runner = createHandoffRunner({
      queue,
      owner: "handoff-owner-1",
      sign: () => "assertion",
      auditStore: fakeAuditStore(),
      renewEveryMs: 60_000,
      delivery: {
        deliver: async ({ claim }) => {
          claims.push(claim);
          return { answer: "the answer" };
        },
      },
    });
    const report = await runner.sweep();
    expect(report.delivered).toEqual(["bot-b"]);
    expect(claims[0]).toEqual({ key: HOP_KEY, owner: "handoff-owner-1" });
  });

  it("a_waiting_hop_finishes_and_tells_the_asker_instead_of_retrying", async () => {
    const { queue, offered, finished, released } = fakeQueue();
    const runner = createHandoffRunner({
      queue,
      owner: "handoff-owner-1",
      sign: () => "assertion",
      auditStore: fakeAuditStore(),
      renewEveryMs: 60_000,
      delivery: {
        deliver: async () => {
          throw new HandoffTargetWaitingError(
            "The Bot it asked is waiting for a decision (approval: gated_thing) and has not answered.",
          );
        },
      },
    });
    const report = await runner.sweep();
    // The hop is over — finished, never released for another advance.
    expect(finished).toEqual([HOP_KEY]);
    expect(released).toEqual([]);
    expect(report.skipped.map((entry) => entry.reason)).toContainEqual(
      expect.stringContaining("waiting"),
    );
    // And the person hears about it through the asker's own voice.
    expect(offered.some((item) => item.key.startsWith("notice:"))).toBe(true);
  });
});
