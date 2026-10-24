/**
 * The preview origin's host routing and admission (#361, spec craft-preview-origin
 * D5/D7, AC6/AC9), and — since #362 — the entry that serves the preview's own
 * traffic on those hosts.
 *
 * A preview must live on a different HOST from the main site (F2/D1) — cookies do
 * not isolate by port. Two shapes carry that:
 * - dev (D5, the config default): the shared host `127.0.0.1:<server port>` beside
 *   a `localhost` login, no wildcard DNS; the session rides the leading PATH label.
 *   The dev CLAIM is hostname + that leading label segment being REGISTERED —
 *   fix-ocr3: the install form (app/serve.ts) forwards every /api call to
 *   `http://127.0.0.1:<server port>/…` on this very host, so unregistered first
 *   segments must fall back to the main-site routes, never be claimed.
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
 * preview origin off, a malformed template, a template base that claims the main
 * site's own host (#404), or PORT/SERVER_PORT that do not name one number each
 * close the origin with a DISPLAYABLE reason — 503 on every preview host, and
 * originFor throws so no address exists to route around the
 * gate. The same-origin form is never a fallback (AC6). The webapp-info half of
 * the reason surface lands with #362's webapp-info rework; the text lives here.
 *
 * What this module serves: the entry that closes #360's D9 loop — a ticket minted
 * on the main site redeems here and plants the preview domain's own session
 * credential (HttpOnly, Path=/ for the host form — Path=/<label> for the shared
 * dev host, R-9 — SameSite=None; Secure — the panel's iframe is
 * cross-site (#365 F-1) — deliberately session-level — no
 * Max-Age, no Expires) — and, since #362, every further request on a preview host:
 * gated on that cookie (the preview pass, naming THIS host's session) and handed
 * to the injected servePreview seam, which proxies to the session's sandbox dev
 * server with the upstream-resolvable path (the pathname verbatim in both
 * forms — the dev form's label included, since #365 mounts the dev server at
 * /<label> via injected env). HMR upgrades on preview hosts are #363's.
 */

import { createHmac } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import type { CraftConfig } from "./config";
import { createPreviewPassCodec, type PreviewPassCodec } from "./preview-pass";
import {
  PREVIEW_SESSION_COOKIE,
  type PreviewTickets,
  previewPortFromEnv,
  previewSessionCookieHeader,
} from "./preview-ticket";
import {
  createTlsStatusGate,
  DEFAULT_TLS_STATUS_FILE,
  type TlsStatusVerdict,
} from "./preview-tls-status";
import { refuseResponse } from "./refusal";

/** The gate's answer: open, or closed with the sentence a person can read. */
export type PreviewOriginAdmission =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * #418 Option B — the deployment-level observability shape of the registry:
 * a COUNT, never an enumeration. The registry is per-process state (the
 * single-replica contract), so "0 registered labels on this instance while
 * previews are active elsewhere" is exactly the wrong-instance signature a
 * multi-replica deployment with no sticky routing produces — health checks
 * and log collectors can read this number and tell that shape apart from a
 * bare 404. Discloses no session ids and no labels (AC9).
 */
export type PreviewRegistryStats = { registeredLabels: number };

/**
 * #418 Option B — the single line the boot log prints about the preview
 * origin's replica contract. The preview origin is ENABLED but its
 * label→session registry (and the ticket table) live in THIS process, so a
 * deployment that scales past one replica must front the replicas with
 * sticky routing or the preview traffic lands on an instance whose registry
 * never saw the label — a 404 "Unknown preview host." with no signal to
 * tell it from a restart (M-2). The notice states the contract at startup;
 * when OPENBOT_REDIS_URL is set (the deployment's own multi-replica signal —
 * the same variable the workshop layer reads) it escalates to warn, because
 * Redis configured but no sticky routing is precisely the half-migrated
 * shape that produces silent cross-instance 404s. Disabled origins stay
 * silent: a closed origin has no preview hosts to route wrong.
 */
export function singleReplicaStartupNotice(deps: {
  previewOriginEnabled: boolean;
  /** The raw OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE — only its host/dev shape is named. */
  template: string;
  /** The deployment's multi-replica signal; unset = single-replica. */
  redisUrl?: string | undefined;
  /** The same stats method the origin instance exposes — one derivation. */
  registryStats: () => PreviewRegistryStats;
}): void {
  if (!deps.previewOriginEnabled) return;
  const log = getLogger("server");
  const stats = deps.registryStats();
  const template = deps.template.trim();
  const form = template === "" ? "dev" : "host";
  if (deps.redisUrl?.trim()) {
    log.warn(
      {
        contract: "single-replica",
        multiReplicaSignal: true,
        form,
        ...stats,
      },
      "single-replica contract: the preview origin's label registry and ticket table are in-process, but OPENBOT_REDIS_URL is set (a multi-replica deployment signal) — route preview traffic with sticky routing or previews will 404 'Unknown preview host.' on the instances that never saw the label",
    );
    return;
  }
  log.info(
    { contract: "single-replica", multiReplicaSignal: false, form, ...stats },
    "single-replica contract: the preview origin's label registry and ticket table are in-process — multi-replica deployments require sticky routing or a shared store (none configured)",
  );
}

/** Host header → session id: `{ sessionId }`, or the refusal the dispatcher answers. */
export type PreviewRequestResolution =
  | { sessionId: string }
  | { refuse: { status: 404 | 503; reason: string } };

/**
 * The refusal sentence both preview-origin gates answer — the HTTP cookie gate
 * below and (#363) the HMR upgrade resolver in webapp-proxy — exported so the
 * two surfaces can never drift apart on the words a person reads.
 */
export const PREVIEW_PASS_REFUSAL =
  "Open this preview from its craft session — its preview pass is missing or no longer valid.";

/**
 * #358 repair: the ONE pass judgment both preview surfaces apply — the HTTP
 * cookie gate in handlePreviewRequest and (#363) the HMR upgrade resolver in
 * webapp-proxy. The pre-repair judgment (holdsPreviewSessionPass) compared the
 * cookie VALUE against the sessionId, so a request that knew both the preview
 * address and the session id forged the credential without redeeming a ticket
 * (the AC4 bypass). Now the cookie must be a pass this deployment SIGNED for
 * (sessionId → userId) at ticket redemption: the codec's constant-time MAC
 * check is the acceptance, and the verified userId rides out as the claim the
 * store re-checks the owner with.
 *
 * The judgment iterates every same-named candidate (§5.4 wire order,
 * previewSessionCookieValues below) and passes when ANY one verifies — a
 * deeper-path shadow planted ahead of the pass on the wire cannot mask it
 * (fix-ocr20 #3); a jar where no candidate verifies refuses. There is no
 * compatibility branch: the old plaintext session-id cookie is just a value
 * no key ever signed, and verifies to null. A platform session is never
 * consulted: on these hosts it does not exist (F2/D1).
 */
