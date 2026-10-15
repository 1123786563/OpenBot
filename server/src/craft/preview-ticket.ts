/**
 * The preview-ticket auth primitive (#360, spec D4/D9 — craft-preview-origin).
 *
 * A cross-host preview origin never sees the platform session cookie (F2/D1),
 * so the main-site cookie exchanges for a SHORT-LIVED, SINGLE-USE ticket that
 * the preview origin redeems for the issuing userId. This module is that
 * primitive and nothing past it: the host routing that decides which origin a
 * request lands on (#361) and origin admission (#362) are separate tickets.
 *
 * Storage is an in-memory TTL table — a ticket lives at most 30 seconds (D9),
 * which is far below any restart tolerance a short-lived object like this
 * needs; no persistent schema. The clock is injectable so expiry tests advance
 * time instead of sleeping.
 *
 * The ticket root is never the authority: redemption re-checks the session
 * against the store (ownership without the idle-clock bump), so a session
 * deleted or reassigned after issue refuses to redeem even while the entry is
 * still inside its TTL window.
 */

import { randomBytes } from "node:crypto";
import type { CraftStore } from "./store";

/** D9, locked: 30 seconds, single use. No idle invalidation exists by design. */
export const PREVIEW_TICKET_TTL_MS = 30_000;

/** Every refusal a redemption can answer. None ever echoes the ticket value. */
export type PreviewTicketRefusal =
  | "unknown" // no such ticket, or already consumed
  | "expired" // past the 30s window
  | "mismatch" // the (sessionId, previewHost) the caller presented is not the bound triple
  | "session"; // the session row is gone or no longer the issuer's

export type PreviewTickets = {
  /** Mint a ticket bound to (userId, sessionId, previewHost). */
  issuePreviewTicket(input: {
    sessionId: string;
    userId: string;
    previewHost: string;
  }): { ticket: string; expiresAt: Date };
  /** Consume a ticket: the take is atomic, one attempt per ticket. */
  redeemPreviewTicket(input: {
    ticket: string;
    sessionId: string;
    previewHost: string;
  }): Promise<{ userId: string } | { reason: PreviewTicketRefusal }>;
  /** Live entries — the sweep test's observable. */
  size(): number;
};

type TicketEntry = {
  userId: string;
  sessionId: string;
  previewHost: string;
  expiresAt: number;
};

export function createPreviewTickets(deps: {
  /** Ownership WITHOUT the activity bump — redemption must not feed the idle clock. */
  store: Pick<CraftStore, "findSession">;
  now?: () => Date;
}): PreviewTickets {
  const now = deps.now ?? (() => new Date());
  const entries = new Map<string, TicketEntry>();

  const sweep = () => {
    const at = now().getTime();
    for (const [ticket, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(ticket);
    }
  };

  return {
    issuePreviewTicket({ sessionId, userId, previewHost }) {
      sweep(); // keep the TTL table flat under churn
      const ticket = randomBytes(32).toString("base64url");
      entries.set(ticket, {
        userId,
        sessionId,
        previewHost,
        expiresAt: now().getTime() + PREVIEW_TICKET_TTL_MS,
      });
      return { ticket, expiresAt: new Date(now().getTime() + PREVIEW_TICKET_TTL_MS) };
    },

    async redeemPreviewTicket({ ticket, sessionId, previewHost }) {
      // Consume on sight, before any check: a ticket is one attempt, not one
      // success — probing with a wrong triple must burn it exactly like a
      // failed login burns nothing reusable.
      const entry = entries.get(ticket);
      if (!entry) return { reason: "unknown" };
      entries.delete(ticket);

      if (now().getTime() >= entry.expiresAt) return { reason: "expired" };
      if (entry.sessionId !== sessionId || entry.previewHost !== previewHost) {
        return { reason: "mismatch" };
      }
      // The root alone is not authority: the session must still exist and
      // still belong to the issuing user (deletion / reassignment refusal).
      const session = await deps.store.findSession(
        entry.sessionId,
        entry.userId,
      );
      if (!session) return { reason: "session" };
      return { userId: entry.userId };
    },

    size() {
      return entries.size;
    },
  };
}

// ── the preview-domain cookie (D9) ────────────────────────────────────────────
//
// Redeeming plants the preview origin's OWN session credential — HttpOnly,
// Path=/, SameSite=Lax, and deliberately WITHOUT Max-Age/Expires: their absence
// is what makes it a session cookie the browser drops at close (D9). The
// cookie's value-to-user validation belongs to the preview-origin routing
// (#361); this header is the shape that routing must not get wrong.

export const PREVIEW_SESSION_COOKIE = "openbot_preview_session";

export function previewSessionCookieHeader(value: string): string {
  return `${PREVIEW_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * D5's dev default: the preview origin is `127.0.0.1` on the API's own port —
 * a different HOST from a `localhost` login (cookie isolation holds) without
 * wildcard DNS. Production's named preview host arrives with #362; until then
 * the port follows the server's own PORT/SERVER_PORT convention.
 */
export function defaultPreviewOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const port = Number.parseInt(env.PORT ?? "", 10) ||
    Number.parseInt(env.SERVER_PORT ?? "", 10) || 3001;
  return `http://127.0.0.1:${port}`;
}
