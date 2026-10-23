import { z } from "zod";
import type { PlatformScope, RunService } from "../../src/enterprise/contracts";
import {
  createGovernedModelExecution,
  type GovernedModelRequest,
} from "../../src/enterprise/runs/governed-execution";
import { ModelInvocationError } from "../../src/enterprise/runs/model-capability";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { executeGovernedMastra } from "../../src/mastra/governed-agent";
import { type GrantedTool, REFUSAL_MARKER } from "@openbot/toolkit/granted-tool";

/*
 * ME04 (#476) shared harness: the governed carrier around a synthetic
 * RunService and a stubbed upstream dial, derived line-for-line from the
 * ME02 fixture inside `server/tests/mastra-governed-execution.test.ts`
 * (that file predates this support module and keeps its own copy). The
 * governed model collaborator, capability minting and settlement here are
 * the REAL production carrier — only the upstream fetch is stubbed.
 */

export const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  OPENAI_API_KEY: "sk-env-fallback",
};

/** The server-selected route every harness admission pins. */
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "bot-a",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

/**
 * Trusted synthetic directory scope, the only shape assertTrustedScope
 * accepts — the production runner tests mint theirs the same way.
 */
export async function trustedScopeFor(actorId: string): Promise<PlatformScope> {
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
                tenantId: `tenant-${actorId}`,
                principalId: `principal-${actorId}`,
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
    "../../src/enterprise/tenancy/connections"
  );
  const { createScopeResolver } = await import(
    "../../src/enterprise/tenancy/store"
  );
  const directory = await verifyDirectoryDatabase(database as never);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId, entrypoint: "web" }),
    selectTenant: () => `tenant-${actorId}`,
    selectWorkspace: () => `workspace-${actorId}`,
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

export interface RunsHarness {
  service: RunService;
  capabilitiesIssued: {
    runId: string;
    maximumTokens: number;
    modelRequestId: string;
  }[];
  capabilitiesConfirmed: { capability: string; usedTokens: number }[];
  /** Publishes the admitted route reference the resolve must echo. */
  bindModelRouteRef(modelRouteRef: string): void;
}

