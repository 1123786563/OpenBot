import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
beforeAll(() => { GlobalRegistrator.register(); });
afterEach(() => { cleanup(); });
afterAll(() => { GlobalRegistrator.unregister(); });
test("probe e: render Dialog only", async () => {
  const v = render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>
        <DialogTitle>Probe</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  expect(await v.findByRole("dialog")).toBeTruthy();
});
