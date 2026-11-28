import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  type AnyRouter,
  type ErrorComponentProps,
  Link,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import {
  type ComponentProps,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "@/i18n";

function WorkspaceLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} replace to="/" />;
}

const actionSize = {
  minHeight: "var(--spacing-11)",
  paddingInline: "var(--spacing-3)",
  borderRadius: "var(--radius-lg)",
};

const primaryAction = {
  ...actionSize,
  backgroundColor: "var(--primary)",
  color: "var(--primary-foreground)",
};

function focusHeading(heading: HTMLElement | null | undefined) {
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus();
}

function currentPageHeading() {
  return (
    document.querySelector<HTMLHeadingElement>("main h1, [role='main'] h1") ??
    document.querySelector("h1")
  );
}

function focusCurrentPage() {
  focusHeading(currentPageHeading());
}

const routeReloadState = "openbotRouteReload";

function routeReloadFocus(): boolean | undefined {
  const focus: unknown = window.history.state?.[routeReloadState];
  return typeof focus === "boolean" ? focus : undefined;
}

export function restoreRouteReloadFocus(router: AnyRouter) {
  if (typeof window === "undefined") return;
  router.subscribe("onRendered", () => {
    const requested = routeReloadFocus();
    if (requested === undefined) return;
    const heading = currentPageHeading();
    if (!heading || heading.closest("[data-route-recovery]")) return;
    const { [routeReloadState]: _removed, ...state } = window.history.state;
    window.history.replaceState(state, "");
    if (requested && document.activeElement === document.body)
      focusHeading(heading);
  });
}

function isRouteModuleLoadError(error: unknown) {
  return (
    error instanceof Error &&
    /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/.test(
      error.message,
    )
  );
}

type Recovery =
  | {
      kind: "missing";
      standalone?: boolean;
      pathname: string;
    }
  | {
      kind: "error";
      retry: (restoreFocus: boolean) => Promise<boolean>;
      offline: boolean;
      repeated: boolean;
      supportCode: "WEB-ROUTE-ASSET" | "WEB-ROUTE-ERROR";
    };

function RouteRecovery(recovery: Recovery) {
  const router = useRouter();
  const { t } = useTranslation();
  const surface = useRef<HTMLElement>(null);
  const restoringNavigationFocus = useRef(false);
  useEffect(() => {
    focusHeading(surface.current?.querySelector("h1"));
  }, []);

  const title =
    recovery.kind === "error"
      ? t("frame.pageLoadFailed", "This page couldn’t load")
      : t("frame.pageNotFound", "Page not found");
  const canGoBack = router.history.canGoBack();
  const primary =
    recovery.kind === "error" && !recovery.offline
      ? "retry"
      : canGoBack
        ? "back"
        : "workspace";
  const failureStatus =
    recovery.kind === "error" &&
    (recovery.offline
      ? t("frame.offlineStatus", "You’re offline. Reconnect to try again.")
      : recovery.repeated
        ? t(
            "frame.repeatedFailureStatus",
            "The page still couldn’t load. You can try again or open your workspace.",
          )
        : undefined);

  function restoreFocusAfterNavigation() {
    if (restoringNavigationFocus.current) return false;
    restoringNavigationFocus.current = true;
    const current = router.history.location;
    const stop = router.subscribe("onRendered", ({ toLocation }) => {
      if (
        toLocation.state.__TSR_key === current.state.__TSR_key &&
        toLocation.href === current.href
      )
        return;
      window.clearTimeout(timeout);
      stop();
      restoringNavigationFocus.current = false;
      if (document.activeElement === document.body) focusCurrentPage();
    });
    const timeout = window.setTimeout(() => {
      stop();
      restoringNavigationFocus.current = false;
    }, 5000);
    return true;
  }

  function goBack() {
    if (router.history.canGoBack() && restoreFocusAfterNavigation()) {
      router.history.back();
    }
  }

  const retry =
    recovery.kind === "error" ? (
      <Button
        clickAction={async (event) => {
          const button = event.currentTarget;
          const address = window.location.href;
          const wasFocused = button === document.activeElement;
          const recovered = await recovery.retry(wasFocused);
          if (!recovered || !wasFocused) return;
          requestAnimationFrame(() => {
            if (
              button.isConnected ||
              document.activeElement !== document.body ||
              window.location.href !== address
            ) {
              return;
            }
            focusCurrentPage();
          });
        }}
        label={t("frame.tryAgain", "Try again")}
        isDisabled={recovery.offline}
        size="lg"
        style={primary === "retry" ? primaryAction : actionSize}
        variant={primary === "retry" ? "primary" : "secondary"}
      />
    ) : null;

  return (
    <VStack
      aria-label={title}
      as={
        recovery.kind === "missing" && recovery.standalone ? "main" : "section"
      }
      data-route-recovery={recovery.kind}
      minHeight="min(100svh, 28rem)"
      ref={surface}
      style={{ paddingInline: "var(--spacing-4)" }}
      vAlign="center"
    >
      <EmptyState
        actions={
          <VStack align="center" gap={3} style={{ minInlineSize: 0 }}>
            {failureStatus ? (
              <Text as="p" color="secondary" justify="center" role="status">
                {failureStatus}
              </Text>
            ) : null}
            {recovery.kind === "error" && recovery.repeated ? (
              <Text as="p" color="secondary" size="sm" justify="center">
                {t(
                  "frame.routeSupportCode",
                  "If you contact support, include code {code}.",
                  { code: recovery.supportCode },
                )}
              </Text>
            ) : null}
            {recovery.kind === "missing" ? (
              <Text
                as="p"
                color="secondary"
                size="sm"
                style={{
                  overflowWrap: "anywhere",
                  maxInlineSize: "100%",
                  textAlign: "center",
                }}
              >
                {recovery.pathname}
              </Text>
            ) : null}
            <Stack direction="horizontal" justify="center" gap={2} wrap="wrap">
              {primary === "retry" ? retry : null}
              {canGoBack ? (
                <Button
                  label={t("frame.goBack", "Go back")}
                  onClick={goBack}
                  size="lg"
                  style={primary === "back" ? primaryAction : actionSize}
                  variant={primary === "back" ? "primary" : "secondary"}
                />
              ) : null}
              <Button
                as={WorkspaceLink}
                href="/"
                label={t("frame.openWorkspace", "Open workspace")}
                size="lg"
                onClick={(event) => {
                  if (
                    event.currentTarget === document.activeElement &&
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    restoreFocusAfterNavigation();
                  }
                }}
                style={primary === "workspace" ? primaryAction : actionSize}
                variant={primary === "workspace" ? "primary" : "secondary"}
              />
              {primary !== "retry" ? retry : null}
            </Stack>
          </VStack>
        }
        description={
          recovery.kind === "error"
            ? failureStatus
              ? undefined
              : t(
                  "frame.pageLoadFailedDescription",
                  "Try again. If the page still won’t open, check your connection or open your workspace to keep working.",
                )
            : canGoBack
              ? t(
                  "frame.pageNotFoundBackDescription",
                  "Check the address below, or return to the previous page.",
                )
              : t(
                  "frame.pageNotFoundDescription",
                  "Check the address below, or open your workspace to find your conversations and Bots.",
                )
        }
        headingLevel={1}
        title={title}
      />
    </VStack>
  );
}

