import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ConversationAccessEnded,
  ConversationUnavailable,
} from "@/components/channels/conversation-status";
import { ClientError } from "@/lib/client";
import { settleReactWork } from "./settle-react-work";

/*
 * A conversation that could not be opened, or that this person can no longer read, used to end in
 * one sentence and nothing else: "You can't access this group conversation." with a Retry that
 * could never succeed, or a bare "Conversation access ended." A person sent there by an old link
 * had no way on but editing the address.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a read the server refused says so, drops the retry, and offers the way back", () => {
  const view = render(
    <ConversationUnavailable
      denied="You can't access this conversation."
      error={new ClientError("Not yours.", 403)}
      title="Couldn't open this conversation."
    />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "You can't access this conversation.",
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(
    view.getByRole("link", { name: "Back to Home" }).getAttribute("href"),
  ).toBe("/");
});

test("a read that failed keeps its retry beside the way back", () => {
  let tried = 0;
  const view = render(
    <ConversationUnavailable
      denied="You can't access this conversation."
      description="You can try again."
      error={new ClientError("Down.", 503)}
      retry={() => {
        tried += 1;
      }}
      title="Couldn't open this conversation."
    />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Couldn't open this conversation.",
  );
  expect(view.getByText("You can try again.")).toBeTruthy();
  expect(view.getByRole("link", { name: "Back to Home" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(tried).toBe(1);
});

test("a conversation whose access ended mid-conversation is explained with the way back", () => {
  const view = render(
    <ConversationAccessEnded title="Conversation access ended." />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Conversation access ended.",
  );
  expect(
    view.getByRole("link", { name: "Back to Home" }).getAttribute("href"),
  ).toBe("/");
  expect(view.queryByRole("button")).toBeNull();
});
