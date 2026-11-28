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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialsPage } from "@/components/manage/credentials-page";
import { NewCredentialPage } from "@/components/manage/new-credential-page";
import type { CredentialStatus } from "@/lib/credentials/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Team Credentials: replacing a key and adding one.
 *
 * Drawn under the real paths (`/admin/credentials`, `/admin/credentials/new`) so every link and
 * navigation is the one the app makes, against a fake `fetch` that records writes and behaves as
 * the vault does: one live row per key, a rotation aimed at a revoked row refused, and a create
 * that collides refused.
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

const REVOKED_AT = "2026-11-25T18:00:00.000Z";

function credential(
  overrides: Partial<CredentialStatus> & { id: string },
): CredentialStatus {
  return {
    kind: "model",
    provider: "openai",
    keyId: "production",
    metadata: {},
    revokedAt: null,
    ...overrides,
  };
}

let credentials: CredentialStatus[];
let creates: Record<string, unknown>[];
let rotates: string[];
/** The next write of this kind commits and then never answers. */
let loseNext: "create" | "rotate" | null;
/** Another administrator saves the same key a moment before this create lands. */
let rivalCreatesFirst: boolean;
let next: number;

beforeEach(() => {
  credentials = [credential({ id: "cred-live" })];
  creates = [];
  rotates = [];
  loseNext = null;
  rivalCreatesFirst = false;
  next = 0;
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status });
    const liveOf = (value: { kind: string; provider: string; keyId: string }) =>
      credentials.find(
        (entry) =>
          !entry.revokedAt &&
          entry.kind === value.kind &&
          entry.provider === value.provider &&
          entry.keyId === value.keyId,
      );

    if (method === "GET" && path === "/api/admin/credentials")
      return json({ credentials });
    if (method === "POST" && path === "/api/admin/credentials") {
      creates.push(body);
      if (rivalCreatesFirst) {
        rivalCreatesFirst = false;
        credentials = [
          ...credentials,
          credential({ id: "cred-rival", ...body, revokedAt: null }),
        ];
        return json(
          { error: "An active credential already uses this ID." },
          409,
        );
      }
      // `createOnly`: one live row per key, so a key that is already there is refused.
      if (liveOf(body)) {
        return json(
          { error: "An active credential already uses this ID." },
          409,
        );
      }
      const stored = credential({ id: `cred-new-${next++}`, ...body });
      credentials = [...credentials, stored];
      if (loseNext === "create") {
        loseNext = null;
        throw new TypeError("Failed to fetch");
      }
      return json({ credential: stored }, 201);
    }
    const rotate = path.match(/^\/api\/admin\/credentials\/(.+)\/rotate$/);
    if (method === "POST" && rotate) {
      rotates.push(path);
      const previous = credentials.find((entry) => entry.id === rotate[1]);
      if (!previous || previous.revokedAt) {
        return json({ error: "Previous credential is already revoked" }, 409);
      }
      credentials = credentials.map((entry) =>
        entry.id === previous.id ? { ...entry, revokedAt: REVOKED_AT } : entry,
      );
      const stored = { ...previous, id: `cred-rotated-${next++}` };
      credentials = [...credentials, stored];
      if (loseNext === "rotate") {
        loseNext = null;
        throw new TypeError("Failed to fetch");
      }
      return json({ credential: stored });
    }
    return json({ error: "not served" }, 404);
  }) as unknown as typeof fetch;
});

function draw(path: string) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/admin/credentials",
    component: CredentialsPage,
  });
  const add = createRoute({
    getParentRoute: () => root,
    path: "/admin/credentials/new",
    component: NewCredentialPage,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([list, add]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** Open Replace on the one row, and type a new secret. */
async function openReplacement(view: Awaited<ReturnType<typeof draw>>["view"]) {
  await view.findByText("openai");
  fireEvent.click(
    view.getByRole("button", { name: "Replace production for openai" }),
  );
  await view.findByText("Replace credential");
  expect(view.getByText("Model · openai · production")).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Secret"), "sk-new-secret");
  return user;
}

test("Replace on a row confirms the key by name and posts the id that was seen", async () => {
  const { view, router } = draw("/admin/credentials");
  await openReplacement(view);
  fireEvent.click(view.getByRole("button", { name: "Review replacement" }));
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Replace production for openai?");

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace credential" }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/credentials"),
  );
  expect(rotates).toEqual(["/api/admin/credentials/cred-live/rotate"]);
  expect(creates).toEqual([]);
});

test("a completed replacement returns to the list, says so, and moves focus to the new row", async () => {
  const { view, router } = draw("/admin/credentials");
  await openReplacement(view);
  fireEvent.click(view.getByRole("button", { name: "Review replacement" }));
  const dialog = await view.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace credential" }),
  );
  await view.findByText("Replacement saved.");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/credentials"),
  );
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "openai · production · active",
    ),
  );
});

test("cancelling the replacement keeps the secret and returns focus to Review replacement", async () => {
  const { view } = draw("/admin/credentials");
  await openReplacement(view);
  const review = view.getByRole("button", { name: "Review replacement" });
  fireEvent.click(review);
  const dialog = await view.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect((view.getByLabelText("Secret") as HTMLInputElement).value).toBe(
    "sk-new-secret",
  );
  expect(document.activeElement).toBe(review);
  expect(rotates).toEqual([]);
});

