import { IconPencil, IconPlus, IconTrash, IconWand } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  createSession,
  deleteSession,
  renameSession,
} from "@/lib/craft/client";
import { craftKeys, craftSessionsQueryOptions } from "@/lib/craft/queries";
import type { CraftSession } from "@/lib/craft/types";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * The session roster down the left edge. One session is open at a time; the list is the interactive
 * sessions only (`origin` is "INTERACTIVE"), newest activity first — scheduled/headless runs have no
 * conversation to open here. Create navigates straight into the new session; rename edits in place;
 * delete asks once before removing the row.
 */
export function SessionSidebar() {
  const { t } = useTranslation("craft");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeId = useParams({
    strict: false,
    select: (params) => (params as { sessionId?: string }).sessionId,
  });
  const sessions = useQuery(craftSessionsQueryOptions());

  const interactive = (sessions.data ?? [])
    .filter((session) => session.origin === "INTERACTIVE")
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));

  const create = useMutation({
    mutationFn: () => createSession(),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: craftKeys.list() });
      void navigate({
        to: "/craft/$sessionId",
        params: { sessionId: session.id },
      });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: craftKeys.list() });
    },
  });

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          <IconWand className="size-4 text-muted-foreground" />
          {t("session.title")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("session.new")}
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          <IconPlus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.isPending ? (
          <p className="p-2 text-xs text-muted-foreground">
            {t("session.loading")}
          </p>
        ) : interactive.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {t("session.none")}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {interactive.map((session) => (
              <li key={session.id}>
                <SessionRow
                  session={session}
                  active={session.id === activeId}
                  deleting={remove.isPending}
                  onDelete={() => remove.mutate(session.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  deleting,
  onDelete,
}: {
  session: CraftSession;
  active: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation("craft");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(session.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const rename = useMutation({
    mutationFn: (name: string) => renameSession(session.id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: craftKeys.list() });
      setEditing(false);
    },
  });

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const name = draft.trim();
    if (name && name !== session.name) rename.mutate(name);
    else setEditing(false);
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5",
        active ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : confirming ? (
        <span className="flex flex-1 items-center gap-1 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {t("session.deleteConfirm")}
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleting}
            onClick={onDelete}
          >
            {t("session.delete")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            {t("session.cancel")}
          </Button>
        </span>
      ) : (
        <Link
          to="/craft/$sessionId"
          params={{ sessionId: session.id }}
          className="min-w-0 flex-1 py-0.5"
        >
          <span className="block truncate text-sm">
            {session.name ?? t("session.untitled")}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {relativeTime(session.last_activity_at)}
          </span>
        </Link>
      )}
      {!editing && !confirming ? (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("session.rename")}
            onClick={() => {
              setDraft(session.name ?? "");
              setEditing(true);
            }}
          >
            <IconPencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("session.delete")}
            onClick={() => setConfirming(true)}
          >
            <IconTrash className="size-3.5" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