function verifyPassWith(
  codec: PreviewPassCodec,
  sessionId: string,
  request: Request,
): { userId: string } | null {
  for (const candidate of previewSessionCookieValues(
    request.headers.get("cookie"),
  )) {
    const verified = codec.verify(sessionId, candidate);
    if (verified !== null) return verified;
  }
  return null;
}

/**
 * fix-ocr28 #1 (round28 CSWSH): the preview websocket upgrade's Origin gate,
 * exported beside the pass judgment (verifyPassWith — the origin's verifyPass
 * method; #358 repair retired the value-equality sibling) so the two manual
 * disciplines the upgrade half applies — pass judgment and origin judgment —
 * live in one place. A WebSocket handshake is NOT subject to CORS, and the
 * preview pass cookie is SameSite=None: without this check, any page on the
 * web could `new WebSocket("wss://<preview-host>/_next/webpack-hmr")` and the
 * pass would ride the cross-site handshake, handing the attacker the live HMR
 * channel (reading source frames, injecting protocol messages).
 *
 * The comparison normalizes BOTH sides through a shared origin form —
 * never a bare string equality — because originFor answers the session's
 * ADDRESS, and in the dev form that address carries the `/<label>` path an
 * Origin header never spells (a bare comparison would refuse every
 * legitimate dev-form browser upgrade). Normalization also makes the
 * equality independent of default-port spelling on either side (originFor
 * drops :80 by its portSuffix rule, fix-ocr27 #6; WHATWG serialization and
 * the browser's Origin header drop scheme defaults the same way) and of the
 * trailing-dot FQDN spelling: a page loaded from the dotted host serializes
 * an Origin header THAT KEEPS THE DOT (WHATWG, fix-ocr14), while originFor
 * mints from the template — which refuses a trailing dot — so the strict
 * `new URL(x).origin` comparison 403ed a legitimate page's upgrade; both
 * sides now dot-fold through the SAME normalizeHostname every host-side
 * comparison in this module runs (fix-ocr29 #1). An absent Origin (a
 * non-browser client) is waved through — the gate exists for pages, and WS
 * clients that send no Origin cannot be a browser's document. An opaque
 * origin ("null", from a sandboxed frame) or any unparseable value
 * parse-fails into a refusal, never a throw.
 */
export function samePreviewOrigin(
  originHeader: string | null,
  sessionAddress: string,
): boolean {
  if (originHeader === null) return true;
  // Both sides through the ONE comparable form (normalizedOriginOf): dot-folded
  // host, port only when present, path ignored — so a dev-form address's `/<label>`
  // never enters the comparison. An unparseable value on either side is a refusal,
  // never a throw.
  const presented = normalizedOriginOf(originHeader);
  const own = normalizedOriginOf(sessionAddress);
  return presented !== null && own !== null && presented === own;
}

export type PreviewOrigin = {
  /** The gate + its displayable closed reason (the 503 body; webapp-info's #362 field). */
  admission(): PreviewOriginAdmission;
  /** The session's absolute preview address; registers its label. Throws when closed. */
  originFor(sessionId: string): string;
  /**
   * Whether the session's label currently sits in the origin registry — the
   * registry half of the pane's same-origin liveness probe (fix-ocr13; the
   * admission half is the caller's injected gate). Registration happens at
   * originFor, so false here means "never entered, or the registry was wiped
   * by a restart" (M-2) — exactly the verdict the pane re-enters from.
   */
  hasSession(sessionId: string): boolean;
  /**
   * #418 Option B — the registry's deployment-level observability surface: a
   * COUNT of registered labels (never the labels/session ids themselves,
   * AC9). The boot log's single-replica notice reads the same number, so a
   * health check correlating "active previews exist but registeredLabels=0
   * on this instance" has found the wrong-instance/multi-replica shape —
   * the alternative to shipping a shared store was making the contract
   * visible, and this is the visible half.
   */
  registryStats(): PreviewRegistryStats;
  /** Whether the request belongs to the preview namespace at all — the
   * dispatcher's branch gate: claimed requests NEVER fall through to main
   * routes. The host form claims the whole wildcard base (fail-closed); the
   * dev form claims hostname + a REGISTERED label in the path's leading
   * segment, so the install form's /api traffic on the same host stays main. */
  handlesRequest(request: Request): boolean;
  /** Host header → session id: the ONLY entry (#361's produced contract). */
  resolvePreviewRequest(request: Request): PreviewRequestResolution;
  /**
   * #410 — whether an ORIGIN-HEADER value sits in the preview namespace, judged
   * by the same `claimsPreviewHost` the dispatcher's `handlesRequest` runs (one
   * claim, two surfaces: the Host header of a request to a preview host, and the
   * Origin header of a request that came from a preview PAGE). This is what lets
   * the main site's cookie-authenticated write surface refuse a credentialed
   * cross-site fetch that SameSite cannot stop — a production preview is a
   * subdomain of the main site, so it is SAME SITE and its cookies ride along.
   *
   * The dev form (empty template) answers false for everything, and that is the
   * honest limit, not an oversight: its address is
   * `http://127.0.0.1:<server port>/<label>` — the session rides a PATH label,
   * and an Origin header never spells a path. The dev-form preview's origin is
   * therefore indistinguishable from the main site's own origin on this host,
   * and refusing it would refuse the main site's own writes (the fix-ocr3
   * paralysis family). Host isolation is a production-form property (D1/D3/D7);
   * the dev form's protection stays the preview pass + CSP (D5).
   *
   * Unparseable values answer false — the caller's own untrusted/unparseable
   * branch decides what to do with them; nothing here throws.
   */
  claimsOrigin(origin: string | null): boolean;
  /**
   * The upstream-resolvable path a request addresses (#363, F-2/#365): the
   * pathname VERBATIM in both forms — the dev form's label included, because
   * the session's dev server is basePath-mounted at /<label> (the start
   * script's injected env, webappBasePathFor below) and the host form's app
   * lives at the origin's root — the one derivation the HTTP entry and the
   * HMR upgrade dispatcher share, so a socket and a fetch for the same
   * resource always name the same upstream path.
   */
  appPathFor(request: Request): string;
  /**
   * The basePath the session's dev server must mount for the preview's URL
   * shape (F-2, #365): the dev form's address rides a PATH label
   * (`http://127.0.0.1:<port>/<label>`), so the app's own URLs must carry it —
   * `/<label>` here, the same HMAC derivation originFor mints, is what the
   * start script injects as ONYX_WEBAPP_BASE_PATH/NEXT_PUBLIC_BASE_PATH. The
   * host form serves at the origin's root and a closed origin has no address
   * whose shape could be mirrored (AC6) — null in both, and the app stays
   * root-path (the production behavior #364 shipped, unchanged).
   */
  webappBasePathFor(sessionId: string): string | null;
  /** The preview origin entry: ticket redemption → D9 cookie → clean 302, and
   * (#362) every further request on the preview host, cookie-gated then proxied. */
  handlePreviewRequest(sessionId: string, request: Request): Promise<Response>;
  /**
   * #358 repair: THE pass judgment — the exact verify this origin's HTTP gate
   * runs, exported as a method so the HMR upgrade resolver receives the same
   * function (injected as its deps.verifyPass) and the two surfaces cannot
   * drift: one codec, one cookie iteration, one acceptance.
   */
  verifyPass(sessionId: string, request: Request): { userId: string } | null;
  /**
   * #427 AC7 — the single-token revocation seam: retire ONE pass token so that
   * exact cookie 401s on every later HTTP and HMR request, while the session
   * itself and the holder's other tokens stay open (a re-mint opens again).
   * Server-side callers hold no deployment secret, so the origin re-exposes its
   * codec's revoke under this name — the call surface a session-deletion or
   * forced-sign-out hook would drive; no production caller is wired by this
   * ticket (tests pin the semantics). False when the token is unknown or bound
   * to a different session — never a throw.
   */
  revokePass(sessionId: string, token: string): boolean;
};

