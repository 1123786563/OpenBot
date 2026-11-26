import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { ChannelChat } from "@/components/channels/channel-chat";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import * as pendingStarts from "@/lib/channels/pending-start";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import type { ConversationModel, ModelCatalogue } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { Route as StartRoute } from "@/routes/_authed/_app/start.$startId";
import { settleReactWork } from "./settle-react-work";

/**
 * A MODEL AND A THINKING EFFORT PICKED BEFORE A CONVERSATION EXISTS, SAVED BEFORE ITS FIRST RUN.
 *
 * On `/channel/new` there is no conversation to save a pick on, so the picker holds it until the
 * first message creates one, and the pick is saved before that message runs. Both halves have to
 * arrive: a model saved without its effort runs the first message at the wrong effort, and nobody
 * would see it.
 *
 * Everything below the HTTP boundary is real: the route, its composer and picker, the start
 * sequence, the hand-over to `ChannelChat` and the run request. The fixture supplies HTTP responses
 * and substitutes for the browser's IndexedDB send claim.
 */

const NativeResponse = globalThis.Response;
const BOT = "terra-bot";

const bot: AgentProfile = {
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  mine: true,
  name: "Terra Bot",
  roleDescription: "Answers on OpenBot's model.",
  systemOwned: false,
  title: "Analyst",
  visibility: "private",
  id: BOT,
  runsOnOpenBotModel: true,
};

const channel: AgentChannel = {
  id: "new-model-channel",
  name: "Terra Bot",
  agentIds: [BOT],
  threadId: "new-model-thread",
  active: true,
  lastMessageAt: "2026-11-05T00:00:00.000Z",
};

const catalogue: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
};

/** Every model-related request and run, in the order they left the browser. */
let trail: string[] = [];
let sentMessages: unknown[] = [];
let currentUserId = "model-tester";
let directMessageReplay = false;
let storedMessages: unknown[] = [];
let historyAvailable = true;
let saved: ConversationModel = { model: null, effort: null };
let originalFetch: typeof fetch;
let originalIndexedDB: PropertyDescriptor | undefined;
let loseCreateResponse = false;
let createRequests: unknown[] = [];
let pendingRun: Promise<void> | undefined;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
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
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname === "/api/channels" && method === "POST") {
        trail.push("create");
        createRequests.push(JSON.parse(String(init?.body)));
        if (loseCreateResponse) {
          loseCreateResponse = false;
          throw new TypeError("Response lost");
        }
        return NativeResponse.json({ channel }, { status: 201 });
      }
      if (url.pathname === "/api/models") return NativeResponse.json(catalogue);
      if (url.pathname === "/api/capabilities")
        return NativeResponse.json({ directMessageReplay });
      if (url.pathname === "/api/me")
        return NativeResponse.json({
          user: {
            id: currentUserId,
            email: "model@example.test",
            role: "user",
            onboarding: null,
          },
        });
      if (url.pathname === `/api/channels/${channel.id}/model`) {
        if (method === "PUT") {
          const pick = JSON.parse(String(init?.body)) as ConversationModel;
          trail.push(`save ${pick.model} ${pick.effort}`);
          const runs = catalogue.models.find(
            (option) => option.id === (pick.model ?? catalogue.default),
          );
          if (!runs)
            return NativeResponse.json(
              { error: "That model isn't available. Pick another one." },
              { status: 400 },
            );
          if (pick.effort !== null && !runs.efforts?.includes(pick.effort))
            return NativeResponse.json(
              { error: `${runs.label} doesn't take that thinking effort.` },
              { status: 400 },
            );
          saved = { model: pick.model, effort: pick.effort };
        }
        return NativeResponse.json(saved);
      }
      if (url.pathname === "/api/route")
        return NativeResponse.json({ agentId: BOT, reason: "chosen" });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [bot] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({ agent: bot });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ tools: [], skills: [] });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        trail.push("run");
        sentMessages.push(body.messages.at(-1));
        await pendingRun;
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (/\/api\/channels\/[^/]+(\/(activity|busy|read))?$/.test(url.pathname))
        return method === "GET"
          ? NativeResponse.json({ channel })
          : new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+(\/messages)?$/.test(url.pathname))
        return NativeResponse.json(
          historyAvailable ? { messages: storedMessages } : {},
          { status: historyAvailable ? 200 : 503 },
        );
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
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
  trail = [];
  createRequests = [];
  loseCreateResponse = false;
  pendingRun = undefined;
  sentMessages = [];
  currentUserId = "model-tester";
  directMessageReplay = false;
  storedMessages = [];
  historyAvailable = true;
  localStorage.clear();
  saved = { model: null, effort: null };
});

