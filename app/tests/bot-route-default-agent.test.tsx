import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { composeDraftKey } from "@/lib/channels/compose-draft";
import {
  agent,
  answerWith,
  botRuntime,
  currentJoin,
  failEveryRequest,
  queryClientWithAgents,
  renderBot,
} from "./bot-route-default-agent.fixture";

botRuntime();

/*
 * The `/bot` route, drawn with its real chat: which Bot it opens, what it says when that Bot cannot
 * be opened, the draft it keeps and the Computer it opens beside the conversation. What the chat
 * itself does with a thread is `bot-chat.test.tsx`.
 */

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

const PICKED_HARNESS = agent({
  builtIn: false,
  endpoint: "http://127.0.0.1:4201",
  id: "picked-harness",
  name: "LangGraph",
  title: "LangGraph",
});

const composer = (view: ReturnType<typeof renderBot>) =>
  view.findByRole("textbox", { name: "Message" });

/** The chat has joined `agentId`'s thread. Says which. */
async function openedFor(view: ReturnType<typeof renderBot>, agentId: string) {
  await composer(view);
  await waitFor(() => expect(currentJoin().agentId).toBe(agentId));
  return currentJoin().threadId;
}

function unreadable() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The roster holds `agents`; the detail endpoint answers `agentId` with `response`. */
function clientAnswering(
  agentId: string,
  response: Response,
  agents: AgentProfile[] = [GENERAL_ASSISTANT],
) {
  answerWith((url) =>
    url.pathname === `/api/agents/${agentId}` ? response.clone() : undefined,
  );
  return queryClientWithAgents(agents);
}

function unreadableClientWithFailingRequests() {
  failEveryRequest();
  return unreadable();
}

/** The roster cannot be read; `agents` names a Bot the detail endpoint still answers for. */
function failingRoster(answered?: Record<string, Response>) {
  failEveryRequest();
  if (answered)
    answerWith(
      (url) => answered[url.pathname] ?? new Response(null, { status: 500 }),
    );
  return unreadable();
}

test("/bot defaults to the picked harness when this setup selected one", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(await openedFor(view, "picked-harness")).toBeTruthy();
});

test("/bot draws the shared transcript and composer inside the Astryx theme", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
  );
  const box = await composer(view);

  expect(box.closest("[data-slot=composer]")).toBeTruthy();
  expect(box.closest(".copilotKitChat")).toBeNull();
  expect(box.closest("[data-astryx-theme]")).toBeTruthy();
});

test("/bot with an empty agent query uses the normal default Bot", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=",
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(await openedFor(view, "picked-harness")).toBeTruthy();
  expect(view.queryByText('There\'s no Bot called "".')).toBeNull();
  expect(view.queryByText("There are no Bots yet.")).toBeNull();
});

test("/bot reports a failed initial roster load instead of claiming there are no Bots", async () => {
  const view = renderBot(unreadableClientWithFailingRequests());

  expect(await view.findByText("Couldn't load your Bots.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Retry Bot list" })).toBeTruthy();
  expect(view.queryByText("There are no Bots yet.")).toBeNull();
});

test("/bot preserves an explicit agent, including the built-in first agent", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=general-assistant",
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(await openedFor(view, "general-assistant")).toBeTruthy();
});

test("/bot preserves an explicit unknown agent as a clear missing-bot state", async () => {
  const view = renderBot(
    clientAnswering("missing-agent", new Response(null, { status: 404 })),
    "/bot?agent=missing-agent",
  );

  expect(await view.findByText("We couldn't find this Bot.")).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("/bot loads a hidden explicit agent from the detail endpoint", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const view = renderBot(
    clientAnswering("hidden-bot", Response.json({ agent: hiddenBot })),
    "/bot?agent=hidden-bot",
  );

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(await openedFor(view, "hidden-bot")).toBeTruthy();
  expect(view.queryByText('There\'s no Bot called "hidden-bot".')).toBeNull();
});

test("/bot hidden lookup does not collide with the shared agent detail cache", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = clientAnswering(
    "hidden-bot",
    Response.json({ agent: hiddenBot }),
  );
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderBot(queryClient, "/bot?agent=hidden-bot");

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(await openedFor(view, "hidden-bot")).toBeTruthy();
  expect(view.queryByText('There\'s no Bot called "hidden-bot".')).toBeNull();
});

