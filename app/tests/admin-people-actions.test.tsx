import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
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
import type { Person } from "@/lib/people/queries";
import { queryClient } from "@/query-client";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin People, where an administrator stops somebody's computers, removes their access or changes
 * their admin role. The server is faked at the fetch boundary with the shapes the people routes and
 * the terminate-computers route answer with, and every write is recorded, so "cancel sends nothing"
 * and "three presses send one request" are counted rather than assumed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MEMBER = "member@example.test";
const LEFT = "left@example.test";

function person(overrides: Partial<Person> & { id: string }): Person {
  return {
    email: `${overrides.id}@example.test`,
    name: null,
    image: null,
    role: "user",
    providers: ["google"],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
    ...overrides,
  };
}

let people: Person[];
let listReads: number;
const writes: { method: string; path: string; body: unknown }[] = [];
/** How many writes answer with `refusal` before the server starts accepting them again. */
let failingWrites: number;
let refusal: { status: number; error?: string };
/** What the stop route answers. */
let stopResult: {
  stopped: string[];
  failed: { computer: string; reason: string }[];
};
/** A test that wants to press again mid-submit holds the first write on this promise. */
let inFlight: Promise<void> | null = null;

const PARTIAL_REMOVAL =
  "Access is removed for this person, but some of their credentials or Recorders could not be retired yet. Try again to finish.";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  people = [
    person({ id: "u1", email: MEMBER }),
    person({ id: "u2", email: LEFT, role: "admin", revoked: true }),
  ];
  listReads = 0;
  writes.length = 0;
  failingWrites = 0;
  refusal = { status: 500 };
  stopResult = { stopped: ["person:u1"], failed: [] };
  inFlight = null;
  queryClient.clear();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/me")
      return Response.json({
        user: {
          id: "admin-1",
          email: "admin@example.test",
          role: "admin",
          onboarding: null,
        },
      });
    if (method === "GET" && path.startsWith("/api/admin/people")) {
      listReads += 1;
      return Response.json({ people, nextCursor: null });
    }
    if (method === "POST") {
      writes.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (inFlight) await inFlight;
      if (failingWrites > 0) {
        failingWrites -= 1;
        return Response.json(
          { error: refusal.error ?? "The server could not do that." },
          { status: refusal.status },
        );
      }
      if (path.endsWith("/terminate-computers"))
        return Response.json(stopResult);
      const id = path.split("/")[4] as string;
      const found = people.find((entry) => entry.id === id) as Person;
      const body = JSON.parse(String(init?.body));
      // The store's own answer: the person as they are after the write.
      const updated = {
        ...found,
        ...(path.endsWith("/role")
          ? { role: body.role }
          : { revoked: body.revoked }),
      };
      people = people.map((entry) => (entry.id === id ? updated : entry));
      return Response.json({ person: updated });
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: PeopleRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  if (people.length > 0) {
    await view.findByRole("button", { name: `Remove access for ${MEMBER}` });
  }
  return view;
}

test("People explains the empty roster before anyone has signed in", async () => {
  people = [];
  const view = await draw();

  expect(await view.findByText("Nobody has signed in yet")).toBeTruthy();
  expect(view.getByText("People show here once they do.")).toBeTruthy();
});

/** The confirmation the trigger opens, once its title is on screen. */
async function open(view: Awaited<ReturnType<typeof draw>>, name: string) {
  const trigger = view.getByRole("button", { name });
  fireEvent.click(trigger);
  const dialog = await view.findByRole("alertdialog");
  return { trigger, dialog, in: within(dialog) };
}

/**
 * What each decision puts in front of the administrator: who, what it reaches, what it costs, and
 * whether it can be undone. The scope of a stop is the person's own computer and their Bots', which
 * is what the server decides at submit time; no endpoint enumerates them before it.
 */
