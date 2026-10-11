import {
  IconChartHistogram,
  IconCode,
  IconCsv,
  IconDatabase,
  IconDownload,
  IconFileText,
  IconFileTypeDocx,
  IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { artifactUrl, exportDocxUrl } from "@/lib/craft/client";
import { craftArtifactsQueryOptions } from "@/lib/craft/queries";
import type { CraftArtifactEntry, CraftArtifactType } from "@/lib/craft/types";

/**
 * What the turn produced, grouped by what it is — the same six-kind gallery the workshop draws.
 * Every artifact is a plain same-origin download; a markdown report also offers a Word export
 * straight from the sandbox file.
 */
export function ArtifactsTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const { data, isPending } = useQuery(craftArtifactsQueryOptions(sessionId));

  if (isPending) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("artifacts.loading")}
      </p>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("artifacts.empty")}
      </p>
    );
  }

  return (
    <ul className="grid gap-2 overflow-y-auto p-3">
      {data.map((artifact) => (
        <li key={artifact.path}>
          <ArtifactRow sessionId={sessionId} artifact={artifact} />
        </li>
      ))}
    </ul>
  );
}

function ArtifactRow({
  sessionId,
  artifact,
}: {
  sessionId: string;
  artifact: CraftArtifactEntry;
}) {
  const { t } = useTranslation("craft");
  const isMarkdown = artifact.name.toLowerCase().endsWith(".md");

  return (
    <article className="rounded-md border border-border p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TypeIcon type={artifact.type} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{artifact.name}</p>
            <p className="text-xs text-muted-foreground">{artifact.path}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {isMarkdown ? (
            <a
              href={exportDocxUrl(sessionId, artifact.path)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent"
            >
              <IconFileTypeDocx className="size-3.5" />
              {t("artifacts.word")}
            </a>
          ) : null}
          <a
            href={artifactUrl(sessionId, artifact.path)}
            download={artifact.name}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent"
          >
            <IconDownload className="size-3.5" />
            {t("artifacts.download")}
          </a>
        </div>
      </header>
    </article>
  );
}

function TypeIcon({ type }: { type: CraftArtifactType }) {
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
    default:
      return <IconCode className={className} />;
  }
}