afterAll(async () => {
  await settleReactWork();
  if (originalIndexedDB)
    Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
/** The channel screen, as far as sending goes: the channel record and `ChannelChat` on it. */
function ChannelScreen() {
  const { channelId } = channelRoute.useParams();
  const { data } = useQuery(channelQueryOptions(channelId));
  return data ? <ChannelChat channel={data} runtimeAgentId={BOT} /> : null;
}
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: ChannelScreen,
});
const startRouteOptions = {
  id: "/start/$startId",
  path: "/start/$startId",
  getParentRoute: () => appRoute,
  component: StartRoute.options.component,
};
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([
      testChannelNewRoute,
      StartRoute.update(startRouteOptions),
      channelRoute,
    ]),
  ]),
]);

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
          <RouterProvider router={router} />
        </CopilotKitProvider>
      </QueryClientProvider>,
    ),
    { router },
  );
}

test("a saved first message from before model selection still sends", async () => {
  const id = crypto.randomUUID();
  const content = "Finish sending my older draft.";
  localStorage.setItem(
    `openbot:conversation-start:model-tester:${id}`,
    JSON.stringify({
      state: "pending",
      draft: {
        text: content,
        commandIds: [],
        attachments: [],
        recipient: { kind: "direct", agentId: BOT },
      },
      progress: { phase: "ready", channelId: channel.id },
    }),
  );

  renderAt(`/channel/${channel.id}`);

  await waitFor(() =>
    expect(sentMessages).toEqual([{ id, role: "user", content }]),
  );
  expect(trail).toEqual(["run"]);
});

test("switching accounts replaces the saved first message in an open conversation", async () => {
  const previousId = crypto.randomUUID();
  const previousDraft = {
    text: "First account's saved draft.",
    commandIds: [],
    attachments: [],
    recipient: { kind: "direct", agentId: BOT },
    model: null,
  } satisfies pendingStarts.StartDraft;
  pendingStarts.savePendingStart("model-tester", previousId, {
    state: "pending",
    draft: previousDraft,
    progress: { phase: "submitted", channelId: channel.id },
  });
  const nextId = crypto.randomUUID();
  const nextText = "Second account's saved draft.";
  pendingStarts.savePendingStart("another-tester", nextId, {
    state: "pending",
    draft: { ...previousDraft, text: nextText },
    progress: { phase: "ready", channelId: channel.id },
  });
  await queryClient.fetchQuery(currentUserQueryOptions());
  const view = renderAt(`/channel/${channel.id}`);
  await view.findByText(previousDraft.text);
  await view.findByRole("button", { name: "Check for message" });

  currentUserId = "another-tester";
  await act(async () => {
    await queryClient.invalidateQueries(currentUserQueryOptions());
  });

  await waitFor(() => {
    expect(view.queryByText(previousDraft.text)).toBeNull();
    expect(sentMessages).toEqual([
      { id: nextId, role: "user", content: nextText },
    ]);
  });
  expect(
    pendingStarts.readPendingStart("model-tester", previousId)?.state,
  ).toBe("pending");
});

test("two open conversations sharing a saved first message dispatch it once", async () => {
  const message = {
    id: crypto.randomUUID(),
    role: "user",
    content: "Send this once across tabs.",
  };
  const run = Promise.withResolvers<void>();
  pendingRun = run.promise;
  pendingStarts.savePendingStart("model-tester", message.id, {
    state: "pending",
    draft: {
      text: message.content,
      commandIds: [],
      attachments: [],
      recipient: { kind: "direct", agentId: BOT },
      model: null,
    },
    progress: { phase: "ready", channelId: channel.id },
  });
  renderAt(`/channel/${channel.id}`);
  const other = renderAt(`/channel/${channel.id}`);
  try {
    // The first run is still open when the other view checks for delivery.
    await other.findByRole(
      "button",
      { name: "Check for message" },
      { timeout: 8000 },
    );
    expect(sentMessages).toEqual([message]);
  } finally {
    run.resolve();
  }
  await waitFor(() =>
    expect(
      pendingStarts.readPendingStart("model-tester", message.id)?.state,
    ).toBe("finished"),
  );
  expect(sentMessages).toEqual([message]);
});

