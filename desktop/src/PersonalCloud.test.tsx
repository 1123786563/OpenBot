import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type CloudAction,
  type CloudView,
  PersonalCloud,
} from "./PersonalCloud";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterEach(cleanup);
afterAll(() => {
  if (GlobalRegistrator.isRegistered) return GlobalRegistrator.unregister();
});

test("a cancelled browser sign-in can be restarted and returned to the existing workspace", async () => {
  const actions: CloudAction[] = [];
  let status: CloudView = { kind: "signedOut" };
  const request = async (action: CloudAction): Promise<CloudView> => {
    actions.push(action);
    if (action === "start") status = { kind: "waiting" };
    if (action === "cancel") status = { kind: "signedOut" };
    return status;
  };
  const screen = within(
    render(<PersonalCloud request={request} showLocal={async () => {}} />)
      .container,
  );
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: "Sign in with browser" }),
  );
  await screen.findByText("Finish signing in in your browser.");
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await user.click(
    await screen.findByRole("button", { name: "Sign in with browser" }),
  );
  const existingWorkspace = {
    kind: "workspace",
    accessMs: 60_000,
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    quotas: {
      bot: { used: 4, limit: 4 },
      computer: { used: null, limit: 1 },
      storage: { used: 32, limit: 64 },
      automation: { used: 0, limit: 30 },
    },
    conversations: [
      {
        id: "conversation-1",
        title: "Weekend <plans>",
        preview: "Saturday at nine",
      },
    ],
  } satisfies CloudView;
  status = existingWorkspace;
  await screen.findByText("My Assistant");
  await screen.findByRole("heading", { name: "Recent conversations" });
  expect(screen.getByText("Weekend <plans>")).toBeTruthy();
  expect(screen.getByText("Saturday at nine")).toBeTruthy();
  expect(screen.getByText("Bot runs: 4 / 4")).toBeTruthy();
  expect(screen.getByText("Computers: Unavailable / 1")).toBeTruthy();
  expect(
    actions.filter((action) => action === "start" || action === "cancel"),
  ).toEqual(["start", "cancel", "start"]);
});

test("cloud configuration errors still leave a direct local entry", async () => {
  let openedLocal = false;
  const screen = within(
    render(
      <PersonalCloud
        request={async () => ({ kind: "unavailable" })}
        showLocal={async () => {
          openedLocal = true;
        }}
      />,
    ).container,
  );
  const user = userEvent.setup({ document });
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Sign in with browser" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open local OpenBot" }));
  expect(openedLocal).toBe(true);
});

test("first entry runs shared setup and keeps a retry when setup fails", async () => {
  let preparations = 0;
  const request = async (action: CloudAction): Promise<CloudView> => {
    if (action === "status") return { kind: "preparing" };
    if (action !== "prepare") throw new Error(`Unexpected action: ${action}`);
    if (++preparations === 1) throw new Error("Temporary setup error");
    return {
      kind: "workspace",
      accessMs: 60_000,
      id: "workspace-1",
      personalAssistant: { id: "bot-1", name: "My Assistant" },
      conversations: [],
    };
  };
  const screen = within(render(<PersonalCloud request={request} />).container);
  const user = userEvent.setup({ document });
  await screen.findByRole("alert");
  expect(preparations).toBe(1);
  await user.click(screen.getByRole("button", { name: "Retry setup" }));
  await screen.findByText("My Assistant");
  expect(screen.getByText("No conversations yet.")).toBeTruthy();
  expect(preparations).toBe(2);
});

test("returning to the cloud window rechecks workspace access before showing the assistant", async () => {
  let status: CloudView = {
    kind: "workspace",
    accessMs: 60_000,
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    conversations: [
      { id: "conversation-1", title: "Existing title", preview: null },
    ],
  };
  const screen = within(
    render(<PersonalCloud request={async () => status} />).container,
  );
  await screen.findByText("My Assistant");

  expect(screen.getByText("Existing title")).toBeTruthy();
  status = { kind: "signedOut" };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  await screen.findByRole("button", { name: "Sign in with browser" });
  expect(screen.queryByText("My Assistant")).toBeNull();
  expect(screen.queryByText("Existing title")).toBeNull();
});

test("a verified paused account shows support and an operation ID instead of workspace content", async () => {
  const paused = {
    kind: "paused",
    operationId: "pause-123",
    reason: "Trial paused for review.",
    supportEmail: "support@example.com",
  } satisfies CloudView;
  const screen = within(
    render(<PersonalCloud request={async () => paused} />).container,
  );
  await screen.findByRole("heading", { name: "Personal Workspace paused" });
  expect(screen.getByText("Trial paused for review.")).toBeTruthy();
  expect(screen.getByText("pause-123")).toBeTruthy();
  expect(screen.getByText("support@example.com")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Recent conversations" }),
  ).toBeNull();
});

