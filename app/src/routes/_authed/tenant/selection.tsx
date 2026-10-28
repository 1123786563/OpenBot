import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/router-link";
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
  readCurrentSelection,
  readStoredSelection,
  type ScopeSelection,
  selectionFromSources,
  selectionKeys,
  selectionState,
  storeSelection,
  switchWorkspaceScope,
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

/**
 * The BA active-preference half of a validated switch (T03.05): after the §4 validation accepts
 * the target, the server-side preference moves to the BOUND organizationId the answer carried —
 * never a tenant guess, never a team id. The write is a preference and grants nothing: the
 * server re-verifies every scoped request regardless, so a failed write costs the convenience
 * copy and nothing else (the coordinator catches and discloses it, the switch still publishes).
 *
 * The import is lazy on purpose: `@/lib/auth/client` evaluates its Better Auth singleton at
 * module scope, which needs a DOM — this route module loads before one exists in several
 * environments, including the test prelude. At call time there is always a DOM.
 */
const setActiveOrganizationPreference = async (organizationId: string) => {
  const { authClient } = await import("@/lib/auth/client");
  await authClient.organization.setActive({ organizationId });
};

/** The role/capability vocabulary that grants a member their company's own settings. */
const COMPANY_MANAGING_ROLES = new Set(["owner", "admin", "tenant_admin"]);

/**
 * Whether the company-settings entry is open to this member (T03.07): the capability the ba-v1
 * listing advertises, or the role the legacy listing carries. This only decides an entry — the
 * server re-authorizes every read behind it.
 */
export function companySettingsOpenTo(company: WorkspaceScopeCompany): boolean {
  if (company.capabilities?.includes("company:manage")) return true;
  return COMPANY_MANAGING_ROLES.has(company.role);
}

