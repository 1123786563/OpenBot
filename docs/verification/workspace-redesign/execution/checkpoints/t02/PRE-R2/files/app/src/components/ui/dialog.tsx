import { Description, Modal, Pressable } from "@heroui/react";
import { IconX } from "@tabler/icons-react";
import {
  createContext,
  useRef,
  type ComponentProps,
  type ComponentPropsWithRef,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * CSS this wrapper needs. The orchestrator adds these to app/src/styles.css, next to the H02
 * component imports — this file must not import CSS itself:
 *
 *   @import "@heroui/styles/components/modal.css";
 *   @import "@heroui/styles/components/close-button.css";
 *
 * NOTE FOR WHOEVER EDITS styles.css: those imports land UNLAYERED (H02's button/input imports do
 * too), and an unlayered rule outranks every `@layer utilities` class regardless of specificity.
 * HeroUI's own `max-height`, `padding`, `border-radius` and backdrop `background-color` therefore
 * beat the app's utilities. This wrapper states the one non-negotiable value (`max-h-[85svh]`) with
 * a `!` modifier so it holds either way; the rest of the class aliases are visual intent that only
 * takes effect once the component CSS is imported into `layer(components)`. Importing
 * `@import ".../modal.css" layer(components);` fixes the whole H02/H03 surface in one line.
 */

/**
 * A centred modal, for a form that is short enough to finish in one sitting.
 *
 * WHY THIS EXISTS ALONGSIDE `DetailPanel`. The panel is the right answer on the screens somebody
 * lives in — writing a skill, editing an agent — where the list stays visible beside what you are
 * editing and the work is worth a URL. Admin is not that: a credential is added once and forgotten,
 * and giving it a route and a side panel dresses a two-field form as a place you might come back to.
 *
 * Built on HeroUI's Modal (React Aria's Dialog under it), so focus trapping, scroll locking, the
 * escape key and returning focus to the trigger behave identically across the app.
 *
 * The app's public shape is unchanged: controlled `open`/`onOpenChange` on the root, and a
 * `DialogContent` that renders the backdrop, the surface and the close button itself. HeroUI's
 * compound parts are mapped once, here, so no call site has to know about `Backdrop`/`Container`.
 */

/**
 * The page scrim uses the theme backdrop token. `transparent` is the HeroUI variant because
 * every visual comes from these classes; the variant modifier sets `background-color: transparent`
 * in unlayered CSS, hence the `!` on the fills.
 */
const SCRIM = "bg-[var(--ob-backdrop)]!";

type DialogRootProps = Omit<ComponentProps<typeof Modal>, "isOpen"> & {
  /** The app's name for React Aria's `isOpen`, kept so call sites did not change. */
  open?: boolean;
  isOpen?: boolean;
};

/**
 * Marker for the task burst a popup-originated Escape belongs to. Set by the capture listener in
 * `Dialog`; read by the wrapped onOpenChange.
 */
let popupEscapeBurst: object | null = null;

/**
 * Open controlled dialogs, outermost first. A dying-popup Escape is consumed by whichever entry
 * is last (the innermost open dialog), so nested dialogs never close the wrong layer.
 */
const openDialogs: Array<{ close: () => void }> = [];

function Dialog({ open, isOpen, ...props }: DialogRootProps) {
  const shown = isOpen ?? open;
  const onOpenChangeRef = useRef<((next: boolean) => void) | null>(null);
  onOpenChangeRef.current = props.onOpenChange ?? null;

  /*
   * ESC belongs to the topmost overlay only. React Aria's Modal closes on the same Escape that a
   * portalled Select popover just consumed, so dismissing the listbox also tore down the whole
   * dialog (reproduced in the H01 browser spike: `afterSelectEsc = {dialogs: 0, focusOn: BODY}`).
   * The capture listener below handles the two ways an Escape interacts with a popup inside the
   * dialog; React delegates at the app root below document listeners, so neither case can be
   * fixed from the wrapped onOpenChange alone:
   * - Live popup (a listbox/menu/grid/tree trigger still aria-expanded): mark the burst, and the
   *   wrapped onOpenChange drops close requests inside that same task — the popover closes
   *   itself and refocuses the trigger. Task-scoped, not time-scoped: the next Escape closes the
   *   dialog however soon.
   * - Dying popup (no expanded trigger left, focus still stuck on an option/menuitem during the
   *   exit animation): the exiting popover swallows this Escape and it never reaches the dialog.
   *   The innermost open dialog consumes it at the document and closes itself. stopImmediatePropagation
   *   at document capture also keeps the event away from React's root delegation, so RAC cannot
   *   close the dialog a second time in the same frame. Only controlled dialogs (onOpenChange
   *   given) take this path; uncontrolled ones keep RAC's own handling.
   */
  const wrappedOnOpenChange = useMemo(() => {
    if (!props.onOpenChange) return undefined;
    const original = props.onOpenChange;
    return (next: boolean) => {
      if (!next && popupEscapeBurst !== null) return;
      original(next);
    };
  }, [props.onOpenChange]);

  /*
   * Stack entry for this dialog instance; `close` reads the ref so it always closes with the
   * latest `onOpenChange`. Registered while open so the innermost dialog wins a dying-popup
   * Escape even though the outer dialog's document listener runs first.
   */
  const entryRef = useRef<{ close: () => void } | null>(null);
  if (!entryRef.current) {
    entryRef.current = {
      close: () => onOpenChangeRef.current?.(false),
    };
  }
  useEffect(() => {
    const entry = entryRef.current;
    if (!shown || !entry || !props.onOpenChange) return;
    openDialogs.push(entry);
    return () => {
      const index = openDialogs.indexOf(entry);
      if (index !== -1) openDialogs.splice(index, 1);
    };
  }, [shown, props.onOpenChange]);

  /*
   * HeroUI only restores trigger focus when the open came from its own DialogTrigger pairing.
   * The app's trigger is a controlled render prop, so the modal does not know it; remember the
   * focused element at open and hand focus back on close (the pre-migration Base UI behavior).
   */
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (shown) {
      restoreRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      return;
    }
    const restore = restoreRef.current;
    restoreRef.current = null;
    if (!restore) return;
    // HeroUI tears its overlay down on an exit animation AFTER `isOpen` flips, and its own
    // cleanup blurs whatever we restored mid-animation. Restore on the far side of the frame
    // boundary, and only if nothing else has taken focus meanwhile.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!document.contains(restore)) return;
        const current = document.activeElement;
        if (
          current === document.body ||
          (current instanceof Element && current.closest('[data-slot="dialog-overlay"]'))
        ) {
          restore.focus();
        }
      }),
    );
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const stamp = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A live popup is one whose trigger still claims aria-expanded="true" (RAC flips it
      // synchronously on close even while the exiting popover lingers in the DOM). grid/tree
      // popups are included so a future ComboBox/branching picker gets the same layering.
      const expanded = document.querySelector(
        [
          '[aria-haspopup="listbox"][aria-expanded="true"]',
          '[aria-haspopup="menu"][aria-expanded="true"]',
          '[aria-haspopup="grid"][aria-expanded="true"]',
          '[aria-haspopup="tree"][aria-expanded="true"]',
        ].join(", "),
      );
      if (expanded) {
        const ae = document.activeElement;
        const inPopup =
          ae instanceof Element &&
          !!ae.closest(
            '[role="listbox"], [role="menu"], [role="grid"], [role="tree"], [data-slot*="select"], [data-slot*="combobox"]',
          );
        if (inPopup) {
          const burst = {};
          popupEscapeBurst = burst;
          setTimeout(() => {
            if (popupEscapeBurst === burst) popupEscapeBurst = null;
          }, 0);
        } else {
          popupEscapeBurst = null;
        }
        return;
      }
      // No popup is expanded: focus on an option/menuitem means it is stranded inside an exiting
      // popover. Only the innermost open dialog answers, so nested dialogs close in order.
      const ae = document.activeElement;
      if (ae instanceof Element && ae.closest('[role="option"], [role="menuitem"]')) {
        const entry = entryRef.current;
        if (
          entry &&
          props.onOpenChange &&
          openDialogs[openDialogs.length - 1] === entry
        ) {
          event.stopImmediatePropagation();
          entry.close();
        }
        return;
      }
      popupEscapeBurst = null;
    };
    document.addEventListener("keydown", stamp, true);
    return () => document.removeEventListener("keydown", stamp, true);
  }, [shown]);

  return (
    <Modal
      data-slot="dialog"
      isOpen={shown}
      {...props}
      onOpenChange={wrappedOnOpenChange}
    />
  );
}
type DialogTriggerProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "children"
> & {
  className?: string;
  children?: ReactNode;
  /**
   * Draws the trigger as something other than the default `<button>`. React Aria's `render` takes a
   * function; this wrapper used to accept a rendered element, and the one call site moved to the
   * function form rather than growing an element-cloning adapter here.
   */
  render?: (props: ComponentPropsWithRef<"button">) => ReactElement;
};

