import {
  IconClock,
  IconHistory,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/relative-time";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  nothingIsFiring,
  type RoutineRecord,
  type RoutineRunRecord,
  scopedRoutineRunsQueryOptions,
  scopedRoutinesQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
function lastRunLabel(
  t: TFunction<"routines">,
  lastRun: RoutineRecord["lastRun"],
): {
  text: string;
  className: string;
  /** The chip's dot, which carries the tone so the text can stay readable. */
  dot: string;
} {
  if (lastRun === null) {
    return {
      text: t("lastRun.never"),
      className: "text-muted-foreground",
      dot: "bg-muted-foreground/40",
    };
  }
  if (lastRun.status === null) {
    return {
      text: t("lastRun.running"),
      className: "text-muted-foreground",
      dot: "animate-pulse bg-muted-foreground",
    };
  }
  const when = lastRun.at ? relativeTime(lastRun.at) : t("lastRun.recently");
  if (lastRun.status === "failed") {
    return {
      text: t("lastRun.failed", { when }),
      className: "text-destructive",
      dot: "bg-destructive",
    };
  }
  if (lastRun.status === "skipped") {
    return {
      text: t("lastRun.skipped", { when }),
      className: "text-amber-600 dark:text-amber-500",
      dot: "bg-amber-500",
    };
  }
  if (lastRun.status === "succeeded") {
    return {
      text: t("lastRun.ran", { when }),
      className: "text-muted-foreground",
      dot: "bg-emerald-500",
    };
  }
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success — the contract typing (`RoutineRunOutcome | null`) makes a fourth outcome a build-time
  // error, but this is the runtime fallback if that ever slips through.
  return {
    text: t("lastRun.finished", { when }),
    className: "text-muted-foreground",
    dot: "bg-muted-foreground/40",
  };
}

/**
 * One fact about a routine, worn as a small pill so the footer reads as a row of states rather
 * than a sentence.
 */
function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs",
        className,
      )}
    >
      {children}
    </span>
  );
}

const RUN_STATUS = {
  running: {
    key: "runs.running",
    dot: "animate-pulse bg-muted-foreground",
    className: "",
  },
  succeeded: { key: "runs.succeeded", dot: "bg-emerald-500", className: "" },
  failed: {
    key: "runs.failed",
    dot: "bg-destructive",
    className: "text-destructive",
  },
  skipped: {
    key: "runs.skipped",
    dot: "bg-amber-500",
    className: "text-amber-600 dark:text-amber-500",
  },
  waiting: { key: "runs.waiting", dot: "bg-sky-500", className: "" },
} as const satisfies Record<
  RoutineRunRecord["status"],
  { key: string; dot: string; className: string }
>;

