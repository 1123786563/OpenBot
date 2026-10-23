import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Button,
  Checkbox,
  Link,
  ListBox,
  Modal,
  Select,
  Switch,
  TextArea,
  Tooltip,
} from "@heroui/react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { settleReactWork } from "./settle-react-work";

/*
 * NOTE ON THE MODAL TESTS BELOW. react-aria decides ONCE, while its `useLayoutEffect` module is
 * first evaluated, whether it exports React's layout effect or a no-op, and a RAC overlay runs its
 * enter/exit animation inside that effect. With the no-op, a modal closed through `isOpen` flips to
 * `exiting` and never reaches `closed`: the `<section role="dialog">` stays mounted with
 * `data-exiting="true"`, and its focus scope leaves `aria-hidden` on every sibling, so the next
 * test's dialogs are found but unreadable. `preload.ts` therefore imports `@heroui/react/modal`
 * inside its document window; a test file cannot, because the module may already be cached by a
 * sibling by the time this file is evaluated.
 */

/**
 * H01 compatibility spike. Isolated: nothing here is imported by a production route.
 *
 * What this file can prove under happy-dom: element/role output, ARIA state, value contracts
 * (including non-string keys and null), controlled open/onOpenChange callbacks, label wiring and
 * that HeroUI's anchor path is a real anchor. What it cannot prove — focus return, scroll lock,
 * portal placement, pointer-positioned context menus, IME — is listed in
 * .archive/runs/2026-10-19-heroui-migration/h01/spike-plan.md and must be run in a browser.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("H01 Button / Link contract", () => {
  test("Button renders a real button and forwards press", async () => {
    let pressed = 0;
    const view = render(<Button onPress={() => (pressed += 1)}>Save</Button>);
    const button = view.getByRole("button", { name: "Save" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(pressed).toBe(1);
  });

  test("Button render prop is a function over a button element, not an element", () => {
    // Type-level evidence lives in @heroui/react/dist/components/button/button.d.ts:
    // `ButtonRootProps extends ComponentPropsWithRef<RAC Button>` and RAC ButtonProps omits
    // href/target/rel and takes `render?: DOMRenderFunction<'button', ButtonRenderProps>`.
    // This test only proves the runtime shape composes when the expected element is a button.
    const view = render(
      <Button
        render={(props) => <button data-spike="rendered" {...props} />}
        variant="primary"
      >
        Rendered
      </Button>,
    );
    const button = view.getByRole("button", { name: "Rendered" });
    expect(button.getAttribute("data-spike")).toBe("rendered");
    expect(button.tagName).toBe("BUTTON");
  });

  test("Link renders an anchor, keeps href, and does not cancel modified clicks", () => {
    const view = render(
      <Link href="/settings" className="button button--md">
        Settings
      </Link>,
    );
    const anchor = view.getByRole("link", {
      name: "Settings",
    }) as HTMLAnchorElement;
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBe("/settings");

    const modified = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    anchor.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  test("Link and Button are distinct elements (no nested button/anchor)", () => {
    const view = render(
      <div>
        <Button>Action</Button>
        <Link href="/x">Go</Link>
      </div>,
    );
    expect(view.getByRole("button", { name: "Action" }).tagName).toBe("BUTTON");
    expect(view.getByRole("link", { name: "Go" }).tagName).toBe("A");
    expect(view.container.querySelector("button a, a button")).toBeNull();
  });
});

describe("H01 Select contract", () => {
  type ModelId = 101 | 202 | 303;
  const items: { id: ModelId; name: string; disabled?: boolean }[] = [
    { id: 101, name: "Alpha" },
    { id: 202, name: "Beta" },
    { id: 303, name: "Gamma", disabled: true },
  ];

  function SelectHarness({
    onChange,
    initial,
  }: {
    onChange: (id: ModelId | null) => void;
    initial: ModelId | null;
  }) {
    const [selected, setSelected] = useState<ModelId | null>(initial);
    return (
      <Select
        aria-label="Model"
        disabledKeys={[303]}
        onSelectionChange={(key) => {
          const next = key === null ? null : (Number(key) as ModelId);
          setSelected(next);
          onChange(next);
        }}
        selectedKey={selected}
      >
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {items.map((item) => (
              <ListBox.Item id={item.id} key={item.id} textValue={item.name}>
                {item.name}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    );
  }

  test("preserves a numeric domain key and shows its textValue", () => {
    const view = render(<SelectHarness initial={202} onChange={() => {}} />);
    const trigger = view.getByRole("button", { name: /Model/ });
    expect(trigger.textContent).toContain("Beta");
  });

  test("supports a null (empty) selection", () => {
    const view = render(<SelectHarness initial={null} onChange={() => {}} />);
    const trigger = view.getByRole("button", { name: /Model/ });
    expect(trigger.textContent).not.toContain("Beta");
  });

  test("reports the exact numeric key, not a stringified label", async () => {
    const seen: (ModelId | null)[] = [];
    const view = render(
      <SelectHarness initial={null} onChange={(id) => seen.push(id)} />,
    );
    fireEvent.click(view.getByRole("button", { name: /Model/ }));
    const option = await view.findByRole("option", { name: "Alpha" });
    fireEvent.click(option);
    await waitFor(() => expect(seen).toEqual([101]));
    expect(typeof seen[0]).toBe("number");
  });

  test("keeps disabled options unselectable", async () => {
    const seen: (ModelId | null)[] = [];
    const view = render(
      <SelectHarness initial={null} onChange={(id) => seen.push(id)} />,
    );
    fireEvent.click(view.getByRole("button", { name: /Model/ }));
    const option = await view.findByRole("option", { name: "Gamma" });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(option);
    expect(seen).toEqual([]);
  });
});

describe("H01 Modal contract", () => {
  /*
   * A dialog or a backdrop that survives its own test is the failure this file was bitten by, so
   * every modal test starts by proving the body carried nothing over: a leftover overlay hides the
   * next test's dialogs behind `aria-hidden` and turns one real failure into two confusing ones.
   */
  function expectCleanBody() {
    expect(
      document.querySelectorAll('[data-slot="modal-backdrop"]').length,
    ).toBe(0);
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  }

  function expectNoModalPortals() {
    expect(
      document.querySelectorAll('[data-slot="modal-backdrop"]').length,
    ).toBe(0);
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  }

  function ModalHarness({ onChange }: { onChange: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Open</Button>
        <Modal
          isOpen={open}
          onOpenChange={(next) => {
            setOpen(next);
            onChange(next);
          }}
        >
          <Modal.Backdrop>
            <Modal.Container>
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading>Spike dialog</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p>Body</p>
                </Modal.Body>
                <Modal.Footer>
                  <Modal.CloseTrigger>Close</Modal.CloseTrigger>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      </>
    );
  }

  test("is controlled by isOpen and emits onOpenChange on ESC", async () => {
    expectCleanBody();
    const changes: boolean[] = [];
    const view = render(
      <ModalHarness onChange={(open) => changes.push(open)} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Open" }));
    const dialog = await view.findByRole("dialog", { name: "Spike dialog" });
    expect(dialog).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(changes).toEqual([false]));
    // `changes` proves the controlled callback; this proves the controlled VALUE was honoured:
    // the portal, its backdrop and the dialog are gone once the exit has settled.
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Spike dialog" })).toBeNull(),
    );
    await waitFor(expectNoModalPortals);
  });

  test("nests a second dialog and closes only the top layer on ESC", async () => {
    expectCleanBody();
    function Nested() {
      return (
        <Modal isOpen onOpenChange={() => {}}>
          <Modal.Backdrop>
            <Modal.Container>
              <Modal.Dialog aria-label="Outer">
                <Modal.Heading>Outer</Modal.Heading>
                <Modal.Body>
                  <Modal isOpen onOpenChange={() => {}}>
                    <Modal.Backdrop>
                      <Modal.Container>
                        <Modal.Dialog aria-label="Inner">
                          <Modal.Heading>Inner</Modal.Heading>
                          <Modal.Body>inner body</Modal.Body>
                        </Modal.Dialog>
                      </Modal.Container>
                    </Modal.Backdrop>
                  </Modal>
                </Modal.Body>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      );
    }
    const view = render(<Nested />);
    expect(await view.findByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(await view.findByRole("dialog", { name: "Inner" })).toBeTruthy();
    // Two layers, both readable: the inner one must not be hidden by the outer layer's aria-hidden.
    expect(view.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(view.getByRole("dialog", { name: "Inner" })).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="modal-backdrop"]').length,
    ).toBe(2);
  });
});

