import { Button } from "@astryxdesign/core/Button";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";
import { ClientError } from "@/lib/client";

export class ActionUnavailable extends Error {
  constructor(
    message: string,
    readonly recovery?: ReactNode,
  ) {
    super(message);
  }
}

export class ActionIncomplete extends Error {}

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  failureMessage: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: callers may return a failure message or nothing.
  run: () => Promise<void | string>;
  trigger?: HTMLElement | undefined;
  fallbackFocus?: (() => HTMLElement | null) | undefined;
  variant?: "default" | "destructive";
  successMessage?: string;
  refresh?: () => Promise<unknown>;
};

type ConfirmationState =
  | { phase: "ready" | "pending"; action: Confirmation }
  | { phase: "retry"; action: Confirmation; message: string }
  | {
      phase: "unavailable";
      action: Confirmation;
      message: string;
      recovery?: ReactNode;
    };

function wrapConfirmationTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const dialog = event.currentTarget;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex], [contenteditable]",
    ),
  ).filter(
    (control) =>
      control.tabIndex >= 0 &&
      !control.matches(":disabled") &&
      !control.closest("[inert]") &&
      control.checkVisibility({ visibilityProperty: true }),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const atBoundary = event.shiftKey ? first : last;
  if (document.activeElement !== atBoundary) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

export function useActionConfirmation(
  review?: {
    content: ReactNode;
    ready: boolean;
    onClose: () => void;
  },
  options?: { overlayClassName: string },
) {
  const { t } = useTranslation();
  const [state, setState] = useState<ConfirmationState | null>(null);
  const [notice, setNotice] = useState("");
  const remembered = useRef<Confirmation | null>(null);
  const submitting = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const close = () => {
    setState(null);
    review?.onClose();
  };

  function requestConfirmation(action: Confirmation) {
    if (submitting.current) return;
    remembered.current = action;
    setNotice("");
    setState({ phase: "ready", action });
  }

  async function submit(action: Confirmation) {
    if (submitting.current || review?.ready === false) return;
    submitting.current = true;
    setState({ phase: "pending", action });
    try {
      const result = await action.run();
      setNotice(result ?? action.successMessage ?? "Change saved.");
      close();
    } catch (error) {
      const message =
        error instanceof ActionUnavailable
          ? error.message
          : error instanceof ClientError
            ? unavailableMessage(error.status)
            : undefined;
      if (message !== undefined) {
        await action.refresh?.().catch(() => undefined);
        setState({
          phase: "unavailable",
          action,
          message,
          recovery:
            error instanceof ActionUnavailable ? error.recovery : undefined,
        });
        cancelButton.current?.focus();
      } else {
        setState({
          phase: "retry",
          action,
          message:
            error instanceof ActionIncomplete
              ? error.message
              : action.failureMessage,
        });
      }
    } finally {
      submitting.current = false;
    }
  }

  const pending = state?.phase === "pending";
  const unavailable = state?.phase === "unavailable";
  const action = state?.action ?? remembered.current;

  return {
    requestConfirmation,
    confirmation: (
      <>
        {/* Only once there is something to say: an ever-present empty status line answers
            screen-reader and test queries for "the status" before the real notice exists. */}
        {notice ? (
          <p ref={status} role="status" tabIndex={-1}>
            {notice}
          </p>
        ) : null}
        <Dialog
          disablePointerDismissal
          open={state !== null}
          onOpenChange={(open, event) => {
            if (open) return;
            if (submitting.current) {
              event.cancel();
              return;
            }
            close();
          }}
        >
          <DialogContent
            {...astryxScope}
            className="break-words"
            finalFocus={() => {
              const opener = remembered.current?.trigger;
              if (
                opener?.isConnected &&
                !opener.matches(":disabled, [aria-disabled=true]")
              ) {
                return opener;
              }
              return (
                remembered.current?.fallbackFocus?.() ?? status.current ?? true
              );
            }}
            initialFocus={cancelButton}
            onKeyDown={wrapConfirmationTab}
            overlayClassName={options?.overlayClassName}
            role="alertdialog"
            showCloseButton={false}
          >
            <DialogTitle>{action?.title}</DialogTitle>
            <DialogBody>
              <DialogDescription>{action?.description}</DialogDescription>
              {state && !unavailable ? review?.content : null}
              {state && "message" in state && (
                <p className="text-destructive" role="alert">
                  {state.message}
                </p>
              )}
              {state?.phase === "unavailable" ? state.recovery : null}
            </DialogBody>
            <DialogFooter className="flex-wrap">
              <Button
                ref={cancelButton}
                className="confirmation-action"
                isDisabled={pending}
                label={
                  unavailable
                    ? t("confirmation.close", "Close")
                    : t("confirmation.cancel", "Cancel")
                }
                onClick={close}
                variant="secondary"
              />
              {action && !unavailable && (
                <Button
                  className="confirmation-action"
                  isDisabled={review?.ready === false}
                  isLoading={pending}
                  label={
                    pending
                      ? action.pendingLabel
                      : state?.phase === "retry"
                        ? t("confirmation.retry", "Try again")
                        : action.confirmLabel
                  }
                  onClick={() => void submit(action)}
                  variant={
                    action.variant === "default" ? "primary" : "destructive"
                  }
                />
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    ),
  };
}

/**
 * What a dialog says when the status itself is the whole answer: the session ended, the permission
 * went, or the row it was opened for changed underneath it. Exported for the other surfaces that
 * meet the same three statuses; a banner's own sentence is `failureMessage` in `lib/client.ts`.
 */
export function unavailableMessage(status: number): string | undefined {
  if (status === 401)
    return "Your session has ended. Sign in again to continue.";
  if (status === 403)
    return "You no longer have permission to make this change.";
  if (status === 404 || status === 409) {
    return "The current state no longer matches this confirmation. Close this dialog and review the list.";
  }
}
