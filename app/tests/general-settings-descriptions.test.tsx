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
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { I18nProvider, initI18n } from "@/i18n";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ preferences: { messageListEmphasis: "agent" } }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function renderMessageListPreference() {
  await act(async () => {
    initI18n();
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MessageListPreference />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // The row as it stands once the account's preferences have arrived.
  await view.findByText("General Assistant");
  return view;
}

// Happy DOM does no layout; the real-browser matrix in 154-followup.md shows the clamp cutting this copy.
test("nothing clamps the message list emphasis description", async () => {
  const view = await renderMessageListPreference();
  const description = view.getByText(
    "Show the conversation title or the Bot name first in the sidebar.",
  );
  expect(description.className).not.toMatch(/\bline-clamp-\d/);
});

// The row's icon aligns with its title through this slot (see ItemMedia in ui/item.tsx).
test("the message list emphasis row keeps its description slot", async () => {
  const view = await renderMessageListPreference();
  expect(
    view.container.querySelector('[data-slot="item-description"]')?.textContent,
  ).toBe("Show the conversation title or the Bot name first in the sidebar.");
});
