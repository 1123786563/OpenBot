import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentRecord } from "@/lib/components/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
import { queryClient } from "@/query-client";
import { Route as ComponentRoute } from "@/routes/_authed/admin/components/$name";
import { Route as ListRoute } from "@/routes/_authed/admin/components/index";
import { Route as PlaygroundRoute } from "@/routes/_authed/admin/playground";
import { settleReactWork } from "./settle-react-work";

/**
 * The Published switch and Publish description on Admin → UI components → one component, against a
 * fake `fetch` that holds the component the way the server does.
 *
 * The switch commits before its Audit row, so a refusal is very often a change that happened. What
 * these hold is that the screen then reads the server rather than the press: it never draws the
 * opposite of what is in force, it says what landed, and the way to record it is a safe retry.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const NAME = "showActivityReport";
const PUBLISHED = "Draw an activity report for a person.";
const DRAFT = "Draw an activity report, with the days they chose.";

function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    name: NAME,
    title: "Activity report",
    kind: "chart",
    draftDescription: PUBLISHED,
    publishedDescription: PUBLISHED,
    published: true,
    publishedAt: "2026-11-20T09:00:00.000Z",
    updatedBy: "admin@acme.test",
    updatedAt: "2026-11-20T09:00:00.000Z",
    hasUnpublishedChanges: false,
    withheldFrom: [],
    functions: [],
    ...overrides,
  };
}

/** What the server writes: publishing promotes the draft, unpublishing only closes the switch. */
function publishedAs(current: ComponentRecord, value: boolean) {
  return value
    ? {
        ...current,
        published: true,
        publishedDescription: current.draftDescription,
        hasUnpublishedChanges: false,
      }
    : { ...current, published: false };
}

let component: ComponentRecord;
let writes: { path: string; body: Record<string, unknown> }[];
/** What the server answers a publication with, when it is not a plain success. */
let publication: { status: number; body: unknown } | null;
/** Whether the write lands before the response is lost, as a failed Audit insert does. */
let lands: boolean;
/** Held until released, so a second press is made while the first is still in flight. */
let gate: Promise<void> | null;
let release: () => void;
const originalFetch = global.fetch;
/** This build can draw it, which is what makes the row writable. */
const names = gallery.RENDERABLE_NAMES as Set<string>;
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  component = record();
  writes = [];
  publication = null;
  lands = false;
  gate = null;
  release = () => {};
  names.add(NAME);
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET") writes.push({ path, body });
    if (path === "/api/sandboxed") {
      return method === "GET"
        ? Response.json({ components: [] })
        : Response.json({ error: "Temporary outage" }, { status: 503 });
    }
    if (path === "/api/components")
      return Response.json({ components: [component] });
    if (path === "/api/components/functions")
      return Response.json({ functions: [] });
    if (path === "/api/agents")
      return Response.json({ agents: [{ id: "bot-ada", name: "Ada" }] });
    if (path === `/api/components/${NAME}/publication`) {
      if (gate) await gate;
      if (publication) {
        if (lands)
          component = publishedAs(component, body.published as boolean);
        return Response.json(publication.body, { status: publication.status });
      }
      component = publishedAs(component, body.published as boolean);
      return Response.json({ published: body.published });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  names.delete(NAME);
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});

