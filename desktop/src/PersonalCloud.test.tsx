import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonalCloud, type CloudAction, type CloudView } from "./PersonalCloud";

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
  const screen = within(render(<PersonalCloud request={request} showLocal={async () => {}} />).container);
  const user = userEvent.setup({ document });
  await user.click(await screen.findByRole("button", { name: "Sign in with browser" }));
  await screen.findByText("Finish signing in in your browser.");
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await user.click(await screen.findByRole("button", { name: "Sign in with browser" }));
  status = { kind: "workspace", id: "workspace-1", personalAssistant: { id: "bot-1", name: "My Assistant" } };
  await screen.findByText("My Assistant");
  expect(actions.filter((action) => action === "start" || action === "cancel")).toEqual(["start", "cancel", "start"]);
});


test("cloud configuration errors still leave a direct local entry", async () => {
  let openedLocal = false;
  const screen = within(render(<PersonalCloud
    request={async () => ({ kind: "unavailable" })}
    showLocal={async () => { openedLocal = true; }}
  />).container);
  const user = userEvent.setup({ document });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Sign in with browser" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open local OpenBot" }));
  expect(openedLocal).toBe(true);
});

test("first entry runs shared setup and keeps a retry when setup fails", async () => {
  let preparations = 0;
  const request = async (action: CloudAction): Promise<CloudView> => {
    if (action === "status") return { kind: "preparing" };
    if (action !== "prepare") throw new Error(`Unexpected action: ${action}`);
    if (++preparations === 1) throw new Error("Temporary setup error");
    return { kind: "workspace", id: "workspace-1", personalAssistant: { id: "bot-1", name: "My Assistant" } };
  };
  const screen = within(render(<PersonalCloud request={request} />).container);
  const user = userEvent.setup({ document });
  await screen.findByRole("alert");
  expect(preparations).toBe(1);
  await user.click(screen.getByRole("button", { name: "Retry setup" }));
  await screen.findByText("My Assistant");
  expect(preparations).toBe(2);
});

test("returning to the cloud window rechecks workspace access before showing the assistant", async () => {
  let status: CloudView = {
    kind: "workspace",
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
  };
  const screen = within(render(<PersonalCloud request={async () => status} />).container);
  await screen.findByText("My Assistant");

  status = { kind: "signedOut" };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  await screen.findByRole("button", { name: "Sign in with browser" });
  expect(screen.queryByText("My Assistant")).toBeNull();
});
