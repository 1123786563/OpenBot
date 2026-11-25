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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { LanguageRow } from "@/components/settings/language-row";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { ThemeProvider } from "@/components/theme-provider";
import { initI18n } from "@/i18n";
import { authKeys } from "@/lib/auth/queries";
import { settingsKeys } from "@/lib/settings/queries";
import { queryClient } from "@/query-client";
import { Route as generalSettingsRoute } from "@/routes/_authed/settings/index";
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
let instructionsUnavailable = false;

beforeEach(() => {
  queryClient.clear();
  instructions = "";
  instructionsUnavailable = false;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/settings/instructions")
        return instructionsUnavailable
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({ instructions });
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
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router as never}>
        <NameRow />
        <StandingInstructionsRow />
      </RouterContextProvider>
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
    within(dialog)
      .getByRole("button", { name: "Save name" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});

test("closing an edited setting asks whether to discard the draft", async () => {
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /^Name/ }));
  const dialog = await view.findByRole("dialog");
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Ada Lovelace");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const discard = await view.findByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(discard).getByRole("button", { name: "Keep editing" }),
  );
  expect(name instanceof HTMLInputElement && name.value).toBe("Ada Lovelace");
});

test("standing instructions are a row that says what they are, or that there are none yet", async () => {
  const view = draw();
  const row = await view.findByRole("button", {
    name: /Applies to every Bot in every conversation\. None yet\./,
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
    await written.findByRole("button", {
      name: /Applies to every Bot in every conversation\. Write in British English\./,
    }),
  ).toBeTruthy();
});

test("standing instructions recover from a failed read inside the editor", async () => {
  instructionsUnavailable = true;
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: /^Standing instructions/ }),
  );
  const dialog = within(await view.findByRole("dialog"));
  const retry = await dialog.findByRole("button", { name: "Retry" });
  expect(dialog.queryByRole("button", { name: "Save" })).toBeNull();

  instructions = "Use British English.";
  instructionsUnavailable = false;
  await user.click(retry);
  const field = await dialog.findByRole("textbox", {
    name: "Standing instructions",
  });
  expect(field instanceof HTMLTextAreaElement && field.value).toBe(
    instructions,
  );
});

/*
 * The page itself: its title, its sections, the dark theme row and the shortcut rows all speak the
 * interface language, and the document title follows. Drawn through the real route, with the
 * desktop-only sections absent because no desktop shell is standing in here.
 */
