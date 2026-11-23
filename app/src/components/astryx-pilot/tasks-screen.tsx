import { Tab, TabList } from "@astryxdesign/core/TabList";
import { VStack } from "@astryxdesign/core/VStack";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useWaitingRows } from "@/components/approvals/waiting";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { InlineEmpty } from "@/components/layout/page-parts";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
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
  const id = useId();
  const activePanel = `${id}-active`;
  const upcomingPanel = `${id}-up-next`;
  return (
    <AstryxSurface className="bot-task-views flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageShell
        description="Review work your Bots are doing and revisit completed tasks."
        title="Bot tasks"
      >
        <VStack gap={4}>
          <TabList
            aria-label="Task views"
            onChange={(value) => {
              if (value === "active" || value === "up_next") {
                setView(value);
                rememberView(value);
              }
            }}
            role="tablist"
            size="lg"
            value={view}
          >
            <Tab label="Active" panelId={activePanel} value="active" />
            <Tab label="Up next" panelId={upcomingPanel} value="up_next" />
          </TabList>
          <section
            aria-label="Active"
            hidden={view !== "active"}
            id={activePanel}
            role="tabpanel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The ARIA tabs pattern puts the focusable target on the panel.
            tabIndex={0}
          >
            {view === "active" ? <ActiveView /> : null}
          </section>
          <section
            aria-label="Up next"
            hidden={view !== "up_next"}
            id={upcomingPanel}
            role="tabpanel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The ARIA tabs pattern puts the focusable target on the panel.
            tabIndex={0}
          >
            {view === "up_next" ? <SuggestionsInbox /> : null}
          </section>
        </VStack>
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
    <VStack gap={6}>
      {taskList.pending || waiting.isPending ? (
        <ReadStatus kind="loading" message="Loading Bot tasks…" />
      ) : null}
      {taskList.error ? (
        <ReadStatus
          kind="error"
          message="Couldn’t load Bot tasks"
          retry={taskList.refetch}
        />
      ) : !taskList.pending &&
        !waiting.isPending &&
        !waiting.error &&
        listed.length === 0 &&
        waiting.rows.length === 0 ? (
        <InlineEmpty title="No Bot tasks yet">
          Work your Bots start and tasks you complete will appear here.
        </InlineEmpty>
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
        <ReadStatus
          kind="error"
          message="Couldn’t load approvals and questions"
          retry={waiting.refetch}
        />
      ) : null}
      <BotResponsibilities />
      <PageSection title="Routines">
        <Link className="text-sm underline underline-offset-2" to="/routines">
          Manage Routines
        </Link>
        <RoutinesList embedded />
      </PageSection>
    </VStack>
  );
}
