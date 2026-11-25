import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { botThreadKey } from "@/lib/copilot/bot-thread";
import {
  agent,
  answerWith,
  botRuntime,
  currentJoin,
  queryClientWithAgents,
  releaseRun,
  renderBot,
  type RunPlan,
  runtime,
} from "./bot-route-default-agent.fixture";

botRuntime();

/*
 * What `/bot` does with a thread, drawn with its real chat and a runtime stand-in (see the fixture):
 * a new chat, a reply as it arrives, a tool card's state, a turn that fails, and a thread reopened
 * with something still waiting for the person.
 */

const BOT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});
const ROUTE = "/bot?agent=general-assistant";
/** What the model provider said when it refused the key, word for word. */
const REJECTED = "invalid x-api-key";

function open() {
  return renderBot(queryClientWithAgents([BOT]), ROUTE);
}

async function send(
  view: ReturnType<typeof open>,
  text: string,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "Message" }), text);
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  return user;
}

/** Settled: the Bot has finished and the composer offers Send again. */
async function settled(view: ReturnType<typeof open>) {
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  await view.findByRole("button", { name: "Send message" });
}

/** Waits for the Bot to have said `text`, wherever the transcript has split the words. */
const said = (view: ReturnType<typeof open>, text: string) =>
  view.findByText(text, { exact: false });

test("what has arrived can be read while the Bot is still replying", async () => {
  runtime.plans = [
    {
      kind: "holds",
      events: [
        { type: "TEXT_MESSAGE_START", messageId: "partial", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "partial",
          delta: "It is 9:05",
        },
      ],
    },
  ];
  const view = open();
  const user = await send(view, "What time is it?");

  await said(view, "It is 9:05");
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();

  expect(view.queryByRole("button", { name: "Copy reply" })).toBeNull();

  releaseRun([
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "partial",
      delta: " in the morning.",
    },
    { type: "TEXT_MESSAGE_END", messageId: "partial" },
    { type: "RUN_FINISHED", threadId: currentJoin().threadId, runId: "run-1" },
  ]);
  await said(view, "It is 9:05 in the morning.");
  await settled(view);
  await user.click(view.getByRole("button", { name: "Copy reply" }));
  expect(
    await view.container.ownerDocument.defaultView?.navigator.clipboard.readText(),
  ).toBe("It is 9:05 in the morning.");
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

test("a tool card says the tool is running, and then what it found, as a Conversation's does", async () => {
  runtime.plans = [
    {
      kind: "holds",
      events: [
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "fixture_lookup",
          parentMessageId: "asks-1",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ],
    },
  ];
  const view = open();
  await send(view, "Find the plan");

  await waitFor(() =>
    expect(view.container.querySelector(".tool-line-running")).toBeTruthy(),
  );
  expect(view.queryByText("Found 3 files")).toBeNull();

  releaseRun([
    {
      type: "TOOL_CALL_RESULT",
      messageId: "result-1",
      toolCallId: "call-1",
      content: "Found 3 files",
    },
    { type: "RUN_FINISHED", threadId: currentJoin().threadId, runId: "run-2" },
  ]);
  await view.findByText("Found 3 files");
  await settled(view);
  expect(view.container.querySelector(".tool-line-running")).toBeNull();
});

test("a turn that fails says so under the transcript, keeps what was said, and still says so on return", async () => {
  runtime.plans = [
    { kind: "answers", text: "Here is yesterday's plan." },
    { kind: "fails", message: REJECTED },
  ];
  const live = open();
  await send(live, "Plan my week");
  await said(live, "Here is yesterday's plan.");
  await settled(live);
  await send(live, "And today");
  const shown = await live.findByTestId("transcript-stopped");
  expect(shown.textContent).toBe(REJECTED);
  expect(await said(live, "Here is yesterday's plan.")).toBeTruthy();
  // The turn that failed leaves the person's words in the transcript and puts them back in the box.
  expect(live.getAllByText("And today").length).toBeGreaterThan(0);
  expect(live.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "And today",
  );
  const threadId = currentJoin().threadId;

  live.unmount();
  const back = open();
  const restored = await back.findByTestId("transcript-stopped");
  expect(restored.textContent).toBe(REJECTED);
  expect(await said(back, "Here is yesterday's plan.")).toBeTruthy();
  expect(currentJoin().threadId).toBe(threadId);
});

test("a failure that a later turn answered is not shown on return", async () => {
  runtime.plans = [
    { kind: "fails", message: REJECTED },
    { kind: "answers", text: "Here is today's plan." },
  ];
  const live = open();
  await send(live, "Plan my week");
  await live.findByTestId("transcript-stopped");
  await send(live, "Try again");
  await said(live, "Here is today's plan.");
  await settled(live);

  live.unmount();
  const back = open();
  await settled(back);
  // The replay has to be all the way in before its silence means anything.
  await said(back, "Try again");
  await said(back, "Here is today's plan.");
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
  expect(back.queryByText(REJECTED)).toBeNull();
});

test("a send the backend refuses leaves the words in the box and says why", async () => {
  runtime.plans = [{ kind: "refuses" }];
  const view = open();
  await send(view, "Anyone there?");

  // In the runtime's own words, as a Conversation shows the same failure.
  const shown = await view.findByTestId("transcript-stopped");
  expect(shown.textContent).toContain("503");
  await settled(view);
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "Anyone there?",
  );
  expect(runtime.runs).toHaveLength(1);
});