test("from the Add form, a key that is already there is replaced by the id the list holds", async () => {
  const { view, router } = draw("/admin/credentials/new");
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("Provider"), "openai");
  await user.type(view.getByLabelText("Key ID"), "production");
  await user.type(view.getByLabelText("Secret"), "sk-other-secret");

  fireEvent.click(view.getByRole("button", { name: "Review replacement" }));
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Replace production for openai?");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace credential" }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/credentials"),
  );
  expect(rotates).toEqual(["/api/admin/credentials/cred-live/rotate"]);
  expect(creates).toEqual([]);
});

test("a create that collides explains it, keeps the secret, and offers to choose another ID", async () => {
  rivalCreatesFirst = true;
  const { view } = draw("/admin/credentials/new");
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("Provider"), "anthropic");
  await user.type(view.getByLabelText("Key ID"), "staging");
  await user.type(view.getByLabelText("Secret"), "sk-ant-secret");

  // A person presses the button, which moves focus onto it; the explanation then takes focus.
  await user.click(view.getByRole("button", { name: "Save credential" }));
  const message = await view.findByText(
    "An active credential now exists with this ID. Review it before replacing it.",
  );
  // Said where focus is, so it is heard as well as seen; the entries are not lost.
  await waitFor(() => expect(document.activeElement).toBe(message));
  expect((view.getByLabelText("Secret") as HTMLInputElement).value).toBe(
    "sk-ant-secret",
  );

  const keyId = view.getByLabelText("Key ID") as HTMLInputElement;
  fireEvent.click(view.getByRole("button", { name: "Use a different ID" }));
  expect(document.activeElement).toBe(keyId);
  expect(keyId.selectionStart).toBe(0);
  expect(keyId.selectionEnd).toBe("staging".length);
  expect(creates).toHaveLength(1);
});

test("a create whose answer was lost is retried into one conflict, not a second row", async () => {
  loseNext = "create";
  const { view } = draw("/admin/credentials/new");
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("Provider"), "anthropic");
  await user.type(view.getByLabelText("Key ID"), "staging");
  await user.type(view.getByLabelText("Secret"), "sk-ant-secret");

  fireEvent.click(view.getByRole("button", { name: "Save credential" }));
  await view.findByText(
    "Couldn't save the credential. Your entries are still here. Try again.",
  );
  fireEvent.click(view.getByRole("button", { name: "Save credential" }));
  await view.findByText(
    "An active credential now exists with this ID. Review it before replacing it.",
  );
  expect(creates).toHaveLength(2);
  expect(
    credentials.filter(
      (entry) => entry.provider === "anthropic" && !entry.revokedAt,
    ),
  ).toHaveLength(1);
});

test("a replacement refused after its answer was lost says the key was already replaced, with focus on the heading", async () => {
  loseNext = "rotate";
  const { view } = draw("/admin/credentials");
  await openReplacement(view);
  fireEvent.click(view.getByRole("button", { name: "Review replacement" }));
  const dialog = await view.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace credential" }),
  );
  await view.findByText(
    "Couldn't replace the credential. Your entries are still here.",
  );
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  const said = await view.findByText(
    "openai · production was already replaced. The active credential is in the list.",
  );
  expect(view.queryByText("This credential is unavailable.")).toBeNull();
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  expect(document.activeElement?.textContent).toBe("Replace credential");
  expect(said.isConnected).toBe(true);
  expect(rotates).toEqual([
    "/api/admin/credentials/cred-live/rotate",
    "/api/admin/credentials/cred-live/rotate",
  ]);
  // One rotation landed: the first one. The refused retry wrote nothing.
  expect(credentials.filter((entry) => !entry.revokedAt)).toHaveLength(1);
});

test("a key somebody else replaced before the confirm writes nothing, and the page says so", async () => {
  const { view } = draw("/admin/credentials");
  await openReplacement(view);
  fireEvent.click(view.getByRole("button", { name: "Review replacement" }));
  const dialog = await view.findByRole("alertdialog");
  // Another administrator replaces it while the confirmation is open.
  credentials = [
    credential({ id: "cred-live", revokedAt: REVOKED_AT }),
    credential({ id: "cred-theirs" }),
  ];
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace credential" }),
  );
  await view.findByText(
    "openai · production was already replaced. The active credential is in the list.",
  );
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  expect(rotates).toEqual(["/api/admin/credentials/cred-live/rotate"]);
  expect(credentials.filter((entry) => !entry.revokedAt)).toEqual([
    credential({ id: "cred-theirs" }),
  ]);
});

test("opening Replace for a key that is simply gone says it is unavailable", async () => {
  const { view, router } = draw("/admin/credentials/new");
  await view.findByText("Add credential");
  await act(async () => {
    await router.navigate({
      to: "/admin/credentials/new",
      state: { replaceCredentialId: "cred-gone" },
    });
  });
  await view.findByText(
    "This credential is unavailable. Return to the list to choose another one.",
  );
  expect(view.queryByText(/was already replaced/)).toBeNull();
});
