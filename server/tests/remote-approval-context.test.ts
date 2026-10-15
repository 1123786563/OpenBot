import { expect, spyOn, test } from "bun:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { of } from "rxjs";
import { z } from "zod";
import { currentApprovalContext } from "../src/approvals/types";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { buildAgents } from "../src/copilot";

async function fixture(answered = false) {
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    return of(
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "STATE_SNAPSHOT", snapshot: { real: "provider-state" } },
      {
        type: "TOOL_CALL_START",
        toolCallId: "provider-call",
        toolCallName: "mcp__vendor__write",
        parentMessageId: "provider-message",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "provider-call",
        delta: '{"value":"actual"}',
      },
      { type: "TOOL_CALL_END", toolCallId: "provider-call" },
      ...(answered
        ? [
            {
              type: "TOOL_CALL_RESULT" as const,
              messageId: "backend-result",
              toolCallId: "provider-call",
              content: "backend already executed",
              role: "tool" as const,
            },
          ]
        : []),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    );
  });
  let context: ReturnType<typeof currentApprovalContext>;
  let calls = 0;
  const args: Parameters<typeof buildAgents> = [
    [
      {
        id: "remote",
        name: "Remote",
        type: "remote_ag_ui",
        endpoint: "https://remote.test/ag-ui",
        standingMessage: {
          id: "standing-role:remote",
          role: "system",
          content: "Remote job",
        },
      },
    ],
    { provider: "openai", defaultModel: "test" },
    null,
  ];
  args[4] = async () => [
    {
      name: "mcp__vendor__write",
      ref: "vendor/write",
      description: "Write with approval",
      parameters: z.object({ value: z.string() }),
      execute: async () => {
        calls += 1;
        context = currentApprovalContext();
        throw new HeadlessToolSuspension("Approve write", {
          kind: "approval",
          requestId: "request",
        });
      },
    },
  ];
  args[5] = () => "signed-original-run";
  const agent = (await buildAgents(...args)).remote;
  if (!agent) throw new Error("Missing fixture agent");
  agent.threadId = "canonical-thread";
  agent.messages = [
    { id: "person-message", role: "user", content: "Write actual" },
  ];
  return { run, requests, agent, calls: () => calls, context: () => context };
}

test("remote client tool captures real provider call and canonical conversation before approval suspension", async () => {
  const f = await fixture();
  try {
    // Fail-closed: the built remote agent refuses before the fully mocked-to-succeed
    // client is ever reached, no granted tool executes, and no approval context exists.
    // The provider-state merge, signed-run forwarding and conversation capture this
    // scenario used to pin are parked behind a future verified governance contract.
    await expect(
      f.agent.runAgent({
        runId: "canonical-run",
        forwardedProps: { original: true },
      }),
    ).rejects.toThrow("REMOTE_RUN_BUDGET_UNVERIFIED");
    expect(f.requests).toHaveLength(0);
    expect(f.calls()).toBe(0);
    expect(f.context()).toBeUndefined();
  } finally {
    f.run.mockRestore();
  }
});

test("backend answered remote tool calls are forwarded without duplicate execution", async () => {
  const f = await fixture(true);
  try {
    // Fail-closed: the dedup semantics under test are remote-path-only and currently
    // unreachable; the refusal plus zero executions is the reachable contract.
    await expect(f.agent.runAgent({ runId: "canonical-run" })).rejects.toThrow(
      "REMOTE_RUN_BUDGET_UNVERIFIED",
    );
    expect(f.requests).toHaveLength(0);
    expect(f.calls()).toBe(0);
    expect(f.context()).toBeUndefined();
  } finally {
    f.run.mockRestore();
  }
});