/**
 * The trigger is a real `<button>` (or whatever `render` draws) wrapped in React Aria's `Pressable`,
 * which is what consumes the press responder the dialog root publishes — that is how pressing it
 * opens the dialog without the trigger knowing anything about dialog state.
 */
function DialogTrigger({
  className,
  children,
  render,
  ...props
}: DialogTriggerProps) {
  const buttonProps: ComponentPropsWithRef<"button"> = {
    type: "button",
    /* Base UI advertised this on the trigger; it is part of the app's observable contract. */
    "aria-haspopup": "dialog",
    ...props,
    className,
    children,
  };
  return (
    <Pressable>
      {render ? render(buttonProps) : <button {...buttonProps} />}
    </Pressable>
  );
}

/**
 * The close control. `slot="close"` is React Aria's contract: a button inside a dialog that carries
 * the slot closes it on press, by mouse or keyboard.
 */
function DialogClose({ ...props }: ButtonProps) {
  return <Button {...props} data-slot="dialog-close" slot="close" />;
}

/**
 * Kept for API compatibility. React Aria portals every overlay itself (the backdrop renders through
 * `Overlay`'s portal), so there is nothing left for a portal component to do.
 */
function DialogPortal({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof Modal.Backdrop>) {
  return (
    <Modal.Backdrop
      data-slot="dialog-overlay"
      /*
       * The caller's scrim REPLACES the default rather than stacking with it: two `background-color`
       * utilities in the same layer resolve by stylesheet order, not by class order, so mixing them
       * is how a nested dialog ends up looking exactly like the one underneath it.
       */
      className={className ?? SCRIM}
      variant="transparent"
      {...props}
    />
  );
}

/**
 * React Aria's `useDialog` only publishes `contentProps.id` for `role="alertdialog"` — for a plain
 * dialog the description slot gets no id and the surface gets no `aria-describedby`. The app's
 * dialogs rely on that association (it read as a description before the migration), so
 * `DialogContent` owns the id and `DialogDescription` registers that it exists: a dangling
 * `aria-describedby` on a dialog with no description is its own accessibility defect.
 */
type DialogDescriptionSlot = {
  id: string;
  setPresent: Dispatch<SetStateAction<boolean>>;
};

const DialogDescriptionContext = createContext<DialogDescriptionSlot | null>(
  null,
);

type DialogContentProps = Omit<
  ComponentProps<typeof Modal.Dialog>,
  "className" | "children"
> & {
  className?: string;
  children?: ReactNode;
  /**
   * Restyles the backdrop behind this dialog. A dialog stacked over another passes a heavier one
   * here, so the dialog underneath reads as background rather than a competing surface.
   *
   * HeroUI does not skip backdrops on nested modals the way Base UI did: every `Modal.Backdrop`
   * goes through React Aria's `Overlay`, which always portals and always renders, so a stacked
   * dialog gets its own backdrop for free and this prop only re-colours it.
   */
  overlayClassName?: string;
  /** Classes for the positioning wrapper (`Modal.Container`), not the surface. */
  containerClassName?: string;
  showCloseButton?: boolean;
  /**
   * HeroUI's surface size. `lg` is the app's historical `max-w-lg`; `full` makes the dialog itself
   * the viewport, which is what the attachment lightbox needs.
   */
  size?: ComponentProps<typeof Modal.Container>["size"];
};

function DialogContent({
  className,
  overlayClassName,
  containerClassName,
  children,
  showCloseButton = true,
  size = "lg",
  ...props
}: DialogContentProps) {
  /*
   * `max-h-[85svh]` with the body scrolling, not the surface growing: a form that is long on a
   * laptop must not push its own submit button off the bottom of the screen, which is exactly
   * where somebody looks for it. HeroUI's "scroll inside" preset sets `max-height: 100%` on the
   * same element, so this one is stated with `!`. `full` is the exception — that surface is the
   * viewport by definition, and its own `h-full` is the cap.
   */
  const capped = size !== "full" && size !== "cover";

  const descriptionId = useId();
  const [hasDescription, setHasDescription] = useState(false);
  const descriptionSlot = useMemo<DialogDescriptionSlot>(
    () => ({ id: descriptionId, setPresent: setHasDescription }),
    [descriptionId],
  );

  return (
    <DialogOverlay
      className={overlayClassName}
      isDismissable
      variant="transparent"
    >
      <Modal.Container
        className={containerClassName}
        placement="center"
        scroll="inside"
        size={size}
      >
        <Modal.Dialog
          aria-describedby={hasDescription ? descriptionId : undefined}
          data-slot="dialog-content"
          className={cn(
            "flex flex-col gap-4 rounded-2xl bg-overlay text-overlay-foreground text-sm",
            capped && "!m-4 !max-h-[calc(100dvh-32px)]! !max-w-[calc(100vw-32px)]! overflow-y-auto",
            capped && size === "lg" && "!w-[min(512px,calc(100vw-32px))]!",
            className,
          )}
          {...props}
        >
          <DialogDescriptionContext value={descriptionSlot}>
            {children}
          </DialogDescriptionContext>
          {showCloseButton && (
            /*
             * HeroUI's close button: a real `<button type="button">`, `aria-label="Close"`, and
             * `slot="close"` so React Aria wires the press. `sr-only` text is added inside as well,
             * because a name that only exists in an attribute is invisible to translation review.
             * The `!` overrides are the unlayered-CSS caveat described at the top of this file.
             */
            <Modal.CloseTrigger className="absolute! top-3! right-3! size-7! bg-transparent!">
              <IconX />
              <span className="sr-only">Close</span>
            </Modal.CloseTrigger>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </DialogOverlay>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 pr-8", className)}
      {...props}
    />
  );
}

/**
 * Body scrolls, so the header and footer stay put on a short viewport.
 *
 * `overflow-y-auto` is the half that was missing. `flex-1 min-h-0` lets this shrink, but without an
 * overflow it shrinks and then paints its content over the footer — which every dialog here was short
 * enough never to show.
 */
function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

/**
 * React Aria's `Heading slot="title"` is what gives the dialog its `aria-labelledby`; HeroUI's
 * `Modal.Heading` is that component with its own type scale, and the app's classes sit on top.
 */
function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof Modal.Heading>) {
  return (
    <Modal.Heading
      data-slot="dialog-title"
      className={cn(
        "font-heading font-medium text-base text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * React Aria's `Text slot="description"`, which is what gives the description its place in the
 * dialog's reading order. HeroUI's `Description` renders nothing outside a dialog, so it must stay
 * inside `DialogContent`; the id comes from the context described above.
 */
function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof Description>) {
  const slot = useContext(DialogDescriptionContext);
  const setPresent = slot?.setPresent;
  const id = slot?.id;

  useEffect(() => {
    if (!setPresent) return;
    setPresent(true);
    return () => setPresent(false);
  }, [setPresent]);

  return (
    <Description
      data-slot="dialog-description"
      id={id}
      className={cn("text-muted-foreground text-sm text-pretty", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
