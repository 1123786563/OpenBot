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
  message,
  description,
  retry,
  retrying,
  retryLabel,
  retryBelow = false,
}: {
  message: string;
  description?: string;
  retry: () => unknown;
  retrying?: boolean;
  retryLabel?: string;
  retryBelow?: boolean;
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

  const action = (
    <Button
      clickAction={async (event) => {
        const button = event.currentTarget;
        if (
          button instanceof HTMLElement &&
          document.activeElement === button
        ) {
          const regions: HTMLElement[] = [];
          const selector = "section, [role=tabpanel], main, [role=main]";
          let region = button.closest<HTMLElement>(selector);
          while (region) {
            regions.push(region);
            region =
              region.parentElement?.closest<HTMLElement>(selector) ?? null;
          }
          const address = window.location.href;
          restoreFocus.current = () => {
            const movedOn = () =>
              button.isConnected ||
              document.activeElement !== document.body ||
              window.location.href !== address;
            const focusRecoveredContent = () => {
              if (movedOn()) return true;
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
            if (focusRecoveredContent()) return;
            const scope = regions.find((region) => region.isConnected);
            if (!scope) return;

            // The retry can disappear before a suspended conversation commits.
            const observer = new MutationObserver(() => {
              if (focusRecoveredContent() || !scope.isConnected) stop();
            });
            const timeout = window.setTimeout(() => stop(), 5_000);
            function stop() {
              observer.disconnect();
              window.clearTimeout(timeout);
              document.removeEventListener("focusin", stop);
            }
            document.addEventListener("focusin", stop, { once: true });
            observer.observe(scope, { childList: true, subtree: true });
          };
        }
        await retry();
      }}
      isLoading={retrying}
      label={retryLabel ?? t("frame.retry", "Retry")}
      className={retryBelow ? "conversation-recovery-action" : undefined}
      size={retryBelow ? "lg" : "sm"}
      variant="secondary"
    />
  );
  return (
    <Banner
      description={description}
      endContent={retryBelow ? undefined : action}
      collapsible={false}
      role="alert"
      status="error"
      title={message}
    >
      {retryBelow ? action : undefined}
    </Banner>
  );
}
