import {
  IconFile,
  IconFolder,
  IconRefresh,
  IconUpload,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  uploadWorkshopFiles,
  type WorkshopFileNode,
} from "@/lib/workshop/client";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  scopedWorkshopFilesQueryOptions,
  workshopScopePair,
} from "@/lib/workshop/queries";

/**
 * The workspace as a tree, and the door data comes in through.
 *
 * The tree renders the server's nodes recursively (a directory folds open, a file shows its
 * name and size); the upload button walks multipart straight to the server. The limits are
 * enforced server-side and stated in the refusal text — the client checks first for a fast
 * answer, then shows whatever the server said verbatim rather than swallowing it, because a
 * refused upload the person cannot read is a refused upload that feels like a bug.
 */
export function WorkshopFilesView({ channelId }: { channelId: string }) {
  const { t } = useTranslation("workshop");
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "refused";
    text: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The tree and the upload are the scope's own (MT091 / Issue #134, AC1/AC3): the pair rides
  // every read and lands the uploaded bytes in the scope's workspace.
  const scope = useScopedCache();
  const root = useQuery(
    scopedWorkshopFilesQueryOptions(queryClient, scope, channelId, ""),
  );

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: scopedWorkshopFilesQueryOptions(
        queryClient,
        scope,
        channelId,
        "",
      ).queryKey,
    });
  };

  const upload = async (files: File[]) => {
    setNotice(null);
    // The client-side check is a fast answer, not the enforcement: the server's limits win.
    if (files.length > MAX_UPLOAD_FILES) {
      setNotice({ kind: "refused", text: t("files.tooMany") });
      return;
    }
    const oversized = files.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      setNotice({
        kind: "refused",
        text: t("files.tooLarge", { name: oversized.name }),
      });
      return;
    }
    setUploading(true);
    try {
      const result = await uploadWorkshopFiles(
        channelId,
        files,
        workshopScopePair(scope),
      );
      setNotice({
        kind: "ok",
        text: t("files.uploadDone", { count: result.uploaded }),
      });
      await refresh();
    } catch (error) {
      // The server's refusal text verbatim: a 413 with a reason is a sentence to show.
      setNotice({
        kind: "refused",
        text: `${t("files.refused")}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("files.title")}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("files.refresh")}
            onClick={() => void refresh()}
          >
            <IconRefresh className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={uploading}
            aria-label={t("files.upload")}
            onClick={() => inputRef.current?.click()}
          >
            <IconUpload className="size-3.5" />
            {uploading ? t("files.uploading") : t("files.upload")}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length > 0) void upload(files);
            }}
          />
        </div>
      </div>

      {notice ? (
        <p
          role={notice.kind === "refused" ? "alert" : "status"}
          className={
            notice.kind === "refused"
              ? "px-3 py-1.5 text-xs text-destructive"
              : "px-3 py-1.5 text-xs text-muted-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
        {root.isPending ? (
          <p className="text-xs text-muted-foreground" role="status">
            {t("panel.loading")}
          </p>
        ) : root.isError ? (
          <p className="text-xs text-destructive" role="alert">
            {t("panel.loadError")}
          </p>
        ) : root.data && root.data.length > 0 ? (
          <ul className="space-y-0.5">
            {root.data.map((node) => (
              <li key={node.path}>
                <TreeNode
                  channelId={channelId}
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
    </div>
  );
}

/** Mirrors the server's limits (B5) for the fast client-side answer; the server still decides. */
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function TreeNode({
  channelId,
  node,
  depth,
  expanded,
  onToggle,
}: {
  channelId: string;
  node: WorkshopFileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isDirectory = node.type === "directory";
  const open = expanded.has(node.path);
  // Lazy: a directory's children are fetched when it opens, cached under its own key.
  const nodeQueryClient = useQueryClient();
  const nodeScope = useScopedCache();
  const children = useQuery(
    scopedWorkshopFilesQueryOptions(
      nodeQueryClient,
      nodeScope,
      channelId,
      node.path,
    ),
  );

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
        {!isDirectory && node.size > 0 ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatBytes(node.size)}
          </span>
        ) : null}
      </button>
      {isDirectory && open ? (
        children.data && children.data.length > 0 ? (
          <ul className="space-y-0.5">
            {children.data.map((child) => (
              <li key={child.path}>
                <TreeNode
                  channelId={channelId}
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
        ) : (
          <p className="px-2 py-0.5 text-xs text-muted-foreground">∅</p>
        )
      ) : null}
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
