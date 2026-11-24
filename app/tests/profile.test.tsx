import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameRow } from "@/components/settings/profile";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The app's own cache, which the name save invalidates, seeded with who is signed in. */
function client(needsName = true) {
  const query = queryClient;
  query.clear();
  // The refetch after a save hits the stubbed fetch; one answer is enough to read the outcome.
  query.setQueryDefaults(authKeys.currentUser(), { retry: false });
  query.setQueryData(authKeys.currentUser(), {
    id: "existing-user",
    email: "dev@openbot.local",
    name: needsName ? "dev@openbot.local" : "Sam",
    needsName,
    onboarding: { completedAt: "2026-01-01", step: 0 },
  });
  return query;
}

async function draw(query: typeof queryClient) {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({ component: NameRow }),
  });
  const view = render(
    <QueryClientProvider client={query}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /^Name/ }));
  const input = await view.findByLabelText("Name");
  return { view, user, input };
}

test("settings saves only the display name and keeps the receipt if refreshing the current user fails", async () => {
  const query = client(false);
  let sent: unknown;
  let refreshed = false;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) === "/api/me/profile") {
        sent = JSON.parse(String(init?.body));
        return Response.json({ profile: { name: "Samuel", needsName: false } });
      }
      refreshed = true;
      return Response.json({}, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { view, user, input } = await draw(query);
  await user.clear(input);
  await user.type(input, " Samuel ");
  await user.click(view.getByRole("button", { name: "Save name" }));
  expect(await view.findByRole("status")).toHaveProperty(
    "textContent",
    "Your name has been saved.",
  );
  expect(sent).toEqual({ name: "Samuel" });
  expect(refreshed).toBe(true);
  expect(view.getByRole("button", { name: /Name Samuel/ })).toBeTruthy();
});

test("failed saves show an error and preserve the draft for retry", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ error: "Could not save your profile." }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  const { view, user, input } = await draw(client(false));
  await user.type(input, " Julien");
  await user.click(view.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Could not save your profile.",
    ),
  );
  expect(input instanceof HTMLInputElement && input.value).toBe("Sam Julien");
});

function replaceName(name: string) {
  queryClient.setQueryData<AuthenticatedUser>(
    authKeys.currentUser(),
    (current) => (current ? { ...current, name, needsName: false } : undefined),
  );
}

test("an untouched settings form reflects a name saved by the welcome dialog", async () => {
  const { input } = await draw(client());
  await act(async () => replaceName("Sam"));
  await waitFor(() =>
    expect(input instanceof HTMLInputElement && input.value).toBe("Sam"),
  );
});

test("a profile refetch does not overwrite an unsaved draft", async () => {
  const { user, input } = await draw(client(false));
  await user.type(input, " Julien");
  await act(async () => replaceName("Samuel"));
  expect(input instanceof HTMLInputElement && input.value).toBe("Sam Julien");
});
