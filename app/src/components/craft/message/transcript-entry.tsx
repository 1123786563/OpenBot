import { IconCircleX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranscriptItem } from "@/lib/craft/streaming";
import { MessagePlan } from "./plan";
import { MessageText } from "./text";
import { MessageThinking } from "./thinking";
import { ToolCall } from "./tool-call";

/**
 * One transcript item, drawn — the switch both the main transcript and the subagent view
 * render through (history and live share the item shape, and so do parent and child).
 *
 * `onViewSubagent` is the parent's `task` card's click-through: opening the subagent's
 * read-only transcript. Absent (the subagent view itself), a task card renders without the
 * affordance — the view is read-only all the way down.
 */
export function TranscriptEntry({
  item,
  onViewSubagent,
}: {
  item: TranscriptItem;
  onViewSubagent?: (subagentSessionId: string) => void;
}) {
  const { t } = useTranslation("craft");
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm">
            {item.text ? (
              <p className="whitespace-pre-wrap">{item.text}</p>
            ) : null}
            {item.attachments && item.attachments.length > 0 ? (
              <ul
                className="mt-1 space-y-0.5"
                aria-label={t("attachments.list")}
              >
                {item.attachments.map((attachment) => (
                  <li
                    key={attachment.path}
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                  >
                    <span className="truncate">{attachment.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );
    case "text":
      return <MessageText text={item.text} />;
    case "thinking":
      return <MessageThinking text={item.text} streaming={item.streaming} />;
    case "tool": {
      const subagentId = item.subagentSessionId;
      return (
        <ToolCall
          title={item.title}
          toolKind={item.toolKind}
          status={item.status}
          rawInput={item.rawInput}
          rawOutput={item.rawOutput}
          content={item.content}
          subagentSessionId={subagentId}
          subagentStatus={item.subagentStatus}
          onViewSubagent={
            subagentId ? () => onViewSubagent?.(subagentId) : undefined
          }
        />
      );
    }
    case "plan":
      return <MessagePlan entries={item.entries} />;
    case "usage":
      return (
        <p className="text-center text-[11px] text-muted-foreground">
          {t("chat.usage", { tokens: item.usedTokens })}
        </p>
      );
    case "compaction":
      return (
        <p className="text-center text-[11px] text-muted-foreground">
          {t("chat.compacted")}
        </p>
      );
    case "error":
      return (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <IconCircleX className="size-3.5 shrink-0" />
          {item.message}
        </p>
      );
  }
}
