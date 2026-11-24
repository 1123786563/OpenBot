import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  CHANNEL_SETUP_DOCS,
  UpdateRoutingSection,
} from "@/components/settings/update-routing";
import { authKeys } from "@/lib/auth/queries";
import type { Reachability } from "@/lib/delivery";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Where updates go, now in Settings: one decision for all of a person's Bots, so it is no longer
 * repeated on every Bot's page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ADMIN = { role: "admin", localEvaluation: false };
const writes: { request: string; body: unknown }[] = [];
const everyKind = {
  progress: ["push"],
  decision: "all",
  question: "all",
  attention: "all",
};
const everyChannel = { slack: true, teams: true, sms: true, push: true };
let routing: Record<string, unknown> = everyKind;
let available: Record<string, boolean> = everyChannel;
let deliveries: Reachability["deliveries"] = [];
let deliveryStatus = 200;
let saveStatus = 200;
afterEach(() => {
  routing = everyKind;
  available = everyChannel;
  deliveries = [];
  deliveryStatus = 200;
  saveStatus = 200;
});
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${String(input)}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: saveStatus === 200 }, { status: saveStatus });
    }
    // Every channel set up unless a case says otherwise, so each switch reflects the person's preference.
    if (String(input).endsWith("/api/delivery")) {
      return Response.json(
        { bindings: [], devices: [], deliveries, available },
        { status: deliveryStatus },
      );
    }
    return Response.json({ routing });
  }) as unknown as typeof fetch;
}

test("switching a transport on for one kind of update saves that kind's transports", async () => {
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByRole("switch", { name: "Progress by SMS" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "sms"] },
  });
});

test("pings get their own row, Something needs you", async () => {
  routing = {
    progress: ["push"],
    decision: "all",
    question: "all",
    attention: ["push", "slack"],
  };
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Something needs you")).toBeTruthy();
  const sms = view.getByRole("switch", { name: "Something needs you by SMS" });
  expect(
    sms instanceof HTMLInputElement
      ? sms.checked
      : sms.getAttribute("aria-checked") === "true",
  ).toBe(false);
  fireEvent.click(sms);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/attention",
    body: { transports: ["push", "slack", "sms"] },
  });
});

test("delivery failure appears only for its update type and channel", async () => {
  routing = { ...everyKind, progress: "all" };
  deliveries = [
    {
      id: "approval",
      transport: "sms",
      kind: "approval",
      state: "failed",
      error: "Provider unavailable",
      createdAt: "2026-11-24T00:00:00Z",
    },
    {
      id: "reply",
      transport: "sms",
      kind: "reply",
      state: "sent",
      error: null,
      createdAt: "2026-11-23T00:00:00Z",
    },
  ];
  serving();
  const view = draw();
  const warning = await view.findByText("Latest SMS delivery failed");
  expect(view.getAllByText("Latest SMS delivery failed")).toHaveLength(1);
  expect(warning.closest('[data-slot="item"]')?.textContent).toContain(
    "Approvals",
  );
  expect(warning.closest("details")?.textContent).toContain(
    "Provider unavailable",
  );
});

/** Who is looking: an admin, or someone running OpenBot themselves, can set channels up; anyone else can't. */
function draw(who: { role: string; localEvaluation: boolean } = ADMIN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), { role: who.role });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: who.localEvaluation,
    edition: "team",
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
}

