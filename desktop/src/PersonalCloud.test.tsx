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
