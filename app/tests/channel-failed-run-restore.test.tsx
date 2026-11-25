import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupSections } from "@/components/bot-profile/setup";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";

/**
 * A conversation whose last run failed still says so after a reload.
 *
 * The failure arrives as a RUN_ERROR, an event, and the thread's stored messages hold only what was
 * said. So the red line under the person's message lived in the screen's memory: reload, or come
 * back later, and the message sat there unanswered with nothing to say why.
 *
 * The runtime keeps every run's events and replays them, run after run, when the conversation joins
 * its thread. That replay is where the failure is read back from. This fixture plays the runtime at
 * the HTTP boundary the way the runtime behaves: `/run` streams a run and records its events, and
 * `/connect` replays every recorded run back to back, as the runners do (the in-memory runner's
 * `connect`, and the Intelligence gateway's per-run replay). Everything above that boundary is the
 * real provider, the real ChannelChat and the real transcript.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "failed-run-channel",
  name: "Failed run",
  agentIds: ["failed-run-bot"],
  threadId: "failed-run-thread",
  active: true,
  lastMessageAt: "2026-11-06T00:00:00.000Z",
};
const other: AgentChannel = {
  ...channel,
  id: "other-channel",
  name: "Another conversation",
  threadId: "other-thread",
};
/** What the model provider said when it refused the key, word for word. */
const REJECTED = "invalid x-api-key";

/** How the next `/run` goes. A fresh one per test. */
type RunPlan =
  | { kind: "fails"; message: string; code?: string }
  | { kind: "calls"; tool: string }
  | { kind: "answers"; text: string }
  | { kind: "stalls"; text: string };

let originalFetch: typeof fetch;
let plans: RunPlan[] = [];
const creditQuote = {
  route: "fixture",
  priceVersion: "fixture-price-version",
  creditType: "test",
  model: "fixture-model",
  provider: "fixture-a",
  price: { inputPerMillion: 250_000, outputPerMillion: 250_000 },
  maxChargeMicrocredits: "2",
  usageDisclosure: "Interrupted or failed requests can still use Test Credits.",
};
const primary = {
  id: creditQuote.route,
  revision: "rev-a",
  model: creditQuote.model,
  provider: creditQuote.provider,
};
const alternate = {
  id: "alternate",
  revision: "rev-b",
  model: "other-model",
  provider: "fixture-b",
};
type Selection = { id: string; revision: string } | null;
let botModel: Selection = null;
let conversationModel: Selection = null;
let revoked = false;
const staleReason =
  "Saved Conversation override is no longer verified for this Harness. Choose another verified model or clear the saved selection.";
function modelState(conversation: boolean) {
  const saved = conversation ? conversationModel : botModel;
  const effective = saved ?? botModel;
  const source =
    conversation && saved ? "conversation" : botModel ? "bot" : "harness";
  const options = revoked ? [alternate] : [primary, alternate];
  const route = effective
    ? options.find(({ id }) => id === effective.id)
    : primary;
  return {
    saved,
    options,
    source,
    ...(route
      ? {
          quote: {
            ...creditQuote,
            paidAvailable: paidChatAvailable,
            route: route.id,
            model: route.model,
            provider: route.provider,
          },
        }
      : { reason: staleReason }),
  };
}
let managedChat = false;
let paidChatAvailable = false;
let requestedRuns: RunAgentInput[] = [];

/** Every event the runtime has streamed for a thread, run after run: what `/connect` replays. */
let recorded = new Map<string, unknown[]>();
/** The thread's stored messages: what was said, and nothing about how a run ended. */
let stored = new Map<string, Message[]>();
let stopRequests: string[] = [];
/** Each stop this browser asked the server for, for a run by its id. */
let serverStops: { threadId: string; runId: string }[] = [];
let stopRefused = false;
type RunRow = {
  id: string;
  status: "running" | "completed" | "failed";
  userMessageId?: string;
  assistantMessageId: null;
  stopReason?: "stopped";
};
/**
 * The thread's stored runs, as the messages read names them. Set, and every run is recorded there
 * as the server stores it and every read carries the list, so a Stop asks the server for the run.
 * Left undefined, the read names no run and a Stop aborts only this browser's copy of the run.
 */
