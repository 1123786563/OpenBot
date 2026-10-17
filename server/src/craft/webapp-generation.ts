/**
 * The legacy-session judgment (#367, spec D10: 存量不迁移).
 *
 * D10 fixes the strategy: sessions whose webapp predates the preview-origin
 * regime stay on the OLD same-origin preview path until natural end; sessions
 * whose app is of the current assembly walk the new preview origin. This module
 * answers, per session, WHICH one it is — and gates the one seam where guessing
 * wrong manufactures a silent 404.
 *
 * THE SIGNAL — an explicit assembly-generation marker (`<session>/.webapp-generation`,
 * content `2`), written by the server-authored start script at the ONE moment an
 * app's generation is decided: the template copy into `outputs/web`
 * (nextjs-dev.ts). Why a marker, and not the alternatives the ticket weighed:
 *
 * - `outputs/web/next.config.ts` mentioning basePath (the ticket's original
 *   suggestion) is DEAD as a signal: since F-2 (#365) BOTH template generations
 *   carry basePath logic — the old one is env-first with a cwd fallback, the new
 *   one env-only — so the source cannot tell old from new.
 * - Session creation time measures the ROW, not the APP. A pre-deployment
 *   session that (re)builds its webapp after the deployment gets a
 *   current-shape app (the template on disk is the new one); judging by creation
 *   date would route that working app to the old path and 404 it — exactly the
 *   silent-404 middle state AC2 forbids. It would also need a persisted
 *   deployment-generation timestamp.
 * - Whether start-webapp.sh exports ONYX_WEBAPP_BASE_PATH measures the SERVER's
 *   current code, not the app's vintage: provisioning/regenerate refreshes
 *   rewrite the script, so in the dev form EVERY session would read "current"
 *   (legacy apps 404 at the preview origin) and in the host form NONE would
 *   (current apps misrouted to the old path).
 *
 * Absence of the app body, however, decides the judgment FIRST (review-367 H1,
 * reordered by fix-ocr17 to close the TOCTOU window between two gateway round
 * trips — the probe order is now body-then-marker, shrinking the race to the
 * script's own cp/echo lines):
 *
 * - app body ABSENT ⇒ "current", and the marker is never consulted: the app
 *   is NOT YET ASSEMBLED, and its first `webapp start` will copy the CURRENT
 *   disk template and stamp the marker (nextjs-dev.ts) — rebuilding and
 *   re-stamping over whatever a stale marker on disk says. The script written
 *   at this provisioning moment must already carry the dev-form mount the
 *   preview address rides — the pre-fix answer (legacy) shipped a root-path
 *   script, the first start spawned without env, the new env-only template
 *   mounted at "/", and webapp-info (reading the fresh marker) handed out
 *   `/<label>`: a silent, non-self-healing 404 on every dev-form first build.
 * - app body PRESENT ⇒ the marker decides: current's own value answers
 *   "current"; any other content (or an unreadable marker) answers "legacy" —
 *   an app that exists was assembled before/outside the marker regime, the
 *   population D10 protects.
 *
 * Every degraded read splits by KIND (fix-ocr26 #8): a missing file API is a
 * PERMANENT fact (no sandbox — there is nothing to retry) and answers
 * "legacy"; a read that THREW is a transient flake and answers "unknown", a
 * third state that is no generational verdict at all. Folding a flake into
 * "legacy" used to rewrite a CURRENT session's webapp-info answer to the old
 * same-origin path (the dev server 404s it — a silent, stalling address
 * rewrite) and made preview-ticket refuse 409 with a legacy-race sentence
 * that described nothing true. The consumers own the unknown handling:
 * webapp-info keeps the current-shape answer (the address already minted),
 * preview-ticket refuses 503 with a retryable sentence, and the start-script
 * gate treats unknown as legacy (null mount — the failure mode there is
 * caught by webapp-info's .webapp-mount cross-check). The one residual risk
 * — an agent deleting the marker — sits at the same trust level as
 * nextjs.pid, and is documented in docs/craft-preview-origin.md.
 */

