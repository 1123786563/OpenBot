import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { asProblem, Failure, type Problem } from "./Problem";

/*
 * The company-and-team choice of the desktop organization flow, MT101 (Issue #144).
 *
 * THE ONLY NATIVE SURFACE THIS CONSUMES is the frozen organization context MT098/MT099 delivered
 * (`org_context_status`, `establish_org_context` — identifiers and names only, no session bytes,
 * no credential values). The Rust side keeps the truth: `org_context_status` re-verifies against
 * the authority before it answers, `establish_org_context` re-validates every choice against the
 * authority's OWN workspace-scope listing before anything freezes, and there is no default
 * organization anywhere in that gate. This screen maps those answers onto faces; it never invents
 * an eligibility, never re-homes a stale selection, and never accepts a credential of any kind —
 * the personal model screen (ProviderPicker) stays the personal surface it always was.
 *
 * THE ELIGIBILITY CATALOG arrives as a prop in the same shape the embedded workbench's own lister
 * answers (`GET /api/enterprise/workspace-scope`, the web selection page's one fact — MT080),
 * because the delivered native surface exposes the VALIDATION of a choice, not the enumeration of
 * one. The screen renders exactly what that catalog says — no company, no team, no order beyond
 * its own — and every commit still passes through the Rust validation, so a stale or lying catalog
 * cannot freeze a scope the person is not really eligible for: it is refused with a code and shown
 * as the failure it is. A catalog that has not arrived yet is an honest pending face, not a
 * shorter list; an empty one is the empty state, not the first company.
 */

/** The person the authority verified, as MT098's status DTO answers it (identifiers only). */
export type ContextUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

/** The frozen company scope; exactly what the authority's own listing said about this company. */
export type CompanyScope = {
  tenantId: string;
  name: string;
  role: string;
  memberEpoch: number;
};

/** The frozen team scope; it exists only under its company. */
export type TeamScope = {
  workspaceId: string;
  name: string;
};

/** `org_context_status`'s whole answer, or `null`: no verified organization, nothing to choose in. */
export type OrgContextStatus = {
  authority: string;
  user: ContextUser;
  company: CompanyScope | null;
  team: TeamScope | null;
  establishedAtMs: number;
  verifiedAtMs: number;
};

/** One company and its teams, in the shape the workbench's workspace-scope listing answers. */
export type CatalogCompany = CompanyScope & {
  teams: TeamScope[];
};

/** The eligibility catalog: the companies (with teams) this person really belongs to. */
export type CompanyCatalog = {
  companies: CatalogCompany[];
};

/** A complete choice: both halves, the same pair the web selection carries. */
export type WorkbenchSelection = {
  tenantId: string;
  workspaceId: string;
};

// ---------------------------------------------------------------------------
// The state machine — pure, so the screen only maps kinds onto faces
// ---------------------------------------------------------------------------

/** The status read a screen holds, narrowed to the facts the state machine answers on. */
export type StatusRead =
  | { status: "pending" }
  | { status: "error"; problem: Problem }
  | { status: "answered"; frozen: OrgContextStatus | null };

/**
 * Where the choice stands, in the same discipline as the web selection's kinds:
 *
 * - `loading` / `error` — the status read itself. An infrastructure failure is not an
 *   authorization fact and must not dress up as one (retry offered, nothing chosen).
 * - `no-organization` — `org_context_status` answered null: no verified organization connection.
 *   The empty state. Nothing is listed, nothing is picked, no default organization exists.
 * - `choosing` — a verified organization, nothing frozen yet. The chooser.
 * - `incomplete` — a company frozen without a team: on the web side a company that names no team
 *   is not a scope at all (`selectionFromSources` refuses half a pair), so this screen treats it
 *   the same way — shown, never carried to the workbench as though it were complete.
 * - `chosen` — a complete frozen pair. This is what the workbench's requests carry.
 */
export type CompanyChoiceState =
  | { kind: "loading" }
  | { kind: "error"; problem: Problem }
  | { kind: "no-organization" }
  | { kind: "choosing"; frozen: OrgContextStatus }
  | { kind: "incomplete"; frozen: OrgContextStatus }
  | { kind: "chosen"; frozen: OrgContextStatus };