test("a new chat starts with an empty transcript", async () => {
  runtime.plans = [{ kind: "answers", text: "Here is yesterday's plan." }];
  const view = open();
  await send(view, "Plan my week");
  await said(view, "Here is yesterday's plan.");
  await settled(view);
  const first = currentJoin().threadId;

  fireEvent.click(view.getByRole("button", { name: "New chat with this Bot" }));
  fireEvent.click(
    await view.findByRole("button", { name: "Start new conversation" }),
  );
  await view.findByRole("button", { name: "Send message" });
  await waitFor(() => expect(currentJoin().threadId).not.toBe(first));
  expect(view.queryByText("Here is yesterday's plan.")).toBeNull();
  expect(view.queryByText("Plan my week")).toBeNull();
});

/** A turn that called an app's tool OpenBot asks about, and has no answer yet. */
const CALL = "call-invite";
const THREAD = "thread-remembered";
const asked: Message[] = [
  {
    id: "u1",
    role: "user",
    content: "Invite sam@example.com to Spec review on Friday at 10.",
  },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: CALL,
        type: "function",
        function: {
          name: "mcp__arcade-GoogleCalendar__CreateEvent",
          arguments: JSON.stringify({
            summary: "Spec review",
            attendee_emails: ["sam@example.com"],
          }),
        },
      },
    ],
  },
];

test("a thread reopened with an approval still waiting shows it, and answering it posts one decision", async () => {
  runtime.stored.set(THREAD, asked);
  runtime.inbox = [
    {
      id: "approval-1",
      status: "pending",
      createdAt: "2026-11-05T10:00:00.000Z",
      action: {
        botId: BOT.id,
        toolRef: "arcade-GoogleCalendar/CreateEvent",
        effect: "write",
        scope: "arcade-GoogleCalendar",
        threadId: THREAD,
        toolCallId: CALL,
        args: { summary: "Spec review" },
        target: {},
        policy: {
          behaviour: "ask",
          source: "safety",
          reason: "Sending something to other people asks you first.",
          kind: "sending",
        },
      },
    },
  ];
  // The thread this browser remembered for the Bot, as `useBotThread` leaves it.
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  const view = open();

  expect(
    await view.findByText(
      "Invite sam@example.com to Spec review on Friday at 10.",
    ),
  ).toBeTruthy();
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(
    card.getByText("Sending something to other people asks you first."),
  ).toBeTruthy();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(card.getByRole("radio", { name: "Allow once" }));
  await user.click(card.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(runtime.decisions).toEqual([
      { id: "approval-1", decision: { decision: "allow_once" } },
    ]),
  );
  // The card folds into the answer it was given.
  expect((await card.findAllByText("Allowed once")).length).toBeGreaterThan(0);
  // The server continues the original run from that decision; this browser starts none of its own.
  expect(runtime.runs).toHaveLength(0);
});

/** A message read that fails says so, keeps the words typed before it, and comes back in place. */
test("a history read that fails is shown, keeps the draft, and recovers in place", async () => {
  let failReads = true;
  answerWith((url) =>
    url.pathname.endsWith("/messages") && failReads
      ? new Response(null, { status: 503 })
      : undefined,
  );
  const view = open();
  await view.findByText("Couldn't load earlier messages.");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = view.getByRole("textbox", { name: "Message" });
  await user.type(box, "Keep these words");

  // The backend answers again: the notice goes and nothing typed was lost.
  failReads = false;
  await user.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(view.queryByText("Couldn't load earlier messages.")).toBeNull(),
  );
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "Keep these words",
  );
});

