import "./preload";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { a2uiProviderOptions } from "@/lib/copilot/a2ui";
import { useFrontendTool } from "@/lib/copilot/approval-tools";
import { resumeHandoffTask } from "@/lib/copilot/handoff-resume";
import { queryClient } from "@/query-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";

/**
 * The existing client against a Mastra-backed runtime's history, without a live server.
 *
 * The server now owns the authoritative history and rebuilds model context itself (ME03 T4); the
 * store it serves from writes turns in its own dialect. Nothing here may assume the previous
 * runtime's private state shapes. These cases read the channel surface the way a refresh, a
 * reconnect, a waiting approval, a Stop press and an old paused handoff actually meet the client:
 * stored turns arrive over HTTP, the gateway snapshot arrives over the join, and the inbox arrives
 * from the same owner-scoped approvals query every other surface reads.
 *
 * ME03 boundary: resume of an interrupted run is ME05 (server-owned). Where a case reaches that
 * boundary it asserts only the client-side observable — the waiting state renders, the affordance
 * is enabled, Stop targets the run in flight — and stops there.
 */

type ChannelCache = InfiniteData<ChannelPage>;

const channel: AgentChannel = {
  id: "mastra-compat",
  name: "Mastra compat",
  agentIds: ["compat-bot"],
  threadId: "compat-thread",
  active: true,
  lastMessageAt: "2026-10-01T00:00:00.000Z",
};

/*
 * Turns as the Mastra-backed history store writes them — the stored tool-call dialect
 * `{id, name, args}` and a tool result row keyed by `toolCallId`. These shapes are what the server
 * persists full-parts from (T4); the client must render them without counting them unreadable.
 */
const userTurn = {
  id: "u1",
  role: "user",
  content: "What is the retry protocol?",
} satisfies Message;
const partialAssistant = {
  id: "a1",
  role: "assistant",
  content: "Checking the runbook.",
  toolCalls: [
    {
      id: "call-read",
      name: "docs_search",
      args: '{"query":"retry protocol"}',
    },
  ],
};
const toolResult = {
  id: "t1",
  role: "tool",
  toolCallId: "call-read",
  content: "Found 3 pages about the retry protocol.",
};
const answer = {
  id: "a2",
  role: "assistant",
  content: "Retry twice, then page the on-call.",
} satisfies Message;
const storedTurns = [userTurn, partialAssistant, toolResult, answer];

