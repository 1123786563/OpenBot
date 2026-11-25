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
import { PasswordsPage } from "@/components/passwords/passwords-page";
import type { SavedLogin } from "@/lib/passwords/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Settings > Passwords, where a person deletes a saved website login. The server is faked at the
 * fetch boundary with the shape `GET /api/passwords` answers with and the delete route, and every
 * write is recorded.
 *
 * Two logins can share a site, so the confirmation names the username as well as the site; the
 * saved login is what a person means to delete, and only the one they picked.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SITE = "https://example.com";

function login(id: string, overrides: Partial<SavedLogin> = {}): SavedLogin {
  return {
    id,
    origin: SITE,
    username: "alice@example.test",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastUsedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

let logins: SavedLogin[];
let passwordManager: boolean;
/** How many deletes answer 500 before the server starts accepting them. */
let failingDeletes: number;
/** Whether the next delete commits and then never answers. */
let loseDeleteResponse: boolean;
/** A test that wants to press again mid-submit holds the delete here. */
let inFlight: Promise<void> | null;
/** A status the list answers with on the re-read. */
let listStatus: number | null;
let writes: { method: string; path: string }[];

beforeEach(() => {
  logins = [
    login("login-alice"),
    login("login-bob", { username: "bob@example.test" }),
  ];
  passwordManager = true;
  failingDeletes = 0;
  loseDeleteResponse = false;
  inFlight = null;
  listStatus = null;
  writes = [];
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status });
    if (method === "GET" && path === "/api/passwords") {
      return listStatus
        ? json({ error: "The saved logins could not be read." }, listStatus)
        : json({ passwordManager, logins });
    }
    const remove = path.match(/^\/api\/passwords\/(.+)$/);
    if (method === "DELETE" && remove) {
      writes.push({ method, path });
      if (inFlight) await inFlight;
      if (failingDeletes > 0) {
        failingDeletes -= 1;
        return json({ error: "The server could not do that." }, 500);
      }
      const id = decodeURIComponent(remove[1] ?? "");
      if (!logins.some((entry) => entry.id === id)) {
        return json({ error: "There is no such saved login." }, 404);
      }
      logins = logins.filter((entry) => entry.id !== id);
      // What a dropped connection looks like: the write landed, its answer never arrived.
      if (loseDeleteResponse) {
        loseDeleteResponse = false;
        throw new TypeError("Failed to fetch");
      }
      return json({ deleted: true });
    }
    return json({ error: "not served" }, 404);
  }) as unknown as typeof fetch;
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: PasswordsPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await view.findByRole("button", {
    name: `Delete saved login for alice@example.test at ${SITE}`,
  });
  return view;
}

function trigger(
  view: Awaited<ReturnType<typeof draw>>,
  username = "alice@example.test",
) {
  return view.getByRole("button", {
    name: `Delete saved login for ${username} at ${SITE}`,
  });
}

async function open(view: Awaited<ReturnType<typeof draw>>) {
  const opener = trigger(view);
  fireEvent.click(opener);
  const dialog = await view.findByRole("alertdialog");
  return { opener, dialog, in: within(dialog) };
}

test("two logins at one site are told apart by the username in the confirmation", async () => {
  const view = await draw();
  const { dialog, in: inside } = await open(view);
  expect(dialog.textContent).toContain(`Delete saved login for ${SITE}?`);
  expect(dialog.textContent).toContain(
    "OpenBot will stop offering the saved login for alice@example.test at this site.",
  );
  expect(dialog.textContent).not.toContain("bob@example.test");
  expect(
    inside.getByRole("button", { name: "Delete saved login" }),
  ).toBeTruthy();
  expect(writes).toEqual([]);
});

test("cancel sends nothing and gives focus back to the control that opened it", async () => {
  const view = await draw();
  const { opener, in: inside } = await open(view);
  expect(document.activeElement).toBe(
    inside.getByRole("button", { name: "Cancel" }),
  );
  fireEvent.click(inside.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
  expect(writes).toEqual([]);
});

test("deleting returns to the next entry with a notice of what was deleted", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await view.findByText(`Saved login for ${SITE} deleted.`);
  await waitFor(() =>
    expect(view.queryByText(/alice@example\.test/)).toBeNull(),
  );
  expect(writes).toEqual([
    { method: "DELETE", path: "/api/passwords/login-alice" },
  ]);
  // The remaining entry takes focus: its title is now the first row.
  await waitFor(() => expect(document.activeElement?.textContent).toBe(SITE));
});

test("deleting the last login leaves focus on the page heading", async () => {
  logins = [login("login-alice")];
  const view = await draw();
  const { in: inside } = await open(view);
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await view.findByText(`Saved login for ${SITE} deleted.`);
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  expect(document.activeElement?.textContent).toBe("Passwords");
});

test("pressing Delete three times during a submit sends one request", async () => {
  let release: () => void = () => {};
  inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await draw();
  const { in: inside } = await open(view);
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  const pending = await inside.findByRole("button", {
    name: "Deleting saved login…",
  });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(writes).toHaveLength(1);
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(writes).toHaveLength(1);
  release();
  await view.findByText(`Saved login for ${SITE} deleted.`);
  expect(writes).toHaveLength(1);
});

test("a refusal keeps the confirmation and Try again deletes it", async () => {
  failingDeletes = 1;
  const view = await draw();
  const { dialog, in: inside } = await open(view);
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await inside.findByText(
    "Deletion could not be confirmed. Try again to check whether this login is still saved.",
  );
  expect(dialog.textContent).toContain(`Delete saved login for ${SITE}?`);
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await view.findByText(`Saved login for ${SITE} deleted.`);
  expect(writes).toHaveLength(2);
});

test("a login deleted under the dialog writes nothing and offers Close only", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  logins = logins.filter((entry) => entry.id !== "login-alice");
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await inside.findByText(
    "The saved login or password manager settings changed. Close this dialog and review your saved logins.",
  );
  expect(
    inside.queryByRole("button", { name: "Delete saved login" }),
  ).toBeNull();
  fireEvent.click(inside.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("turning the password manager off under the dialog writes nothing", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  passwordManager = false;
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await inside.findByText(
    "The saved login or password manager settings changed. Close this dialog and review your saved logins.",
  );
  expect(writes).toEqual([]);
});

test("a delete whose answer was lost is retried without a second write", async () => {
  loseDeleteResponse = true;
  const view = await draw();
  const { in: inside } = await open(view);
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await inside.findByText(
    "Deletion could not be confirmed. Try again to check whether this login is still saved.",
  );
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await inside.findByText(
    "The saved login or password manager settings changed. Close this dialog and review your saved logins.",
  );
  expect(writes).toHaveLength(1);
});

test("losing permission on the re-read says so, and writes nothing", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  listStatus = 403;
  fireEvent.click(inside.getByRole("button", { name: "Delete saved login" }));
  await inside.findByText("You no longer have permission to make this change.");
  expect(
    inside.queryByRole("button", { name: "Delete saved login" }),
  ).toBeNull();
  expect(writes).toEqual([]);
});