/**
 * How a cookie-authenticated request on the preview origin reaches the session's
 * app (#362): the routing module hands over the session, the raw request, and
 * the upstream-resolvable path — the pathname VERBATIM in both forms (the dev
 * form's label included: the app is basePath-mounted at /<label> there, F-2/
 * #365; the host form's app lives at the origin's root) — so the serving side
 * never needs to know how a preview address is spelled. Production wires
 * webapp-proxy's `createPreviewProxy` here.
 */
export type ServePreview = (input: {
  sessionId: string;
  request: Request;
  /** The userId the verified pass carries — the ownership re-check's input. */
  userId: string;
  appPath: string;
  query: string;
}) => Promise<Response>;

/** 20 hex chars of HMAC-SHA256 — 80 bits: unguessable, unenumerable, DNS-label safe. */
const LABEL_HEX_CHARS = 20;
const DEV_PREVIEW_HOSTNAME = "127.0.0.1";
/** The purpose label this module's MAC use of the deployment secret derives under. */
const LABEL_KEY_PURPOSE = "craft-preview-label";

/**
 * The MAC key for hostname labels, derived from the deployment secret under a
 * purpose label — the library's signed-value convention
 * (server/src/auth/signed-value.ts's signingKey/sealingKey): one secret to
 * configure, per-use material, so a label here can never be confused with —
 * or computed as — any other use of the secret (a signature or a credential
 * ciphertext there). fix-ocr3 medium: this was the library's one bare-KEK MAC.
 *
 * UPGRADE CONSEQUENCE (fix-ocr28 #7, recorded beside M-2's restart note so
 * upgrade day is not misread as a new fault): the derivation has changed
 * once already — bare KEK → this purpose-derived key — and any future
 * re-derivation flips every label again with the deployment secret
 * UNCHANGED: labels are a function of (derivation, secret, sessionId), so
 * new code + old secret = new labels. In the dev form a RUNNING dev server
 * still mounts its OLD label basePath (the start script injected the env at
 * spawn), and its `.webapp-mount` record names the old mount — the
 * re-minted label matches neither, so webapp-info answers
 * WEBAPP_MOUNT_STALE and withholds the address until the session's start
 * script is rewritten (the reconcile light path: re-entering the session
 * re-provisions it) and the web app restarted. One-time, self-healing per
 * session — the same shape as an M-2 restart, not an outage.
 */
function previewLabelKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(LABEL_KEY_PURPOSE).digest();
}

function previewLabel(secret: string, sessionId: string): string {
  return createHmac("sha256", previewLabelKey(secret))
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
function previewDevPort(env: Record<string, string | undefined>): {
  port?: number;
  invalid?: string;
} {
  const parsed = previewPortFromEnv(env);
  return "reason" in parsed
    ? { invalid: parsed.reason }
    : { port: parsed.port };
}

/** The parsed template: the wildcard-host form, the derived dev form, or the refusal. */
type ParsedTemplate =
  | {
      kind: "host";
      scheme: string;
      suffix: string;
      baseHostname: string;
      /**
       * fix-ocr22 #2: set ONLY when the base is exactly `localhost` (the
       * fix-ocr5 D local testing form) — the template's own port, or the
       * scheme default when the template carries none. The localhost claim is
       * port-narrowed to this (handlesRequest); every other base claims the
       * whole wildcard host at any port, unchanged.
       */
      localhostPort?: number;
    }
  | { kind: "dev" }
  | { kind: "invalid"; reason: string };

/**
 * Fold a hostname's trailing dots — ALL of them (fix-ocr16): WHATWG URL keeps
 * the fully-qualified trailing dot for non-IPv4 hosts (`x.preview.example.com.`
 * IS `x.preview.example.com` to DNS and to certificates), and a multi-dot form
 * (`x.preview.example.com..`) is the same host again — the old slice(0,-1)
 * folded one dot and left the second, so the dotted form walked out of the
 * suffix match and into the main-site routes. Every host-side comparison must
 * normalize; dotted forms never leak to the main site.
 */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

/**
 * The ONE comparable form of an origin: `scheme://host[:port]`, host dot-folded,
 * the port carried only when present (WHATWG serialization already dropped the
 * scheme default, and originFor mints its address by the same rule — fix-ocr27
 * #6). Path, query and hash are IGNORED: an Origin header never spells one, and
 * the dev-form address is `http://127.0.0.1:<port>/<label>` — comparing whole
 * URLs would refuse every legitimate dev-form upgrade.
 *
 * Null is the refusal: an unparseable value, an opaque origin ("null" — a
 * sandboxed frame), or anything without a hostname (`javascript:` and friends
 * parse but address no host). Callers judge null their own way; nothing throws.
 */
export function normalizedOriginOf(value: string): string | null {
  const url = parseOriginUrl(value);
  if (url === null) return null;
  const host = normalizeHostname(url.hostname);
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/** A parseable origin (scheme + host) or null — the ONE parse every origin comparison runs. */
function parseOriginUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return normalizeHostname(url.hostname) === "" ? null : url;
  } catch {
    return null;
  }
}

