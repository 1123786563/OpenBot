import type { Message } from "@ag-ui/client";
import { z } from "zod";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import type {
  PlatformScope,
  RunDTO,
  RunFailureCode,
  RunnerRequestLease,
  RunService,
  TrustedRunAdmission,
} from "../src/enterprise/contracts";
import {
  classifyGovernedRunFailure,
  createGovernedModelExecution,
} from "../src/enterprise/runs/governed-execution";
import { ModelInvocationError } from "../src/enterprise/runs/model-capability";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../src/enterprise/runs/model-route-catalog";
import { RunDomainError } from "../src/enterprise/runs/store";
import { MastraContinuationRefusal } from "../src/mastra/continuation-store";
import {
  assertResumeBindingCurrent,
  createGenerationCurrentGate,
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  GovernedHeadlessRefusal,
  governedFiringIntentKey,
  MASTRA_RESUME_SETTLE_REFUSALS,
  settleResumedRun,
} from "../src/mastra/headless";
import type { GrantedTool } from "../src/plugins/tools";
import { UNTRUSTED_GUIDANCE } from "../src/untrusted-content";

/*
 * ME09 (#481) unit suite: the governed headless turn — the routine firing
 * that runs the SAME controlled Mastra execution the web chat runs, with the
 * runs service' request lease as the only lock and no Intelligence socket on
 * the path. The governed carrier here is the REAL one
 * (createGovernedModelExecution) around a synthetic runs service and a
 * stubbed upstream dial — the exact governed fixture the production runner
 * tests and the ME02 loop tests use — so admission, capability minting and
 * settlement behave as production.
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

/**
 * Trusted synthetic directory scope — the only shape the governed carrier's
 * route rebind accepts (UNVERIFIED_SCOPE otherwise). The production runner
 * tests mint theirs the same way; the entrypoint is the schedule entrypoint
 * the governed headless turn runs under.
 */
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
                // The workspace-membership select projects only `status`.
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
    toolCall?: { id: string; name: string; args: string };
  }[],
): Response {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && part.content !== undefined) delta.role = "assistant";
    if (part.toolCall) {
      delta.tool_calls = [
        {
          index: 0,
          ...(part.toolCall.id
            ? { id: part.toolCall.id, type: "function" }
            : {}),
          function: {
            ...(part.toolCall.name ? { name: part.toolCall.name } : {}),
            ...(part.toolCall.args ? { arguments: part.toolCall.args } : {}),
          },
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
    { content: "the nightly answer" },
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
  cancels: number;
  confirmed: { capability: string; usedTokens: number }[];
  issued: { runId: string; maximumTokens: number }[];
  /** Renewals fail from the nth call on (the lease-lost injection). */
  failRenewalsFrom: { value: number };
}

function fakeRuns(
  options: {
    intentConflictKeys?: ReadonlySet<string>;
    issueError?: Error;
  } = {},
): RunsHarness {
  const harness: RunsHarness = {
    runs: undefined as never,
    starts: [],
    completes: 0,
    failures: [],
    suspensions: [],
    releases: 0,
    cancels: 0,
    confirmed: [],
    issued: [],
    failRenewalsFrom: { value: Number.POSITIVE_INFINITY },
  };
  let runSeq = 0;
  let capabilitySeq = 0;
  let renewals = 0;
  const minted = new Map<
    string,
    {
      runId: string;
      attemptId: string;
      generation: number;
      modelRequestId: string;
      maximumTokens: number;
    }
  >();
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
      renewals += 1;
      if (renewals >= harness.failRenewalsFrom.value) {
        throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
      }
      return {
        ...lease,
        expiresAt: new Date(Date.now() + 30_000),
      };
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
      harness.cancels += 1;
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
      if (options.issueError) throw options.issueError;
      capabilitySeq += 1;
      const capability = Buffer.alloc(32, capabilitySeq).toString("base64url");
      minted.set(capability, {
        runId: input.runId,
        attemptId: input.attemptId,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        maximumTokens: input.maximumTokens,
      });
      harness.issued.push({
        runId: input.runId,
        maximumTokens: input.maximumTokens,
      });
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
      if (!entry)
        throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: entry.runId,
        attemptId: entry.attemptId,
        generation: entry.generation,
        modelRouteRef: routeRefBox.current,
        modelRequestId: entry.modelRequestId,
        maximumTokens: entry.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage(
      _scope: PlatformScope,
      capability: string,
      usedTokens: number,
    ) {
      harness.confirmed.push({ capability, usedTokens });
    },
    async markModelInvocationUnknown() {},
  };
  harness.runs = service as unknown as RunService;
  // Publish the admitted route ref once the harness builder binds it.
  (harness as { bindRouteRef?(routeRef: string): void }).bindRouteRef = (
    routeRef: string,
  ) => {
    routeRefBox.current = routeRef;
  };
  return harness as RunsHarness & {
    bindRouteRef(routeRef: string): void;
  };
}

interface HarnessOptions {
  fetch: (
    url: string,
    call: number,
    init?: { signal?: AbortSignal },
  ) => Promise<Response> | Response;
  ceiling?: number;
  runs?: ReturnType<typeof fakeRuns>;
  record?: {
    agentId?: string;
    threadId?: string;
    instruction?: string;
    enabled?: boolean;
  } | null;
  scopeError?: Error;
  tools?: readonly GrantedTool[];
  frontendTools?: readonly {
    name: string;
    description: string;
    parameters?: unknown;
  }[];
  runtimeLoad?: (scope: PlatformScope, input: unknown) => unknown;
  continuations?: unknown;
  leaseRenewMs?: number;
}

async function harness(options: HarnessOptions) {
  const scope = await trustedScopeFor();
  const record =
    options.record === null
      ? null
      : {
          agentId: "bot-a",
          threadId: "thread-1",
          instruction: "Summarize yesterday.",
          enabled: true,
          ...(options.record ?? {}),
        };
  const runsHarness = options.runs ?? fakeRuns();
  const admitted = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    ROUTE,
    SECRET,
  );
  (runsHarness as unknown as { bindRouteRef(r: string): void }).bindRouteRef(
    admitted.routeRef,
  );
  const appends: { clientMessageKey: string; content: string }[] = [];
  const persisted: { binding: unknown; messages: unknown[] }[] = [];
  const loads: { clientMessageKey?: unknown }[] = [];
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
        : {
            routeRef: admitted.routeRef,
            maximumTokens: options.ceiling ?? 1024,
          },
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
        fetch: (url, init) => {
          dial += 1;
          return options.fetch(url, dial, init) as never;
        },
      }),
    surfaceFor: async () => ({
      instructions: ["You are Bot A, the nightly summarizer."],
      trailingInstructions: [PROVENANCE_GUIDANCE, UNTRUSTED_GUIDANCE],
      tools: options.tools ?? [],
      ...(options.frontendTools
        ? { frontendTools: options.frontendTools }
        : {}),
      ...(options.continuations
        ? { continuations: options.continuations }
        : {}),
    }),
    runtime: {
      loadExecutionInput: async (_scope, input) => {
        loads.push({
          clientMessageKey: (
            (input as { messages?: { id?: unknown }[] }).messages ?? []
          ).at(-1)?.id,
        });
        return (
          options.runtimeLoad ? options.runtimeLoad(_scope, input) : input
        ) as never;
      },
      persistExecutionMessages: async (binding, messages) => {
        persisted.push({ binding, messages: [...messages] });
      },
    } as never,
    leaseRenewMs: options.leaseRenewMs ?? 60_000,
  });
  return {
    runner,
    runsHarness,
    appends,
    persisted,
    loads,
    dialCount: () => dial,
    record,
  };
}