export function companyChoiceState(read: StatusRead): CompanyChoiceState {
  if (read.status === "pending") return { kind: "loading" };
  if (read.status === "error") return { kind: "error", problem: read.problem };
  if (read.frozen === null) return { kind: "no-organization" };
  const { company, team } = read.frozen;
  if (company === null) return { kind: "choosing", frozen: read.frozen };
  if (team === null) return { kind: "incomplete", frozen: read.frozen };
  return { kind: "chosen", frozen: read.frozen };
}

/** The complete pair a frozen status holds, or null when it does not hold one. */
export function selectionOf(
  frozen: OrgContextStatus,
): WorkbenchSelection | null {
  if (frozen.company === null || frozen.team === null) return null;
  return {
    tenantId: frozen.company.tenantId,
    workspaceId: frozen.team.workspaceId,
  };
}

/**
 * Put the choice on the workbench's own URL, under the same two names the web selection reads
 * (`company`, `team`), so the embedded workbench starts under the scope the desktop froze — the
 * URL is the authority there, exactly as a deep link is.
 *
 * Same-origin discipline, like the web transport's gates: a `null` selection (nothing frozen, or
 * the personal context) changes nothing at all — absence is carried as absence, never defaulted —
 * and a URL the desktop does not own shape-wise (a foreign origin, a protocol-relative path) is
 * left untouched rather than decorated. Existing query parameters (the Rust handoff's one-use
 * session ticket among them) are preserved.
 */
