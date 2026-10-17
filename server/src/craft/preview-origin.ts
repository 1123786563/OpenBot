/**
 * The preview origin's host routing and admission (#361, spec craft-preview-origin
 * D5/D7, AC6/AC9).
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
 * enumerated for other sessions (AC9), one lowercase-hex DNS label. Reversal runs
 * through an in-memory label→sessionId index rather than a craft_sessions column:
 * the label is a pure function of the secret and the id, so a column would only
 * cache what derivation already knows, while the index keeps the schema and its
 * migrations out of a routing concern. The index registers when an address is
 * minted (originFor), which is also how it repopulates after a restart — every
 * entry into a preview passes through the main site first (D4), and that hop
 * re-mints the address.
 *
 * Admission is the gate in front of all of it: craft off, webapp proxy off,
 * preview origin off, a malformed template, or PORT/SERVER_PORT that do not name
 * one number each close the origin with a DISPLAYABLE reason — 503 on every
 * preview host, and originFor throws so no address exists to route around the
 * gate. The same-origin form is never a fallback (AC6). The webapp-info half of
 * the reason surface lands with #362's webapp-info rework; the text lives here.
 *
 * What this module serves TODAY is the entry that closes #360's D9 loop: a ticket
 * minted on the main site redeems here and plants the preview domain's own
 * session credential (HttpOnly, Path=/, SameSite=Lax, deliberately session-level —
 * no Max-Age, no Expires). Proxying the preview's traffic on these hosts is #362's;
 * HMR upgrades are #363's.
 */

import { createHmac } from "node:crypto";
import type { CraftConfig } from "./config";
import { previewSessionCookieHeader, type PreviewTickets } from "./preview-ticket";

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
  /** The preview origin entry: ticket redemption → D9 cookie → clean 302. */
  handlePreviewRequest(sessionId: string, request: Request): Promise<Response>;
};

/** 20 hex chars of HMAC-SHA256 — 80 bits: unguessable, unenumerable, DNS-label safe. */
const LABEL_HEX_CHARS = 20;
const DEV_PREVIEW_HOSTNAME = "127.0.0.1";
const DEV_FALLBACK_PORT = 3001;

function previewLabel(secret: string, sessionId: string): string {
  return createHmac("sha256", secret)
    .update(sessionId)
    .digest("hex")
    .slice(0, LABEL_HEX_CHARS);
}

/**
 * The dev form's port, parsed with serverPort's rules (server/src/config.ts):
 * PORT and SERVER_PORT name one number, empty means absent, and a value that is
 * not a whole port is refused rather than quietly parsed to its prefix. Where
 * serverPort throws at boot, a closed craft feature refuses with this sentence
 * instead — a preview misconfiguration must not take the server down.
 */
function previewDevPort(
  env: Record<string, string | undefined>,
): { port?: number; invalid?: string } {
  const read = (name: string): { port?: number; invalid?: string } => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return {};
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      return { invalid: `${name} must be a whole number between 1 and 65535.` };
    }
    return { port: value };
  };
  const port = read("PORT");
  if (port.invalid) return port;
  const serverPort = read("SERVER_PORT");
  if (serverPort.invalid) return serverPort;
  if (port.port !== undefined && serverPort.port !== undefined && port.port !== serverPort.port) {
    return {
      invalid: `PORT (${port.port}) and SERVER_PORT (${serverPort.port}) disagree: set one or set both to the same value.`,
    };
  }
  return { port: port.port ?? serverPort.port ?? DEV_FALLBACK_PORT };
}

/** The dev form's host, shaped the way URL serialization writes it: http's
 * default port 80 is never explicit, so minted addresses and url.host
 * comparisons agree on it (port 80 → no ":80", any other port → ":port"). */
function devHost(port: number): string {
  return port === 80 ? DEV_PREVIEW_HOSTNAME : `${DEV_PREVIEW_HOSTNAME}:${port}`;
}

/** The parsed template: the wildcard-host form, the derived dev form, or the refusal. */
type ParsedTemplate =
  | { kind: "host"; scheme: string; suffix: string; baseHostname: string }
  | { kind: "dev" }
  | { kind: "invalid"; reason: string };

