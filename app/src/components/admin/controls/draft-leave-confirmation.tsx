import { type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import { useTranslation } from "@/i18n";
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
  description,
  hasDraft,
  leavesDraft,
  overlayClassName,
  saving,
  submitting,
  title,
}: {
  description?: string;
  hasDraft: boolean | RefObject<boolean>;
  leavesDraft?: (location: Parameters<ShouldBlockFn>[0]) => boolean;
  overlayClassName?: string;
  saving: boolean;
  submitting: RefObject<boolean>;
  title: string;
}) {
  const { t } = useTranslation();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const isWorking = () =>
    submitting.current ||
    (typeof hasDraft === "boolean" ? hasDraft : hasDraft.current);
  const blocker = useBlocker({
    enableBeforeUnload: isWorking,
    shouldBlockFn: (location) =>
      isWorking() &&
      (leavesDraft
        ? leavesDraft(location)
        : location.current.pathname !== location.next.pathname),
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
        overlayClassName={overlayClassName}
        role="alertdialog"
        showCloseButton={false}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <DialogDescription>
            {description ??
              t(
                "frame.draft.leaveDescriptionDefault",
                "Your description and draft changes will be lost.",
              )}
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
            {t("frame.draft.keepEditing", "Keep editing")}
          </Button>
          <Button
            className="min-h-12"
            onClick={() => {
              if (blocker.status === "blocked") blocker.proceed();
            }}
            type="button"
            variant="destructive"
          >
            {t("frame.draft.discard", "Discard changes")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