/*
 * A READ THAT LANDS WHILE THE BOT IS REPLYING MERGES NOTHING, because the live stream owns the
 * transcript until it ends. With no read after the turn, the earlier messages a failed opening read
 * had left out never arrived, short of reopening the chat. The read after the turn brings them.
 */
test("earlier messages that could not be loaded arrive after the next reply, without reopening the chat", async () => {
  const THREAD = "thread-late";
  const earlier: Message[] = [
    { id: "u-early", role: "user", content: "What did we decide?" },
    { id: "a-early", role: "assistant", content: "To ship on Friday." },
  ];
  runtime.stored.set(THREAD, earlier);
  // The server names a thread's runs in every read, as this one does for a run that answered.
  runtime.threadRuns.set(THREAD, [
    {
      id: "run-early",
      status: "completed",
      userMessageId: "u-early",
      assistantMessageId: "a-early",
    },
  ]);
  let failReads = true;
  answerWith((url) =>
    url.pathname.endsWith("/messages") && failReads
      ? new Response(null, { status: 503 })
      : undefined,
  );
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  runtime.plans = [HOLDING];
  const view = open();
  await view.findByText("Couldn't load earlier messages.");

  await send(view, "And Saturday?");
  // Try again while the Bot is replying: the read succeeds and the notice goes, but the reply
  // still owns the transcript, so the earlier messages are not merged into it.
  failReads = false;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(view.queryByText("Couldn't load earlier messages.")).toBeNull(),
  );
  expect(view.queryByText("To ship on Friday.")).toBeNull();

  releaseRun([
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "partial",
      delta: "Saturday is free.",
    },
    { type: "TEXT_MESSAGE_END", messageId: "partial" },
    { type: "RUN_FINISHED", threadId: THREAD, runId: "run-late" },
  ]);
  await said(view, "Saturday is free.");
  await settled(view);
  // The thread is read once the turn ends, answered or not, and what was missing is on screen.
  expect(await view.findByText("What did we decide?")).toBeTruthy();
  expect(view.getByText("To ship on Friday.")).toBeTruthy();
  expect(view.getByText("Saturday is free.")).toBeTruthy();
});

/**
 * The approval in a thread kept for this Bot, as the inbox holds it at whatever status it reached.
 * It names the tool call the transcript still shows unanswered, so the step shimmers while the
 * server carries the turn on.
 */
function approvedInbox(status: "approved" | "completed", threadId: string) {
  return [
    {
      id: "approval-1",
      status,
      createdAt: "2026-11-05T10:00:00.000Z",
      // Just now: the server carries a turn on for ten minutes after a decision.
      decidedAt: new Date().toISOString(),
      action: {
        botId: BOT.id,
        toolRef: "arcade-GoogleCalendar/CreateEvent",
        effect: "write",
        scope: "arcade-GoogleCalendar",
        threadId,
        toolCallId: CALL,
        args: { summary: "Spec review" },
        target: {},
        policy: {
          behaviour: "ask",
          source: "safety",
          reason: "Sending something to other people asks you first.",
          kind: "sending",
        },
      },
    },
  ];
}

test("after a decision, the Bot working on the server shows here and its reply arrives without reopening", async () => {
  const THREAD = "thread-remembered";
  runtime.stored.set(THREAD, asked);
  runtime.inbox = approvedInbox("approved", THREAD);
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  const client = queryClientWithAgents([BOT]);
  const view = renderBot(client, ROUTE);
  expect(
    await view.findByText(
      "Invite sam@example.com to Spec review on Friday at 10.",
    ),
  ).toBeTruthy();

  // The server has the turn: the step it is on shimmers, and this tab has no run to stop.
  await waitFor(() =>
    expect(view.container.querySelector(".tool-line-running")).toBeTruthy(),
  );
  expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull();

  // It ended and wrote the reply. Read when it did, without opening the conversation again.
  const reply = {
    id: "reply-1",
    role: "assistant",
    content: "Invited sam@example.com to the Spec review.",
  } satisfies Message;
  runtime.stored.set(THREAD, [
    ...asked,
    { id: "result-1", role: "tool", toolCallId: CALL, content: "sent" },
    reply,
  ]);
  runtime.inbox = approvedInbox("completed", THREAD);
  await act(() => client.invalidateQueries({ queryKey: ["approvals"] }));
  // The reply draws the address as its own element, so the sentence is read off the transcript.
  await waitFor(() =>
    expect(view.container.textContent).toContain(reply.content),
  );
  await waitFor(() =>
    expect(view.container.querySelector(".tool-line-running")).toBeNull(),
  );
});

