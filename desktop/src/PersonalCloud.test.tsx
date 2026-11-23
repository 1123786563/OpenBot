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
    testCredits: {
      state: "issued",
      amountMicrocredits: "100",
      balance: { availableMicrocredits: "0" },
      usedUp: true,
      quote: {
        model: "Pilot model",
        route: "pilot",
        priceVersion: "00000000-0000-4000-8000-000000000000",
        price: { inputPerMillion: 1_000, outputPerMillion: 2_000 },
        maxChargeMicrocredits: "250",
        usageDisclosure: "Interrupted requests may still use Test Credits.",
      },
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
  expect(screen.getByText("Test Credits are used up.")).toBeTruthy();
  expect(screen.getByText(/Pilot model costs 1000 microcredits/)).toBeTruthy();
  expect(
    screen.getByText(/Maximum reservation per run: 250 microcredits/),
  ).toBeTruthy();
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

test("an authorized owner can submit a managed text run and read its settled charge", async () => {
  let requestIdBeforeFailure = "";
  const originalVersion = "00000000-0000-4000-8000-000000000000";
  const updatedVersion = "00000000-0000-4000-8000-000000000001";
  let version = originalVersion;
  let attempts = 0;
  const screen = within(
    render(
      <PersonalCloud
        request={async () => ({
          kind: "workspace",
          accessMs: 2500,
          id: "workspace-1",
          personalAssistant: { id: "bot-1", name: "My Assistant" },
          testCredits: {
            state: "issued",
            amountMicrocredits: "1000",
            balance: { availableMicrocredits: "1000" },
            usedUp: false,
            quote: {
              model:
                version === originalVersion
                  ? "Pilot model"
                  : "Updated pilot model",
              route: "pilot",
              priceVersion: version,
              price: { inputPerMillion: 1000, outputPerMillion: 2000 },
              maxChargeMicrocredits: "250",
              usageDisclosure:
                "Interrupted requests may still use Test Credits.",
            },
          },
          conversations: [],
        })}
        botRuns={{
          start: async ({
            workspaceId,
            botId,
            instruction,
            requestId,
            quote,
          }) => {
            expect({ workspaceId, botId, instruction }).toEqual({
              workspaceId: "workspace-1",
              botId: "bot-1",
              instruction: "Hello",
            });
            expect(requestId).toMatch(/^[a-f\d-]{36}$/i);
            attempts++;
            if (attempts === 1) {
              expect(quote).toEqual({
                route: "pilot",
                priceVersion: originalVersion,
              });
              requestIdBeforeFailure = requestId;
              throw "The response was lost.";
            }
            if (attempts === 2) {
              expect(requestId).toBe(requestIdBeforeFailure);
              expect(quote).toEqual({
                route: "pilot",
                priceVersion: originalVersion,
              });
              return { error: "test_credit_quote_changed" };
            }
            expect(requestId).not.toBe(requestIdBeforeFailure);
            expect(quote).toEqual({
              route: "pilot",
              priceVersion: updatedVersion,
            });
            return { runId: "run-1" };
          },
          status: async (runId) => {
            expect(runId).toBe("run-1");
            return {
              state: "completed",
              output: "Managed answer",
              testCredit: {
                model: "Pilot model",
                state: "settled",
                heldMicrocredits: "0",
                chargedMicrocredits: "3",
                releasedMicrocredits: "247",
              },
            };
          },
          stop: async () => {},
        }}
      />,
    ).container,
  );
  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("Instruction"), "Hello");
  await user.click(
    screen.getByRole("button", { name: "Run with Test Credits" }),
  );
  await screen.findByText("The response was lost.");
  await user.click(screen.getByRole("button", { name: "Retry submission" }));
  await screen.findByText(/Test Credit pricing changed/);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Run with Test Credits",
    }).disabled,
  ).toBe(true);
  version = updatedVersion;
  await screen.findByText(/Updated pilot model costs/, undefined, {
    timeout: 3000,
  });
  await user.click(
    screen.getByRole("button", { name: "Run with Test Credits" }),
  );
  await screen.findByText("Managed answer");
  expect(screen.getByText(/Charged 3 microcredits/)).toBeTruthy();

  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(screen.queryByText("Managed answer")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByText("Managed answer");
});

test("focus while offline cannot reopen protected content", async () => {
  const workspace = {
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "Private assistant" },
    conversations: [],
    accessMs: 60_000,
  } satisfies CloudView;
  let checks = 0;
  const screen = within(
    render(
      <PersonalCloud
        request={async () => {
          checks++;
          return workspace;
        }}
      />,
    ).container,
  );
  await screen.findByText("Private assistant");
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(Boolean(screen.queryByText("Private assistant"))).toBe(false);
  expect(checks).toBe(1);

  await act(async () => window.dispatchEvent(new Event("online")));
  await screen.findByText("Private assistant");
  expect(checks).toBe(2);
});

test("a pending poll cannot undo a newer sign-out response", async () => {
  const workspace = {
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "Private assistant" },
    conversations: [],
    computer: { status: "not_started", cutoff: null },
    accessMs: 4_000,
  } satisfies CloudView;
  const pollStarted = Promise.withResolvers<void>();
  const poll = Promise.withResolvers<CloudView>();
  const action = Promise.withResolvers<null>();
  let checks = 0;
  const screen = within(
    render(
      <PersonalCloud
        request={async () => {
          switch (++checks) {
            case 1:
              return workspace;
            case 2:
              pollStarted.resolve();
              return poll.promise;
            default:
              return { kind: "signedOut" };
          }
        }}
        workspaceAction={() => action.promise}
      />,
    ).container,
  );
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: "Start Computer" }),
  );
  await pollStarted.promise;
  await act(async () => action.resolve(null));
  await screen.findByRole("button", { name: "Sign in with browser" });
  await act(async () => poll.resolve(workspace));
  expect(Boolean(screen.queryByText("Private assistant"))).toBe(false);
  expect(
    screen.getByRole("button", { name: "Sign in with browser" }),
  ).toBeTruthy();
});