/** The session-root file the start script stamps at template-copy time. */
export const WEBAPP_GENERATION_MARKER = ".webapp-generation";

/** The generation value the current scaffold regime stamps. */
export const WEBAPP_GENERATION_CURRENT = "2";

/**
 * The app-body probe: the same file the start script's copy branch checks to
 * decide whether an app exists (nextjs-dev.ts: `[ ! -f .../outputs/web/package.json ]`).
 * An absent file here means the copy branch WILL run — the app the next start
 * assembles is born from the current template.
 *
 * Exported (fix-ocr15): nextjs-dev.ts's script template interpolates this
 * constant for its copy-branch check, so the probe and the check cannot
 * drift — the two spellings used to be hand-mirrored literals across the
 * two files, and drift between them silently misjudges current vs legacy.
 */
export const WEBAPP_APP_BODY_SENTINEL = "outputs/web/package.json";

/**
 * The judgment's three answers (fix-ocr26 #8): "legacy" and "current" are the
 * two app populations; "unknown" is a read that failed — a gateway flake, a
 * verdict on NOTHING. Consumers never treat unknown as either population.
 */
export type WebappGeneration = "legacy" | "current" | "unknown";

/**
 * The session's webapp generation, from the workspace marker. `sessionRoot` is
 * the session directory in the config's own spelling (sessionDirectory).
 *
 * The app body (`outputs/web/package.json` — the exact file the start script's
 * copy branch checks to decide whether an app exists) is probed FIRST. Absent
 * app ⇒ "current" (see the module header: unassembled ⇒ current, the next
 * start rebuilds and re-stamps); present app ⇒ the marker decides. A missing
 * file API ⇒ "legacy" (permanent: no sandbox, nothing to retry); a read that
 * THREW ⇒ "unknown" (transient — never a generational verdict, fix-ocr26 #8).
 */
export async function readWebappGeneration(
  api: { readFile(path: string): Promise<string | null> } | null | undefined,
  sessionRoot: string,
): Promise<WebappGeneration> {
  if (!api || typeof api.readFile !== "function") return "legacy";
  // The app-body probe runs FIRST (fix-ocr17): absent app ⇒ "current" without
  // consulting the marker at all — the next start WILL copy the template and
  // stamp current, so the answer must already be current and the window where
  // an assembly can land between this judgment's reads shrinks from two
  // gateway round trips to the script's own cp/echo lines. Present app ⇒ the
  // marker decides below.
  let appBody: string | null;
  try {
    appBody = await api.readFile(`${sessionRoot}/${WEBAPP_APP_BODY_SENTINEL}`);
  } catch {
    // A read that THREW is a flake, not a verdict (fix-ocr26 #8): it cannot
    // distinguish the two absent-marker populations, and neither may it
    // invent "legacy" — a current session demoted by a gateway hiccup had its
    // address rewritten to a path the dev server 404s.
    return "unknown";
  }
  // Absent includes the deployed gateway's shape for it: the sandbox
  // /file/content envelope answers 200 {"type":"text","content":""} for a
  // MISSING path — readFile's 404→null branch never fires against it — so
  // the "absent ⇒ current" fact above must read the empty string the same
  // way. Reading "" as an assembled app made every brand-new session fall
  // through to the marker comparison (`"" !== "2"` ⇒ "legacy"), and
  // provisioning wrote a root-path start script beside a /<label> preview
  // address: the F-2 silent first-build 404 (live-repro'd three times; see
  // the parity test in craft-webapp-generation.test.ts). A zero-byte
  // package.json is not an assembled app either, so the treatment is sound
  // for both absent spellings; a REAL app body is a non-empty manifest.
  if (appBody === null || appBody.trim() === "") return "current";
  try {
    const content = await api.readFile(
      `${sessionRoot}/${WEBAPP_GENERATION_MARKER}`,
    );
    if (content?.trim() === WEBAPP_GENERATION_CURRENT) return "current";
    // Foreign content (a value this code never wrote) never guesses forward:
    // the app exists, so it was assembled by something this code cannot see.
    return "legacy";
  } catch {
    // Same flake rule: the marker content is unreadable THIS time — the
    // session whose marker reads "2" on a healthy gateway must not be
    // demoted by the jitter (fix-ocr26 #8).
    return "unknown";
  }
}

