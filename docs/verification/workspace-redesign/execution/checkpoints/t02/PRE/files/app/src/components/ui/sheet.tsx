import { Description, Drawer } from "@heroui/react";
import { IconX } from "@tabler/icons-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * CSS this wrapper needs. The orchestrator adds it to app/src/styles.css, next to the H02/H03
 * component imports — this file must not import CSS itself:
 *
 *   @import "@heroui/styles/components/drawer.css" layer(components);
 *
 * `close-button.css`, `surface.css` and `description.css` are already imported by H03.
 *
 * HeroUI's Drawer is React Aria's Dialog under a side placement, so focus trapping, focus return,
 * Escape, outside-press dismissal and body-scroll release all come from the same overlay stack as
 * `dialog.tsx`. The compound parts are mapped once, here, so call sites keep the flat API they had:
 * `Sheet` + `SheetContent` still draw the backdrop, the panel and the close button themselves.
 */

/** The page scrim: 15% black over the page, 60% in dark — unchanged from the Base UI sheet. */
const SCRIM =
  "bg-black/15 dark:bg-black/60 supports-backdrop-filter:backdrop-blur-xs";

type Side = "top" | "right" | "bottom" | "left";

/**
 * Geometry per placement. `max-w-none` is load-bearing: `.drawer__dialog` ships
 * `max-w-[85vw]`, which would clip the 18rem mobile sidebar on a 320px viewport.
 */
const SIDE_CLASSES: Record<Side, string> = {
  top: "h-auto max-h-none w-full rounded-none border-b",
  bottom: "h-auto max-h-none w-full rounded-none border-t",
  left: "h-full w-3/4 max-w-none rounded-none border-r sm:max-w-sm",
  right: "h-full w-3/4 max-w-none rounded-none border-l sm:max-w-sm",
};

type SheetProps = Omit<React.ComponentProps<typeof Drawer>, "isOpen"> & {
  /** The app's name for React Aria's `isOpen`, kept so call sites did not change. */
  open?: boolean;
  isOpen?: boolean;
  /**
   * Base UI's non-modal flag. HeroUI's Drawer is modal by construction (React Aria's ModalOverlay
   * always traps focus and locks scroll), and the app never opened a non-modal sheet. Accepted and
   * ignored so the public shape survives; a second, hand-rolled overlay for it would be a new
   * component rather than this migration.
   *
   * @deprecated No effect. Drawer sheets are always modal.
   */
  modal?: boolean;
};

function Sheet({
  open,
  isOpen,
  onOpenChange,
  modal: _modal,
  ...props
}: SheetProps) {
  return (
    <Drawer
      data-slot="sheet"
      isOpen={isOpen ?? open}
      onOpenChange={onOpenChange}
      {...props}
    />
  );
}

/**
 * React Aria's trigger button. It must stay inside `Sheet`, which is what publishes the press
 * handler that opens the drawer.
 */
function SheetTrigger({
  ...props
}: React.ComponentProps<typeof Drawer.Trigger>) {
  return <Drawer.Trigger data-slot="sheet-trigger" {...props} />;
}

/**
 * A close control for content other than the panel's corner button. `slot="close"` is React Aria's
 * contract: a button carrying it inside a dialog closes the dialog on press.
 */
function SheetClose({ ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="sheet-close" slot="close" {...props} />;
}

type SheetContentProps = Omit<
  React.ComponentProps<typeof Drawer.Dialog>,
  "className" | "children"
> & {
  className?: string;
  children?: React.ReactNode;
  side?: Side;
  showCloseButton?: boolean;
};

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  style,
  ...props
}: SheetContentProps) {
  return (
    <Drawer.Backdrop
      className={SCRIM}
      data-slot="sheet-overlay"
      isDismissable
      variant="transparent"
    >
      {/* `placement` is React Aria's Modal, the full-viewport flex box the panel is placed in. */}
      <Drawer.Content placement={side}>
        <Drawer.Dialog
          data-side={side}
          data-slot="sheet-content"
          className={cn(
            "flex flex-col gap-4 bg-popover p-0 text-sm text-popover-foreground shadow-lg",
            SIDE_CLASSES[side],
            className,
          )}
          /*
           * HeroUI's drawer binds drag-to-dismiss to the whole panel and sets `touch-action: none`
           * on it. The Base UI sheet had no drag, and the sidebar's roster scrolls inside this
           * panel on touch — both would be lost. The explicit undefined handlers override the
           * spread `dragHandlers` (Drawer.Dialog applies its own first), and the style restores
           * panning; outside-press and Escape still close through `isDismissable` on the backdrop.
           */
          onPointerDown={undefined}
          onPointerMove={undefined}
          onPointerUp={undefined}
          style={{ touchAction: "auto", ...style }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <Button
              className="absolute top-3 right-3"
              data-slot="sheet-close"
              size="icon-sm"
              slot="close"
              variant="ghost"
            >
              <IconX />
              <span className="sr-only">Close</span>
            </Button>
          )}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Drawer.Header
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Drawer.Footer
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

/** `Drawer.Heading` is React Aria's `Heading slot="title"` — what labels the dialog. */
function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof Drawer.Heading>) {
  return (
    <Drawer.Heading
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof Description>) {
  return (
    <Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