test("/bot reports an explicit agent detail load failure", async () => {
  const view = renderBot(
    clientAnswering(
      "error-bot",
      Response.json({ error: "detail exploded" }, { status: 500 }),
    ),
    "/bot?agent=error-bot",
  );

  const message = await view.findByText("Couldn't load this Bot.");
  expect(message.closest('[role="alert"]')).toBeTruthy();
  expect(view.getByRole("button", { name: "Retry this Bot" })).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("/bot can open a bookmarked Bot when the roster is unavailable", async () => {
  const roleDescription = "Helps organize work across departments. "
    .repeat(16)
    .trim();
  const view = renderBot(
    failingRoster({
      "/api/capabilities": Response.json({ mode: "openbot" }),
      "/api/channels": Response.json({
        channel: { threadId: "bookmarked-bot-thread" },
      }),
      "/api/agents/general-assistant": Response.json({
        agent: { ...GENERAL_ASSISTANT, roleDescription, visibility: "public" },
      }),
    }),
    "/bot?agent=general-assistant",
  );
  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(view.getByText("Public")).toBeTruthy();
  const disclosure = view.getByRole("button", { name: "About this Bot" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  disclosure.focus();
  const user = userEvent.setup({ document });
  await user.keyboard("{Enter}");
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByText(roleDescription)).toBeTruthy();
  await user.keyboard(" ");
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(await composer(view)).toBeTruthy();
  expect(view.queryByText("Couldn't load your Bots.")).toBeNull();
});

test("/bot opens a named bookmark without waiting for the roster response", async () => {
  let releaseRoster: ((response: Response) => void) | undefined;
  const pendingRoster = new Promise<Response>((resolve) => {
    releaseRoster = resolve;
  });
  failEveryRequest();
  answerWith((url) => {
    if (url.pathname === "/api/agents") return pendingRoster;
    if (url.pathname === "/api/agents/general-assistant")
      return Response.json({ agent: GENERAL_ASSISTANT });
    return undefined;
  });
  const client = unreadable();
  try {
    const view = renderBot(client, "/bot?agent=general-assistant");
    expect(
      await view.findByRole("heading", { name: "General Assistant" }),
    ).toBeTruthy();
    expect(client.getQueryState(agentKeys.list(false))?.fetchStatus).toBe(
      "fetching",
    );
  } finally {
    releaseRoster?.(Response.json({ agents: [GENERAL_ASSISTANT] }));
  }
});

test("/bot does not use a detail response belonging to another Bot", async () => {
  const view = renderBot(
    clientAnswering(
      "wrong-response",
      Response.json({ agent: GENERAL_ASSISTANT }),
      [PICKED_HARNESS],
    ),
    "/bot?agent=wrong-response",
  );
  expect(await view.findByText("Couldn't load this Bot.")).toBeTruthy();
  expect(
    view.getByRole("link", { name: "Open LangGraph" }).getAttribute("href"),
  ).toBe("/bot?agent=picked-harness");
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("/bot gives a denied bookmark a way back to the Bot list", async () => {
  const view = renderBot(
    clientAnswering("restricted", new Response(null, { status: 403 })),
    "/bot?agent=restricted",
  );
  expect(await view.findByText("This Bot is unavailable to you.")).toBeTruthy();
  expect(
    view.getByRole("link", { name: "Browse Bots" }).getAttribute("href"),
  ).toBe("/bots");
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("/bot still falls back to the first agent when no picked harness exists", async () => {
  const otherAgent = agent({ id: "researcher", name: "Researcher" });
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, otherAgent]),
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(await openedFor(view, "general-assistant")).toBeTruthy();
});

/** The Computer's ownership state, as the control endpoint reports it. */
const HELD_BY_BOT = {
  holder: "bot",
  since: "2026-09-26",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
  recoveryRequired: false,
};

test("/bot opens a live Computer sidebar with ownership controls and preserves the chat", async () => {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  answerWith((url) =>
    url.pathname.endsWith("/control") ? Response.json(HELD_BY_BOT) : undefined,
  );
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=general-assistant",
  );
  const toggle = await view.findByRole("button", { name: "Open Computer" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  // Taking control is offered inside the Computer, never beside the header's icon.
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
  const box = await composer(view);
  const first = await openedFor(view, "general-assistant");
  await userEvent.setup({ document }).type(box, "Keep this conversation");
  fireEvent.click(toggle);
  const sidebarElement = await view.findByRole("region", {
    name: "Computer sidebar",
  });
  const sidebar = within(sidebarElement);
  expect(
    sidebar
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(
    sidebar.getByRole("button", {
      name: "Open the Bot's screen full size",
    }),
  ).toBeTruthy();
  expect(sidebar.getByRole("heading", { name: "Activity" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close Computer" }));
  // Poll a boolean: Bun serializes the entire Happy DOM tree when a pending
  // element is compared with null, starving the navigation this wait observes.
  await waitFor(() => expect(sidebarElement.isConnected).toBe(false));
  expect(
    view.container.querySelector("[inert] [data-slot=detail-pane]"),
  ).toBeTruthy();
  // The same composer, holding the same words, on the same thread.
  expect(view.getByRole("textbox", { name: "Message" })).toBe(box);
  expect(box.textContent).toContain("Keep this conversation");
  expect(currentJoin()).toEqual({
    agentId: "general-assistant",
    threadId: first,
  });
  expect(view.getByRole("button", { name: "Open Computer" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "New chat with this Bot" }));
  fireEvent.click(
    await view.findByRole("button", { name: "Start new conversation" }),
  );
  await waitFor(() => expect(currentJoin().threadId).not.toBe(first));
  expect(currentJoin().agentId).toBe("general-assistant");
});

test("a quick chat draft stays with its Bot after reload and starting fresh", async () => {
  const client = queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]);
  client.setQueryData(authKeys.currentUser(), { id: "draft-owner" });
  const route = "/bot?agent=general-assistant";
  const first = renderBot(client, route);
  await openedFor(first, "general-assistant");
  await userEvent
    .setup({ document })
    .type(await composer(first), "Keep my draft");
  first.unmount();

  const other = renderBot(client, "/bot?agent=picked-harness");
  await openedFor(other, "picked-harness");
  expect((await composer(other)).textContent).toBe("");
  other.unmount();

  const reopened = renderBot(client, route);
  await waitFor(() =>
    expect(
      reopened.getByRole("textbox", { name: "Message" }).textContent ?? "",
    ).toContain("Keep my draft"),
  );
  fireEvent.click(
    reopened.getByRole("button", { name: "New chat with this Bot" }),
  );
  fireEvent.click(
    await reopened.findByRole("button", { name: "Start new conversation" }),
  );
  await waitFor(() =>
    expect(
      reopened.getByRole("textbox", { name: "Message" }).textContent ?? "",
    ).toContain("Keep my draft"),
  );
});

test("a draft saved by the earlier /bot chat is still there", async () => {
  const client = queryClientWithAgents([GENERAL_ASSISTANT]);
  client.setQueryData(authKeys.currentUser(), { id: "draft-owner" });
  // Plain text, which is how the packaged chat stored it.
  sessionStorage.setItem(
    composeDraftKey(
      "draft-owner",
      `quick:${encodeURIComponent(GENERAL_ASSISTANT.id)}`,
      "message",
    ) ?? "",
    JSON.stringify("Written before this chat"),
  );

  const view = renderBot(client, "/bot?agent=general-assistant");
  expect((await composer(view)).textContent).toContain(
    "Written before this chat",
  );
});

test("/bot?watch=true restores the live Computer panel on reload", async () => {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  answerWith((url) =>
    url.pathname.endsWith("/control") ? Response.json(HELD_BY_BOT) : undefined,
  );
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT]),
    "/bot?agent=general-assistant&watch=true",
  );
  const sidebar = within(
    await view.findByRole("region", { name: "Computer sidebar" }),
  );
  await waitFor(() =>
    expect(
      sidebar
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(await openedFor(view, "general-assistant")).toBeTruthy();
});