let originalFetch: typeof fetch;
let history: (threadId: string) => Promise<Response>;
let historyReads: string[];
let gatewaySnapshot: readonly Message[] = [];
let decisionRequests: { id: string; body: unknown }[];
const EMPTY_INBOX = {
  enabled: false,
  requests: [],
  rules: [],
  teamRules: [],
  questions: [],
};
let inbox: unknown = EMPTY_INBOX;
let runRequests: { path: string; input: RunAgentInput }[];
let stopRequests: unknown[];
let runEvents: (input: RunAgentInput) => Response;
/** ME16: the workspace's waiting Mastra suspensions, as the list route answers. */
let waitingSuspensions: {
  continuationId: string;
  status: string;
  kind: string;
  toolCallId: string;
}[];
/** ME16: the tool results the browser posted to the participation route. */
let participationPosts: { id: string; body: unknown }[];
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}
function stored(messages: unknown[]) {
  return Response.json({ messages });
}
function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
/** A run whose stream stays open: the run is genuinely in flight until something ends it. */
function openRun(input: RunAgentInput) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId })}\n\n`,
          ),
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * A Mastra frontend_tool suspension on the wire: the call is announced, the
 * args stream, the call ends — and the stream CLOSES with no result event
 * and no terminal. That is what a suspension is: the run is parked on the
 * server, and only a client answering the participation route continues it.
 */
function suspendedRun(input: RunAgentInput, toolCallId: string) {
  const events = [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TOOL_CALL_START",
      threadId: input.threadId,
      runId: input.runId,
      toolCallId,
      toolCallName: "participation_probe",
    },
    {
      type: "TOOL_CALL_ARGS",
      threadId: input.threadId,
      runId: input.runId,
      toolCallId,
      delta: '{"query":"the page says hello"}',
    },
    {
      type: "TOOL_CALL_END",
      threadId: input.threadId,
      runId: input.runId,
      toolCallId,
    },
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * The probe tool the participation cases drive, registered through the app's
 * own `useFrontendTool` wrapper — the seam the participation answer lives in.
 */
function ParticipationProbeTool(props: {
  onResult: (result: unknown) => unknown;
}) {
  useFrontendTool({
    name: "participation_probe",
    description: "Reads the page the person is on.",
    parameters: z.object({ query: z.string().describe("What to read.") }),
    handler: async (args: { query?: string }) =>
      props.onResult({ text: `read: ${args.query ?? ""}` }),
  });
  return null;
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents") return Response.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/compat-bot")
        return Response.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return Response.json({
          version: "fixture",
          agents: {
            "compat-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: gatewaySnapshot },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        let body: RunAgentInput;
        try {
          body = RunAgentInputSchema.parse(await request.json());
        } catch (error) {
          console.error("fixture /run input failed schema:", String(error));
          throw error;
        }
        runRequests.push({ path: url.pathname, input: body });
        return runEvents(body);
      }
      if (/^\/api\/copilotkit\/agent\/[^/]+\/stop\//.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        stopRequests.push(await request.json().catch(() => ({})));
        return Response.json({});
      }
      if (url.pathname === "/api/mastra-continuations") {
        return Response.json({ suspensions: waitingSuspensions });
      }
      if (
        /^\/api\/mastra-continuations\/[^/]+\/tool-result$/.test(url.pathname)
      ) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        participationPosts.push({ id, body: await request.json() });
        return Response.json({ result: { outcome: "resumed" } });
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return Response.json({ sessions: [], nextCursor: null });
      if (url.pathname === "/api/approvals") return Response.json(inbox);
      if (/^\/api\/approvals\/[^/]+\/decision$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const id = url.pathname.split("/")[3];
        decisionRequests.push({ id, body: await request.json() });
        return Response.json({});
      }
      const match = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (match) {
        const threadId = match[1];
        if (!threadId) throw new Error("Missing fixture thread id");
        historyReads.push(threadId);
        return history(threadId);
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    { preconnect: () => undefined },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  core = undefined;
  sessionStorage.clear();
  inbox = EMPTY_INBOX;
  waitingSuspensions = [];
  participationPosts = [];
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function tree() {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        runtimeUrl="http://localhost/api/copilotkit"
        {...a2uiProviderOptions(false)}
      >
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="compat-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}
function cacheChannel() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}
function mounting(
  read: typeof history = async () => stored(storedTurns),
  snapshot: readonly Message[] = [],
) {
  historyReads = [];
  gatewaySnapshot = snapshot;
  decisionRequests = [];
  runRequests = [];
  stopRequests = [];
  waitingSuspensions = [];
  participationPosts = [];
  runEvents = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  history = read;
  cacheChannel();
  return render(tree());
}
function currentAgent() {
  const agent = core?.getAgent(`channel:${channel.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent;
}

