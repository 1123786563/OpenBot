import { IconFile, IconFolder } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { craftFilesQueryOptions } from "@/lib/craft/queries";
import type { CraftFileEntry } from "@/lib/craft/types";

/**
 * The session's outputs as a read-only tree — the deliverables the agent writes, anchored at
 * `outputs/` so the startup scaffolding (AGENTS.md, opencode.json, attachments/) never clutters
 * the view. A directory folds open and fetches its children lazily under the path's own cache
 * key; files show their name. There is deliberately no upload and no editor here — the agent
 * writes the files, and this answers "what does it hold now".
 */
export function FilesTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = useQuery(craftFilesQueryOptions(sessionId, "outputs"));

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="h-full overflow-y-auto p-2 text-sm">
      {root.isPending ? (
        <p className="text-xs text-muted-foreground">{t("files.loading")}</p>
      ) : root.isError ? (
        <p className="text-xs text-destructive">{t("files.error")}</p>
      ) : root.data && root.data.length > 0 ? (
        <ul className="space-y-0.5">
          {root.data.map((node) => (
            <li key={node.path}>
              <TreeNode
                sessionId={sessionId}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("files.empty")}</p>
      )}
    </div>
  );
}

function TreeNode({
  sessionId,
  node,
  depth,
  expanded,
  onToggle,
}: {
  sessionId: string;
  node: CraftFileEntry;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isDirectory = node.kind === "dir";
  const open = expanded.has(node.path);
  const children = useQuery({
    ...craftFilesQueryOptions(sessionId, node.path),
    enabled: isDirectory && open,
  });

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-foreground/5"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => isDirectory && onToggle(node.path)}
        aria-expanded={isDirectory ? open : undefined}
      >
        {isDirectory ? (
          <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <IconFile className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDirectory && open ? (
        children.data && children.data.length > 0 ? (
          <ul className="space-y-0.5">
            {children.data.map((child) => (
              <li key={child.path}>
                <TreeNode
                  sessionId={sessionId}
                  node={child}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              </li>
            ))}
          </ul>
        ) : children.isPending ? (
          <p className="px-2 py-0.5 text-xs text-muted-foreground">…</p>
        ) : null
      ) : null}
    </div>
  );
}
