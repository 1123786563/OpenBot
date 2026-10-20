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
// fix-ocr19 #11 retired the hand-synced default-port constant by importing
// config.ts's DEFAULT_PORT; fix-ocr23 #8 goes one step further — the ENTIRE
// PORT/SERVER_PORT parser (whose rules the default port rides inside) is now
// imported, so the dev preview's port judgment is config.ts's own answer and
// the two can no longer drift, not even in how they read the environment.
import { portFromEnvironment } from "../config";
// #358 repair (Task 1): the value whitelist accepts the SIGNED pass shape as
// one definition imported from its codec — the header side and the verify side
// can never drift apart on what a pass looks like.
import { PREVIEW_PASS_COOKIE_SHAPE } from "./preview-pass";
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
//
// ENGINE SET (fix-ocr16, recorded — behavior unchanged): the
// Secure-on-http judgment above is per-engine, and the dev form's
// availability rides it. Chromium and Firefox treat the loopback
// (127.0.0.1, localhost) as a trustworthy origin and DO store a Secure
// cookie planted there — the dev form works on those engines. WebKit/Safari
// rejects a Secure cookie on ANY plain-http origin — loopback included — so
// the dev form cannot plant the pass there and the preview is unavailable
// on Safari/WebKit (the known limitation reference/craft-preview-origin.md
// records; the acceptance evidence chain is Chromium). Production's https
// preview hosts are unaffected: every engine stores Secure cookies on
// https. There is no attribute combination that satisfies both engines
// (`None` requiring `Secure` is Chromium semantics; the
// trustworthy-loopback exception is Chromium behavior), which is why this
// is recorded rather than "fixed". This comment documents the constraint
// only — the refusal copy on the wire is unchanged.

export const PREVIEW_SESSION_COOKIE = "openbot_preview_session";

export function previewSessionCookieHeader(value: string, path = "/"): string {
  // fix-ocr22 #3: the path lands in a Set-Cookie ATTRIBUTE position, so it is
  // whitelisted at this export API's own boundary, never trusted: `/` or one
  // /<label> of `0-9a-zA-Z._~-`, at most 64 chars — anything else (an
  // injection shape like `/x; Path=/evil` above all) folds to the root scope
  // and can never be interpolated into the attribute position. The dev
  // form's real caller shape is 20 lowercase hex (the preview label); the
  // whitelist is deliberately a little wider so a future caller cannot grow
  // an injection here.
  const safePath = /^\/[0-9a-zA-Z._~-]{0,64}$/.test(path) ? path : "/";
  // fix-ocr23 #6: the value sits in the NAME=VALUE position of the same header
  // — the dual of the path guard above, not its neighbor: a `;`, `,`, or
  // control byte in the value can rewrite cookie attributes exactly the way a
  // hostile path can. This export's stated contract is that a caller cannot
  // grow an injection here — so the value gets a boundary whitelist and a
  // mismatch folds it to EMPTY rather than guessing a repair. Fail-safe by
  // construction: an empty pass verifies to nothing, so the preview gate
  // refuses with 401 forever — a folded value can never open anything.
  //
  // #358 repair (Task 1): two legitimate caller shapes, both charset-safe
  // (neither carries `;` `,` or a control byte, so neither can rewrite an
  // attribute): the registry-internal sessionId (`[A-Za-z0-9_-]`, bounded at
  // 128 — the pre-repair transitional caller, gone once redemption mints
  // passes) and the SIGNED pass (`v1.<user>.<mac>`, PREVIEW_PASS_COOKIE_SHAPE
  // — the codec's own definition, bounded at 512: `v1.` + a ≤256-byte userId's
  // base64url + `.` + the 43-char MAC). The whitelist is an INJECTION guard,
  // not the auth decision — whether a carried value opens anything is the
  // codec's signature check alone, and the old plaintext session-id cookie is
  // rejected THERE (verify), never waved through here.
  const safeValue =
    (/^[A-Za-z0-9_-]{1,128}$/.test(value) ||
      (PREVIEW_PASS_COOKIE_SHAPE.test(value) && value.length <= 512))
      ? value
      : "";
  // fix-ocr24 #6, why the fold is SILENT: the fold itself is the rejection
  // signal — an empty pass can never equal any session id, so the preview
  // gate answers 401 on every request and the failure is visible at exactly
  // the seam that matters — while this module's own contract (the header:
  // a ticket is a bearer credential, nothing here logs) forbids the log
  // line a drift-shaped warn would want. Observability lives at the gate,
  // not beside the credential.
  return `${PREVIEW_SESSION_COOKIE}=${safeValue}; Path=${safePath}; HttpOnly; SameSite=None; Secure`;
}

/**
 * The dev preview origin's port, parsed by config.ts's ONE port parser
 * (`portFromEnvironment`, imported — fix-ocr23 #8): PORT and SERVER_PORT name
 * one number, an empty value is absent rather than zero, a value that is not a
 * whole port refuses with its sentence (never a truncated parse — "30o1" must
 * not become 30), and two set values that disagree refuse together rather than
 * one silently winning. Before the shared parser this was a hand-synced twin
 * of config.ts's serverPort, aligned only by this comment's claim — the same
 * shape fix-ocr19 #11 retired for DEFAULT_PORT; now the rules literally cannot
 * drift. Where serverPort throws the reason at boot, a closed preview feature
 * refuses with the sentence instead — a preview misconfiguration must not take
 * the server down.
 */
export function previewPortFromEnv(
  env: Record<string, string | undefined> = process.env,
): { port: number } | { reason: string } {
  return portFromEnvironment(env);
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
  if ("reason" in parsed) return { reason: parsed.reason };
  // fix-ocr27 #6: the SAME spelling rule originFor mints by (preview-origin.ts
  // portSuffix): http's scheme-default port is dropped by WHATWG URL
  // serialization, so a listener on :80 is addressed without the suffix —
  // this twin used to spell `:80` unconditionally, the last hand-synced
  // spelling left in the file (the parser itself was converged in
  // fix-ocr23 #8). One rule, both spellings.
  const portSuffix = parsed.port === 80 ? "" : `:${parsed.port}`;
  return { origin: `http://127.0.0.1${portSuffix}` };
}
