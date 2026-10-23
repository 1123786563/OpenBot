import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { LiveScreen } from "@/components/computer/live-screen";
import { queryClient } from "@/query-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";

/*
 * The router modules read `@tanstack/router-core/isServer`, which resolves through Node's `node`
 * export condition to a constant decided from NODE_ENV at module-eval time. Left unset (the native
 * runner's default), that constant says "server": the router never mounts its client-side
 * Transitioner and RouterProvider crashes in Matches ("Cannot read properties of undefined
 * (reading '0')") — the same signature that routed the repo's other router-rendering suites to the
 * driven layer (tests/config/e2e-bun-suites.json, the admin-catalog-sync-ui entry). bun test
 * sets NODE_ENV=test on the driven layer, so the router behaves there; the fact is now stated
 * process-wide in `preload.ts` (H14 — the full-native sweep caught this file losing the
 * module-eval race against `button-native.test.tsx`, which imports the router statically), and
 * this file keeps its own statement before the router modules evaluate as belt-and-suspenders.
 */
let routerReact!: typeof import("@tanstack/react-router");
let DemonstrationRecorder!: typeof import("@/components/computer/demonstration-recorder")["DemonstrationRecorder"];

/**
 * This page's own fields while a person drives a Bot's browser.
 *
 * LiveScreen takes every keystroke on the window while someone holds the wheel, because the canvas
 * cannot hold focus. The full-size view also carries fields of its own, the recorder's workflow name
 * and the secret box, and taking their keys left them dead: typing into "Workflow name" did nothing,
 * and every letter went to the Bot's browser instead. And the recorder's button, a Base UI Button,
 * defaults to type="button", so pressing it never submitted the form and no recording ever started.
 *
 * The schedule form the recorder opens for a published skill carries the page's Select (H10): its
 * "report in" choice must stay a two-way toggle. BASE's native select listed "this Bot's only
 * conversation" (`<option value="">`) as a real option, so a channel could be un-picked; the Select
 * migration briefly reduced that to a placeholder, and this file pins the path back.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

const requests: { method: string; url: string; body: unknown }[] = [];

/** A stopped-and-published recording, so the recorder offers "Run on a schedule". */
const published = {
  id: "d1",
  botId: "fields-test",
  title: "Find an invoice",
  status: "published",
  actions: [
    {
      kind: "click",
      target: { role: "button", name: "Search", sensitive: false },
    },
  ],
  draft: null,
  skillSlug: "find-an-invoice",
  createdAt: "2026-10-20T08:00:00Z",
  finishedAt: "2026-10-20T08:01:00Z",
  expiresAt: "2026-10-20T08:10:00Z",
  maxDurationMs: 600_000,
  reachedTimeLimit: false,
};

/** Two conversations: only the one the Bot belongs to may report somewhere. */
const channels = [
  {
    id: "ch-billing",
    name: "Billing",
    agentIds: ["fields-test"],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-20T07:00:00Z",
    pinned: false,
    lastReadAt: null,
  },
  {
    id: "ch-elsewhere",
    name: "Elsewhere",
    agentIds: ["other-bot"],
    threadId: "thread-2",
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-20T07:00:00Z",
    pinned: false,
    lastReadAt: null,
  },
];

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;

beforeAll(async () => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.includes("/control"))
      return Response.json({ holder: "human", transitioning: false });
    if (url === "/api/channels")
      return Response.json({ channels, nextCursor: null });
    if (url.startsWith("/api/demonstrations/") && url.endsWith("/schedule"))
      return Response.json({
        routine: {
          id: "r1",
          agentId: "fields-test",
          channelId: "ch-billing",
          cron: "0 9 * * 1-5",
          timezone: "UTC",
          instruction: "",
          nextRunAt: "2026-10-21T09:00:00Z",
        },
      });
    if (url.startsWith("/api/demonstrations") && method === "POST")
      return Response.json({ demonstration: { id: "d1" } });
    if (url.startsWith("/api/demonstrations"))
      return Response.json({ demonstrations: [published] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  // Stated before the router modules are imported: see the comment above the declarations.
  process.env.NODE_ENV = "test";
  routerReact = await import("@tanstack/react-router");
  ({ DemonstrationRecorder } = await import(
    "@/components/computer/demonstration-recorder"
  ));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  requests.length = 0;
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function Field() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Workflow name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

async function driving(extra?: React.ReactNode) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      {withRouter(
        <>
          <LiveScreen computerId="fields-test" driving />
          {extra}
        </>,
      )}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  // Input is sent only once ownership is confirmed; wait for the screen to say so.
  await waitFor(() =>
    expect(document.querySelector("canvas")?.dataset.connected).toBe("true"),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { socket, view, user };
}

/**
 * Router context for the recorder's links ("Edit /slug" on a published recording, "See routines"
 * after a schedule lands): the paths exist so the links render, and no route mounts anything.
 */
function withRouter(node: ReactNode) {
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
  } = routerReact;
  const rootRoute = createRootRoute({ component: () => node });
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => null,
  });
  const routinesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/routines",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([skillsRoute, routinesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

