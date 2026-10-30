import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  type CompanyReauthPause,
  companyReauthGate,
  companyReauthNeedsGate,
  companyReauthReturnPath,
  dismissCompanyReauth,
  startCompanyReauthRoundTrip,
  useCompanyReauthPause,
} from "../lib/auth/company-assurance";
import { companyReauthChallengeMutationOptions } from "../lib/auth/mutations";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import {
  adoptExplicitSelection,
  selectionStorageKey,
} from "../lib/enterprise/tenant/selection";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
  },
  /*
   * Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
   * a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
   */
  component: AuthedShell,
});

/**
 * The authed shell, T05.15: before any business mounts, one gate pass asks whether the company
 * this session works under still accepts its proof. Only where there is a company question at
 * all — a landing from the company's extra sign-in, or a stored company selection — does the
 * first paint wait for it; a personal scope or a legacy deployment renders immediately, as it
 * always did. A proof refusal replaces the whole tree with the wall below, which is the pause:
 * nothing under this boundary mounts, so no business request leaves the browser.
 */
function AuthedShell() {
  const { queryClient } = Route.useRouteContext();
  const { data: user } = useQuery(currentUserQueryOptions());
  const userId = user?.id;
  const pause = useCompanyReauthPause(userId);
  const [gate, setGate] = useState<"checking" | "open">(() =>
    userId !== undefined && companyReauthNeedsGate(userId)
      ? "checking"
      : "open",
  );

  useEffect(() => {
    if (userId === undefined || gate !== "checking") return;
    let live = true;
    void companyReauthGate(queryClient, userId).finally(() => {
      if (live) setGate("open");
    });
    return () => {
      live = false;
    };
  }, [gate, queryClient, userId]);

  if (pause !== null) {
    return <CompanyReauthWall pause={pause} userId={userId} />;
  }
  if (gate === "checking") return null;
  return (
    <CopilotProvider>
      <AppHotkeys />
      <Outlet />
    </CopilotProvider>
  );
}

/**
 * The company's extra sign-in, offered where the app paused. Not a screen of its own: it
 * interrupts whatever route is under the boundary, so it takes no frame assumptions from the
 * pages it covers — just the sentence, and the two ways forward. The runtime is deliberately
 * not mounted behind it; a paused company runs nothing.
 */
function CompanyReauthWall({
  pause,
  userId,
}: {
  pause: CompanyReauthPause;
  userId: string | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { queryClient } = Route.useRouteContext();
  const location = useRouterState({ select: (state) => state.location });
  const challenge = useMutation(companyReauthChallengeMutationOptions());

  const start = () => {
    if (userId === undefined) return;
    const returnPath = companyReauthReturnPath(
      `${location.pathname}${location.searchStr}`,
    );
    if (returnPath === null) return;
    challenge.mutate(
      { tenantId: pause.tenantId, returnPath },
      {
        onSuccess: (issued) =>
          startCompanyReauthRoundTrip(
            userId,
            { tenantId: pause.tenantId, workspaceId: pause.workspaceId },
            returnPath,
            issued.redirectUrl,
          ),
      },
    );
  };

  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <h1 className="text-base font-medium">
        {t(
          pause.failed
            ? "companyReauth.failedTitle"
            : "companyReauth.pausedTitle",
        )}
      </h1>
      <p className="max-w-prose text-muted-foreground text-sm">
        {t(
          pause.failed
            ? "companyReauth.failedBody"
            : "companyReauth.pausedBody",
        )}
      </p>
      <div className="mt-3 flex gap-2">
        <Button disabled={challenge.isPending} onClick={start}>
          {t("companyReauth.start")}
        </Button>
        <Button
          onClick={() => {
            if (userId !== undefined) {
              dismissCompanyReauth(userId);
              // Leaving the paused company means leaving its selection too: the
              // stored choice would otherwise re-enter the same wall.
              window.localStorage.removeItem(selectionStorageKey(userId));
              adoptExplicitSelection(queryClient, userId, null);
            }
            void navigate({ to: "/tenant/selection" });
          }}
          variant="outline"
        >
          {t("companyReauth.escape")}
        </Button>
      </div>
      {challenge.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {t("companyReauth.startError")}
        </p>
      ) : null}
    </div>
  );
}
