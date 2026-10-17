import { spyOn } from "bun:test";
import { cloneElement, createContext, useContext } from "react";
import type * as React from "react";
import type { ReactNode } from "react";
import * as Dialog from "@/components/ui/dialog";

/**
 * A RESTORABLE stand-in for the Base UI dialog, installed as namespace spies rather than
 * `mock.module`. The Base UI dialog never mounts under happy-dom — its portal rides browser
 * transition APIs the DOM shim does not implement, so an open dialog renders nothing at all —
 * so any suite exercising a screen through a dialog needs this shell. Bun cannot take a module
 * mock back off (`mock.restore()` leaves it in place), so the old registry-level mocks leaked
 * into every later file in the same process and had to be written for strangers; a namespace spy
 * is restorable, and the `afterAll` each caller registers genuinely puts the real module back.
 *
 * The components are SHAPE-COMPATIBLE with the real one's split behavior, because the suites
 * this serves assert on exactly that:
 *
 * - a DialogTrigger child ALWAYS renders (the real trigger is the closed-state affordance), and
 *   it honors `render` the way the real one does: the rendered element IS the trigger (carrying
 *   its aria-label) with the children inside it, plus the `aria-haspopup="dialog"` the real
 *   trigger answers for;
 * - every other child (the DialogContent tree) renders ONLY while open, wrapped in
 *   role="dialog" (a closed dialog mounting its content is the leak this replaces — the real
 *   popup mounts nothing until open);
 * - DialogContent keeps the close button a real one renders, and it works: the close ask is
 *   threaded through context to the Dialog root's onOpenChange, so a test clicking "Close" by
 *   name sees the dialog gone;
 * - DialogTitle and DialogDescription get their own elements, as the real ones do (h2 and p), so
 *   exact text matchers can hit a sentence sitting in a Description.
 *
 * Content renders inline instead of into a portal — the only part happy-dom cannot do.
 */
const CloseContext = createContext<() => void>(() => {});

const pass = ({ children }: { children?: ReactNode }) => children ?? null;

const DialogTriggerMock = ({
  children,
  render,
}: {
  children?: ReactNode;
  render?: React.ReactElement<Record<string, unknown>>;
}) =>
  render
    ? cloneElement(render, { "aria-haspopup": "dialog" }, children)
    : (children ?? null);
DialogTriggerMock.displayName = "DialogTriggerMock";

const isTrigger = (child: React.ReactNode) =>
  child !== null &&
  typeof child === "object" &&
  "type" in child &&
  (child as { type?: { displayName?: string } }).type?.displayName ===
    "DialogTriggerMock";

const PassDialog = ({
  children,
  open = false,
  onOpenChange,
}: {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const array = (Array.isArray(children) ? children : [children]).filter(
    Boolean,
  );
  const triggers = array.filter(isTrigger);
  const rest = array.filter((child) => !isTrigger(child));
  const close = () => onOpenChange?.(false);
  return open ? (
    <CloseContext.Provider value={close}>
      <div role="dialog">
        {triggers}
        {rest}
      </div>
    </CloseContext.Provider>
  ) : (
    <>
      {triggers}
      {rest.length === 0 ? null : null}
    </>
  );
};

const PassDialogContent = ({ children }: { children?: ReactNode }) => {
  const close = useContext(CloseContext);
  return (
    <div>
      {children}
      <button onClick={close} type="button">
        <span className="sr-only">Close</span>
      </button>
    </div>
  );
};

/**
 * Spies every dialog export the real module has — a missing one is a SyntaxError
 * ("No matching export") for the first importer the real module graph pulls in.
 * Returns the disposer each caller hands to `afterAll`.
 */
export function installDialogPassThrough(): () => void {
  const spies = [
    spyOn(Dialog, "Dialog").mockImplementation(PassDialog as never),
    spyOn(Dialog, "DialogContent").mockImplementation(
      PassDialogContent as never,
    ),
    spyOn(Dialog, "DialogHeader").mockImplementation(pass as never),
    spyOn(Dialog, "DialogBody").mockImplementation(pass as never),
    spyOn(Dialog, "DialogFooter").mockImplementation(pass as never),
    spyOn(Dialog, "DialogTitle").mockImplementation((({
      children,
    }: {
      children?: ReactNode;
    }) => <h2>{children}</h2>) as never),
    spyOn(Dialog, "DialogDescription").mockImplementation((({
      children,
    }: {
      children?: ReactNode;
    }) => <p>{children}</p>) as never),
    spyOn(Dialog, "DialogClose").mockImplementation(pass as never),
    spyOn(Dialog, "DialogOverlay").mockImplementation(pass as never),
    spyOn(Dialog, "DialogPortal").mockImplementation(pass as never),
    spyOn(Dialog, "DialogTrigger").mockImplementation(
      DialogTriggerMock as never,
    ),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}