test("a cloud window drops conversation content at the server deadline", async () => {
  const request = async (): Promise<CloudView> => ({
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    conversations: [
      { id: "conversation-1", title: "Private title", preview: null },
    ],
    accessMs: 350,
  });
  const screen = within(render(<PersonalCloud request={request} />).container);
  await screen.findByText("Private title");
  await screen.findByRole("alert", {}, { timeout: 2000 });
  expect(screen.queryByText("Private title")).toBeNull();
});

test("an offline foreground transition discards an outstanding successful cloud response", async () => {
  const workspace = {
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    conversations: [
      { id: "conversation-1", title: "Private title", preview: null },
    ],
    accessMs: 60_000,
  } satisfies CloudView;
  const pending = Promise.withResolvers<CloudView>();
  const checking = Promise.withResolvers<void>();
  let request = async (): Promise<CloudView> => workspace;
  const screen = within(
    render(<PersonalCloud request={() => request()} />).container,
  );
  await screen.findByText("Private title");

  request = () => {
    checking.resolve();
    return pending.promise;
  };
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await checking.promise;
  expect(screen.queryByText("Private title")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
    pending.resolve(workspace);
  });
  await screen.findByRole("alert");
  expect(screen.queryByText("Private title")).toBeNull();

  request = async () => workspace;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await screen.findByText("Private title");
});

test("restored access shows stopped background work, outcomes and per-item recovery", async () => {
  const confirmedActions: [string, string, boolean][] = [];
  const status = {
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    conversations: [],
    accessMs: 60_000,
    interruptedBackgroundWork: [
      {
        key: "handoff:1",
        label: "Bot handoff",
        summary: "Prepare the briefing",
        reasonMessage: "The workspace was paused.",
        outcomeUnknown: true,
        output: "Partial briefing",
        recoveryCanRetry: true,
        recovery: null,
      },
      {
        key: "notification:1",
        label: "Background notification",
        summary: null,
        reasonMessage: "The workspace was paused.",
        outcomeUnknown: true,
        output: null,
        recoveryCanRetry: false,
        recovery: null,
      },
    ],
    computer: { status: "restart_required", cutoff: "confirmed" },
    automation: {
      routines: [
        {
          id: "routine-1",
          title: "Morning briefing",
          enabled: true,
          blockedReason: "manual_resume_required",
        },
      ],
      bindings: [],
    },
  } satisfies CloudView;
  const actions: object[] = [];
  const screen = within(
    render(
      <PersonalCloud
        request={async () => status}
        recover={async (key, action, acknowledged) => {
          confirmedActions.push([key, action, acknowledged]);
        }}
        workspaceAction={async (action) => {
          actions.push(action);
          return action.kind === "history"
            ? {
                runs: [
                  {
                    id: "run-1",
                    timestamp: "2026-11-21T01:00:00.000Z",
                    outcome: "skipped",
                    reason: "The workspace was paused.",
                  },
                ],
              }
            : null;
        }}
      />,
    ).container,
  );
  const user = userEvent.setup({ document });
  const stopped = within(
    await screen.findByRole("region", { name: "Stopped work" }),
  );
  expect(stopped.getByText("Partial briefing")).toBeTruthy();
  expect(
    stopped.getAllByRole("button", { name: "Start fresh work" }),
  ).toHaveLength(1);
  await user.click(stopped.getByRole("button", { name: "Start fresh work" }));
  expect(confirmedActions).toEqual([]);
  await user.click(
    stopped.getByRole("checkbox", { name: "I checked the external actions." }),
  );
  await user.click(stopped.getByRole("button", { name: "Start fresh work" }));
  expect(confirmedActions).toEqual([["handoff:1", "retry", true]]);
  await user.click(
    await screen.findByRole("button", { name: "Start Computer" }),
  );
  await user.click(await screen.findByRole("button", { name: "View history" }));
  await screen.findByText(/skipped · The workspace was paused/);
  await user.click(await screen.findByRole("button", { name: "Resume" }));
  expect(actions).toEqual([
    { kind: "computer", action: "start" },
    { kind: "history", resource: "routines", id: "routine-1" },
    { kind: "resume", resource: "routines", id: "routine-1" },
  ]);
  await act(async () => window.dispatchEvent(new Event("offline")));
  expect(screen.queryByText(/skipped · The workspace was paused/)).toBeNull();
});

test("the authorized workspace opens export in the system browser", async () => {
  const actions: CloudAction[] = [];
  const workspace: CloudView = {
    kind: "workspace",
    accessMs: 60_000,
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    conversations: [],
  };
  const request = async (action: CloudAction) => {
    actions.push(action);
    return workspace;
  };
  const screen = within(render(<PersonalCloud request={request} />).container);
  const user = userEvent.setup({ document });
  const button = { name: "Export workspace data in browser" };
  await user.click(await screen.findByRole("button", button));
  expect(actions.filter((action) => action === "export")).toEqual(["export"]);
  await act(async () => window.dispatchEvent(new Event("offline")));
  expect(screen.queryByRole("button", button)).toBeNull();
});
