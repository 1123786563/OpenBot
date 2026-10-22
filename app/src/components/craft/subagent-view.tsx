import { IconArrowLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  SubagentState,
  SubagentStatus,
} from "@/lib/craft/streaming-kernel";
import { cn } from "@/lib/utils";
import { TranscriptEntry } from "./message/transcript-entry";

/**
 * One subagent's transcript, read-only — the pane the parent's `task` card swaps in for the main
 * conversation (onyx's SubagentView reusing BuildMessageList). The return button restores the main
 * transcript; there is no composer here, and no cross-fade (recorded simplification versus onyx).
 */

const STATUS_CHIP: Record<SubagentStatus, string> = {
  running: "bg-amber-500/15 text-amber-600",
  done: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-destructive/15 text-destructive",
};

const STATUS_LABEL = {
  running: "subagent.status.running",
  done: "subagent.status.done",
  failed: "subagent.status.failed",
} as const satisfies Record<SubagentStatus, string>;

export function SubagentView({
  subagent,
  onReturn,
}: {
  subagent: SubagentState;
  onReturn: () => void;
}) {
  const { t } = useTranslation("craft");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-ob-muted-surface/40 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={onReturn}
        >
          <IconArrowLeft className="size-3.5" />
          {t("subagent.back")}
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("subagent.title")}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
            STATUS_CHIP[subagent.status],
          )}
        >
          {t(STATUS_LABEL[subagent.status])}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {subagent.streamItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("subagent.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {subagent.streamItems.map((item) => (
              <li key={item.key}>
                <TranscriptEntry item={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
