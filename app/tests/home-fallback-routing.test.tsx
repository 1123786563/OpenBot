import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pluginKeys } from "@/lib/plugins/queries";
import {
  agent,
  createdChannel,
  queryClientWithAgents,
  readChannelRequest,
  renderHome,
  submitHomeMessage,
} from "./home-fallback-routing.fixture";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // prompt-area positions its skill menu at a caret with a non-empty box.
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
});

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
  localStorage.clear();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function installHomeRoutingFetch(options: {
  routeResponse: Response;
  starts: string[][];
}) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route") return options.routeResponse.clone();
      if (url === "/api/channels" && init?.method === "POST") {
        const { agentIds } = readChannelRequest(init);
        options.starts.push(agentIds);
        return createdChannel(`channel-${options.starts.length}`, agentIds);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

// Teach a Bot's Try it, once a Bot learned a task from a recording: a new conversation with the task in the box.
test("/ starts the box with the words a link hands over, and sends them only when the person does", async () => {
  const own = agent({
    id: "own-public",
    mine: true,
    name: "Own Public",
    visibility: "public",
  });
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json({ error: "router down" }, { status: 503 }),
    starts,
  });
  const view = renderHome(
    queryClientWithAgents([own]),
    "/?ask=Find%20my%20meeting",
  );
  const box = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(box.textContent).toBe("Find my meeting"));
  expect(starts).toEqual([]);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Send message" }));
  await waitFor(() => expect(starts).toEqual([["own-public"]]));
});

test("/ fallback routing matches the server default when route selection is unavailable", async () => {
  const ownPublic = agent({
    id: "own-public",
    mine: true,
    name: "Own Public",
    visibility: "public",
  });
  const sharedPublic = agent({
    id: "shared-public",
    mine: false,
    name: "Shared Public",
    visibility: "public",
  });
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json({ error: "router down" }, { status: 503 }),
    starts,
  });
  const view = renderHome(queryClientWithAgents([ownPublic, sharedPublic]));

  await submitHomeMessage(view, "hello");

  await waitFor(() => expect(starts).toEqual([["own-public"]]));
});

test("/ keeps a successful route decision ahead of the fallback", async () => {
  const ownPublic = agent({
    id: "own-public",
    mine: true,
    name: "Own Public",
    visibility: "public",
  });
  const sharedPublic = agent({
    id: "shared-public",
    mine: false,
    name: "Shared Public",
    visibility: "public",
  });
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json({
      agentId: "shared-public",
      fallback: false,
      name: "Shared Public",
      reason: "matched",
      viaMention: false,
    }),
    starts,
  });
  const view = renderHome(queryClientWithAgents([ownPublic, sharedPublic]));

  await submitHomeMessage(view, "hello");

  await waitFor(() => expect(starts).toEqual([["shared-public"]]));
});

for (const refusal of [
  {
    status: 409,
    body: {
      error: "More than one coworker matches that name.",
      names: ["Data Analyst", "Risk Analyst"],
    },
    message: "Data Analyst, Risk Analyst",
  },
]) {
  test(`routing refusal ${refusal.status} preserves the draft and shows the explanation without starting a fallback`, async () => {
    const starts: string[][] = [];
    installHomeRoutingFetch({
      routeResponse: Response.json(refusal.body, { status: refusal.status }),
      starts,
    });
    const view = renderHome(
      queryClientWithAgents([
        agent({ id: "default", name: "Default", visibility: "public" }),
      ]),
    );
    await submitHomeMessage(view, "ask analyst");
    await waitFor(() =>
      expect(view.getByText(refusal.message, { exact: false })).toBeTruthy(),
    );
    expect(starts).toEqual([]);
    expect(view.getByText("ask analyst")).toBeTruthy();
  });
}

test("send opens the placeholder at once, before a Bot is picked or a channel made", async () => {
  const asked: string[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Only the writes: the page's own reads (who is signed in, the roster) are not the start.
      if (init?.method === "POST")
        asked.push(typeof input === "string" ? input : input.toString());
      // Routing never answers: whatever is on screen got there without it.
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderHome(
    queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]),
  );

  await submitHomeMessage(view, "hello");

  expect(await view.findByText("hello")).toBeTruthy();
  expect(view.router.state.location.pathname).toStartWith("/start/");
  expect(asked).toEqual(["/api/route"]);
});

test("a failed start is reachable from Home without replacing a new draft", async () => {
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json(
      {
        error: "More than one coworker matches that name.",
        names: ["Data Analyst", "Risk Analyst"],
      },
      { status: 409 },
    ),
    starts,
  });
  const view = renderHome(
    queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]),
  );

  await submitHomeMessage(view, "ask analyst");
  await view.findByText("Data Analyst, Risk Analyst", { exact: false });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("link", { name: "Back to Home" }));
  const composer = await view.findByRole("textbox", { name: "Message" });
  await user.type(composer, "something new");
  expect(composer.textContent).toBe("something new");
  await user.click(
    view.getByRole("link", { name: /Resume conversation · ask analyst/ }),
  );
  expect(await view.findByText("ask analyst")).toBeTruthy();
  expect(starts).toEqual([]);
});

for (const status of [409, 500]) {
  test(`skill routing failure ${status} preserves the message without starting an incompatible fallback`, async () => {
    const starts: string[][] = [];
    const requests: unknown[] = [];
    installHomeRoutingFetch({
      routeResponse: Response.json(
        { error: "Cannot route these skills" },
        { status },
      ),
      starts,
    });
    const installed = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/route")
          requests.push(JSON.parse(String(init?.body)));
        return installed(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]);
    client.setQueryData(pluginKeys.forAgent("default"), {
      tools: [],
      skills: [
        { slug: "first", title: "First skill", instructions: "Use first" },
      ],
    });
    const view = renderHome(client);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(await view.findByRole("textbox", { name: "Message" }));
    await user.keyboard("/first");
    await user.click(await view.findByRole("option", { name: /First skill/ }));
    await user.click(await view.findByRole("button", { name: "Send message" }));
    await view.findByText("Cannot route these skills");
    expect(requests).toEqual([{ text: "/first", skillSlugs: ["first"] }]);
    expect(starts).toEqual([]);
    expect(view.getByText("/first")).toBeTruthy();
  });
}
