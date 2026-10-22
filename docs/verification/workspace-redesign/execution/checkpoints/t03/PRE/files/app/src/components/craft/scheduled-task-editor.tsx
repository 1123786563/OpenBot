import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  craftScheduledTaskKeys,
  createScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow,
  scheduledTaskQueryOptions,
  scheduledTaskRunsQueryOptions,
  updateScheduledTask,
} from "@/lib/craft/scheduled-tasks";
import type {
  CraftIntervalUnit,
  CraftScheduledTaskDetail,
  CraftScheduledTaskEditorMode,
  CraftScheduledTaskRunStatus,
  CraftScheduledTaskStatus,
} from "@/lib/craft/types";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * The scheduled-task form, in the detail panel beside the list. The three editor modes are the
 * server's three payloads verbatim (interval / daily_weekly / advanced — onyx's `interfaces.ts`),
 * kept to the minimum each needs: one unit + one number, one time + weekday toggles, or one cron
 * line. The server compiles and refuses (400 with a sentence), so this form validates nothing
 * locally beyond required fields — the compile errors are the schedule's own error messages.
 *
 * Editing reconstructs the form from the task's cron (the detail carries the compiled expression,
 * not the original payload — onyx's editor does the same reverse pass); anything it cannot parse
 * lands in advanced mode with the raw expression, which is always honest.
 */

type FormState = {
  name: string;
  prompt: string;
  mode: CraftScheduledTaskEditorMode;
  every: string;
  unit: CraftIntervalUnit;
  timeOfDay: string;
  weekdays: number[];
  cron: string;
  status: CraftScheduledTaskStatus;
  runImmediately: boolean;
};

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAY_KEYS: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

function emptyForm(): FormState {
  return {
    name: "",
    prompt: "",
    mode: "daily_weekly",
    every: "1",
    unit: "hours",
    timeOfDay: "09:00",
    weekdays: [],
    cron: "",
    status: "active",
    runImmediately: false,
  };
}

/** Best-effort reverse of the server's compileToCron — mode defaults to what the task was saved as. */
function formFromTask(task: CraftScheduledTaskDetail): FormState {
  const [minute, hour, dayOfMonth, , dayOfWeek] = task.cron_expression
    .split(/\s+/)
    .map((field) => field ?? "");
  const timeOfDay = `${(hour ?? "0").padStart(2, "0")}:${(minute ?? "0").padStart(2, "0")}`;

  if (task.editor_mode === "advanced") {
    return {
      ...emptyForm(),
      name: task.name,
      prompt: task.prompt,
      mode: "advanced",
      cron: task.cron_expression,
      status: task.status,
    };
  }

  if (task.editor_mode === "daily_weekly") {
    const weekdays =
      dayOfWeek && dayOfWeek !== "*"
        ? dayOfWeek
            .split(",")
            .map((day) => Number.parseInt(day, 10))
            .filter((day) => Number.isInteger(day))
        : [];
    return {
      ...emptyForm(),
      name: task.name,
      prompt: task.prompt,
      mode: "daily_weekly",
      timeOfDay,
      weekdays,
      status: task.status,
    };
  }

  // interval: which field carries the step says which unit it is.
  if (minute?.startsWith("*/")) {
    return {
      ...emptyForm(),
      name: task.name,
      prompt: task.prompt,
      mode: "interval",
      unit: "minutes",
      every: minute.slice(2),
      status: task.status,
    };
  }
  if (hour?.startsWith("*/")) {
    return {
      ...emptyForm(),
      name: task.name,
      prompt: task.prompt,
      mode: "interval",
      unit: "hours",
      every: hour.slice(2),
      status: task.status,
    };
  }
  return {
    ...emptyForm(),
    name: task.name,
    prompt: task.prompt,
    mode: "interval",
    unit: "days",
    every: dayOfMonth?.startsWith("*/") ? dayOfMonth.slice(2) : "1",
    timeOfDay,
    status: task.status,
  };
}

function payloadFor(state: FormState) {
  if (state.mode === "advanced") return { cron: state.cron.trim() };
  if (state.mode === "interval") {
    const every = Number.parseInt(state.every, 10);
    return {
      unit: state.unit,
      every,
      ...(state.unit === "days" ? { time_of_day: state.timeOfDay } : {}),
    };
  }
  return { time_of_day: state.timeOfDay, weekdays: state.weekdays };
}

/** One run status, said in the person's language — the roster row and the run history share it. */
export function ScheduledRunStatusChip({
  status,
}: {
  status: CraftScheduledTaskRunStatus;
}) {
  const { t } = useTranslation("craft");
  const labels: Record<CraftScheduledTaskRunStatus, string> = {
    queued: t("tasks.runStatus.queued"),
    running: t("tasks.runStatus.running"),
    succeeded: t("tasks.runStatus.succeeded"),
    failed: t("tasks.runStatus.failed"),
    skipped: t("tasks.runStatus.skipped"),
    awaiting_approval: t("tasks.runStatus.awaiting_approval"),
  };
  return (
    <span
      className={cn(
        "rounded-full border border-border px-1.5 py-0.5 text-xs",
        status === "failed" || status === "skipped"
          ? "text-destructive"
          : "text-muted-foreground",
      )}
    >
      {labels[status]}
    </span>
  );
}

