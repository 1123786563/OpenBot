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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { GroupChat } from "@/components/channels/group-chat";
import type { GroupMessage } from "@/lib/groups";
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
let answers: unknown[] = [];
let groupSends: unknown[] = [];
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
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests: [],
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
  background = undefined;
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
  return render(
    <QueryClientProvider client={queryClient}>
      <BotsNavBadge />
      <GroupChat channelId={CHANNEL} />
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
