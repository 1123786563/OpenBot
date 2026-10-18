import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ListingRead,
  readStoredSelection,
  type ScopeSelection,
  selectionFromSources,
  selectionState,
  selectWorkspaceScope,
  storeSelection,
  type WorkspaceScopeCompany,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";

/**
 * The company-and-team selection surface, MT080 (Issue #123).
 *
 * THE ONE FACT THIS PAGE TRUSTS is the server's own eligibility listing
 * (`GET /api/enterprise/workspace-scope`, the MT006 lister): the companies — and, per company,
 * the teams — this person really belongs to. Everything on screen is a state of that listing plus
 * the selection, and `lib/enterprise/tenant/selection` owns both: the five kinds (loading, error,
 * empty, ready, selected, revoked) are its pure state machine, and the switch is its cache
 * discipline. This component only maps kinds onto faces.
 *
 * WHAT THE PAGE REFUSES TO DO. It never picks for you: with eligible companies and nothing
 * chosen, both selectors sit at their placeholders — not the first company, not any default team
 * (spec A6: a missing selection is refused, never defaulted). It never hides a revocation: a
 * selection the listing no longer names is shown as revoked, kept in the URL, and re-checked on
 * demand — never silently re-homed onto a scope the person did not choose. And a failed listing
 * says so with a retry, rather than reading as "you have no companies".
 *
 * THE SELECTION LIVES IN THE URL (deep-linkable, the same discipline as the tenant channels
 * page), mirrored to per-account storage so a later, parameter-less visit restores the user's own
 * last explicit choice — which is also how a revocation that happened elsewhere surfaces here.
 */

