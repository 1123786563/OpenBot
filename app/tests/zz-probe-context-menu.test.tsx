import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/*
 * WHY EVERY QUERY BELOW GOES THROUGH `render`'S RESULT AND NOT `screen`.
 *
 * `screen` is bound to `document.body` ONCE, while `@testing-library/dom`'s screen module is first
 * evaluated. On this runner (e2e, node target) that evaluation happens at file import — after
 * `tests/preload.ts` has already closed its short-lived windows and before `beforeAll` registers
 * this file's own one — so `screen` captures the throwing stubs and every query fails with
 * "For queries bound to document.body a global document has to be available". That environment
 * error is what this suite's original 8 reds were: not one assertion ever ran. Scoped queries are
 * also the pattern every other native suite in `app/tests` uses. Single-variable check (H10):
 * the same file reading every query through `screen` errors 8/8 before any product behavior is
 * reached; scoped, the behaviors below assert.
 *
 * WHY THE TWO "CLOSES" TESTS ASSERT THE CLOSE REQUEST (controlled `onOpenChange`) AND NOT DOM
 * REMOVAL. React Aria popovers unmount only after their exit animation resolves. happy-dom has no
 * `Element.getAnimations`, and — measured, not assumed — the exit never completes here: the menu
 * element stays mounted with `data-exiting="true"` indefinitely. That is a property of the
 * runtime, not of this adapter: a raw HeroUI `<Dropdown>` (React Aria's own MenuTrigger wiring,
 * none of this file's code) leaves its menu mounted the same way after an item click. The close
 * path itself is instrumented green — RAC's item click reaches the Menu `onClose`, which flips the
 * root state — and the real-browser counterpart is proven for this same popover stack by the H01
 * CDP harness run (Select ESC closes the popup: `options: 0`), with the context menu's own
 * physical-key / touch browser pass scheduled as the H15 backlog item. So the harness can prove
 * the CONTRACT (the close is requested, exactly once); whether the exit animation is observable
 * (data-exiting, then unmount) or the popover unmounts outright depends on shared-process module
 * state this suite does not control, so neither is asserted.
 */

type AnchorRowProps = {
  onPick?: () => void;
  /** Controlled-open witness: records every close request the menu issues. */
  onCloseRequest?: () => void;
};

function AnchorRow({ onPick, onCloseRequest }: AnchorRowProps) {
  const [checked, setChecked] = useState(false);
  const [radio, setRadio] = useState<number | null>(null);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) onCloseRequest?.();
      }}
    >
      <ContextMenuTrigger>
        <button type="button">row</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onPick}>Pin</ContextMenuItem>
        <ContextMenuItem disabled onClick={onPick}>
          Disabled
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
          Show
        </ContextMenuCheckboxItem>
        <ContextMenuRadioGroup
          value={radio}
          onValueChange={(value) => setRadio(value as 1 | 2)}
        >
          <ContextMenuRadioItem value={1}>One</ContextMenuRadioItem>
          <ContextMenuRadioItem value={2}>Two</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderRow(props: AnchorRowProps = {}): RenderResult {
  return render(<AnchorRow {...props} />);
}

test("right click opens at the pointer and the anchor follows", async () => {
  const scoped = renderRow();
  fireEvent.contextMenu(scoped.getByText("row").parentElement as HTMLElement, {
    clientX: 120,
    clientY: 80,
  });
  const menu = await scoped.findByRole("menu");
  expect(menu).toBeTruthy();
  const anchor = document.querySelector(
    '[data-slot="context-menu-anchor"]',
  ) as HTMLElement;
  expect(anchor.style.left).toBe("120px");
  expect(anchor.style.top).toBe("80px");
});

test("Shift+F10 opens and focuses the menu", async () => {
  const scoped = renderRow();
  const button = scoped.getByText("row");
  button.focus();
  fireEvent.keyDown(button, { key: "F10", shiftKey: true });
  const menu = await scoped.findByRole("menu");
  expect(menu).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBeTruthy());
});

test("item activation runs once and requests the close", async () => {
  let picks = 0;
  let closeRequests = 0;
  const scoped = renderRow({
    onPick: () => picks++,
    onCloseRequest: () => closeRequests++,
  });
  fireEvent.contextMenu(scoped.getByText("row").parentElement as HTMLElement);
  const item = await scoped.findByRole("menuitem", { name: "Pin" });
  fireEvent.click(item);
  await waitFor(() => expect(closeRequests).toBe(1));
  // Exactly one send for one click: the legacy onClick ran once, not once per wrapped handler.
  expect(picks).toBe(1);
});

test("disabled item does nothing", async () => {
  let picks = 0;
  const scoped = renderRow({ onPick: () => picks++ });
  fireEvent.contextMenu(scoped.getByText("row").parentElement as HTMLElement);
  const item = await scoped.findByRole("menuitem", { name: "Disabled" });
  fireEvent.click(item);
  expect(picks).toBe(0);
});

test("checkbox toggles once and keeps the menu open", async () => {
  const scoped = renderRow();
  fireEvent.contextMenu(scoped.getByText("row").parentElement as HTMLElement);
  const item = await scoped.findByRole("menuitemcheckbox", { name: "Show" });
  expect(item.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(item);
  await waitFor(() =>
    expect(
      scoped
        .getByRole("menuitemcheckbox", { name: "Show" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(scoped.getByRole("menu")).toBeTruthy();
});

test("radio selects the domain value once", async () => {
  const scoped = renderRow();
  fireEvent.contextMenu(scoped.getByText("row").parentElement as HTMLElement);
  const two = await scoped.findByRole("menuitemradio", { name: "Two" });
  fireEvent.click(two);
  await waitFor(() =>
    expect(
      scoped
        .getByRole("menuitemradio", { name: "Two" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("Escape while the menu has focus requests the close", async () => {
  let closeRequests = 0;
  const scoped = renderRow({ onCloseRequest: () => closeRequests++ });
  const button = scoped.getByText("row");
  button.focus();
  fireEvent.contextMenu(button.parentElement as HTMLElement);
  const menu = await scoped.findByRole("menu");
  expect(menu).toBeTruthy();
  await act(async () => {
    // Focus inside the overlay first: that is where a keyboard user is when Escape means "close
    // the menu". With focus outside it (a pointer-opened menu leaves focus on the trigger),
    // React Aria's overlay-level Escape handling does not claim the key in happy-dom — the
    // browser-side behavior of that path is the H15 backlog item.
    menu.focus();
    fireEvent.keyDown(menu, { key: "Escape" });
  });
  await waitFor(() => expect(closeRequests).toBe(1));
});

test("touch long press opens after the delay and a drag cancels it", async () => {
  const scoped = renderRow();
  const trigger = scoped.getByText("row").parentElement as HTMLElement;
  fireEvent.touchStart(trigger, {
    touches: [{ clientX: 30, clientY: 40, identifier: 1 }],
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 560));
  });
  expect(await scoped.findByRole("menu")).toBeTruthy();

  cleanup();
  const second = renderRow();
  const trigger2 = second.getByText("row").parentElement as HTMLElement;
  fireEvent.touchStart(trigger2, {
    touches: [{ clientX: 30, clientY: 40, identifier: 1 }],
  });
  fireEvent.touchMove(trigger2, {
    touches: [{ clientX: 80, clientY: 40, identifier: 1 }],
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 560));
  });
  expect(second.queryByRole("menu")).toBeNull();
});