describe("the existing client against a Mastra-backed history", () => {
  test("partial_text_and_tool_result_render_once", async () => {
    const view = mounting();

    await view.findByText("Retry twice, then page the on-call.");
    // Every projection of the restored turn, exactly once each: the partial sentence the Bot
    // streamed before it called, the result the runtime recorded, and the answer.
    expect(view.getAllByText("Checking the runbook.")).toHaveLength(1);
    expect(
      view.getAllByText(/Found 3 pages about the retry protocol/),
    ).toHaveLength(1);
    expect(
      view.getAllByText("Retry twice, then page the on-call."),
    ).toHaveLength(1);
    // The stored tool-call dialect was history, not damage: nothing was counted unreadable.
    expect(view.queryByText(/could not be read/)).toBeNull();
  });

  test("refresh_waiting_approval_can_resume", async () => {
    inbox = {
      enabled: true,
      requests: [
        {
          id: "approval-1",
          status: "pending",
          createdAt: "2026-10-01T00:00:01.000Z",
          action: {
            botId: "compat-bot",
            toolRef: "computer_click",
            effect: "computer.write",
            scope: "workspace",
            threadId: channel.threadId,
            toolCallId: "call-approve",
            args: { ref: "#publish" },
            target: {},
          },
        },
      ],
      rules: [],
      teamRules: [],
      questions: [],
    };
    const view = mounting(async () =>
      stored([
        userTurn,
        {
          id: "a3",
          role: "assistant",
          toolCalls: [
            {
              id: "call-approve",
              name: "computer_click",
              args: '{"ref":"#publish"}',
            },
          ],
        },
      ]),
    );

    // A run that stopped for approval comes back from refresh as a waiting card, driven by the
    // same owner-scoped inbox the Approvals page reads — not by any previous runtime's state.
    const card = await view.findByLabelText("Waiting for your approval");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const allowOnce = await view.findByRole("button", { name: "Allow once" });
    await user.click(allowOnce);

    // The decision reaches the server's durable gate; what the server does next (running the
    // action once and continuing the conversation) is ME05 and out of scope here.
    await waitFor(() => expect(decisionRequests).toHaveLength(1));
    expect(decisionRequests[0]).toMatchObject({
      id: "approval-1",
      body: { decision: "allow_once" },
    });
    expect(card).toBeTruthy();
  });

  test("stop_targets_current_run", async () => {
    const view = mounting(async () => stored([userTurn, answer]));
    await view.findByText("Retry twice, then page the on-call.");

    const agent = currentAgent();
    const stopCalls: unknown[] = [];
    const originalStop = core!.stopAgent.bind(core!);
    core!.stopAgent = ((args: Parameters<typeof originalStop>[0]) => {
      stopCalls.push(args);
      return originalStop(args);
    }) as NonNullable<typeof core>["stopAgent"];

    runEvents = openRun;
    void core!.runAgent({ agent }).catch(() => undefined);
    const stopButton = await view.findByRole("button", {
      name: "Stop the Bot",
    });
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(stopButton);

    // Stop reaches the run in flight: the core aborts the current channel agent's run and
    // tells the server which runId died, so an interrupted turn can never be confused with a
    // finished one. The targeted run is the one this test just started, not a stale instance.
    await waitFor(() => expect(stopCalls).toHaveLength(1));
    expect(runRequests).toHaveLength(1);
    const startedRunId = runRequests[0]?.input.runId;
    expect(typeof startedRunId).toBe("string");
    expect(stopCalls[0]).toMatchObject({
      agent: { agentId: `channel:${channel.id}` },
    });
    expect(stopRequests).toHaveLength(1);
    expect(stopRequests[0]).toMatchObject({ runId: startedRunId });
    expect(currentAgent()).toBe(agent);
  });

  test("reconnect_does_not_duplicate_answer", async () => {
    // The answer arrives twice on purpose — once in the gateway reconnect snapshot, once from
    // the durable history read — under the same stable id. It must render once.
    const view = mounting(async () => stored(storedTurns), [answer]);

    await view.findByText("Retry twice, then page the on-call.");
    expect(
      view.getAllByText("Retry twice, then page the on-call."),
    ).toHaveLength(1);

    // And a bot-authored turn the roster announces (the reconnect pull) re-reads the same
    // history without appending a second copy.
    await act(async () => {
      queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
        if (!cache) throw new Error("No mounted channel cache");
        const summary = cache.pages[0]?.channels[0];
        if (!summary) throw new Error("No channel in cache");
        return {
          ...cache,
          pages: [
            {
              channels: [
                {
                  ...summary,
                  lastMessage: "Retry twice, then page the on-call.",
                  lastMessageAgentId: "compat-bot",
                  lastMessageAt: "2026-10-01T00:01:00.000Z",
                },
              ],
              nextCursor: null,
            },
          ],
        };
      });
    });
    await waitFor(() => expect(historyReads.length).toBeGreaterThan(1));
    expect(
      view.getAllByText("Retry twice, then page the on-call."),
    ).toHaveLength(1);
  });

  test("incompatible_legacy_pause_has_clear_next_action", async () => {
    // A pause recorded by an earlier session (sessionStorage survives the refresh). While its
    // tool call is still unanswered the transcript says so and offers the one action.
    sessionStorage.setItem(
      "openbot:pending-handoff:compat-bot",
      JSON.stringify({ requestId: "req-7", toolCallId: "call-pending" }),
    );
    const paused = mounting(async () =>
      stored([
        userTurn,
        {
          id: "a6",
          role: "assistant",
          toolCalls: [
            {
              id: "call-pending",
              name: "computer_request_help",
              args: '{"reason":"Sign in"}',
            },
          ],
        },
      ]),
    );
    await paused.findByText("A browser task is paused in this conversation.");
    const resumeButton = paused.getByRole("button", { name: "Resume task" });
    expect((resumeButton as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    queryClient.clear();

    // The same pause when the work has meanwhile been answered: nothing may offer to run it
    // again, the stale record is dropped, and the transcript simply reads complete.
    sessionStorage.setItem(
      "openbot:pending-handoff:compat-bot",
      JSON.stringify({ requestId: "req-9", toolCallId: "call-gone" }),
    );
    const answered = mounting(async () =>
      stored([
        userTurn,
        {
          id: "a7",
          role: "assistant",
          toolCalls: [
            {
              id: "call-gone",
              name: "computer_request_help",
              args: '{"reason":"Sign in"}',
            },
          ],
        },
        {
          id: "t9",
          role: "tool",
          toolCallId: "call-gone",
          content: '{"ok":true,"title":"Signed in"}',
        },
      ]),
    );
    await answered.findByText("What is the retry protocol?");
    await waitFor(() =>
      expect(
        sessionStorage.getItem("openbot:pending-handoff:compat-bot"),
      ).toBeNull(),
    );
    expect(
      answered.queryByText("A browser task is paused in this conversation."),
    ).toBeNull();
    expect(answered.queryByRole("button", { name: "Resume task" })).toBeNull();

    // And if a stale pause were resumed anyway, the refusal is a sentence a person can act on,
    // not a silent double execution of already-accepted work.
    const answeredOnce: Message[] = [
      {
        id: "a8",
        role: "assistant",
        toolCalls: [
          {
            id: "call-answered",
            type: "function",
            function: { name: "computer_request_help", arguments: "{}" },
          },
        ],
      },
      {
        id: "t10",
        role: "tool",
        toolCallId: "call-answered",
        content: '{"ok":true}',
      },
    ];
    const agent = {
      messages: answeredOnce,
      isRunning: false,
      setMessages: () => undefined,
    };
    let refusal = "";
    try {
      await resumeHandoffTask(
        "compat-bot",
        { requestId: "req-10", toolCallId: "call-answered" },
        agent,
        async () => undefined,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : "";
    }
    expect(refusal).toBe("This tool call is already answered.");
  });
});

// ---------------------------------------------------------------------------
// ME16 (#488): the browser half of a Mastra frontend_tool suspension — the
// handler's real result reaches the participation route, or the run never
// continues.
// ---------------------------------------------------------------------------

describe("the browser answers a Mastra frontend_tool suspension", () => {
  function participationTree(onResult: (result: unknown) => unknown) {
    return (
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider
          runtimeUrl="http://localhost/api/copilotkit"
          {...a2uiProviderOptions(false)}
        >
          <CoreProbe />
          <ParticipationProbeTool onResult={onResult} />
          <ChannelChat channel={channel} runtimeAgentId="compat-bot" />
        </CopilotKitProvider>
      </QueryClientProvider>
    );
  }

  async function runProbe() {
    const agent = currentAgent();
    await core!.runAgent({ agent });
    // The tool execution's follow-up run and its renders settle here, not in
    // the next test's environment.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return agent;
  }

  test("a waiting suspension is answered with the handler's real result", async () => {
    waitingSuspensions = [
      {
        continuationId: "cont-1",
        status: "waiting",
        kind: "frontend_tool",
        toolCallId: "call-participate",
      },
    ];
    let handlerResult: unknown;
    history = async () => stored(storedTurns);
    gatewaySnapshot = [];
    cacheChannel();
    const view = render(
      participationTree((result) => {
        handlerResult = result;
        return result;
      }),
    );
    await view.findByText("Retry twice, then page the on-call.");

    runEvents = (input) => suspendedRun(input, "call-participate");
    await runProbe();

    // The browser posted the tool's real result to the participation route:
    // the reply names the suspended call and carries what the handler read.
    await waitFor(() => expect(participationPosts).toHaveLength(1));
    // Exactly once — the follow-up run that carries the result forward must
    // not answer the same suspension a second time.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(participationPosts).toHaveLength(1);
    expect(participationPosts[0]).toMatchObject({
      id: "cont-1",
      body: {
        toolCallId: "call-participate",
        result: { text: "read: the page says hello" },
      },
    });
    // And the handler's own return value still flows to the transcript —
    // answering the suspension never eats the client-side result.
    expect(handlerResult).toEqual({ text: "read: the page says hello" });
  });

  test("an approval-kind suspension is never answered with a tool result", async () => {
    waitingSuspensions = [
      {
        continuationId: "cont-approval",
        status: "waiting",
        kind: "approval",
        toolCallId: "call-participate",
      },
    ];
    history = async () => stored(storedTurns);
    gatewaySnapshot = [];
    cacheChannel();
    const view = render(participationTree(() => undefined));
    await view.findByText("Retry twice, then page the on-call.");

    runEvents = (input) => suspendedRun(input, "call-participate");
    await runProbe();

    // The waiting list was consulted, but the kind gate held: a parked
    // approval is the approvals flow's to resume.
    await waitFor(() => expect(participationPosts).toHaveLength(0));
  });

  test("nothing waiting — the legacy in-band flow answers nothing", async () => {
    waitingSuspensions = [];
    history = async () => stored(storedTurns);
    gatewaySnapshot = [];
    cacheChannel();
    const view = render(participationTree(() => undefined));
    await view.findByText("Retry twice, then page the on-call.");

    runEvents = (input) => suspendedRun(input, "call-participate");
    await runProbe();

    expect(participationPosts).toHaveLength(0);
  });
});