function parseTemplate(raw: string): ParsedTemplate {
  const value = raw.trim();
  if (value === "") return { kind: "dev" };
  const usage =
    "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE must be an http(s) URL with {session} exactly once as the hostname's leading label, e.g. https://{session}.preview.example.com.";
  if (value.split("{session}").length !== 2 || !value.includes("{session}.")) {
    return { kind: "invalid" as const, reason: usage };
  }
  let probe: URL;
  try {
    probe = new URL(value.replace("{session}", "probe"));
  } catch {
    return { kind: "invalid" as const, reason: usage };
  }
  if (probe.protocol !== "http:" && probe.protocol !== "https:") {
    return { kind: "invalid" as const, reason: usage };
  }
  // {session} must be the hostname's LEADING label, checked on the RAW template
  // right after the scheme's `//` — not on the replaced probe URL, where a
  // `probe.` hostname prefix is spoofable: `https://probe.{session}.example.com`
  // probes to probe.probe.example.com (passes) and mints undeclared
  // *.probe.example.com hosts, while userinfo like `https://user@{session}.…`
  // never enters the hostname and degrades the base to the apex. A mid-host or
  // trailing {session} would derive garbage and mint addresses the wildcard
  // never answers — requests to them would fall back onto the main site with
  // its cookies (AC6: never same-origin).
  if (!/^https?:\/\/\{session\}\./i.test(value)) {
    return { kind: "invalid" as const, reason: usage };
  }
  // The wildcard form serves the app at the origin's root (D3) — a template that
  // carries a path or query would smuggle the basePath footgun back in.
  if (probe.pathname !== "/" || probe.search !== "" || probe.hash !== "") {
    return { kind: "invalid" as const, reason: usage };
  }
  const suffix = probe.host.slice("probe".length); // ".preview.example.com[:port]"
  // The base the wildcard answers on — empty for a degenerate template like
  // `https://{session}./`: that would mint dead `https://<label>.` addresses and,
  // with baseHostname "", claim every trailing-dot FQDN host into the preview
  // branch (endsWith(".")). Closed here instead — fail closed (AC6).
  const baseHostname = probe.hostname.slice("probe.".length); // "preview.example.com"
  if (baseHostname === "") return { kind: "invalid" as const, reason: usage };
  return { kind: "host", scheme: probe.protocol, suffix, baseHostname };
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
      return `http://${devHost(devPort.port ?? DEV_FALLBACK_PORT)}/${label}`;
    },

    handlesRequest(request) {
      const url = new URL(request.url);
      const hostname = url.hostname;
      if (template.kind === "host") {
        // The base and everything under it stay in the preview namespace —
        // fail closed inside the deployment's declared wildcard host.
        return (
          hostname === template.baseHostname ||
          hostname.endsWith(`.${template.baseHostname}`)
        );
      }
      if (template.kind === "dev") {
        // The dev host is claimed by hostname; the port, when derivable, must
        // be the server's own (an underivable port leaves admission closed
        // anyway). The whole url.host is compared, not .port — WHATWG
        // serialization drops http's default :80, so a String(port) comparison
        // would never match a server genuinely listening on port 80.
        return (
          hostname === DEV_PREVIEW_HOSTNAME &&
          (devPort.port === undefined || url.host === devHost(devPort.port))
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
      const label =
        template.kind === "host"
          ? url.hostname === template.baseHostname
            ? null // the apex: a preview host with no session label on it
            : url.hostname.endsWith(`.${template.baseHostname}`)
              ? url.hostname.slice(0, -(template.baseHostname.length + 1))
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
      if (ticket === null) {
        // The redemption entry is this ticket's surface; serving the preview's
        // traffic on these hosts is #362's. Refused with the surface's shape.
        return Response.json(
          { error: "The preview is not being served yet." },
          { status: 503 },
        );
      }
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
      // A pathname leading with "//" is not a path — sent raw, Location would
      // be protocol-relative and carry this hop off-host (an open redirect);
      // the preview's own root answers instead.
      const location = url.pathname.startsWith("//") ? "/" : url.pathname;
      return new Response(null, {
        status: 302,
        headers: {
          // The clean path: the ticket dies with this hop, never in the URL (D4).
          location,
          "set-cookie": previewSessionCookieHeader(sessionId),
          "cache-control": "no-store",
        },
      });
    },
  };
}
