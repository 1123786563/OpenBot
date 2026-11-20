import { Button } from "@astryxdesign/core/Button";
import { IconChecklist } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useWaitingRows } from "@/components/approvals/waiting";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  NeedsYouRows,
  useNeedsYouTasks,
} from "@/components/needs-you/needs-you";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { TASK_ORDER } from "@/lib/tasks/groups";
import { TASK_STATUS_LABEL } from "@/lib/tasks/queries";

/** Which list Tasks shows: what waits on you and what your Bots carry, or what to start next. */
export type TasksView = "active" | "up_next";

/** Which list was open last, kept in this browser between visits. */
export const TASKS_VIEW_STORAGE_KEY = "openduet.tasks-view";

function rememberedView(): TasksView {
  try {
    return window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY) === "up_next"
      ? "up_next"
      : "active";
  } catch {
    return "active";
  }
}

function rememberView(view: TasksView) {
  try {
    window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be refused. The list still switches; it opens on Active next time.
  }
}

export function TasksScreen() {
  const [view, setView] = useState<TasksView>(rememberedView);
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageShell
        backButton={{ label: "Routines", linkProps: { to: "/routines" } }}
        description="Review work your Bots are doing and revisit completed tasks."
        title="Bot tasks"
      >
        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className="sr-only">Task view</legend>
          {(["active", "up_next"] satisfies TasksView[]).map((option) => (
            <Button
              aria-pressed={view === option}
              key={option}
              label={option === "active" ? "Active" : "Up next"}
              onClick={() => {
                setView(option);
                rememberView(option);
              }}
              variant={view === option ? "primary" : "secondary"}
            />
          ))}
        </fieldset>
        <div className="mt-6">
          {view === "active" ? <ActiveView /> : <SuggestionsInbox />}
        </div>
      </PageShell>
    </AstryxSurface>
  );
}

function ActiveView() {
  const waiting = useWaitingRows(undefined);
  const taskList = useNeedsYouTasks();
  const { tasks, done } = taskList;
  const listed = [...tasks, ...done];

  return (
    <div className="flex flex-col gap-7">
      {taskList.error ? (
        <p className="text-destructive text-sm" role="alert">
          {taskList.error.message}
        </p>
      ) : !taskList.pending &&
        !waiting.isPending &&
        !waiting.error &&
        listed.length === 0 &&
        waiting.rows.length === 0 ? (
        <PageEmpty icon={IconChecklist} title="No Bot tasks yet">
          Work your Bots start and tasks you complete will appear here.
        </PageEmpty>
      ) : null}
      {TASK_ORDER.map((status) => {
        const group = listed.filter((entry) => entry.status === status);
        const lead = status === "needs_input" ? waiting.rows : [];
        if (group.length + lead.length === 0) return null;
        return (
          <PageSection
            className="mt-0"
            key={status}
            title={TASK_STATUS_LABEL[status]}
          >
            <NeedsYouRows items={[]} lead={lead} tasks={group} />
          </PageSection>
        );
      })}
      {waiting.error ? (
        <p className="text-destructive text-sm" role="alert">
          {waiting.error.message}
        </p>
      ) : null}
      <BotResponsibilities />
      <PageSection title="Routines">
        <Link className="text-sm underline underline-offset-2" to="/routines">
          Manage Routines
        </Link>
        <RoutinesList embedded />
      </PageSection>
    </div>
  );
}
