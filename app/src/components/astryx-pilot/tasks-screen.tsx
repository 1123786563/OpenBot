import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useWaitingRows } from "@/components/approvals/waiting";
import { AstryxSurface, astryxScope } from "@/components/astryx-pilot/theme";
import { InlineEmpty } from "@/components/layout/page-parts";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  NeedsYouRows,
  useNeedsYouTasks,
} from "@/components/needs-you/needs-you";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/i18n";
import { useBotNames } from "@/lib/agents/bot-names";
import { TASK_ORDER } from "@/lib/tasks/groups";
import { resolveTaskMutationOptions } from "@/lib/tasks/mutations";
import {
  type BotTask,
  TASK_STATUS_LABEL,
  type TaskStatus,
} from "@/lib/tasks/queries";

/** Which list Tasks shows: what waits on you and what your Bots carry, or what to start next. */
export type TasksView = "active" | "up_next";
type StatusFilter = "all" | TaskStatus;

const EMPTY_STATUS: Record<TaskStatus, string> = {
  ready_for_review: "No tasks ready for review.",
  needs_input: "Nothing needs your input.",
  failed: "No failed tasks.",
  working: "No tasks are running.",
  resolved: "No tasks resolved in the last seven days.",
};

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
    // Storage can be refused. The list still switches; it opens on Work and history next time.
  }
}

