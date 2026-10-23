import { z } from "zod";
import { FIRING_FRAME } from "../../shared/routine-firing";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import { currentApprovalContext } from "../src/approvals/types";
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
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  GovernedHeadlessRefusal,
  governedFiringIntentKey,
} from "../src/mastra/headless";
import { createMastraTools, MastraToolRefusal } from "../src/mastra/tools";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";

/*
 * ME10 (#482) unit suite: the four unattended entries (responsibility
 * advance, delivery, wake-up, approval continuation) as THIN assemblies over
 * the SAME governed headless turn ME09 built for the routine firing. The
 * entry-specific contracts pinned here, against the REAL governed carrier
 * around a synthetic runs service and a stubbed upstream dial:
 *
 *   - each entry's record authority keys the ONE advance intent on the
 *     entry's OWN durable identity (the inbox id, the follow-up item key,
 *     the responsibility run id) — stable across redelivery;
 *   - an entry whose instruction is already the person-visible message runs
 *     it UNFRAMED (the firing frame is routine presentation, never a
 *     general contract), and the routine frame itself is regression-fenced;
 *   - every entry re-reads its record and re-verifies eligibility through
 *     the directory at the moment of running: a gone record, a mismatched
 *     caller or a revoked member refuses before anything is admitted;
 *   - cancel, timeout and duplicate delivery each reach a truthful outcome
 *     on the shared turn;
 *   - the F4 durable approval pause: an approval wait parks the engine with
 *     the run's binding, and a declined decision returns the person's answer
 *     as the tool result without executing the call.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  OPENAI_API_KEY: "sk-env-fallback",
};

const ROUTE: ModelRouteSnapshotInput = {
  agentId: "bot-a",
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
    finish?: string | null;
    usage?: Record<string, unknown>;
  }[],
): Response {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && part.content !== undefined) delta.role = "assistant";
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
    { content: "the entry answer" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

interface RunsHarness {
  runs: RunService;
  starts: TrustedRunAdmission[];
  completes: number;
  failures: RunFailureCode[];
  suspensions: string[];
  releases: number;
}

function fakeRuns(options: { intentConflictKeys?: ReadonlySet<string> } = {}) {
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

interface EntryHarnessOptions {
  fetch: () => Promise<Response> | Response;
  record?: {
    agentId?: string;
    threadId?: string;
    instruction?: string;
    enabled?: boolean;
    frame?: "firing" | "none";
  } | null;
  scopeError?: Error;
  ceiling?: number;
  turnTimeoutMs?: number;
  intentConflictKeys?: ReadonlySet<string>;
}

async function entryHarness(options: EntryHarnessOptions) {
  const scope = await trustedScopeFor();
  const record =
    options.record === null
      ? null
      : {
          agentId: "bot-a",
          threadId: "thread-1",
          instruction: "the inbound text",
          enabled: true,
          ...(options.record ?? {}),
        };
  const { harness: runsHarness, publishRouteRef } = fakeRuns({
    intentConflictKeys: options.intentConflictKeys,
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
    schedulingRecordFor: async () => record,
    scopeFor: async () => {
      if (options.scopeError) throw options.scopeError;
      return scope;
    },
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
    modelRouteFor: async () =>
      options.ceiling === 0
        ? null
        : { routeRef: admitted.routeRef, maximumTokens: 1024 },
    governedExecutionFor: ({ routeRef, ceiling }) =>
      createGovernedModelExecution({
        scope,
        agentId: "bot-a",
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
    surfaceFor: async () => ({
      instructions: ["You are Bot A."],
      tools: [],
    }),
    runtime: {
      loadExecutionInput: async (_scope, input) => input,
      persistExecutionMessages: async () => undefined,
    } as never,
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });
  return {
    runner,
    runsHarness,
    appends,
    dialCount: () => dial,
    record,
  };
}

const turnInput = (routineId: string, runId?: string) => ({
  ownerUserId: "actor-x",
  routineId,
  agentId: "bot-a",
  threadId: "thread-1",
  instruction: "whatever the caller claims",
  ...(runId ? { runId } : {}),
});

describe("ME10 entries — one governed turn, four durable records", () => {
  it("a_delivery_record_runs_unframed_and_keys_the_intent_on_the_inbox_identity", async () => {
    const delivery = await entryHarness({
      fetch: TEXT_TURN,
      record: { instruction: "the person's own message", frame: "none" },
    });
    const reply = await delivery.runner(
      turnInput("delivery:inbox-1", "inbox-1"),
    );
    expect(reply.replyText).toBe("the entry answer");
    // The message is the person's text, NOT wrapped in the routine frame.
    expect(delivery.appends[0]!.content).toBe("the person's own message");
    expect(delivery.appends[0]!.content.startsWith(FIRING_FRAME[0])).toBe(
      false,
    );
    // The ONE advance intent is the inbox identity: stable per delivery.
    expect(delivery.appends[0]!.clientMessageKey).toBe(
      governedFiringIntentKey("delivery:inbox-1", "inbox-1"),
    );
    expect(delivery.runsHarness.completes).toBe(1);
  });

  it("a_wake_up_redelivery_converges_on_the_first_advance_and_skips", async () => {
    const key = governedFiringIntentKey("follow-up:item-1", "item-1");
    const first = await entryHarness({ fetch: TEXT_TURN });
    const firstReply = await first.runner(
      turnInput("follow-up:item-1", "item-1"),
    );
    expect(firstReply.replyText).toBe("the entry answer");
    expect(first.runsHarness.completes).toBe(1);
    // The redelivery carries the SAME identity: the admission refuses, and
    // the refusal is the named convergence, not a second run.
    const redelivery = await entryHarness({
      fetch: TEXT_TURN,
      intentConflictKeys: new Set([key]),
    });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await redelivery.runner(turnInput("follow-up:item-1", "item-1"));
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(
      GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced,
    );
    expect(redelivery.dialCount()).toBe(0);
    expect(redelivery.runsHarness.completes).toBe(0);
    expect(redelivery.runsHarness.failures).toEqual([]);
  });

  it("a_routine_record_keeps_its_firing_frame", async () => {
    const routine = await entryHarness({
      fetch: TEXT_TURN,
      record: { instruction: "Summarize yesterday." },
    });
    await routine.runner(turnInput("routine_1", "firing-1"));
    expect(routine.appends[0]!.content).toBe(
      [...FIRING_FRAME, "", "Summarize yesterday."].join("\n"),
    );
  });

  it("each_entry_refuses_a_gone_record_before_anything_runs", async () => {
    const gone = await entryHarness({ fetch: TEXT_TURN, record: null });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await gone.runner(turnInput("delivery:inbox-gone", "inbox-gone"));
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(gone.appends).toHaveLength(0);
    expect(gone.dialCount()).toBe(0);
    expect(gone.runsHarness.starts).toHaveLength(0);
  });

  it("each_entry_reverifies_eligibility_through_the_directory_before_running", async () => {
    // AC2: the scope is re-signed NOW; a revoked or moved member throws from
    // the directory's own answer and the entry never runs under a stale or
    // scanned identity.
    const revoked = await entryHarness({
      fetch: TEXT_TURN,
      scopeError: new Error("WORKSPACE_FORBIDDEN"),
    });
    let blocked = false;
    try {
      await revoked.runner(turnInput("delivery:inbox-1", "inbox-1"));
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    expect(revoked.appends).toHaveLength(0);
    expect(revoked.dialCount()).toBe(0);
    expect(revoked.runsHarness.starts).toHaveLength(0);
  });

  it("each_entry_refuses_without_the_explicit_budget", async () => {
    const unconfigured = await entryHarness({
      fetch: TEXT_TURN,
      ceiling: 0,
    });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await unconfigured.runner(turnInput("delivery:inbox-1", "inbox-1"));
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.budgetUnconfigured);
    expect(unconfigured.appends).toHaveLength(0);
    expect(unconfigured.dialCount()).toBe(0);
  });

  it("a_cancelled_turn_never_claims_the_intent", async () => {
    const cancelled = await entryHarness({ fetch: TEXT_TURN });
    const controller = new AbortController();
    controller.abort();
    let stopped = false;
    try {
      await cancelled.runner({
        ...turnInput("delivery:inbox-1", "inbox-1"),
        signal: controller.signal,
      });
    } catch {
      stopped = true;
    }
    expect(stopped).toBe(true);
    expect(cancelled.appends).toHaveLength(0);
    expect(cancelled.dialCount()).toBe(0);
    expect(cancelled.runsHarness.starts).toHaveLength(0);
  });

  it("a_timed_out_turn_fails_the_run_truthfully_and_releases_the_lease", async () => {
    const slow = await entryHarness({
      fetch: () =>
        new Promise<Response>(() => {
          // Never answers: the turn deadline is the only way out.
        }),
      turnTimeoutMs: 50,
    });
    let timedOut = false;
    try {
      await slow.runner(turnInput("delivery:inbox-1", "inbox-1"));
    } catch (error) {
      timedOut = (error as Error).message.includes("did not finish within");
    }
    expect(timedOut).toBe(true);
    // The run settles FAILED (never a silent success) and the lease goes
    // back, so nothing is left running.
    expect(slow.runsHarness.failures).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(slow.runsHarness.completes).toBe(0);
    expect(slow.runsHarness.releases).toBeGreaterThanOrEqual(1);
  });
});

describe("ME10 entries — the F4 durable approval pause", () => {
  const APPROVAL_SUSPENSION = () =>
    new HeadlessToolSuspension("This action is waiting for your approval.", {
      kind: "approval",
      approvalId: "approval-1",
      requestId: "approval-1",
    });

  // The granted ask that the approvals gate parked: the raise happens
  // INSIDE the granted execute (the gate's own wait), which is exactly the
  // shape the governed wrapper must catch.
  const grantedAskTool = (executions: unknown[]): GrantedTool => ({
    name: "ask_tool",
    description: "Does the thing that needs approval.",
    parameters: z.object({ value: z.string() }),
    ref: "server/ask_tool",
    execute: async (args) => {
      executions.push(args);
      throw APPROVAL_SUSPENSION();
    },
  });

  const engineContext = (overrides: {
    suspend?: unknown;
    resumeData?: unknown;
  }) => ({
    agent: {
      toolCallId: "call_9",
      ...(overrides.suspend !== undefined
        ? { suspend: overrides.suspend }
        : {}),
      ...(overrides.resumeData !== undefined
        ? { resumeData: overrides.resumeData }
        : {}),
    },
  });

  it("an_approval_wait_parks_the_engine_with_the_run_binding_and_the_ask_context", async () => {
    const executions: unknown[] = [];
    const tools = createMastraTools([grantedAskTool(executions)], {
      approvalBinding: {
        runId: "server-run-1",
        threadId: "thread-1",
      },
    });
    const suspensions: unknown[] = [];
    const result = await (
      tools.ask_tool as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      }
    ).execute(
      { value: "hi" },
      engineContext({
        suspend: async (payload: unknown) => {
          suspensions.push(payload);
        },
      }),
    );
    // The engine is parked: the call names itself, the ask carries the
    // approval id, and no fabricated result is read.
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]).toMatchObject({
      kind: "approval",
      toolCallId: "call_9",
      toolName: "ask_tool",
      approvalId: "approval-1",
    });
    expect(result).toMatchObject({ waiting: true, kind: "approval" });
    expect(executions).toHaveLength(1);
  });

  it("the_parked_ask_opens_under_the_runs_approval_context", async () => {
    let seen: ReturnType<typeof currentApprovalContext>;
    const probe: GrantedTool = {
      name: "probe_tool",
      description: "Reads the ambient approval context.",
      parameters: z.object({}),
      ref: "server/probe_tool",
      execute: async () => {
        seen = currentApprovalContext();
        throw APPROVAL_SUSPENSION();
      },
    };
    const tools = createMastraTools([probe], {
      approvalBinding: {
        runId: "server-run-7",
        threadId: "thread-9",
      },
    });
    await (
      tools.probe_tool as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      }
    ).execute({}, engineContext({ suspend: async () => undefined }));
    expect(seen).toBeDefined();
    expect(seen).toMatchObject({
      runId: "server-run-7",
      threadId: "thread-9",
      toolCallId: "call_9",
      toolName: "probe_tool",
      state: { engine: "mastra" },
    });
  });

  it("a_declined_decision_returns_the_persons_answer_without_executing", async () => {
    const executions: unknown[] = [];
    const tools = createMastraTools([grantedAskTool(executions)], {
      approvalBinding: { runId: "server-run-1", threadId: "thread-1" },
    });
    const result = await (
      tools.ask_tool as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      }
    ).execute(
      { value: "hi" },
      engineContext({
        resumeData: { approved: false, reason: "The person declined this." },
      }),
    );
    expect(String(result)).toContain("Refused");
    expect(String(result)).toContain("The person declined this.");
    expect(executions).toHaveLength(0);
  });

  it("a_non_approval_wait_fails_closed_even_with_a_park_surface", async () => {
    // The pinned engine always injects `context.agent.suspend`, so the
    // fail-closed surface that matters is the WAIT KIND: only an approval
    // wait parks. A question wait (whose drive shape is a different
    // ticket's contract) must never be laundered into a park, a vendor
    // error or a fabricated result.
    const tools = createMastraTools(
      [
        {
          name: "ask_tool",
          description: "Asks the person something.",
          parameters: z.object({ value: z.string() }),
          ref: "server/ask_tool",
          execute: async () => {
            throw new HeadlessToolSuspension("waiting for the answer", {
              kind: "question",
              requestId: "q-1",
            });
          },
        },
      ],
      { approvalBinding: { runId: "server-run-1", threadId: "thread-1" } },
    );
    let refusal: Error | undefined;
    try {
      await (
        tools.ask_tool as {
          execute: (input: unknown, context: unknown) => Promise<unknown>;
        }
      ).execute(
        { value: "hi" },
        engineContext({ suspend: async () => undefined }),
      );
    } catch (error) {
      refusal = error as Error;
    }
    expect(refusal instanceof MastraToolRefusal).toBe(true);
    expect(refusal?.message).toContain("MASTRA_TOOL_SUSPENSION_UNSUPPORTED");
  });
});
