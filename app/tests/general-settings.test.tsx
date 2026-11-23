import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageRow } from "@/components/settings/language-row";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { initI18n } from "@/i18n";
import { authKeys } from "@/lib/auth/queries";
import { settingsKeys } from "@/lib/settings/queries";
import { queryClient } from "@/query-client";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * General's two free-text answers, drawn as the layout has every free text: a row that states the answer, and a dialog
 * that changes it.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let instructions = "";

beforeEach(() => {
  queryClient.clear();
  instructions = "";
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/settings/instructions")
        return Response.json({ instructions });
      if (path === "/api/me")
        return Response.json({
          user: { id: "ada", email: "ada@example.com", name: "Ada" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "ada",
    email: "ada@example.com",
    name: "Ada",
    needsName: false,
  } as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <NameRow />
      <StandingInstructionsRow />
    </QueryClientProvider>,
  );
}

test("the name is a row that states it and opens a dialog to change it", async () => {
  const view = draw();
  const row = view.getByRole("button", { name: /^Name/ });
  expect(row.textContent).toContain("Ada");
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Ada");
  expect(
    within(dialog).getByRole("button", { name: "Save name" }),
  ).toBeTruthy();
});

test("standing instructions are a row that says what they are, or that there are none yet", async () => {
  const view = draw();
  const row = await view.findByRole("button", {
    name: /None yet\. Tell every Bot how you want things done\./,
  });
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByRole("textbox", {
      name: "Standing instructions",
    }),
  ).toBeTruthy();
  cleanup();

  queryClient.clear();
  instructions = "Write in British English.";
  queryClient.setQueryData(settingsKeys.instructions(), instructions);
  const written = draw();
  expect(
    await written.findByRole("button", { name: /Write in British English\./ }),
  ).toBeTruthy();
});

/*
 * The language row is the one place this ticket translates, drawn like every other choice on this
 * page: a row that states it and a select that changes it at once. The language names themselves are
 * written in their own language in both catalogs, so they never translate.
 */
describe("the language row", () => {
  const rowTitle = (view: ReturnType<typeof render>, name: string) =>
    view.getByText(name, { selector: '[data-slot="item-title"]' });

  /*
   * Two ways a visit begins: fresh, with nothing stored, or reopened, reading whatever choice is
   * stored back. Only the fresh one clears storage.
   */
  async function reopen() {
    await act(async () => {
      initI18n();
    });
  }

  async function startFresh() {
    localStorage.removeItem("openbot-locale");
    await reopen();
  }

  beforeEach(() => startFresh());
  afterEach(async () => {
    cleanup();
    await pinLocale("en");
    localStorage.removeItem("openbot-locale");
  });

  test("it follows the browser, offering English and 简体中文 in their own writing", async () => {
    const view = render(<LanguageRow />);
    expect(rowTitle(view, "Language")).toBeTruthy();
    expect(
      view.getByText("Choose the language OpenBot uses for its own text."),
    ).toBeTruthy();
    const trigger = view.getByRole("combobox", { name: "Language" });
    expect(trigger.textContent).toBe("Follow the browser");
    const user = userEvent.setup({ document });
    await user.click(trigger);
    expect(
      (await view.findAllByRole("option")).map((option) => option.textContent),
    ).toEqual(["Follow the browser", "English", "简体中文"]);
  });

  test("choosing 简体中文 redraws this row in Chinese at once, without reloading", async () => {
    const view = render(<LanguageRow />);
    const user = userEvent.setup({ document });
    await user.click(view.getByRole("combobox", { name: "Language" }));
    act(() => {
      view.getByRole("option", { name: "简体中文" }).click();
    });
    await settleReactWork();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(view.getByRole("combobox", { name: "语言" }).textContent).toBe(
      "简体中文",
    );
    expect(rowTitle(view, "语言")).toBeTruthy();
    expect(view.getByText("选择 OpenBot 界面文字使用的语言。")).toBeTruthy();
    expect(localStorage.getItem("openbot-locale")).toBe("zh-CN");

    // What a fresh start of the page shows, having read the same choice back.
    cleanup();
    await reopen();
    const again = render(<LanguageRow />);
    expect(again.getByRole("combobox", { name: "语言" }).textContent).toBe(
      "简体中文",
    );
  });

  test("choosing English again speaks it at once, finding it unchanged in the Chinese menu", async () => {
    const view = render(<LanguageRow />);
    const user = userEvent.setup({ document });
    await user.click(view.getByRole("combobox", { name: "Language" }));
    act(() => {
      view.getByRole("option", { name: "简体中文" }).click();
    });
    await settleReactWork();
    await user.click(view.getByRole("combobox", { name: "语言" }));
    act(() => {
      view.getByRole("option", { name: "English" }).click();
    });
    await settleReactWork();
    expect(document.documentElement.lang).toBe("en");
    expect(view.getByRole("combobox", { name: "Language" }).textContent).toBe(
      "English",
    );
    expect(
      view.getByText("Choose the language OpenBot uses for its own text."),
    ).toBeTruthy();
    expect(localStorage.getItem("openbot-locale")).toBe("en");
  });

  test("a choice made in an earlier visit is what the row opens with", async () => {
    localStorage.setItem("openbot-locale", "zh-CN");
    await reopen();
    const view = render(<LanguageRow />);
    expect(view.getByRole("combobox", { name: "语言" }).textContent).toBe(
      "简体中文",
    );
    expect(view.getByText("选择 OpenBot 界面文字使用的语言。")).toBeTruthy();
  });
});
