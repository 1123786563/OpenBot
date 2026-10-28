import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  readCurrentSelection,
  readStoredSelection,
  type ScopeSelection,
  switchWorkspaceScope,
  validateWorkspaceScopeSelection,
  WorkspaceScopeRefusedError,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";

/**
 * The client half of the company's extra sign-in, T05.15 (P13).
 *
 * The server halves are already wired: the scope gate answers 403 COMPANY_REAUTH_REQUIRED when a
 * company's stored policy demands a proof the session does not hold (T05.04), and the challenge
 * routes issue one and complete it on the IdP's callback (T05.01/T05.02). This module owns what
 * the browser does around those answers: it learns the refusal through the one typed channel the
 * client has — the §4 validation, whose refusals carry the server's code — and on it, the app
 * keeps the company and team it was working under, pauses business, and offers the company's
 * extra sign-in. The round trip is a full-page journey to the provider and back, so the pause is
 * per-app-session memory and the landing is recognized by a one-shot marker recorded before the
 * hand-off: coming back re-validates the scope, a completed proof resumes it through the one
 * switch coordinator, and anything else never resumes what the proof did not cover.
 *
 * NOT THIS MODULE'S JOB. A refusal that is not the proof question never pauses anything — an
 * account-linking or MFA demand is not a company SSO, and a network failure is the surfaces'
 * own error to show. The gate fails open to the app rather than breaking it.
 */

/** The server's own code, restated for the same reason every other frozen name is (T05.04). */
export const COMPANY_REAUTH_REQUIRED = "COMPANY_REAUTH_REQUIRED";

/** A pause in force: the company and team are preserved, business is not running. */
export type CompanyReauthPause = Readonly<{
  tenantId: string;
  workspaceId: string;
  /**
   * A round trip came back and the proof still does not hold: the sign-in finished with a
   * different account, or the company changed underneath it.
   */
  failed: boolean;
}>;

/** The marker that survives the provider round trip: written before the hand-off, read once. */
type CompanyReauthMarker = Readonly<{
  tenantId: string;
  workspaceId: string;
  returnPath: string;
}>;

function markerKey(userId: string): string {
  return `openbot.company-reauth.v1:${userId}`;
}

function markerOf(value: unknown): CompanyReauthMarker | null {
  if (value === null || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.tenantId !== "string" ||
    typeof fields.workspaceId !== "string" ||
    typeof fields.returnPath !== "string"
  ) {
    return null;
  }
  return {
    tenantId: fields.tenantId,
    workspaceId: fields.workspaceId,
    returnPath: fields.returnPath,
  };
}

/** Reads and removes the marker in one act: the resume is one-shot, whatever it finds. */
function takeCompanyReauthMarker(userId: string): CompanyReauthMarker | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(markerKey(userId));
  if (raw !== null) window.sessionStorage.removeItem(markerKey(userId));
  return markerOf(raw === null ? null : (JSON.parse(raw) as unknown));
}

// ---------------------------------------------------------------------------
// The pause — module state, because it must not survive the round trip
// ---------------------------------------------------------------------------

const pauses = new Map<string, CompanyReauthPause>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function pauseCompanyForReauth(
  queryClient: QueryClient,
  userId: string,
  selection: ScopeSelection,
  failed: boolean,
): void {
  if (pauses.has(userId)) return;
  pauses.set(userId, {
    tenantId: selection.tenantId,
    workspaceId: selection.workspaceId,
    failed,
  });
  // The pause is real, not visual: in-flight reads die here, so nothing answers under a scope
  // the server just refused. New ones never start — the wall replaces the tree that would fire them.
  void queryClient.cancelQueries();
  emit();
}

/** The person's own way out of the wall: the pause drops, the chooser offers every company. */
export function dismissCompanyReauth(userId: string): void {
  if (!pauses.delete(userId)) return;
  emit();
}

/**
 * The fresh-boot seam. A real navigation to the provider's page resets this module's state by
 * destroying the page; a test that re-draws the app inside one JS context resets the same state
 * by hand (the same deal as `selectionStorageKey`, exported so tests can reach it).
 */
export function resetCompanyReauthState(): void {
  pauses.clear();
  emit();
}

function subscribeCompanyReauth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pause in force for this person, live. Null is the ordinary day. */
export function useCompanyReauthPause(
  userId: string | undefined,
): CompanyReauthPause | null {
  return useSyncExternalStore(
    subscribeCompanyReauth,
    () => (userId === undefined ? null : (pauses.get(userId) ?? null)),
    () => null,
  );
}

/** Whether the app even has a company question to ask before its first paint. */
export function companyReauthNeedsGate(userId: string): boolean {
  return (
    takeCompanyReauthMarkerPeek(userId) !== null ||
    readStoredSelection(userId) !== null
  );
}

