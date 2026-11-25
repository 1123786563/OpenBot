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

test("Stop the Bot stops the run on the server and says so without an error", async () => {
  const THREAD = "thread-stopped";
  localStorage.setItem(botThreadKey(BOT.id), THREAD);
  // The read says this thread has a run going, so Stop can name it.
  runtime.threadRuns.set(THREAD, [
    {
      id: "run-live",
      status: "running",
      userMessageId: "u-1",
      assistantMessageId: null,
    },
  ]);
  runtime.plans = [
    {
      kind: "holds",
      events: [
        {
          type: "TEXT_MESSAGE_START",
          messageId: "partial",
          role: "assistant",
        },
      ],
    },
  ];
  const view = open();
  const user = await send(view, "Take your time");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy(),
  );
  await user.click(view.getByRole("button", { name: "Stop the Bot" }));

  await waitFor(() =>
    expect(runtime.stops).toEqual([{ threadId: THREAD, runId: "run-live" }]),
  );
  // A stop is not a failure: the row under the transcript says so without an error.
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(await view.findByText("The run was stopped.")).toBeTruthy();
  releaseRun([
    { type: "TEXT_MESSAGE_END", messageId: "partial" },
    { type: "RUN_FINISHED", threadId: THREAD, runId: "run-1" },
  ]);
  await settled(view);
});
