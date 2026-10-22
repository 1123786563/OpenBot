import { IconFiles, IconListDetails, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ArtifactsTab } from "./artifacts-tab";
import { FilesTab } from "./files-tab";
import { PreviewTab } from "./preview-tab";

/**
 * The right-hand pane: three ways to look at what the agent has made. Preview shows the running
 * web app, Files the workspace tree, Artifacts the produced downloads. Tabs are local state — there
 * is no deep link into a tab, and none is wanted: the pane is a viewport, not a destination.
 */
type Tab = "preview" | "files" | "artifacts";

const TABS: Array<{
  id: Tab;
  icon: typeof IconWorld;
  labelKey: "tabs.preview" | "tabs.files" | "tabs.artifacts";
}> = [
  { id: "preview", icon: IconWorld, labelKey: "tabs.preview" },
  { id: "files", icon: IconFiles, labelKey: "tabs.files" },
  { id: "artifacts", icon: IconListDetails, labelKey: "tabs.artifacts" },
];

export function OutputPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const [tab, setTab] = useState<Tab>("preview");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex gap-1 border-b border-border px-2 pt-2">
        {TABS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-ob-muted-surface/40",
              tab === id && "bg-ob-muted-surface/50 text-foreground",
            )}
            onClick={() => setTab(id)}
          >
            <Icon className="size-3.5" />
            {t(labelKey)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "preview" ? (
          <div className="h-full">
            <PreviewTab sessionId={sessionId} />
          </div>
        ) : tab === "files" ? (
          <FilesTab sessionId={sessionId} />
        ) : (
          <div className="h-full">
            <ArtifactsTab sessionId={sessionId} />
          </div>
        )}
      </div>
    </div>
  );
}
