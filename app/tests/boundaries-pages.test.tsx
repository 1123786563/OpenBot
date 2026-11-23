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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RULE_TEMPLATES } from "@/lib/boundaries/rules";
import type { ActionPolicy } from "@/lib/computers/queries";
import { Route as BoundariesRoute } from "@/routes/_authed/admin/boundaries";
import { Route as RuleRoute } from "@/routes/_authed/admin/boundaries_.$index";
import { Route as NewRuleRoute } from "@/routes/_authed/admin/boundaries_.new";

/**
 * The Boundaries screens: the list reads rules by name, adding one saves its name beside it, and
 * removing one takes its name with it. The server is a fake that stores what it is sent.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

type Routed = { options: object };
const routes = [
  BoundariesRoute,
  NewRuleRoute,
  RuleRoute,
] as unknown as Routed[];
const pristine = routes.map((route) => ({
  ...route,
  options: { ...route.options },
}));
beforeEach(() => {
  routes.forEach((route, index) => {
    for (const key of Object.keys(route))
      if (!(key in pristine[index]!))
        delete (route as Record<string, unknown>)[key];
    Object.assign(route, pristine[index], {
      options: { ...pristine[index]!.options },
    });
  });
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const custom = 'tool.name == "computer_run" && contains(command, "rm")';
const template = RULE_TEMPLATES[1]!;

let stored: ActionPolicy;
const saved: ActionPolicy[] = [];
const expectedPolicies: (ActionPolicy | undefined)[] = [];
/** Every candidate the screens asked the server to replay. */
const replayed: ActionPolicy[] = [];
const NOTHING_REPLAYED = Response.json({
  report: {
    scanned: 0,
    wouldRefuse: 0,
    wouldAllow: 0,
    unchanged: 0,
    changes: [],
  },
});
let replay: (candidate: ActionPolicy) => Response = () =>
  NOTHING_REPLAYED.clone();