test("access to the thread ending hides what was read and offers the way back", async () => {
  const THREAD = "thread-remembered";
  runtime.stored.set(THREAD, asked);
  runtime.inbox = approvedInbox("approved", THREAD);
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  let denyReads = false;
  answerWith((url) =>
    url.pathname.endsWith("/messages") && denyReads
      ? new Response(null, { status: 403 })
      : undefined,
  );
  const client = queryClientWithAgents([BOT]);
  const view = renderBot(client, ROUTE);
  expect(
    await view.findByText(
      "Invite sam@example.com to Spec review on Friday at 10.",
    ),
  ).toBeTruthy();

  denyReads = true;
  runtime.inbox = approvedInbox("completed", THREAD);
  await act(() => client.invalidateQueries({ queryKey: ["approvals"] }));
  expect(await view.findByRole("link", { name: "Back to Home" })).toBeTruthy();
  expect(view.getByText("Conversation access ended.")).toBeTruthy();
  expect(
    view.queryByText("Invite sam@example.com to Spec review on Friday at 10."),
  ).toBeNull();
});

/** A turn the Bot takes its time over, so Stop has a run to reach. */
const HOLDING: RunPlan = {
  kind: "holds",
  events: [
    { type: "TEXT_MESSAGE_START", messageId: "partial", role: "assistant" },
  ],
};

/** A run the server holds for this tab's turn, as the messages read names it. */
const liveRun = (id: string) => ({
  id,
  status: "running",
  userMessageId: `u-${id}`,
  assistantMessageId: null,
});

/** Press Stop the Bot, once the run is on the wire and there is one to reach. */
async function pressStop(view: ReturnType<typeof open>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Stop the Bot" }));
}

/*
 * Stop reaches the run the person is watching. A `/bot` thread is read when the chat opens, and
 * that read said nothing about the run started after it: Stop only aborted this browser's copy, said
 * "The run was stopped." while the Bot went on working, and the next send was refused. So the thread
 * is read again when Stop is pressed, and the run that read names is the one stopped, as a
 * conversation with one Bot does. Only the server's own word says the run was stopped.
 */
test("Stop the Bot stops the run this tab started, and the server's word says it was stopped", async () => {
  runtime.plans = [HOLDING];
  const view = open();
  await send(view, "Take your time");
  // The server holds this tab's run from the moment its request arrives.
  const { threadId } = currentJoin();
  runtime.threadRuns.set(threadId, [liveRun("run-live")]);
  await pressStop(view);

  await waitFor(() =>
    expect(runtime.stops).toEqual([{ threadId, runId: "run-live" }]),
  );
  expect(await view.findByText("The run was stopped.")).toBeTruthy();
  // As the server ends a run it stopped: a RUN_ERROR that is not a failure to the person who asked.
  releaseRun([
    { type: "RUN_ERROR", message: "The Bot run was stopped.", code: "stopped" },
  ]);
  await settled(view);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.getByText("The run was stopped.")).toBeTruthy();
});

test("a run that was going when the chat opened, and has ended since, is not the one Stop posts", async () => {
  const THREAD = "thread-stale";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  runtime.threadRuns.set(THREAD, [liveRun("run-old")]);
  runtime.plans = [HOLDING];
  const view = open();
  await waitFor(() => expect(runtime.reads).toEqual([THREAD]));
  await send(view, "Take your time");
  // The older run answered; the one going now is this tab's.
  runtime.threadRuns.set(THREAD, [
    {
      id: "run-old",
      status: "completed",
      userMessageId: "u-run-old",
      assistantMessageId: "a-run-old",
    },
    liveRun("run-live"),
  ]);
  await pressStop(view);

  await waitFor(() =>
    expect(runtime.stops).toEqual([{ threadId: THREAD, runId: "run-live" }]),
  );
});