for (const scenario of [
  "resend",
  "already delivered",
  "check only",
  "history offline",
] as const) {
  test(`an interrupted first send resolves through the Thread: ${scenario}`, async () => {
    directMessageReplay = scenario !== "check only";
    const message = {
      id: crypto.randomUUID(),
      role: "user",
      content: "Recover my first message.",
    };
    pendingStarts.savePendingStart("model-tester", message.id, {
      state: "pending",
      draft: {
        text: message.content,
        commandIds: [],
        attachments: [],
        recipient: { kind: "direct", agentId: BOT },
        model: null,
      },
      progress: { phase: "submitted", channelId: channel.id },
    });
    const view = renderAt(`/channel/${channel.id}`);
    const button = await view.findByRole("button", {
      name: scenario === "check only" ? "Check for message" : "Resend message",
    });
    expect(
      view.getByText(
        scenario === "check only"
          ? "Check whether your first message arrived."
          : "Your first message hasn’t appeared in the conversation.",
      ),
    ).toBeTruthy();
    expect(sentMessages).toEqual([]);
    if (scenario === "already delivered") storedMessages = [message];
    if (scenario === "history offline") historyAvailable = false;
    await userEvent.setup({ document }).click(button);

    if (scenario === "check only" || scenario === "history offline") {
      const checkAgain = await view.findByRole("button", {
        name: "Check for message",
      });
      expect(checkAgain).toBe(button);
      expect(document.activeElement).toBe(checkAgain);
      expect(view.getByText(/without sending (a copy|it again)/)).toBeTruthy();
      expect(
        pendingStarts.readPendingStart("model-tester", message.id)?.state,
      ).toBe("pending");
    } else {
      await waitFor(() =>
        expect(
          pendingStarts.readPendingStart("model-tester", message.id)?.state,
        ).toBe("finished"),
      );
    }
    expect(sentMessages).toEqual(scenario === "resend" ? [message] : []);
  });
}

test("a model and effort picked before the first message survive reload and are saved before it runs", async () => {
  queryClient.setQueryData(agentKeys.list(false), [bot]);
  loseCreateResponse = true;
  const view = renderAt(`/channel/new?agent=${BOT}`);
  const user = userEvent.setup({ document });

  expect(await view.findByRole("combobox", { name: "To" })).toBeTruthy();

  // OpenBot's own model, at its own default effort, until the person picks.
  await user.click(
    await view.findByRole("combobox", {
      name: "Model: GPT-5.5, thinking: Medium",
    }),
  );
  await user.click(
    within(await view.findByRole("dialog")).getByRole("option", {
      name: "GPT-6.1 Terra",
    }),
  );
  // The popup stays open on the model's efforts, so the effort is picked in the same go.
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-6.1 Terra, thinking: Medium",
    }),
  ).toBeTruthy();
  await user.click(
    within(await view.findByRole("dialog")).getByRole("option", {
      name: "Extra high",
    }),
  );
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-6.1 Terra, thinking: Extra high",
    }),
  ).toBeTruthy();
  // Nothing is saved while the conversation does not exist.
  expect(trail).toEqual([]);

  const editor = await view.findByRole("textbox", { name: "Message" });
  await user.click(editor);
  await user.keyboard("Summarise the quarter.{Enter}");

  await view.findByText("Couldn't continue the conversation.");
  const startPath = view.router.state.location.pathname;
  const startId = startPath.slice("/start/".length);
  expect(startPath).toStartWith("/start/");
  view.unmount();
  const reloaded = renderAt(startPath);
  await waitFor(() => expect(trail).toContain("run"), { timeout: 5000 });
  expect(reloaded.router.state.location.pathname).toBe(
    `/channel/${channel.id}`,
  );
  expect(createRequests).toEqual([
    { agentIds: [BOT], requestId: startId },
    { agentIds: [BOT], requestId: startId },
  ]);
  expect(sentMessages).toEqual([
    { id: startId, role: "user", content: "Summarise the quarter." },
  ]);
  expect(trail.slice(0, 4)).toEqual([
    "create",
    "create",
    "save gpt-6.1-terra xhigh",
    "run",
  ]);
  expect(saved).toEqual({ model: "gpt-6.1-terra", effort: "xhigh" });
});
