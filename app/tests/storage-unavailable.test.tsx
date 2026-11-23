import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { LanguageRow } from "@/components/settings/language-row";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { Sidebar, SidebarRail, SidebarTrigger } from "@/components/ui/sidebar";
import { I18nProvider, initI18n } from "@/i18n";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function ThemeControl() {
  const { dark, setDark } = useTheme();
  return (
    <button type="button" onClick={() => setDark(!dark)}>
      Change theme
    </button>
  );
}

// These are platform failures for every key, not a mock of the locale storage adapter.
for (const fault of ["getter", "read", "write"] as const) {
  test(`theme, sidebar and language remain usable when all storage ${fault} access fails`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const storage = window.localStorage;
    storage.clear();
    const denied = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get:
        fault === "getter"
          ? denied
          : () => ({
              getItem:
                fault === "read" ? denied : storage.getItem.bind(storage),
              setItem:
                fault === "write"
                  ? () => {
                      throw new DOMException(
                        "Storage full",
                        "QuotaExceededError",
                      );
                    }
                  : storage.setItem.bind(storage),
            }),
    });
    try {
      await act(async () => {
        initI18n();
      });
      const view = render(
        <I18nProvider>
          <ThemeProvider>
            <SidebarShell name="settings" width="300px">
              <Sidebar>
                <SidebarRail />
              </Sidebar>
              <SidebarTrigger />
              <ThemeControl />
              <LanguageRow />
            </SidebarShell>
          </ThemeProvider>
        </I18nProvider>,
      );
      const sidebar = view.container.querySelector('[data-slot="sidebar"]');
      expect(sidebar?.getAttribute("data-state")).toBe("expanded");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      const user = userEvent.setup({ document });
      await user.click(view.getByRole("button", { name: "Change theme" }));
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe("dark");
      const trigger = view.container.querySelector<HTMLElement>(
        '[data-slot="sidebar-trigger"]',
      );
      if (!trigger) throw new Error("Sidebar trigger missing");
      await user.click(trigger);
      expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
      await user.click(trigger);
      expect(sidebar?.getAttribute("data-state")).toBe("expanded");

      const panel = view.container.querySelector<HTMLElement>(
        '[data-slot="sidebar-container"]',
      );
      const rail = view.getByTitle("Drag to resize, click to hide");
      if (!panel) throw new Error("Sidebar panel missing");
      panel.getBoundingClientRect = () => new DOMRect(0, 0, 300, 800);
      rail.setPointerCapture = () => {};
      fireEvent.pointerDown(rail, { button: 0, clientX: 300, pointerId: 1 });
      fireEvent.pointerMove(rail, { clientX: 340, pointerId: 1 });
      fireEvent.pointerUp(rail, { pointerId: 1 });
      expect(
        view.container
          .querySelector('[data-slot="sidebar-wrapper"]')
          ?.getAttribute("style"),
      ).toContain("--sidebar-width: 340px");

      await user.click(view.getByRole("combobox", { name: "Language" }));
      act(() => {
        view.getByRole("option", { name: "简体中文" }).click();
      });
      await settleReactWork();
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(view.getByText("选择 OpenBot 界面文字使用的语言。")).toBeTruthy();
      await user.click(view.getByRole("combobox", { name: "语言" }));
      act(() => {
        view.getByRole("option", { name: "English" }).click();
      });
      await settleReactWork();
      expect(document.documentElement.lang).toBe("en");
      expect(
        view.getByText("Choose the language OpenBot uses for its own text."),
      ).toBeTruthy();
    } finally {
      cleanup();
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else delete (window as unknown as Record<string, unknown>).localStorage;
      storage.clear();
    }
  });
}