export const Route = createFileRoute("/_authed/tenant/selection")({
  component: TenantSelectionPage,
  /*
   * The selection in the URL rather than component state, like the channels page's tenant: a
   * reader mid-review can hand someone the exact scope they were in, and a new tab obeys the same
   * rules (spec A10). A URL that names only a company is an incomplete scope — the resolver in
   * `selectionFromSources` answers null for it, never half of the stored selection.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    company?: string;
    team?: string;
  } => ({
    company: typeof search.company === "string" ? search.company : undefined,
    team: typeof search.team === "string" ? search.team : undefined,
  }),
});

function TenantSelectionPage() {
  const { t } = useTranslation("tenant");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(userId ?? ""),
    enabled: userId !== undefined,
  });

  const stored = userId !== undefined ? readStoredSelection(userId) : null;
  const selection = selectionFromSources(search, stored);

  const read: ListingRead =
    user.isError || listing.isError
      ? { status: "error" }
      : userId === undefined || listing.isPending
        ? { status: "pending" }
        : { status: "success", listing: listing.data };
  const state = selectionState(read, selection);

  /*
   * The picker's own values. The company shows what the URL names, else the stored company; the
   * team shows the selection's team only while its company is the one on screen — a team never
   * outlives its company in the picker, and neither half is ever filled in for the user.
   */
  const companyValue = search.company ?? stored?.tenantId ?? "";
  const teamValue =
    selection !== null && selection.tenantId === companyValue
      ? selection.workspaceId
      : "";

  const commit = (next: { company: string; team?: string }) => {
    if (userId === undefined) return;
    const nextSelection: ScopeSelection | null =
      next.team !== undefined
        ? { tenantId: next.company, workspaceId: next.team }
        : null;
    // The switch moves the shared generation and drops the old scope's cache BEFORE the URL
    // moves, so nothing renders under the old scope after the picker has moved on (spec A10).
    selectWorkspaceScope(queryClient, userId, selection, nextSelection);
    if (nextSelection !== null) storeSelection(userId, nextSelection);
    void navigate({ search: { company: next.company, team: next.team } });
  };

  const companies = read.status === "success" ? read.listing.companies : [];
  const pickedCompany = companies.find(
    (candidate) => candidate.tenantId === companyValue,
  );

  return (
    <PageShell
      description={t("selection.description")}
      title={t("selection.title")}
    >
      <PageSection title={t("selection.title")}>
        {state.kind === "loading" ? (
          <TableSkeleton />
        ) : state.kind === "error" ? (
          <>
            <PageEmpty>
              <span className="text-foreground font-medium">
                {t("selection.error.title")}
              </span>
            </PageEmpty>
            <Button
              className="mt-3"
              onClick={() => void listing.refetch()}
              size="sm"
              variant="outline"
            >
              {t("selection.error.retry")}
            </Button>
          </>
        ) : state.kind === "empty" ? (
          <>
            <PageEmpty>
              <span className="text-foreground font-medium">
                {t("selection.empty.title")}
              </span>
            </PageEmpty>
            <PageEmpty>{t("selection.empty.description")}</PageEmpty>
          </>
        ) : (
          <>
            {state.kind === "revoked" ? (
              <>
                <PageEmpty>
                  <span className="text-foreground font-medium">
                    {t("selection.revoked.title")}
                  </span>
                </PageEmpty>
                <PageEmpty>{t("selection.revoked.description")}</PageEmpty>
                <Button
                  className="mt-3"
                  onClick={() => void listing.refetch()}
                  size="sm"
                  variant="outline"
                >
                  {t("selection.revoked.retry")}
                </Button>
              </>
            ) : null}
            {state.kind === "selected" ? (
              <p className="mt-4 text-muted-foreground text-sm">
                {t("selection.current.label")}:{" "}
                <span className="text-foreground">
                  {state.company.name} · {state.team.name}
                </span>{" "}
                <span className="font-mono text-xs">
                  ({state.company.role})
                </span>
              </p>
            ) : null}
            <ScopeSelectors
              companyValue={companyValue}
              companies={companies}
              onCompany={(next) => commit({ company: next })}
              onTeam={(next) => commit({ company: companyValue, team: next })}
              teamValue={teamValue}
              t={t}
            />
            {pickedCompany !== undefined && pickedCompany.teams.length === 0 ? (
              <PageEmpty>{t("selection.team.none")}</PageEmpty>
            ) : null}
          </>
        )}
      </PageSection>
    </PageShell>
  );
}

/**
 * The two selectors, shared by the ready, selected and revoked states — the revoked state keeps
 * them, because choosing another scope explicitly is the recovery path the revocation face offers.
 * The team selector stays at its placeholder until a company is on screen, and no option is
 * pre-picked anywhere.
 */
function ScopeSelectors({
  companyValue,
  companies,
  onCompany,
  onTeam,
  teamValue,
  t,
}: {
  companyValue: string;
  companies: WorkspaceScopeCompany[];
  onCompany: (next: string) => void;
  onTeam: (next: string) => void;
  teamValue: string;
  t: TFunction<"tenant">;
}) {
  const teams =
    companies.find((candidate) => candidate.tenantId === companyValue)?.teams ??
    [];
  /*
   * The closed trigger's label is resolved here, not by the widget: the options only exist while
   * the popup is open, so a value whose label the widget cannot see would otherwise show the raw
   * id (including a revoked selection's — which stays visible on purpose, never re-homed).
   */
  const companyLabel =
    companies.find((candidate) => candidate.tenantId === companyValue)?.name ??
    companyValue;
  const teamLabel =
    teams.find((candidate) => candidate.workspaceId === teamValue)?.name ??
    teamValue;
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm" htmlFor="workspace-scope-company">
          {t("selection.company.label")}
        </label>
        <Select
          onValueChange={(next) => {
            // A non-string answer from the widget is no selection at all — not something to pass
            // on. Selecting a company alone never chooses a team: the team half resets.
            if (typeof next !== "string") return;
            onCompany(next);
          }}
          value={companyValue}
        >
          <SelectTrigger
            aria-label={t("selection.company.aria")}
            id="workspace-scope-company"
          >
            <SelectValue placeholder={t("selection.company.placeholder")}>
              {companyValue !== "" ? companyLabel : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {companies.map((company) => (
                <SelectItem key={company.tenantId} value={company.tenantId}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm" htmlFor="workspace-scope-team">
          {t("selection.team.label")}
        </label>
        <Select
          disabled={companyValue === ""}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            onTeam(next);
          }}
          value={teamValue}
        >
          <SelectTrigger
            aria-label={t("selection.team.aria")}
            id="workspace-scope-team"
          >
            <SelectValue placeholder={t("selection.team.placeholder")}>
              {teamValue !== "" ? teamLabel : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {teams.map((team) => (
                <SelectItem key={team.workspaceId} value={team.workspaceId}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