export function TasksScreen() {
  const [view, setView] = useState<TasksView>(rememberedView);
  const [status, setStatus] = useState<StatusFilter>("all");
  const id = useId();
  const activePanel = `${id}-active`;
  const upcomingPanel = `${id}-up-next`;
  return (
    <AstryxSurface className="bot-task-views flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageShell
        description="Review active work, approvals and completed tasks, or choose what to start next."
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
            <Tab
              label="Work and history"
              panelId={activePanel}
              value="active"
            />
            <Tab label="Ideas" panelId={upcomingPanel} value="up_next" />
          </TabList>
          <section
            aria-label="Work and history"
            hidden={view !== "active"}
            id={activePanel}
            role="tabpanel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The ARIA tabs pattern puts the focusable target on the panel.
            tabIndex={0}
          >
            {view === "active" ? (
              <ActiveView status={status} setStatus={setStatus} />
            ) : null}
          </section>
          <section
            aria-label="Ideas"
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

function ActiveView({
  status,
  setStatus,
}: {
  status: StatusFilter;
  setStatus: (status: StatusFilter) => void;
}) {
  const { t } = useTranslation();
  const botName = useBotNames();
  const waiting = useWaitingRows(undefined);
  const taskList = useNeedsYouTasks();
  const client = useQueryClient();
  const resolve = useMutation(resolveTaskMutationOptions(client));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const { tasks, done } = taskList;
  const listed = [...tasks, ...done];
  const showWaiting = status === "all" || status === "needs_input";
  const waitingRows = waiting.error ? [] : waiting.rows;
  const groups = (status === "all" ? TASK_ORDER : [status])
    .map((group) => ({
      status: group,
      tasks: listed.filter((entry) => entry.status === group),
      waiting: group === "needs_input" ? waitingRows : [],
    }))
    .filter((group) => group.tasks.length + group.waiting.length > 0);
  const count = groups.reduce(
    (total, group) => total + group.tasks.length + group.waiting.length,
    0,
  );
  const waitingPending = showWaiting && waiting.isPending;
  const waitingError = showWaiting ? waiting.error : null;
  const ready =
    !taskList.pending && !taskList.error && !waitingPending && !waitingError;
  const firstTaskHeading = useRef<HTMLHeadingElement>(null);
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const statusHelpId = useId();
  const statusHelp =
    status === "needs_input"
      ? "Includes approval requests and questions for you."
      : status === "resolved"
        ? "Shows tasks resolved in the last seven days."
        : undefined;
  const selectedLabel =
    status === "all" ? "All statuses" : TASK_STATUS_LABEL[status];
  const showReset = ready && count === 0 && status !== "all";

  function markDone(task: BotTask, trigger: HTMLButtonElement) {
    requestConfirmation({
      title: t("tasks.markDoneTitle", "Mark {title} done?", {
        title: task.title,
      }),
      description: t(
        "tasks.markDoneDescription",
        "The task moves to Resolved. You can reopen it there for seven days. Its conversation stays available.",
      ),
      confirmLabel: t("tasks.markDone", "Mark done"),
      pendingLabel: t("tasks.markDoneSaving", "Saving…"),
      failureMessage: t(
        "tasks.markDoneFailed",
        "Couldn't mark this task done. Try again.",
      ),
      successMessage: t(
        "tasks.markDoneSuccess",
        "Marked {title} done. Reopen it under Resolved.",
        { title: task.title },
      ),
      variant: "default",
      trigger,
      fallbackFocus: () => statusTrigger.current,
      run: async () => {
        const latest = await taskList.refetch({ throwOnError: true });
        const current = latest.data?.find(({ id }) => id === task.id);
        if (!current || current.title !== task.title)
          throw new ActionUnavailable(
            t(
              "tasks.markDoneStale",
              "This task changed. Check the list before trying again.",
            ),
          );
        if (current.status !== "resolved")
          await resolve.mutateAsync({ id: task.id, done: true });
      },
    });
  }

  return (
    <VStack gap={6}>
      {confirmation}
      <VStack gap={2} align="start">
        <Text as="p" size="sm">
          Task status
        </Text>
        <Select
          value={status}
          onValueChange={(next) => {
            if (next !== null) setStatus(next);
          }}
        >
          <SelectTrigger
            aria-describedby={statusHelp ? statusHelpId : undefined}
            aria-label="Task status"
            className="min-h-11"
            ref={statusTrigger}
          >
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent {...astryxScope} align="start">
            <SelectItem value="all">All statuses</SelectItem>
            {TASK_ORDER.map((option) => (
              <SelectItem key={option} value={option}>
                {TASK_STATUS_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {statusHelp ? (
          <Text as="p" color="secondary" id={statusHelpId} size="sm">
            {statusHelp}
          </Text>
        ) : null}
        <Text as="p" color="secondary" size="sm" role="status">
          {showReset
            ? EMPTY_STATUS[status]
            : ready && count > 0
              ? `${count} ${count === 1 ? "item" : "items"}${status === "all" ? "" : ` in ${selectedLabel}`}.`
              : ""}
        </Text>
        {showReset ? (
          <Button
            size="lg"
            label="Show all statuses"
            variant="secondary"
            style={{ minHeight: "var(--spacing-11)" }}
            onClick={() => {
              setStatus("all");
              statusTrigger.current?.focus();
            }}
          />
        ) : null}
      </VStack>
      {taskList.pending || waitingPending ? (
        <ReadStatus kind="loading" message="Loading Bot tasks…" />
      ) : null}
      {taskList.error ? (
        <ReadError
          description={
            listed.length ? "Showing the last loaded tasks." : undefined
          }
          focusAfterRetry={() =>
            firstTaskHeading.current ?? statusTrigger.current
          }
          message="Couldn’t load Bot tasks"
          retry={taskList.refetch}
          retryBelow
          retryLabel={t("tasks.retryTasks", "Retry loading tasks")}
          retrying={taskList.fetching}
        />
      ) : null}
      {waitingError ? (
        <ReadError
          message="Couldn’t load approvals and questions"
          retry={waiting.refetch}
          retryBelow
          retryLabel={t(
            "tasks.retryApprovals",
            "Retry approvals and questions",
          )}
          retrying={waiting.isFetching}
          focusAfterRetry={() =>
            firstTaskHeading.current ?? statusTrigger.current
          }
        />
      ) : null}
      {ready && count === 0 && status === "all" ? (
        <InlineEmpty title="No Bot tasks yet">
          Work your Bots start and tasks you complete will appear here.
        </InlineEmpty>
      ) : null}
      {groups.map((group, index) => (
        <PageSection
          className="mt-0"
          headingRef={index === 0 ? firstTaskHeading : undefined}
          key={group.status}
          title={TASK_STATUS_LABEL[group.status]}
          description={
            group.status === "resolved" && status === "all"
              ? "Tasks resolved in the last seven days."
              : undefined
          }
        >
          <NeedsYouRows
            canChangeTasks={!taskList.error}
            items={[]}
            lead={group.waiting}
            onMarkDone={markDone}
            tasks={group.tasks}
          />
        </PageSection>
      ))}
      <BotResponsibilities botName={botName} embedded />
      <RoutinesList
        embedded
        sectionLink={
          <Link className="text-sm underline underline-offset-2" to="/routines">
            Manage Routines
          </Link>
        }
      />
    </VStack>
  );
}
