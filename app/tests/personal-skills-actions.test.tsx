import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { PluginSkill } from "@/lib/plugins/queries";
import { Route as SkillsRoute } from "@/routes/_authed/_app/capabilities.skills";
import { settleReactWork } from "./settle-react-work";

/**
 * Deleting a personal skill: who is asked, what the confirmation says, and what reaches the server.
 *
 * The confirmation has to name the Bots that offer the skill, because that is what deletion takes
 * away. A roster that could not be read is reported as unread, never as "no Bot offers it".
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `skills-read-failure.test.tsx`: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, queries off `render()`'s own return, a
 * `QueryClient` with `retry: false`, and the exported `Route` singleton captured and restored around
 * its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let writes: { method: string; path: string }[];
let skills: PluginSkill[];
let rosterStatus: number;
let hiddenRosterStatus: number;
/** The status the next DELETE answers with, or 200. */
let deleteStatus: number;

function skill(overrides: Partial<PluginSkill> = {}): PluginSkill {
  return {
    id: "skill-standup",
    slug: "standup",
    ownerUserId: "user-1",
    title: "Standup notes",
    summary: "Summarise yesterday",
    instructions: "Summarise what I did yesterday.",
    origin: "manual",
    installedBy: "user-1",
    grantedTo: ["bot-ada"],
    tools: [],
    ...overrides,
  };
}

beforeEach(() => {
  writes = [];
  skills = [skill()];
  rosterStatus = 200;
  hiddenRosterStatus = 200;
  deleteStatus = 200;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0] ?? url;
      const method = init?.method ?? "GET";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") {
        writes.push({ method, path: url });
        return new Response(null, { status: deleteStatus });
      }
      if (path === "/api/me")
        return json({
          user: {
            id: "user-1",
            email: "person@example.test",
            role: "user",
            onboarding: null,
          },
        });
      if (path === "/api/agents") {
        const hidden = url.includes("hidden=true");
        const status = hidden ? hiddenRosterStatus : rosterStatus;
        if (status !== 200) return new Response(null, { status });
        return json({
          agents: hidden
            ? [{ id: "bot-hidden", name: "Quiet", mine: true, hidden: true }]
            : [
                { id: "bot-ada", name: "Ada", mine: true, hidden: false },
                { id: "bot-grace", name: "Grace", mine: true, hidden: false },
                // Somebody else's Bot: a personal skill can never be granted to it.
                { id: "bot-other", name: "Theirs", mine: false, hidden: false },
              ],
        });
      }
      if (path === "/api/plugins")
        return json({
          catalogue: [],
          servers: [],
          skills,
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
          authorizesPerAction: false,
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

const pristineSkillsRouteState = captureRouteState(SkillsRoute);
let skillsRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  skillsRouteSnapshot = captureRouteState(pristineSkillsRouteState);
});

afterEach(() => {
  restoreRouteState(SkillsRoute, skillsRouteSnapshot);
});

/** `/capabilities/skills`, at the id its `Route.useSearch()` reads. */
function renderSkills(at = "/skills") {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const skillsRoute = (
    SkillsRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    path: "/skills",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([skillsRoute as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Opens the row's menu and chooses Delete, returning the confirmation. */
async function openDelete(view: ReturnType<typeof renderSkills>) {
  const user = userEvent.setup({ document });
  const trigger = await view.findByRole("button", {
    name: "Actions for Standup notes",
  });
  await user.click(trigger);
  await user.click(
    await view.findByRole("menuitem", { name: "Delete Standup notes" }),
  );
  const dialog = await view.findByRole("alertdialog", {
    name: "Delete Standup notes?",
  });
  return { user, trigger, dialog };
}

test("the confirmation names the Bots that offer the skill", async () => {
  skills = [skill({ grantedTo: ["bot-ada", "bot-grace"] })];
  const view = renderSkills();
  const { dialog } = await openDelete(view);
  expect(dialog.textContent).toContain("Ada and Grace offer this skill.");
  expect(dialog.textContent).not.toContain("Theirs");
  expect(writes).toEqual([]);
});

test("a Bot hidden from the roster is still named when it offers the skill", async () => {
  skills = [skill({ grantedTo: ["bot-hidden"] })];
  const view = renderSkills();
  const { dialog } = await openDelete(view);
  expect(dialog.textContent).toContain("Quiet offers this skill.");
});

test("a skill no Bot offers says so", async () => {
  skills = [skill({ grantedTo: [] })];
  const view = renderSkills();
  const { dialog } = await openDelete(view);
  expect(dialog.textContent).toContain("No Bot offers this skill.");
  expect(dialog.textContent).not.toMatch(/Ada|Grace|Quiet/);
});

test("an unreadable Bot list is reported as unread, not as no Bot", async () => {
  rosterStatus = 503;
  const view = renderSkills();
  const { dialog } = await openDelete(view);
  expect(dialog.textContent).toContain(
    "Couldn't read the Bot list, so this may not name every Bot that offers it.",
  );
  expect(dialog.textContent).not.toContain("No Bot offers this skill.");
});

test("Cancel sends nothing and returns focus to the row's menu button", async () => {
  const view = renderSkills();
  const { user, trigger, dialog } = await openDelete(view);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);
  expect(document.activeElement).toBe(trigger);
  expect(view.getByText("Standup notes")).toBeTruthy();
});

test("activating Delete twice sends one DELETE", async () => {
  // The first DELETE is held open, so the second activation lands while it is in flight.
  let release: () => void = () => {};
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serve = global.fetch;
  let attempts = 0;
  global.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method !== "DELETE") return serve(...args);
      // Counted as it arrives, before the hold: a second request would be a second attempt.
      attempts += 1;
      if (attempts === 1) await holding;
      return serve(...args);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderSkills();
  const { user, dialog } = await openDelete(view);
  const confirm = within(dialog).getByRole("button", {
    name: "Delete skill",
  });
  await user.click(confirm);
  await waitFor(() => expect(attempts).toBe(1));
  // In flight it reads "Deleting…" and is announced busy. A busy button is not natively disabled,
  // on purpose, so it keeps focus; activation must still send nothing.
  expect(
    within(dialog).getByRole("button", { name: "Deleting…" }),
  ).toBeTruthy();
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(confirm.getAttribute("aria-disabled")).toBe("true");
  confirm.click();
  fireEvent.click(confirm);
  expect(attempts).toBe(1);
  release();
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(attempts).toBe(1);
  expect(writes).toEqual([
    { method: "DELETE", path: "/api/plugins/skills/standup" },
  ]);
});

test("a failed delete keeps the confirmation and retries in place", async () => {
  const view = renderSkills();
  const { user, dialog } = await openDelete(view);
  deleteStatus = 503;
  await user.click(
    within(dialog).getByRole("button", { name: "Delete skill" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(
    /Couldn't delete this skill/,
  );
  deleteStatus = 200;
  await user.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([
    { method: "DELETE", path: "/api/plugins/skills/standup" },
    { method: "DELETE", path: "/api/plugins/skills/standup" },
  ]);
});

test("the editor says what a Bot grant changes before it is pressed", async () => {
  const view = renderSkills("/skills?edit=standup");
  const sentence = await view.findByText(/Selected Bots offer/);
  expect(sentence.textContent).toBe(
    "Selected Bots offer /standup in the / menu. Changes take effect immediately.",
  );
  // OpenBot says Bot; "agent" is the model's word.
  expect(sentence.textContent).not.toMatch(/agent/i);
});