function grantedEchoTool(executions: unknown[]): GrantedTool {
  return {
    name: "echo_tool",
    description: "Echo the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async (args) => {
      executions.push(args);
      return "echoed:hi";
    },
    ref: "server/echo_tool",
  };
}

const TOOL_TURN_AND_ANSWER = () => {
  let call = 0;
  return (_request: Request, nth: number) => {
    call += 1;
    void call;
    return nth === 1
      ? sse([
          { toolCall: { id: "call_1", name: "echo_tool", args: "" } },
          { toolCall: { args: '{"value":"hi"}' } },
          { finish: "tool_calls" },
          {
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          },
        ])
      : sse([
          { content: "answered from the tool result" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        ]);
  };
};

describe("governed headless turn — the firing intent", () => {
  it("derives_one_stable_intent_key_per_firing_and_a_distinct_manual_key", () => {
    const scheduled = governedFiringIntentKey(
      "routine_1",
      "routine_1:2026-10-22T09:30Z",
    );
    expect(scheduled).toBe(
      governedFiringIntentKey("routine_1", "routine_1:2026-10-22T09:30Z"),
    );
    // A different firing (or routine) is a different intent.
    expect(scheduled).not.toBe(
      governedFiringIntentKey("routine_1", "routine_1:2026-10-22T09:45Z"),
    );
    expect(scheduled).not.toBe(
      governedFiringIntentKey("routine_2", "routine_1:2026-10-22T09:30Z"),
    );
    // A manual firing mints its own id inside the runner; the key shape stays
    // namespaced and the 200-code-point key cap holds for absurd ids.
    const long = governedFiringIntentKey("r".repeat(300), "f".repeat(300));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("routine-adv:")).toBe(true);
  });

  it("manual_and_scheduled_triggers_each_advance_once_with_their_own_intent", async () => {
    const scheduled = await harness({ fetch: TEXT_TURN });
    const scheduledReply = await scheduled.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
      runId: "routine_1:2026-10-22T09:30Z",
    });
    expect(scheduledReply.replyText).toBe("the nightly answer");
    expect(scheduled.appends).toHaveLength(1);
    expect(scheduled.appends[0]!.clientMessageKey).toBe(
      governedFiringIntentKey("routine_1", "routine_1:2026-10-22T09:30Z"),
    );
    expect(scheduled.runsHarness.completes).toBe(1);
    expect(scheduled.runsHarness.failures).toEqual([]);

    const manual = await harness({ fetch: TEXT_TURN });
    const manualReply = await manual.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
    });
    expect(manualReply.replyText).toBe("the nightly answer");
    // The manual firing's intent is its own (not the scheduled key).
    expect(manual.appends[0]!.clientMessageKey).not.toBe(
      scheduled.appends[0]!.clientMessageKey,
    );
    expect(manual.appends[0]!.clientMessageKey).toContain("manual-");
  });
});

