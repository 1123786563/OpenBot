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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryClient } from "@/query-client";
import { Route as ComponentRoute } from "@/routes/_authed/admin/components/$name";
import type { ComponentRecord } from "@/lib/components/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
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

function open() {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/admin/components",
    component: () => null,
  });
  const one = (
    ComponentRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/_authed/admin/components/$name",
    path: "/admin/components/$name",
    getParentRoute: () => root,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, one]),
    history: createMemoryHistory({
      initialEntries: [`/admin/components/${NAME}`],
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
    expect(publications()[0]?.body).toEqual({ published: false });
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
      { published: false },
      { published: false },
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
    expect(publications()[0]?.body).toEqual({ published: false });
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
    expect(publications()[0]?.body).toEqual({ published: true });
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
      { published: true },
      { published: true },
    ]);
    expect(view.getByText("Description published.")).toBeTruthy();
  });
});
