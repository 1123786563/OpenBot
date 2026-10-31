import { IconFlag } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/generated/application-config";
import {
  ShareUnavailableError,
  workshopApi,
} from "@/lib/workshop/public-client";

/**
 * The public share page: what a token reaches, and nothing else.
 *
 * Anonymous by design (the token is the key), read-only by contract (the scope decides
 * downloads), and UNIFORM ON EVERY MISS: a wrong, expired, or revoked token renders the same
 * 404 miss — no field, no hint, nothing about which it was. A service that cannot be asked
 * (offline, 429, 5xx) is not a miss: it says so and offers a retry, because the token was
 * never judged. The owner's identity never crosses this page: the API behind it answers
 * artifacts and previews, not sessions or Bots.
 */
function SharePage() {
  const { t } = useTranslation("workshop");
  const token = Route.useParams().token;

  /*
   * MT092 (Issue #135): a share's availability is the SERVER's answer, never a copy the page
   * holds. The token is the whole key and no identity rides the request, so this query is the
   * one place the page must not outlive its authorization: nothing is kept (gcTime 0 — a
   * remount re-asks, so a revoked or expired link reads as the uniform miss on the very next
   * visit, no cached "still live" carry-over), nothing is served stale (staleTime 0), and a
   * refusal never retries (the answer does not change by asking again).
   */
  const share = useQuery({
    queryKey: ["workshop", "share", token],
    queryFn: () => workshopApi.publicShare(token),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const report = workshopApi.useReportShare();

  // The panel's vocabulary for artifact types, when the type is one it knows.
  const typeLabels = {
    chart: t("artifacts.type.chart"),
    csv: t("artifacts.type.csv"),
    dataset: t("artifacts.type.dataset"),
    file: t("artifacts.type.file"),
    report: t("artifacts.type.report"),
    webapp: t("artifacts.type.webapp"),
  } as const;
  const typeLabel = (type: string) =>
    type in typeLabels ? typeLabels[type as keyof typeof typeLabels] : type;

  // The live share's tab title; the miss/unavailable states set theirs through AuthShell.
  const liveHeading = share.data ? t("sharePublic.heading") : null;
  useEffect(() => {
    if (liveHeading !== null) {
      document.title = `${liveHeading} · ${appConfig.brand.productName}`;
    }
  }, [liveHeading]);

  if (share.isPending) {
    return (
      <AuthShell title={t("sharePublic.loading")}>
        <p className="text-sm text-muted-foreground" role="status">
          {t("sharePublic.loading")}
        </p>
      </AuthShell>
    );
  }

  // A miss is the server's verdict on the token; anything else is the service being unreachable.
  if (share.isError || !share.data) {
    const unavailable = share.error instanceof ShareUnavailableError;
    if (unavailable) {
      return (
        <AuthShell title={t("sharePublic.unavailable.title")}>
          <div className="space-y-4">
            <div className="space-y-2">
              <h1 className="text-2xl font-medium tracking-tight">
                {t("sharePublic.unavailable.title")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("sharePublic.unavailable.hint")}
              </p>
            </div>
            <Button
              disabled={share.isFetching}
              onClick={() => void share.refetch()}
              type="button"
              variant="outline"
            >
              {t("sharePublic.retry")}
            </Button>
          </div>
        </AuthShell>
      );
    }
    return <ShareMiss />;
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
        <h2 className="text-sm font-medium">
          {t("sharePublic.artifacts.heading")}
        </h2>
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
                  <p
                    className="truncate text-xs font-medium"
                    title={artifact.name}
                  >
                    {artifact.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {typeLabel(artifact.type)} ·{" "}
                    {formatBytes(artifact.sizeBytes)}
                  </p>
                </div>
                {scope === "preview_download" && artifact.downloadUrl ? (
                  <a
                    className="shrink-0 rounded-md border border-border px-2 py-1.5 text-xs underline-offset-2 hover:bg-accent"
                    download={artifact.name}
                    href={artifact.downloadUrl}
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
        <p className="text-xs text-muted-foreground">
          {t("sharePublic.footer")}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => report.mutate(token)}
          disabled={report.isPending || report.isSuccess}
        >
          <IconFlag className="size-3.5" />
          {report.isSuccess
            ? t("sharePublic.reported")
            : t("sharePublic.report")}
        </Button>
      </footer>
    </main>
  );
}

/** The miss page a wrong, expired, or revoked token earns — brand, a heading, and one next step. */
function ShareMiss() {
  const { t } = useTranslation("workshop");
  return (
    <AuthShell title={t("sharePublic.missing.title")}>
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">
          {t("sharePublic.missing.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("sharePublic.missing.hint")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("sharePublic.missing.next")}
        </p>
      </div>
      {/* The page's first focusable element: an exit, not a dead end. */}
      <Link
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        to="/"
      >
        {t("sharePublic.missing.home")}
      </Link>
    </AuthShell>
  );
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024 * 1024) {
    return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

export const Route = createFileRoute("/share/$token")({
  component: SharePage,
  notFoundComponent: () => <ShareMiss />,
});
