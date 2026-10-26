import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import type { ValidatedSelection } from "../../../../../shared/auth-directory";
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
  /**
   * The BA directory row this workspace is bound to (interfaces §4, T03.02). Present only when the
   * listing advertised `ba-v1`; a binding fact to carry, never a substitute for `workspaceId` —
   * the workspace id is the stable business identity, and the team row is recreated on re-join.
   */
  teamId?: string;
  workspaceMemberEpoch?: number;
  teamGeneration?: number;
};

/** One company the actor is an active member of, with the teams they belong to. */
export type WorkspaceScopeCompany = {
  tenantId: string;
  name: string;
  /** The actor's own company role for this company. */
  role: string;
  memberEpoch: number;
  teams: WorkspaceScopeTeam[];
  /**
   * The BA-side binding facts of the §4 DTO (T03.02): present only when the listing advertised
   * `ba-v1`. `organizationId` is what the BA active preference is written with — read from the
   * validated answer, never guessed from the tenant id.
   */
  organizationId?: string;
  companyGeneration?: number;
  capabilities?: readonly string[];
};

/**
 * The DTO contract the listing response advertised (T03.02 / T03.05). `legacy` is the DTO this
 * module was born reading (MT080); `ba-v1` is the interfaces §4 shape with its binding and
 * version fields. Undefined means the deployment serves the listing unwrapped — the pre-T03.02
 * world, which reads and switches exactly as legacy does.
 */
export type DirectoryAuthorityAdvertisement = "legacy" | "ba-v1";