/**
 * The port a host comparison must run on. URL serialization drops http(s)'s
 * DEFAULT port — `http://127.0.0.1/x` carries `url.port === ""` — so an empty
 * port reads as the scheme default rather than as "no port", or a :80 listener's
 * preview traffic falls through to the main-site routes (#363, #361 final
 * review).
 */
function effectivePortOf(url: URL): number {
  // fix-ocr19 #10: plain branches over the nested ternary (review-367 L3's
  // direction) — same value, readable at a glance.
  if (url.port === "") return url.protocol === "https:" ? 443 : 80;
  return Number(url.port);
}

/**
 * Whether a dot-folded hostname + effective port sits in the preview namespace.
 * The ONE host-side claim, run by `handlesRequest` (the dispatcher's branch gate,
 * judged on the request URL), by #404's admission check (judged on the main
 * site's OWN host), and by `claimsOrigin` (#410, judged on an Origin header) —
 * the surfaces must never disagree about what "a preview host" is, or the guard
 * would close on a host nothing swallows while leaving open the one that takes
 * the main site down.
 */
function claimsPreviewHost(
  template: Extract<ParsedTemplate, { kind: "host" }>,
  hostname: string,
  effectivePort: number,
): boolean {
  if (template.localhostPort !== undefined) {
    // fix-ocr22 #2: the localhost exemption (fix-ocr5 D) cannot carry the
    // wildcard claim's "whole hostname, any port" shape — `localhost` IS the
    // local main site's own hostname, so claiming it swallowed the main site
    // into "Unknown preview host." 404s (the fix-ocr3 critical family,
    // host-form twin). Two narrowings, localhost bases only: the bare apex is
    // never claimed (its traffic falls back to the main-site routes — the
    // fix-ocr3 lesson), and a claim needs the template's OWN port —
    // `<label>.localhost:3001` rides the declared form, any other port on that
    // host is somebody else's listener.
    if (hostname === template.baseHostname) return false;
    if (!hostname.endsWith(`.${template.baseHostname}`)) return false;
    return effectivePort === template.localhostPort;
  }
  // The base and everything under it stay in the preview namespace — fail closed
  // inside the deployment's declared wildcard host. The comparison runs on the
  // DOT-FOLDED hostname: the trailing-dot FQDN form is the same host to DNS and
  // must never fall to main routes.
  return (
    hostname === template.baseHostname ||
    hostname.endsWith(`.${template.baseHostname}`)
  );
}

/**
 * #404: the main site's own host, read through the SAME parser the template uses
 * (dot-folded, port-resolved). A value that names no host — empty, or text the
 * URL parser throws on — answers null and the guard judges nothing: it exists to
 * refuse a PROVEN outage, never to close a deployment it cannot read, and a
 * single-origin deployment sets no appUrl at all. A schemeless value is still a
 * host an operator actually writes (`TRUSTED_ORIGINS=app.example.com`), so it
 * reads as the https default instead of slipping past the check unarmed.
 */
function mainSiteHostOf(
  appUrl: string | undefined,
): { hostname: string; port: number } | null {
  const value = appUrl?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "") return null;
  return { hostname, port: effectivePortOf(url) };
}

/**
 * #408 (AC6): whether the deployment's appUrl names a host a browser reaches
 * over the network — the production context an empty template cannot serve.
 * Unset, unparsable, or loopback (localhost, 127.0.0.0/8, [::1]) answers
 * false: those are the local dev forms the 127.0.0.1 preview was built for,
 * where the dev form's address IS reachable. Read through the same parser
 * mainSiteHostOf uses, so the two appUrl consumers cannot disagree about what
 * a deployment "is".
 */
