import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { craftWebappQueryOptions } from "@/lib/craft/queries";
import type { CraftWebappInfo } from "@/lib/craft/types";

/**
 * The running web app, if the agent scaffolded one. The server answers `webapp_info` with the URL
 * the proxy serves AND with `ready` — the probe of the session's reserved port — so the pane can
 * tell "an app exists" from "an app is serving".
 *
 * THE GATE IS `ready`, NOT `has_webapp`. `has_webapp` is true the moment `outputs/web/package.json`
 * exists, which is long before (and can outlive) the dev server behind it: a `webapp start` the turn
 * watchdog cancelled, a sandbox that restarted, an app that crashed on boot — all leave a scaffold
 * with nothing listening on the reserved port. Gating the iframe on `has_webapp` alone pointed the
 * frame at the proxy's 503, and what rendered in the pane was that response's raw body:
 * `{"error":"The web app is not running. Ask the agent to call the webapp tool with action
 * 'start'."}`. A down server is its own state here, in the product's own voice.
 *
 * The pane keeps polling while an app exists but is not serving, so the preview comes alive on its
 * own the moment the agent does start it — no reload, no hunting for a refresh. A serving app stops
 * polling: the iframe's own HMR socket is the live surface from there.
 *
 * Both empty states are the browser-chrome motif (this pane's own future, drawn small): hairline
 * window, muted dots, a dashed inner frame. Waiting-for-the-first-app and app-is-down share the
 * chrome and differ in the sentence, so the pane teaches its job without illustration theater.
 */

/** The not-yet-serving poll. Only while the pane is mounted, i.e. only while it's being looked at. */
const NOT_READY_POLL_MS = 5000;

/**
 * The pane's poll decision, as a fact of its own: an app that exists but is NOT serving is a
 * transient the agent can end at any moment, so it is watched; every other state — no app yet,
 * serving, no sandbox — settles and waits to be invalidated (a turn's end does that, see
 * chat-panel's handleSend). Exported because the decision is the interesting half: whether
 * react-query honors an interval is the library's business, and its own environment sniffing
 * (`typeof window` at import time) makes that unobservable under happy-dom.
 */
export function previewPollInterval(
  info: CraftWebappInfo | undefined,
): number | false {
  return info?.has_webapp && !info.ready ? NOT_READY_POLL_MS : false;
}

export function PreviewTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const info = useQuery({
    ...craftWebappQueryOptions(sessionId),
    refetchInterval: (query) => previewPollInterval(query.state.data),
  });

  if (info.isPending) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("preview.loading")}
      </p>
    );
  }

  const hasWebapp = info.data?.has_webapp === true;
  const serving = hasWebapp && info.data?.ready === true;

  if (serving && info.data?.webapp_url) {
    return (
      <iframe
        title={t("preview.title")}
        src={info.data.webapp_url}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    );
  }

  // An app exists but its dev server is down: the honest middle state, and the one the
  // iframe used to swallow whole.
  const down = hasWebapp && !serving;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-2.5">
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="ml-2 h-3 flex-1 rounded-full bg-muted" />
        </div>
        <div className="p-4">
          <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8">
            <p className="text-xs text-muted-foreground">
              {down ? t("preview.downTitle") : t("preview.emptyTitle")}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {down ? t("preview.downHint") : t("preview.emptyHint")}
        </p>
        <p className="text-xs text-muted-foreground/80">
          {t("preview.emptyTabs")}
        </p>
      </div>
      {down ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void info.refetch()}
          disabled={info.isFetching}
        >
          {t("preview.downRetry")}
        </Button>
      ) : null}
    </div>
  );
}
