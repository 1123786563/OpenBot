import { IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  CraftTaskEditorPresenter,
  ScheduledRunStatusChip,
} from "@/components/craft/scheduled-task-editor";
import { SessionSidebar } from "@/components/craft/session-sidebar";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { ButtonLink } from "@/components/ui/router-link";
import { Separator } from "@/components/ui/separator";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { scopedScheduledTasksQueryOptions } from "@/lib/craft/scheduled-tasks";
import type { CraftScheduledTaskListItem } from "@/lib/craft/types";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * The scheduled tasks roster, inside craft's shell: the session roster down the left edge, the
 * house settings-page frame for the list itself (PageShell/PageRows), and the create/edit form in
 * the detail panel the skills page made the pattern for — a search parameter, so editing is a real
 * navigation and Back closes it.
 */

const tasksSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The task id being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/craft/tasks")({
  validateSearch: tasksSearchSchema,
  component: CraftTasksPage,
});

function CraftTasksPage() {
  const { t } = useTranslation("craft");
  const { new: isCreating, edit: editingId } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Creating wins if both are somehow set — the roster's rule, re-used verbatim.
  const showCreate = isCreating === true;
  const showEdit = !showCreate && editingId !== undefined;
  // The roster is the scope's own answer (MT091 / Issue #134, AC1/AC3): the pair rides the
  // read, and the editor's writes below settle under the same scope.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const tasks = useQuery(scopedScheduledTasksQueryOptions(queryClient, scope));

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar />
      <CraftTaskEditorPresenter
        active={showCreate || showEdit}
        create={showCreate}
        taskId={showEdit ? editingId : undefined}
        onClose={finish}
      >
        <PageShell
          title={t("tasks.title")}
          description={t("tasks.description")}
          width="wide"
          action={
            <ButtonLink
              search={{ new: true }}
              to="/craft/tasks"
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              {t("tasks.new")}
            </ButtonLink>
          }
        >
          <PageSection>
            {tasks.isPending ? (
              <p className="text-muted-foreground mt-4 text-sm">
                {t("tasks.loading")}
              </p>
            ) : tasks.data === undefined ? (
              <p className="text-destructive mt-4 text-sm" role="alert">
                {t("tasks.loadError")}
              </p>
            ) : tasks.data.length === 0 ? (
              <Empty className="mt-4 h-[180px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    {t("tasks.empty")}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <PageRows>
                {tasks.data.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </PageRows>
            )}
          </PageSection>
        </PageShell>
      </CraftTaskEditorPresenter>
    </div>
  );
}

function TaskRow({ task }: { task: CraftScheduledTaskListItem }) {
  const { t } = useTranslation("craft");
  const navigate = Route.useNavigate();
  const paused = task.status === "paused";

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          <span className="truncate">{task.name}</span>
          <span
            className={cn(
              "ml-2 rounded-full border border-border px-1.5 py-0.5 align-middle text-muted-foreground text-xs",
              paused && "text-muted-foreground/70",
            )}
          >
            {paused ? t("tasks.status.paused") : t("tasks.status.active")}
          </span>
          {task.last_run ? (
            <span className="ml-2 align-middle">
              <ScheduledRunStatusChip status={task.last_run.status} />
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <span className="font-mono text-foreground/80 text-xs">
            {task.human_readable_schedule}
          </span>
          {task.next_run_at ? (
            <>
              <Separator className="mx-1 inline-block h-3 w-px align-middle" />
              {t("tasks.nextRun")}: {relativeTime(task.next_run_at)}
            </>
          ) : null}
        </ItemDescription>
      </ItemContent>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate({ search: { edit: task.id } })}
      >
        {t("tasks.edit")}
      </Button>
    </Item>
  );
}
