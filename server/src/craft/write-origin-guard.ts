/**
 * #410 (spec craft-preview-origin AC1, CP-03/D-5) — the main site's own
 * cookie-authenticated WRITE surface refuses a preview Origin, server-side.
 *
 * Why this exists when the preview already lives on a different host (D1): a
 * production preview is a SUBDOMAIN of the main site, so it is SAME SITE —
 * SameSite has nothing to withhold there, and a credentialed
 * `fetch("https://<main>/api/craft/sessions", {credentials:"include"})` from
 * inside LLM-generated preview code rides the platform session cookie. CSP is
 * the browser-side half (it can be relaxed by the very page it guards); this is
 * the defense-in-depth half, judged where the cookie is actually spent.
 *
 * The judgment, in order (fail closed at each step):
 * - SAFE METHODS (GET/HEAD/OPTIONS) are not this gate's business: reads answer
 *   through CORS and the preview pass, and an OPTIONS preflight must still reach
 *   the CORS middleware.
 * - NO ORIGIN passes. The header is what a browser adds to a cross-site write;
 *   its absence means a CLI, a native client, or another server — none of which
 *   is a document that could be tricked. (Same discipline the CORS block above
 *   the mount already follows: "native clients never send Origin".)
 * - PREVIEW NAMESPACE is refused FIRST, before the allow-list, so a deployment
 *   that misconfigures a preview base into `TRUSTED_ORIGINS` still refuses.
 *   The claim is the preview origin's OWN `claimsOrigin` — one rule, judged on
 *   the Host header for routing and on the Origin header here (preview-origin.ts).
 * - THEN THE ALLOW-LIST: the request's own origin (Host-derived, so a main site
 *   that talks to this server directly needs no configuration — the install/dev
 *   form's exact shape) plus the origins the deployment already serves browser
 *   traffic from (`TRUSTED_ORIGINS` + app URL — the same list CORS credentials,
 *   never a second copy of it).
 * - EVERYTHING ELSE is refused: a foreign Origin on a credentialed write is not
 *   a request this deployment has any business honoring.
 *
 * Both sides normalize through `normalizedOriginOf` (dot-folded host, port only
 * when present, path ignored), so trailing-dot FQDN and default-port spellings
 * cannot smuggle a claim past a string equality.
 *
 * KNOWN, RECORDED GAP: the DEV form (empty template — the config default) hosts
 * previews at `http://127.0.0.1:<server port>/<label>`, i.e. the server's OWN
 * origin with the session in a PATH label. An Origin header carries no path, so
 * a dev-form preview is indistinguishable from a main-site page on the same
 * host, and `claimsOrigin` answers false rather than guessing. Refusing that
 * origin would refuse the main site's own writes (the fix-ocr3 paralysis
 * family). The dev form's isolation stays host-based (D5) plus CSP.
 *
 * What a refusal says and where it leaks: the response is one displayable
 * sentence, echoing neither Origin nor Cookie, and the log line carries method +
 * path + the normalized origin + which branch refused. No ticket value, no
 * cookie value, no session id ever crosses this surface.
 */

import type { MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import { normalizedOriginOf } from "./preview-origin";

const logger = getLogger("server");

/** The one sentence a refused write answers — displayable, credential-free. */
export const CRAFT_WRITE_ORIGIN_REFUSAL =
  "This write was refused because its browser Origin is not trusted on this deployment.";

/** Which branch refused, for the log line — never a secret, always explainable. */
export type WriteOriginVerdict = "preview" | "untrusted" | "unparseable";

/** The log entry: no cookie, no ticket, no session id — see the module docblock. */
export type WriteOriginRefusal = {
  method: string;
  path: string;
  origin: string;
  verdict: WriteOriginVerdict;
};

/** The verbs a browser can spend a cookie on. Reads and preflight stay outside this gate. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createCraftWriteOriginGuard(deps: {
  /**
   * The origins the deployment already serves browser traffic from — CORS's own
   * list (`TRUSTED_ORIGINS` + app URL). Unset wiring is the empty list, i.e.
   * Host same-origin only: fail closed, never fail open.
   */
  trustedOrigins: readonly string[];
  /** The preview origin's claim, judged on an Origin header value. */
  isPreviewOrigin: (origin: string) => boolean;
  /** Refusal sink; the default warns through the server logger. */
  log?: (entry: WriteOriginRefusal) => void;
}): MiddlewareHandler<{ Variables: AppVariables }> {
  // Normalized ONCE at assembly: a per-request parse of a static list would only
  // add a way for the two sides to drift.
  const trusted = new Set(
    deps.trustedOrigins
      .map((origin) => normalizedOriginOf(origin))
      .filter((origin): origin is string => origin !== null),
  );
  const log =
    deps.log ??
    ((entry: WriteOriginRefusal) =>
      logger.warn(
        entry,
        "[craft] cookie-authenticated write refused by origin",
      ));

  return async (context, next) => {
    if (!UNSAFE_METHODS.has(context.req.method)) return next();
    const header = context.req.header("origin");
    // No Origin at all: not a browser document, nothing to be tricked about.
    if (header === undefined || header === "") return next();

    const refuse = (verdict: WriteOriginVerdict) => {
      let path = context.req.path;
      try {
        path = new URL(context.req.url).pathname;
      } catch {
        // req.path already answers; the URL is only for the log line.
      }
      log({
        method: context.req.method,
        path,
        origin: normalizedOriginOf(header) ?? "<unparseable>",
        verdict,
      });
      return context.json({ error: CRAFT_WRITE_ORIGIN_REFUSAL }, 403, {
        "cache-control": "no-store",
      });
    };

    // The preview namespace first — a trusted-list entry must never buy a
    // preview a write into the platform session.
    if (deps.isPreviewOrigin(header)) return refuse("preview");

    const origin = normalizedOriginOf(header);
    if (origin === null) return refuse("unparseable");
    // The request's own origin, derived from the Host it arrived on: this is the
    // "same origin as the server" case that needs no configuration at all.
    const own = normalizedOriginOf(context.req.url);
    if (origin === own || trusted.has(origin)) return next();
    return refuse("untrusted");
  };
}