export function MissingPage({ standalone }: { standalone?: boolean }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <RouteRecovery kind="missing" standalone={standalone} pathname={pathname} />
  );
}

// A failed load can replace its error component during invalidation.
const recoveryAttempts = new WeakMap<
  AnyRouter,
  { entry: string; pending: boolean }
>();

function subscribeToConnection(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function RouteLoadError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const entry =
    router.history.location.state.__TSR_key ?? router.history.location.href;
  const [failedEntry, setFailedEntry] = useState(() =>
    recoveryAttempts.get(router)?.entry === entry ||
    (typeof window !== "undefined" && routeReloadFocus() !== undefined)
      ? entry
      : undefined,
  );
  const online = useSyncExternalStore(
    subscribeToConnection,
    () => navigator.onLine,
    () => true,
  );

  return (
    <RouteRecovery
      kind="error"
      offline={!online}
      repeated={failedEntry === entry}
      supportCode={
        isRouteModuleLoadError(error) ? "WEB-ROUTE-ASSET" : "WEB-ROUTE-ERROR"
      }
      retry={async (restoreFocus) => {
        const previous = recoveryAttempts.get(router);
        if (
          !navigator.onLine ||
          (previous?.entry === entry && previous.pending)
        )
          return false;
        const attempt = { entry, pending: true };
        recoveryAttempts.set(router, attempt);
        if (isRouteModuleLoadError(error)) {
          // A failed module fetch is cached for this document. Reload the same
          // history entry so the browser can request the route again.
          window.history.replaceState(
            { ...window.history.state, [routeReloadState]: restoreFocus },
            "",
          );
          window.location.reload();
          return false;
        }
        try {
          await router.invalidate({ sync: true });
          const current = router.history.location;
          if ((current.state.__TSR_key ?? current.href) !== entry) return false;
          if (!router.state.matches.some((match) => match.status === "error")) {
            if (recoveryAttempts.get(router) === attempt)
              recoveryAttempts.delete(router);
            reset();
            return true;
          }
        } catch {
          // The route may still be unavailable after the retry.
        } finally {
          attempt.pending = false;
        }
        setFailedEntry(entry);
        return false;
      }}
    />
  );
}
