import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import type { SharedUseRequest } from "@/lib/plugins/shared-use";
import { settleReactWork } from "./settle-react-work";

/** Admin → Approvals: the team-wide controls and team rules, in one place for administrators. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const sent: { path: string; method: string; body: unknown }[] = [];
let sharedRequests: SharedUseRequest[];
let sharedReadFailed: boolean;
let approvalReadFailed: boolean;

const inbox = {
  enabled: false,
  requests: [
    {
      id: "request-1",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: {
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "thread",
        args: { element: "Pay now" },
        target: {},
        toolCallId: "pay-call",
        policy: {
          behaviour: "hand_off",
          source: "safety",
          reason:
            "Paying, purchasing or moving money is always done by the person.",
        },
      },
    },
  ],
  rules: [
    {
      id: "mine",
      botId: "*",
      toolRef: "mcp/gmail/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    },
  ],
  teamRules: [
    {
      id: "locked",
      botId: "*",
      toolRef: "mcp/drive/share",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    },
  ],
  preferences: { enabled: false, autoReview: false, hostCommands: "allow" },
  team: {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
  },
  hostCommands: "ask",
  questions: [],
};

beforeEach(() => {
  sent.length = 0;
  sharedRequests = [];
  sharedReadFailed = false;
  approvalReadFailed = false;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url === "/api/approvals/shared-use/approval-1/approve") {
          sharedRequests = [];
          sharedReadFailed = true;
        }
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals")
        return approvalReadFailed
          ? Response.json({}, { status: 503 })
          : Response.json(inbox);
      if (url === "/api/approvals/shared-use")
        return sharedReadFailed
          ? Response.json({}, { status: 503 })
          : Response.json({ requests: sharedRequests });
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role: "admin" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

test("shared requests recover in place and approval requires confirmation", async () => {
  sharedReadFailed = true;
  sharedRequests = [
    {
      id: "approval-1",
      botId: "ops",
      botName: "Operations",
      ownerUserId: "me",
      serverId: "calendar",
      title: "Calendar",
      proposed: { audience: "team", outsideInput: true, members: [] },
      current: { audience: "owner", outsideInput: false, members: [] },
      reason: "publish",
      requestedBy: "me",
      status: "pending",
      createdAt: "2026-11-23T08:00:00.000Z",
    },
  ];
  const user = userEvent.setup({ document });
  const view = draw();
  await view.findByText("Couldn't load shared account requests.");
  expect(
    view.queryByText("No shared account requests awaiting review."),
  ).toBeNull();
  sharedReadFailed = false;
  await user.click(view.getByRole("button", { name: "Retry" }));
  const approve = await view.findByRole("button", {
    name: "Approve",
  });
  await user.click(approve);
  await view.findByRole("alertdialog", {
    name: "Approve shared access for Operations?",
  });
  await user.click(view.getByRole("button", { name: "Cancel" }));
  expect(sent).toEqual([]);
  await user.click(approve);
  await user.click(
    await view.findByRole("button", { name: "Approve request" }),
  );
  await view.findByText("Request approved for Operations.");
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(sent).toEqual([
    {
      path: "/api/approvals/shared-use/approval-1/approve",
      method: "POST",
      body: undefined,
    },
  ]);
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** On Admin → Approvals, inside a router: the screen links on to describing rules in words. */
function draw() {
  const root = createRootRoute({ component: TeamApprovalSettings });
  const describe = createRoute({
    path: "/admin/approvals/describe",
    getParentRoute: () => root,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([describe]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an administrator sets the team-wide controls", async () => {
  const view = draw();
  await view.findByText("Team settings");
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("combobox", {
      name: "Commands on members' computers, at most",
    }),
  );
  await user.click(await view.findByRole("option", { name: "Never" }));
  expect(sent).toEqual([]);
  expect(await view.findByRole("alertdialog")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Change team setting" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team",
      method: "PATCH",
      body: { hostCommandsCap: "never" },
    }),
  );
  // Team rules only: a member's own rules are theirs, in Settings.
  expect(view.getAllByRole("button", { name: /^Remove / }).length).toBe(1);
});

test("a failed team rules refresh pauses editing until recovery", async () => {
  const view = draw();
  const user = userEvent.setup({ document });
  const remove = await view.findByRole("button", { name: /^Remove / });
  await user.click(remove);
  approvalReadFailed = true;
  await user.click(view.getByRole("button", { name: "Remove rule" }));
  await view.findByRole("button", { name: "Try again" }, { timeout: 4000 });
  await user.click(view.getByRole("button", { name: "Cancel" }));
  const add = view.getByRole("button", { name: /Add a team rule/ });
  expect(remove.hasAttribute("disabled")).toBe(true);
  expect(add.hasAttribute("disabled")).toBe(true);
  expect(sent).toEqual([]);

  approvalReadFailed = false;
  await user.click(view.getByRole("button", { name: "Refresh team rules" }));
  await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
  expect(remove.hasAttribute("disabled")).toBe(false);
});

test("an administrator adds a team rule for every Bot", async () => {
  const view = draw();
  await view.findByText("Add a team rule");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Add a team rule/ }));
  await user.type(
    await view.findByRole("textbox", { name: "Tool or app" }),
    "mcp/slack/*",
  );
  await user.click(view.getByRole("button", { name: "Save rule" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team/rules",
      method: "POST",
      body: {
        botId: "*",
        toolRef: "mcp/slack/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    }),
  );
});
