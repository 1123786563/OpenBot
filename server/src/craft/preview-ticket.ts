/**
 * The preview-ticket auth primitive (#360, spec craft-preview-origin D4/D9).
 *
 * A cross-host preview origin never sees the platform session cookie (F2/D1),
 * so the main-site cookie exchanges for a SHORT-LIVED, SINGLE-USE ticket that
 * the preview origin redeems for the issuing userId. This module is that
 * primitive and nothing past it: the host routing that lands a request on the
 * preview origin (#361) and origin admission (#362) are separate tickets.
 *
 * Storage is an in-memory TTL table — a ticket lives at most 30 seconds (D9),
 * far below any restart tolerance a short-lived object needs; no persistent
 * schema. The clock is injectable so expiry tests advance time instead of
 * sleeping.
 *
 * The ticket root is never the authority: redemption re-checks the session
 * against the store (the bump-free findSession — this read must not feed the
 * idle clock), so a session deleted or reassigned after issue refuses to
 * redeem even while the entry is still inside its TTL window.
 *
 * Nothing here logs. A ticket is a bearer credential with a 30-second life;
 * the only shape it may appear in is the issue response — never a log field,
 * never an error body.
 */

import { randomBytes } from "node:crypto";
import type { CraftStore } from "./store";

/** D9, locked: 30 seconds, single use. No idle invalidation exists by design. */
export const PREVIEW_TICKET_TTL_MS = 30_000;

/** Every refusal a redemption can answer. None ever echoes the ticket value. */
export type PreviewTicketRefusal =
  | "unknown" // no such ticket, or already consumed
  | "expired" // past the 30s window
  | "mismatch" // the (sessionId, previewHost) presented is not the bound triple
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
  /** Live entries — the sweep's observable (test-only, no callers in prod). */
  size(): number;
};

type TicketEntry = {
  userId: string;
  sessionId: string;
  previewHost: string;
  expiresAt: number;
};

export function createPreviewTickets(deps: {
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
      const expiresAt = now().getTime() + PREVIEW_TICKET_TTL_MS;
      entries.set(ticket, { userId, sessionId, previewHost, expiresAt });
      return { ticket, expiresAt: new Date(expiresAt) };
    },

    async redeemPreviewTicket({ ticket, sessionId, previewHost }) {
      // Consume on sight, before any check: a ticket is one ATTEMPT, not one
      // success — probing with a wrong triple burns it exactly like a failed
      // login burns nothing reusable.
      const entry = entries.get(ticket);
      if (!entry) return { reason: "unknown" };
      entries.delete(ticket);

      if (now().getTime() >= entry.expiresAt) return { reason: "expired" };
      if (entry.sessionId !== sessionId || entry.previewHost !== previewHost) {
        return { reason: "mismatch" };
      }
      // The root alone is not authority: the session must still exist and
      // still belong to the issuing user (deletion / reassignment refusal).
      const session = await deps.store.findSession(entry.sessionId, entry.userId);
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
// path-scoped (R-9), and deliberately WITHOUT Max-Age/Expires: their absence is
// what makes it a session cookie the browser drops at close (D9). The routing
// that sets this header is #361's; this is the shape it must not get wrong.
//
// The Path is the caller's call (R-9, OCR round 2): the HOST form serves one
// session per host, so "/" is right there; but the DEV form (D5, the default)
// hosts EVERY session on one shared host — 127.0.0.1:<port> — where a Path=/
// pass is a single cookie-jar slot under Set-Cookie replace semantics (same
// name + domain + path): the LAST redeemer overwrites every earlier preview's
// pass, and the first-in iframe's traffic and HMR upgrade then sit at 401
// forever (preview-tab never re-redeems inside an entry's lifetime). The dev
// form therefore plants the pass at its session's own /<label> — concurrent
// dev previews coexist in the jar, and the browser only sends the pass whose
// Path matches the address, which is exactly the label the request's own host
// resolution derived anyway.
//
// SameSite=None; Secure, not Lax (#365's F-1): the panel embeds the preview
// origin in an iframe that is CROSS-SITE from the main site — dev is
// `localhost` (main) → `127.0.0.1` (preview), different sites — and a browser
// refuses to store a Lax cookie planted by that cross-site redemption 302, so
// the panel iframe sat at 401. None is the only attribute that crosses that
// hop, and browsers honor None only when Secure rides with it. Secure holds in
// both shapes we ship: dev's `127.0.0.1` is a trustworthy (secure-context)
// origin where Chrome accepts Secure cookies, and production's named preview
// host serves HTTPS. Production's preview domain is a subdomain of the main
// site (same-site, first-party iframe) — Lax worked there and None works too,
// so None is a strict widening for dev, never a regression. The cookie's
// semantics are unchanged: session-level, HttpOnly, Path=the caller's scope
// ("/" for the host form, "/<label>" for the dev form — D9, R-9).

export const PREVIEW_SESSION_COOKIE = "openbot_preview_session";

export function previewSessionCookieHeader(value: string, path = "/"): string {
  return `${PREVIEW_SESSION_COOKIE}=${value}; Path=${path}; HttpOnly; SameSite=None; Secure`;
}

/**
 * The dev preview origin's port, parsed with config.ts serverPort's exact rules
 * (the #362 convergence of #360 review Nit 3/4): PORT and SERVER_PORT name one
 * number, an empty value is absent rather than zero, a value that is not a whole
 * port refuses with its sentence (never a truncated parse — "30o1" must not
 * become 30), and two set values that disagree refuse together rather than one
 * silently winning. Where serverPort throws at boot, a closed preview feature
 * refuses with the sentence instead — a preview misconfiguration must not take
 * the server down.
 */
export function previewPortFromEnv(
  env: Record<string, string | undefined> = process.env,
): { port: number } | { reason: string } {
  const read = (name: string): { port?: number; reason?: string } => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return {};
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      return { reason: `${name} must be a whole number between 1 and 65535.` };
    }
    return { port: value };
  };
  const port = read("PORT");
  if (port.reason) return { reason: port.reason };
  const serverPort = read("SERVER_PORT");
  if (serverPort.reason) return { reason: serverPort.reason };
  if (
    port.port !== undefined &&
    serverPort.port !== undefined &&
    port.port !== serverPort.port
  ) {
    return {
      reason: `PORT (${port.port}) and SERVER_PORT (${serverPort.port}) disagree: set one or set both to the same value.`,
    };
  }
  return { port: port.port ?? serverPort.port ?? 3001 };
}

/**
 * D5's dev default: the preview origin is `127.0.0.1` on the API's own port —
 * a different HOST from a `localhost` login (cookie isolation holds) without
 * wildcard DNS. Production's named preview host arrives with #362. The port is
 * `previewPortFromEnv`'s (serverPort's rules — one number or a refusal with a
 * displayable reason; #360's silent PORT preference is converged away).
 */
export function defaultPreviewOrigin(
  env: Record<string, string | undefined> = process.env,
): { origin: string } | { reason: string } {
  const parsed = previewPortFromEnv(env);
  return "reason" in parsed
    ? { reason: parsed.reason }
    : { origin: `http://127.0.0.1:${parsed.port}` };
}
