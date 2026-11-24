import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const nestedOverlay = "bg-black/20 supports-backdrop-filter:backdrop-blur-sm";

export function SettingsDraftDialog({
  title,
  description,
  open,
  dirty,
  saving,
  opener,
  onClose,
  action,
  overlay,
  guardNavigation,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  dirty: boolean;
  saving: boolean;
  opener: RefObject<HTMLButtonElement | null> | (() => HTMLElement | null);
  onClose: () => void;
  action?: ReactNode;
  overlay?: Pick<ComponentProps<typeof DialogContent>, "className" | "style">;
  guardNavigation?: RefObject<boolean>;
  children: ReactNode;
}) {
  const [discard, setDiscard] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const discarded = useRef(false);
  const restoreFocus =
    typeof opener === "function" ? opener : () => opener.current;

  function requestClose() {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    discarded.current = false;
    setDiscard(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next, event) => {
        if (next) return;
        event.cancel();
        requestClose();
      }}
    >
      <DialogContent
        {...overlay}
        finalFocus={restoreFocus}
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">{children}</DialogBody>
        <DialogFooter className="flex-wrap">
          <Button
            className="min-h-11"
            disabled={saving}
            onClick={requestClose}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {action}
        </DialogFooter>

        {open && guardNavigation ? (
          <DraftLeaveConfirmation
            description="Your changes will be lost when you leave this page."
            hasDraft={dirty}
            overlayClassName={nestedOverlay}
            saving={saving}
            submitting={guardNavigation}
            title="Leave without saving?"
          />
        ) : null}

        <Dialog
          disablePointerDismissal
          open={open && discard}
          onOpenChange={(next) => {
            if (!next) setDiscard(false);
          }}
        >
          <DialogContent
            {...overlay}
            finalFocus={() =>
              discarded.current ? restoreFocus() : previousFocus.current
            }
            initialFocus={keepEditing}
            overlayClassName={nestedOverlay}
            role="alertdialog"
            showCloseButton={false}
          >
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription>
                Your changes will be lost when you close this editor.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-wrap">
              <Button
                className="min-h-11"
                onClick={() => setDiscard(false)}
                ref={keepEditing}
                type="button"
                variant="outline"
              >
                Keep editing
              </Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  discarded.current = true;
                  setDiscard(false);
                  onClose();
                }}
                type="button"
                variant="destructive"
              >
                Discard changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
