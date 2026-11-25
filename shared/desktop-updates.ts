/**
 * What OpenBot Desktop says on a build that never updates itself (an internal or candidate build,
 * or one without the updater). The setup window's Updates section and Settings › This computer both
 * say it up front, with nothing to check, and from these words alone, so the two can't drift.
 */
export const DOESNT_UPDATE_ITSELF =
  "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.";

/**
 * How ready a newer OpenBot Desktop is to install, as the desktop app says
 * (desktop/src-tauri/src/app_update.rs, `Readiness`): its downloads arriving in the background
 * while this version keeps running, or all of them here.
 */
export type UpdateReadiness =
  | { state: "preparing"; done: number; total: number }
  | { state: "ready" };

/**
 * What OpenBot Desktop says of a newer version, with how ready it is. The banner in OpenBot's page,
 * Settings › This computer and the setup window all say it in these words. While it downloads the
 * share shown stops at 99%, so 100% is only ever said as "ready to install".
 *
 * Short enough for the banner's one line beside Update and restart at the default window width,
 * for a release's version, so the page under the banner never moves as the state changes
 * (app/tests/update-banner-layout.test.tsx).
 *
 * A surface speaking a language other than English hands in that language's three sentences. Which
 * sentence fits which state, and the share shown, stay decided here, so they cannot drift apart.
 */
export function updateOffered(
  version: string,
  ready?: UpdateReadiness | null,
  sentences: {
    available: (version: string) => string;
    downloading: (version: string, share: number) => string;
    ready: (version: string) => string;
  } = {
    available: (version) => `OpenBot ${version} is available.`,
    downloading: (version, share) =>
      `OpenBot ${version} is downloading in the background (${share}%).`,
    ready: (version) =>
      `OpenBot ${version} is ready to install. It takes a few minutes.`,
  },
): string {
  if (ready?.state === "ready") return sentences.ready(version);
  if (ready?.state === "preparing") {
    const share =
      ready.total > 0
        ? Math.min(99, Math.floor((ready.done / ready.total) * 100))
        : 0;
    return sentences.downloading(version, share);
  }
  return sentences.available(version);
}
