import { afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { agentListQueryOptions } from "@/lib/agents/queries";
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
  return render(
    <QueryClientProvider client={client}>
      <SuggestionsInbox agentId="research" />
    </QueryClientProvider>,
  );
}

test("a Bot's Ideas show a failed suggestion request", async () => {
  const view = openBotSuggestions(
    Response.json({ error: "Check-ins could not load" }, { status: 503 }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Check-ins could not load",
  );
});