test("a stop the server did not make lets this browser's end of the turn go, and says nothing was stopped", async () => {
  const THREAD = "thread-ended";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  // The read that opened the chat found a run going. It ended before Stop was pressed.
  runtime.threadRuns.set(THREAD, [liveRun("run-old")]);
  runtime.plans = [HOLDING];
  const view = open();
  await waitFor(() => expect(runtime.reads).toEqual([THREAD]));
  await send(view, "Take your time");
  // The server confirms only a run still going: this one is over, so it stopped nothing.
  runtime.stopAnswer = "ended";
  await pressStop(view);

  await waitFor(() =>
    expect(runtime.stops).toEqual([{ threadId: THREAD, runId: "run-old" }]),
  );
  await waitFor(() => expect(runtime.aborts).toEqual([THREAD]));
  await settled(view);
  expect(view.queryByText("The run was stopped.")).toBeNull();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

/*
 * A REFUSED STOP STOPS NOTHING. It used to abort this browser's copy of the run as well, so the Bot
 * went on working on the server while its reply stopped arriving here, and Stop went with the run:
 * "Try again" pointed at a button that was no longer there. Only a run that had already ended is
 * let go here. After a refusal the run keeps streaming and Stop stays for another press, and a
 * press the server then confirms replaces the refusal with what it says.
 */
test("a stop the server refuses leaves the run going here, with Stop to press again, and a later stop that is confirmed says so", async () => {
  runtime.plans = [HOLDING];
  const view = open();
  await send(view, "Take your time");
  const { threadId } = currentJoin();
  runtime.threadRuns.set(threadId, [liveRun("run-live")]);
  runtime.stopAnswer = "refused";
  await pressStop(view);

  const refused = "The Bot couldn't be stopped. Try again.";
  expect(await view.findByText(refused)).toBeTruthy();
  // Nothing was stopped: this browser's copy of the run was not ended.
  expect(runtime.aborts).toEqual([]);
  await view.findByRole("button", { name: "Stop the Bot" });

  runtime.stopAnswer = "confirms";
  await pressStop(view);
  await waitFor(() =>
    expect(runtime.stops).toEqual([
      { threadId, runId: "run-live" },
      { threadId, runId: "run-live" },
    ]),
  );
  expect(await view.findByText("The run was stopped.")).toBeTruthy();
  expect(view.queryByText(refused)).toBeNull();
  expect(runtime.aborts).toEqual([]);
  releaseRun([
    { type: "RUN_ERROR", message: "The Bot run was stopped.", code: "stopped" },
  ]);
  await settled(view);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

test("a failure after a stop the server refused is still a failure", async () => {
  runtime.plans = [HOLDING];
  const view = open();
  await send(view, "Take your time");
  const { threadId } = currentJoin();
  runtime.threadRuns.set(threadId, [liveRun("run-live")]);
  runtime.stopAnswer = "refused";
  await pressStop(view);
  const refused = "The Bot couldn't be stopped. Try again.";
  expect(await view.findByText(refused)).toBeTruthy();
  await view.findByRole("button", { name: "Stop the Bot" });

  // The run then fails on its own. Nobody stopped it, so it fails like any other run.
  releaseRun([{ type: "RUN_ERROR", message: REJECTED }]);
  const shown = await view.findByTestId("transcript-stopped");
  expect(shown.textContent).toBe(REJECTED);
  await settled(view);
  expect(view.queryByText(refused)).toBeNull();
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "Take your time",
  );
});

/*
 * THE THREAD IS READ AGAIN AFTER EVERY TURN OF THIS TAB, answered or not. It was read only after a
 * turn that failed, so "The run was stopped." stayed on screen under the next turn's answer.
 */
test("after a Stop is confirmed, the next turn's answer takes the sentence about the stop away", async () => {
  runtime.plans = [HOLDING, { kind: "answers", text: "All done." }];
  const view = open();
  await send(view, "Take your time");
  const { threadId } = currentJoin();
  runtime.threadRuns.set(threadId, [liveRun("run-1")]);
  await pressStop(view);
  await waitFor(() =>
    expect(runtime.stops).toEqual([{ threadId, runId: "run-1" }]),
  );
  expect(await view.findByText("The run was stopped.")).toBeTruthy();
  releaseRun([
    { type: "RUN_ERROR", message: "The Bot run was stopped.", code: "stopped" },
  ]);
  await settled(view);
  expect(view.getByText("The run was stopped.")).toBeTruthy();

  // The next turn answers. As the server then records the thread: the stopped run is no longer
  // the last one, and a run that ended as it should has nothing to explain.
  answerWith((url) => {
    if (!url.pathname.endsWith("/run")) return undefined;
    runtime.threadRuns.set(threadId, [
      { ...liveRun("run-1"), status: "failed", stopReason: "stopped" },
      {
        id: "run-2",
        status: "completed",
        userMessageId: "u-run-2",
        assistantMessageId: "a-run-2",
      },
    ]);
    return undefined;
  });
  await send(view, "And now");
  await said(view, "All done.");
  await settled(view);
  await waitFor(() =>
    expect(view.queryByText("The run was stopped.")).toBeNull(),
  );
});

/*
 * What became of a stored run is said on `/bot` as a conversation with one Bot says it, from the same
 * notice. Each shape is one the server writes (`direct-chat.ts`): a run stopped while it was
 * dispatching an action leaves `unknown`, a managed model's own record settles it as `executed` or
 * `not_dispatched`, and a run the server stopped carries its reason.
 */
const STORED_RUNS: [string, Record<string, unknown>, string][] = [
  [
    "waiting for approval",
    { id: "run-waiting", status: "running", waitingForApproval: true },
    "Waiting for your approval.",
  ],
  [
    "stopped with an outcome nobody can vouch for",
    {
      id: "run-unknown",
      status: "failed",
      stopReason: "stopped",
      externalOutcome: "unknown",
    },
    "The previous run's external outcome is unknown. Check the outcome before sending again.",
  ],
  [
    "paused",
    { id: "run-paused", status: "failed", stopReason: "context_revoked" },
    "The run paused because Memory or Learned skill access changed.",
  ],
  [
    "not dispatched",
    { id: "run-not-sent", status: "failed", externalOutcome: "not_dispatched" },
    "The action was not dispatched. Send your request again to retry.",
  ],
  [
    "executed",
    { id: "run-done", status: "failed", externalOutcome: "executed" },
    "The outcome was verified and added to the conversation.",
  ],
  [
    "stopped",
    { id: "run-stopped", status: "failed", stopReason: "stopped" },
    "The run was stopped.",
  ],
  [
    "stopped when access was revoked",
    { id: "run-revoked", status: "failed", stopReason: "access_revoked" },
    "The run ended when access was revoked.",
  ],
];

test.each(STORED_RUNS)(
  "a run %s says so on /bot, as every conversation does",
  async (_, run, words) => {
    const THREAD = `thread-${String(run.id)}`;
    localStorage.setItem(botThreadKey(BOT.id), THREAD);
    runtime.threadRuns.set(THREAD, [
      { userMessageId: "u-1", assistantMessageId: null, ...run },
    ]);
    const view = open();
    expect(
      await view.findByText(words, { selector: "[role=status]" }),
    ).toBeTruthy();
  },
);

/*
 * On a deployment with a managed model, a run the person stopped can leave its outcome unknown, and
 * the next send is refused until somebody checks it. A conversation with one Bot offers "Check
 * outcome" there; `/bot` must not be left without it once its Stop reaches the server.
 */
test("a run whose outcome nobody can vouch for is explained on /bot, and Check outcome asks the server about it", async () => {
  const THREAD = "thread-unverified";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  const run = {
    id: "run-unverified",
    status: "failed",
    stopReason: "stopped",
    externalOutcome: "unknown",
    userMessageId: "u-1",
    assistantMessageId: null,
  };
  runtime.threadRuns.set(THREAD, [run]);
  const view = open();
  expect(
    await view.findByText(
      "The previous run's external outcome is unknown. Check the outcome before sending again.",
      { selector: "[role=status]" },
    ),
  ).toBeTruthy();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Check outcome" }));

  await waitFor(() => expect(runtime.reconciles).toEqual(["run-unverified"]));
  // The server settled it, and the read after that says what it settled to.
  expect(
    await view.findByText(
      "The outcome was verified and added to the conversation.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Check outcome" })).toBeNull();
});

/*
 * A turn of this tab that fails is read back at once. On a deployment with a managed model such a
 * run ends with an outcome nobody can vouch for, and the next send is refused until it is checked:
 * the sentence and its way out have to be on screen before the person types again, not after a reload.
 */
test("a turn that fails leaves an outcome to check on /bot, without reopening the chat", async () => {
  const THREAD = "thread-managed";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  runtime.plans = [{ kind: "fails", message: REJECTED }];
  // The server's record of the run, as a managed model's failure leaves it.
  answerWith((url) => {
    if (url.pathname.endsWith("/run"))
      runtime.threadRuns.set(THREAD, [
        {
          id: "run-1",
          status: "failed",
          externalOutcome: "unknown",
          userMessageId: "u-1",
          assistantMessageId: null,
        },
      ]);
    return undefined;
  });
  const view = open();
  await waitFor(() => expect(runtime.reads).toEqual([THREAD]));
  await send(view, "Plan my week");

  expect(await view.findByTestId("transcript-stopped")).toBeTruthy();
  expect(
    await view.findByText(
      "The previous run's external outcome is unknown. Check the outcome before sending again.",
      { selector: "[role=status]" },
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Check outcome" })).toBeTruthy();
});

/*
 * A RUN STOPPED IN ANOTHER TAB while this one streams the turn. The server ends the stream with a
 * RUN_ERROR carrying its reason (`stoppedRunEvent`), and read as a failure it drew the stop in red
 * with the words put back in the box. It is not a failure: the notice says "The run was stopped."
 * from the read after the turn, as it does in a conversation.
 */
test("a run stopped in another tab is not drawn as a failure on /bot, and the notice says it was stopped", async () => {
  const THREAD = "thread-stopped-elsewhere";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  runtime.plans = [
    { kind: "fails", message: "The Bot run was stopped.", code: "stopped" },
  ];
  answerWith((url) => {
    if (url.pathname.endsWith("/run"))
      runtime.threadRuns.set(THREAD, [
        {
          id: "run-1",
          status: "failed",
          stopReason: "stopped",
          userMessageId: "u-1",
          assistantMessageId: null,
        },
      ]);
    return undefined;
  });
  const view = open();
  await waitFor(() => expect(runtime.reads).toEqual([THREAD]));
  await send(view, "Plan my week");

  await settled(view);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe("");
  expect(
    await view.findByText("The run was stopped.", {
      selector: "[role=status]",
    }),
  ).toBeTruthy();
});

/*
 * Access that ends while the chat is open showed only on the next send, as a red run error with the
 * old content still on screen. The read after a failed send hides it and offers the way back.
 */
test("a send that fails because access ended hides what was read and offers the way back", async () => {
  const THREAD = "thread-taken-away";
  runtime.stored.set(THREAD, asked);
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  let takenAway = false;
  answerWith((url) =>
    takenAway &&
    (url.pathname.endsWith("/run") || url.pathname.endsWith("/messages"))
      ? new Response(JSON.stringify({ error: "Not yours." }), { status: 403 })
      : undefined,
  );
  const view = open();
  expect(
    await view.findByText(
      "Invite sam@example.com to Spec review on Friday at 10.",
    ),
  ).toBeTruthy();

  takenAway = true;
  await send(view, "And today");
  expect(await view.findByRole("link", { name: "Back to Home" })).toBeTruthy();
  expect(view.getByText("Conversation access ended.")).toBeTruthy();
  expect(
    view.queryByText("Invite sam@example.com to Spec review on Friday at 10."),
  ).toBeNull();
});

/*
 * A stopped run comes back as the server recorded it, a RUN_ERROR that carries its reason, and read
 * as a failure it was drawn in red under the plain notice: live, and again after a reload, when the
 * replay sends it back. A stop is not a failure, either time.
 */
test("a run the person stopped is not drawn as a failure, live or after a reload", async () => {
  const THREAD = "thread-stopped-reload";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  runtime.threadRuns.set(THREAD, [
    {
      id: "run-1",
      status: "failed",
      stopReason: "stopped",
      userMessageId: "u-1",
      assistantMessageId: null,
    },
  ]);
  runtime.plans = [
    { kind: "fails", message: "The Bot run was stopped.", code: "stopped" },
  ];
  const live = open();
  await send(live, "Take your time");
  await settled(live);
  await said(live, "Take your time");
  expect(live.queryByTestId("transcript-stopped")).toBeNull();
  expect(live.getByText("The run was stopped.")).toBeTruthy();

  live.unmount();
  const back = open();
  await settled(back);
  await said(back, "Take your time");
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
  expect(back.queryByText("The Bot run was stopped.")).toBeNull();
  expect(back.getByText("The run was stopped.")).toBeTruthy();
});