/** The listing's whole answer: eligible companies, nothing pre-selected. */
export type WorkspaceScopeListing = {
  companies: WorkspaceScopeCompany[];
  /** The advertised DTO contract (see {@link DirectoryAuthorityAdvertisement}); absent on an unwrapped legacy deployment. */
  authority?: DirectoryAuthorityAdvertisement;
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
/** The live current selection this app session holds (see {@link selectionKeys.current}). */
const CURRENT_SELECTION = ":current-selection";
/**
 * The count of EXPLICIT selection intents this session has burned (T03.05). Data is a number; a
 * late async answer that would seed the selection may only land while it is still zero — once a
 * person has chosen, no background response outranks them.
 */
const SWITCH_INTENT = ":switch-intent";
/** Where business surfaces cache what they answer under "no company/team selected" (MT083). */
const PERSONAL_SCOPE = ":personal";

/**
 * The DTO contract header the T03.02-wrapped listing answers with (interfaces §4). The same name
 * the server's mount sets (`DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER` in
 * server/src/enterprise/tenancy/workspace-scope-routes.ts); restated here because the app cannot
 * import server code, and a drift between the two would be a compile-time stranger, not an error.
 */
const DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER =
  "x-openbot-directory-authority";

export const selectionKeys = {
  /** The eligibility listing — the one read that needs no selection, like the chooser. */
  listing: (userId: string) =>
    [...tenantKeys.all, userId, WORKSPACE_SCOPE_LISTING] as const,
  /** Everything one (company, team) answers for, under the tenant prefix the switch removes. */
  workspaceScope: (userId: string, tenantId: string, workspaceId: string) =>
    [...tenantKeys.scope(userId, tenantId), WORKSPACE, workspaceId] as const,
  /**
   * The selection this app session is actually working under, pair or null.
   *
   * Written by {@link selectWorkspaceScope} (the one switch seam), seeded from the per-account
   * storage by whoever observes it first (the streaming half reads it in
   * `lib/enterprise/tenant/stream-scope.ts`, MT082), and mirrored across tabs through the
   * browser's storage event. Distinct from storage itself, which stays what it always was: the
   * user's last explicit choice, not a live value.
   */
  current: (userId: string) =>
    [...tenantKeys.all, userId, CURRENT_SELECTION] as const,
  /**
   * The personal context's business subtree: what the scoped-cache mechanism (MT083,
   * `scoped-cache.ts`) files business reads and writes under when nothing is selected. The one
   * prefix a switch INTO a selection must remove — data cached under "no selection" belongs to no
   * company, and must not sit beside (or flash through into) the scope just chosen.
   */
  personalScope: (userId: string) =>
    [...tenantKeys.all, userId, PERSONAL_SCOPE] as const,
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
      /*
       * The wrapped listing names its DTO contract (T03.02): `ba-v1` answers the §4 shape — the
       * same minimal check above accepts it, the binding fields arrive as optional facts — and
       * `legacy` answers the body this module always read. An advertisement this client does not
       * know is a contract it cannot parse honestly, so it refuses rather than guessing a branch
       * (the client-side twin of the server's own fail-closed rule). No header at all is the
       * unwrapped pre-T03.02 deployment, which keeps reading and switching as legacy does.
       */
      const advertised = response.headers.get(
        DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER,
      );
      if (
        advertised !== null &&
        advertised !== "legacy" &&
        advertised !== "ba-v1"
      ) {
        throw new WorkspaceScopeRefusedError(
          response.status,
          "DIRECTORY_AUTHORITY_UNKNOWN",
        );
      }
      return advertised === null
        ? (body as WorkspaceScopeListing)
        : { ...(body as WorkspaceScopeListing), authority: advertised };
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
 * the company. And moving from no selection into one drops the personal context's business subtree
 * (`selectionKeys.personalScope`, MT083) beside the generation advance. Order matters exactly as in
 * `selectTenant` — the generation moves before any cache goes, so a response already in flight
 * against the old scope is refused on arrival.
 *
 * The live current-selection entry (`selectionKeys.current`, MT082) moves here too: every switch
 * that can change what a stream should carry changes it in this one place, so the streaming half
 * has no second seam to keep in step.
 */
export function selectWorkspaceScope(
  queryClient: QueryClient,
  userId: string,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (sameScope(previous, next)) return;
  queryClient.setQueryData(selectionKeys.current(userId), next);
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
  if (previous === null && next !== null) {
    // Choosing a scope out of the personal context drops the personal context's business subtree
    // as well (MT083): the generation has already moved above, so an in-flight personal read is
    // refused on arrival — and this removal is why no stale personal entry can render beside the
    // scope that was just chosen, the same discipline a team change applies to the old team.
    queryClient.removeQueries({
      queryKey: selectionKeys.personalScope(userId),
    });
  }
}

// ---------------------------------------------------------------------------
// The switch coordinator (T03.05): freeze, validate, prefer, publish — one intent order
// ---------------------------------------------------------------------------

/** The live current selection, as one reader — the entry {@link selectionKeys.current} holds. */
export function readCurrentSelection(
  queryClient: QueryClient,
  userId: string,
): ScopeSelection | null {
  return (
    queryClient.getQueryData<ScopeSelection | null>(
      selectionKeys.current(userId),
    ) ?? null
  );
}

function explicitIntentsOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(intentKeys(userId)) ?? 0;
}

/** Records one more explicit selection act and returns its ordinal; the latest ordinal owns state. */
function burnExplicitIntent(queryClient: QueryClient, userId: string): number {
  const next = explicitIntentsOf(queryClient, userId) + 1;
  queryClient.setQueryData(intentKeys(userId), next);
  return next;
}

function intentKeys(userId: string) {
  return [...tenantKeys.all, userId, SWITCH_INTENT] as const;
}

/**
 * The §4 validation read (T03.02's `POST /api/enterprise/workspace-scope/validate-selection`).
 *
 * The request body IS the explicit target — the pair the person chose. It carries no scope
 * headers on purpose: the headers would name the scope being LEFT, and the §4 contract refuses
 * an explicit selection that conflicts with them (SCOPE_SELECTOR_CONFLICT), so attaching the old
 * pair here would be asking for the refusal the person never chose. The validation is answered
 * before any switch publishes, so there is no new pair to name yet either.
 *
 * A non-ok answer, or a 200 that is not a ValidatedSelection, refuses as a typed error — a
 * malformed acceptance is not an acceptance.
 */
export async function validateWorkspaceScopeSelection(
  target: ScopeSelection,
): Promise<ValidatedSelection> {
  const response = await tryClient(
    "/api/enterprise/workspace-scope/validate-selection",
    {
      method: "POST",
      body: { tenantId: target.tenantId, workspaceId: target.workspaceId },
      fallbackKey: "enterpriseTenant.validateWorkspaceScope",
    },
  );
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
        : "SELECTION_REFUSED";
    throw new WorkspaceScopeRefusedError(response.status, code);
  }
  const body = (await response.json().catch(() => null)) as unknown;
  const shaped =
    body !== null &&
    typeof body === "object" &&
    ["tenantId", "workspaceId", "organizationId", "teamId"].every(
      (field) =>
        typeof (body as Record<string, unknown>)[field] === "string" &&
        ((body as Record<string, unknown>)[field] as string) !== "",
    ) &&
    [
      "memberEpoch",
      "workspaceMemberEpoch",
      "companyGeneration",
      "teamGeneration",
    ].every(
      (field) => typeof (body as Record<string, unknown>)[field] === "number",
    ) &&
    Array.isArray((body as Record<string, unknown>).capabilities) &&
    ((body as Record<string, unknown>).capabilities as unknown[]).every(
      (capability) => typeof capability === "string",
    );
  if (!shaped) {
    throw new WorkspaceScopeRefusedError(
      response.status,
      "VALIDATION_MALFORMED",
    );
  }
  return body as ValidatedSelection;
}

