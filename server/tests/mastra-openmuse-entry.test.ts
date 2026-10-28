import { frameFiring } from "../../shared/routine-firing";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import type { AuditInitiator } from "../src/audit";
import type {
  PlatformScope,
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
import {
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  GovernedHeadlessRefusal,
} from "../src/mastra/headless";

/*
 * ME12 (#484) unit suite: the OpenMuse Task queue entry — the one main-repo
 * assembled OpenMuse call that runs an OpenBot Bot turn — as a THIN assembly
 * over the SAME governed headless turn every other unattended entry runs.
 * The TASK ROW is the record authority: the adapter re-reads it at the
 * moment of running (a settled or deleted Task refuses by name before
 * anything is admitted), the instruction is the row's own prompt (a plan
 * runs the step its claim marked running), and the identity is the row's
 * owner + private Bot + the owner's own conversation thread. The entry
 * adds no model dial, no budget and no scope of its own: budget, scope
 * re-signing, settlement and lease are the shared governed base.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
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
    { content: "the task answer" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

function fakeRuns(routeRefBox: { current: string }) {
  const state = {
    starts: [] as TrustedRunAdmission[],
    completes: 0,
    failures: [] as RunFailureCode[],
    releases: 0,
  };
  let runSeq = 0;
  const service = {
    async start(_scope: PlatformScope, admission: TrustedRunAdmission) {
      state.starts.push(admission);
      runSeq += 1;
      return {
        run_id: `server-run-${runSeq}`,
        thread_id: admission.input.threadId,
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        finished_at: null,
      } as never;
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
      state.releases += 1;
      return true;
    },
    async complete() {
      state.completes += 1;
      return true;
    },
    async fail(_scope: PlatformScope, input: { errorCode: RunFailureCode }) {
      state.failures.push(input.errorCode);
      return true;
    },
    async cancel() {
      return {} as never;
    },
    async markRunSuspended() {
      return true;
    },
    async issueModelInvocationCapability(
      _scope: PlatformScope,
      input: { maximumTokens: number },
    ) {
      return {
        capability: Buffer.alloc(32, 9).toString("base64url"),
        model_request_id: "mr-1",
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(scope: PlatformScope) {
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: "server-run-1",
        attemptId: "attempt-server-run-1",
        generation: 1,
        modelRouteRef: routeRefBox.current,
        maximumTokens: 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage() {},
    async markModelInvocationUnknown() {},
  };
  return { state, runs: service as unknown as RunService };
}

type TaskRow = {
  ownerUserId: string;
  botId: string;
  kind: string;
  status: string;
  prompt: string | null;
  steps: unknown;
};

/** The adapter's whole database surface: one projected row read by id. */
function fakeTaskDatabase(row: TaskRow | null) {
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => (row ? [row] : []),
  };
  return { select: () => query };
}

interface HarnessOptions {
  row: TaskRow | null;
  threadId?: string | null;
  fetch?: () => Promise<Response> | Response;
  turnTimeoutMs?: number;
}

async function harness(options: HarnessOptions) {
  const scope = await trustedScopeFor();
  const routeRefBox = { current: "" };
  const { state, runs } = fakeRuns(routeRefBox);
  const admitted = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    ROUTE,
    SECRET,
  );
  routeRefBox.current = admitted.routeRef;
  const appends: { clientMessageKey: string; content: string }[] = [];
  let dial = 0;
  const surfaceInputs: {
    initiator: AuditInitiator;
    agentId: string;
    routineId: string;
  }[] = [];
  const { openMuseTaskSchedulingRecordFor } = await import(
    "../src/mastra/openmuse-task-entry"
  );
  const runner = createGovernedTurnRunner({
    schedulingRecordFor: openMuseTaskSchedulingRecordFor({
      database: fakeTaskDatabase(options.row) as never,
      channelThreadIdFor: async () =>
        options.threadId === undefined ? "thread-1" : options.threadId,
    }),
    scopeFor: async () => scope,
    runs,
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
        agentId: "bot-a",
        routeRef,
        ceiling,
        runs,
        catalog: {
          get: async (_scope, ref) =>
            ref === admitted.routeRef ? admitted : null,
        },
        currentRouteForAgent: async () => ROUTE,
        modelCapabilitySecret: SECRET,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        credentialReader: { readModelSecret: async () => null },
        environment: {
          OPENAI_BASE_URL: "https://provider.example/v1",
          OPENAI_API_KEY: "sk-env-fallback",
        },
        fetch: () => {
          dial += 1;
          return (options.fetch ?? TEXT_TURN)() as never;
        },
      }),
    surfaceFor: async (input) => {
      surfaceInputs.push({
        initiator: input.initiator,
        agentId: input.agentId,
        routineId: input.routineId,
      });
      return { instructions: ["You are the private Bot."], tools: [] };
    },
    runtime: {
      loadExecutionInput: async (_scope, input) => input,
      persistExecutionMessages: async () => undefined,
    } as never,
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });
  return { runner, state, appends, dialCount: () => dial, surfaceInputs };
}