test("delivery recovery confirms which switches to show and save recovery keeps newer preferences", async () => {
  available = { ...everyChannel, slack: false, teams: false };
  deliveryStatus = 503;
  saveStatus = 503;
  serving();
  const view = draw();
  const retryDelivery = await view.findByRole("button", {
    name: "Retry delivery channels",
  });
  expect(view.queryAllByRole("switch")).toHaveLength(0);

  deliveryStatus = 200;
  fireEvent.click(retryDelivery);
  const sms = await view.findByRole("switch", { name: "Progress by SMS" });
  expect(view.queryByRole("switch", { name: "Progress by Slack" })).toBeNull();
  fireEvent.click(sms);
  const retrySave = await view.findByRole("button", {
    name: "Retry saving Progress by SMS",
  });
  expect(view.getByText("Couldn't save Progress by SMS.")).toBeTruthy();
  expect(writes.map(({ body }) => body)).toEqual([
    { transports: ["push", "sms"] },
  ]);

  routing = { ...everyKind, progress: ["push", "slack"] };
  saveStatus = 200;
  fireEvent.click(retrySave);
  await waitFor(() =>
    expect(view.queryByText("Couldn't save Progress by SMS.")).toBeNull(),
  );
  expect(writes.map(({ body }) => body)).toEqual([
    { transports: ["push", "sms"] },
    { transports: ["push", "slack", "sms"] },
  ]);
});

test("only channels that are set up get a switch, and a save keeps the others as they were", async () => {
  available = { slack: true, teams: false, sms: false, push: true };
  routing = { ...everyKind, progress: ["push", "sms"] };
  serving();
  const view = draw();
  const slack = await view.findByRole("switch", { name: "Progress by Slack" });
  expect(view.queryByRole("switch", { name: "Progress by SMS" })).toBeNull();
  expect(view.queryByText("Microsoft Teams")).toBeNull();
  expect(view.queryByText("Not set up")).toBeNull();
  fireEvent.click(slack);
  await waitFor(() => expect(writes).toHaveLength(1));
  // SMS is not set up and has no switch, but the person's choice for it is still saved as it was.
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "slack", "sms"] },
  });
});

test("with no channel set up, it says updates stay in OpenBot, and whoever can set them up gets the way to", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw(ADMIN);
  expect(await view.findByText("Updates stay in OpenBot")).toBeTruthy();
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(
    view.getByText(
      "Push, Slack, Microsoft Teams and text messages show up here once they're set up where OpenBot runs.",
    ),
  ).toBeTruthy();
  const how = view.getByRole("link", { name: "How to set them up" });
  expect(how.getAttribute("href")).toBe(CHANNEL_SETUP_DOCS);
  expect(how.getAttribute("target")).toBe("_blank");
});

test("the section asks where updates go only above switches to choose with", async () => {
  const ASK = /Choose where to receive each type of update/;
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const empty = draw(ADMIN);
  expect(await empty.findByText("Updates stay in OpenBot")).toBeTruthy();
  expect(empty.queryByText(ASK)).toBeNull();
  cleanup();
  available = everyChannel;
  serving();
  const choosing = draw(ADMIN);
  await choosing.findByRole("switch", { name: "Progress by Slack" });
  expect(choosing.getByText(ASK)).toBeTruthy();
});

test("in OpenBot Desktop, where these channels can't reach anyone, it says so and links no setup docs", async () => {
  // What the Desktop window injects (`desktopShell`): the page is inside OpenBot Desktop.
  const shell = window as { __TAURI_INTERNALS__?: unknown };
  shell.__TAURI_INTERNALS__ = {
    invoke: async () => undefined,
    transformCallback: () => 0,
  };
  try {
    available = { slack: false, teams: false, sms: false, push: false };
    serving();
    const view = draw({ role: "member", localEvaluation: true });
    expect(
      await view.findByText(
        "Push, Slack, Microsoft Teams and text messages need OpenBot running on a server.",
      ),
    ).toBeTruthy();
    expect(view.queryByRole("link", { name: "How to set them up" })).toBeNull();
  } finally {
    delete shell.__TAURI_INTERNALS__;
  }
});

test("someone running OpenBot on their own computer gets the way to set channels up too", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw({ role: "member", localEvaluation: true });
  expect(
    await view.findByRole("link", { name: "How to set them up" }),
  ).toBeTruthy();
});

test("a member who can't set channels up is told their admin does, with no link", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw({ role: "member", localEvaluation: false });
  expect(
    await view.findByText(
      "Push, Slack, Microsoft Teams and text messages show up here once your admin sets them up.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("link", { name: "How to set them up" })).toBeNull();
});