function isNonLoopbackAppUrl(appUrl: string | undefined): boolean {
  const mainSite = mainSiteHostOf(appUrl);
  if (mainSite === null) return false;
  const host = mainSite.hostname.toLowerCase();
  return !(
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/**
 * #410: the Origin-header side of `claimsPreviewHost`. The dev form answers
 * false for everything — its address carries the session in a PATH label and an
 * Origin header never spells a path, so a dev-form preview is
 * indistinguishable from this host's own main-site origin (the honest limit,
 * documented on `PreviewOrigin.claimsOrigin`). An unparseable value is not a
 * claim either: the caller's own untrusted branch refuses it.
 */
function claimsPreviewOrigin(
  template: ParsedTemplate,
  origin: string | null,
): boolean {
  if (template.kind !== "host" || origin === null) return false;
  const url = parseOriginUrl(origin);
  if (url === null) return false;
  return claimsPreviewHost(
    template,
    normalizeHostname(url.hostname),
    effectivePortOf(url),
  );
}

function parseTemplate(raw: string): ParsedTemplate {
  const value = raw.trim();
  if (value === "") return { kind: "dev" };
  const usage =
    "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE must be an https URL with {session} exactly once as the hostname's leading label, e.g. https://{session}.preview.example.com.";
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
  // {session} must be the hostname's LEADING label, anchored on the RAW trimmed
  // template right after the scheme's `//` (#361 checkpoint 96b8a2b8, restored
  // after #362's rewrite dropped it) — not judged on the replaced probe URL,
  // where the shape is spoofable: `https://probe.{session}.example.com` probes
  // to probe.probe.example.com (passes) and mints undeclared *.probe.example.com
  // hosts, while a trailing `{session}.x@host` never enters the hostname and
  // would degrade the base to the apex. A mid-host or trailing {session} would
  // derive garbage the wildcard never answers (AC6: never same-origin).
  if (
    value.split("{session}").length !== 2 ||
    !/^https?:\/\/\{session\}\./i.test(value)
  ) {
    return refuse(usage);
  }
  // fix-ocr27 #1: an IPv4-literal base is refused BY NAME, judged on the RAW
  // template text. `https://{session}.127.0.0.1:3001` — the dev address
  // misfilled into the template, a natural misconfiguration — has a
  // dot-bearing base, so the multi-label check below alone would pass it,
  // and its claim would be the loopback APEX (no localhost port narrowing,
  // the apex claimed too): every `http://127.0.0.1:<any port>/…` request —
  // the install form's own /api forwarding included — would 404 "Unknown
  // preview host." (the fix-ocr3 critical family, host-form side). WHATWG's
  // URL parser happens to refuse these hosts itself (ends-in-a-number →
  // IPv4 attempt → failure), so the probe below never constructs and the
  // misconfiguration would otherwise die in the catch with the generic
  // usage sentence — naming nothing the operator actually misconfigured.
  // The judgment runs on the raw text (the anchored `{session}.` prefix
  // stripped, an optional trailing port removed) because the URL that would
  // carry the base is exactly the one no parser will build. The dev-form
  // preview on the loopback is the EMPTY template, never this spelling.
  const rawBase = value
    .replace(/^https?:\/\/\{session\}\./i, "")
    .replace(/:[0-9]*$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rawBase)) {
    return refuse(
      "must not use an IPv4-literal base (e.g. {session}.127.0.0.1) — it would claim the loopback host itself and take the main site's traffic down with it; use a hostname base, or leave the template empty for the dev form.",
    );
  }
  let probe: URL;
  try {
    probe = new URL(value.replace("{session}", "probe"));
  } catch {
    return refuse(usage);
  }
  // fix-ocr4 #9: the host form must be https, fail-closed. The preview pass
  // cookie is hardcoded SameSite=None; Secure — a browser refuses a Secure
  // cookie on a non-trustworthy (http) origin, and an http cross-site iframe
  // cannot carry a None cookie either, so an http template could never accept
  // its own pass: the 401 death loop the F-1 fix exists to prevent, replayed
  // under a misconfiguration. The dev form (127.0.0.1, a trustworthy origin
  // where the cookie demonstrably plants) is the EMPTY template and is not
  // affected by this check.
  if (probe.protocol !== "https:") {
    return refuse(
      "must be https — the preview cookie is SameSite=None; Secure, which browsers refuse on a plain-http origin.",
    );
  }
  // fix-ocr26 #9: port 0 has no serving meaning, and the certificate sidecar's
  // derive_preview_host already refuses it (its port floor is `-lt 1`, the
  // fix-ocr4 #5 fail-closed category) — a :0 template accepted here made the
  // sidecar crash-loop against a template the server served. Consistent with
  // :70000 (fix-ocr18 #8) and the bare `:` (fix-ocr4 #5): neither face serves
  // what the other refuses. WHATWG normalizes :00/:000 to "0", so the numeric
  // read catches every zero spelling.
  if (probe.port !== "" && Number(probe.port) < 1) {
    return refuse(
      "must not use port 0 — it has no serving meaning, and the certificate sidecar refuses it too.",
    );
  }
  if (probe.username !== "" || probe.password !== "") {
    return refuse("must not carry userinfo (user:pass@host).");
  }
  if (probe.hostname.endsWith(".")) {
    return refuse("must not end its hostname with a trailing dot.");
  }
  if (probe.hostname.includes("_")) {
    return refuse(
      "must not contain underscores (they are not DNS label characters).",
    );
  }
  // #415: a wildcard `*` parses into a WHATWG hostname (it is not a
  // forbidden domain code point), so the probe alone never catches it — but
  // `<label>.*.example.com` is a host no DNS zone spells, and the sidecar's
  // derive_preview_host refuses the same template (its base charset never
  // admits `*`), which is the fix-ocr18 #9 crash-loop divergence class in
  // the serving direction. Neither face serves it.
  if (probe.hostname.includes("*")) {
    return refuse(
      "must not contain a wildcard `*` label (e.g. {session}.*.example.com) — it is not a DNS name, and the certificate sidecar refuses it too.",
    );
  }
  // The wildcard form serves the app at the origin's root (D3) — a template that
  // carries a path or query would smuggle the basePath footgun back in.
  if (probe.pathname !== "/" || probe.search !== "" || probe.hash !== "") {
    return refuse(usage);
  }
  const suffix = probe.host.slice("probe".length); // ".preview.example.com[:port]"
  const baseHostname = probe.hostname.slice("probe".length); // ".preview.example.com"
  if (baseHostname === "") return refuse(usage);
  // fix-ocr5 D: the base (everything after `{session}.`) must be a multi-label
  // domain (≥1 dot) or exactly `localhost` (the local testing form —
  // `https://{session}.localhost:3001` must keep working). A single-label
  // base like `https://{session}.com` is a missing-base misconfiguration,
  // not a deployment: every host on earth ends with `.com`, so handlesRequest's
  // suffix match would claim the ENTIRE public-suffix space and the dispatcher
  // would 404 the whole site — the host-form twin of the install-form
  // paralysis fix-ocr3 closed. (The sidecar's derive_preview_host stays laxer
  // here — a recorded lockstep deviation, harmless: LE refuses to issue for a
  // bare public suffix anyway, and a cert the server never addresses is
  // waste, not an outage.)
  const base = probe.hostname.slice("probe".length + 1);
  // fix-ocr27 #2: an empty label anywhere in the base is refused — the same
  // region as the IPv4 check above, the two shapes the dot-counting check
  // alone lets through. `{session}..localhost` / `{session}.preview..example.com`
  // PARSE (WHATWG keeps empty interior labels), pass the multi-label check,
  // and mint a degenerate wildcard nothing routes: the minted host
  // `<label>..localhost` matches neither handlesRequest's apex equality nor
  // its suffix rule, and for the `..localhost` spelling the base hostname
  // is not `localhost`, so the fix-ocr22 #2 port narrowing never applies —
  // an admission-open answer whose addresses 404 everywhere.
  if (base.split(".").some((label) => label === "")) {
    return refuse(
      "must not contain empty labels (e.g. {session}..localhost) — the degenerate wildcard would claim hosts no certificate derivation answers for.",
    );
  }
  if (base !== "localhost" && !base.includes(".")) {
    return refuse(
      "must sit under a multi-label base hostname (e.g. preview.example.com) or exactly localhost — a single-label base like {session}.com would claim an entire public suffix.",
    );
  }
  return {
    kind: "host",
    scheme: probe.protocol,
    suffix,
    baseHostname: baseHostname.slice(1),
    // fix-ocr22 #2: the localhost exemption's claim port. `https://{session}.localhost:3001`
    // narrows its claim to :3001; a portless `https://{session}.localhost`
    // claims only the scheme default (443 — the template is https-only, so
    // WHATWG's serialization presents no port and the effective port is 443).
    ...(base === "localhost"
      ? { localhostPort: probe.port === "" ? 443 : Number(probe.port) }
      : {}),
  };
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
   * deployment's key-encryption key: an existing per-deployment secret, and
   * HMAC with it discloses nothing about the key. The label MAC key is derived
   * from it under the purpose label "craft-preview-label" (the signed-value
   * convention — never the bare KEK; fix-ocr3 medium).
   */
  secret: string;
  /** PORT/SERVER_PORT for the dev form's port; injectable so tests pin it. */
  env?: Record<string, string | undefined>;
  /**
   * #404 (AC6/M-1): the deployment's own main-site address — the boot file
   * injects `config.appUrl`. A wildcard base claims that host AND everything
   * under it, so `https://{session}.example.com` with the app on
   * `app.example.com` (or on the `example.com` apex) swallows the main site into
   * 404 "Unknown preview host." with no route ever reached. Unset, or a value
   * naming no host, judges nothing (mainSiteHostOf).
   */
  appUrl?: string;
  /**
   * #362: serves an authenticated request on a preview host by proxying to the
   * session's sandbox dev server (attach model: probe, never spawn). Injected by
   * the boot file from webapp-proxy's createPreviewProxy; tests stub the seam.
   */
  servePreview: ServePreview;
  /**
   * #411: the TLS renewal-status gate the HOST form's admission consults.
   * Injectable so tests drive the five health bands without a sidecar;
   * production derives it from OPENBOT_TLS_STATUS_FILE (default
   * /etc/openbot/tls/renewal-status.json, the main compose's read-only mount).
   */
  tlsStatusGate?: { verdict(): TlsStatusVerdict };
}): PreviewOrigin {
  const env = deps.env ?? process.env;
  const template = parseTemplate(deps.config.previewOriginTemplate);
  const tlsStatusGate =
    deps.tlsStatusGate ??
    createTlsStatusGate({
      statusFile:
        env.OPENBOT_TLS_STATUS_FILE?.trim() || DEFAULT_TLS_STATUS_FILE,
    });
  const devPort = previewDevPort(env);
  // #358 repair: the pass codec derives from the SAME deployment secret the
  // hostname labels use, under its own purpose label ("craft-preview-pass") —
  // domain-separated by construction, so a label can never verify as a pass
  // and vice versa. One instance here; the HMR resolver receives this
  // origin's verifyPass method (the boot file injects it), so HTTP and HMR
  // share ONE acceptance function.
  const previewPass = createPreviewPassCodec(deps.secret);
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
    if (template.kind === "invalid")
      return { ok: false, reason: template.reason };
    // #404 (AC6/M-1): a base that claims the main site's own host is a
    // self-inflicted outage. Judged by the SAME claim the dispatcher runs
    // (claimsPreviewHost), so this closes exactly when the app's traffic would
    // really be swallowed — no wider, no narrower — and the answer is the AC6
    // shape: a closed origin with a readable reason, never a quiet fallback.
    if (template.kind === "host") {
      const mainSite = mainSiteHostOf(deps.appUrl);
      if (
        mainSite !== null &&
        claimsPreviewHost(template, mainSite.hostname, mainSite.port)
      ) {
        return {
          ok: false,
          reason: `The preview base "${template.baseHostname}" claims the main site's own host "${mainSite.hostname}" (OPENBOT_APP_URL), so every request to the app would 404 "Unknown preview host." Put the previews on a base that is its own subdomain of the app's host — e.g. https://{session}.preview.${mainSite.hostname}.`,
        };
      }
    }
    if (template.kind === "dev" && devPort.invalid) {
      return {
        ok: false,
        reason: `The preview origin is disabled: ${devPort.invalid}`,
      };
    }

    // #408 (AC6): production + empty template is an explicit close, never a
    // loopback address a remote browser would aim at its own machine. The
    // deployment context is the same appUrl #404 reads — unset or loopback is
    // the local dev form and keeps the dev shape; anything else names a host
    // the user's browser reaches over the network, where
    // http://127.0.0.1:<port>/<label> is unreachable by construction.
    if (template.kind === "dev" && isNonLoopbackAppUrl(deps.appUrl)) {
      return {
        ok: false,
        reason:
          "The preview origin is closed: OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE is empty (the dev form), but this deployment serves the app on a non-loopback host, so a 127.0.0.1 preview address would be unreachable from the user's browser. Set OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE (e.g. https://{session}.preview.example.com) to serve previews on their own host.",
      };
    }
    // #411 (AC6/AC8): the HOST form's addresses are https behind a certificate
    // this deployment terminates in front of the server — admission closes while
    // that certificate is missing, expired, or mid-first-issuance, surfacing the
    // renewal guard's own sentence instead of handing out addresses the browser
    // would fail to load. The DEV form never consults the gate: its addresses
    // are plain http on a local port, no certificate in the path. The gate
    // re-stats the file on every call, so a sidecar update re-opens admission
    // without a restart.
    if (template.kind === "host") {
      const tls = tlsStatusGate.verdict();
      if (!tls.ok) return { ok: false, reason: tls.reason };
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
      // http's default port is dropped by URL serialization (WHATWG), so a
      // listener on :80 is addressed without the suffix — mint the address in
      // that same shape or the browser-presented host would never match the
      // ticket binding (#363, from #361's final review).
      const portSuffix = port === 80 ? "" : `:${port}`;
      return `http://${DEV_PREVIEW_HOSTNAME}${portSuffix}/${label}`;
    },

    hasSession(sessionId) {
      // The registry's only reverse read: derive THIS session's label (the
      // same one-way derivation originFor registers under) and compare the
      // mapped id — a fresh registry (the restart state, M-2) answers false
      // for every session, which is the probe's restart verdict.
      return registry.get(previewLabel(deps.secret, sessionId)) === sessionId;
    },

    registryStats() {
      // #418 Option B: the count only — the observability surface never
      // enumerates labels or session ids (AC9).
      return { registeredLabels: registry.size };
    },

    handlesRequest(request) {
      const url = new URL(request.url);
      const hostname = normalizeHostname(url.hostname);
      if (template.kind === "host") {
        // fix-ocr22 #2's narrowings and the wildcard claim both live in
        // claimsPreviewHost — the SAME rule #404's admission check runs against
        // the main site's own host, so the guard can only ever close on a claim
        // that really takes the main site down.
        return claimsPreviewHost(template, hostname, effectivePortOf(url));
      }
      if (template.kind === "dev") {
        // fix-ocr3 (critical): the dev form claims hostname + a REGISTERED
        // label in the path's leading segment — the same label extraction
        // resolvePreviewRequest's dev branch reads. The install form
        // (app/serve.ts) forwards every /api call to
        // `http://127.0.0.1:<server port>/…` (the Host header derives from the
        // target URL), so the dev form's "main site on localhost, previews on
        // 127.0.0.1" host split does NOT hold there: claiming everything on
        // this host short-circuits the dispatcher into 404 "Unknown preview
        // host." and paralyzes the installed main site. Unregistered first
        // segments (/api, /, anything) MUST fall back to the main-site routes.
        if (hostname !== DEV_PREVIEW_HOSTNAME) return false;
        // The port, when derivable, must be the server's own — the same
        // effective-port reading the host form runs (URL serialization drops
        // http's default, so a :80 listener is judged on 80, not on ""). An
        // underivable port claims nothing either — admission is closed then
        // anyway (originFor throws, so no label can ever register) and the claim
        // must not widen to every port on the host.
        if (
          devPort.port !== undefined &&
          effectivePortOf(url) !== devPort.port
        ) {
          return false;
        }
        return registry.has(url.pathname.split("/")[1] ?? "");
      }
      // A malformed template claims nothing — but admission is closed with the
      // reason, and originFor throws, so no address ever pointed here.
      return false;
    },

    claimsOrigin(origin) {
      return claimsPreviewOrigin(template, origin);
    },

    resolvePreviewRequest(request) {
      const gate = admission();
      if (!gate.ok) return { refuse: { status: 503, reason: gate.reason } };
      const url = new URL(request.url);
      // Dot-folded like handlesRequest: the dotted and undotted forms of one
      // host must resolve to the same session, never to different branches.
      const hostname = normalizeHostname(url.hostname);
      // The label extraction, as plain branches (review-367 L3): the host form
      // reads the leading label off the hostname (the apex names no session),
      // the dev form reads the leading path segment.
      let label: string | null;
      if (template.kind === "host") {
        if (hostname === template.baseHostname) {
          label = null; // the apex: a preview host with no session label on it
        } else if (hostname.endsWith(`.${template.baseHostname}`)) {
          label = hostname.slice(0, -(template.baseHostname.length + 1));
        } else {
          label = null;
        }
      } else {
        label = url.pathname.split("/")[1] ?? null; // dev: the leading path label
      }
      const sessionId = label === null ? undefined : registry.get(label);
      if (sessionId === undefined) {
        // Unknown hostnames die here (AC on the Host↔session mapping): the
        // dispatcher only calls in for claimed hosts, so this 404 is the end of
        // the road — main-site routes are never a fallback target. For the host
        // form this is the load-bearing refusal (every subdomain under the base
        // is claimed); for the dev form it is defensive — fix-ocr3 tightened
        // the dev claim to registered label segments, so a claimed dev request
        // always resolves, and unregistered segments never reach here through
        // the dispatcher at all.
        return {
          refuse: { status: 404, reason: "Unknown preview host." },
        };
      }
      return { sessionId };
    },

    appPathFor(request) {
      // The upstream-resolvable path: the pathname VERBATIM in both forms.
      // The dev form's label rides the SAME mount the dev server serves under
      // (its start script's injected basePath, F-2/#365), so stripping it here
      // would dial the port root — where a basePath-mounted Next answers 404
      // for everything (the #365 finding: asset URLs off the mount, no
      // hydration, no HMR). The host form's app lives at the origin's root
      // (D3), pathname verbatim by definition.
      return new URL(request.url).pathname;
    },

    webappBasePathFor(sessionId) {
      // Only the dev form mounts the app under a path label (D5); the host
      // form (D3/D7) serves at the origin's root, and while admission is
      // closed no address exists whose shape could be mirrored (AC6) — root
      // path in both, never a guessed mount (#364's cwd retirement stands).
      if (template.kind !== "dev") return null;
      if (!admission().ok) return null;
      return `/${previewLabel(deps.secret, sessionId)}`;
    },

    async handlePreviewRequest(sessionId, request) {
      const gate = admission();
      if (!gate.ok) {
        return Response.json({ error: gate.reason }, { status: 503 });
      }
      const url = new URL(request.url);
      const ticket = url.searchParams.get("ticket");
      // fix-ocr20 #2 (medium，产品级)：兑换只发生在铸造地址根 —— 面板入口跳的
      // 唯一落点（dev = /<label>，webappBasePathFor 的同一派生；host = /）。
      // 旧的「见到 ?ticket= 就兑换」把 LLM 生成应用里常见的业务参数
      // （`?ticket=5` 的订单/工单号）全部拦进兑换分支 401，永远到不了应用；
      // 非入口根路径的 ?ticket= 是普通请求，过 cookie 门后连 query 一起透传。
      // fix-ocr22 #1: 入口根本身也不能无条件兑换 —— 应用内部跳回自己根路径
      // 携带业务 ?ticket= 时（已持有效 pass），旧判定仍落兑换分支 → 兑换失败
      // 401 卡死且刷新无法自愈（持 pass 者不会再走换票跳）。兑换因此加
      // 「未持有效 pass」前置：持 pass 的请求即使是入口根 + ?ticket= 也按普通
      // 请求过 cookie 门透传 —— 业务参数原样到达应用，pass 继续有效。
      const entryRoot = this.webappBasePathFor(sessionId) ?? "/";
      if (
        ticket !== null &&
        url.pathname === entryRoot &&
        this.verifyPass(sessionId, request) === null
      ) {
        // The presented host must be the one the ticket was bound to (the triple's
        // host element) — the issuing side bound `new URL(origin).host`, which by
        // construction never carries an FQDN trailing dot and never carries a
        // scheme-default port. WHATWG keeps the trailing dot on the wire, so the
        // binding comparison folds it — the SAME normalizeHostname the host-form
        // handlesRequest / resolvePreviewRequest comparisons run — or the dotted
        // redemption form (`x.preview.example.com.`) 401s a ticket its own host
        // legitimately holds (fix-ocr14). The dev form's hostname is an IP literal
        // (normalizeHostname is a no-op there); a present port rides the folded
        // host verbatim, matching the issued host's shape.
        const boundHost =
          url.port === ""
            ? normalizeHostname(url.hostname)
            : `${normalizeHostname(url.hostname)}:${url.port}`;
        const redeemed = await deps.previewTickets.redeemPreviewTicket({
          ticket,
          sessionId,
          previewHost: boundHost,
        });
        if ("reason" in redeemed) {
          // Never the ticket value, never a reason that echoes it (#360's rule).
          // fix-ocr27 #7: the refusal family's no-store discipline lands here
          // too — a 401 describes a transient state (the ticket burned,
          // expired, or foreign) and is never a cacheable answer.
          // fix-ocr28 #6: and so does the family's DUAL SHAPE — this was the
          // one bare Response.json left in the family, so an iframe
          // re-navigating the spent entry URL (the ticket already consumed
          // by the first hop) landed on raw JSON instead of the readable
          // page. refuseResponse answers no-store in both branches, keeping
          // fix-ocr27 #7's goal intact.
          return refuseResponse(
            request,
            "The preview ticket is invalid, expired, or already used.",
            401,
          );
        }
        // #427: the cookie carries a fresh RANDOM TOKEN in the v1 MAC frame —
        // HttpOnly on the preview origin, and the proxy never forwards cookies
        // to the app. The token's (sessionId, redeemed.userId) binding lives in
        // the server-side pass index (preview-pass.ts), not on the wire, so the
        // value discloses neither field and one token can be revoked without
        // touching the session (the old ponytail note's mint-an-opaque-token-
        // plus-index design, now landed). The userId is the ticket's OWN
        // verified claim (redemption re-checked the store for it above), so the
        // pass binds the session to its true owner.
        return new Response(null, {
          status: 302,
          headers: {
            // The clean path: the ticket dies with this hop, never in the URL (D4).
            // Leading slashes collapse first: a pathname like `//evil.com` would
            // otherwise echo into a SCHEME-RELATIVE Location and carry the browser
            // off the preview origin entirely (review-362 low, fixed in #363) —
            // the redemption target is always a same-origin path.
            location: `/${url.pathname.replace(/^\/+/, "")}`,
            // R-9 (OCR round 2): the DEV form hosts every session on ONE
            // shared host — 127.0.0.1:<port> — so a Path=/ pass is a single
            // cookie-jar slot the last redeemer overwrites; scoping the cookie
            // to the session's own /<label> (webappBasePathFor — the SAME
            // derivation that mounts the dev server, never a second HMAC copy)
            // keeps concurrent dev previews' passes coexistent. The host form
            // is one host per session and stays Path=/ (null → "/" below).
            // fix-ocr23 #7: this is entryRoot's ONE read — `entryRoot` above
            // already folded `webappBasePathFor(sessionId) ?? "/"`, and a
            // second independent call here (admission re-run + a fresh HMAC
            // derive each time) is a silent-inconsistency seam: if either side
            // ever grows its own guard or cache, the redemption gate's entry
            // root and the pass cookie's Path scope can drift apart — exactly
            // the cross-session overwrite shape R-9 guards against. One read,
            // two consumers.
            "set-cookie": previewSessionCookieHeader(
              previewPass.issue(sessionId, redeemed.userId),
              entryRoot,
            ),
            "cache-control": "no-store",
            // #406: the entry URL (the ticket's one appearance) must not
            // ride a Referer onto the clean path, where the app or its
            // access logs would keep the spent credential.
            "referrer-policy": "no-referrer",
          },
        });
      }

      // ── #362: the preview's own traffic — cookie-gated proxying ─────────────
      //
      // Everything after the redemption hop rides the preview domain's session
      // cookie (D9). The gate is exact: the cookie must carry a pass this
      // deployment SIGNED for THIS session (#358 repair — verifyPassWith, the
      // codec's constant-time MAC check, not the old value-equality a known
      // session id forged). The verified userId becomes the proxy's ownership
      // input: the store re-checks the row against it, so a pass minted
      // before a reassignment or deletion dies with the row, and a pass
      // minted for session A never opens session B's host. A main-site cookie
      // jar (never carried across hosts — F2) opens nothing. The refusal is
      // the iframe-facing dual shape, and like every refusal on this surface
      // it echoes neither cookie nor ticket values.
      const verified = this.verifyPass(sessionId, request);
      if (verified === null) {
        return refuseResponse(request, PREVIEW_PASS_REFUSAL, 401);
      }
      // The app-relative path this request addresses — the shared derivation
      // (appPathFor above), so the HMR upgrade dispatcher (#363) hands the dev
      // server the very same path this HTTP entry would.
      return deps.servePreview({
        sessionId,
        userId: verified.userId,
        request,
        appPath: this.appPathFor(request),
        query: url.search,
      });
    },

    verifyPass(sessionId, request) {
      return verifyPassWith(previewPass, sessionId, request);
    },

    revokePass(sessionId, token) {
      return previewPass.revoke(sessionId, token);
    },
  };
}

