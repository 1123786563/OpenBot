import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconFlag } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { workshopApi } from "@/lib/workshop/public-client";

/**
 * The public share page: what a token reaches, and nothing else.
 *
 * Anonymous by design (the token is the key), read-only by contract (the scope decides
 * downloads), and UNIFORM ON EVERY MISS: a wrong, expired, or revoked token renders the same
 * 404 this route answers with `notFound()` — no field, no hint, nothing about which it was.
 * The owner's identity never crosses this page: the API behind it answers artifacts and
 * previews, not sessions or Bots.
 */
function SharePage() {
  const { t } = useTranslation("workshop");
  const token = Route.useParams().token;

  const share = useQuery({
    queryKey: ["workshop", "share", token],
    queryFn: () => workshopApi.publicShare(token),
    retry: false,
  });

  const report = workshopApi.useReportShare();

  if (share.isPending) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground" role="status">
          {t("sharePublic.loading")}
        </p>
      </main>
    );
  }

  // Every failure shape is the same page — see the head.
  if (share.isError || !share.data) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-base font-medium">{t("sharePublic.missing.title")}</p>
          <p className="text-sm text-muted-foreground">
            {t("sharePublic.missing.hint")}
          </p>
        </div>
      </main>
    );
  }

  const { scope, artifacts, previewUrl } = share.data;

  return (
    <main className="mx-auto min-h-svh max-w-4xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sharePublic.heading")}</h1>
        <p className="text-xs text-muted-foreground">{t("sharePublic.hint")}</p>
      </header>

      {previewUrl ? (
        <section aria-label={t("sharePublic.preview.aria")}>
          <iframe
            src={previewUrl}
            title={t("sharePublic.preview.aria")}
            className="h-[60vh] w-full rounded-md border border-border bg-background"
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        </section>
      ) : null}

      <section aria-label={t("sharePublic.artifacts.aria")}>
        <h2 className="text-sm font-medium">{t("sharePublic.artifacts.heading")}</h2>
        {artifacts.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("sharePublic.artifacts.empty")}
          </p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {artifacts.map((artifact) => (
              <li
                key={artifact.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{artifact.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {artifact.type} · {(artifact.sizeBytes / 1024).toFixed(1)} KB
                  </p>
                </div>
                {scope === "preview_download" && artifact.downloadUrl ? (
                  <a
                    href={artifact.downloadUrl}
                    download={artifact.name}
                    className="shrink-0 text-xs underline underline-offset-2"
                  >
                    {t("sharePublic.artifacts.download")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex items-center justify-between border-t border-border pt-3">
        <p className="text-[11px] text-muted-foreground">
          {t("sharePublic.footer")}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => report.mutate(token)}
          disabled={report.isPending || report.isSuccess}
        >
          <IconFlag className="size-3.5" />
          {report.isSuccess ? t("sharePublic.reported") : t("sharePublic.report")}
        </Button>
      </footer>
    </main>
  );
}

export const Route = createFileRoute("/share/$token")({
  component: SharePage,
  notFoundComponent: () => {
    const { t } = useTranslation("workshop");
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p className="text-base font-medium">{t("sharePublic.missing.title")}</p>
      </main>
    );
  },
});

void notFound;