describe("governed headless turn — the scheduling record and the directory", () => {
  it("a_queue_string_cannot_redirect_a_firing", async () => {
    const forged = await harness({
      fetch: TEXT_TURN,
      record: { threadId: "thread-1", agentId: "bot-a" },
    });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await forged.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-EVIL",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      refusal = error as GovernedHeadlessRefusal;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.contextMismatch);
    expect(forged.runsHarness.starts).toHaveLength(0);

    const forgedBot = await harness({
      fetch: TEXT_TURN,
    });
    let botRefusal: GovernedHeadlessRefusal | undefined;
    try {
      await forgedBot.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-EVIL",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      botRefusal = error as GovernedHeadlessRefusal;
    }
    expect(botRefusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.contextMismatch);
    expect(forgedBot.runsHarness.starts).toHaveLength(0);
  });

  it("a_gone_or_paused_record_refuses_before_anything_runs", async () => {
    const gone = await harness({ fetch: TEXT_TURN, record: null });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await gone.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      refusal = error as GovernedHeadlessRefusal;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(gone.runsHarness.starts).toHaveLength(0);

    const paused = await harness({
      fetch: TEXT_TURN,
      record: { enabled: false },
    });
    let pausedRefusal: GovernedHeadlessRefusal | undefined;
    try {
      await paused.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      pausedRefusal = error as GovernedHeadlessRefusal;
    }
    expect(pausedRefusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(pausedRefusal?.message).toContain("switched off");
    expect(paused.runsHarness.starts).toHaveLength(0);
  });

  it("a_revoked_owner_is_blocked_before_admission", async () => {
    const revoked = await harness({
      fetch: TEXT_TURN,
      scopeError: new Error("TENANT_FORBIDDEN"),
    });
    let thrown: unknown;
    try {
      await revoked.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("TENANT_FORBIDDEN");
    expect(revoked.runsHarness.starts).toHaveLength(0);
    expect(revoked.runsHarness.failures).toEqual([]);
  });
});

describe("governed headless turn — the explicit budget", () => {
  it("missing_budget_configuration_refuses_with_the_named_reason", async () => {
    const unconfigured = await harness({ fetch: TEXT_TURN, ceiling: 0 });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await unconfigured.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      refusal = error as GovernedHeadlessRefusal;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.budgetUnconfigured);
    expect(refusal?.message).toContain("ROUTINE_BUDGET_UNCONFIGURED");
    // Nothing was appended and nothing was admitted: the refusal precedes
    // every durable write.
    expect(unconfigured.appends).toHaveLength(0);
    expect(unconfigured.runsHarness.starts).toHaveLength(0);
  });

  it("the_admission_carries_the_route_and_the_explicit_ceiling", async () => {
    const h = await harness({ fetch: TEXT_TURN, ceiling: 777 });
    await h.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
    });
    const admission = h.runsHarness.starts[0]!;
    expect(admission.input.forwardedProps).toEqual({ maxOutputTokens: 777 });
    expect(admission.input.entrypoint).toBe("schedule");
    expect(admission.input.messageDigest).toBeTruthy();
  });
});