/**
 * Every preview pass candidate out of a Cookie header, in wire order, or an
 * empty jar when none rides it. Cookie values are opaque here — parsed,
 * never decoded, never logged.
 *
 * ALL same-named candidates (fix-ocr20 #3, superseding fix-ocr5 E's
 * first-match): RFC 6265 §5.4 sends a jar's same-named cookies longest-path
 * first, so the wire order is by descending path — but a preview page can
 * plant a same-named cookie on ANY deeper path (HttpOnly protects only the
 * pass's own name+domain+path slot; the deep slot is legal), and §5.4 then
 * puts that deep shadow FIRST on the wire. First-match judged exactly that
 * shadow, so a dev-form session A could plant Path=/<labelB>/x and 401
 * session B's whole preview until the jar was scrubbed — a cross-session DoS
 * first-match only ever closed for the SHALLOW (Path=/) shadow. The caller
 * (holdsPreviewSessionPass) iterates the candidates in this order and passes
 * when any one names its session: a shadow can no longer mask a pass that is
 * present, and a jar without the pass still refuses.
 */
function previewSessionCookieValues(cookieHeader: string | null): string[] {
  if (cookieHeader === null) return [];
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${PREVIEW_SESSION_COOKIE}=`)) {
      values.push(trimmed.slice(PREVIEW_SESSION_COOKIE.length + 1));
    }
  }
  return values;
}