/** What a caller hands {@link switchWorkspaceScope} to steer the validated path. */
export type WorkspaceScopeSwitchPlan = Readonly<{
  /**
   * The DTO contract the current listing advertised. Only `ba-v1` takes the validated path;
   * anything else — legacy, or an answer that never came — keeps the old adapter, because a
   * legacy deployment's eligibility listing is the whole validation there ever was.
   */
  authority?: DirectoryAuthorityAdvertisement;
  /**
   * The BA active-preference sink: fed the BOUND `organizationId` of the validated target, after
   * the validation accepts it and before the new selection generation publishes. A preference,
   * never an authorization — the server re-verifies every scoped request regardless.
   */
  setActiveOrganization?: (organizationId: string) => void | Promise<void>;
  /**
   * The §4 validation transport. Injectable so a test can hold, order and inspect validations
   * with controlled promises; the default is the real {@link validateWorkspaceScopeSelection}.
   */
  validate?: (target: ScopeSelection) => Promise<ValidatedSelection>;
}>;

/** How one explicit switch ended. */
export type WorkspaceScopeSwitchOutcome =
  | {
      kind: "published";
      /** The selection now in force (null: no scope). */
      selection: ScopeSelection | null;
      /** Whether the BA active preference sink accepted the bound organizationId. */
      preferenceRecorded: boolean;
    }
  | {
      kind: "refused";
      /** The scope that remains — the previously verified one, or null; unchanged by this refusal. */
      selection: ScopeSelection | null;
      refusal: WorkspaceScopeRefusedError;
    }
  | {
      kind: "superseded";
      /** The scope actually in force when this intent settled; a later explicit intent owns it. */
      selection: ScopeSelection | null;
    };

/** Wraps anything the transport threw that is not already a typed refusal. */
function refusalOf(error: unknown): WorkspaceScopeRefusedError {
  if (error instanceof WorkspaceScopeRefusedError) return error;
  const refusal = new WorkspaceScopeRefusedError(0, "SELECTION_UNAVAILABLE");
  refusal.cause = error;
  return refusal;
}

/**
 * The one switch coordinator (T03.05). An explicit act, in the contract's order:
 *
 * 1. FREEZE — the intent is recorded first, as the latest explicit ordinal. From this moment an
 *    earlier in-flight intent can no longer publish, and a late background answer can no longer
 *    seed the session ({@link adoptActivePreference} reads the same counter).
 * 2. VALIDATE — only where the listing advertised `ba-v1`: the target pair goes to the §4
 *    validation, and the answer must echo the pair that was asked for. Legacy authority keeps
 *    the old adapter — the MT080 switch, server-listed eligibility and no second gate.
 * 3. PREFER — the BA active preference moves to the BOUND organizationId the validated answer
 *    carries. Never the tenant id as a guess, never a team id: the binding is the answer's own
 *    fact. A preference write that fails does not fail the switch — the validation already
 *    accepted the scope, and the preference grants nothing.
 * 4. PUBLISH — {@link selectWorkspaceScope} moves the generation and the caches, exactly as
 *    every switch since MT080 did.
 *
 * A refusal publishes nothing: the previously verified scope (or no scope) stays, so the screen
 * and the request headers it rides cannot fall out of step. A superseded intent — a later
 * explicit act happened while this one waited — settles without touching state at all.
 *
 * `next === null` (a company half without a team, or leaving a scope) needs no validation: it
 * grants nothing. The publish is the whole act, which is the pre-T03.05 behavior for that half.
 */
