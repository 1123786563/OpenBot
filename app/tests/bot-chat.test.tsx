import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { botThreadKey } from "@/lib/copilot/bot-thread";
import {
  agent,
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
  await send(view, "What time is it?");

  await said(view, "It is 9:05");
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();

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
