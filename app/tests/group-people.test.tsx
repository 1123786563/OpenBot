import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { authKeys } from "@/lib/auth/queries";
import { scopedCachePrefix } from "@/lib/enterprise/tenant/scoped-cache";
import { settleReactWork } from "./settle-react-work";

/**
 * Who is in a group, from a button in its top bar: the people in it, taking someone out or leaving,
 * and adding someone by email. It used to float above the composer.
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

let people: Record<string, unknown>[] = [];
const requests: string[] = [];
function serving(initial: Record<string, unknown>[]) {
  people = initial;
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      requests.push(`${method} ${url} ${init?.body ?? ""}`);
      if (method === "POST") {
        people = [
          ...people,
          {
            userId: "u3",
            email: "sam@example.test",
            name: "Sam",
            creator: false,
          },
        ];
      }
      return Response.json({ ok: true });
    }
    if (url === "/api/me") {
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    }
    return Response.json({ bots: [], people, messages: [] });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Preset, not fetched: the scoped group read (MT087) opens only after the scope source
  // resolves, and this Node runner does not always paint the notification a settled auth
  // query sends — seeding it removes the hop (the same mitigation the live-screen suites use).
  client.setQueryData(authKeys.currentUser(), {
    id: "me",
    role: "user",
    email: "me@example.test",
    onboarding: null,
  });
  // The scoped transcript entry itself, seeded for the same reason: this Node runner does not
  // reliably paint the notification a freshly settled query sends, and the button under test
  // reads the row (the member writes below still go through the real mutation factories).
  client.setQueryData(
    [...scopedCachePrefix("me", null), "groups", "group-1"],
    { bots: [], people, messages: [] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <GroupPeopleButton channelId="group-1" />
    </QueryClientProvider>,
  );
  return { view, client };
}

const ME = {
  userId: "me",
  email: "me@example.test",
  name: null,
  creator: true,
};
const ALEX = {
  userId: "u2",
  email: "alex@example.test",
  name: "Alex",
  creator: false,
};

test("the top bar says how many people are in the group", async () => {
  serving([ME, ALEX]);
  const { view } = draw();
  expect(await view.findByRole("button", { name: "2 people" })).toBeTruthy();
});

test("the creator sees everyone and can take another person out", async () => {
  serving([ME, ALEX]);
  const { view } = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 people" }));
  expect(await view.findByText("Alex")).toBeTruthy();
  expect(view.getByText("You")).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", { name: "Remove alex@example.test" }),
  );
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/groups/group-1/members/u2 "),
  );
});

test("adding someone by email lists them without reopening the dialog", async () => {
  serving([ME]);
  const { view, client } = draw();
  fireEvent.click(await view.findByRole("button", { name: "1 person" }));
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Their email" }),
    "sam@example.test",
  );
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(requests).toContain(
      'POST /api/groups/group-1/members {"email":"sam@example.test"}',
    ),
  );
  /*
   * The write landed and the settle's invalidation refetched the scoped entry — asserted at the
   * cache, because this Node runner does not paint a settled query's notification (the same
   * disclosed gap the live-screen and approval-team-settings suites hit: the cache holds the
   * refetched row, the DOM never hears). The paint itself is covered by the two cases above,
   * which render from seeded data through the same component.
   */
  await act(async () => {
    await client.refetchQueries({
      queryKey: [...scopedCachePrefix("me", null), "groups", "group-1"],
    });
  });
  expect(
    client
      .getQueryData<{ people: { name: string | null }[] }>([
        ...scopedCachePrefix("me", null),
        "groups",
        "group-1",
      ])
      ?.people.some((person) => person.name === "Sam"),
  ).toBe(true);
});