describe("governed headless turn — duplicate delivery", () => {
  it("a_redelivery_converges_on_the_same_intent_and_never_reruns", async () => {
    const intentKey = governedFiringIntentKey("routine_1", "firing-key-1");
    const h = await harness({
      fetch: TEXT_TURN,
      runs: fakeRuns({ intentConflictKeys: new Set([intentKey]) }),
    });
    // First delivery: the admission has NOT seen the key yet, so it runs...
    // except the harness pre-seeds the conflict, simulating the intent the
    // FIRST delivery claimed. The redelivery refuses before the model.
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
        runId: "firing-key-1",
      });
    } catch (error) {
      refusal = error as GovernedHeadlessRefusal;
    }
    expect(refusal?.code).toBe(
      GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced,
    );
    // No model dial, no completion, no second admission.
    expect(h.dialCount()).toBe(0);
    expect(h.runsHarness.completes).toBe(0);
    expect(h.runsHarness.starts).toHaveLength(1);
  });

  it("a_second_intent_is_a_new_firing_not_a_conflict", async () => {
    const h = await harness({ fetch: TEXT_TURN });
    await h.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
      runId: "firing-key-1",
    });
    await h.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
      runId: "firing-key-2",
    });
    expect(h.runsHarness.starts).toHaveLength(2);
    expect(h.runsHarness.completes).toBe(2);
    expect(h.dialCount()).toBe(2);
  });
});

