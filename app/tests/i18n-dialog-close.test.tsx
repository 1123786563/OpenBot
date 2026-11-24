import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
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