const agentRow = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  ownerUserId: "actor-x",
  botId: "bot-a",
  kind: "agent",
  status: "running",
  prompt: "Summarize my week",
  steps: [],
  ...overrides,
});

const turnInput = () => ({
  ownerUserId: "actor-x",
  routineId: "openmuse-task:task-1",
  agentId: "bot-a",
  threadId: "thread-1",
  instruction: "Summarize my week",
});

describe("ME12 — the OpenMuse Task entry runs the row, not the claim", () => {
  it("a_running_task_runs_its_prompt_framed_under_the_tasks_own_identity", async () => {
    const entry = await harness({ row: agentRow() });
    const reply = await entry.runner(turnInput());
    expect(reply.replyText).toBe("the task answer");
    // The submitted intent is the ROW's prompt under the routine firing
    // frame — the same message the legacy runner framed for a Task turn.
    expect(entry.appends[0]!.content).toBe(frameFiring("Summarize my week"));
    expect(entry.state.completes).toBe(1);
    // The surface ran as the Task's own initiator (kind routine, the task's
    // queue identity) — never a person session, never a global identity.
    expect(entry.surfaceInputs[0]!.initiator).toEqual({
      kind: "routine",
      id: "openmuse-task:task-1",
    });
    expect(entry.surfaceInputs[0]!.agentId).toBe("bot-a");
  });

  it("a_running_task_without_words_refuses_rather_than_running_an_empty_instruction", async () => {
    const entry = await harness({ row: agentRow({ prompt: null }) });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await entry.runner(turnInput());
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(entry.appends).toHaveLength(0);
    expect(entry.dialCount()).toBe(0);
  });

  it("a_plan_task_runs_the_step_its_claim_marked_running", async () => {
    const entry = await harness({
      row: agentRow({
        kind: "plan",
        prompt: "the plan prompt",
        steps: [
          {
            id: "s1",
            title: "Fetch the data",
            dependsOn: [],
            status: "succeeded",
          },
          {
            id: "s2",
            title: "Write the summary",
            dependsOn: ["s1"],
            status: "running",
          },
        ],
      }),
    });
    await entry.runner(turnInput());
    expect(entry.appends[0]!.content).toBe(frameFiring("Write the summary"));
  });

  it("a_plan_without_a_running_step_refuses_rather_than_running_the_prompt", async () => {
    const entry = await harness({
      row: agentRow({
        kind: "plan",
        steps: [
          {
            id: "s1",
            title: "Fetch the data",
            dependsOn: [],
            status: "pending",
          },
        ],
      }),
    });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await entry.runner(turnInput());
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(entry.appends).toHaveLength(0);
    expect(entry.dialCount()).toBe(0);
  });

  it("a_settled_task_refuses_before_anything_is_admitted", async () => {
    const entry = await harness({ row: agentRow({ status: "succeeded" }) });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await entry.runner(turnInput());
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(entry.appends).toHaveLength(0);
    expect(entry.dialCount()).toBe(0);
    expect(entry.state.starts).toHaveLength(0);
  });

  it("a_task_whose_conversation_no_longer_resolves_refuses", async () => {
    const entry = await harness({ row: agentRow(), threadId: null });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await entry.runner(turnInput());
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(entry.appends).toHaveLength(0);
    expect(entry.dialCount()).toBe(0);
  });

  it("a_routine_id_that_is_not_an_openmuse_task_is_not_this_entrys_record", async () => {
    const entry = await harness({ row: agentRow() });
    let refusal: GovernedHeadlessRefusal | undefined;
    try {
      await entry.runner({ ...turnInput(), routineId: "routine_1" });
    } catch (error) {
      if (error instanceof GovernedHeadlessRefusal) refusal = error;
    }
    expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.recordGone);
    expect(entry.dialCount()).toBe(0);
  });

  it("a_timed_out_task_turn_fails_the_run_truthfully_and_releases_the_lease", async () => {
    const entry = await harness({
      row: agentRow(),
      fetch: () =>
        new Promise<Response>(() => {
          // Never answers: the turn deadline is the only way out.
        }),
      turnTimeoutMs: 50,
    });
    let timedOut = false;
    try {
      await entry.runner(turnInput());
    } catch (error) {
      timedOut = (error as Error).message.includes("did not finish within");
    }
    expect(timedOut).toBe(true);
    expect(entry.state.failures).toEqual(["MODEL_EXECUTION_FAILED"]);
    expect(entry.state.completes).toBe(0);
    expect(entry.state.releases).toBeGreaterThanOrEqual(1);
  });
});
