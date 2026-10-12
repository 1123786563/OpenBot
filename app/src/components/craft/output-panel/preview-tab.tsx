import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { craftWebappQueryOptions } from "@/lib/craft/queries";

/**
 * The running web app, if the agent scaffolded one. The server answers `webapp_info` with the URL
 * the proxy serves; the iframe's first fetch starts the sandbox dev server lazily, so an empty slot
 * (rather than a spinner that never resolves) is the honest state before the first build.
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
  if (info.data?.webapp_url) {
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
    <p className="p-4 text-sm text-muted-foreground">{t("preview.empty")}</p>
  );
}