let threadRuns: Map<string, RunRow[]> | undefined;
/** The open stream of a stalled run, for the stop that ends it. */
let stalled: {
  input: RunAgentInput;
  messageId: string;
  finish: (events: unknown[]) => void;
} | null = null;

function frames(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function sse(events: unknown[]) {
  return new NativeResponse(frames(events), {
    headers: { "content-type": "text/event-stream" },
  });
}
function record(threadId: string, events: unknown[]) {
  recorded.set(threadId, [...(recorded.get(threadId) ?? []), ...events]);
}
function remember(threadId: string, messages: Message[]) {
  const known = stored.get(threadId) ?? [];
  const ids = new Set(known.map((message) => message.id));
  stored.set(threadId, [
    ...known,
    ...messages.filter((message) => !ids.has(message.id)),
  ]);
}
/** How the run ended, as the server records it: a RUN_ERROR fails it, and a stopped run says why. */
function ended(row: RunRow, events: unknown[]) {
  const last = events.at(-1) as { type?: string; code?: string } | undefined;
  row.status = last?.type === "RUN_ERROR" ? "failed" : "completed";
  if (last?.type === "RUN_ERROR" && last.code === "stopped")
    row.stopReason = "stopped";
}
/**
 * The server stopping the run that is open, as `stopDirectChatRun` does and as the stream then
 * carries it (`stoppedRunEvent`): the run is stored as failed, with its reason, and the stream ends
 * with the RUN_ERROR the server wrote for it. From a Stop this browser asked for, or from a Stop
 * made in another tab. Whether a run was open to stop.
 */
function stopOnServer(): boolean {
  const open = stalled;
  stalled = null;
  if (!open) return false;
  const row = threadRuns
    ?.get(open.input.threadId)
    ?.find((run) => run.id === open.input.runId);
  if (row) {
    row.status = "failed";
    row.stopReason = "stopped";
  }
  open.finish([
    { type: "TEXT_MESSAGE_END", messageId: open.messageId },
    { type: "RUN_ERROR", message: "The Bot run was stopped.", code: "stopped" },
  ]);
  return true;
}

/** One run, as the runtime streams it and records it. */
function run(input: RunAgentInput): Response {
  requestedRuns.push(input);
  const plan = plans.shift();
  if (!plan) throw new Error("A run nobody planned for");
  const started = {
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  };
  // The person's message is stored whatever the run comes to.
  remember(
    input.threadId,
    input.messages.filter((message) => message.role === "user"),
  );
  // And the run is stored as going, until `ended` says how it ended.
  const row: RunRow = {
    id: input.runId,
    status: "running",
    userMessageId: input.messages.at(-1)?.id,
    assistantMessageId: null,
  };
  if (threadRuns)
    threadRuns.set(input.threadId, [
      ...(threadRuns.get(input.threadId) ?? []),
      row,
    ]);
  if (plan.kind === "calls") {
    // A step the browser carries out, as a Bot's run ends on one: the call, then RUN_FINISHED.
    const toolCallId = `call-${input.runId}`;
    const events = [
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: plan.tool,
        parentMessageId: `asks-${input.runId}`,
      },
      { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];
    record(input.threadId, events);
    ended(row, events);
    return sse(events);
  }
  if (plan.kind === "fails") {
    const events = [
      started,
      ...(plan.code === "reconciling"
        ? [
            {
              type: "CUSTOM",
              name: "openbot-test-credit-receipt",
              value: {
                operationId: "fixture-operation",
                userMessageId: input.messages.at(-1)?.id,
                state: "pending",
                heldMicrocredits: "2",
                chargedMicrocredits: null,
                releasedMicrocredits: null,
              },
            },
          ]
        : []),
      {
        type: "RUN_ERROR",
        message: plan.message,
        code: plan.code ?? "agent_error",
      },
    ];
    record(input.threadId, events);
    return sse(events);
  }
  const messageId = `reply-${input.runId}`;
  const reply = [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: plan.text },
  ];
  if (plan.kind === "answers") {
    const events = [
      started,
      ...reply,
      { type: "TEXT_MESSAGE_END", messageId },
      ...(managedChat
        ? [
            {
              type: "CUSTOM",
              name: "openbot-test-credit-receipt",
              value: {
                operationId: "settled-operation",
                userMessageId: input.messages.at(-1)?.id,
                state: "settled",
                chargedMicrocredits: "1",
                releasedMicrocredits: "1",
              },
            },
          ]
        : []),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];
    record(input.threadId, events);
    ended(row, events);
    remember(input.threadId, [
      { id: messageId, role: "assistant", content: plan.text },
    ]);
    return sse(events);
  }
  // Stalls: streams the start of an answer and waits, as a Bot still thinking does.
  const opening = [started, ...reply];
  let close: (events: unknown[]) => void = () => {
    throw new Error("Stream not started");
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(frames(opening)));
      close = (events) => {
        controller.enqueue(encoder.encode(frames(events)));
        controller.close();
      };
    },
  });
  stalled = {
    input,
    messageId,
    finish: (events) => {
      record(input.threadId, [...opening, ...events]);
      ended(row, events);
      remember(input.threadId, [
        { id: messageId, role: "assistant", content: plan.text },
      ]);
      close(events);
    },
  };
  return new NativeResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(() => {
  // At an origin, as a page is: a Stop is posted to a URL resolved against it.
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
      const request = () =>
        input instanceof Request ? input : new Request(url, init);
      if (url.pathname === "/api/capabilities")
        return NativeResponse.json({ testCreditConversations: managedChat });
      if (url.pathname.endsWith("/test-credit-model")) {
        const conversation = url.searchParams.has("threadId");
        if (request().method === "PUT") {
          const { selection } = (await request().json()) as {
            selection: Selection;
          };
          if (conversation) conversationModel = selection;
          else botModel = selection;
        }
        return NativeResponse.json(modelState(conversation));
      }
      if (url.pathname.endsWith("/test-credit-quote")) {
        const state = modelState(true);
        return "quote" in state
          ? NativeResponse.json(state.quote)
          : NativeResponse.json({ error: state.reason }, { status: 409 });
      }
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/failed-run-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/agents/failed-run-bot")
        return NativeResponse.json({
          agent: {
            id: "failed-run-bot",
            visibility: "public",
            canManage: true,
          },
        });
      if (url.pathname === "/api/components/for-agent/failed-run-bot")
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "failed-run-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) {
        const body = (await request().json()) as { threadId?: string };
        const threadId = body.threadId ?? "";
        const events = recorded.get(threadId) ?? [];
        if (!managedChat) return sse(events);
        const receipt = events.findLast(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "name" in event &&
            event.name === "openbot-test-credit-receipt",
        );
        const snapshot = {
          type: "MESSAGES_SNAPSHOT",
          messages: stored.get(threadId) ?? [],
        };
        return sse(receipt ? [snapshot, receipt] : [snapshot]);
      }
      if (url.pathname.endsWith("/run"))
        return run(RunAgentInputSchema.parse(await request().json()));
      /*
       * A stop, as the runtime carries it out: the runner closes what the run left open and ends it
       * with RUN_FINISHED, outcome cancelled, never a RUN_ERROR (`finalizeRunEvents` in
       * @copilotkit/shared, with `stopRequested`).
       */
      const stop = url.pathname.match(/\/agent\/[^/]+\/stop\/([^/]+)$/);
      if (stop) {
        stopRequests.push(decodeURIComponent(stop[1] ?? ""));
        const open = stalled;
        stalled = null;
        open?.finish([
          { type: "TEXT_MESSAGE_END", messageId: open.messageId },
          {
            type: "RUN_FINISHED",
            threadId: open.input.threadId,
            runId: open.input.runId,
            outcome: { type: "cancelled" },
          },
        ]);
        return NativeResponse.json({ stopped: true });
      }
      /*
       * The server's own stop, as `stopDirectChatRun` carries it out on a thread's stored run: only
       * a run still going is stopped, and only that is confirmed.
       */
      const serverStop = url.pathname.match(
        /\/threads\/([^/]+)\/runs\/([^/]+)\/stop$/,
      );
      if (serverStop) {
        serverStops.push({
          threadId: decodeURIComponent(serverStop[1] ?? ""),
          runId: decodeURIComponent(serverStop[2] ?? ""),
        });
        if (stopRefused)
          return NativeResponse.json(
            { error: "The run could not be stopped." },
            { status: 500 },
          );
        return NativeResponse.json({ stopped: stopOnServer() });
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      const thread = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (thread) {
        const threadId = decodeURIComponent(thread[1] ?? "");
        return NativeResponse.json({
          messages: stored.get(threadId) ?? [],
          ...(threadRuns ? { runs: threadRuns.get(threadId) ?? [] } : {}),
        });
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  plans = [];
  managedChat = false;
  paidChatAvailable = false;
  botModel = null;
  conversationModel = null;
  revoked = false;
  requestedRuns = [];
  recorded = new Map();
  stored = new Map();
  stopRequests = [];
  serverStops = [];
  stopRefused = false;
  threadRuns = undefined;
  stalled = null;
  stepsRun = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A step the browser answers, as the computer's tools are: it runs here and the turn goes on. */
const STEP = "fixture_step";
let stepsRun = 0;
function BrowserStep() {
  useFrontendTool({
    name: STEP,
    description: "A step the browser carries out.",
    handler: async () => {
      stepsRun += 1;
      return { ok: false, reason: "The button is not on the page any more." };
    },
  });
  return null;
}

function conversation(selected: AgentChannel) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <BrowserStep />
        {/* Keyed as the channel route keys it, so another conversation is a fresh mount. */}
        <ChannelChat
          channel={selected}
          key={selected.id}
          runtimeAgentId="failed-run-bot"
        />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}
/** A page load: a fresh provider, so nothing is carried over from the last one but the server. */
function open(selected = channel) {
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [
      {
        channels: [channel, other].map((row) => ({
          ...row,
          summary: null,
          lastMessage: null,
          lastMessageAgentId: null,
          createdAt: "2026-11-06T00:00:00.000Z",
          pinned: false,
          lastReadAt: null,
        })),
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return render(conversation(selected));
}
async function send(view: ReturnType<typeof open>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  if (box.textContent) await user.clear(box);
  await user.type(box, text);
  await user.click(await view.findByRole("button", { name: "Send message" }));
  return user;
}
/** Settled: the history is in and the composer is open again. */
async function settled(view: ReturnType<typeof open>, said: string) {
  await view.findByText(said);
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
}

test.each(["a reload", "coming back from another conversation"])(
  "a conversation whose last run failed shows that failure again after %s, as it did live",
  async (how) => {
    plans = [{ kind: "fails", message: REJECTED }];
    const live = open();
    await send(live, "Summarise my inbox");
    const shown = await live.findByTestId("transcript-stopped");
    expect(shown.textContent).toBe(REJECTED);
    const liveMarkup = shown.outerHTML;

    let back: ReturnType<typeof open>;
    if (how === "a reload") {
      live.unmount();
      back = open();
    } else {
      live.rerender(conversation(other));
      await waitFor(() =>
        expect(live.queryByTestId("transcript-stopped")).toBeNull(),
      );
      live.rerender(conversation(channel));
      back = live;
    }
    await settled(back, "Summarise my inbox");
    const restored = await back.findByTestId("transcript-stopped");
    // In its own words, in the same place, drawn the same way.
    expect(restored.textContent).toBe(REJECTED);
    expect(restored.outerHTML).toBe(liveMarkup);
  },
);

test("a failure that a later run answered is not shown after a reload", async () => {
  plans = [
    { kind: "fails", message: REJECTED },
    { kind: "answers", text: "Here is your inbox summary." },
  ];
  const live = open();
  await send(live, "Summarise my inbox");
  await live.findByTestId("transcript-stopped");
  await send(live, "Try again");
  await live.findByText("Here is your inbox summary.");
  expect(live.queryByTestId("transcript-stopped")).toBeNull();

  live.unmount();
  const back = open();
  await settled(back, "Here is your inbox summary.");
  // The replay has to be all the way in before its silence means anything.
  await waitFor(() => expect(back.queryByText("Try again")).not.toBeNull());
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
  expect(back.queryByText(REJECTED)).toBeNull();
});

test("a run the person stopped is not shown as a failure, live or after a reload", async () => {
  plans = [{ kind: "stalls", text: "Reading your inbox" }];
  const live = open();
  const user = await send(live, "Summarise my inbox");
  await live.findByText("Reading your inbox");
  await user.click(await live.findByRole("button", { name: "Stop the Bot" }));
  await waitFor(() => expect(stopRequests).toEqual([channel.threadId]));
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(live.queryByTestId("transcript-stopped")).toBeNull();

  live.unmount();
  const back = open();
  await settled(back, "Summarise my inbox");
  await back.findByText("Reading your inbox");
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
});

/*
 * The replay also carries a run the server stopped at the person's request, as a RUN_ERROR with its
 * reason (`stoppedRunEvent` in direct-chat-replay.ts). Read as a failure, it drew "The Bot run was
 * stopped." in red after every reload, under the plain notice that says the run was stopped.
 */
test("a run the server stopped at the person's request is not shown as a failure, live or after a reload", async () => {
  plans = [
    { kind: "fails", message: "The Bot run was stopped.", code: "stopped" },
  ];
  const live = open();
  await send(live, "Summarise my inbox");
  await settled(live, "Summarise my inbox");
  expect(live.queryByTestId("transcript-stopped")).toBeNull();

  live.unmount();
  const back = open();
  await settled(back, "Summarise my inbox");
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
  expect(back.queryByText("The Bot run was stopped.")).toBeNull();
});

/*
 * THE PERSON'S OWN STOP IS NOT A FAILURE. The server ends a run it stopped with a RUN_ERROR, and
 * the live handler read every RUN_ERROR as one: "The Bot run was stopped." in red under the
 * conversation, the message put back in the box, and the plain "The run was stopped." beside them.
 * As on `/bot`, the words stay sent and only the notice says what happened, from the read that
 * follows the turn.
 */
test("a Stop pressed in the conversation is not shown as a failure, and the notice says the run was stopped", async () => {
  threadRuns = new Map();
  plans = [{ kind: "stalls", text: "Reading your inbox" }];
  const live = open();
  const user = await send(live, "Summarise my inbox");
  await live.findByText("Reading your inbox");
  await user.click(await live.findByRole("button", { name: "Stop the Bot" }));

  // The run this tab started, stopped on the server.
  await waitFor(() =>
    expect(serverStops).toEqual([
      {
        threadId: channel.threadId,
        runId: threadRuns?.get(channel.threadId)?.[0]?.id,
      },
    ]),
  );
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(live.queryByTestId("transcript-stopped")).toBeNull();
  // The words stay sent: the box is empty, and the message is on screen once.
  expect(live.getByRole("textbox", { name: "Message" }).textContent).toBe("");
  expect(live.getAllByText("Summarise my inbox")).toHaveLength(1);
  expect(
    await live.findByText("The run was stopped.", {
      selector: "[role=status]",
    }),
  ).toBeTruthy();
});

test("a run stopped in another tab while this one watches its turn is not shown as a failure either", async () => {
  threadRuns = new Map();
  plans = [{ kind: "stalls", text: "Reading your inbox" }];
  const live = open();
  await send(live, "Summarise my inbox");
  await live.findByText("Reading your inbox");
  // The same person presses Stop in another tab: the server stops the run, and this stream ends.
  expect(stopOnServer()).toBe(true);

  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(live.queryByTestId("transcript-stopped")).toBeNull();
  expect(live.getByRole("textbox", { name: "Message" }).textContent).toBe("");
  // Nothing is said at the moment. The thread is read again when the turn ends, and that read
  // brings the notice: nothing else here asks for it.
  expect(
    await live.findByText("The run was stopped.", {
      selector: "[role=status]",
    }),
  ).toBeTruthy();
});

test("a turn that fails in a run after its browser steps says so, as one that fails at once does", async () => {
  // The Bot works through browser steps, each answered here and sent back in a run of its own, and
  // the run after the last of them fails. That turn used to end on its steps with nothing said.
  const OUT_OF_TIME = "The Claude query timed out after 300s.";
  plans = [
    { kind: "calls", tool: STEP },
    { kind: "calls", tool: STEP },
    { kind: "fails", message: OUT_OF_TIME },
  ];
  const live = open();
  await send(live, "Sign me up on the garden form");
  const shown = await live.findByTestId("transcript-stopped");
  expect(shown.textContent).toBe(OUT_OF_TIME);
  expect(stepsRun).toBe(2);
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
});

test("a managed turn confirms its quote before sending and retries an uncertain turn with the same message ID", async () => {
  managedChat = true;
  plans = [
    {
      kind: "fails",
      message: "The model outcome is being reconciled.",
      code: "reconciling",
    },
    { kind: "answers", text: "Recovered answer" },
  ];
  const view = open();
  expect(
    (await view.findByRole("combobox", { name: "Conversation model" }))
      .textContent,
  ).toContain("Administrator default · fixture-a/fixture-model");
  const user = await send(view, "Bill this turn");
  const confirm = await view.findByRole("button", { name: "Confirm and send" });
  expect(
    view.getByText("fixture-a/fixture-model · Bifrost route fixture"),
  ).toBeTruthy();
  expect(view.getByText("Maximum reservation 2 microcredits.")).toBeTruthy();
  expect(
    view.getByText(
      "Input 250000 and output 250000 microcredits per million tokens.",
    ),
  ).toBeTruthy();
  expect(view.getByText(creditQuote.usageDisclosure)).toBeTruthy();
  expect(requestedRuns).toHaveLength(0);
  await user.click(confirm);
  await view.findByText(
    "Test Credits · Pending reconciliation · 2 microcredits held",
  );
  view.unmount();
  const reopened = open();
  await user.click(
    await reopened.findByRole("button", { name: "Check again" }),
  );
  expect(
    reopened.queryByRole("button", { name: "Confirm and send" }),
  ).toBeNull();
  await settled(reopened, "Recovered answer");
  expect(
    reopened.getByText(
      "Test Credits · Settled · 1 microcredit charged · 1 microcredit released",
    ),
  ).toBeTruthy();
  expect(requestedRuns).toHaveLength(2);
  expect(requestedRuns[0]?.forwardedProps).toMatchObject({
    testCreditQuote: {
      route: creditQuote.route,
      priceVersion: creditQuote.priceVersion,
    },
  });
  expect(requestedRuns[1]?.messages.at(-1)?.id).toBe(
    requestedRuns[0]?.messages.at(-1)?.id,
  );
});

test("a signed paid Conversation sends the credit type the user confirmed", async () => {
  managedChat = true;
  paidChatAvailable = true;
  plans = [{ kind: "answers", text: "Paid reply" }];
  const view = open();
  const user = await send(view, "Paid turn");
  await user.click(await view.findByRole("radio", { name: "Paid Credits" }));
  expect(view.getByText("Send using Paid Credits?")).toBeTruthy();
  expect(requestedRuns).toHaveLength(0);
  await user.click(view.getByRole("button", { name: "Confirm and send" }));
  await settled(view, "Paid reply");
  expect(requestedRuns[0]?.forwardedProps).toMatchObject({
    testCreditQuote: {
      route: creditQuote.route,
      priceVersion: creditQuote.priceVersion,
      creditType: "paid",
    },
  });
});

test("an explicit managed rerun confirms a fresh reservation linked to the original message", async () => {
  managedChat = true;
  plans = [
    {
      kind: "fails",
      code: "reconciling",
      message: "The model outcome is being reconciled.",
    },
    { kind: "answers", text: "New answer" },
  ];
  const view = open();
  const user = await send(view, "Run this again");
  await user.click(
    await view.findByRole("button", { name: "Confirm and send" }),
  );
  await user.click(await view.findByRole("button", { name: "Run again" }));
  const confirm = await view.findByRole("button", {
    name: "Confirm and rerun",
  });
  expect(view.getByText(creditQuote.usageDisclosure)).toBeTruthy();
  expect(requestedRuns).toHaveLength(1);
  await user.click(confirm);
  await settled(view, "New answer");
  expect(requestedRuns).toHaveLength(2);
  const original = requestedRuns[0]?.messages.at(-1)?.id;
  expect(requestedRuns[1]?.messages.at(-1)?.id).not.toBe(original);
  expect(requestedRuns[1]?.forwardedProps).toMatchObject({
    rerunOfMessageId: original,
    testCreditQuote: {
      route: creditQuote.route,
      priceVersion: creditQuote.priceVersion,
    },
  });
});

test("Bot Setup and the Conversation picker show the effective route and let a person replace a stale override", async () => {
  managedChat = true;
  const setup = render(
    <QueryClientProvider client={queryClient}>
      <SetupSections
        agent={{
          id: "failed-run-bot",
          name: "Fixture",
          title: "Bot",
          roleDescription: "Answers questions.",
          avatarSeed: "fixture",
          visibility: "private",
          endpoint: null,
          builtIn: true,
          hasAuth: false,
          hasCallbackToken: false,
          hidden: false,
          pinned: false,
          systemOwned: false,
          canManage: true,
          mine: true,
          isolated: false,
          isolationActive: false,
          isolationOffReason: null,
        }}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: setup.container.ownerDocument });
  await user.click(
    await setup.findByRole("combobox", { name: "Bot default model" }),
  );
  await setup.findByRole("option", { name: "fixture-b/other-model" });
  await user.keyboard("{End}{Enter}");
  await waitFor(() =>
    expect(botModel).toEqual({
      id: alternate.id,
      revision: alternate.revision,
    }),
  );
  setup.unmount();

  plans = [
    { kind: "answers", text: "Bot default answer" },
    { kind: "answers", text: "Conversation override answer" },
  ];
  const view = open();
  expect(
    (await view.findByRole("combobox", { name: "Conversation model" }))
      .textContent,
  ).toContain("Bot default · fixture-b/other-model");
  await send(view, "Use the Bot default");
  expect(
    await view.findByText("fixture-b/other-model · Bifrost route alternate"),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Confirm and send" }));
  await settled(view, "Bot default answer");

  await user.click(view.getByRole("combobox", { name: "Conversation model" }));
  await view.findByRole("option", { name: "fixture-a/fixture-model" });
  await user.keyboard("{Home}{ArrowDown}{Enter}");
  await waitFor(() =>
    expect(conversationModel).toEqual({
      id: primary.id,
      revision: primary.revision,
    }),
  );
  await view.findByRole("button", { name: "Send message" });
  await send(view, "Use the Conversation override");
  expect(
    await view.findByText("fixture-a/fixture-model · Bifrost route fixture"),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Confirm and send" }));
  await settled(view, "Conversation override answer");

  revoked = true;
  await view.findByRole("button", { name: "Send message" });
  await send(view, "Keep this draft");
  expect(await view.findByText(staleReason)).toBeTruthy();
  expect(requestedRuns).toHaveLength(2);
  expect(view.queryByRole("button", { name: "Confirm and send" })).toBeNull();
  await user.click(view.getByRole("combobox", { name: "Conversation model" }));
  await view.findByRole("option", { name: "Use Bot or administrator default" });
  await user.keyboard("{Home}{Enter}");
  await waitFor(() =>
    expect(
      view.getByRole("combobox", { name: "Conversation model" }).textContent,
    ).toContain("Bot default · fixture-b/other-model"),
  );
  expect(conversationModel).toBeNull();
  expect(
    requestedRuns.map((run) => run.forwardedProps?.testCreditQuote),
  ).toEqual([
    { route: alternate.id, priceVersion: creditQuote.priceVersion },
    { route: primary.id, priceVersion: creditQuote.priceVersion },
  ]);
});
