/**
 * The preview origin's host routing and admission (#361, spec craft-preview-origin
 * D5/D7, AC6/AC9), and — since #362 — the entry that serves the preview's own
 * traffic on those hosts.
 *
 * A preview must live on a different HOST from the main site (F2/D1) — cookies do
 * not isolate by port. Two shapes carry that:
 * - dev (D5, the config default): the shared host `127.0.0.1:<server port>` beside
 *   a `localhost` login, no wildcard DNS; the session rides the leading PATH label.
 * - production (D3/D7): per-session subdomains `<hash-label>.<preview base>` from
 *   the configured template, the app at the origin's root.
 *
 * The hostname label is HMAC(secret, sessionId) truncated — stable for a session's
 * whole life (AC6: the address never drifts), keyed so it cannot be derived or
 * enumerated for other sessions (AC9), one lowercase-hex DNS label. Derivation is
 * ONE-WAY: id → label is a function, label → id is not, so reverse routing needs a
 * real index — this module's in-memory label→sessionId registry is that NECESSARY
 * object, not a cache of anything derivation knows (derivation knows nothing in
 * this direction; #361's comment claiming a column "would only cache what
 * derivation already knows" was wrong, and is corrected here — the honest trade
 * is in-memory index vs. a store column, and #362 accepts the in-memory one).
 *
 * M-2, accepted and documented (docs/craft-preview-origin.md): the registry is
 * in-memory, so a server restart forgets every label. An already-open preview tab
 * then reloads into 404 "Unknown preview host" and stays refused until the person
 * re-enters through the main site (the webapp-info poll or a fresh ticket — both
 * call originFor, which re-mints the address and re-registers the label).
 * Registration happens at originFor, which is also how the registry repopulates
 * after a restart — every entry into a preview passes through the main site first
 * (D4), and that hop re-mints the address.
 *
 * Admission is the gate in front of all of it: craft off, webapp proxy off,
 * preview origin off, a malformed template, or PORT/SERVER_PORT that do not name
 * one number each close the origin with a DISPLAYABLE reason — 503 on every
 * preview host, and originFor throws so no address exists to route around the
 * gate. The same-origin form is never a fallback (AC6). The webapp-info half of
 * the reason surface lands with #362's webapp-info rework; the text lives here.
 *
 * What this module serves: the entry that closes #360's D9 loop — a ticket minted
 * on the main site redeems here and plants the preview domain's own session
 * credential (HttpOnly, Path=/, SameSite=Lax, deliberately session-level — no
 * Max-Age, no Expires) — and, since #362, every further request on a preview host:
 * gated on that cookie (the preview pass, naming THIS host's session) and handed
 * to the injected servePreview seam, which proxies to the session's sandbox dev
 * server with the app-relative path (dev: the leading label stripped; host form:
 * the pathname verbatim). HMR upgrades on preview hosts are #363's.
 */

import { createHmac } from "node:crypto";
import type { CraftConfig } from "./config";
import {
  PREVIEW_SESSION_COOKIE,
  previewPortFromEnv,
  previewSessionCookieHeader,
  type PreviewTickets,
} from "./preview-ticket";
import { refuseResponse } from "./webapp-proxy";

/** The gate's answer: open, or closed with the sentence a person can read. */
export type PreviewOriginAdmission = { ok: true } | { ok: false; reason: string };

/** Host header → session id: `{ sessionId }`, or the refusal the dispatcher answers. */
export type PreviewRequestResolution =
  | { sessionId: string }
  | { refuse: { status: 404 | 503; reason: string } };

export type PreviewOrigin = {
  /** The gate + its displayable closed reason (the 503 body; webapp-info's #362 field). */
  admission(): PreviewOriginAdmission;
  /** The session's absolute preview address; registers its label. Throws when closed. */
  originFor(sessionId: string): string;
  /** Whether the request's host belongs to the preview namespace at all — the
   * dispatcher's branch gate: claimed hosts NEVER fall through to main routes. */
  handlesRequest(request: Request): boolean;
  /** Host header → session id: the ONLY entry (#361's produced contract). */
  resolvePreviewRequest(request: Request): PreviewRequestResolution;
  /** The preview origin entry: ticket redemption → D9 cookie → clean 302, and
   * (#362) every further request on the preview host, cookie-gated then proxied. */
  handlePreviewRequest(sessionId: string, request: Request): Promise<Response>;
};

