import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Toaster } from "@/components/ui/toast";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

// The close control is the one string these two shared layers draw themselves; everything inside
// them comes from the caller, which already speaks the interface language.
test("a dialog's close control speaks the interface language", async () => {
  const view = render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Title</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  expect(view.getByRole("button", { name: "Close" })).toBeTruthy();

  await pinLocale("zh-CN");
  expect(view.getByRole("button", { name: "关闭" })).toBeTruthy();
});

// Base UI names the toast region itself, in English; the shared toaster names it in its place.
test("the toast region speaks the interface language", async () => {
  const view = render(<Toaster />);
  expect(view.getByRole("region", { name: "Notifications" })).toBeTruthy();

  await pinLocale("zh-CN");
  expect(view.getByRole("region", { name: "通知" })).toBeTruthy();
});

test("the frame's skip link speaks the interface language", async () => {
  const view = render(
    <SidebarShell name="settings" width="300px">
      <main id="main-content">Content</main>
    </SidebarShell>,
  );
  const link = view.getByRole("link", { name: "Skip to content" });
  expect(link.getAttribute("href")).toBe("#main-content");

  await pinLocale("zh-CN");
  expect(view.getByRole("link", { name: "跳到主要内容" })).toBe(link);
});

test("a sheet's close control speaks the interface language", async () => {
  const view = render(
    <Sheet open>
      <SheetContent>
        <SheetTitle>Title</SheetTitle>
      </SheetContent>
    </Sheet>,
  );
  expect(view.getByRole("button", { name: "Close" })).toBeTruthy();

  await pinLocale("zh-CN");
  expect(view.getByRole("button", { name: "关闭" })).toBeTruthy();
});