describe("governed headless turn — write-back and settlement", () => {
  it("success_persists_the_answer_before_completing_and_reports_it", async () => {
    const h = await harness({ fetch: TEXT_TURN });
    const reply = await h.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Summarize yesterday.",
    });
    expect(reply.replyText).toBe("the nightly answer");
    // Write-back happened through the conversation runtime, with the
    // server-issued binding (threadId included).
    expect(h.persisted).toHaveLength(1);
    const binding = h.persisted[0]!.binding as { threadId?: string };
    expect(binding.threadId).toBe("thread-1");
    const roles = (h.persisted[0]!.messages as Message[]).map((m) => m.role);
    expect(roles).toEqual(["assistant"]);
    expect(h.runsHarness.completes).toBe(1);
    // The usage was authoritatively confirmed before completion.
    expect(h.runsHarness.confirmed.length).toBeGreaterThan(0);
    expect(h.loads[0]!.clientMessageKey).toBe(h.appends[0]!.clientMessageKey);
  });

  it("a_tool_turn_runs_the_granted_path_and_writes_back_the_answer", async () => {
    const executions: unknown[] = [];
    const h = await harness({
      fetch: TOOL_TURN_AND_ANSWER(),
      tools: [grantedEchoTool(executions)],
    });
    const reply = await h.runner({
      ownerUserId: "actor-x",
      routineId: "routine_1",
      agentId: "bot-a",
      threadId: "thread-1",
      instruction: "Echo hi, then answer.",
    });
    expect(executions).toEqual([{ value: "hi" }]);
    expect(reply.replyText).toBe("answered from the tool result");
    expect(h.runsHarness.completes).toBe(1);
    expect(h.runsHarness.issued.length).toBe(2);
  });

  it("malformed_usage_settlement_never_reads_as_success", async () => {
    const h = await harness({
      fetch: () =>
        sse([
          { content: "looks done" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 5 },
          },
        ]),
    });
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    // The malformed usage block fails the gateway stream: no confirmed
    // usage, no completion, no persisted answer, and a truthful failure
    // settled on the run row.
    expect(h.runsHarness.confirmed).toHaveLength(0);
    expect(h.runsHarness.completes).toBe(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.runsHarness.failures).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(thrown).toBeDefined();
  });

  it("a_budget_402_blocks_the_run_with_the_classified_code", async () => {
    const h = await harness({
      runs: fakeRuns({
        issueError: new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402),
      }),
      fetch: TEXT_TURN,
    });
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    expect(h.runsHarness.failures).toEqual(["MODEL_BUDGET_EXCEEDED"]);
    expect((thrown as Error).message).toContain("ROUTINE_TURN_RUN_ERROR");
    expect(
      classifyGovernedRunFailure(
        {
          budgetExhausted: () => true,
          settlementFailed: () => false,
        },
        thrown,
      ),
    ).toBe("MODEL_BUDGET_EXCEEDED");
  });

  it("a_lost_lease_blocks_the_run_before_it_can_continue", async () => {
    const h = await harness({
      fetch: (_url, _call, init) => {
        // The dial hangs until the run's abort reaches it (the gateway passes
        // the abort signal in the fetch init — the same wire a real provider
        // dial honors).
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () =>
            reject(new Error("The aborted dial was stopped."));
          const signal = init?.signal;
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      leaseRenewMs: 5,
    });
    h.runsHarness.failRenewalsFrom.value = 1;
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(h.runsHarness.failures).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(h.runsHarness.completes).toBe(0);
  }, 20000);
});