/**
 * How a cookie-authenticated request on the preview origin reaches the session's
 * app (#362): the routing module hands over the session, the raw request, and the
 * APP-RELATIVE path — the dev form's leading label already stripped, the host
 * form's pathname verbatim (the app lives at the origin's root there) — so the
 * serving side never needs to know how a preview address is spelled. Production
 * wires webapp-proxy's `createPreviewProxy` here.
 */
export type ServePreview = (input: {
  sessionId: string;
  request: Request;
  appPath: string;
  query: string;
}) => Promise<Response>;

/** 20 hex chars of HMAC-SHA256 — 80 bits: unguessable, unenumerable, DNS-label safe. */
const LABEL_HEX_CHARS = 20;
const DEV_PREVIEW_HOSTNAME = "127.0.0.1";

function previewLabel(secret: string, sessionId: string): string {
  return createHmac("sha256", secret)
    .update(sessionId)
    .digest("hex")
    .slice(0, LABEL_HEX_CHARS);
}

/**
 * The dev form's port, through the ONE parser (preview-ticket's
 * `previewPortFromEnv`, converged on server/src/config.ts serverPort's rules by
 * #362): PORT and SERVER_PORT name one number, empty means absent, and a value
 * that is not a whole port is refused rather than quietly parsed to its prefix.
 * Where serverPort throws at boot, a closed craft feature refuses with this
 * sentence instead — a preview misconfiguration must not take the server down.
 */
function previewDevPort(
  env: Record<string, string | undefined>,
): { port?: number; invalid?: string } {
  const parsed = previewPortFromEnv(env);
  return "reason" in parsed ? { invalid: parsed.reason } : { port: parsed.port };
}

/** The parsed template: the wildcard-host form, the derived dev form, or the refusal. */
type ParsedTemplate =
  | { kind: "host"; scheme: string; suffix: string; baseHostname: string }
  | { kind: "dev" }
  | { kind: "invalid"; reason: string };

/**
 * Fold a hostname's fully-qualified trailing dot: WHATWG URL keeps it for
 * non-IPv4 hosts (`x.preview.example.com.` IS `x.preview.example.com` to DNS
 * and to certificates), so every host-side comparison must normalize first or
 * the dotted form escapes the suffix match — straight into the main-site routes
 * (#361 Pi 终审 M-1, absorbed by #362).
 */
