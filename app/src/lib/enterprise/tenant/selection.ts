import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { selectTenant, tenantKeys } from "./queries";

/*
 * The company-and-team selection layer, MT080 (Issue #123).
 *
 * THE DATA CONTRACT IS THE MT006 LISTER'S. `GET /api/enterprise/workspace-scope` answers with this
 * user's eligible companies and, per company, the teams they belong to — eligibility decided by
 * the server's own membership facts (tenant, principal and membership rows all `active`), never by
 * anything this client declares. The listing carries no current/default/selected field by contract
 * (pinned server-side in MT006): what is selected here is this module's business, and nothing is
 * selected unless a person picks it.
 *
 * THE TWO RULES THE TENANCY DESIGN IMPOSES, continued from `queries.ts`. The selection rides the
 * request — `x-openbot-tenant` with `x-openbot-workspace`, attached per request by `client` (see
 * the same-origin gate there); there is no module-level "current scope". And the cache is scoped:
 * the workspace entries live under the SAME per-user, per-tenant prefixes the tenant surface
 * already removes on a company switch, and every switch advances the SAME generation, so a
 * response that left under one selection and lands under another is refused on arrival (the
 * `TenantSelectionChangedError` guard in queries.ts) instead of decorating the new scope.
 *
 * The team selection is ADDED ON TOP of that design — one key tree, one generation, one removal
 * discipline — not a parallel mechanism beside it.
 */

/** One team the actor belongs to, named by the tenant-scoped data read. */
export type WorkspaceScopeTeam = {
  workspaceId: string;
  name: string;
};

/** One company the actor is an active member of, with the teams they belong to. */
export type WorkspaceScopeCompany = {
  tenantId: string;
  name: string;
  /** The actor's own company role for this company. */
  role: string;
  memberEpoch: number;
  teams: WorkspaceScopeTeam[];
};

/** The listing's whole answer: eligible companies, nothing pre-selected. */
export type WorkspaceScopeListing = {
  companies: WorkspaceScopeCompany[];
};

/** A complete selection: both halves, or no selection at all. */
export type ScopeSelection = {
  tenantId: string;
  workspaceId: string;
};

/**
 * The refusal a non-ok listing raises, carrying the facts the state machine needs — the status and
 * the server's own error code — instead of flattening them into a sentence. The page never shows
 * this message: infrastructure trouble says so in its own words (spec: errors do not fall back to
 * a default scope, and they do not masquerade as an empty eligibility either).
 */
export class WorkspaceScopeRefusedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(
      `The workspace-scope listing refused the request (${status} ${code}).`,
    );
    this.name = "WorkspaceScopeRefusedError";
    this.status = status;
    this.code = code;
  }
}

/** The typed refusal behind an error, for callers that branch on it; anything else is not one. */
export function scopeRefusalOf(
  error: unknown,
): WorkspaceScopeRefusedError | null {
  return error instanceof WorkspaceScopeRefusedError ? error : null;
}

/*
 * Reserved second-element tokens, same discipline as queries.ts: a tenant id matches
 * `^[A-Za-z0-9_-]{1,128}$`, so a leading colon keeps these from ever colliding with one —
 * which is what lets prefix removal target exactly one subtree.
 */
const WORKSPACE_SCOPE_LISTING = ":workspace-scope";
/** Third-level token under a tenant scope; team entries gather under it, per workspace. */
const WORKSPACE = ":workspace";

export const selectionKeys = {
  /** The eligibility listing — the one read that needs no selection, like the chooser. */
  listing: (userId: string) =>
    [...tenantKeys.all, userId, WORKSPACE_SCOPE_LISTING] as const,
  /** Everything one (company, team) answers for, under the tenant prefix the switch removes. */
  workspaceScope: (userId: string, tenantId: string, workspaceId: string) =>
    [...tenantKeys.scope(userId, tenantId), WORKSPACE, workspaceId] as const,
};

/**
 * The listing read. Ruling #1 (MT005): the selector headers only select; the listing is answered
 * before any selection exists, so it names no tenant and no workspace — naming a scope here would
 * be circular. A non-ok answer, or a 200 that is not a listing, refuses as a typed error; a
 * broken body must never read as "you have no companies".
 */
