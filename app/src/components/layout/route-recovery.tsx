import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { VStack } from "@astryxdesign/core/VStack";
import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { type ComponentProps, useEffect, useRef } from "react";
import { useTranslation } from "@/i18n";

function WorkspaceLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} replace to="/" />;
}

type Recovery =
  | { kind: "missing"; standalone?: boolean }
  | { kind: "error"; retry: () => Promise<void> };

function RouteRecovery(recovery: Recovery) {
  const { t } = useTranslation();
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    surface.current?.focus();
  }, []);

  const title =
    recovery.kind === "error"
      ? t("frame.pageLoadFailed", "This page couldn’t load")
      : t("frame.pageNotFound", "Page not found");

  return (
    <VStack
      aria-label={title}
      as={
        recovery.kind === "missing" && recovery.standalone ? "main" : "section"
      }
      minHeight="min(100svh, 28rem)"
      padding={4}
      ref={surface}
      tabIndex={-1}
      vAlign="center"
    >
      <EmptyState
        actions={
          <>
            {recovery.kind === "error" && (
              <Button
                clickAction={recovery.retry}
                label={t("frame.tryAgain", "Try again")}
                size="lg"
                variant="primary"
              />
            )}
            <Button
              as={WorkspaceLink}
              href="/"
              label={t("frame.openWorkspace", "Open workspace")}
              size="lg"
              variant={recovery.kind === "error" ? "secondary" : "primary"}
            />
          </>
        }
        description={
          recovery.kind === "error"
            ? t(
                "frame.pageLoadFailedDescription",
                "Try loading this page again, or return to your workspace to keep working.",
              )
            : t(
                "frame.pageNotFoundDescription",
                "Check the address or open your workspace to find your conversations and Bots.",
              )
        }
        headingLevel={1}
        title={title}
      />
    </VStack>
  );
}

export function MissingPage({ standalone }: { standalone?: boolean }) {
  return <RouteRecovery kind="missing" standalone={standalone} />;
}

export function RouteLoadError({ reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <RouteRecovery
      kind="error"
      retry={async () => {
        await router.invalidate({ sync: true });
        reset();
      }}
    />
  );
}
