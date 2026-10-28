import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import {
  MAIN_CONTENT_ID,
  SkipToContent,
} from "@/components/layout/skip-to-content";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/router-link";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { tenantKeys } from "@/lib/enterprise/tenant/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  findSelection,
  type ListingRead,
  readCurrentSelection,
  type ScopeSelection,
  switchWorkspaceScope,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";
import { companySettingsOpenTo } from "./tenant/selection";

/**
 * The application shell, bound to the one selection coordinator (T03.07, Issue #544).
 *
 * THE ONE FACT THE SHELL TRUSTS is the same pair the selection page maintains: the live current
 * selection plus the server's eligibility listing. Everything the shell mounts or withholds is a
 * state of those two:
 *
 * - With no selection (or before one is seeded), the business chrome renders as it always has.
 *   A listing that answers "no companies" or "no teams anywhere" renders a notice with the next
 *   step instead of leaving the person inside business content that has nothing to read — and
 *   the one thing a teamless admin may still open (company settings, when the listing grants
 *   `company:manage`) is offered right there.
 * - With a selection the listing still names, the chrome renders and every scoped request rides
 *   the verified pair — the old authority included, byte-for-byte.
 * - With a selection the listing no longer names, the business chrome does NOT mount. Nothing
 *   can ride a pair the server would refuse: the shell holds the person at a face that says the
 *   access ended and offers the way out (choose another scope, or sign out). An in-flight
 *   listing holds the same way, because a stored pair is exactly what must not leak while its
 *   verification is unsettled.
 * - A listing that FAILED is not an authorization fact (the house rule): the chrome renders as
 *   always, and every scoped read still fails closed at the server.
 *
 * The shell never writes the selection: the person's explicit act on the selection page is the
 * only writer, and the coordinator stays the only seam that moves it.
 *
 * One more duty lands here because the shell is the only surface that sees every identity: a
 * sign-in by another person (a sign-out followed by a different account, no reload between) ends
 * the previous account's epoch through the coordinator's leave-scope arm and removes everything
 * its cache held, so nothing survives a handover for anybody else to read.
 */

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

type ShellScopeState =
  | { kind: "business" }
  | { kind: "holdPending" }
  | { kind: "revoked" }
  | { kind: "noCompany" }
  | { kind: "noTeam"; settings: boolean };

/** The shell's operative state: two facts in, one state out, nothing else consulted. */
function shellScopeState(
  read: ListingRead,
  live: ScopeSelection | null,
): ShellScopeState {
  if (live === null) {
    if (read.status === "success") {
      if (read.listing.companies.length === 0) return { kind: "noCompany" };
      if (
        read.listing.companies.every((company) => company.teams.length === 0)
      ) {
        return {
          kind: "noTeam",
          settings: read.listing.companies.some(companySettingsOpenTo),
        };
      }
    }
    return { kind: "business" };
  }
  if (read.status === "success" && findSelection(read.listing, live) === null) {
    return { kind: "revoked" };
  }
  // A stored pair whose verification has not answered yet: held, so no read rides it unverified.
  if (read.status === "pending") return { kind: "holdPending" };
  return { kind: "business" };
}

/**
 * The identity handover: every enterprise-tenant entry this client holds that names another
 * account is a previous session's — its epoch ends through the coordinator's leave-scope arm
 * (which also drops the scope it was in), and the rest of its subtree goes wholesale.
 */
function useIdentityHandover(
  queryClient: QueryClient,
  userId: string | undefined,
): void {
  useEffect(() => {
    if (userId === undefined) return;
    const previous = new Set<string>();
    for (const query of queryClient.getQueryCache().getAll()) {
      const [root, owner] = query.queryKey as readonly unknown[];
      if (root !== tenantKeys.all[0]) continue;
      if (typeof owner !== "string" || owner === userId) continue;
      previous.add(owner);
    }
    for (const owner of previous) {
      // The leave-scope arm publishes synchronously: the epoch is aborted and the old scope's
      // subtree removed before the wholesale removal below runs.
      void switchWorkspaceScope(
        queryClient,
        owner,
        readCurrentSelection(queryClient, owner),
        null,
      );
      queryClient.removeQueries({ queryKey: [...tenantKeys.all, owner] });
    }
  }, [queryClient, userId]);
}

/**
 * The strip above the business content that names an empty company/team state and its next step.
 */
function ScopeNotice({
  kind,
  settings,
  t,
}: {
  kind: "noCompany" | "noTeam";
  settings: boolean;
  t: TFunction<"company-admin">;
}) {
  return (
    <div
      className="shrink-0 border-b border-border px-4 py-2 text-sm"
      role="status"
    >
      <p className="font-medium">{t(`shell.${kind}.title`)}</p>
      <p className="text-muted-foreground">{t(`shell.${kind}.description`)}</p>
      {kind === "noTeam" && settings ? (
        <div className="mt-1.5">
          <ButtonLink size="sm" to="/tenant/admin">
            {t("shell.companySettings")}
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

function RouteComponent() {
  const { t } = useTranslation("company-admin");
  const { t: tNav } = useTranslation("nav");
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const scope = useScopedCache();
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(userId ?? ""),
    enabled: userId !== undefined,
  });

  useIdentityHandover(queryClient, userId);

  const signOut = useMutation(signOutMutationOptions(queryClient));
  const handleSignOut = async () => {
    await signOut.mutateAsync();
    await navigate({ to: "/sign" });
  };

  const live = scope.status === "open" ? scope.selection : null;
  const read: ListingRead = listing.isError
    ? { status: "error" }
    : userId === undefined || listing.isPending
      ? { status: "pending" }
      : { status: "success", listing: listing.data };
  const state = shellScopeState(read, live);

  const business =
    state.kind === "business" ||
    state.kind === "noCompany" ||
    state.kind === "noTeam";

  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="280px">
      <SkipToContent />
      {business ? (
        <>
          <AppSidebar />
          <main
            id={MAIN_CONTENT_ID}
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
          >
            <SelfHostBanner />
            {state.kind === "noCompany" ? (
              <ScopeNotice kind="noCompany" settings={false} t={t} />
            ) : null}
            {state.kind === "noTeam" ? (
              <ScopeNotice kind="noTeam" settings={state.settings} t={t} />
            ) : null}
            <Outlet />
          </main>
        </>
      ) : (
        // The held shell: no business chrome, no business reads — just the state and the way out.
        <main
          id={MAIN_CONTENT_ID}
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
        >
          {state.kind === "holdPending" ? (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center"
              role="status"
            >
              <p className="text-muted-foreground text-sm">
                {t("gate.pending")}
              </p>
            </div>
          ) : (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
              role="status"
            >
              <p className="font-medium">{t("shell.revoked.title")}</p>
              <p className="text-muted-foreground text-sm">
                {t("shell.revoked.description")}
              </p>
              <div className="flex gap-2">
                <ButtonLink size="sm" to="/tenant/selection">
                  {t("shell.chooseScope")}
                </ButtonLink>
                <Button
                  disabled={signOut.isPending}
                  onClick={() => void handleSignOut()}
                  size="sm"
                  variant="outline"
                >
                  {tNav("logOut")}
                </Button>
              </div>
            </div>
          )}
        </main>
      )}
    </SidebarShell>
  );
}