function open(at = `/admin/components/${NAME}`) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/admin/components",
    component: ListRoute.options.component,
  });
  const one = (
    ComponentRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/_authed/admin/components/$name",
    path: "/admin/components/$name",
    getParentRoute: () => root,
  });
  const playground = createRoute({
    getParentRoute: () => root,
    path: "/admin/playground",
    component: PlaygroundRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, one, playground]),
    history: createMemoryHistory({
      initialEntries: [at],
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

const publications = () =>
  writes.filter((write) => write.path.endsWith("/publication"));

async function switchOff(view: ReturnType<typeof render>) {
  const toggle = await view.findByRole("switch", { name: "Published" });
  await waitFor(() =>
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true"),
  );
  return toggle;
}

describe("the Published switch", () => {
  test("a lost response reads the server, so the switch is never the opposite of what is in force", async () => {
    // The write landed and the response did not: the server holds it unpublished, the press failed.
    publication = { status: 500, body: { error: "The gateway timed out." } };
    lands = true;
    const { view, user } = open();
    const toggle = await switchOff(view);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);

    expect(await view.findByRole("alert")).toBeTruthy();
    // What the server holds, not what the screen held before the press.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(view.getByText("No Bot can use it.")).toBeTruthy();
    expect(publications()).toHaveLength(1);
    expect(publications()[0]?.body).toEqual({
      published: false,
      expectedUpdatedAt: "2026-11-20T09:00:00.000Z",
    });
  });

  test("a stale publication refreshes the switch and requires a new decision", async () => {
    publication = {
      status: 409,
      body: { error: "Publication or its draft changed." },
    };
    lands = true;
    const { view, user } = open();
    const toggle = await switchOff(view);
    await user.click(toggle);
    expect((await view.findByRole("alert")).textContent).toContain(
      "Publication or its draft changed.",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      view.getByRole("button", { name: "Try again" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(publications()).toHaveLength(1);
  });

  test("a publication the trail could not record says what landed, and Retry records it", async () => {
    publication = {
      status: 500,
      body: {
        error:
          "The component is unpublished, but Audit couldn't record the change. Try again to record it.",
        published: false,
      },
    };
    lands = true;
    const { view, user } = open();
    const toggle = await switchOff(view);

    await user.click(toggle);

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain(
      "The component is unpublished, but Audit couldn't record the change.",
    );
    // In force, and drawn that way: the retry must not be the opposite press.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(view.getByText("No Bot can use it.")).toBeTruthy();

    publication = null;
    await user.click(view.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(publications().map((write) => write.body)).toEqual([
      { published: false, expectedUpdatedAt: "2026-11-20T09:00:00.000Z" },
      { published: false, expectedUpdatedAt: "2026-11-20T09:00:00.000Z" },
    ]);
  });

  test("two presses of the switch while the first is in flight make one write", async () => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { view, user } = open();
    const toggle = await switchOff(view);

    await user.click(toggle);
    await waitFor(() => expect(publications()).toHaveLength(1));
    await user.click(toggle);

    expect(publications()).toHaveLength(1);
    release();
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(publications()).toHaveLength(1);
    expect(publications()[0]?.body).toEqual({
      published: false,
      expectedUpdatedAt: "2026-11-20T09:00:00.000Z",
    });
  });

  test("a refusal that changed nothing leaves the switch as it was and can be retried", async () => {
    publication = { status: 503, body: { error: "OpenBot is starting." } };
    const { view, user } = open();
    const toggle = await switchOff(view);

    await user.click(toggle);

    expect((await view.findByRole("alert")).textContent).toContain(
      "OpenBot is starting.",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    publication = null;
    await user.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(publications()).toHaveLength(2);
  });
});

describe("Publish description", () => {
  const withDraft = () => {
    component = record({
      draftDescription: DRAFT,
      hasUnpublishedChanges: true,
    });
  };

  test("asks first, and Cancel writes nothing and returns focus to the button", async () => {
    withDraft();
    const { view, user } = open();
    const opener = await view.findByRole("button", {
      name: "Publish description",
    });
    await waitFor(() =>
      expect((opener as HTMLButtonElement).disabled).toBe(false),
    );

    await user.click(opener);
    const dialog = await view.findByRole("alertdialog", {
      name: "Publish this description?",
    });
    expect(
      within(dialog).getByText(
        `Bots allowed to use Activity report will read the saved draft. The component stays published and Bot access stays the same.`,
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(writes).toEqual([]);
    expect(component.draftDescription).toBe(DRAFT);
    expect(document.activeElement).toBe(opener);
  });

  test("two presses of Publish make one write", async () => {
    withDraft();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { view, user } = open();
    const opener = await view.findByRole("button", {
      name: "Publish description",
    });
    await waitFor(() =>
      expect((opener as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(opener);
    const dialog = await view.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Publish description",
    });

    await user.click(confirm);
    await user.click(confirm);

    await waitFor(() => expect(publications()).toHaveLength(1));
    release();
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(publications()).toHaveLength(1);
    expect(publications()[0]?.body).toEqual({
      published: true,
      expectedUpdatedAt: "2026-11-20T09:00:00.000Z",
    });
  });

  test("a description that published but whose Audit row failed says so, and Try again records it", async () => {
    withDraft();
    publication = {
      status: 500,
      body: {
        error:
          "The component is published, but Audit couldn't record the change. Try again to record it.",
        published: true,
      },
    };
    lands = true;
    const { view, user } = open();
    const opener = await view.findByRole("button", {
      name: "Publish description",
    });
    await waitFor(() =>
      expect((opener as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(opener);
    const dialog = await view.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Publish description" }),
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "The component is published, but Audit couldn't record the change. Try again to record it.",
    );
    // Re-read behind the dialog: the description is published, so nothing is left to publish.
    await waitFor(() =>
      expect(
        view.queryByText(/A saved description draft is ready to publish/),
      ).toBeNull(),
    );
    expect(publications()).toHaveLength(1);

    // Try again sends the same publication to record it, though nothing is left to publish.
    publication = null;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(publications().map((write) => write.body)).toEqual([
      { published: true, expectedUpdatedAt: "2026-11-20T09:00:00.000Z" },
      { published: true, expectedUpdatedAt: "2026-11-20T09:00:00.000Z" },
    ]);
    expect(view.getByText("Description published.")).toBeTruthy();
  });
});

describe("the components list", () => {
  test("a failed read is retried in place, and focus returns to the heading", async () => {
    const serve = global.fetch;
    let unavailable = true;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).split("?")[0] === "/api/components" &&
          (init?.method ?? "GET") === "GET" &&
          unavailable
        ) {
          return Response.json({ error: "Temporary outage" }, { status: 503 });
        }
        return serve(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );

    const { view } = open("/admin/components");
    expect(await view.findByText("Couldn't load components.")).toBeTruthy();
    unavailable = false;
    const retry = view.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    expect(await view.findByText("Activity report")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    // The tile is still a link, so the failure keeps its list context.
    expect(view.getByTestId(`component-${NAME}`).tagName).toBe("A");
    // The retry button is gone; focus lands on the page it recovered, not on BODY.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("heading", { name: "UI components" }),
      ),
    );
  });
});

describe("Bot access", () => {
  test("Available to says what turning a Bot off does before any switch is pressed", async () => {
    const { view, user } = open();
    await user.click(await view.findByTestId(`grants-${NAME}`));
    const dialog = await view.findByRole("dialog", { name: "Available to" });
    expect(
      within(dialog).getByText(
        "Turn a Bot off to withhold this component from it.",
      ),
    ).toBeTruthy();
    // The switch that follows the sentence is the Bot grant it describes.
    expect(within(dialog).getByTestId(`grant-${NAME}-bot-ada`)).toBeTruthy();
  });
});

test("Playground explains who can use a component before publishing it", async () => {
  const { view, user } = open("/admin/playground");
  await user.type(await view.findByLabelText("Name"), "activity_report");
  await user.type(view.getByLabelText("Title"), "Activity report");
  await user.click(view.getByRole("button", { name: /^Publish$/ }));
  const dialog = await view.findByRole("alertdialog", {
    name: "Publish Activity report?",
  });
  const consequence =
    "Publishing makes it available to every Bot. Turn it off for one Bot on the UI components page.";
  expect(within(dialog).getByText(consequence)).toBeTruthy();
  expect(writes).toEqual([]);

  await user.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText(/your edits are still in the editor/i);
  expect(within(dialog).getByText(consequence)).toBeTruthy();
  expect(writes.map((write) => write.path)).toEqual(["/api/sandboxed"]);
});

test("a failed gallery tile still opens its detail and detail Retry focuses Preview", async () => {
  component = record({ kind: "sandboxed" });
  const serve = global.fetch;
  let unavailable = true;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).split("?")[0] === "/api/sandboxed" && unavailable) {
        return Response.json({ error: "Temporary outage" }, { status: 503 });
      }
      return serve(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );

  const { view, user } = open("/admin/components");
  const tile = await view.findByTestId(`component-${NAME}`);
  expect(
    await within(tile).findByText("Couldn't load the preview."),
  ).toBeTruthy();
  expect(tile.querySelector("button")).toBeNull();

  await user.click(tile);
  const retry = await view.findByRole("button", { name: "Retry" });
  unavailable = false;
  retry.focus();
  await user.keyboard("{Enter}");

  await view.findByText("Published in the playground.");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Preview" }),
    ),
  );
});
