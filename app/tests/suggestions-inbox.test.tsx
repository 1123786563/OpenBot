import { afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { proactiveSuggestionsQueryOptions } from "@/lib/proactive";
import { settleReactWork } from "./settle-react-work";

afterEach(async () => {
  cleanup();
  fetchMock?.mockRestore();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

function openBotSuggestions(suggestions: Response) {
  GlobalRegistrator.register({ url: "http://openbot.test" });
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(suggestions);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentListQueryOptions().queryKey, []);
  const view = render(
    <QueryClientProvider client={client}>
      <SuggestionsInbox agentId="research" searchable showEmpty />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

test("a Bot's Ideas can recover a failed suggestion request in place", async () => {
  const view = openBotSuggestions(
    Response.json({ error: "Check-ins could not load" }, { status: 503 }),
  );
  expect(
    await view.findByText("Couldn’t load suggested next steps"),
  ).toBeTruthy();
  fetchMock?.mockResolvedValue(Response.json({ suggestions: [] }));
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("suggestions stay readable after a temporary failure and disappear when access is denied", async () => {
  const view = openBotSuggestions(
    Response.json({
      suggestions: [
        {
          id: "notes",
          agentId: "research",
          title: "Review meeting notes",
          detail: "Calendar has new notes.",
          createdAt: "2026-11-23T10:00:00Z",
        },
      ],
    }),
  );
  const title = "Review meeting notes";
  await view.findByRole("button", { name: "Work on it" });

  fetchMock?.mockResolvedValue(Response.json({}, { status: 503 }));
  await act(() =>
    view.client.invalidateQueries(proactiveSuggestionsQueryOptions()),
  );
  await view.findByText("Showing the last loaded suggestions.");
  expect(view.getByText(title)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Work on it" })).toBeNull();
  expect(view.queryByRole("button", { name: `Dismiss ${title}` })).toBeNull();

  fetchMock?.mockResolvedValue(Response.json({}, { status: 403 }));
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await view.findByText("Couldn’t load suggested next steps");
  expect(view.queryByText(title)).toBeNull();

  fetchMock?.mockResolvedValue(Response.json({}, { status: 503 }));
  await act(() =>
    view.client.invalidateQueries(proactiveSuggestionsQueryOptions()),
  );
  expect(view.queryByText(title)).toBeNull();
  expect(view.queryByText("Showing the last loaded suggestions.")).toBeNull();
});

test("dismissing a suggestion requires confirmation and checks that the idea is still open", async () => {
  const title = "Review meeting notes";
  const view = openBotSuggestions(
    Response.json({
      suggestions: [
        {
          id: "notes",
          agentId: "research",
          title,
          detail: "Calendar has new notes.",
          createdAt: "2026-11-23T10:00:00Z",
        },
      ],
    }),
  );
  const dismiss = await view.findByRole("button", { name: `Dismiss ${title}` });
  const writes = () =>
    fetchMock?.mock.calls.filter(([url]) => String(url).endsWith("/dismiss"));

  fireEvent.click(dismiss);
  const dialog = await view.findByRole("alertdialog", {
    name: `Dismiss ${title}?`,
  });
  expect(within(dialog).getByText(/30 days/)).toBeTruthy();
  expect(writes()).toHaveLength(0);

  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes()).toHaveLength(0);

  fireEvent.click(dismiss);
  fetchMock?.mockResolvedValue(Response.json({ suggestions: [] }));
  fireEvent.click(await view.findByRole("button", { name: "Dismiss idea" }));
  expect(
    await view.findByText("This idea is no longer in the list."),
  ).toBeTruthy();
  expect(writes()).toHaveLength(0);
});