function serving(policy: ActionPolicy) {
  stored = policy;
  saved.length = 0;
  expectedPolicies.length = 0;
  replayed.length = 0;
  replay = () => NOTHING_REPLAYED.clone();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/computers/policy") && init?.method === "PUT") {
      const { expected, ...updated } = JSON.parse(
        String(init.body),
      ) as ActionPolicy & { expected?: ActionPolicy };
      expectedPolicies.push(expected);
      if (expected && JSON.stringify(expected) !== JSON.stringify(stored)) {
        return Response.json(
          { error: "The policy has changed." },
          { status: 409 },
        );
      }
      stored = updated;
      saved.push(stored);
      return Response.json({ policy: stored });
    }
    if (path.endsWith("/api/computers/policy"))
      return Response.json({ policy: stored });
    if (path.endsWith("/api/computers/policy-dry-run")) {
      const { policy: candidate } = JSON.parse(String(init?.body)) as {
        policy: ActionPolicy;
      };
      replayed.push(candidate);
      return replay(candidate);
    }
    if (path.includes("/api/agents"))
      return Response.json({
        agents: [{ id: "general-assistant", name: "General Assistant" }],
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
}

function open(path: string) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const wire = (route: unknown, id: string, at: string) =>
    (route as { update: (options: unknown) => never }).update({
      id,
      path: at,
      getParentRoute: () => admin,
    });
  const audit = createRoute({
    path: "/audit",
    getParentRoute: () => admin,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        admin.addChildren([
          wire(BoundariesRoute, "/boundaries", "/boundaries"),
          wire(NewRuleRoute, "/boundaries_/new", "/boundaries/new"),
          wire(RuleRoute, "/boundaries_/$index", "/boundaries/$index"),
          audit,
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the list shows each rule by its name, a template's own name, or as a custom rule", async () => {
  serving({
    mode: "enforce",
    deny: ["true", template.rule, custom],
    allow: ["true"],
    labels: { true: { name: "Stop everything", description: "All of it." } },
  });
  const { view } = open("/admin/boundaries");

  expect(await view.findByText("Stop everything")).toBeTruthy();
  expect(view.getByText("All of it.")).toBeTruthy();
  expect(view.getByText(template.name)).toBeTruthy();
  expect(view.getByText("Custom rule")).toBeTruthy();
  expect(view.getByText(custom)).toBeTruthy();
});

test("adding from a template saves the rule with its name and returns to the list", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  const { view, router } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText(template.name));
  const add = view.getByRole("button", { name: "Add rule" });
  expect(add.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
  fireEvent.click(view.getByRole("button", { name: "Add rule" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    mode: "enforce",
    deny: [template.rule],
    allow: ["true"],
    labels: {
      [template.rule]: {
        name: template.name,
        description: template.description,
      },
    },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/boundaries"),
  );
});

test("new rule keeps its draft through a starter switch and a failed preview", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  replay = () =>
    Response.json({ error: "Preview unavailable" }, { status: 503 });
  const { view } = open("/admin/boundaries/new");
  fireEvent.click(await view.findByText("Write your own"));
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Name"), "Test rule");
  await user.type(view.getByLabelText("Rule"), custom);
  await view.findByText("Couldn’t check this rule.");
  expect(
    view.getByRole("button", { name: "Add rule" }).hasAttribute("disabled"),
  ).toBe(true);

  fireEvent.click(view.getByText(template.name));
  fireEvent.click(view.getByText("Write your own"));
  const name = view.getByLabelText("Name");
  const rule = view.getByLabelText("Rule");
  expect(name instanceof HTMLInputElement && name.value).toBe("Test rule");
  expect(rule instanceof HTMLTextAreaElement && rule.value).toBe(custom);

  const retry = await view.findByRole("button", { name: "Retry" });
  replay = () => NOTHING_REPLAYED.clone();
  fireEvent.click(retry);
  const add = view.getByRole("button", { name: "Add rule" });
  await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
  fireEvent.submit(add.closest("form")!);
  expect(saved).toHaveLength(0);
  fireEvent.click(add);
  await waitFor(() => expect(saved[0]?.deny).toEqual([custom]));
});

test("new rule reloads a changed policy without overwriting the other rule", async () => {
  const initial: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
  serving(initial);
  const { view } = open("/admin/boundaries/new");
  fireEvent.click(await view.findByText(template.name));
  const add = view.getByRole("button", { name: "Add rule" });
  await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));

  stored = { ...initial, deny: [custom] };
  fireEvent.click(add);
  await view.findByText(
    "Reload the current boundaries before adding your rule.",
  );
  expect(add.hasAttribute("disabled")).toBe(true);
  expect(saved).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
  const name = view.getByLabelText("Name");
  expect(name instanceof HTMLInputElement && name.value).toBe(template.name);
  fireEvent.click(add);
  await waitFor(() => expect(saved[0]?.deny).toEqual([custom, template.rule]));
  expect(expectedPolicies).toEqual([initial, { ...initial, deny: [custom] }]);
});

test("removing a rule is confirmed, and takes its name with it", async () => {
  serving({
    mode: "enforce",
    deny: [template.rule, custom],
    allow: ["true"],
    labels: { [custom]: { name: "No rm", description: "" } },
  });
  const { view } = open("/admin/boundaries/1");

  fireEvent.click(await view.findByRole("button", { name: "Remove rule" }));
  expect(saved).toHaveLength(0);
  fireEvent.click(await view.findByRole("button", { name: "Remove" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.deny).toEqual([template.rule]);
  expect(saved[0]?.labels).toEqual({});
});

test("changing Trial mode reviews impact and declines to overwrite a newer policy", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  const { view } = open("/admin/boundaries");
  const control = await view.findByRole("switch", { name: "Trial mode" });

  fireEvent.click(control);
  expect(
    await view.findByRole("alertdialog", { name: "Turn on Trial mode?" }),
  ).toBeTruthy();
  expect(saved).toHaveLength(0);
  stored = { ...stored, deny: [custom] };
  fireEvent.click(view.getByRole("button", { name: "Turn on Trial mode" }));
  expect(
    await view.findByText(
      /The boundaries changed while you were reviewing them/,
    ),
  ).toBeTruthy();
  expect(saved).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());

  fireEvent.click(control);
  fireEvent.click(
    await view.findByRole("button", { name: "Turn on Trial mode" }),
  );
  await waitFor(() =>
    expect(saved).toEqual([
      { mode: "dry-run", deny: [custom], allow: ["true"] },
    ]),
  );
});

const salesforceWrites = 'mcp.server == "salesforce" && mcp.effect == "write"';

/** One recorded action as the dry-run reports it. */
function changed(overrides: Record<string, unknown>) {
  return {
    createdAt: "2026-11-09T10:45:00.000Z",
    bot: "general-assistant",
    page: "",
    element: null,
    command: null,
    file: null,
    initiator: { kind: "person", id: "" },
    was: "allowed",
    would: "refused",
    rule: salesforceWrites,
    reason: "Blocked.",
    ...overrides,
  };
}

test("a rule about an app is tested as it is written, and lists the app calls it would stop beside computer actions", async () => {
  // A rule already in force, which this one's answer must not borrow from.
  serving({ mode: "enforce", deny: [custom], allow: ["true"] });
  replay = () =>
    Response.json({
      report: {
        scanned: 9,
        wouldRefuse: 2,
        wouldAllow: 0,
        unchanged: 7,
        changes: [
          changed({
            id: "a",
            kind: "app",
            action: "salesforce/update_record",
            initiator: { kind: "routine", id: "weekly-review" },
          }),
          changed({
            id: "c",
            kind: "computer",
            action: "computer_run_command",
            command: "sf data update record",
          }),
        ],
      },
    });
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Write your own"));
  // Typed a key at a time: replayed once it rests, not once a keystroke.
  await userEvent
    .setup({ document })
    .type(view.getByLabelText("Rule"), salesforceWrites);

  // Nobody presses anything: the answer arrives under the rule.
  expect(view.queryByRole("button", { name: /test/i })).toBeNull();
  expect(
    await view.findByText(
      "Of the last 9 recorded actions, this rule would have stopped 2.",
    ),
  ).toBeTruthy();
  // Once, when the rule rested, and the rule on its own: the rule in force stops what it stops
  // whether or not this one is added, so what it would have stopped is no part of this answer.
  expect(replayed).toEqual([
    { mode: "enforce", deny: [salesforceWrites], allow: ["true"] },
  ]);

  // The app call reads as Audit reads it: the action in words, the app's tool, who started it.
  expect(view.getByText("Update record")).toBeTruthy();
  expect(view.getByText("salesforce/update_record")).toBeTruthy();
  expect(view.getByText("Started by a routine")).toBeTruthy();
  expect(view.getByRole("img", { name: "App call" })).toBeTruthy();
  // Beside the computer action it would also stop.
  expect(view.getByText("sf data update record")).toBeTruthy();
  expect(view.getByRole("img", { name: "Computer action" })).toBeTruthy();
  expect(view.getAllByText("Would stop")).toHaveLength(2);
});

test("a rule that doesn't compile says why under it, and isn't replayed as one that stops everything", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  const why =
    'A rule can\'t check "elemnt". It can check tool, intent, bot, actor, initiator, page, element, key, file, command and mcp.';
  replay = (candidate) =>
    Response.json({ error: why, rule: candidate.deny.at(-1) }, { status: 400 });
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Write your own"));
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Name"), "Submit");
  await user.type(view.getByLabelText("Rule"), 'elemnt.name == "Submit"');

  expect((await view.findByRole("alert")).textContent).toBe(why);
  expect(view.queryByText(/recorded actions/)).toBeNull();
  expect(
    view.getByRole("button", { name: "Add rule" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("a rule's page lists the app calls it stopped", async () => {
  serving({
    mode: "enforce",
    deny: [salesforceWrites],
    allow: ["true"],
    labels: {
      [salesforceWrites]: { name: "Never change Salesforce", description: "" },
    },
  });
  replay = () =>
    Response.json({
      report: {
        scanned: 4,
        wouldRefuse: 0,
        wouldAllow: 1,
        unchanged: 3,
        changes: [
          changed({
            id: "s",
            kind: "app",
            action: "salesforce/delete_record",
            was: "refused",
            would: "allowed",
          }),
        ],
      },
    });
  const { view } = open("/admin/boundaries/0");

  expect(
    await view.findByText("It stopped 1 of the last 4 recorded actions."),
  ).toBeTruthy();
  expect(view.getByText("Delete record")).toBeTruthy();
  expect(view.getByText("salesforce/delete_record")).toBeTruthy();
  expect(view.getByText("Stopped")).toBeTruthy();
  // Replayed without the rule: what it stopped is what would have gone through.
  expect(replayed).toEqual([
    { mode: "enforce", deny: [], allow: ["true"], labels: {} },
  ]);
});
