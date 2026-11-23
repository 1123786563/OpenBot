import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { passwordKeys } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";
import { Route } from "@/routes/_authed/sign-in/$requestId";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;
const requestId = "website-sign-in";
const threadId = "assigned-thread";
const rawMessage = "Vendor internals should not appear.";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderPage({
  status = "expired",
  responseStatus = 200,
  agents = ["fixture-bot"],
  matchingConversation = true,
}: {
  status?: "pending" | "expired";
  responseStatus?: number;
  agents?: string[];
  matchingConversation?: boolean;
} = {}) {
  const request = {
    id: requestId,
    botId: "fixture-bot",
    origin: "https://portal.example",
    reason: null,
    method: null,
    status,
    outcome: rawMessage,
    threadId,
    savedLogins: [],
  };
  const calls: string[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/channels") {
        return Response.json({
          channels: [
            {
              id: "assigned-channel",
              agentIds: agents,
              threadId: matchingConversation ? threadId : "another-thread",
            },
          ],
          nextCursor: null,
        });
      }
      if (path === "/api/agents/fixture-bot") {
        return Response.json({ agent: { name: "Expense Review" } });
      }
      if (responseStatus === 200) return Response.json(request);
      return Response.json({ error: rawMessage }, { status: responseStatus });
    },
    { preconnect: originalFetch.preconnect },
  );

  const root = createRootRoute();
  const authed = createRoute({ getParentRoute: () => root, id: "_authed" });
  const signIn = createRoute({
    getParentRoute: () => authed,
    path: "/sign-in/$requestId",
    component: Route.options.component,
  });
  const channel = createRoute({
    getParentRoute: () => authed,
    path: "/channel/$channelId",
  });
  const group = createRoute({
    getParentRoute: () => authed,
    path: "/group/$channelId",
  });
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([signIn, channel, group])]),
    history: createMemoryHistory({
      initialEntries: [
        `/sign-in/${requestId}?returnTo=https://untrusted.example`,
      ],
    }),
  });
  const tree = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    tree,
    request,
    calls,
    setReadStatus: (nextStatus = 200) => {
      responseStatus = nextStatus;
    },
  };
}

test("an expired request returns to its authenticated group conversation by keyboard", async () => {
  const { tree } = renderPage({ agents: ["fixture-bot", "another-bot"] });
  const user = userEvent.setup({ document });
  const recovery = await tree.findByRole("region", {
    name: "This sign-in link expired",
  });
  const link = await tree.findByRole("link", {
    name: "Return to conversation",
  });
  expect(document.activeElement).toBe(recovery);
  await user.tab();
  expect(document.activeElement).toBe(link);
  expect(link.getAttribute("href")).toBe("/group/assigned-channel");
  expect(tree.queryByText(rawMessage)).toBeNull();
});

test("expiration during entry removes the credentials and moves focus to recovery", async () => {
  const { tree, request, calls } = renderPage({ status: "pending" });
  const user = userEvent.setup({ document });
  const password = await tree.findByLabelText("Password");
  await user.type(password, "synthetic-secret");
  request.status = "expired";
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: passwordKeys.signIn(requestId),
    });
  });
  const recovery = await tree.findByRole("region", {
    name: "This sign-in link expired",
  });
  expect(document.activeElement).toBe(recovery);
  expect(tree.queryByLabelText("Password")).toBeNull();
  const link = await tree.findByRole("link", {
    name: "Return to conversation",
  });
  expect(link.getAttribute("href")).toBe("/channel/assigned-channel");
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

test("an unmatched thread falls back to the workspace", async () => {
  const { tree, calls } = renderPage({ matchingConversation: false });
  await tree.findByRole("heading", { name: "This sign-in link expired" });
  await settleReactWork();
  expect(calls).toContain("GET /api/channels");
  expect(
    tree.queryByRole("link", { name: "Return to conversation" }),
  ).toBeNull();
  expect(
    tree.getByRole("link", { name: "Open workspace" }).getAttribute("href"),
  ).toBe("/");
});

test("an unavailable request exposes no vendor copy and performs no conversation lookup", async () => {
  const { tree, calls } = renderPage({ responseStatus: 404 });
  await tree.findByRole("heading", {
    name: "This sign-in link is unavailable",
  });
  expect(
    tree.getByRole("link", { name: "Open workspace" }).getAttribute("href"),
  ).toBe("/");
  expect(tree.queryByText(rawMessage)).toBeNull();
  expect(calls).toEqual([`GET /api/sign-in-requests/${requestId}`]);
});

test("a failed read can be retried without posting credentials", async () => {
  const { tree, calls, setReadStatus } = renderPage({
    responseStatus: 503,
    status: "pending",
  });
  const user = userEvent.setup({ document });
  const retry = await tree.findByRole(
    "button",
    { name: "Retry" },
    { timeout: 3_000 },
  );
  expect(tree.queryByText(rawMessage)).toBeNull();
  setReadStatus();
  await user.tab();
  expect(document.activeElement).toBe(retry);
  await user.keyboard("{Enter}");
  expect(await tree.findByLabelText("Password")).toBeDefined();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      tree.getByRole("heading", { name: "Sign in for your Bot" }),
    ),
  );
  expect(
    await tree.findByText(/Expense Review needs access to continue/),
  ).toBeTruthy();
  expect(tree.getByText("https://portal.example")).toBeTruthy();
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

test("a transient refresh failure preserves credentials in the open form", async () => {
  const { tree, setReadStatus } = renderPage({ status: "pending" });
  const user = userEvent.setup({ document });
  const password = await tree.findByLabelText("Password");
  await user.type(password, "synthetic-secret");
  setReadStatus(503);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: passwordKeys.signIn(requestId) });
  await act(refresh);
  expect(await tree.findByText(/Couldn’t refresh this sign-in/)).toBeTruthy();
  expect(tree.getByLabelText("Password")).toBe(password);
  expect(password).toHaveProperty("value", "synthetic-secret");
  expect(document.activeElement).toBe(password);
  setReadStatus();
  await act(refresh);
  await waitFor(() =>
    expect(tree.queryByText(/Couldn’t refresh this sign-in/)).toBeNull(),
  );
  expect(password).toHaveProperty("value", "synthetic-secret");
}, 10_000);
