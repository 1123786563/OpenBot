import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { GroupChat } from "@/components/channels/group-chat";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { type GroupMessage, groupPollInterval } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's question in a conversation with two Bots.
 *
 * The person asked Errand Helper which area to do first, and it asked them back. The question was
 * saved and the sidebar badge counted it, but the group conversation drew no question, so Answer on
 * the Bots page opened a conversation with nothing in it to answer and the badge could not be
 * cleared. It now waits above the composer, as it does in a conversation with one Bot, and what
 * the person sends answers it.
 *
 * The group, the inbox, the badge and the answer route are played at the HTTP boundary, the way the
 * server answers them (`server/tests/group-ask-person.integration.test.ts` holds the server to its
 * half). Everything above it is the real GroupChat and the real badge.
 */

const CHANNEL = "group-1";
const ERRANDS = "picked-harness";
const BUDGET = "budget-buddy";
const QUESTION =
  "Where are you starting, and which errands are downtown versus in Riverside?";
const WHY =
  "The best order depends on your starting point and where the errands are.";
const ANSWER =
  "From home. Dry cleaning is downtown, groceries are in Riverside.";
const REPLY = "Do downtown first, then Riverside on the way home.";

function line(
  id: string,
  agentId: string | null,
  text: string,
  status: GroupMessage["status"] = "completed",
): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId,
    text,
    status,
    createdAt: new Date().toISOString(),
  };
}

