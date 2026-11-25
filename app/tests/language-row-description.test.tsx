import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { LanguageRow } from "@/components/settings/language-row";
import { I18nProvider, initI18n } from "@/i18n";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function renderLanguageRow() {
  await act(async () => {
    initI18n();
  });
  return render(
    <I18nProvider>
      <LanguageRow />
    </I18nProvider>,
  );
}

// Happy DOM does no layout; the real-browser matrix in 150-fixes-browser.md proves the wrapping.
test("nothing clamps the language description", async () => {
  const view = await renderLanguageRow();
  const description = view.getByText(
    "Choose the language OpenBot uses for its own text.",
  );
  expect(description.className).not.toMatch(/\bline-clamp-\d/);
});

// The row's icon aligns with its title through this slot (see ItemMedia in ui/item.tsx).
test("the language row keeps its description slot", async () => {
  const view = await renderLanguageRow();
  expect(
    view.container.querySelector('[data-slot="item-description"]')?.textContent,
  ).toBe("Choose the language OpenBot uses for its own text.");
});