export function syntheticRuns(
  options: { issueError?: Error } = {},
): RunsHarness {
  const capabilitiesIssued: RunsHarness["capabilitiesIssued"] = [];
  const capabilitiesConfirmed: RunsHarness["capabilitiesConfirmed"] = [];
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
  // Set once the carrier publishes its admitted route: the resolve must echo
  // exactly the admitted reference, or the adapter fails closed.
  const routeRef: { current: string | null } = { current: null };
  let seed = 0;
  const service: RunService = {
    async issueModelInvocationCapability(_scope, input) {
      if (options.issueError) throw options.issueError;
      const capability = Buffer.alloc(32, ++seed).toString("base64url");
      minted.set(capability, {
        runId: input.runId,
        attemptId: input.attemptId,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        maximumTokens: input.maximumTokens,
      });
      capabilitiesIssued.push({
        runId: input.runId,
        maximumTokens: input.maximumTokens,
        modelRequestId: input.modelRequestId,
      });
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(scope, capability) {
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
        modelRouteRef: routeRef.current ?? "",
        modelRequestId: entry.modelRequestId,
        maximumTokens: entry.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage(_scope, capability, usedTokens) {
      capabilitiesConfirmed.push({ capability, usedTokens });
    },
    async markModelInvocationUnknown() {},
  };
  return {
    service: service as unknown as RunService,
    capabilitiesIssued,
    capabilitiesConfirmed,
    bindModelRouteRef(modelRouteRef) {
      routeRef.current = modelRouteRef;
    },
  };
}

/** OpenAI SSE response built from raw chat-completion chunks. */
export function sse(
  parts: {
    content?: string;
    finish?: string | null;
    usage?: Record<string, unknown>;
    toolCall?: { id: string; name: string; args: string };
  }[],
): Response {
  const chunks = parts.map((part) => {
    const delta: Record<string, unknown> = {};
    if (part.content !== undefined) delta.role = "assistant";
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

export interface CarrierHarness {
  scope: PlatformScope;
  governedModel: GovernedModelRequest;
  settlementClean(): boolean;
  budgetExhausted(): boolean;
  settlementFailed(): boolean;
}

export async function carrier(options: {
  ceiling?: number;
  runs?: RunsHarness;
  /** Observability: every upstream dial, as the parsed JSON body. */
  onDial?: (body: Record<string, unknown>) => void;
  fetch: (call: number) => Response;
}): Promise<CarrierHarness> {
  const scope = await trustedScopeFor("actor-a");
  const admitted = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    ROUTE,
    SECRET,
  );
  const runs = options.runs ?? syntheticRuns();
  runs.bindModelRouteRef(admitted.routeRef);
  let call = 0;
  const execution = createGovernedModelExecution({
    scope,
    agentId: "bot-a",
    routeRef: admitted.routeRef,
    ceiling: options.ceiling ?? 4096,
    runs: runs.service,
    catalog: {
      get: async (_scope, routeRef) =>
        routeRef === admitted.routeRef ? admitted : null,
    },
    currentRouteForAgent: async () => ROUTE,
    modelCapabilitySecret: SECRET,
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    credentialReader: { readModelSecret: async () => null },
    environment: ENVIRONMENT,
    fetch: (async (input: unknown, init: unknown) => {
      const request = new Request(input as string, init as RequestInit);
      const body = (await request.clone().json()) as Record<string, unknown>;
      options.onDial?.(body);
      call += 1;
      return options.fetch(call);
    }) as typeof fetch,
  });
  execution.bind({
    runId: "server-run-1",
    attemptId: "attempt-1",
    generation: 1,
  });
  return {
    scope,
    governedModel: execution.governedModel,
    settlementClean: () => execution.settlementClean(),
    budgetExhausted: () => execution.budgetExhausted(),
    settlementFailed: () => execution.settlementFailed(),
  };
}

export interface GrantedToolSpec {
  /** The model-facing name (`mcp__<server>__<tool>` in production). */
  name?: string;
  executions?: unknown[];
  /** Simulates the store's read-at-run-time grant re-check going false. */
  revoked?: { value: boolean };
  /** Falls back to a refusal text, exactly like `grantedTools` does. */
  refuseWith?: string;
  /** Optional sink for every receipt the granted path writes. */
  onExecute?: (args: unknown) => void | Promise<void>;
}

export function grantedEchoTool(spec: GrantedToolSpec = {}): GrantedTool {
  const name = spec.name ?? "mcp__server__echo_tool";
  return {
    name,
    description: "Echo the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async (args) => {
      // The GrantedTool execute path re-checks the grant at run time (the
      // store reads grants fresh per call); a revoked grant refuses and
      // never reaches the vendor.
      if (spec.revoked?.value) {
        // The same REFUSAL_MARKER production assembles its refusals with, so
        // the "exactly like `grantedTools` does" claim above survives any
        // prefix evolution instead of pinning today's literal.
        return `${REFUSAL_MARKER} the grant for this tool was revoked.`;
      }
      spec.executions?.push(args);
      await spec.onExecute?.(args);
      return "echoed:hi";
    },
    ref: `server/${name}`,
  };
}

export function collectEvents(
  request: Parameters<typeof executeGovernedMastra>[0],
): Promise<{
  events: { type: string; message?: unknown }[];
  error?: Error;
}> {
  return new Promise((resolve) => {
    const events: { type: string; message?: unknown }[] = [];
    executeGovernedMastra(request).subscribe({
      next: (event) =>
        events.push({
          type: event.type,
          message: (event as unknown as { message?: unknown }).message,
        }),
      error: (cause) =>
        resolve({
          events,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      complete: () => resolve({ events }),
    });
  });
}

/** Same, but keeps every raw BaseEvent field (toolCallId, delta, ...). */
export function collectRawEvents(
  request: Parameters<typeof executeGovernedMastra>[0],
): Promise<{ events: Record<string, unknown>[]; error?: Error }> {
  return new Promise((resolve) => {
    const events: Record<string, unknown>[] = [];
    executeGovernedMastra(request).subscribe({
      next: (event) => events.push(event as unknown as Record<string, unknown>),
      error: (cause) =>
        resolve({
          events,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      complete: () => resolve({ events }),
    });
  });
}

export function buildRequest(
  harness: CarrierHarness,
  overrides: Record<string, unknown> = {},
) {
  const facts = harness.governedModel.executionBinding?.();
  if (!facts) throw new Error("carrier did not issue execution facts");
  return {
    binding: {
      scope: harness.scope,
      botId: facts.botId,
      runId: facts.runId,
      attemptId: facts.attemptId,
      generation: facts.generation,
      executionKey: facts.executionKey,
    },
    input: {
      threadId: "thread-1",
      runId: "client-run-1",
      messages: [{ id: "msg-1", role: "user" as const, content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
    instructions: ["You are Bot A."],
    tools: [] as GrantedTool[],
    governedModel: harness.governedModel,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A fresh 2-step scripted upstream: tool call, then the final answer. */
export function twoStepToolUpstream(): (call: number) => Response {
  return (call) =>
    call === 1
      ? sse([
          {
            toolCall: {
              id: "call_1",
              name: "mcp__server__echo_tool",
              args: "",
            },
          },
          { toolCall: { args: '{"value":"hi"}' } },
          { finish: "tool_calls" },
          {
            usage: {
              prompt_tokens: 70,
              completion_tokens: 0,
              total_tokens: 70,
            },
          },
        ])
      : sse([
          { content: "answered from tool result" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          },
        ]);
}