describe("governed headless turn — the approval wait", () => {
  it("a_participation_wait_parks_the_run_and_throws_the_suspension", async () => {
    const suspensionsSaved: {
      kind: string;
      toolName: string;
      toolCallId: string;
    }[] = [];
    const frontendTool = {
      name: "computer_navigate",
      description: "Open a web page on your own computer.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    };
    const h = await harness({
      fetch: () =>
        sse([
          {
            toolCall: {
              id: "call_web_1",
              name: "computer_navigate",
              args: '{"url":"https://example.com"}',
            },
          },
          { finish: "tool_calls" },
          {
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          },
        ]),
      frontendTools: [frontendTool],
      continuations: {
        // The durable context the wiring supplies: here it only records the
        // fact (an in-process suspension — the save-before-waiting contract
        // is observable without engine storage).
        onSuspension: async (fact) => {
          suspensionsSaved.push(fact);
        },
      } as never,
    });
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Open the page.",
      });
    } catch (error) {
      thrown = error;
    }
    // The bridge suspended the engine: the save ran BEFORE the waiting state
    // was published, and the firing outcome is the shared waiting vocabulary.
    expect(suspensionsSaved).toHaveLength(1);
    expect(suspensionsSaved[0]!.kind).toBe("frontend_tool");
    expect(suspensionsSaved[0]!.toolName).toBe("computer_navigate");
    expect(thrown).toBeInstanceOf(HeadlessToolSuspension);
    expect((thrown as HeadlessToolSuspension).waiting.kind).toBe(
      "frontend_tool",
    );
    // The run was parked in its ACTIVE waiting status, never failed, and the
    // lease went back for the later resume.
    expect(h.runsHarness.suspensions).toEqual(["suspended"]);
    expect(h.runsHarness.failures).toEqual([]);
    expect(h.runsHarness.releases).toBe(1);
    expect(h.runsHarness.completes).toBe(0);
    // No fabricated result reached the write-back.
    expect(h.persisted).toHaveLength(0);
  });

  it("terminalless_without_a_suspension_fact_fails_truthfully", async () => {
    // A frontend bridge suspends the engine terminal-less; with NO
    // continuations context wired there is no save hook, so the run ends
    // with neither a terminal nor a suspension fact — the runner must fail
    // truthfully instead of inventing an outcome (and the execution itself
    // refuses the save-less suspension with a named error first).
    const h = await harness({
      fetch: () =>
        sse([
          {
            toolCall: {
              id: "call_web_2",
              name: "computer_navigate",
              args: '{"url":"https://example.com"}',
            },
          },
          { finish: "tool_calls" },
          {
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          },
        ]),
      frontendTools: [
        {
          name: "computer_navigate",
          description: "Open a web page on your own computer.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      ],
    });
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: "actor-x",
        routineId: "routine_1",
        agentId: "bot-a",
        threadId: "thread-1",
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    const message =
      thrown instanceof Error ? thrown.message : String(thrown ?? "");
    // Either named refusal is truthful: the execution's save-less-suspension
    // error (the continuation save failed = the named MASTRA error) or the
    // runner's own unterminated refusal. What must NOT happen is a success
    // or a fabricated reply.
    expect(
      message.includes("ROUTINE_TURN_UNTERMINATED") ||
        message.includes("MASTRA_CONTINUATION_SAVE_FAILED"),
    ).toBe(true);
    expect(h.runsHarness.completes).toBe(0);
    expect(h.persisted).toHaveLength(0);
  });
});

describe("the composed generation gate", () => {
  it("is_current_only_while_the_bound_attempt_generation_is_active", async () => {
    const calls: { runId: string; attemptId: string }[] = [];
    const gate = createGenerationCurrentGate({
      getActiveAttemptGeneration: async (_scope, runId, attemptId) => {
        calls.push({ runId, attemptId });
        if (attemptId === "gone") throw new Error("RUN_ATTEMPT_STALE");
        if (attemptId === "moved") return 2;
        return 1;
      },
    });
    const scope = await trustedScopeFor();
    await expect(
      gate({ scope, runId: "run-1", attemptId: "attempt-1", generation: 1 }),
    ).resolves.toBe(true);
    await expect(
      gate({ scope, runId: "run-1", attemptId: "moved", generation: 1 }),
    ).resolves.toBe(false);
    // Absence (the read throws) refuses too — never a permissive default.
    await expect(
      gate({ scope, runId: "run-1", attemptId: "gone", generation: 1 }),
    ).resolves.toBe(false);
    expect(calls.every((call) => call.runId === "run-1")).toBe(true);
  });
});