export function workspaceScopeListingQueryOptions(userId: string) {
  return queryOptions({
    queryKey: selectionKeys.listing(userId),
    queryFn: async (): Promise<WorkspaceScopeListing> => {
      const response = await tryClient("/api/enterprise/workspace-scope", {
        fallbackKey: "enterpriseTenant.loadWorkspaceScope",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const envelope = body?.error;
        const code =
          envelope !== null &&
          typeof envelope === "object" &&
          typeof (envelope as Record<string, unknown>).code === "string"
            ? (envelope as { code: string }).code
            : "WORKSPACE_SCOPE_REFUSED";
        throw new WorkspaceScopeRefusedError(response.status, code);
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (
        body === null ||
        typeof body !== "object" ||
        !Array.isArray((body as Record<string, unknown>).companies)
      ) {
        throw new WorkspaceScopeRefusedError(
          response.status,
          "WORKSPACE_SCOPE_MALFORMED",
        );
      }
      const companies: unknown[] = (body as { companies: unknown[] }).companies;
      const shaped = companies.every(
        (company) =>
          company !== null &&
          typeof company === "object" &&
          typeof (company as Record<string, unknown>).tenantId === "string" &&
          Array.isArray((company as Record<string, unknown>).teams),
      );
      if (!shaped) {
        throw new WorkspaceScopeRefusedError(
          response.status,
          "WORKSPACE_SCOPE_MALFORMED",
        );
      }
      return body as WorkspaceScopeListing;
    },
  });
}

// ---------------------------------------------------------------------------
// The state machine — pure, so the page only maps kinds onto faces
// ---------------------------------------------------------------------------

/** The listing read a screen holds, narrowed to the facts the state machine answers on. */
export type ListingRead =
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; listing: WorkspaceScopeListing };

export type SelectionState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  /** Eligible companies exist; nobody has chosen a scope. Nothing is picked for them. */
  | { kind: "ready" }
  | {
      kind: "selected";
      company: WorkspaceScopeCompany;
      team: WorkspaceScopeTeam;
    }
  | {
      kind: "revoked";
      /** The selection that no longer matches the listing — shown, never silently cleared. */
      selection: ScopeSelection;
    };

/**
 * Where the chosen pair sits in the listing, or null when it does not.
 *
 * This IS the revocation judgment: the server's lister is the live membership fact (a suspended
 * company hides whole, a suspended team hides alone), so an absent pair means revoked access —
 * and an erroring listing stays an error, because infrastructure trouble is not an authorization
 * fact and must not dress up as one.
 */
export function findSelection(
  listing: WorkspaceScopeListing,
  selection: ScopeSelection,
): { company: WorkspaceScopeCompany; team: WorkspaceScopeTeam } | null {
  const company = listing.companies.find(
    (candidate) => candidate.tenantId === selection.tenantId,
  );
  if (company === undefined) return null;
  const team = company.teams.find(
    (candidate) => candidate.workspaceId === selection.workspaceId,
  );
  if (team === undefined) return null;
  return { company, team };
}

export function selectionState(
  read: ListingRead,
  selection: ScopeSelection | null,
): SelectionState {
  if (read.status === "pending") return { kind: "loading" };
  if (read.status === "error") return { kind: "error" };
  if (read.listing.companies.length === 0) return { kind: "empty" };
  if (selection === null) return { kind: "ready" };
  const found = findSelection(read.listing, selection);
  if (found === null) return { kind: "revoked", selection };
  return { kind: "selected", company: found.company, team: found.team };
}

/**
 * The selection this screen holds, from the two user-explicit sources.
 *
 * The URL is the authority whenever it names anything (deep links stay exact, and a link that
 * names only a company is an incomplete scope — not half of the stored one). Storage fills only a
 * silent URL, with the user's own last explicit choice; it never invents one.
 */
export function selectionFromSources(
  url: { company?: string; team?: string },
  stored: ScopeSelection | null,
): ScopeSelection | null {
  if (url.company !== undefined || url.team !== undefined) {
    if (url.company !== undefined && url.team !== undefined) {
      return { tenantId: url.company, workspaceId: url.team };
    }
    return null;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Persistence — the choice itself is user-explicit; storage only remembers it
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "openbot.workspace-scope.v1:";

/** The per-account storage slot, exported so tests can corrupt it. */
export function selectionStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function scopeOf(value: unknown): ScopeSelection | null {
  if (value === null || typeof value !== "object") return null;
  const tenantId = (value as Record<string, unknown>).tenantId;
  const workspaceId = (value as Record<string, unknown>).workspaceId;
  if (
    typeof tenantId !== "string" ||
    tenantId === "" ||
    typeof workspaceId !== "string" ||
    workspaceId === ""
  ) {
    return null;
  }
  return { tenantId, workspaceId };
}

/** The user's last explicit selection on this browser, or null. A damaged slot reads as nothing. */
export function readStoredSelection(userId: string): ScopeSelection | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(selectionStorageKey(userId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return scopeOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remember an explicit choice. The URL carries the authority after a commit; this mirror is what
 * a later, parameter-less visit reads. Storage trouble is swallowed because the URL still holds
 * the selection — the choice is not lost, only its convenience copy.
 */
export function storeSelection(
  userId: string,
  selection: ScopeSelection,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      selectionStorageKey(userId),
      JSON.stringify(selection),
    );
  } catch {
    /* The URL carries the selection; the mirror is best-effort. */
  }
}

// ---------------------------------------------------------------------------
// The switch — one generation, one removal discipline, shared with the tenant surface
// ---------------------------------------------------------------------------

function generationOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
}

function sameScope(
  left: ScopeSelection | null,
  right: ScopeSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
  );
}

/**
 * The whole switch, for a selection that now names `next` (null: the picker holds a company
 * without a team, which is no scope at all).
 *
 * Company change — including into or out of "no selection" — reuses `selectTenant` wholesale: the
 * generation advances and the old company's ENTIRE scope subtree goes (ours and the channels
 * surface's alike, since both live under the same tenant prefix). Team change inside one company
 * advances the generation and drops only the old team's subtree: leaving one team is not leaving
 * the company. Order matters exactly as in `selectTenant` — the generation moves before any cache
 * goes, so a response already in flight against the old scope is refused on arrival.
 */
export function selectWorkspaceScope(
  queryClient: QueryClient,
  userId: string,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (sameScope(previous, next)) return;
  if (
    previous !== null &&
    next !== null &&
    previous.tenantId === next.tenantId
  ) {
    queryClient.setQueryData(
      tenantKeys.generation(userId),
      generationOf(queryClient, userId) + 1,
    );
    queryClient.removeQueries({
      queryKey: selectionKeys.workspaceScope(
        userId,
        previous.tenantId,
        previous.workspaceId,
      ),
    });
    return;
  }
  selectTenant(
    queryClient,
    userId,
    previous?.tenantId ?? null,
    next?.tenantId ?? null,
  );
}