const PREVIEWS = [
  {
    trigger: `Stop computers for ${MEMBER}`,
    title: `Stop computers for ${MEMBER}?`,
    scope: "their running computer and the computers of Bots they own",
    impact: "Active work can be interrupted",
    recovery:
      "Disks are kept, and the computers can start again in a later session",
  },
  {
    trigger: `Remove access for ${MEMBER}`,
    title: `Remove access for ${MEMBER}?`,
    scope:
      "loses access to this workspace and their owned credentials are retired",
    impact: "Retired credentials need to be replaced",
    recovery: "You can restore sign-in access later",
  },
  {
    trigger: `Restore access for ${LEFT}`,
    title: `Restore access for ${LEFT}?`,
    scope: "restores their sign-in access to this workspace",
    impact: "Credentials retired when access was removed stay revoked",
    recovery: "restores their sign-in access",
  },
  {
    trigger: `Grant admin for ${MEMBER}`,
    title: `Grant admin for ${MEMBER}?`,
    scope: "manage people and deployment settings in Admin",
    impact: "manage people and deployment settings",
    recovery: "Another administrator can remove this role later",
  },
  {
    trigger: `Remove admin for ${LEFT}`,
    title: `Remove admin for ${LEFT}?`,
    scope: "lose access to Admin pages and admin actions",
    impact: "Their workspace access stays as it is",
    recovery: "An administrator can grant the role again",
  },
];

test("every decision names the person, what it reaches, what it costs and whether it can be undone", async () => {
  const view = await draw();
  for (const preview of PREVIEWS) {
    const { dialog, in: inside } = await open(view, preview.trigger);
    expect(dialog.textContent).toContain(preview.title);
    expect(dialog.textContent).toContain(preview.scope);
    expect(dialog.textContent).toContain(preview.impact);
    expect(dialog.textContent).toContain(preview.recovery);
    fireEvent.click(inside.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  }
  expect(writes).toEqual([]);
});

test("a removal that only half finished says what took effect and finishes on the retry", async () => {
  failingWrites = 1;
  refusal = { status: 503, error: PARTIAL_REMOVAL };
  const view = await draw();
  const { dialog, in: inside } = await open(
    view,
    `Remove access for ${MEMBER}`,
  );

  fireEvent.click(inside.getByRole("button", { name: "Remove access" }));

  await waitFor(() => expect(dialog.textContent).toContain(PARTIAL_REMOVAL));
  // The preview stays: the administrator is still deciding about the same person.
  expect(dialog.textContent).toContain(`Remove access for ${MEMBER}?`);
  expect(dialog.textContent).toContain(
    "You can restore sign-in access later. Retired credentials need to be replaced.",
  );
  const again = inside.getByRole("button", { name: "Try again" });

  fireEvent.click(again);

  await view.findByText(`Access removed for ${MEMBER}.`);
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/admin/people/u1/access",
      body: { revoked: true },
    },
    {
      method: "POST",
      path: "/api/admin/people/u1/access",
      body: { revoked: true },
    },
  ]);
});

test.each([
  ["a row button", `Remove access for ${MEMBER}`],
  ["another row button", `Grant admin for ${MEMBER}`],
])(
  "cancel from %s sends nothing and gives focus back to the control that opened the confirmation",
  async (_kind, name) => {
    const view = await draw();
    const trigger = view.getByRole("button", { name });
    trigger.focus();
    const { dialog, in: inside } = await open(view, name);
    // The first thing in the confirmation, so a keyboard does not start on the destructive control.
    expect(document.activeElement).toBe(
      inside.getByRole("button", { name: "Cancel" }),
    );
    // What a screen reader announces: the decision as its name, the preview as its description.
    const describedBy = dialog.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toBe(
      inside.getByText(/This |They /).textContent,
    );
    fireEvent.click(inside.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(writes).toEqual([]);
  },
);

test("cancel from the narrow-screen menu sends nothing and gives focus back to its trigger", async () => {
  const view = await draw();
  const user = userEvent.setup({ document });
  const trigger = view.getByRole("button", { name: `Actions for ${MEMBER}` });
  await user.click(trigger);
  const menu = await view.findByRole("menu");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Stop computers" }),
  );
  const dialog = await view.findByRole("alertdialog", {
    name: `Stop computers for ${MEMBER}?`,
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(writes).toEqual([]);
});

test("pressing confirm three times during a submit sends one request", async () => {
  const view = await draw();
  const { in: inside } = await open(view, `Grant admin for ${MEMBER}`);
  let release: () => void = () => {};
  inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });

  const confirm = inside.getByRole("button", { name: "Grant admin" });
  fireEvent.click(confirm);
  const pending = await within(view.getByRole("alertdialog")).findByRole(
    "button",
    { name: "Updating role…" },
  );
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(writes).toHaveLength(1);
  // A second and a third press land while the first is in flight.
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(writes).toHaveLength(1);

  release();
  await view.findByText(`Admin role granted to ${MEMBER}.`);
  expect(writes.filter((write) => write.path.endsWith("/role"))).toEqual([
    {
      method: "POST",
      path: "/api/admin/people/u1/role",
      body: { role: "admin" },
    },
  ]);
});