describe("the General page speaks the interface language", () => {
  afterEach(async () => {
    cleanup();
    await pinLocale("en");
  });

  function drawPage() {
    queryClient.setQueryData(authKeys.currentUser(), {
      id: "ada",
      email: "ada@example.com",
      name: "Ada",
      needsName: false,
    } as never);
    const Page = generalSettingsRoute.options.component as ComponentType;
    // The dialogs' leave guard reads the router, as the layout always gives them one.
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute(),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={router as never}>
          <ThemeProvider>
            <Page />
          </ThemeProvider>
        </RouterContextProvider>
      </QueryClientProvider>,
    );
  }

  const rowTitle = (view: ReturnType<typeof render>, name: string) =>
    view.getByText(name, { selector: '[data-slot="item-title"]' });

  test("in English it reads General, with its sections and the one shortcut", async () => {
    const view = drawPage();
    expect(document.title).toBe("General · OpenBot");
    expect(view.getByRole("heading", { name: "About you" })).toBeTruthy();
    expect(rowTitle(view, "Dark theme")).toBeTruthy();
    expect(
      view.getByText("Use the dark appearance across OpenBot."),
    ).toBeTruthy();
    expect(
      view.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    expect(rowTitle(view, "New conversation")).toBeTruthy();
    expect(
      view.getByText("Start a new conversation from anywhere in OpenBot."),
    ).toBeTruthy();
  });

  test("in Simplified Chinese the page, its sections and its shortcuts read in Chinese", async () => {
    await pinLocale("zh-CN");
    const view = drawPage();
    expect(document.title).toBe("通用 · OpenBot");
    expect(view.getByRole("heading", { name: "关于你" })).toBeTruthy();
    expect(rowTitle(view, "深色主题")).toBeTruthy();
    expect(view.getByText("在 OpenBot 中使用深色外观。")).toBeTruthy();
    // The jump nav main added names itself and its three sections in the interface language.
    const sections = view.getByRole("navigation", { name: "通用设置分区" });
    expect(
      within(sections)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["关于你", "#about-you"],
      ["外观", "#appearance"],
      ["键盘快捷键", "#keyboard-shortcuts"],
    ]);
    expect(
      view.getByText("在侧栏中优先显示对话标题或 Bot 名称。"),
    ).toBeTruthy();
    expect(rowTitle(view, "消息列表突出显示")).toBeTruthy();
    expect(view.getByRole("heading", { name: "键盘快捷键" })).toBeTruthy();
    expect(rowTitle(view, "新对话")).toBeTruthy();
    expect(
      view.getByText("在 OpenBot 的任何地方开始一个新对话。"),
    ).toBeTruthy();
  });

  test("in Chinese the name row and its dialog read in Chinese, with Ada unchanged", async () => {
    await pinLocale("zh-CN");
    const view = drawPage();
    const row = view.getByRole("button", { name: /^姓名/ });
    expect(row.textContent).toContain("Ada");
    await userEvent.setup({ document }).click(row);
    const dialog = await view.findByRole("dialog");
    expect(within(dialog).getByText("你的名字")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("姓名") as HTMLInputElement).value,
    ).toBe("Ada");
    expect(
      within(dialog).getByRole("button", { name: "保存名字" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("选择 OpenBot 为你显示的名字。"),
    ).toBeTruthy();
  });

  test("in Chinese the instructions row and dialog read in Chinese, with written content unchanged", async () => {
    instructions = "Write in British English.";
    queryClient.setQueryData(settingsKeys.instructions(), instructions);
    await pinLocale("zh-CN");
    const view = drawPage();
    const row = view.getByRole("button", { name: /^常设指令/ });
    expect(row.textContent).toContain("Write in British English.");
    await userEvent.setup({ document }).click(row);
    const dialog = await view.findByRole("dialog");
    expect(within(dialog).getByText("常设指令")).toBeTruthy();
    expect(
      within(dialog).getByRole("textbox", { name: "常设指令" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByPlaceholderText(
        "使用英式英语，日期按日–月–年的顺序书写。",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("已用 25 / 4000 个字符")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeTruthy();
    expect(
      within(dialog).getByText(
        "适用于每个对话中的每个 Bot。Bot 的角色说明它做什么；这里说明你希望它怎么做，比如你的写作风格。",
      ),
    ).toBeTruthy();
  });

  test("in Chinese a read that fails speaks the fallback in Chinese, on the row and in the editor", async () => {
    await pinLocale("zh-CN");
    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (String(input) === "/api/settings/instructions")
          return new Response(null, { status: 500 });
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = drawPage();
    const row = view.getByRole("button", { name: /^常设指令/ });
    await waitFor(
      () => expect(row.textContent).toContain("无法加载你的常设指令。"),
      { timeout: 3000 },
    );
    await userEvent.setup({ document }).click(row);
    const dialog = await view.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "无法加载你的常设指令。",
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
  });

  test("in Chinese closing an edited setting asks whether to discard the draft", async () => {
    await pinLocale("zh-CN");
    const view = draw();
    const user = userEvent.setup({ document });
    await user.click(view.getByRole("button", { name: /^姓名/ }));
    const dialog = await view.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeTruthy();
    const name = within(dialog).getByRole("textbox", { name: "姓名" });
    await user.clear(name);
    await user.type(name, "Ada Lovelace");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    const discard = await view.findByRole("alertdialog", {
      name: "放弃未保存的更改？",
    });
    expect(
      within(discard).getByText("关闭此编辑器后，你的更改会丢失。"),
    ).toBeTruthy();
    await user.click(within(discard).getByRole("button", { name: "继续编辑" }));
    expect(name instanceof HTMLInputElement && name.value).toBe("Ada Lovelace");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(
      within(
        await view.findByRole("alertdialog", { name: "放弃未保存的更改？" }),
      ).getByRole("button", { name: "放弃更改" }),
    );
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("in Chinese the instructions row says what they apply to, or that there are none", async () => {
    await pinLocale("zh-CN");
    const view = drawPage();
    expect(view.getByText("适用于每个对话中的每个 Bot。")).toBeTruthy();
    // Awaited, because the row says it is loading until the read has answered.
    expect(await view.findByText("还没有内容。")).toBeTruthy();
  });

  test("in Chinese both rows say they are loading, and then that the read failed", async () => {
    await pinLocale("zh-CN");
    let answer: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    global.fetch = Object.assign(
      async () => {
        await gate;
        return new Response(null, { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    );
    // A cache of this test's own, with no retries, so neither read waits to fail.
    const fresh = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute(),
    });
    const view = render(
      <QueryClientProvider client={fresh}>
        <RouterContextProvider router={router as never}>
          <NameRow />
          <StandingInstructionsRow />
        </RouterContextProvider>
      </QueryClientProvider>,
    );
    const nameRow = () => view.getByRole("button", { name: /^姓名/ });
    const instructionsRow = () =>
      view.getByRole("button", { name: /^常设指令/ });
    expect(nameRow().textContent).toContain("正在加载你的名字…");
    expect(instructionsRow().textContent).toContain("正在加载你的常设指令…");

    answer();
    await waitFor(
      () => expect(nameRow().textContent).toContain("无法加载你的名字。"),
      { timeout: 3000 },
    );
    await waitFor(
      () =>
        expect(instructionsRow().textContent).toContain(
          "无法加载你的常设指令。",
        ),
      { timeout: 3000 },
    );
  });

  test("in Chinese a stale read says so on both rows, and the dialogs offer a refresh", async () => {
    await pinLocale("zh-CN");
    // Both reads have an answer cached and refuse to refresh it: the rows keep what they had.
    let patches = 0;
    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (String(input) === "/api/me/profile") {
          patches += 1;
          return Response.json({
            profile: { name: "Ada Lovelace", needsName: false },
          });
        }
        return new Response(null, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    instructions = "Write in British English.";
    queryClient.setQueryData(settingsKeys.instructions(), instructions);
    const view = draw();
    const user = userEvent.setup({ document });
    const nameRow = view.getByRole("button", { name: /^姓名/ });
    const instructionsRow = view.getByRole("button", { name: /^常设指令/ });
    await waitFor(
      () =>
        expect(instructionsRow.textContent).toContain(
          "上次加载 · 保存前请刷新。",
        ),
      { timeout: 3000 },
    );
    expect(instructionsRow.textContent).toContain("Write in British English.");

    await user.click(nameRow);
    const nameDialog = within(await view.findByRole("dialog"));
    const name = nameDialog.getByRole("textbox", { name: "姓名" });
    await user.type(name, " Lovelace");
    await user.click(nameDialog.getByRole("button", { name: "保存名字" }));
    expect(patches).toBe(1);
    await waitFor(
      () =>
        expect(
          view.getByRole("button", { name: /^姓名/ }).textContent,
        ).toContain("上次加载 · 保存前请刷新。"),
      { timeout: 3000 },
    );
    expect(view.getByRole("status").textContent).toBe("你的名字已保存。");
    // Asked for again: the rows were drawn anew by the save and the failed refresh.
    await user.click(view.getByRole("button", { name: /^姓名/ }));
    const nameAgain = within(await view.findByRole("dialog"));
    expect(nameAgain.getByText("无法刷新你的名字。")).toBeTruthy();
    expect(
      nameAgain.getByText("显示的是上次加载的名字。保存前请刷新。"),
    ).toBeTruthy();
    expect(nameAgain.getByRole("button", { name: "刷新名字" })).toBeTruthy();

    // The open dialog hides the page behind it from assistive technology, so it closes first.
    await user.click(nameAgain.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await user.click(view.getByRole("button", { name: /^常设指令/ }));
    const instructionsDialog = within(await view.findByRole("dialog"));
    expect(instructionsDialog.getByText("无法刷新你的常设指令。")).toBeTruthy();
    expect(
      instructionsDialog.getByText(
        "显示的是上次加载的常设指令。保存前请刷新。",
      ),
    ).toBeTruthy();
    expect(
      instructionsDialog.getByRole("button", { name: "刷新常设指令" }),
    ).toBeTruthy();
  });

  test("in Chinese a save that fails speaks the fallback in Chinese", async () => {
    await pinLocale("zh-CN");
    global.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) === "/api/settings/instructions") {
          if (init?.method === "PUT")
            return new Response(null, { status: 500 });
          return Response.json({ instructions: "" });
        }
        return new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = drawPage();
    await view.findByRole("button", { name: /^常设指令/ });
    await userEvent
      .setup({ document })
      .click(view.getByRole("button", { name: /^常设指令/ }));
    const dialog = await view.findByRole("dialog");
    const box = await within(dialog).findByRole("textbox", {
      name: "常设指令",
    });
    await userEvent.setup({ document }).type(box, "先简后繁。");
    await userEvent
      .setup({ document })
      .click(within(dialog).getByRole("button", { name: "保存" }));
    expect(
      await within(dialog).findByText("无法保存你的常设指令"),
    ).toBeTruthy();
  });
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
    expect(document.activeElement).toBe(
      view.getByRole("combobox", { name: "语言" }),
    );
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

test("standing instructions remain fully readable in the settings row", async () => {
  instructions = "A long instruction ".repeat(40);
  queryClient.setQueryData(settingsKeys.instructions(), instructions);
  const view = draw();
  const preview = await view.findByText(instructions.trim());
  expect(preview.className).not.toMatch(/\bline-clamp-\d/);
});
