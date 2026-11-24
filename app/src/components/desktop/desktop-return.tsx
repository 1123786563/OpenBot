import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { desktopShell } from "@/lib/desktop/shell";
import {
  confirmBrokeredConnectionMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * The link that brings OpenBot Desktop's window forward, on the page it is already showing.
 *
 * `openbot://open` with no page named: the window was left where the sign-in started (a conversation,
 * an app's page), and that is where the person goes back to (`open_from_link` in desktop/src-tauri).
 */
export const DESKTOP_LINK = "openbot://open";

/**
 * Where an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser
 * (`/desktop-return`).
 *
 * The Desktop window opens every site outside OpenBot in the browser, so the vendor's redirect lands
 * there as well (`desktopReturnUrlFor` on the server). This page does what the account's page does on
 * arrival, asking the server to confirm the account so it is recorded, and then hands the person back
 * to the window through `openbot://` when confirmed. The window refreshes its apps on focus.
 *
 * Loaded in the Desktop window itself, it goes to the account's page instead, which confirms on its
 * own.
 */
export function DesktopReturn({
  app,
  openDesktop = (link: string) => window.location.assign(link),
}: {
  /** The app the sign-in was for, by its key. */
  app?: string;
  /** Follows the `openbot://` link. Replaced in tests, which cannot follow one. */
  openDesktop?: (link: string) => void;
}) {
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<
    "connected" | "unconnected" | "inconclusive" | null
  >(null);
  const queryClient = useQueryClient();
  const confirmation = useMutation({
    ...confirmBrokeredConnectionMutationOptions(queryClient),
    onSettled: (data) => {
      setOutcome(
        data?.connected === true
          ? "connected"
          : data?.connected === false
            ? "unconnected"
            : "inconclusive",
      );
      // Refresh Connections in the background. Its app metadata cannot delay this handoff.
      void invalidatePlugins(queryClient);
    },
  });
  const plugins = useQuery({
    ...pluginsPageQueryOptions(),
    enabled: Boolean(app) && !desktopShell(),
  });
  const appName = app
    ? (plugins.data?.servers.find(({ id }) => id === app)?.title ??
      plugins.data?.catalogue.find(({ key }) => key === app)?.title)
    : undefined;
  const connection = appName ? `the ${appName} connection` : "your connection";
  const launchId = useId();
  const confirm = confirmation.mutate;
  const started = useRef(false);
  const launched = useRef(false);
  const unconnected = outcome === "unconnected";
  const canHandBack = !app || outcome === "connected";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (desktopShell()) {
      void navigate(
        app
          ? { to: "/connections/$key", params: { key: app } }
          : { to: "/connections" },
      );
      return;
    }
    if (app) confirm(app);
  }, [app, confirm, navigate]);

  useEffect(() => {
    if (!canHandBack || desktopShell() || launched.current) return;
    launched.current = true;
    try {
      openDesktop(DESKTOP_LINK);
    } catch {
      // Browser protocol restrictions are recoverable via either visible link.
    }
  }, [canHandBack, openDesktop]);

  return (
    <AstryxSurface className="desktop-return min-h-svh">
      <Stack
        as="main"
        align="center"
        justify="center"
        minHeight="100svh"
        style={{ padding: "var(--spacing-6, 1.5rem)" }}
      >
        <Stack
          align="center"
          gap={4}
          maxWidth="26rem"
          width="100%"
          style={{ overflowWrap: "anywhere" }}
        >
          <Heading
            level={1}
            weight="semibold"
            style={{ fontSize: "var(--text-xl, 1.25rem)" }}
          >
            Back to OpenBot
          </Heading>
          {canHandBack ? (
            <>
              {app ? (
                <Text as="p" justify="center" role="status" type="supporting">
                  {appName ? `${appName} is connected.` : "Account connected."}
                </Text>
              ) : null}
              <Text as="p" justify="center" type="supporting">
                If OpenBot Desktop didn’t open, try the button below. If OpenBot
                Desktop isn’t installed, you can continue in your browser.
              </Text>
              <AstryxButton
                as="a"
                href={DESKTOP_LINK}
                id={launchId}
                label="Open OpenBot Desktop"
                size="lg"
                className="conversation-recovery-action"
                variant="primary"
              />
            </>
          ) : outcome === null ? (
            <ReadStatus kind="loading" message={`Checking ${connection}…`} />
          ) : (
            <ReadError
              message={
                unconnected
                  ? `${appName ?? "Your account"} isn’t connected yet.`
                  : `Couldn’t check ${connection}.`
              }
              description={
                unconnected
                  ? `Finish signing in to ${appName ?? "the app"}, then check again.`
                  : "Try again, or view the connection in your browser."
              }
              focusAfterRetry={() => document.getElementById(launchId)}
              retry={() =>
                app ? confirmation.mutateAsync(app).catch(() => {}) : undefined
              }
              retryBelow
              retrying={confirmation.isPending}
            />
          )}
          {app ? (
            <Link
              className="recovery-link"
              params={{ key: app }}
              to="/connections/$key"
            >
              View connection in browser
            </Link>
          ) : (
            <Link className="recovery-link" to="/connections">
              View connections in browser
            </Link>
          )}
        </Stack>
      </Stack>
    </AstryxSurface>
  );
}
