import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { craftWebappQueryOptions } from "@/lib/craft/queries";

/**
 * The running web app, if the agent scaffolded one. The server answers `webapp_info` with the URL
 * the proxy serves; the iframe's first fetch starts the sandbox dev server lazily, so an empty slot
 * (rather than a spinner that never resolves) is the honest state before the first build.
 *
 * The empty slot is a browser-chrome motif (this pane's own future, drawn small): hairline window,
 * muted dots, a dashed inner frame waiting for the first build — plus one sentence each for what
 * renders here and where files/downloads live. It teaches the pane's job without illustration
 * theater, in the app's quiet card idiom.
 *
 * The iframe gate is `has_webapp`, NOT `webapp_url`: the server answers the URL for every
 * interactive session (the proxy route exists per session, port reserved at creation), so gating
 * on the URL alone renders the proxy's error page inside the frame for a workspace that never
 * built one. `has_webapp` is the honest "an app exists" fact; null (no sandbox) degrades to the
 * same empty state.
 */
export function PreviewTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const info = useQuery(craftWebappQueryOptions(sessionId));

  if (info.isPending) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("preview.loading")}
      </p>
    );
  }
  if (info.data?.has_webapp && info.data.webapp_url) {
    return (
      <iframe
        title={t("preview.title")}
        src={info.data.webapp_url}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    );
  }
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
              {t("preview.emptyTitle")}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {t("preview.emptyHint")}
        </p>
        <p className="text-xs text-muted-foreground/80">
          {t("preview.emptyTabs")}
        </p>
      </div>
    </div>
  );
}
