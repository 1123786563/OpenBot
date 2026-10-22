import {
  IconCalendarPlus,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createWorkshopSchedule,
  deleteWorkshopSchedule,
  listWorkshopSchedules,
  type ScheduleMode,
  toggleWorkshopSchedule,
  type WorkshopSchedule,
} from "@/lib/workshop/client";

/**
 * The schedules panel: what fires, when it last fired and fires next, and what it did.
 *
 * The form sends STRUCTURED MODES only (interval/daily/advanced cron) — the compiler is the
 * server's (B17), and the panel's job is to make the common cases un-typeable-wrong rather
 * than to teach the browser cron. The preapproval selector is honest about its clamp: the
 * server clamps again (parsePreapproval), so what the user sees here is advisory text, not
 * a promise the wire keeps.
 */
export function WorkshopSchedulesView({ channelId }: { channelId: string }) {
  const { t } = useTranslation("workshop");
  const queryClient = useQueryClient();

  const schedules = useQuery({
    queryKey: ["workshop", channelId, "schedules"],
    queryFn: () => listWorkshopSchedules(channelId),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: ["workshop", channelId, "schedules"],
    });

  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <CreateScheduleForm channelId={channelId} onCreated={invalidate} />

      <section aria-label={t("schedules.list.aria")}>
        <h3 className="text-sm font-medium">{t("schedules.list.heading")}</h3>
        {schedules.isPending ? (
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            {t("schedules.list.loading")}
          </p>
        ) : schedules.isError ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t("schedules.list.error")}
          </p>
        ) : schedules.data.schedules.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("schedules.list.empty")}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {schedules.data.schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                channelId={channelId}
                schedule={schedule}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("schedules.history.aria")}>
        <h3 className="text-sm font-medium">
          {t("schedules.history.heading")}
        </h3>
        {schedules.data && schedules.data.runs.length > 0 ? (
          <ol className="mt-2 space-y-1.5">
            {schedules.data.runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5 text-xs"
              >
                <span
                  className={
                    run.status === "failed"
                      ? "font-medium text-destructive"
                      : run.status === "succeeded"
                        ? "font-medium text-emerald-600"
                        : "text-muted-foreground"
                  }
                >
                  {t(`schedules.run.status.${run.status}`)}
                </span>
                <time dateTime={run.scheduledFor}>
                  {new Date(run.scheduledFor).toLocaleString()}
                </time>
                {run.turnId ? (
                  <span className="text-muted-foreground">{run.turnId}</span>
                ) : null}
                {run.note ? (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {run.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("schedules.history.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

function ScheduleRow({
  channelId,
  schedule,
  onChanged,
}: {
  channelId: string;
  schedule: WorkshopSchedule;
  onChanged: () => void;
}) {
  const { t } = useTranslation("workshop");
  const toggle = useMutation({
    mutationFn: () =>
      toggleWorkshopSchedule(
        channelId,
        schedule.id,
        schedule.status !== "enabled",
      ),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => deleteWorkshopSchedule(channelId, schedule.id),
    onSuccess: onChanged,
  });
  const enabled = schedule.status === "enabled";

  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{schedule.prompt}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {schedule.rrule}
            {schedule.timezone ? ` · ${schedule.timezone}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {enabled && schedule.nextRunAt
              ? t("schedules.row.nextRun", {
                  time: new Date(schedule.nextRunAt).toLocaleString(),
                })
              : t("schedules.row.paused")}
          </p>
          {schedule.preapproved && schedule.preapproved.tools.length > 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("schedules.row.preapproved", {
                tools: schedule.preapproved.tools.join(", "),
                max: schedule.preapproved.maxTurnsPerRun,
              })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={
              enabled ? t("schedules.row.pause") : t("schedules.row.resume")
            }
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
          >
            {enabled ? (
              <IconPlayerPause className="size-3.5" />
            ) : (
              <IconPlayerPlay className="size-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("schedules.row.delete")}
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <IconTrash className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function CreateScheduleForm({
  channelId,
  onCreated,
}: {
  channelId: string;
  onCreated: () => void;
}) {
  const { t } = useTranslation("workshop");
  const [prompt, setPrompt] = useState("");
  const [modeKind, setModeKind] = useState<"interval" | "daily" | "advanced">(
    "interval",
  );
  const [every, setEvery] = useState(30);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("minutes");
  const [time, setTime] = useState("09:00");
  const [cron, setCron] = useState("");
  const [tools, setTools] = useState("");
  const [maxTurns, setMaxTurns] = useState(3);

  const create = useMutation({
    mutationFn: () => {
      const mode: ScheduleMode =
        modeKind === "interval"
          ? { kind: "interval", every, unit }
          : modeKind === "daily"
            ? { kind: "daily", time }
            : { kind: "advanced", cron };
      return createWorkshopSchedule(channelId, {
        prompt,
        mode,
        preapproval: {
          ...(tools.trim()
            ? {
                tools: tools
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              }
            : {}),
          maxTurnsPerRun: maxTurns,
        },
      });
    },
    onSuccess: () => {
      setPrompt("");
      setCron("");
      onCreated();
    },
  });

  return (
    <section
      className="rounded-md border border-border p-3"
      aria-label={t("schedules.form.aria")}
    >
      <h3 className="text-sm font-medium">{t("schedules.form.heading")}</h3>
      <Textarea
        className="mt-2 min-h-16 w-full text-xs"
        placeholder={t("schedules.form.prompt")}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {(["interval", "daily", "advanced"] as const).map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant={modeKind === kind ? "default" : "outline"}
            onClick={() => setModeKind(kind)}
          >
            {t(`schedules.form.mode.${kind}`)}
          </Button>
        ))}
      </div>

      {modeKind === "interval" ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            min={1}
            className="h-8 w-20 text-xs"
            value={every}
            onChange={(event) => setEvery(Number(event.target.value))}
            aria-label={t("schedules.form.every")}
          />
          <Select
            value={unit}
            onValueChange={(value) => {
              // The null guard is the migration contract (H05/H06/H10): null means "no
              // selection", and the half-built schedule keeps its previous unit.
              if (value !== null) setUnit(value);
            }}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-auto text-xs"
              aria-label={t("schedules.form.unitLabel")}
            >
              <SelectValue>{t(`schedules.form.unit.${unit}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">
                {t("schedules.form.unit.minutes")}
              </SelectItem>
              <SelectItem value="hours">
                {t("schedules.form.unit.hours")}
              </SelectItem>
              <SelectItem value="days">
                {t("schedules.form.unit.days")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : modeKind === "daily" ? (
        <Input
          type="time"
          className="mt-2 h-8 w-24 text-xs"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          aria-label={t("schedules.form.time")}
        />
      ) : (
        <Input
          type="text"
          className="mt-2 w-full font-mono text-xs"
          placeholder={t("schedules.form.cron")}
          value={cron}
          onChange={(event) => setCron(event.target.value)}
        />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="sched-tools">
          {t("schedules.form.tools")}
        </label>
        <Input
          id="sched-tools"
          type="text"
          className="h-8 w-40 text-xs"
          placeholder="python, bash"
          value={tools}
          onChange={(event) => setTools(event.target.value)}
        />
        <label
          className="ml-1 text-xs text-muted-foreground"
          htmlFor="sched-max"
        >
          {t("schedules.form.maxTurns")}
        </label>
        <Input
          id="sched-max"
          type="number"
          min={1}
          max={20}
          className="h-8 w-16 text-xs"
          value={maxTurns}
          onChange={(event) => setMaxTurns(Number(event.target.value))}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("schedules.form.clampHint")}
      </p>

      <Button
        size="sm"
        className="mt-2"
        onClick={() => create.mutate()}
        disabled={
          create.isPending ||
          !prompt.trim() ||
          (modeKind === "advanced" && !cron.trim())
        }
      >
        <IconCalendarPlus className="size-3.5" />
        {t("schedules.form.submit")}
      </Button>
      {create.isError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {t("schedules.form.error")}
        </p>
      ) : null}
    </section>
  );
}
