import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ChatPanel } from "@/components/craft/chat-panel";
import { SessionSidebar } from "@/components/craft/session-sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * THE SESSION TITLE: an unnamed session is named by the LLM the moment its first user message
 * is durable — never before the send-message write lands (the naming read would see no user
 * message and fall back), and never for a session the person already named.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const session = (name: string | null) => ({
  id: "s1",
  user_id: "u1",
  name,
  status: "active",
  created_at: "2026-10-12T10:00:00Z",
  last_activity_at: "2026-10-12T10:00:00Z",
  nextjs_port: null,
  sharing_scope: "private",
  origin: "INTERACTIVE",
  agent_provider: null,
  agent_model: null,
  opencode_session_id: null,
  skills_stale: false,
});

/** Every request in flight order — the ordering assertions are the point of this file. */
const calls: { method: string; url: string }[] = [];

function serving(sessionName: string | null) {
  calls.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "GET" && url === "/api/craft/sessions/s1/messages") {
      return Response.json({ messages: [] });
    }
    if (method === "GET" && url === "/api/craft/sessions/s1") {
      return Response.json(session(sessionName));
    }
    if (method === "GET" && url === "/api/craft/sessions") {
      return Response.json({ sessions: [session(sessionName)] });
    }
    if (url === "/api/craft/sessions/s1/approvals/live") {
      return Response.json({ approvals: [] });
    }
    if (method === "POST" && url === "/api/craft/sessions/s1/send-message") {
      return Response.json({
        turn_id: "t1",
        session_id: "s1",
        status: "running",
        turn_index: 0,
      });
    }
    if (url === "/api/craft/sessions/s1/turns/t1/events") {
      return new Response(
        'event: message\ndata: {"type":"prompt_response"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (method === "POST" && url === "/api/craft/sessions/s1/generate-name") {
      return Response.json({ name: "Landing page build" });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The session page's own shape: sidebar roster + conversation, one shared query cache. */
function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <div className="flex">
        <SessionSidebar />
        <ChatPanel sessionId="s1" />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Type one message and send it with Enter, waiting until the composer is ready. */
async function sendOneMessage(view: RenderResult, text: string) {
  const box = (await view.findByRole("textbox")) as HTMLTextAreaElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  // TYPED RATHER THAN SET — a controlled box here reads keystrokes, not a change event
  // fired at the element (see connection-fields.test.tsx for the same lesson).
  const user = userEvent.setup({ document });
  await user.type(box, text);
  await user.type(box, "{Enter}");
}

test("an unnamed session is titled after its first message lands, ordered after the send", async () => {
  serving(null);
  const view = draw();
  await sendOneMessage(view, "Build me a landing page");

  await waitFor(() => {
    const send = calls.findIndex((call) => call.url.endsWith("/send-message"));
    const named = calls.findIndex((call) => call.url.endsWith("/generate-name"));
    expect(send).toBeGreaterThanOrEqual(0);
    expect(named).toBeGreaterThanOrEqual(0);
    // The naming read must happen after the user row is durable.
    expect(named).toBeGreaterThan(send);
  });

  // The sidebar's roster refreshes once the name lands.
  await waitFor(() => {
    const roster = calls.findLastIndex(
      (call) => call.method === "GET" && call.url === "/api/craft/sessions",
    );
    const named = calls.findIndex((call) => call.url.endsWith("/generate-name"));
    expect(roster).toBeGreaterThan(named);
  });
});

test("a session that already has a name is never re-titled", async () => {
  serving("Existing name");
  const view = draw();
  await sendOneMessage(view, "One more thing");

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/send-message"))).toBe(true),
  );
  await settleReactWork();
  expect(
    calls.some((call) => call.url.endsWith("/generate-name")),
  ).toBe(false);
});
