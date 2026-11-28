import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "@/i18n";

type ReadStatusProps =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string; retry: () => Promise<unknown> };

export function ReadStatus(status: ReadStatusProps) {
  if (status.kind === "loading") {
    return (
      <Text as="p" color="secondary" role="status" size="sm">
        {status.message}
      </Text>
    );
  }

  return <ReadError message={status.message} retry={status.retry} />;
}

export function ReadError({
  alertRef,
  message,
  description,
  retry,
  retrying,
  retryLabel,
  retryBelow = false,
  focusAfterRetry,
}: {
  alertRef?: ((alert: HTMLDivElement | null) => void) | undefined;
  message: string;
  description?: string;
  retry?: (() => unknown) | undefined;
  retrying?: boolean;
  retryLabel?: string;
  retryBelow?: boolean;
  focusAfterRetry?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const restoreFocus = useRef<(() => void) | null>(null);
  useLayoutEffect(
    () => () => {
      // Refetch removes the retry button when the recovered content commits.
      const restore = restoreFocus.current;
      if (restore) requestAnimationFrame(restore);
    },
    [],
  );

  const action = retry ? (
    <Button
      clickAction={async (event) => {
        const button = event.currentTarget;
        if (
          button instanceof HTMLElement &&
          document.activeElement === button
        ) {
          const regions: HTMLElement[] = [];
          const dialogs = "[role=dialog], [role=alertdialog]";
          const selector = `section, [role=tabpanel], main, [role=main], ${dialogs}`;
          const dialog = button.closest<HTMLElement>(dialogs);
          let region = button.closest<HTMLElement>(selector);
          while (region) {
            regions.push(region);
            region =
              region.parentElement?.closest<HTMLElement>(selector) ?? null;
          }
          const address = window.location.href;
          const restoreRecoveredFocus = () => {
            const movedOn = () =>
              button.isConnected ||
              (document.activeElement !== document.body &&
                document.activeElement !== dialog) ||
              window.location.href !== address;
            const focusRecoveredContent = (allowFallback: boolean) => {
              if (movedOn()) return true;
              const preferred = focusAfterRetry?.();
              if (preferred?.isConnected) {
                preferred.focus();
                if (document.activeElement === preferred) return true;
              }
              if (focusAfterRetry && !allowFallback) return false;
              for (const region of regions) {
                if (!region.isConnected) continue;
                const target =
                  region.getAttribute("role") === "tabpanel"
                    ? region
                    : region.querySelector<HTMLElement>("h1, h2");
                if (!target) continue;
                if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
                target.focus();
                if (document.activeElement === target) return true;
              }
              return false;
            };
            if (focusRecoveredContent(false)) return;
            const scope = regions.findLast((region) => region.isConnected);
            if (!scope) return;

            // The retry can disappear before a suspended conversation commits.
            const observer = new MutationObserver(() => {
              if (focusRecoveredContent(false) || !scope.isConnected) stop();
            });
            const timeout = window.setTimeout(() => {
              stop();
              focusRecoveredContent(true);
            }, 5_000);
            function stop() {
              observer.disconnect();
              window.clearTimeout(timeout);
              document.removeEventListener("focusin", stop);
            }
            document.addEventListener("focusin", stop, { once: true });
            observer.observe(scope, { childList: true, subtree: true });
          };
          // Let the dialog finish its queued focus restoration before choosing a target.
          restoreFocus.current = dialog
            ? () => window.setTimeout(restoreRecoveredFocus, 50)
            : restoreRecoveredFocus;
        }
        await retry();
      }}
      isLoading={retrying}
      label={retryLabel ?? t("frame.retry", "Retry")}
      className={retryBelow ? "conversation-recovery-action" : undefined}
      size={retryBelow ? "lg" : "sm"}
      variant="secondary"
    />
  ) : undefined;
  return (
    <Banner
      description={description}
      endContent={retryBelow ? undefined : action}
      collapsible={false}
      ref={
        alertRef
          ? (frame) => {
              const alert =
                frame?.querySelector<HTMLDivElement>('[role="alert"]') ?? null;
              if (alert) alert.tabIndex = -1;
              alertRef(alert);
            }
          : undefined
      }
      role="alert"
      status="error"
      title={message}
    >
      {retryBelow ? action : undefined}
    </Banner>
  );
}