let open = true;
let showQuestion = true;
let denied = false;
let failNextAnswer = false;
let messages: GroupMessage[] = [];
/** Runs of their own the Bots are making in the group; undefined when there are none. */
let background: unknown[] | undefined;
let reconciliations: string[] = [];
let failReconciliation = false;
let answers: unknown[] = [];
let groupSends: unknown[] = [];
/** The approval inbox's requests, as `/api/approvals` answers them. */
let requests: unknown[] = [];
/** What the inbox holds for approval-1 once it is decided: nothing, unless a test says otherwise. */
let decidedRequests: unknown[] = [];
let decisions: unknown[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/me")
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [
          { id: ERRANDS, name: "Errand Helper", avatarSeed: "personal" },
          { id: BUDGET, name: "Budget Buddy", avatarSeed: BUDGET },
        ],
      });
    if (url.pathname === `/api/groups/${CHANNEL}`) {
      if (denied)
        return Response.json(
          { error: "This group conversation was not found." },
          { status: 403 },
        );
      if (method === "POST") {
        groupSends.push(JSON.parse(String(init?.body)));
        return Response.json({ queued: true }, { status: 202 });
      }
      return Response.json({
        bots: [
          { id: ERRANDS, name: "Errand Helper" },
          { id: BUDGET, name: "Budget Buddy" },
        ],
        people: [
          { userId: "me", email: "me@example.test", name: null, creator: true },
        ],
        messages,
        ...(background ? { backgroundRuns: background } : {}),
      });
    }
    if (
      url.pathname.endsWith("/runs/run-unknown/reconcile") &&
      method === "POST"
    ) {
      reconciliations.push(url.pathname + url.search);
      if (failReconciliation) return Response.json({}, { status: 503 });
      background = [unknownRun("executed")];
      return Response.json({ externalOutcome: "executed" });
    }
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests,
        rules: [],
        teamRules: [],
        questions:
          open && showQuestion
            ? [
                {
                  id: "q-1",
                  botId: ERRANDS,
                  conversationBotId: ERRANDS,
                  // The Bot's own thread in the group, not the channel's.
                  threadId: "errand-helper-group-thread",
                  channelId: CHANNEL,
                  question: QUESTION,
                  why: WHY,
                  createdAt: "2026-11-08T05:16:39.000Z",
                },
              ]
            : [],
      });
    if (url.pathname === "/api/approvals/approval-1/decision") {
      decisions.push(JSON.parse(String(init?.body)));
      // Decided: the server carries the turn on, so nothing is waiting on the person.
      requests = decidedRequests;
      return Response.json({ id: "approval-1" });
    }
    if (url.pathname === "/api/bots/attention")
      return Response.json({
        lastPingId: null,
        bots: [
          {
            agentId: ERRANDS,
            name: "Errand Helper",
            questions: open ? 1 : 0,
            approvals: 0,
            handoffs: 0,
            unread: 0,
            paused: false,
            notify: "none",
            items: 0,
            tasks: { needsInput: 0, ready: 0, failed: 0 },
          },
        ],
      });
    // As the server answers a group question: closed, the answer posted to the group, and the Bot
    // that asked queued to answer it there.
    if (url.pathname === "/api/approvals/questions/q-1/respond") {
      answers.push(JSON.parse(String(init?.body)));
      if (failNextAnswer) {
        failNextAnswer = false;
        return Response.json({}, { status: 503 });
      }
      open = false;
      messages = [
        ...messages,
        line("person-response:q-1", null, ANSWER),
        line(`person-response:q-1:${ERRANDS}`, ERRANDS, REPLY),
      ];
      return Response.json({ id: "q-1", queued: true });
    }
    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
  }) as typeof fetch;
});
beforeEach(() => {
  queryClient.clear();
  open = true;
  showQuestion = true;
  denied = false;
  failNextAnswer = false;
  answers = [];
  groupSends = [];
  requests = [];
  decidedRequests = [];
  decisions = [];
  background = undefined;
  reconciliations = [];
  failReconciliation = false;
  messages = [
    line(
      "m-1",
      null,
      "@Errand Helper which area should I do first on Saturday, downtown or Riverside? One sentence.",
    ),
    line(
      `m-1:${ERRANDS}`,
      ERRANDS,
      "Where are you starting, and which errands are in each area?",
    ),
  ];
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  sessionStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function conversation() {
  // A Bot's line can link to its page, which needs a router as the route provides one.
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <BotsNavBadge />
          <GroupChat channelId={CHANNEL} />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: [`/group/${CHANNEL}`] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a Bot's question waits in the group, and answering it there clears the badge", async () => {
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  // The question is in the conversation it was asked in, with why it was asked.
  const card = await view.findByRole("region", {
    name: "Errand Helper is waiting on your answer",
  });
  expect(card.textContent).toContain(QUESTION);
  expect(card.textContent).toContain(WHY);
  await view.findByRole("img", { name: "1 thing needs you" });

  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    ANSWER,
  );
  await user.click(view.getByRole("button", { name: "Send message" }));

  // What they sent is the answer to the question, not a new message to every Bot.
  await waitFor(() => expect(answers).toEqual([{ response: ANSWER }]));
  expect(groupSends).toEqual([]);
  // Answered: the card and the badge go, and the Bot's answer to it is in the conversation.
  await waitFor(() =>
    expect(
      view.queryByRole("region", {
        name: "Errand Helper is waiting on your answer",
      }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(view.queryByRole("img", { name: /needs? you/ })).toBeNull(),
  );
  await view.findByText(ANSWER);
  await view.findByText(REPLY);
});

test("a failed answer restored after reload still goes to the original question", async () => {
  failNextAnswer = true;
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByRole("region", {
    name: "Errand Helper is waiting on your answer",
  });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    ANSWER,
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText(/Couldn't confirm your answer/);
  view.unmount();
  queryClient.clear();
  showQuestion = false;

  const restored = conversation();
  await restored.findByText(/Draft restored/);
  await user.click(restored.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(answers).toEqual([{ response: ANSWER }, { response: ANSWER }]),
  );
  expect(groupSends).toEqual([]);
  await restored.findByText(REPLY);
});

/*
 * One vocabulary for the stages a Bot run can be in. A group used to keep its own: "Waiting to
 * reply", "Run ended". `/bot` and a conversation with one Bot say "Queued" and "The run was
 * stopped." for the same stored facts, and so does a group now.
 */
test("a group names a queued Bot, a working Bot and a stopped run as every conversation does", async () => {
  showQuestion = false;
  messages = [
    line("queued-1", BUDGET, "", "queued"),
    line("running-1", ERRANDS, "", "running"),
  ];
  background = [
    {
      id: "run-stopped",
      agentId: ERRANDS,
      threadId: "errand-helper-group-thread",
      status: "failed",
      waitingForApproval: false,
      partialReply: null,
      externalOutcome: null,
      stopReason: "stopped",
    },
  ];
  const view = conversation();

  expect(await view.findByText("Queued")).toBeTruthy();
  expect(view.getByText("Thinking")).toBeTruthy();
  expect(
    await view.findByText("The run was stopped.", {
      selector: "[role=status]",
    }),
  ).toBeTruthy();
  expect(view.queryByText("Waiting to reply")).toBeNull();
  expect(view.queryByText("Run ended")).toBeNull();
});

function unknownRun(externalOutcome: "unknown" | "executed") {
  return {
    id: "run-unknown",
    agentId: ERRANDS,
    threadId: ERRANDS_THREAD,
    status: "failed",
    waitingForApproval: false,
    partialReply: null,
    externalOutcome,
    stopReason: "stopped",
  };
}

test("a group can check the outcome of its stopped Run without repeating its work", async () => {
  showQuestion = false;
  background = [unknownRun("unknown")];
  failReconciliation = true;
  const view = conversation();
  const user = userEvent.setup({ document });
  const check = await view.findByRole("button", { name: "Check outcome" });
  await user.click(check);
  await view.findByText("Couldn't check the outcome. Try again.");
  failReconciliation = false;
  await user.click(check);
  await view.findByText("The outcome was verified.");
  expect(view.queryByRole("button", { name: "Check outcome" })).toBeNull();
  expect(reconciliations).toEqual([
    `/api/copilotkit/threads/${ERRANDS_THREAD}/runs/run-unknown/reconcile?agentId=${ERRANDS}`,
    `/api/copilotkit/threads/${ERRANDS_THREAD}/runs/run-unknown/reconcile?agentId=${ERRANDS}`,
  ]);
  expect(groupSends).toEqual([]);
});

test("an empty group gives the next step as a status", async () => {
  showQuestion = false;
  messages = [];
  const view = conversation();

  await waitFor(() =>
    expect(
      view
        .getAllByRole("status")
        .some((row) => row.textContent?.includes("Type @ to ask one Bot.")),
    ).toBe(true),
  );
  expect(view.getByRole("textbox", { name: "Message" })).toBeTruthy();
});

test("a group this person can no longer read hides its old messages and offers the way back", async () => {
  showQuestion = false;
  messages = [
    line("before-denied", null, "An old message must not stay here."),
    line("before-denied:bot", ERRANDS, "", "running"),
  ];
  const view = conversation();
  await view.findByText("An old message must not stay here.");

  denied = true;
  // The same read a poll or another action would ask for: the server refuses it, and the query
  // drops its cache rather than leaving this person's old messages on screen.
  await act(() =>
    queryClient.invalidateQueries({ queryKey: ["groups", CHANNEL] }),
  );
  expect(
    await view.findByRole("link", { name: "Back to Home" }, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(view.queryByText("An old message must not stay here.")).toBeNull();
  expect(view.queryByText("Thinking")).toBeNull();
  expect(
    view.getByText("You can't access this group conversation."),
  ).toBeTruthy();
  // The only thing left to try is Home, not a Retry that can never be allowed.
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
});

const ERRANDS_THREAD = "errand-helper-group-thread";

/** An approval waiting on the Errand Helper's thread in the group. */
function waitingApproval(threadId: string) {
  return {
    id: "approval-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    action: {
      botId: ERRANDS,
      toolRef: "arcade-GoogleCalendar/CreateEvent",
      effect: "write",
      scope: "arcade-GoogleCalendar",
      threadId,
      toolCallId: "call-invite",
      args: { summary: "Spec review" },
      target: {},
      policy: {
        behaviour: "ask",
        source: "safety",
        reason: "Sending something to other people asks you first.",
        kind: "sending",
      },
    },
  };
}

/*
 * NO STOP IN A GROUP. A Bot's turn here is a run the server owns, and a stop leaves its outcome
 * "unknown". Nothing in a group can vouch for the run afterwards, so the Bot answers "busy" to
 * every later turn of its own, for good. A working Bot offers no Stop, in the composer or on the
 * run the server holds for it.
 */
test("a Bot working in the group is not offered a Stop, in the composer or on its run", async () => {
  showQuestion = false;
  messages = [
    line("queued-1", BUDGET, "", "queued"),
    { ...line("running-1", ERRANDS, "", "running"), threadId: ERRANDS_THREAD },
  ];
  background = [
    {
      id: "run-live",
      agentId: BUDGET,
      threadId: "budget-buddy-group-thread",
      status: "running",
      waitingForApproval: false,
      partialReply: null,
      externalOutcome: null,
    },
  ];
  const view = conversation();

  // The Errand Helper's line and the Budget Buddy's run are both working.
  expect(await view.findAllByText("Thinking")).toHaveLength(2);
  expect(
    await view.findByText("All Bots reply in order. Type @ to ask one Bot."),
  ).toBeTruthy();
  // The composer names no Stop, and neither does the run the server holds for the Budget Buddy.
  expect(view.queryByRole("button", { name: /Stop/ })).toBeNull();
});

/*
 * A Bot that stopped for an approval asked in one sentence and sent the person to the Bot's own
 * page. The same card a conversation with one Bot draws now waits in the group, once for the Bot's
 * thread, whether the wait shows on the Bot's line or on the run the server is holding.
 */
test("a Bot waiting for approval asks in the group, once, and the answer is sent once", async () => {
  showQuestion = false;
  messages = [
    {
      ...line("waiting-1", ERRANDS, "", "waiting"),
      threadId: ERRANDS_THREAD,
      reason: "This action is waiting for your approval.",
    },
  ];
  background = [
    {
      id: "run-waiting",
      agentId: ERRANDS,
      threadId: ERRANDS_THREAD,
      status: "running",
      waitingForApproval: true,
      partialReply: null,
      externalOutcome: null,
    },
  ];
  requests = [waitingApproval(ERRANDS_THREAD)];
  const view = conversation();

  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  // One thread, one card: the line and the run behind it do not each ask.
  expect(
    view.getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(
    card.getByText("Sending something to other people asks you first."),
  ).toBeTruthy();
  expect(
    view.getByText("This action is waiting for your approval."),
  ).toBeTruthy();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(card.getByRole("radio", { name: "Allow once" }));
  await user.click(card.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(decisions).toEqual([{ decision: "allow_once" }]));
  // Answered: the server carries the turn on, so the card goes and nothing asks twice.
  await waitFor(() =>
    expect(
      view.queryByRole("region", { name: "Waiting for your approval" }),
    ).toBeNull(),
  );
});

/*
 * THE REPLY AFTER A DECISION. A Bot's line that stopped for an approval stays "waiting" until the
 * server has carried the turn on and written the reply into it, and nothing else changes the
 * transcript until then. The reading stopped with the line, and the decision only read the approvals
 * again, so the reply never arrived without leaving the conversation.
 */
test("after an approval is answered in the group, the Bot's reply arrives without leaving", async () => {
  showQuestion = false;
  messages = [
    {
      ...line("waiting-1", ERRANDS, "", "waiting"),
      threadId: ERRANDS_THREAD,
      reason: "This action is waiting for your approval.",
    },
  ];
  requests = [waitingApproval(ERRANDS_THREAD)];
  // Decided: the server runs the action and carries the turn on, in a turn no browser streams.
  decidedRequests = [
    {
      ...waitingApproval(ERRANDS_THREAD),
      status: "approved",
      decidedAt: new Date().toISOString(),
    },
  ];
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  await user.click(card.getByRole("radio", { name: "Allow once" }));
  await user.click(card.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(decisions).toEqual([{ decision: "allow_once" }]));

  // The line still waits on the server, and says the Bot is working, not that it waits on you.
  await view.findByText("Thinking");
  expect(
    view.queryByText("This action is waiting for your approval."),
  ).toBeNull();
  expect(view.queryByRole("link", { name: "Open Errand Helper" })).toBeNull();

  // The server ends the turn it carried on: the row that waited now holds the reply.
  messages = [
    {
      ...line("waiting-1", ERRANDS, "Spec review booked for Thursday."),
      threadId: ERRANDS_THREAD,
    },
  ];
  requests = [];
  // The approvals are read again, as their own reading does: the turn is over, so the group is read.
  await act(() =>
    queryClient.refetchQueries({ queryKey: approvalInboxOptions().queryKey }),
  );
  await view.findByText("Spec review booked for Thursday.");
  expect(groupSends).toEqual([]);
});

/*
 * The transcript is read while it can still change. A line that waited on an approval used to stop
 * the reading, though the server writes that line's reply into it later. It is read slowly while
 * nobody has decided, and at the ordinary pace once the server is carrying the line on.
 */
test("a group keeps reading while a Bot's line waits, and reads faster once the server carries it on", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const waiting = {
    ...line("waiting-1", ERRANDS, "", "waiting"),
    threadId: ERRANDS_THREAD,
  };
  const settled = {
    bots: [],
    people: [],
    messages: [line("done-1", ERRANDS, "All set.")],
  };
  // Nothing owed: no reading.
  expect(groupPollInterval(settled, null, now)).toBe(false);
  // A line waiting on the person is read slowly, with no decision to go on.
  expect(
    groupPollInterval({ ...settled, messages: [waiting] }, null, now),
  ).toBe(10_000);
  const decided: ApprovalInboxData = {
    enabled: true,
    requests: [
      // The inbox while the server carries the line on: decided, not yet completed.
      {
        ...(waitingApproval(
          ERRANDS_THREAD,
        ) as ApprovalInboxData["requests"][number]),
        status: "approved",
        decidedAt: new Date(now - 1_000).toISOString(),
      },
    ],
    rules: [],
    teamRules: [],
    questions: [],
  };
  // The server is carrying that line on: the ordinary pace.
  expect(
    groupPollInterval({ ...settled, messages: [waiting] }, decided, now),
  ).toBe(1_500);
  // A line that is working is read at the ordinary pace whatever the approvals say.
  expect(
    groupPollInterval(
      { ...settled, messages: [line("running-1", ERRANDS, "", "running")] },
      null,
      now,
    ),
  ).toBe(1_500);
});

/* A run the server holds for an approval, with no line of its own waiting, asks the same way. */
test("a run waiting on an approval in the group asks there, under no Bot's line", async () => {
  showQuestion = false;
  messages = [line("done-1", BUDGET, "All set.")];
  background = [
    {
      id: "run-waiting",
      agentId: ERRANDS,
      threadId: ERRANDS_THREAD,
      status: "running",
      waitingForApproval: true,
      partialReply: null,
      externalOutcome: null,
    },
  ];
  requests = [waitingApproval(ERRANDS_THREAD)];
  const view = conversation();
  expect(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  ).toBeTruthy();
});

/*
 * Which Bot is working was said in words only. The roster's avatar says it too, with the same
 * working badge the Home page draws.
 */
test("a working Bot's avatar says it is working", async () => {
  showQuestion = false;
  messages = [
    { ...line("running-1", ERRANDS, "", "running"), threadId: ERRANDS_THREAD },
    line("done-1", BUDGET, "All set."),
  ];
  background = [
    {
      id: "run-live",
      agentId: BUDGET,
      threadId: "budget-buddy-group-thread",
      status: "running",
      waitingForApproval: false,
      partialReply: null,
      externalOutcome: null,
    },
  ];
  const view = conversation();
  // The Errand Helper's line and the Budget Buddy's run; the finished line's avatar is still.
  expect(await view.findAllByText("Working…")).toHaveLength(2);
  const working = view.getAllByText("Working…");
  expect(
    working[0]?.closest("[data-speaker]")?.getAttribute("data-speaker"),
  ).toBe(ERRANDS);
});
