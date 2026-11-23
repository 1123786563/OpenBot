import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { desktopShell } from "@/lib/desktop/shell";
import { confirmBrokeredConnectionMutationOptions } from "@/lib/plugins/mutations";

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
  const confirmation = useMutation(
    confirmBrokeredConnectionMutationOptions(useQueryClient()),
  );
  const confirm = confirmation.mutate;
  const started = useRef(false);
  const launched = useRef(false);
  const [checked, setChecked] = useState(false);
  const connected = confirmation.data?.connected === true;
  const canHandBack = !app || connected;

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
    if (app) confirm(app, { onSettled: () => setChecked(true) });
  }, [app, confirm, navigate]);

  useEffect(() => {
    if (!canHandBack || desktopShell() || launched.current) return;
    launched.current = true;
    openDesktop(DESKTOP_LINK);
  }, [canHandBack, openDesktop]);

  return (
    <AstryxSurface className="min-h-svh">
      <Stack
        as="main"
        align="center"
        justify="center"
        minHeight="100svh"
        style={{ padding: "var(--spacing-6, 1.5rem)" }}
      >
        <Stack align="center" gap={4} maxWidth="26rem" width="100%">
          <Heading
            level={1}
            weight="semibold"
            style={{ fontSize: "var(--text-xl, 1.25rem)" }}
          >
            Back to OpenBot
          </Heading>
          {canHandBack ? (
            <>
              <Text as="p" justify="center" role="status" type="supporting">
                {app ? "Account connected. " : ""}
                If the OpenBot Desktop window is still closed, open it below.
              </Text>
              <AstryxButton
                as="a"
                href={DESKTOP_LINK}
                label="Open OpenBot Desktop"
                size="lg"
                className="conversation-recovery-action"
                variant="primary"
              />
            </>
          ) : !checked ? (
            <ReadStatus kind="loading" message="Checking your connection…" />
          ) : (
            <ReadError
              message="Couldn't confirm your connection."
              description="Check again here, or open Connections in your browser to check the account."
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