function TenantSelectionPage() {
  const { t } = useTranslation("tenant");
  const { t: tAdmin } = useTranslation("company-admin");
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
   * Which adapter owns the switch (T03.05). `ba-v1` is the interfaces §4 contract: the switch
   * freezes, the server validates the target, the BA active preference moves to the bound
   * organization, and only then does the selection generation publish. Legacy — or an unwrapped
   * deployment whose listing never advertised — keeps the MT080 switch this page was born with,
   * byte-for-byte. The pickers only render once the read has answered, so the branch is settled
   * before a person can act on it.
   */
  const baV1 = read.status === "success" && read.listing.authority === "ba-v1";

  /*
   * The company half of an in-progress ba-v1 choice. Under ba-v1 the URL carries verified scopes
   * only, so picking a company does not move it: the pick rides the picker until a team completes
   * the pair and the validation accepts it. A hand-crafted URL that names only a company names no
   * scope (the resolver answers null for it), and no unverified half is promoted into the picker
   * either.
   */
  const [pendingCompany, setPendingCompany] = useState<string | null>(null);
  /** The freeze itself: while a switch is validating, the pickers take no second intent. */
  const [switchInFlight, setSwitchInFlight] = useState(false);
  const switchInFlightRef = useRef(false);
  /**
   * The refusal code of the last switch, when the page has a next step for it. A refusal is the
   * coordinator's answer and the verified scope stays in force; the page adds one word only for
   * the refusals a person can act on (an extra sign-in the company asks for, T03.07).
   */
  const [refusalCode, setRefusalCode] = useState<string | null>(null);

  /*
   * One controlled state source (T03.05): the selection this page has verified against the
   * listing IS the session's live current selection — recorded here on verify, moved by every
   * switch through the coordinator, and the one fact the streaming half, the registry switcher
   * and a late preference read all observe.
   */
  useEffect(() => {
    if (state.kind !== "selected" || userId === undefined) return;
    const live = readCurrentSelection(queryClient, userId);
    if (
      live === null ||
      live.tenantId !== state.company.tenantId ||
      live.workspaceId !== state.team.workspaceId
    ) {
      queryClient.setQueryData(selectionKeys.current(userId), {
        tenantId: state.company.tenantId,
        workspaceId: state.team.workspaceId,
      });
    }
  }, [queryClient, state, userId]);

  /*
   * The picker's own values. Under legacy the company shows what the URL names, else the stored
   * company; under ba-v1 it shows the in-progress pick, else the verified selection's company.
   * Either way the team shows the selection's team only while its company is the one on screen —
   * a team never outlives its company in the picker, and neither half is ever filled in for the
   * user.
   */
  const companyValue = baV1
    ? (pendingCompany ?? (selection !== null ? selection.tenantId : ""))
    : (search.company ?? stored?.tenantId ?? "");
  const teamValue =
    selection !== null && selection.tenantId === companyValue
      ? selection.workspaceId
      : "";

  const commit = (next: { company: string; team?: string }) => {
    if (userId === undefined || switchInFlightRef.current) return;
    setRefusalCode(null);
    const nextSelection: ScopeSelection | null =
      next.team !== undefined
        ? { tenantId: next.company, workspaceId: next.team }
        : null;
    const finish = () => {
      if (nextSelection !== null) storeSelection(userId, nextSelection);
      void navigate({ search: { company: next.company, team: next.team } });
    };
    /*
     * The old adapter — legacy authority, and every leave-scope half — publishes inside the
     * call: listed eligibility is the whole gate there ever was (MT080), so the URL and the
     * shared generation move in the same tick they always did.
     */
    if (!baV1 || nextSelection === null) {
      void switchWorkspaceScope(queryClient, userId, selection, nextSelection);
      finish();
      return;
    }
    /*
     * ba-v1: freeze, validate, prefer, publish — the coordinator owns the order. The URL —
     * which every scoped request's headers derive from — moves only with the published scope,
     * so a refused switch leaves the previously verified one (or no scope) on screen and on the
     * wire, exactly in step.
     */
    switchInFlightRef.current = true;
    setSwitchInFlight(true);
    void switchWorkspaceScope(queryClient, userId, selection, nextSelection, {
      authority: "ba-v1",
      setActiveOrganization: setActiveOrganizationPreference,
    })
      .then((outcome) => {
        switchInFlightRef.current = false;
        setSwitchInFlight(false);
        if (outcome.kind === "published") {
          setPendingCompany(null);
          finish();
          return;
        }
        if (outcome.kind === "refused") {
          // The verified scope stays in force; the picker face returns to it. The refusal itself
          // is the coordinator's answer — this page names a next step only for the refusals a
          // person can act on (an extra sign-in the company asks for), and stays silent for the
          // rest.
          setRefusalCode(outcome.refusal.code);
          setPendingCompany(null);
        }
        // superseded: a later explicit intent owns the state; this one touches nothing.
      })
      // The chain is the coordinator's own outcome, and every arm above resets the freeze — a
      // defensive catch keeps an unexpected rejection from leaving the pickers frozen, and adds
      // no second word.
      .catch(() => {
        switchInFlightRef.current = false;
        setSwitchInFlight(false);
      });
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
              locked={switchInFlight}
              onCompany={(next) => {
                if (baV1) {
                  // The company half is an in-progress choice, not a scope: under ba-v1 the
                  // pick rides the picker until a team completes the pair and the §4
                  // validation accepts it. Nothing publishes, nothing moves.
                  setPendingCompany(next);
                  return;
                }
                commit({ company: next });
              }}
              onTeam={(next) =>
                commit({ company: pendingCompany ?? companyValue, team: next })
              }
              teamValue={teamValue}
              t={t}
            />
            {refusalCode === "COMPANY_REAUTH_REQUIRED" ? (
              <PageEmpty>{tAdmin("shell.reauth")}</PageEmpty>
            ) : null}
            {pickedCompany !== undefined && pickedCompany.teams.length === 0 ? (
              <>
                <PageEmpty>{t("selection.team.none")}</PageEmpty>
                {companySettingsOpenTo(pickedCompany) ? (
                  <ButtonLink
                    className="mt-3"
                    size="sm"
                    to="/tenant/admin"
                    variant="outline"
                  >
                    {tAdmin("shell.companySettings")}
                  </ButtonLink>
                ) : null}
              </>
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
  locked,
  onCompany,
  onTeam,
  teamValue,
  t,
}: {
  companyValue: string;
  companies: WorkspaceScopeCompany[];
  /** The frozen state while a ba-v1 switch is validating: both selectors take no second intent. */
  locked: boolean;
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
          disabled={locked}
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
          disabled={locked || companyValue === ""}
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
