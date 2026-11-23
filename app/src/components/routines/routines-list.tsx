import {
  IconClock,
  IconHistory,
  IconMessageCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { ContinueBudgetedWork } from "@/components/billing/execution-budget-dialog";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { RoutineAction } from "@/components/routines/routine-action";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { ClientError, canKeepCachedRead } from "@/lib/client";
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
  routineKeys,
  routineRunsQueryOptions,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { NewRoutineButton } from "./new-routine-button";

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
function lastRunLabel(lastRun: RoutineRecord["lastRun"]): {
  text: string;
  className: string;
  /** The chip's dot, which carries the tone so the text can stay readable. */
  dot: string;
} {
  if (lastRun === null) {
    return {
      text: "Hasn't run yet",
      className: "text-muted-foreground",
      dot: "bg-muted-foreground/40",
    };
  }
  if (lastRun.status === null) {
    return {
      text: "Running…",
      className: "text-muted-foreground",
      dot: "animate-pulse bg-muted-foreground",
    };
  }
  const when = lastRun.at ? relativeTime(lastRun.at) : "recently";
  if (lastRun.status === "failed") {
    return {
      text: `Failed ${when}`,
      className: "text-destructive",
      dot: "bg-destructive",
    };
  }
  if (lastRun.status === "skipped" || lastRun.status === "paused") {
    return {
      text: `${lastRun.status === "paused" ? "Paused" : "Skipped"} ${when}`,
      className: "text-amber-600 dark:text-amber-500",
      dot: "bg-amber-500",
    };
  }
  if (lastRun.status === "succeeded") {
    return {
      text: `Ran ${when}`,
      className: "text-muted-foreground",
      dot: "bg-emerald-500",
    };
  }
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success — the contract typing (`RoutineRunOutcome | null`) makes a fourth outcome a build-time
  // error, but this is the runtime fallback if that ever slips through.
  return {
    text: `Finished ${when}`,
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

const RUN_STATUS: Record<
  RoutineRunRecord["status"],
  { text: string; dot: string; className: string }
> = {
  running: {
    text: "Running",
    dot: "animate-pulse bg-muted-foreground",
    className: "",
  },
  succeeded: { text: "Succeeded", dot: "bg-emerald-500", className: "" },
  failed: {
    text: "Failed",
    dot: "bg-destructive",
    className: "text-destructive",
  },
  skipped: {
    text: "Skipped",
    dot: "bg-amber-500",
    className: "text-amber-600 dark:text-amber-500",
  },
  paused: {
    text: "Paused",
    dot: "bg-amber-500",
    className: "text-amber-600 dark:text-amber-500",
  },
  waiting: { text: "Waiting for you", dot: "bg-sky-500", className: "" },
};

/** Every firing of one routine, newest first, each linking to the thread it ran in. */
function RoutineRuns({ routine }: { routine: RoutineRecord }) {
  const runs = useQuery(routineRunsQueryOptions(routine.id));
  const history = canKeepCachedRead(runs.error) ? runs.data : undefined;
  if (runs.isPending)
    return <ReadStatus kind="loading" message="Loading run history…" />;
  const failure = runs.error ? (
    <ReadError
      description={
        history?.length ? "Showing the last loaded runs." : undefined
      }
      message={
        history?.length
          ? "Couldn’t refresh run history"
          : "Couldn’t load run history"
      }
      retry={runs.refetch}
      retryBelow
      retrying={runs.isFetching}
    />
  ) : null;
  if (!history?.length)
    return (
      failure ?? <p className="text-muted-foreground text-sm">No runs yet.</p>
    );
  return (
    <>
      {failure}
      <ul className="flex w-full flex-col gap-1.5">
        {history.map((run) => {
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
                {status.text}
              </span>
              <span className="text-muted-foreground">
                {run.source === "run_now"
                  ? "Run now"
                  : run.source === "trigger"
                    ? "Triggered"
                    : "Scheduled"}{" "}
                · {relativeTime(run.startedAt)}
              </span>
              {routine.channel.gone ? null : (
                <Link
                  className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  params={{ channelId: routine.channel.id }}
                  to="/channel/$channelId"
                >
                  Open conversation
                </Link>
              )}
              {run.billingOperationId && !routine.channel.gone ? (
                <ContinueBudgetedWork
                  operationId={run.billingOperationId}
                  path={`/api/routines/${encodeURIComponent(routine.id)}/runs/${encodeURIComponent(run.id)}/continue`}
                  queryKey={routineKeys.all}
                />
              ) : null}
              {run.error ? (
                <span className="basis-full text-muted-foreground">
                  {run.error}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function RoutineRow({
  bot,
  historyOpen,
  onDelete,
  onHistoryChange,
  routine,
  showBot,
}: {
  bot: AgentProfile | undefined;
  historyOpen: boolean;
  onDelete: () => void;
  onHistoryChange: (id: string | null) => void;
  routine: RoutineRecord;
  showBot: boolean;
}) {
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const writePending = setEnabled.isPending || runNow.isPending;
  const historyRegionId = useId();
  const lastRun = lastRunLabel(routine.lastRun);
  const routineName = routine.title ?? routine.schedule;

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {routine.enabled ? <IconClock /> : <IconPlayerPause />}
      </ItemMedia>
      <ItemContent>
        {/*
         * Named by the person, the name heads the row and the schedule takes a line of
         * its own under it, so a narrow window never squeezes the name to fit it.
         */}
        {routine.title ? (
          <>
            <ItemTitle>{routine.title}</ItemTitle>
            <p className="break-words text-muted-foreground text-sm">
              {routine.schedule} · {routine.timezone}
            </p>
          </>
        ) : (
          <ItemTitle>
            {routine.schedule}
            <span className="font-normal text-muted-foreground text-sm">
              {routine.timezone}
            </span>
          </ItemTitle>
        )}
        <ItemDescription className="text-sm">
          {routine.instruction}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="routine-enable">
        {/*
         * Binary and immediate: it takes effect when switched, there is no save.
         * Disabled only while its own write is in flight, so switching one routine
         * does not freeze the rest of the list — the same idiom the per-tool plugins
         * page uses for its per-Bot grant switches.
         */}
        <Switch
          isDisabled={writePending}
          isLabelHidden
          isLoading={setEnabled.isPending}
          label={`Enable ${routineName}`}
          onChange={(next) =>
            setEnabled.mutate({ id: routine.id, enabled: next })
          }
          value={routine.enabled}
        />
      </ItemActions>
      {setEnabled.error ? (
        <p className="basis-full text-destructive text-sm" role="alert">
          Couldn’t update {routineName}.{" "}
          {setEnabled.error instanceof ClientError &&
          setEnabled.error.status < 500
            ? setEnabled.error.message
            : "Try the switch again."}
        </p>
      ) : null}
      {/* Two sets — where it stands, and what can be done to it — so they wrap onto a
          line of their own rather than crowding the title. */}
      <ItemFooter className="flex-wrap">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Every Bot's routines are on one page, so each says whose it is. */}
          {showBot ? (
            <Link
              params={{ agentId: routine.agentId }}
              to="/bots/$agentId/routines"
            >
              <Chip className="text-foreground transition-colors hover:bg-muted">
                {bot ? (
                  <span aria-hidden="true" className="contents">
                    <AbstractAvatar
                      name={bot.name}
                      seed={bot.avatarSeed}
                      size={14}
                    />
                  </span>
                ) : null}
                {bot?.name ?? "A Bot"}
              </Chip>
            </Link>
          ) : null}
          {routine.channel.gone ? (
            <Chip className="border-destructive/40 text-destructive">
              Conversation deleted
            </Chip>
          ) : (
            // Where it posts is a place, so the chip goes there.
            <Link
              aria-label={`Conversation: ${routine.channel.title ?? "Untitled conversation"}`}
              params={{ channelId: routine.channel.id }}
              to="/channel/$channelId"
            >
              <Chip className="text-muted-foreground transition-colors hover:text-foreground">
                <IconMessageCircle aria-hidden className="size-3.5" />
                {routine.channel.title ?? "Untitled conversation"}
              </Chip>
            </Link>
          )}
          <Chip className={lastRun.className}>
            <span className={cn("size-1.5 rounded-full", lastRun.dot)} />
            {lastRun.text}
          </Chip>
          {/*
           * Enabled only: the store recomputes nextRunAt on cron/timezone change or
           * re-enable, so a disabled routine's stamp is frozen in the past — rendering
           * it unguarded would announce a stale "3 days ago" as the next run. Paused
           * takes its place, so the switch's state has a word as well as a position.
           */}
          {!routine.enabled ? (
            <Chip className="text-muted-foreground">Paused</Chip>
          ) : new Date(routine.nextRunAt).getTime() <= Date.now() ? (
            /*
             * A stamp in the past is a firing the sweep has not picked up, and "Next 5
             * hours ago" is nonsense. Said as what it is: due, and visibly waiting.
             */
            <Chip className="text-amber-800 dark:text-amber-400">
              <span className="size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              Due
            </Chip>
          ) : (
            <Chip className="text-muted-foreground">
              Next {relativeTime(routine.nextRunAt)}
            </Chip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {!routine.channel.gone ? (
            <Link
              className="rounded-sm px-2 py-1 text-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              params={{ channelId: routine.channel.id }}
              to="/channel/$channelId"
            >
              Edit in conversation
            </Link>
          ) : null}
          {/*
           * Run now is the Test button, and it does real work: the Bot carries out the
           * instruction in the channel right away. Offered only while the routine is
           * on, because a paused routine never runs.
           */}
          <RoutineAction
            aria-label={`Run now for ${routineName}`}
            disabled={!routine.enabled || writePending}
            onClick={() => {
              onHistoryChange(routine.id);
              runNow.mutate(routine.id);
            }}
            icon={<IconPlayerPlay aria-hidden />}
            title={
              routine.enabled
                ? "Runs it now, for real. The Bot does the work and posts in the conversation."
                : "This routine is paused. Turn it on first."
            }
            type="button"
            variant="outline"
          >
            {runNow.isPending ? "Starting…" : "Run now"}
          </RoutineAction>
          <RoutineAction
            aria-controls={historyRegionId}
            aria-expanded={historyOpen}
            aria-label={`Run history for ${routineName}`}
            onClick={() => onHistoryChange(historyOpen ? null : routine.id)}
            icon={<IconHistory aria-hidden />}
            type="button"
            variant="ghost"
          >
            History
          </RoutineAction>
          <RoutineAction
            aria-label={`Delete ${routineName}`}
            disabled={writePending}
            onClick={onDelete}
            icon={<IconTrash aria-hidden />}
            type="button"
            variant="ghost"
          >
            Delete
          </RoutineAction>
        </div>
      </ItemFooter>
      {runNow.error ? (
        <p className="basis-full text-destructive text-sm" role="alert">
          Couldn’t start {routineName}. {runNow.error.message}
        </p>
      ) : null}
      <section
        aria-label={`Run history for ${routineName}`}
        className="basis-full border-border border-t pt-2"
        hidden={!historyOpen}
        id={historyRegionId}
      >
        {historyOpen ? <RoutineRuns routine={routine} /> : null}
      </section>
    </Item>
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
  hasCreateAction = false,
}: {
  /** Show only the routines this Bot carries out. Absent shows all of the person's. */
  agentId?: string;
  /** Where the page section's own top margin is somebody else's spacing. */
  embedded?: boolean;
  /** The surrounding page already provides its create action. */
  hasCreateAction?: boolean;
} = {}) {
  const routines = useQuery(routinesQueryOptions());
  /* Names and faces for the Bot chip, hidden Bots included: a routine outlives hiding its Bot. */
  const shownBots = useQuery({
    ...agentListQueryOptions(),
    enabled: agentId === undefined,
  });
  const hiddenBots = useQuery({
    ...agentListQueryOptions(true),
    enabled: agentId === undefined,
  });
  const bots = new Map(
    [...(shownBots.data ?? []), ...(hiddenBots.data ?? [])].map((bot) => [
      bot.id,
      bot,
    ]),
  );
  const deleteRoutine = useMutation(deleteRoutineMutationOptions(queryClient));
  /** Which routine's run history is open. One at a time keeps the list scannable. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  /** The routine a delete is being confirmed for, or null. Its own dialog rather than one per row. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const loaded = canKeepCachedRead(routines.error) ? routines.data : undefined;
  const rows = (loaded?.routines ?? []).filter(
    (row) => agentId === undefined || row.agentId === agentId,
  );
  const sweep = loaded?.sweep;
  const noWorker = nothingIsFiring(sweep, rows.length);
  const confirming = rows.find((row) => row.id === confirmingId) ?? null;

  return (
    <PageSection className={embedded ? "mt-0" : undefined}>
      {/* A fact about the deployment rather than a row to act on, so said as a sentence. */}
      {noWorker ? (
        <p className="mt-4 text-muted-foreground text-sm" role="alert">
          <span className="font-medium text-amber-600 dark:text-amber-500">
            Routines aren't running.
          </span>{" "}
          {sweep?.lastSweptAt
            ? `OpenBot last checked them ${relativeTime(sweep.lastSweptAt)}. None will run until it starts again. Ask an admin if this keeps happening.`
            : "OpenBot hasn't started running routines yet, so none of these will run. Ask an admin to set this up."}
        </p>
      ) : null}

      {routines.error ? (
        <ReadError
          description={
            rows.length ? "Showing the last loaded routines." : undefined
          }
          message={
            rows.length ? "Couldn’t refresh Routines" : "Couldn’t load Routines"
          }
          retry={routines.refetch}
          retryBelow
          retrying={routines.isFetching}
        />
      ) : null}
      {routines.isPending ? (
        <ReadStatus kind="loading" message="Loading Routines…" />
      ) : rows.length === 0 ? (
        routines.error ? null : (
          <PageEmpty
            action={
              hasCreateAction ? undefined : (
                <NewRoutineButton agentId={agentId} />
              )
            }
            icon={IconClock}
            title={agentId ? "No routines for this Bot yet" : "No routines yet"}
          >
            {agentId
              ? 'Set one up with New routine, or ask it something like "every weekday at 9, send me…".'
              : 'Set one up with New routine, or ask a Bot something like "every weekday at 9, send me…".'}
          </PageEmpty>
        )
      ) : (
        <PageRows>
          {rows.map((routine, index) => (
            <Fragment key={routine.id}>
              {index > 0 ? <Separator /> : null}
              <RoutineRow
                bot={bots.get(routine.agentId)}
                historyOpen={historyId === routine.id}
                onDelete={() => {
                  deleteRoutine.reset();
                  setConfirmingId(routine.id);
                }}
                onHistoryChange={setHistoryId}
                routine={routine}
                showBot={agentId === undefined}
              />
            </Fragment>
          ))}
        </PageRows>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        open={confirming !== null}
      >
        {/* The heavier backdrop, forced: opened from a Bot's dialog this stacks over it, and Base
            UI would otherwise render a nested dialog with no backdrop at all. */}
        <DialogContent
          {...astryxScope}
          overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        >
          <DialogHeader>
            <DialogTitle>
              Delete "{confirming?.title ?? confirming?.schedule}"?
            </DialogTitle>
            <DialogDescription>
              {confirming?.title
                ? `Scheduled ${confirming.schedule} (${confirming.timezone}). `
                : null}
              This routine stops for good. You can't undo this.
            </DialogDescription>
          </DialogHeader>
          {deleteRoutine.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {deleteRoutine.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <RoutineAction
              onClick={() => setConfirmingId(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </RoutineAction>
            <RoutineAction
              disabled={deleteRoutine.isPending}
              onClick={() => {
                if (!confirmingId) return;
                deleteRoutine.mutate(confirmingId, {
                  onSuccess: () => setConfirmingId(null),
                });
              }}
              type="button"
              variant="destructive"
            >
              {deleteRoutine.isPending ? "Deleting…" : "Delete"}
            </RoutineAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

import { Switch } from "@astryxdesign/core/Switch";