function takeCompanyReauthMarkerPeek(userId: string): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(markerKey(userId));
}

// ---------------------------------------------------------------------------
// The gate — runs once per app entry, before business mounts
// ---------------------------------------------------------------------------

/** Only the server's own proof code is the proof question; anything else is not a pause. */
function isProofRefusal(error: unknown): boolean {
  return (
    error instanceof WorkspaceScopeRefusedError &&
    error.code === COMPANY_REAUTH_REQUIRED
  );
}

/**
 * The assurance question at the gate: does the company this app session works under still
 * accept its proof? Asked only where the listing advertised `ba-v1` — a legacy or unwrapped
 * deployment keeps its behavior byte-for-byte, with no validation and no wall.
 */
async function authorityIsBaV1(
  queryClient: QueryClient,
  userId: string,
): Promise<boolean> {
  const listing = await queryClient.ensureQueryData(
    workspaceScopeListingQueryOptions(userId),
  );
  return listing.authority === "ba-v1";
}

/**
 * One gate pass, on app entry. In order: a landing from the company's extra sign-in is resumed
 * (one validation, then the one switch coordinator); otherwise the live scope's proof is asked
 * about, and only the named refusal pauses the app.
 *
 * The gate never breaks the app: an unreadable world is not a proof question, and the surfaces
 * below show their own errors.
 */
export async function companyReauthGate(
  queryClient: QueryClient,
  userId: string,
): Promise<void> {
  try {
    const marker = takeCompanyReauthMarker(userId);
    if (marker !== null) {
      if (!(await authorityIsBaV1(queryClient, userId))) return;
      const selection: ScopeSelection = {
        tenantId: marker.tenantId,
        workspaceId: marker.workspaceId,
      };
      try {
        const validated = await validateWorkspaceScopeSelection(selection);
        await switchWorkspaceScope(
          queryClient,
          userId,
          readCurrentSelection(queryClient, userId),
          selection,
          {
            authority: "ba-v1",
            // The answer just received — one validation, never two for one landing.
            validate: () => Promise.resolve(validated),
          },
        );
      } catch (error) {
        // The proof did not cover the landing: a different account at the provider, a policy
        // that changed mid-flight. The old scope never resumes; the wall says what happened.
        if (isProofRefusal(error)) {
          pauseCompanyForReauth(queryClient, userId, selection, true);
        }
      }
      return;
    }

    const candidate =
      readCurrentSelection(queryClient, userId) ?? readStoredSelection(userId);
    if (candidate === null) return;
    if (!(await authorityIsBaV1(queryClient, userId))) return;
    try {
      await validateWorkspaceScopeSelection(candidate);
    } catch (error) {
      if (isProofRefusal(error)) {
        pauseCompanyForReauth(queryClient, userId, candidate, false);
      }
    }
  } catch {
    /* Not the gate's failure to show. */
  }
}

// ---------------------------------------------------------------------------
// The hand-off — the challenge's return path, and the marker that survives it
// ---------------------------------------------------------------------------

/**
 * The site-local shape the server enforces on the returnPath, mirrored here so the client never
 * offers what the challenge route would refuse: one leading slash, no protocol-relative form,
 * no backslashes, no control characters, and none of their encoded disguises.
 */
function isSiteLocalReturnPath(path: string): boolean {
  const hasControlCharacter = (value: string): boolean => {
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  };
  const isShapedLocal = (value: string): boolean =>
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !hasControlCharacter(value);
  let candidate = path;
  for (let round = 0; round < 3; round += 1) {
    if (!isShapedLocal(candidate)) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      break;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return isShapedLocal(candidate);
}

/**
 * Where the company's extra sign-in sends the person back to: this page, this query, exactly as
 * the caller's own location holds it — the router's, which in the browser is the location. Never
 * a URL parameter, never a server echo: a foreign-looking value inside a query rides as inert
 * data within a same-origin path.
 */
export function companyReauthReturnPath(path: string): string | null {
  return isSiteLocalReturnPath(path) ? path : null;
}

/**
 * The hand-off itself: record the marker, then leave for the provider's page. The marker is the
 * only state that survives the journey — the challenge binds to this session on the server, and
 * the browser's next landing starts over from it.
 */
export function startCompanyReauthRoundTrip(
  userId: string,
  selection: ScopeSelection,
  returnPath: string,
  redirectUrl: string,
): void {
  window.sessionStorage.setItem(
    markerKey(userId),
    JSON.stringify({
      tenantId: selection.tenantId,
      workspaceId: selection.workspaceId,
      returnPath,
    }),
  );
  window.location.assign(redirectUrl);
}