export async function switchWorkspaceScope(
  queryClient: QueryClient,
  userId: string,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
  plan: WorkspaceScopeSwitchPlan = {},
): Promise<WorkspaceScopeSwitchOutcome> {
  if (sameScope(previous, next)) {
    return { kind: "published", selection: next, preferenceRecorded: false };
  }
  const intent = burnExplicitIntent(queryClient, userId);
  const stale = () => explicitIntentsOf(queryClient, userId) !== intent;

  if (plan.authority !== "ba-v1" || next === null) {
    // The old adapter: legacy authority (or none), and every leave-scope half.
    selectWorkspaceScope(queryClient, userId, previous, next);
    return { kind: "published", selection: next, preferenceRecorded: false };
  }

  let validated: ValidatedSelection;
  try {
    validated = await (plan.validate ?? validateWorkspaceScopeSelection)(next);
  } catch (error) {
    if (stale()) {
      return {
        kind: "superseded",
        selection: readCurrentSelection(queryClient, userId),
      };
    }
    return { kind: "refused", selection: previous, refusal: refusalOf(error) };
  }
  if (stale()) {
    return {
      kind: "superseded",
      selection: readCurrentSelection(queryClient, userId),
    };
  }
  // The answer must be about the pair that was asked for. A server echoing a different scope is
  // not a validation of this one — and the workspace half especially must come back as the
  // stable id that was sent, never the BA team row beside it.
  if (
    validated.tenantId !== next.tenantId ||
    validated.workspaceId !== next.workspaceId
  ) {
    return {
      kind: "refused",
      selection: previous,
      refusal: new WorkspaceScopeRefusedError(200, "VALIDATION_ECHO_MISMATCH"),
    };
  }

  let preferenceRecorded = false;
  if (plan.setActiveOrganization !== undefined) {
    try {
      await plan.setActiveOrganization(validated.organizationId);
      preferenceRecorded = true;
    } catch {
      /* The validation accepted the scope; a failed preference write grants nothing and costs nothing. */
    }
  }
  selectWorkspaceScope(queryClient, userId, previous, next);
  return { kind: "published", selection: next, preferenceRecorded };
}

/**
 * Lands a NON-explicit scope answer — the async resolutions that claim what this session should
 * be working under: an active-organization preference read, mapped through the listing to the
 * pair it names, or any equivalent background answer.
 *
 * The rule is the one the whole coordinator hangs on: such an answer may only SEED a session
 * that has never made an explicit selection. The first seed wins (a second background answer
 * never fights the first), and once a person has chosen — the intent counter moved — every late
 * arrival is refused, however stale its ordering. A delayed active-company A that resolves after
 * an explicit B replaces nothing.
 *
 * The seed writes only the live current-selection entry, never the per-account storage: storage
 * is the person's own last explicit choice, and a preference is not one.
 */
export function adoptActivePreference(
  queryClient: QueryClient,
  userId: string,
  preference: ScopeSelection | null,
): boolean {
  if (explicitIntentsOf(queryClient, userId) > 0) return false;
  if (queryClient.getQueryData(selectionKeys.current(userId)) !== undefined) {
    return false;
  }
  queryClient.setQueryData(selectionKeys.current(userId), preference);
  return true;
}

/**
 * Resolves a switcher's company id to the listing row it names, through the binding the listing
 * carries: the `organizationId` under `ba-v1`, the `tenantId` otherwise. An id the listing does
 * not name — including any BA team row id, which is neither field — answers null. The caller
 * treats null as "no OpenBot company", never a guess.
 */
export function companyOfBinding(
  listing: WorkspaceScopeListing | null,
  companyId: string,
): WorkspaceScopeCompany | null {
  if (listing === null) return null;
  return (
    listing.companies.find(
      (company) =>
        (company.organizationId !== undefined &&
          company.organizationId === companyId) ||
        company.tenantId === companyId,
    ) ?? null
  );
}