/** Every firing of one routine, newest first, each linking to the thread it ran in. */
function RoutineRuns({ routine }: { routine: RoutineRecord }) {
  const { t } = useTranslation("routines");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const runs = useQuery(
    scopedRoutineRunsQueryOptions(queryClient, scope, routine.id),
  );
  // Pending renders nothing: "No runs yet." would otherwise flash for the fetch.
  if (runs.isPending) return null;
  if (runs.error)
    return (
      <p className="text-destructive text-xs" role="alert">
        {runs.error.message}
      </p>
    );
  if (!runs.data?.length)
    return <p className="text-muted-foreground text-xs">{t("runs.none")}</p>;
  return (
    <ul className="flex w-full flex-col gap-1.5">
      {runs.data.map((run) => {
        const status = RUN_STATUS[run.status] ?? RUN_STATUS.skipped;
        return (
          <li
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
            key={run.id}
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                status.className,
              )}
            >
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              {t(status.key)}
            </span>
            <span className="text-muted-foreground">
              {run.source === "run_now"
                ? t("runs.source.runNow")
                : run.source === "trigger"
                  ? t("runs.source.triggered")
                  : t("runs.source.scheduled")}{" "}
              · {relativeTime(run.startedAt)}
            </span>
            {routine.channel.gone ? null : (
              <Link
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                params={{ channelId: routine.channel.id }}
                to="/channel/$channelId"
              >
                {t("runs.openThread")}
              </Link>
            )}
            {run.error ? (
              <span className="basis-full text-muted-foreground">
                {run.error}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The signed-in person's standing instructions: a switch to stop one taking effect, and a delete
 * that ends it for good.
 *
 * Scoped by `agentId` on a Bot's Routines page, unscoped on the Routines page. One query either way —
 * the list is owner-scoped and small, so the scope is a filter here rather than a second endpoint.
 */
export function RoutinesList({
  agentId,
  embedded = false,
}: {
  /** Show only the routines this Bot carries out. Absent shows all of the person's. */
  agentId?: string;
  /** Where the page section's own top margin is somebody else's spacing. */
  embedded?: boolean;
} = {}) {
  const { t } = useTranslation("routines");
  // The routines read and every action ride the scope this screen holds (MT089 AC2): keyed under
  // the scope's own prefix, carrying the pair, so the schedule shown and changed is the scope's
  // own, and a switch drops the old scope's rows wholesale (AC3).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const routines = useQuery(scopedRoutinesQueryOptions(queryClient, scope));
  const setEnabled = useMutation(
    setRoutineEnabledMutationOptions(queryClient, scope),
  );
  const deleteRoutine = useMutation(
    deleteRoutineMutationOptions(queryClient, scope),
  );
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient, scope));
  /** Which routine's run history is open. One at a time keeps the list scannable. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  /** The routine a delete is being confirmed for, or null. Its own dialog rather than one per row. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const rows = (routines.data?.routines ?? []).filter(
    (row) => agentId === undefined || row.agentId === agentId,
  );
  const sweep = routines.data?.sweep;
  const noWorker = nothingIsFiring(sweep, rows.length);
  const confirming = rows.find((row) => row.id === confirmingId) ?? null;

  return (
    <PageSection className={embedded ? "mt-0" : undefined}>
      {setEnabled.error || runNow.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {setEnabled.error?.message ?? runNow.error?.message}
        </p>
      ) : null}

      {/* A fact about the deployment rather than a row to act on, so said as a sentence. */}
      {noWorker ? (
        <p className="mt-4 text-muted-foreground text-sm" role="alert">
          <span className="font-medium text-amber-600 dark:text-amber-500">
            {t("workerStalled.title")}
          </span>{" "}
          {sweep?.lastSweptAt
            ? t("workerStalled.lastChecked", {
                when: relativeTime(sweep.lastSweptAt),
              })
            : t("workerStalled.neverChecked")}
        </p>
      ) : null}

      {/* Pending renders nothing: the empty-state sentence would otherwise flash for the fetch. */}
      {routines.isPending ? null : routines.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty>
          {agentId ? (
            <>
              {t("empty.agentTitle")} {t("empty.agentHint")}
            </>
          ) : (
            <>
              {t("empty.title")} {t("empty.hint")}
            </>
          )}
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((routine, index) => {
            const lastRun = lastRunLabel(t, routine.lastRun);
            return (
              <Fragment key={routine.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {routine.enabled ? <IconClock /> : <IconPlayerPause />}
                  </ItemMedia>
                  {/* Paused reads at a glance: the content dims, and a chip below says the word. */}
                  <ItemContent className={routine.enabled ? "" : "opacity-60"}>
                    <ItemTitle>
                      {routine.schedule}
                      <span className="font-normal text-muted-foreground text-xs">
                        {routine.timezone}
                      </span>
                    </ItemTitle>
                    <ItemDescription>{routine.instruction}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {/*
                     * Binary and immediate: it takes effect when switched, there is no save.
                     * Disabled only while its own write is in flight, so switching one routine
                     * does not freeze the rest of the list — the same idiom the per-tool plugins
                     * page uses for its per-Bot grant switches.
                     */}
                    <Switch
                      aria-label={t("actions.enableAria", {
                        schedule: routine.schedule,
                      })}
                      checked={routine.enabled}
                      disabled={
                        setEnabled.isPending &&
                        setEnabled.variables?.id === routine.id
                      }
                      onCheckedChange={(next) =>
                        setEnabled.mutate({ id: routine.id, enabled: next })
                      }
                    />
                  </ItemActions>
                  {/* Two sets — where it stands, and what can be done to it — so they wrap onto a
                      line of their own rather than crowding the title. */}
                  <ItemFooter className="flex-wrap">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-1.5",
                        routine.enabled ? "" : "opacity-60",
                      )}
                    >
                      {routine.channel.gone ? (
                        <Chip className="border-destructive/40 text-destructive">
                          {t("channelGone")}
                        </Chip>
                      ) : (
                        // Where it posts is a place, so the chip goes there.
                        <Link
                          params={{ channelId: routine.channel.id }}
                          to="/channel/$channelId"
                        >
                          <Chip className="text-muted-foreground transition-colors hover:text-foreground">
                            {routine.channel.name ?? t("unnamedChannel")}
                          </Chip>
                        </Link>
                      )}
                      <Chip className={lastRun.className}>
                        <span
                          className={cn("size-1.5 rounded-full", lastRun.dot)}
                        />
                        {lastRun.text}
                      </Chip>
                      {/*
                       * Enabled only: the store recomputes nextRunAt on cron/timezone change or
                       * re-enable, so a disabled routine's stamp is frozen in the past — rendering
                       * it unguarded would announce a stale "3 days ago" as the next run. Paused
                       * takes its place, so the switch's state has a word as well as a position.
                       */}
                      {!routine.enabled ? (
                        <Chip className="text-muted-foreground">
                          {t("paused")}
                        </Chip>
                      ) : new Date(routine.nextRunAt).getTime() <=
                        Date.now() ? (
                        /*
                         * A stamp in the past is a firing the sweep has not picked up, and "Next 5
                         * hours ago" is nonsense. Said as what it is: due, and visibly waiting.
                         */
                        <Chip className="text-amber-600 dark:text-amber-500">
                          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                          {t("due")}
                        </Chip>
                      ) : (
                        <Chip className="text-muted-foreground">
                          {t("next", { when: relativeTime(routine.nextRunAt) })}
                        </Chip>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {/*
                       * Run now is the Test button, and it does real work: the Bot carries out the
                       * instruction in the channel right away. Offered only while the routine is
                       * on, because a paused routine never runs.
                       */}
                      <Button
                        aria-label={t("actions.runNowAria", {
                          schedule: routine.schedule,
                        })}
                        disabled={
                          !routine.enabled ||
                          (runNow.isPending && runNow.variables === routine.id)
                        }
                        onClick={() =>
                          runNow.mutate(routine.id, {
                            onSuccess: () => setHistoryId(routine.id),
                          })
                        }
                        size="sm"
                        title={
                          routine.enabled
                            ? t("actions.runNowTitle")
                            : t("actions.runNowPausedTitle")
                        }
                        type="button"
                        variant="outline"
                      >
                        <IconPlayerPlay />
                        {t("actions.runNow")}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={t("actions.moreActions")}
                          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-ob-hover hover:text-ob-hover-foreground"
                          type="button"
                        >
                          <span aria-hidden="true">⋯</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              setHistoryId(
                                historyId === routine.id ? null : routine.id,
                              )
                            }
                          >
                            <IconHistory />
                            {t("actions.history")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              deleteRoutine.reset();
                              setConfirmingId(routine.id);
                            }}
                          >
                            <IconTrash />
                            {t("actions.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </ItemFooter>
                  {historyId === routine.id ? (
                    <div className="basis-full border-border border-t pt-2">
                      <RoutineRuns routine={routine} />
                    </div>
                  ) : null}
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}

      {/*
       * One dialog for the whole list rather than one per row, keyed by which routine is being
       * confirmed. It names the schedule, not the id or the instruction, because the schedule is
       * the word a person reads first on the row and the one most likely to tell two routines apart
       * at a glance.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        open={confirming !== null}
      >
        {/* The heavier backdrop, forced: opened from a Bot's dialog this stacks over it. HeroUI
            renders the nested backdrop itself; the `!` is only because the component CSS that sets
            `background-color: transparent` on the backdrop is imported unlayered. */}
        <DialogContent overlayClassName="bg-black/20! supports-backdrop-filter:backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle>
              {t("delete.title", { schedule: confirming?.schedule ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("delete.description")}</DialogDescription>
          </DialogHeader>
          {deleteRoutine.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {deleteRoutine.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirmingId(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("delete.cancel")}
            </Button>
            <Button
              disabled={deleteRoutine.isPending}
              onClick={() => {
                if (!confirmingId) return;
                deleteRoutine.mutate(confirmingId, {
                  onSuccess: () => setConfirmingId(null),
                });
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              {deleteRoutine.isPending
                ? t("delete.deleting")
                : t("delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
