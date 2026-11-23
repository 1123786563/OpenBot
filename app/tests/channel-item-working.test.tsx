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
import { act, cleanup, render } from "@testing-library/react";
import { i18n, setLocalePreference } from "@/i18n";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation in the sidebar says "Working" while its Bot works on it, where its time goes, and shows its time
 * again once the work is done.
 */

beforeAll(() => GlobalRegistrator.register());
beforeEach(async () => {
  // The language singleton is shared with every other test file in the run.
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function row(busy: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentListQueryOptions().queryKey, []);
  return render(
    <QueryClientProvider client={client}>
      <ChannelItemContent
        busy={busy}
        emphasis="agent"
        lastMessageAt="2m"
        name="Personal Assistant"
        participantIds={["bot-1"]}
        title="Plan the trip"
      />
    </QueryClientProvider>,
  );
}

test("a conversation whose Bot is working says Working where its time goes", () => {
  const view = row(true);
  expect(view.getByText("Working")).toBeTruthy();
  expect(view.queryByText("2m")).toBeNull();
});

test("once the Bot is done, the conversation shows its time again", () => {
  const view = row(false);
  expect(view.getByText("2m")).toBeTruthy();
  expect(view.queryByText("Working")).toBeNull();
});

test("the working note follows the interface language on the same row", async () => {
  const view = row(true);
  const working = view.getByText("Working");
  await act(() => setLocalePreference("zh-CN"));
  expect(view.getByText("处理中")).toBe(working);
  await act(() => setLocalePreference("en"));
  expect(view.getByText("Working")).toBe(working);
});