test("a failed submit keeps the decision on screen and offers Try again", async () => {
  failingWrites = 1;
  refusal = { status: 500 };
  const view = await draw();
  const { dialog, in: inside } = await open(view, `Grant admin for ${MEMBER}`);
  const preview = inside.getByText(/They can manage people/).textContent;

  fireEvent.click(inside.getByRole("button", { name: "Grant admin" }));

  await waitFor(() =>
    expect(dialog.textContent).toContain(
      "The role change could not be confirmed. Try again to check their current role.",
    ),
  );
  expect(dialog.textContent).toContain(`Grant admin for ${MEMBER}?`);
  expect(dialog.textContent).toContain(preview);
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await view.findByText(`Admin role granted to ${MEMBER}.`);
  expect(writes.filter((write) => write.path.endsWith("/role"))).toHaveLength(
    2,
  );
});

test("a role somebody else changed is read again, explained, and only Close is offered", async () => {
  const view = await draw();
  const { dialog, in: inside } = await open(view, `Grant admin for ${MEMBER}`);
  const readsBefore = listReads;
  // Another administrator grants it while this confirmation is open.
  people = people.map((entry) =>
    entry.id === "u1" ? { ...entry, role: "admin" } : entry,
  );

  fireEvent.click(inside.getByRole("button", { name: "Grant admin" }));

  await waitFor(() =>
    expect(dialog.textContent).toContain(
      "This person’s role or access changed. Close this dialog and review their current permissions.",
    ),
  );
  expect(listReads).toBeGreaterThan(readsBefore);
  expect(writes).toEqual([]);
  expect(inside.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(inside.queryByRole("button", { name: "Grant admin" })).toBeNull();
  const close = inside.getByRole("button", { name: "Close" });
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
});

test.each([
  [403, "You no longer have permission to make this change."],
  [401, "Your session has ended. Sign in again to continue."],
  [
    409,
    "The current state no longer matches this confirmation. Close this dialog and review the list.",
  ],
])(
  "a %i on the write explains it and asks for a new decision",
  async (status, message) => {
    failingWrites = 1;
    refusal = { status };
    const view = await draw();
    const { dialog, in: inside } = await open(view, `Remove admin for ${LEFT}`);

    fireEvent.click(inside.getByRole("button", { name: "Remove admin" }));

    await waitFor(() => expect(dialog.textContent).toContain(message));
    expect(inside.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(inside.getByRole("button", { name: "Close" })).toBeTruthy();
    // The refused write itself, and nothing after it.
    expect(writes).toHaveLength(1);
  },
);

test("a stop that only half finished says what stopped and what is left, and retries the rest", async () => {
  stopResult = {
    stopped: ["person:u1"],
    failed: [{ computer: "bot:owned", reason: "computer service unreachable" }],
  };
  const view = await draw();
  const { dialog, in: inside } = await open(
    view,
    `Stop computers for ${MEMBER}`,
  );

  fireEvent.click(inside.getByRole("button", { name: "Stop computers" }));

  await waitFor(() =>
    expect(dialog.textContent).toContain(
      `Stopped 1 computer for ${MEMBER}. Still unable to stop 1. Try again to stop the remaining computers.`,
    ),
  );
  expect(dialog.textContent).toContain(`Stop computers for ${MEMBER}?`);
  stopResult = { stopped: ["bot:owned"], failed: [] };
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await view.findByText(`Stopped 1 computer for ${MEMBER}.`);
  expect(
    writes.filter((write) => write.path.endsWith("/terminate-computers")),
  ).toHaveLength(2);
});