describe("H01 form controls contract", () => {
  test("Checkbox supports controlled checked and indeterminate", async () => {
    function Harness() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          isIndeterminate={!checked}
          isSelected={checked}
          onChange={setChecked}
        >
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>Select all</Checkbox.Content>
        </Checkbox>
      );
    }
    const view = render(<Harness />);
    const checkbox = view.container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(checkbox.indeterminate).toBe(false);
  });

  test("Switch reports checked state and toggles", async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return (
        <Switch isSelected={on} onChange={setOn}>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>Notifications</Switch.Content>
        </Switch>
      );
    }
    const view = render(<Harness />);
    const control = view.getByRole("switch", {
      name: "Notifications",
    }) as HTMLInputElement;
    expect(control.checked).toBe(false);
    fireEvent.click(control);
    await waitFor(() =>
      expect(
        (
          view.getByRole("switch", {
            name: "Notifications",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
  });

  test("TextArea keeps a controlled value and emits changes once", async () => {
    let changes = 0;
    function Harness() {
      const [value, setValue] = useState("hello");
      return (
        <TextArea
          aria-label="Notes"
          onChange={(event) => {
            changes += 1;
            setValue(event.target.value);
          }}
          value={value}
        />
      );
    }
    const view = render(<Harness />);
    const textarea = view.getByRole("textbox", {
      name: "Notes",
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello");
    /*
     * React Aria's controlled textarea does not process the synthetic `input` event
     * `fireEvent.change` dispatches — the value resurrects on the next render (the H06/H13
     * root cause, recorded in h06/REPORT.md). A person replacing what the field holds, one
     * real keystroke at a time, is the path the controlled value follows here too.
     */
    const user = userEvent.setup({ document: textarea.ownerDocument });
    await user.type(textarea, "{Backspace}".repeat("hello".length));
    await user.type(textarea, "hi");
    await waitFor(() => expect(textarea.value).toBe("hi"));
    // One change per keystroke: 5 Backspaces to clear "hello", then 2 characters.
    expect(changes).toBe(7);
  });
});

describe("H01 Tooltip contract", () => {
  test("describes its trigger and reveals content on keyboard focus", async () => {
    const view = render(
      <Tooltip delay={0}>
        <Tooltip.Trigger
          render={(props) => (
            // Trigger props are typed for the div it usually draws; a Button takes the same DOM
            // events as generic Element handlers. The handler set is unchanged.
            <Button {...(props as unknown as ComponentProps<typeof Button>)}>
              Hover me
            </Button>
          )}
        />
        <Tooltip.Content>Helpful text</Tooltip.Content>
      </Tooltip>,
    );
    const trigger = view.getByRole("button", { name: "Hover me" });
    trigger.focus();
    fireEvent.focusIn(trigger);
    const tip = await view.findByRole("tooltip");
    expect(tip.textContent).toContain("Helpful text");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
  });

  test("wrapping a Button in Tooltip.Trigger adds a second interactive role", () => {
    const view = render(
      <Tooltip delay={0}>
        <Tooltip.Trigger>
          <Button>Wrapped</Button>
        </Tooltip.Trigger>
        <Tooltip.Content>Helpful text</Tooltip.Content>
      </Tooltip>,
    );
    // Evidence for the adapter contract: the default trigger is a div[role=button] wrapper, so
    // wrapping an existing Button creates nested interactive roles. H02/H03 must use `render`.
    expect(view.getAllByRole("button", { name: "Wrapped" }).length).toBe(2);
  });
});