export function ScheduledTaskEditor({
  taskId,
  onDone,
}: {
  /** Absent means creating. */
  taskId?: string;
  onDone: () => void;
}) {
  const { t } = useTranslation("craft");
  const queryClient = useQueryClient();
  const detail = useQuery({
    ...scheduledTaskQueryOptions(taskId ?? ""),
    enabled: taskId !== undefined,
  });
  const runs = useQuery({
    ...scheduledTaskRunsQueryOptions(taskId ?? ""),
    enabled: taskId !== undefined,
  });

  const [form, setForm] = useState<FormState>(emptyForm);
  const [seeded, setSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Seed once when the detail arrives (the panel mounts before the read resolves).
  if (taskId && detail.data && !seeded) {
    setForm(formFromTask(detail.data));
    setSeeded(true);
  }

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: craftScheduledTaskKeys.all,
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (taskId) {
        return updateScheduledTask(taskId, {
          name: form.name,
          prompt: form.prompt,
          editor_mode: form.mode,
          editor_payload: payloadFor(form),
          status: form.status,
        });
      }
      return createScheduledTask({
        name: form.name,
        prompt: form.prompt,
        editor_mode: form.mode,
        editor_payload: payloadFor(form),
        status: form.status,
        run_immediately: form.runImmediately,
      });
    },
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: async () => {
      setError(null);
      await invalidate();
      onDone();
    },
  });

  const runNow = useMutation({
    mutationFn: () => runScheduledTaskNow(taskId ?? ""),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteScheduledTask(taskId ?? ""),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: async () => {
      setError(null);
      await invalidate();
      onDone();
    },
  });

  const weekdayLabel = (day: number): string => {
    const key = WEEKDAY_KEYS[day];
    const labels: Record<string, string> = {
      sun: t("tasks.weekday.sun"),
      mon: t("tasks.weekday.mon"),
      tue: t("tasks.weekday.tue"),
      wed: t("tasks.weekday.wed"),
      thu: t("tasks.weekday.thu"),
      fri: t("tasks.weekday.fri"),
      sat: t("tasks.weekday.sat"),
    };
    return key ? (labels[key] ?? "") : "";
  };

  const submit = () => {
    if (!form.name.trim() || !form.prompt.trim()) {
      setError(t("tasks.requiredError"));
      return;
    }
    if (form.mode === "advanced" && !form.cron.trim()) {
      setError(t("tasks.requiredError"));
      return;
    }
    save.mutate();
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">
          {taskId ? t("tasks.editTitle") : t("tasks.newTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("tasks.editorHint")}
        </p>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="task-name">{t("tasks.name")}</FieldLabel>
          <Input
            id="task-name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="task-prompt">{t("tasks.prompt")}</FieldLabel>
          <Textarea
            id="task-prompt"
            rows={4}
            value={form.prompt}
            onChange={(event) =>
              setForm({ ...form, prompt: event.target.value })
            }
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="task-mode">{t("tasks.schedule")}</FieldLabel>
          <Select
            value={form.mode}
            onValueChange={(mode) => {
              // The null guard is the migration contract (H05/H06/H10): React Aria reports an
              // empty selection as null, and the draft keeps its editor mode rather than a
              // cast-through absence.
              if (mode !== null) setForm({ ...form, mode });
            }}
          >
            <SelectTrigger id="task-mode">
              <SelectValue>
                {form.mode === "interval"
                  ? t("tasks.mode.interval")
                  : form.mode === "daily_weekly"
                    ? t("tasks.mode.daily_weekly")
                    : t("tasks.mode.advanced")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interval">
                {t("tasks.mode.interval")}
              </SelectItem>
              <SelectItem value="daily_weekly">
                {t("tasks.mode.daily_weekly")}
              </SelectItem>
              <SelectItem value="advanced">
                {t("tasks.mode.advanced")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {form.mode === "interval" ? (
          <div className="flex gap-3">
            <Field className="flex-1">
              <FieldLabel htmlFor="task-every">{t("tasks.every")}</FieldLabel>
              <Input
                id="task-every"
                type="number"
                min={1}
                value={form.every}
                onChange={(event) =>
                  setForm({ ...form, every: event.target.value })
                }
              />
            </Field>
            <Field className="flex-1">
              <FieldLabel htmlFor="task-unit">
                {t("tasks.unitLabel")}
              </FieldLabel>
              <Select
                value={form.unit}
                onValueChange={(unit) => {
                  // Same null guard: null keeps the draft's previous unit.
                  if (unit !== null) setForm({ ...form, unit });
                }}
              >
                <SelectTrigger id="task-unit">
                  <SelectValue>
                    {form.unit === "minutes"
                      ? t("tasks.unit.minutes")
                      : form.unit === "hours"
                        ? t("tasks.unit.hours")
                        : t("tasks.unit.days")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">
                    {t("tasks.unit.minutes")}
                  </SelectItem>
                  <SelectItem value="hours">{t("tasks.unit.hours")}</SelectItem>
                  <SelectItem value="days">{t("tasks.unit.days")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}

        {form.mode === "interval" && form.unit === "days" ? (
          <Field>
            <FieldLabel htmlFor="task-time-days">
              {t("tasks.timeOfDay")}
            </FieldLabel>
            <Input
              id="task-time-days"
              type="time"
              value={form.timeOfDay}
              onChange={(event) =>
                setForm({ ...form, timeOfDay: event.target.value })
              }
            />
          </Field>
        ) : null}

        {form.mode === "daily_weekly" ? (
          <>
            <Field>
              <FieldLabel htmlFor="task-time-daily">
                {t("tasks.timeOfDay")}
              </FieldLabel>
              <Input
                id="task-time-daily"
                type="time"
                value={form.timeOfDay}
                onChange={(event) =>
                  setForm({ ...form, timeOfDay: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel>{t("tasks.weekdays")}</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day) => {
                  const active = form.weekdays.includes(day);
                  return (
                    <Button
                      key={day}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      aria-pressed={active}
                      onClick={() =>
                        setForm({
                          ...form,
                          weekdays: active
                            ? form.weekdays.filter((value) => value !== day)
                            : [...form.weekdays, day].sort((a, b) => a - b),
                        })
                      }
                    >
                      {weekdayLabel(day)}
                    </Button>
                  );
                })}
              </div>
              <p className="text-muted-foreground text-xs">
                {t("tasks.weekdaysHint")}
              </p>
            </Field>
          </>
        ) : null}

        {form.mode === "advanced" ? (
          <Field>
            <FieldLabel htmlFor="task-cron">{t("tasks.cron")}</FieldLabel>
            <Input
              id="task-cron"
              placeholder="0 9 * * 1-5"
              value={form.cron}
              onChange={(event) =>
                setForm({ ...form, cron: event.target.value })
              }
            />
            <p className="text-muted-foreground text-xs">
              {t("tasks.cronHint")}
            </p>
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor="task-status">
            {t("tasks.statusLabel")}
          </FieldLabel>
          <Select
            value={form.status}
            onValueChange={(status) => {
              // Same null guard: null keeps the draft's previous status.
              if (status !== null) setForm({ ...form, status });
            }}
          >
            <SelectTrigger id="task-status">
              <SelectValue>
                {form.status === "active"
                  ? t("tasks.status.active")
                  : t("tasks.status.paused")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t("tasks.status.active")}</SelectItem>
              <SelectItem value="paused">{t("tasks.status.paused")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {!taskId ? (
          <Field>
            <label
              htmlFor="task-run-now"
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              {/* The app checkbox (H04 shared-approval-fields pattern): ui/checkbox plants
                  `id` on its hidden native input via inputRef, so the sibling
                  `<label htmlFor>` keeps pointing at the control that actually toggles. */}
              <Checkbox
                id="task-run-now"
                checked={form.runImmediately}
                onCheckedChange={(checked) =>
                  setForm({ ...form, runImmediately: checked })
                }
              />
              {t("tasks.runImmediately")}
            </label>
          </Field>
        ) : null}
      </FieldGroup>

      <div className="flex items-center gap-2">
        <Button disabled={save.isPending} onClick={submit}>
          {taskId ? t("tasks.save") : t("tasks.create")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("session.cancel")}
        </Button>
        {taskId ? (
          <>
            <Button
              className="ml-auto"
              variant="outline"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              {t("tasks.runNow")}
            </Button>
            {confirmingDelete ? (
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t("tasks.deleteConfirm")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
                {t("tasks.delete")}
              </Button>
            )}
          </>
        ) : null}
      </div>

      {taskId ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-lg">{t("tasks.runs")}</h2>
          {detail.data ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono text-foreground/80">
                {detail.data.cron_expression}
              </span>
              {detail.data.next_runs.length > 0 ? (
                <span>
                  {t("tasks.nextRuns")}:{" "}
                  {detail.data.next_runs
                    .map((iso) => new Date(iso).toLocaleString())
                    .join(" · ")}
                </span>
              ) : null}
            </div>
          ) : null}
          {runs.data && runs.data.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {runs.data.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-col gap-0.5 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <ScheduledRunStatusChip status={run.status} />
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(run.started_at)}
                    </span>
                    {run.session_id ? (
                      <Link
                        className="ml-auto text-xs underline-offset-2 hover:underline"
                        params={{ sessionId: run.session_id }}
                        to="/craft/$sessionId"
                      >
                        {t("tasks.openSession")}
                      </Link>
                    ) : null}
                  </div>
                  {run.summary ? (
                    <p className="text-muted-foreground text-xs">
                      {run.summary}
                    </p>
                  ) : null}
                  {run.error_class ? (
                    <p className="text-destructive text-xs">
                      {run.error_class}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("tasks.runsEmpty")}
            </p>
          )}
          <Separator />
        </section>
      ) : null}
    </div>
  );
}
