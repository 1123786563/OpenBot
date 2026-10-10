import { useTranslation } from "react-i18next";
import {
  IconChartHistogram,
  IconCode,
  IconCsv,
  IconDatabase,
  IconDownload,
  IconFileText,
  IconWorld,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import type {
  WorkshopArtifact,
  WorkshopArtifactType,
} from "@/lib/workshop/client";
import { workshopArtifactDownloadUrl } from "@/lib/workshop/client";

/**
 * The artifact gallery: what the turn produced, by what it is.
 *
 * Six kinds, six previews — a CSV shows its head rows, a chart or report shows its card, a
 * webapp holds a "preview" slot until the share batch (B14) wires the running-app URL in, and
 * files and datasets get the honest generic card. Downloads are plain links: same-origin with
 * the session cookie, exactly how the rest of this app downloads.
 */
export function WorkshopArtifactsView({
  channelId,
  artifacts,
}: {
  channelId: string;
  artifacts: WorkshopArtifact[];
}) {
  const { t } = useTranslation("workshop");

  if (artifacts.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("artifacts.empty")}
      </p>
    );
  }

  return (
    <ul className="grid gap-2 p-3">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <ArtifactCard channelId={channelId} artifact={artifact} />
        </li>
      ))}
    </ul>
  );
}

/** The kind's label key, resolved per-branch so the typed t() sees literals, not strings. */
function typeLabelKey(type: WorkshopArtifactType) {
  switch (type) {
    case "csv":
      return "artifacts.type.csv" as const;
    case "chart":
      return "artifacts.type.chart" as const;
    case "report":
      return "artifacts.type.report" as const;
    case "webapp":
      return "artifacts.type.webapp" as const;
    case "dataset":
      return "artifacts.type.dataset" as const;
    case "file":
    default:
      return "artifacts.type.file" as const;
  }
}

function ArtifactCard({
  channelId,
  artifact,
}: {
  channelId: string;
  artifact: WorkshopArtifact;
}) {
  const { t } = useTranslation("workshop");
  return (
    <article className="rounded-md border border-border p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TypeIcon type={artifact.type} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{artifact.name}</p>
            <p className="text-xs text-muted-foreground">
              {t(typeLabelKey(artifact.type))} · {formatBytes(artifact.sizeBytes)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {artifact.type === "webapp" ? (
            <Button size="sm" variant="outline" disabled title={t("artifacts.webappPending")}>
              {t("artifacts.preview")}
            </Button>
          ) : null}
          <a
            href={workshopArtifactDownloadUrl(channelId, artifact.id)}
            download={artifact.name}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent"
          >
            <IconDownload className="size-3.5" />
            {t("artifacts.download")}
          </a>
        </div>
      </header>
      <Preview artifact={artifact} />
    </article>
  );
}

/** Each kind's honest preview: data where data exists, a slot where it is still coming. */
function Preview({ artifact }: { artifact: WorkshopArtifact }) {
  const { t } = useTranslation("workshop");
  switch (artifact.type) {
    case "csv":
      // The indexer stores head rows in the artifact's previewUrl field for csv kinds
      // (server contract); absent means "too large to preview", not "broken".
      return artifact.previewUrl ? (
        <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 text-xs whitespace-pre">
          {artifact.previewUrl}
        </pre>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("artifacts.previewUnavailable")}
        </p>
      );
    case "chart":
      return (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("artifacts.fileCard", {
            path: artifact.path,
            size: formatBytes(artifact.sizeBytes),
          })}
        </p>
      );
    case "report":
      return (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("artifacts.fileCard", {
            path: artifact.path,
            size: formatBytes(artifact.sizeBytes),
          })}
        </p>
      );
    case "webapp":
      // B14's share service replaces this note with the running app's URL. The button above
      // stays disabled until then: a dead preview is worse than an honest one.
      return (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("artifacts.webappPending")}
        </p>
      );
    case "dataset":
      return (
        <p className="mt-2 text-xs text-muted-foreground">{artifact.path}</p>
      );
    case "file":
    default:
      return (
        <p className="mt-2 text-xs text-muted-foreground">{artifact.path}</p>
      );
  }
}

function TypeIcon({ type }: { type: WorkshopArtifactType }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (type) {
    case "csv":
      return <IconCsv className={className} />;
    case "chart":
      return <IconChartHistogram className={className} />;
    case "report":
      return <IconFileText className={className} />;
    case "webapp":
      return <IconWorld className={className} />;
    case "dataset":
      return <IconDatabase className={className} />;
    case "file":
    default:
      return <IconCode className={className} />;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