describe("the waiting outcome contract", () => {
  it("the_routine_runner_skips_a_duplicate_without_counting_a_failure", () => {
    // The refusal the runner maps to "skipped" is the named one — a plain
    // GovernedHeadlessRefusal with the intent code. The BEHAVIORAL mapping
    // test lives in `server/tests/routine-runner.test.ts`
    // ("records a duplicate-delivery convergence as skipped without touching
    // the fatigue rule"); here the contract surface is pinned: the code is
    // stable and the error is the class the runner instanceof-checks.
    const refusal = new GovernedHeadlessRefusal(
      GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced,
      "converged",
    );
    expect(refusal instanceof GovernedHeadlessRefusal).toBe(true);
    expect(refusal.code).toBe("ROUTINE_INTENT_ALREADY_ADVANCED");
  });

  it("a_headless_suspension_is_the_shared_waiting_vocabulary", () => {
    const suspension = new HeadlessToolSuspension("waiting", {
      kind: "frontend_tool",
      toolName: "computer_navigate",
    });
    expect(suspension.waiting.kind).toBe("frontend_tool");
    expect(suspension.name).toBe("HeadlessToolSuspension");
  });
});

/**
 * ME09 fix round 1: the resume wrapper's run settlement gate. The production
 * resume wrapper (index.ts) used to settle a finished drive's run `complete`
 * unconditionally — the engine finishing read as success even when the
 * governed carrier's usage settlement refused (spec §5's "仅见引擎 finish 即
 * 成功" violation). The gate below is the code production now runs; these
 * tests pin it: usage evidence decides, an un-settleable lease isolates the
 * run by name, and no path here can produce a silent "resumed".
 */