test("typing into a field on this page while driving fills it and sends nothing", async () => {
  const { socket, view, user } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name") as HTMLInputElement;

  await user.click(field);
  await user.keyboard("Find an invoice");

  expect(field.value).toBe("Find an invoice");
  expect(socket.sent).toEqual([]);
});

test("a paste into a field on this page stays in the field", async () => {
  const { socket, view } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "invoice" },
  });

  field.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("keys with no field focused still go to the Bot's browser", async () => {
  const { socket } = await driving(<Field />);
  const key = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    bubbles: true,
    cancelable: true,
  });

  document.body.dispatchEvent(key);

  expect(key.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
    },
  ]);
});

test("naming a workflow and pressing Record your steps starts a recording", async () => {
  const { socket, view, user } = await driving(
    <DemonstrationRecorder
      botId="fields-test"
      driving
      onRecordingChange={() => {}}
    />,
  );

  await user.click(view.getByLabelText("Workflow name"));
  await user.keyboard("Find an invoice");
  await user.click(view.getByRole("button", { name: "Record your steps" }));

  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" && request.url === "/api/demonstrations",
      ),
    ).toEqual([
      {
        method: "POST",
        url: "/api/demonstrations",
        body: { botId: "fields-test", title: "Find an invoice" },
      },
    ]),
  );
  expect(socket.sent.filter((message) => message.type === "key")).toEqual([]);
});

/** The recorder alone (no live screen): enough to open the schedule form for the published skill. */
function recorder() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      {withRouter(
        <DemonstrationRecorder
          botId="fields-test"
          driving
          onRecordingChange={() => {}}
        />,
      )}
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user };
}

test("schedule Select triggers show translated labels for every preset and custom cron", async () => {
  const { view, user } = recorder();
  await view.findByText(/Find an invoice/);
  await user.click(view.getByRole("button", { name: "Run on a schedule" }));

  const trigger = () => view.getByRole("button", { name: /when it runs/i });
  expect(trigger().textContent).toContain("Every weekday at 09:00");
  for (const [label] of [
    ["Every day at 09:00", "0 9 * * *"],
    ["Every Monday at 09:00", "0 9 * * 1"],
    ["Every hour", "0 * * * *"],
    ["Every weekday at 09:00", "0 9 * * 1-5"],
    ["Custom cron expression", "custom"],
  ]) {
    await user.click(trigger());
    await user.click(await view.findByRole("option", { name: label }));
    expect(trigger().textContent).toContain(label);
  }
});

test("a schedule reported to a channel can go back to this Bot's only conversation", async () => {
  const { view, user } = recorder();
  await view.findByText(/Find an invoice/);
  await user.click(view.getByRole("button", { name: "Run on a schedule" }));

  // Until a channel is picked, the trigger says the conversation-only sentence (BASE's `value=""`).
  const trigger = () => view.getByRole("button", { name: "Report in" });
  expect(trigger().textContent).toContain("This Bot's only conversation");
  expect(trigger().hasAttribute("data-placeholder")).toBe(false);

  await user.click(trigger());
  await user.click(await view.findByRole("option", { name: "Billing" }));
  expect(trigger().textContent).toContain("Billing");

  // The toggle-back: BASE's `<option value="">` stays in the list after a channel was chosen.
  await user.click(trigger());
  await user.click(
    await view.findByRole("option", { name: "This Bot's only conversation" }),
  );
  expect(trigger().textContent).toContain("This Bot's only conversation");

  await user.click(view.getByRole("button", { name: "Schedule" }));
  await waitFor(() =>
    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/schedule"),
      ),
    ).toBeDefined(),
  );
  // No channelId: the routine reports in the conversation, exactly the BASE payload for `""`.
  expect(
    requests.find(
      (request) =>
        request.method === "POST" && request.url.endsWith("/schedule"),
    )?.body,
  ).toEqual({
    cron: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});
