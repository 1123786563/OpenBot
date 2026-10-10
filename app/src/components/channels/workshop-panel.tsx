import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workshopSnapshotQueryOptions } from "@/lib/workshop/queries";
import { WorkshopTurnView } from "./workshop-turn";
import { WorkshopFilesView } from "./workshop-files";
import { WorkshopArtifactsView } from "./workshop-artifacts";
import { WorkshopUsageView } from "./workshop-usage";

/**
 * The workshop tab: one channel's working surface in four panes.
 *
 * Files, artifacts, the live turn, usage — one aggregate (F1) paints the frame, and the tabs
 * fill in from it. This wave ships the shell and the live "process" pane (F5); the remaining
 * panes are honest placeholders naming what will fill them, not empty boxes pretending.
 *
 * The panel mounts in the channel's detail pane (search param `workshop=true`), beside the
 * Bot's settings and its screen: the workshop is a third way of looking at the same coworker.
 */
export function WorkshopPanel({
  channelId,
  botId,
}: {
  channelId: string;
  botId: string;
}) {
  const { t } = useTranslation("workshop");
  const [tab, setTab] = useState<"process" | "files" | "artifacts" | "usage">(
    "process",
  );
  const snapshot = useQuery(workshopSnapshotQueryOptions(channelId));

  const tabs = [
    { id: "process" as const, label: t("panel.tabs.process") },
    { id: "files" as const, label: t("panel.tabs.files") },
    { id: "artifacts" as const, label: t("panel.tabs.artifacts") },
    { id: "usage" as const, label: t("panel.tabs.usage") },
  ];

  return (
    <section
      aria-label={t("panel.ariaLabel")}
      className="flex h-full min-h-0 flex-col"
    >
      {snapshot.isPending ? (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          {t("panel.loading")}
        </p>
      ) : snapshot.isError ? (
        <p className="p-4 text-sm text-destructive" role="alert">
          {t("panel.loadError")}
        </p>
      ) : null}
      {snapshot.data ? (
        <>
          <div
            className="flex flex-row gap-1 border-b border-border px-2 py-1.5"
            role="tablist"
            aria-label={t("panel.tabs.ariaLabel")}
          >
            {tabs.map((entry) => (
              <Button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                variant="ghost"
                size="sm"
                className={cn(
                  "text-xs",
                  tab === entry.id && "bg-foreground/5 font-medium",
                )}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
            {tab === "process" ? (
              <WorkshopTurnView channelId={channelId} botId={botId} />
            ) : tab === "files" ? (
              <WorkshopFilesView channelId={channelId} />
            ) : tab === "artifacts" ? (
              <WorkshopArtifactsView
                channelId={channelId}
                artifacts={snapshot.data.artifacts}
              />
            ) : (
              <WorkshopUsageView snapshot={snapshot.data} />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