function normalizeHostname(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function parseTemplate(raw: string): ParsedTemplate {
  const value = raw.trim();
  if (value === "") return { kind: "dev" };
  const usage =
    "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE must be an http(s) URL with {session} exactly once as the hostname's leading label, e.g. https://{session}.preview.example.com.";
  // The address a template mints is what certificates and DNS must answer for,
  // so the shape is strict on purpose (#359 review F2, absorbed by #362): no
  // userinfo, no trailing-dot FQDN, no IDN (the certificate pipeline sees the
  // ASCII form only), no underscore labels, and a whole-number port when present.
  // Each refusal names the variable so the operator can find it.
  const refuse = (why: string): ParsedTemplate => ({
    kind: "invalid",
    reason: `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE ${why}`,
  });
  if (/[\u0080-\uffff]/.test(value)) {
    return refuse("must be pure ASCII (IDN hostnames are not supported).");
  }
  if (value.split("{session}").length !== 2 || !value.includes("{session}.")) {
    return refuse(usage);
  }
  let probe: URL;
  try {
    probe = new URL(value.replace("{session}", "probe"));
  } catch {
    return refuse(usage);
  }
  if (probe.protocol !== "http:" && probe.protocol !== "https:") {
    return refuse(usage);
  }
  if (probe.username !== "" || probe.password !== "") {
    return refuse("must not carry userinfo (user:pass@host).");
  }
  if (probe.hostname.endsWith(".")) {
    return refuse("must not end its hostname with a trailing dot.");
  }
  if (probe.hostname.includes("_")) {
    return refuse("must not contain underscores (they are not DNS label characters).");
  }
  // The wildcard form serves the app at the origin's root (D3) — a template that
  // carries a path or query would smuggle the basePath footgun back in.
  if (probe.pathname !== "/" || probe.search !== "" || probe.hash !== "") {
    return refuse(usage);
  }
  const suffix = probe.host.slice("probe".length); // ".preview.example.com[:port]"
  const baseHostname = probe.hostname.slice("probe".length); // ".preview.example.com"
  if (baseHostname === "") return refuse(usage);
  return { kind: "host", scheme: probe.protocol, suffix, baseHostname: baseHostname.slice(1) };
}

export function createPreviewOrigin(deps: {
  config: Pick<
    CraftConfig,
    | "enabled"
    | "webappProxyEnabled"
    | "previewOriginEnabled"
    | "previewOriginTemplate"
  >;
  /**
   * The process's ONE ticket table — the same instance the issuing route mints
   * through (#360's review constraint: never a second instance).
   */
  previewTickets: PreviewTickets;
  /**
   * The HMAC key behind the hostname labels. The boot file passes the
   * deployment's key-encryption key: an existing per-deployment secret, and HMAC
   * with it discloses nothing about the key.
   */
  secret: string;
  /** PORT/SERVER_PORT for the dev form's port; injectable so tests pin it. */
  env?: Record<string, string | undefined>;
  /**
   * #362: serves an authenticated request on a preview host by proxying to the
   * session's sandbox dev server (attach model: probe, never spawn). Injected by
   * the boot file from webapp-proxy's createPreviewProxy; tests stub the seam.
   */
  servePreview: ServePreview;
}): PreviewOrigin {
  const env = deps.env ?? process.env;
  const template = parseTemplate(deps.config.previewOriginTemplate);
  const devPort = previewDevPort(env);
  // ponytail: in-memory label→sessionId index; move to a shared store only if a
  // multi-replica deployment needs one origin answer across replicas.
  const registry = new Map<string, string>();

  const admission = (): PreviewOriginAdmission => {
    if (!deps.config.enabled) {
      return { ok: false, reason: "Craft is disabled on this deployment." };
    }
    if (!deps.config.webappProxyEnabled) {
      return {
        ok: false,
        reason: "The craft web-app preview is disabled on this deployment.",
      };
    }
    if (!deps.config.previewOriginEnabled) {
      return {
        ok: false,
        reason:
          "The preview origin is disabled on this deployment (OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED is false).",
      };
    }
    if (template.kind === "invalid") return { ok: false, reason: template.reason };
    if (template.kind === "dev" && devPort.invalid) {
      return { ok: false, reason: `The preview origin is disabled: ${devPort.invalid}` };
    }
    return { ok: true };
  };

  return {
    admission,

    originFor(sessionId) {
      const gate = admission();
      if (!gate.ok) {
        // No address may exist while the origin is closed — an unreachable host
        // is the honest answer, not a same-origin fallback (AC6).
        throw new Error(`The preview origin is closed: ${gate.reason}`);
      }
      const label = previewLabel(deps.secret, sessionId);
      registry.set(label, sessionId);
      if (template.kind === "host") {
        return `${template.scheme}//${label}${template.suffix}`;
      }
      // Admission open + dev form ⇒ the port parsed to exactly one number;
      // the unreachable alternative is refused above, this narrows the type.
      const port = devPort.port;
      if (port === undefined) {
        throw new Error(`The preview origin is closed: ${devPort.invalid}`);
      }
      return `http://${DEV_PREVIEW_HOSTNAME}:${port}/${label}`;
    },

    handlesRequest(request) {
      const hostname = normalizeHostname(new URL(request.url).hostname);
      if (template.kind === "host") {
        // The base and everything under it stay in the preview namespace —
        // fail closed inside the deployment's declared wildcard host. The
        // comparison runs on the DOT-FOLDED hostname: the trailing-dot FQDN
        // form is the same host to DNS and must never fall to main routes.
        return (
          hostname === template.baseHostname ||
          hostname.endsWith(`.${template.baseHostname}`)
        );
      }
      if (template.kind === "dev") {
        // The dev host is claimed by hostname; the port, when derivable, must be
        // the server's own (an underivable port leaves admission closed anyway).
        return (
          hostname === DEV_PREVIEW_HOSTNAME &&
          (devPort.port === undefined ||
            new URL(request.url).port === String(devPort.port))
        );
      }
      // A malformed template claims nothing — but admission is closed with the
      // reason, and originFor throws, so no address ever pointed here.
      return false;
    },

    resolvePreviewRequest(request) {
      const gate = admission();
      if (!gate.ok) return { refuse: { status: 503, reason: gate.reason } };
      const url = new URL(request.url);
      // Dot-folded like handlesRequest: the dotted and undotted forms of one
      // host must resolve to the same session, never to different branches.
      const hostname = normalizeHostname(url.hostname);
      const label =
        template.kind === "host"
          ? hostname === template.baseHostname
            ? null // the apex: a preview host with no session label on it
            : hostname.endsWith(`.${template.baseHostname}`)
              ? hostname.slice(0, -(template.baseHostname.length + 1))
              : null
          : url.pathname.split("/")[1] ?? null; // dev: the leading path label
      const sessionId = label === null ? undefined : registry.get(label);
      if (sessionId === undefined) {
        // Unknown hostnames die here (AC on the Host↔session mapping): the
        // dispatcher only calls in for claimed hosts, so this 404 is the end of
        // the road — main-site routes are never a fallback target.
        return {
          refuse: { status: 404, reason: "Unknown preview host." },
        };
      }
      return { sessionId };
    },

    async handlePreviewRequest(sessionId, request) {
      const gate = admission();
      if (!gate.ok) {
        return Response.json({ error: gate.reason }, { status: 503 });
      }
      const url = new URL(request.url);
      const ticket = url.searchParams.get("ticket");
      if (ticket !== null) {
        // The presented host must be the one the ticket was bound to (the triple's
        // host element) — url.host is what the issuing side bound via originFor.
        const redeemed = await deps.previewTickets.redeemPreviewTicket({
          ticket,
          sessionId,
          previewHost: url.host,
        });
        if ("reason" in redeemed) {
          // Never the ticket value, never a reason that echoes it (#360's rule).
          return Response.json(
            { error: "The preview ticket is invalid, expired, or already used." },
            { status: 401 },
          );
        }
        // ponytail: the cookie carries the session id itself — HttpOnly on the
        // preview origin, and the proxy never forwards cookies to the app; mint an
        // opaque token + index instead only if a consumer needs rotation.
        return new Response(null, {
          status: 302,
          headers: {
            // The clean path: the ticket dies with this hop, never in the URL (D4).
            location: url.pathname,
            "set-cookie": previewSessionCookieHeader(sessionId),
            "cache-control": "no-store",
          },
        });
      }

      // ── #362: the preview's own traffic — cookie-gated proxying ─────────────
      //
      // Everything after the redemption hop rides the preview domain's session
      // cookie (D9). The gate is exact: the cookie must be present AND name THIS
      // host's session, so a pass minted for session A never opens session B's
      // host, and a main-site cookie jar (never carried across hosts — F2) opens
      // nothing. The refusal is the iframe-facing dual shape, and like every
      // refusal on this surface it echoes neither cookie nor ticket values.
      const pass = previewSessionCookieValue(request.headers.get("cookie"));
      if (pass === null || pass !== sessionId) {
        return refuseResponse(
          request,
          "Open this preview from its craft session — its preview pass is missing or no longer valid.",
          401,
        );
      }
      // The app-relative path: the dev form rides a leading path label the app
      // itself never sees (#364 removes the basePath that used to mirror it), so
      // the first segment goes; the host form's app lives at the origin's root
      // (D3) and the pathname passes verbatim.
      const appPath =
        template.kind === "dev"
          ? url.pathname.replace(/^\/[^/]+/, "") || "/"
          : url.pathname;
      return deps.servePreview({ sessionId, request, appPath, query: url.search });
    },
  };
}

/**
 * The preview pass out of a Cookie header, or null when the jar holds none.
 * Cookie values are opaque here — parsed, never decoded, never logged.
 */
function previewSessionCookieValue(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${PREVIEW_SESSION_COOKIE}=`)) {
      return trimmed.slice(PREVIEW_SESSION_COOKIE.length + 1);
    }
  }
  return null;
}
