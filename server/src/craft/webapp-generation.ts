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
 * Absence of the marker therefore means precisely "assembled before the new
 * scaffold regime" — the population D10 protects — and every degraded read
 * (no sandbox, gateway error, foreign content) answers "legacy": the
 * conservative direction for the AC that exists to keep old previews honest.
 * The one residual risk — an agent deleting the marker — sits at the same trust
 * level as nextjs.pid, and is documented in docs/craft-preview-origin.md.
 */

/** The session-root file the start script stamps at template-copy time. */
export const WEBAPP_GENERATION_MARKER = ".webapp-generation";

/** The generation value the current scaffold regime stamps. */
export const WEBAPP_GENERATION_CURRENT = "2";

export type WebappGeneration = "legacy" | "current";

/**
 * The session's webapp generation, from the workspace marker. `sessionRoot` is
 * the session directory in the config's own spelling (sessionDirectory).
 */
export async function readWebappGeneration(
  api: { readFile(path: string): Promise<string | null> } | null | undefined,
  sessionRoot: string,
): Promise<WebappGeneration> {
  if (!api || typeof api.readFile !== "function") return "legacy";
  try {
    const content = await api.readFile(
      `${sessionRoot}/${WEBAPP_GENERATION_MARKER}`,
    );
    return content?.trim() === WEBAPP_GENERATION_CURRENT ? "current" : "legacy";
  } catch {
    return "legacy";
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
 * Both surfaces (the generated start script AND webapp-info's address) read the
 * generation through this ONE gate, so the script's mount and the pane's URL can
 * never disagree about where a legacy app lives.
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
    const botId = await input.botIdFor(sessionId);
    const fileApi = botId ? input.fileApiFor(botId) : null;
    const generation = await readWebappGeneration(
      fileApi,
      input.sessionDirectoryFor(sessionId),
    );
    if (generation === "legacy") return null;
    return (await input.webappBasePathFor?.(sessionId)) ?? null;
  };
}