export function withWorkbenchSelection(
  appUrl: string,
  selection: WorkbenchSelection | null,
): string {
  if (selection === null) return appUrl;
  if (!appUrl.startsWith("/") || appUrl.startsWith("//")) return appUrl;
  const queryAt = appUrl.indexOf("?");
  const pair =
    `company=${encodeURIComponent(selection.tenantId)}` +
    `&team=${encodeURIComponent(selection.workspaceId)}`;
  return queryAt === -1 ? `${appUrl}?${pair}` : `${appUrl}&${pair}`;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** The catalog prop: not arrived yet, or the answer the workbench's lister gave. */
export type CatalogProp =
  | { status: "pending" }
  | { status: "answered"; catalog: CompanyCatalog };

/**
 * The company/team picker: two selects fed by the catalog alone, committing only a complete pair.
 * No company pre-selected, no team pre-selected — the same never-picks-for-you rule as the web
 * selection page.
 */
function Chooser({
  companies,
  busy,
  onCommit,
}: {
  companies: CatalogCompany[];
  busy: boolean;
  onCommit: (tenantId: string, workspaceId: string) => void;
}) {
  const [company, setCompany] = useState("");
  const [team, setTeam] = useState("");
  const chosenCompany = companies.find(
    (candidate) => candidate.tenantId === company,
  );
  return (
    <>
      <div className="field">
        <label htmlFor="company-choice">Company</label>
        <select
          id="company-choice"
          value={company}
          onChange={(event) => {
            setCompany(event.target.value);
            setTeam("");
          }}
        >
          <option value="">Choose a company…</option>
          {companies.map((candidate) => (
            <option key={candidate.tenantId} value={candidate.tenantId}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {chosenCompany && (
        <div className="field">
          <label htmlFor="team-choice">Team</label>
          <select
            id="team-choice"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">Choose a team…</option>
            {chosenCompany.teams.map((candidate) => (
              <option key={candidate.workspaceId} value={candidate.workspaceId}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        type="button"
        disabled={busy || company === "" || team === ""}
        onClick={() => onCommit(company, team)}
      >
        {busy ? "Saving…" : "Work in this company and team"}
      </button>
    </>
  );
}

/**
 * The desktop's organization choice surface: what is frozen, what may be chosen, and the handoff.
 *
 * Renders after an organization sign-in (and on recovery) wherever the flow needs the frozen pair
 * before the workbench opens. `onOpenWorkbench` is the handoff action (the caller's
 * `show_openbot`); `onEstablished` fires when a fresh establish froze a new pair.
 */
export function CompanySelection({
  root,
  catalog,
  onEstablished,
  onOpenWorkbench,
}: {
  root: string;
  catalog: CatalogProp;
  onEstablished?: (frozen: OrgContextStatus) => void | Promise<void>;
  onOpenWorkbench: () => void | Promise<void>;
}) {
  const [read, setRead] = useState<StatusRead>({ status: "pending" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);

  const refresh = useCallback(async () => {
    setRead({ status: "pending" });
    try {
      const frozen = await invoke<OrgContextStatus | null>(
        "org_context_status",
        { root },
      );
      setRead({ status: "answered", frozen });
    } catch (error) {
      setRead({ status: "error", problem: asProblem(error) });
    }
  }, [root]);

  useEffect(() => {
    void refresh();
    // One read per mount: the frozen context changes only through this screen's own establish,
    // which re-reads on completion, and through a restart — which remounts everything.
  }, [refresh]);

  async function establish(tenantId: string, workspaceId: string) {
    setBusy(true);
    setFailure(null);
    try {
      const frozen = await invoke<OrgContextStatus>("establish_org_context", {
        root,
        tenantId,
        workspaceId,
      });
      setRead({ status: "answered", frozen });
      await onEstablished?.(frozen);
    } catch (error) {
      // The refusal is shown with its code; the frozen selection (if any) stays as it was —
      // a refused choice never silently re-homes the screen onto another scope.
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  const state = companyChoiceState(read);
  const companies =
    catalog.status === "answered" ? catalog.catalog.companies : null;

  if (state.kind === "loading") {
    return (
      <div className="sheet">
        <h1>Your company and team</h1>
        <p role="status">Reading this installation’s organization context…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="sheet">
        <h1>Your company and team</h1>
        <p className="lede">
          OpenBot could not read its organization context. This is a connection
          problem, not an answer about your companies.
        </p>
        <Failure problem={state.problem} />
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }

  if (state.kind === "no-organization") {
    return (
      <div className="sheet">
        <h1>Your company and team</h1>
        <p className="lede">
          This installation is not signed in to an organization, so there is no
          company or team to choose. Sign in to your organization first.
        </p>
        <p className="footnote">
          OpenBot never falls back to a default organization: without a verified
          organization connection, there is nothing to choose in.
        </p>
      </div>
    );
  }

  return (
    <div className="sheet">
      <h1>Your company and team</h1>
      <p className="lede">
        Signed in to <strong>{state.frozen.authority}</strong> as{" "}
        {state.frozen.user.name ?? state.frozen.user.email}.
      </p>

      {state.kind === "chosen" &&
        state.frozen.company !== null &&
        state.frozen.team !== null && (
          <p data-testid="frozen-selection">
            Working in {state.frozen.company.name} · {state.frozen.team.name}.
            The embedded workbench carries this choice on its requests, under
            the same rules as the web workbench.
          </p>
        )}

      {state.kind === "incomplete" && state.frozen.company !== null && (
        <p data-testid="frozen-selection">
          {state.frozen.company.name} is chosen, but no team is. A company
          without a team is not a complete scope — choose a team below before
          the workbench carries the choice.
        </p>
      )}

      <fieldset className="picker" disabled={busy}>
        <legend>
          {state.kind === "chosen" ? "Change the choice" : "Choose where to work"}
        </legend>
        {catalog.status === "pending" && (
          <p className="footnote">
            The eligibility listing has not arrived from the workbench yet. You
            can open the workbench and choose there; this screen shows the
            frozen choice once it has one.
          </p>
        )}
        {companies !== null && companies.length === 0 && (
          <p className="footnote">
            {state.kind === "chosen"
              ? "The eligibility listing no longer names a company you belong to, yet a frozen choice exists. The authority’s own listing is the live fact; a fresh choice will be refused rather than re-homed if your access is gone."
              : "You do not belong to any company yet. When your organization adds you to one, it will appear here."}
          </p>
        )}
        {companies !== null && companies.length > 0 && (
          <Chooser
            companies={companies}
            busy={busy}
            onCommit={(tenantId, workspaceId) =>
              void establish(tenantId, workspaceId)
            }
          />
        )}
      </fieldset>

      {failure && <Failure problem={failure} />}

      <button
        type="button"
        disabled={busy}
        onClick={() => void onOpenWorkbench()}
      >
        Open the workbench
      </button>

      <p className="footnote">
        This choice is about where your organization’s work happens. Your
        personal model connections stay personal: they are never used as company
        credentials, and this screen never asks for one.
      </p>
    </div>
  );
}