describe("the resumed drive's settlement gate", () => {
  const LEASE: RunnerRequestLease = {
    runId: "server-run-1",
    attemptId: "attempt-1",
    generation: 3,
    ownerToken: "token-1",
    expiresAt: new Date(Date.now() + 30_000),
  };

  /** The runs-service face the gate settles through, with call counters. */
  function settleRuns(options: { complete?: boolean; fail?: boolean } = {}) {
    const calls = {
      completes: 0,
      fails: [] as RunFailureCode[],
      releases: 0,
    };
    const runs = {
      async complete() {
        calls.completes += 1;
        return options.complete ?? true;
      },
      async fail(_scope: PlatformScope, input: { errorCode: RunFailureCode }) {
        calls.fails.push(input.errorCode);
        return options.fail ?? true;
      },
      async releaseRequestLease() {
        calls.releases += 1;
        return true;
      },
    };
    return { runs, calls };
  }

  /** The carrier probes the gate reads; clean means issued==confirmed usage. */
  const carrierWith = (probes: {
    clean: boolean;
    budget: boolean;
    settlementFailed: boolean;
  }) => ({
    settlementClean: () => probes.clean,
    budgetExhausted: () => probes.budget,
    settlementFailed: () => probes.settlementFailed,
  });
  const cleanCarrier = carrierWith({
    clean: true,
    budget: false,
    settlementFailed: false,
  });
  const refusedCarrier = carrierWith({
    clean: false,
    budget: false,
    settlementFailed: true,
  });
  const usagelessCarrier = carrierWith({
    clean: false,
    budget: false,
    settlementFailed: false,
  });
  const budgetCarrier = carrierWith({
    clean: false,
    budget: true,
    settlementFailed: false,
  });

  it("a_resumed_drive_whose_usage_settlement_refuses_never_settles_the_run_succeeded", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns();
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: refusedCarrier,
        outcome: "resumed",
      });
    } catch (error) {
      thrown = error;
    }
    // The completion is never attempted on an unverified settlement: the run
    // settles FAILED with the carrier-classified code instead.
    expect(calls.completes).toBe(0);
    expect(calls.fails).toEqual(["MODEL_SETTLEMENT_FAILED"]);
    expect(thrown).toBeInstanceOf(MastraContinuationRefusal);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.settlementUnverified,
    );
    expect((thrown as Error).message).toContain("MODEL_SETTLEMENT_FAILED");
  });

  it("a_declined_drive_without_usage_evidence_fails_closed_the_same_way", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns();
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        // A drive that never consumed the model has no usage evidence: the
        // classifier reads MODEL_EXECUTION_FAILED, the run never succeeds.
        carrier: usagelessCarrier,
        outcome: "declined",
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls.completes).toBe(0);
    expect(calls.fails).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.settlementUnverified,
    );
  });

  it("a_clean_finish_still_settles_the_run_succeeded_under_the_lease", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns();
    await expect(
      settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: cleanCarrier,
        outcome: "resumed",
      }),
    ).resolves.toBeUndefined();
    expect(calls.completes).toBe(1);
    expect(calls.fails).toEqual([]);
    expect(calls.releases).toBe(0);
  });

  it("a_refused_completion_after_a_clean_finish_settles_the_truthful_failure", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns({ complete: false, fail: true });
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: cleanCarrier,
        outcome: "resumed",
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls.completes).toBe(1);
    expect(calls.fails).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(calls.releases).toBe(0);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.completionStale,
    );
  });

  it("an_unsettleable_outcome_isolates_the_run_and_releases_the_lease", async () => {
    const scope = await trustedScopeFor();
    // The lease expired during the drive with nothing renewing it: neither
    // complete nor fail can settle under it.
    const { runs, calls } = settleRuns({ complete: false, fail: false });
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: cleanCarrier,
        outcome: "resumed",
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls.completes).toBe(1);
    expect(calls.fails).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(calls.releases).toBe(1);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.runUnsettled,
    );
    expect((thrown as Error).message).toContain("resumed");
  });

  it("a_budget_refusal_with_a_dead_lease_fails_and_isolates_by_name", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns({ fail: false });
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: budgetCarrier,
        outcome: "declined",
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls.completes).toBe(0);
    expect(calls.fails).toEqual(["MODEL_BUDGET_EXCEEDED"]);
    expect(calls.releases).toBe(1);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.runUnsettled,
    );
  });

  it("a_drive_that_surfaced_no_carrier_at_all_fails_closed", async () => {
    const scope = await trustedScopeFor();
    const { runs, calls } = settleRuns();
    let thrown: unknown;
    try {
      await settleResumedRun(runs, {
        scope,
        lease: LEASE,
        carrier: null,
        outcome: "resumed",
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls.completes).toBe(0);
    expect(calls.fails).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      MASTRA_RESUME_SETTLE_REFUSALS.settlementUnverified,
    );
  });

  it("the_re_activated_lease_must_be_the_attempt_the_continuation_binds", async () => {
    // The index.ts wiring's check, extracted so ONE definition serves both —
    // driven here by the refusal contract the wrapper surfaces.
    const staleAttempt = {
      lease: { attemptId: "attempt-2", generation: 3 },
    };
    let thrown: unknown;
    try {
      assertResumeBindingCurrent(staleAttempt, {
        attemptId: "attempt-1",
        generation: 3,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MastraContinuationRefusal);
    expect((thrown as MastraContinuationRefusal).code).toBe(
      "MASTRA_CONTINUATION_GENERATION_STALE",
    );
    expect(() =>
      assertResumeBindingCurrent(
        { lease: { attemptId: "attempt-1", generation: 3 } },
        { attemptId: "attempt-1", generation: 3 },
      ),
    ).not.toThrow();
    // A moved generation refuses the same way.
    expect(() =>
      assertResumeBindingCurrent(
        { lease: { attemptId: "attempt-1", generation: 4 } },
        { attemptId: "attempt-1", generation: 3 },
      ),
    ).toThrow(MastraContinuationRefusal);
  });
});
