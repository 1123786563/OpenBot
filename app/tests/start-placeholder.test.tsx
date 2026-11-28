import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  discardPendingStart,
  savePendingStart,
} from "@/lib/channels/pending-start";
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

test("automatic routing keeps the start ID and waits for a confirmed quote", async () => {
  const quote = {
    creditType: "test",
    route: "routing-fixture",
    priceVersion: crypto.randomUUID(),
    provider: "fixture",
    model: "routing",
    price: { inputPerMillion: 10, outputPerMillion: 20 },
    maxChargeMicrocredits: "30",
    usageDisclosure: "Interrupted routing may still use Test Credits.",
  };
  const requests: unknown[] = [];
  let created = 0;
  answerRequests(async (url, init) => {
    if (url === "/api/route") {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? Response.json(
            { code: "routing_quote_required", quote },
            { status: 409 },
          )
        : Response.json({ agentId: knowledge.id });
    }
    if (url === "/api/channels" && init?.method === "POST") {
      created++;
      return createdChannel(
        "channel-quoted",
        readChannelRequest(init).agentIds,
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const view = renderAt("/");
  await submitHomeMessage(view, "Review the quarterly numbers");
  expect(await view.findByText("Use Test Credits to pick a Bot?")).toBeTruthy();
  expect(view.getByText(/Maximum 30 microcredits for routing/)).toBeTruthy();
  const requestId = view.router.state.location.pathname.slice("/start/".length);
  expect(requests).toEqual([
    { text: "Review the quarterly numbers", requestId },
  ]);
  expect(created).toBe(0);

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Confirm routing" }));
  await view.findByText("The conversation");
  expect(requests[1]).toMatchObject({
    requestId,
    confirmation: { route: quote.route, priceVersion: quote.priceVersion },
  });
  expect(created).toBe(1);
});

test("a first message stays recoverable in the current tab when site storage denies writes", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const storage = localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new Proxy(storage, {
      get(target, property) {
        if (property === "setItem" || property === "removeItem")
          return () => {
            throw new DOMException("Storage is denied.", "SecurityError");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  const message = "Keep this temporary first message";
  let id: string | undefined;
  try {
    answerRequests(async (url, init) => {
      if (url === "/api/route") return Response.json({ agentId: knowledge.id });
      if (url === "/api/channels" && init?.method === "POST") {
        id = readChannelRequest(init).requestId;
        return Response.json(
          { error: "Creation unavailable." },
          { status: 503 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const view = renderAt("/");
    await submitHomeMessage(view, message);
    await view.findByText(
      "This message is saved only in this tab. Copy it before closing or refreshing this tab.",
    );
    expect(view.getByText(message)).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Copy message text" }),
    ).toBeTruthy();
    const path = view.router.state.location.pathname;
    expect(path).toBe(`/start/${id}`);
    view.unmount();

    const home = renderAt("/");
    await home.findByRole("link", { name: new RegExp(message) });
    home.unmount();
    const other = renderAt(path, "another-person");
    await other.findByText("This conversation start is unavailable.");
    expect(other.queryByText(message)).toBeNull();
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    if (id) discardPendingStart("person", id);
  }
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

for (const failure of [
  {
    name: "refused",
    recipient: { kind: "route" } as const,
    route: () =>
      Response.json(
        {
          error: "More than one coworker matches that name.",
          names: ["Data Analyst", "Risk Analyst"],
        },
        { status: 409 },
      ),
  },
  {
    name: "creating",
    recipient: { kind: "direct", agentId: knowledge.id } as const,
    route: () => Response.json({ agentId: knowledge.id }),
  },
]) {
  test(`discarding a ${failure.name} start clears its saved message and leaves Home's resume list`, async () => {
    answerRequests(async (url, init) => {
      if (url === "/api/route") return failure.route();
      if (url === "/api/channels" && init?.method === "POST")
        return Response.json(
          { error: "Creation unavailable." },
          { status: 503 },
        );
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const startId = crypto.randomUUID();
    const message = "Discard this interrupted first message";
    savePendingStart("person", startId, {
      state: "pending",
      progress: { phase: "creating" },
      draft: {
        text: message,
        commandIds: [],
        attachments: [
          { attachmentId: "file-1", name: "notes.txt", type: "document" },
        ],
        recipient: failure.recipient,
        model: null,
      },
    });
    const homeBefore = renderAt("/");
    await homeBefore.findByRole("link", { name: new RegExp(message) });
    homeBefore.unmount();

    const view = renderAt(`/start/${startId}`);
    await view.findByText(message);
    await view.findByRole("button", { name: "Discard saved message" });
    if (failure.name === "creating")
      expect(
        view.getByText("Couldn't continue the conversation."),
      ).toBeTruthy();
    expect(localStorage.getItem(pendingStartKey("person", startId))).toContain(
      "notes.txt",
    );
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      view.getByRole("button", { name: "Discard saved message" }),
    );
    const confirmation = await view.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Discard saved message",
      }),
    );
    await view.findByRole("textbox", { name: "Message" });
    expect(view.router.state.location.pathname).toBe("/");
    expect(localStorage.getItem(pendingStartKey("person", startId))).toBeNull();

    const homeAfter = renderAt("/");
    await homeAfter.findByRole("textbox", { name: "Message" });
    expect(homeAfter.queryByText(message)).toBeNull();
    expect(
      homeAfter.queryByRole("link", { name: /Resume sending/ }),
    ).toBeNull();
  });
}

function pendingStartKey(owner: string, id: string) {
  return `openbot:conversation-start:${encodeURIComponent(owner)}:${id}`;
}

test("two open handoff views for one start create its Conversation once", async () => {
  const creating = Promise.withResolvers<Response>();
  const requests: string[] = [];
  answerRequests(async (url, init) => {
    if (url === "/api/channels" && init?.method === "POST") {
      const { requestId, agentIds } = readChannelRequest(init);
      requests.push(requestId);
      return creating.promise.then(() =>
        createdChannel("channel-shared", agentIds),
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const startId = crypto.randomUUID();
  savePendingStart("person", startId, {
    state: "pending",
    progress: { phase: "creating" },
    draft: {
      text: "Create this conversation once",
      commandIds: [],
      attachments: [],
      recipient: { kind: "direct", agentId: knowledge.id },
      model: null,
    },
  });
  const first = renderAt(`/start/${startId}`);
  const second = renderAt(`/start/${startId}`);
  await within(first.container).findByText("Create this conversation once");
  await within(second.container).findByText("Create this conversation once");
  await act(async () => {
    creating.resolve(createdChannel("channel-shared", [knowledge.id]));
  });
  await within(first.container).findByText("The conversation");
  await within(second.container).findByText("The conversation");
  expect(requests).toEqual([startId]);
});

test("a refused clipboard leaves the saved message readable and nothing is sent", async () => {
  const posts: string[] = [];
  answerRequests(async (url, init) => {
    if (url === "/api/route")
      return Response.json(
        {
          error: "More than one coworker matches that name.",
          names: ["Data Analyst", "Risk Analyst"],
        },
        { status: 409 },
      );
    posts.push(`${init?.method ?? "GET"} ${url}`);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const startId = crypto.randomUUID();
  const message = "Copy this saved first message";
  savePendingStart("person", startId, {
    state: "pending",
    progress: { phase: "creating" },
    draft: {
      text: message,
      commandIds: [],
      attachments: [],
      recipient: { kind: "route" },
      model: null,
    },
  });
  const view = renderAt(`/start/${startId}`);
  await view.findByText("Choose a Bot for this message.");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const writeText = spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard is denied.", "NotAllowedError"),
  );
  try {
    await user.click(view.getByRole("button", { name: "Copy message text" }));
    const field = await view.findByRole("textbox", {
      name: "Saved message text",
    });
    expect(field).toHaveProperty("value", message);
    expect(field).toHaveProperty("readOnly", true);
    expect(document.activeElement).toBe(field);
    expect(field).toHaveProperty("selectionStart", 0);
    expect(field).toHaveProperty("selectionEnd", message.length);
    expect(view.queryByText("Message text copied.")).toBeNull();
    expect(posts).toEqual([]);
  } finally {
    writeText.mockRestore();
  }
});

test("a handoff link with no saved start explains how to open a new Conversation", async () => {
  const view = renderAt("/start/missing");
  expect(
    await view.findByText("This conversation start is unavailable."),
  ).toBeTruthy();
  expect(
    view.getByText(/browser and account where you started it/),
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