/**
 * The D10 gate around the dev-form mount seam (`webappBasePathFor`, F-2/#365).
 *
 * The preview origin's derivation is SHAPE-aware (dev form → `/<label>`, host
 * form / closed origin → null) but not GENERATION-aware: a legacy app must NOT
 * receive the `/<label>` mount even in the dev form — its env-first template
 * would honor the env and re-mount itself under the label, while D10 routes the
 * session's preview to the OLD same-origin path its cwd-fallback mount answers.
 * What the two call sites share is the readWebappGeneration judgment itself
 * (fix-ocr15): the start script's write goes through THIS gate, and webapp-info
 * re-walks the same read one branch up in webapp-proxy.ts — two call sites
 * deriving the same inputs, which must stay mirrors of each other. They are
 * deliberately NOT one shared assembly: each surface consumes the judgment at
 * its own seam, and the mirror is the discipline, not an abstraction.
 *
 * Null file API (no sandbox) degrades to legacy → null: with no sandbox there is
 * no script write and no serving surface either, so the conservative answer
 * never costs a reachable preview anything.
 */
export function generationGatedWebappBasePathFor(input: {
  /** The shape-aware derivation (preview-origin.ts's webappBasePathFor). */
  webappBasePathFor?:
    | ((sessionId: string) => Promise<string | null> | string | null)
    | null;
  fileApiFor: (
    botId: string,
  ) => { readFile(path: string): Promise<string | null> } | null | undefined;
  botIdFor: (sessionId: string) => Promise<string | null>;
  sessionDirectoryFor: (sessionId: string) => string;
}): (sessionId: string) => Promise<string | null> {
  return async (sessionId) => {
    // fix-ocr15: a rejecting botIdFor is a DEGRADED read like every other this
    // gate takes — the module contract above promises each one falls back the
    // conservative way, so the rejection is caught and answered null (legacy:
    // no mount), never propagated to a caller scripting against that contract.
    let botId: string | null;
    try {
      botId = await input.botIdFor(sessionId);
    } catch {
      return null;
    }
    // fix-ocr28 #10: the SYNC injections are gated reads like every other
    // this gate takes — the async twins (botIdFor above, webappBasePathFor
    // below) were already caught, but a throwing fileApiFor or
    // sessionDirectoryFor pierced the returned async function and rode
    // writeWebappBootstrapScript's `await webappBasePathFor?.(sessionId)`
    // into provisioning/script-regeneration as a whole, exactly the
    // pattern the module header's "every degraded read falls back
    // conservatively" promise exists to prevent. Null (legacy: no mount)
    // is the conservative answer, mirroring the twins.
    let fileApi: ReturnType<typeof input.fileApiFor>;
    try {
      fileApi = botId ? input.fileApiFor(botId) : null;
    } catch {
      return null;
    }
    let sessionRoot: string;
    try {
      sessionRoot = input.sessionDirectoryFor(sessionId);
    } catch {
      return null;
    }
    const generation = await readWebappGeneration(fileApi, sessionRoot);
    // fix-ocr26 #8: "unknown" degrades like legacy HERE — the conservative
    // arm at the script write is null (no mount), never the label derivation.
    // Deriving for an actually-legacy app would export the env and silently
    // re-mount it under /<label> while the pane answers the old path (a
    // non-self-healing 404 with no cross-check to catch it); null for an
    // actually-current app IS caught — webapp-info's .webapp-mount
    // cross-check withholds the address behind the repair sentence.
    if (generation !== "current") return null;
    // fix-ocr17: the shape derivation is a gated read like every other this
    // gate takes — a rejection here (the async contract allows one) used to
    // pierce the await and fail provisioning as a whole, breaking the module
    // header's "every degraded read falls back conservatively" promise. Null
    // (legacy: no mount) is the conservative answer, mirroring botIdFor above.
    try {
      return (await input.webappBasePathFor?.(sessionId)) ?? null;
    } catch {
      return null;
    }
  };
}
