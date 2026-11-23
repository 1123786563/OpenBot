import { useBlocker } from "@tanstack/react-router";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

export function DraftLeaveConfirmation({
  hasDraft,
  saving,
  submitting,
  title,
}: {
  hasDraft: boolean;
  saving: boolean;
  submitting: RefObject<boolean>;
  title: string;
}) {
  const keepEditing = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker({
    enableBeforeUnload: hasDraft,
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname && (submitting.current || hasDraft),
    withResolver: true,
  });
  useLayoutEffect(() => {
    if (blocker.status === "blocked" && submitting.current) blocker.reset();
  }, [blocker, submitting]);
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") blocker.reset();
      }}
      open={blocker.status === "blocked" && !saving}
    >
      <DialogContent
        {...astryxScope}
        initialFocus={keepEditing}
        role="alertdialog"
        showCloseButton={false}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <DialogDescription>
            Your description and draft changes will be lost.
          </DialogDescription>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button
            className="min-h-12"
            onClick={() => {
              if (blocker.status === "blocked") blocker.reset();
            }}
            ref={keepEditing}
            type="button"
            variant="outline"
          >
            Keep editing
          </Button>
          <Button
            className="min-h-12"
            onClick={() => {
              if (blocker.status === "blocked") blocker.proceed();
            }}
            type="button"
            variant="destructive"
          >
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
