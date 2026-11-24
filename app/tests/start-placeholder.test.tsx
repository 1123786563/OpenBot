import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agent,
  createdChannel,
  queryClientWithAgents,
  readChannelRequest,
  renderHome,
  submitHomeMessage,
} from "./home-fallback-routing.fixture";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;

const knowledge = agent({
  id: "knowledge",
  name: "Knowledge",
  title: "Company Knowledge",
  roleDescription: "Answers company questions.",
  builtIn: true,
  visibility: "public",
});

function renderAt(path: string, owner?: string) {
  return renderHome(queryClientWithAgents([knowledge], owner), path);
}

function answerRequests(
  answer: (url: string, init?: RequestInit) => Promise<Response>,
) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      answer(typeof input === "string" ? input : input.toString(), init),
    { preconnect: originalFetch.preconnect },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a Bot chosen with @ and the message appear in the Conversation handoff", async () => {
  answerRequests(async (url) => {
    if (url === "/api/route") return Response.json({ agentId: knowledge.id });
    if (url === "/api/channels") return new Promise<Response>(() => {});
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const view = renderAt("/");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const composer = await view.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  await user.keyboard("@Know");
  await user.click(await view.findByRole("option", { name: /Knowledge/ }));
  await user.keyboard("Summarize our onboarding policy");
  await user.click(view.getByRole("button", { name: "Send message" }));

  const transcript = within(
    await view.findByRole("region", { name: "Messages" }),
  );
  expect(
    await view.findByRole("heading", { level: 1, name: "Knowledge" }),
  ).toBeTruthy();
  expect(
    await transcript.findByText("Summarize our onboarding policy", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("reloading an interrupted creation keeps the first message and reuses its request ID", async () => {
  const requests: string[] = [];
  answerRequests(async (url, init) => {
    if (url === "/api/route") return Response.json({ agentId: knowledge.id });
    if (url === "/api/channels" && init?.method === "POST") {
      const { requestId, agentIds } = readChannelRequest(init);
      requests.push(requestId);
      if (requests.length === 1) throw new TypeError("Response lost");
      return createdChannel("channel-recovered", agentIds);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const message = "Keep this first conversation message";
  const original = renderAt("/");
  await submitHomeMessage(original, message);
  await original.findByText("Couldn't continue the conversation.", undefined, {
    timeout: 10_000,
  });
  const savedPath = original.router.state.location.pathname;
  expect(savedPath).toStartWith("/start/");
  expect(original.getByText(message)).toBeTruthy();
  expect(requests).toEqual([savedPath.slice("/start/".length)]);
  original.unmount();

  const otherOwner = renderAt(savedPath, "someone-else");
  await otherOwner.findByText("This conversation start is unavailable.");
  expect(otherOwner.queryByText(message)).toBeNull();
  const originalId = savedPath.slice("/start/".length);
  expect(requests).toEqual([originalId]);
  otherOwner.unmount();

  const reloaded = renderAt(savedPath);
  await reloaded.findByText("The conversation", undefined, { timeout: 10_000 });
  expect(reloaded.router.state.location.pathname).toBe(
    "/channel/channel-recovered",
  );
  expect(requests).toEqual([originalId, originalId]);
});

test("a handoff link with no saved start explains how to open a new Conversation", async () => {
  const view = renderAt("/start/missing");
  expect(
    await view.findByText("This conversation start is unavailable."),
  ).toBeTruthy();
  expect(
    view.getByRole("link", { name: "New conversation" }).getAttribute("href"),
  ).toBe("/channel/new");
  expect(view.router.state.location.pathname).toBe("/start/missing");
});

test("returning to a handoff that completed while on Home opens the same Conversation", async () => {
  const routing = Promise.withResolvers<Response>();
  let requests = 0;
  answerRequests(async (url, init) => {
    if (url === "/api/route") return routing.promise;
    if (url === "/api/channels" && init?.method === "POST") {
      requests++;
      return createdChannel("channel-made", readChannelRequest(init).agentIds);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const view = renderAt("/");
  await submitHomeMessage(view, "What were our Q3 numbers?");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("link", { name: "Back to Home" }));
  await view.findByRole("textbox", { name: "Message" });
  await act(async () => {
    routing.resolve(Response.json({ agentId: knowledge.id }));
  });
  await waitFor(() => expect(requests).toBe(1));
  expect(view.router.state.location.pathname).toBe("/");

  await user.click(
    view.getByRole("link", {
      name: "What were our Q3 numbers? Resume sending",
    }),
  );
  await view.findByText("The conversation");
  expect(view.router.state.location.pathname).toBe("/channel/channel-made");
  expect(requests).toBe(1);
});
