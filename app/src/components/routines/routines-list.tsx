import { HStack } from "@astryxdesign/core/HStack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import {
  IconClock,
  IconHistory,
  IconListSearch,
  IconMessageCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { RoutineAction } from "@/components/routines/routine-action";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { useTranslation } from "@/i18n";
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
  routineRunsQueryOptions,
  routinesAccessDenied,
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
function RoutineRuns({
  focusAfterRetry,
  routine,
}: {
  focusAfterRetry: () => HTMLElement | null;
  routine: RoutineRecord;
}) {
  // Subscribes this history to the interface language, so choosing another one redraws its times in place.
  useTranslation();
  const runs = useQuery(routineRunsQueryOptions(routine.id));
  const history = canKeepCachedRead(runs.error) ? runs.data : undefined;
  if (runs.isPending)
    return <ReadStatus kind="loading" message="Loading run history…" />;
  const failure = runs.error ? (
    <ReadError
      focusAfterRetry={focusAfterRetry}
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
      retryLabel="Retry loading run history"
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
  canChange,
  historyOpen,
  onDelete,
  onHistoryChange,
  routine,
  runHelpId,
  showBot,
}: {
  bot: AgentProfile | undefined;
  historyOpen: boolean;
  canChange: boolean;
  onDelete: (trigger: HTMLElement) => void;
  onHistoryChange: (id: string | null) => void;
  routine: RoutineRecord;
  runHelpId?: string;
  showBot: boolean;
}) {
  // Subscribes this row to the interface language, so choosing another one redraws its times in place.
  useTranslation();
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const writePending = setEnabled.isPending || runNow.isPending;
  const historyRegionId = useId();
  const pausedHelpId = useId();
  const historyRegion = useRef<HTMLElement>(null);
  const lastRun = lastRunLabel(routine.lastRun);
  const routineName = routine.title ?? routine.schedule;
  const longInstructions = routine.instruction.length > 120;
  const instructions = (
    <ItemDescription
      className="line-clamp-none text-sm"
      style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
    >
      {routine.instruction}
    </ItemDescription>
  );

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {routine.enabled ? <IconClock /> : <IconPlayerPause />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        {/*
         * Named by the person, the name heads the row and the schedule takes a line of
         * its own under it, so a narrow window never squeezes the name to fit it.
         */}
        {routine.title ? (
          <>
            <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
              {routine.title}
            </ItemTitle>
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
        {longInstructions ? null : instructions}
      </ItemContent>
      {canChange ? (
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
      ) : null}
      {longInstructions ? (
        <details style={{ flexBasis: "100%", minInlineSize: 0 }}>
          <summary
            aria-label={`View instructions for ${routineName}`}
            style={{
              cursor: "pointer",
              minBlockSize: "var(--spacing-11)",
              paddingBlock: "var(--spacing-3)",
            }}
          >
            View instructions
          </summary>
          {instructions}
        </details>
      ) : null}
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
              Runs{" "}
              <time dateTime={routine.nextRunAt}>
                {relativeTime(routine.nextRunAt)}
              </time>
            </Chip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {canChange && !routine.channel.gone ? (
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
          {canChange ? (
            <RoutineAction
              aria-describedby={routine.enabled ? runHelpId : pausedHelpId}
              aria-label={`Run now for ${routineName}`}
              disabled={!routine.enabled || writePending}
              onClick={() => {
                onHistoryChange(routine.id);
                runNow.mutate(routine.id);
              }}
              icon={<IconPlayerPlay aria-hidden />}
              title={
                routine.enabled && !runHelpId
                  ? "The Bot starts work immediately and can post in the conversation."
                  : undefined
              }
              type="button"
              variant="outline"
            >
              {runNow.isPending ? "Starting…" : "Run now"}
            </RoutineAction>
          ) : null}
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
          {canChange ? (
            <RoutineAction
              aria-label={`Delete ${routineName}`}
              disabled={writePending}
              onClick={(event) => onDelete(event.currentTarget)}
              icon={<IconTrash aria-hidden />}
              type="button"
              variant="ghost"
            >
              Delete
            </RoutineAction>
          ) : null}
        </div>
      </ItemFooter>
      {!routine.enabled && canChange ? (
        <Text
          as="p"
          className="basis-full"
          color="secondary"
          id={pausedHelpId}
          size="sm"
        >
          Turn this routine on to run it now.
        </Text>
      ) : null}
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
        ref={historyRegion}
        tabIndex={-1}
      >
        {historyOpen ? (
          <RoutineRuns
            focusAfterRetry={() => historyRegion.current}
            routine={routine}
          />
        ) : null}
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
  searchable = false,
}: {
  /** Show only the routines this Bot carries out. Absent shows all of the person's. */
  agentId?: string;
  /** Where the page section's own top margin is somebody else's spacing. */
  embedded?: boolean;
  /** The surrounding page already provides its create action. */
  hasCreateAction?: boolean;
  searchable?: boolean;
} = {}) {
  // Subscribes this list to the interface language, so choosing another one redraws its times in place.
  useTranslation();
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
  // The Bot's dialog needs a second backdrop when a confirmation opens over it.
  const { requestConfirmation, confirmation } = useActionConfirmation(
    undefined,
    {
      overlayClassName: "bg-black/20 supports-backdrop-filter:backdrop-blur-sm",
    },
  );
  /** Which routine's run history is open. One at a time keeps the list scannable. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const runHelpId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const denied = routinesAccessDenied(routines.error);
  const loaded = canKeepCachedRead(routines.error) ? routines.data : undefined;
  const rows = (loaded?.routines ?? []).filter(
    (row) => agentId === undefined || row.agentId === agentId,
  );
  const sweep = loaded?.sweep;
  const showRunHelp =
    searchable && routines.isSuccess && rows.some(({ enabled }) => enabled);
  const noWorker = routines.isSuccess && nothingIsFiring(sweep, rows.length);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = rows.filter((row) => {
    if (!words.length) return true;
    const text = [
      row.title,
      row.instruction,
      row.channel.title,
      row.schedule,
      row.timezone,
      bots.get(row.agentId)?.name,
      row.enabled ? "enabled" : "paused",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });

  return (
    <PageSection
      className={embedded ? "mt-0" : undefined}
      description={
        showRunHelp ? (
          <Text as="span" id={runHelpId}>
            Run now starts work immediately and can post in the conversation.
          </Text>
        ) : undefined
      }
      headingRef={searchable ? heading : undefined}
      title={
        searchable
          ? agentId
            ? "This Bot’s routines"
            : "Your routines"
          : undefined
      }
    >
      {confirmation}
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
            rows.length
              ? "Showing the last loaded routines. Refresh to make changes."
              : undefined
          }
          message={
            denied
              ? "You don’t have access to these routines."
              : rows.length
                ? "Couldn’t refresh Routines"
                : "Couldn’t load Routines"
          }
          retry={routines.refetch}
          retryBelow
          retryLabel="Retry loading routines"
          retrying={routines.isFetching}
          focusAfterRetry={() => heading.current ?? searchInput.current}
        />
      ) : null}
      {searchable && rows.length ? (
        <Field className="mt-4">
          <FieldLabel htmlFor={searchId}>Search routines</FieldLabel>
          <HStack gap={2}>
            <Input
              className="min-h-11 min-w-0 flex-1"
              id={searchId}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              placeholder={
                agentId
                  ? "Title, conversation, schedule, or status"
                  : "Title, Bot, schedule, or status"
              }
              ref={searchInput}
              type="search"
              value={search}
            />
            {search ? (
              <Button
                className="min-h-11"
                onClick={() => {
                  setSearch("");
                  searchInput.current?.focus();
                }}
                type="button"
                variant="ghost"
              >
                Clear search
              </Button>
            ) : null}
          </HStack>
          {words.length ? (
            <p className="text-muted-foreground text-sm" role="status">
              {matches.length} of {rows.length} routines match
            </p>
          ) : null}
        </Field>
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
      ) : !matches.length ? (
        <PageEmpty icon={IconListSearch} title="No matching routines">
          Try a shorter title or search for Enabled or Paused.
        </PageEmpty>
      ) : (
        <PageRows>
          {matches.map((routine, index) => (
            <Fragment key={routine.id}>
              {index > 0 ? <Separator /> : null}
              <RoutineRow
                bot={bots.get(routine.agentId)}
                canChange={routines.isSuccess}
                historyOpen={historyId === routine.id}
                onDelete={(trigger) =>
                  requestConfirmation({
                    title: `Delete “${routine.title ?? routine.schedule}”?`,
                    description: `Scheduled ${routine.schedule} (${routine.timezone}). This routine stops for good. You can't undo this.`,
                    confirmLabel: "Delete routine",
                    pendingLabel: "Deleting…",
                    failureMessage: "Couldn’t delete this routine. Try again.",
                    successMessage: "Routine deleted.",
                    trigger,
                    fallbackFocus: () => searchInput.current ?? heading.current,
                    refresh: () => routines.refetch(),
                    run: async () => {
                      const { data } = await routines.refetch({
                        throwOnError: true,
                      });
                      const latest = data?.routines.find(
                        ({ id }) => id === routine.id,
                      );
                      if (
                        !latest ||
                        latest.title !== routine.title ||
                        latest.instruction !== routine.instruction ||
                        latest.schedule !== routine.schedule ||
                        latest.timezone !== routine.timezone ||
                        latest.enabled !== routine.enabled ||
                        latest.agentId !== routine.agentId ||
                        latest.channel.id !== routine.channel.id
                      ) {
                        throw new ActionUnavailable(
                          "This routine changed or is no longer available. Close this dialog and check the list.",
                        );
                      }
                      try {
                        await deleteRoutine.mutateAsync(routine.id);
                      } catch (error) {
                        if (error instanceof ClientError && error.status < 500)
                          throw error;
                        throw new ActionUnavailable(
                          "Deletion could not be confirmed. Check the list before trying again.",
                        );
                      }
                    },
                  })
                }
                onHistoryChange={setHistoryId}
                routine={routine}
                runHelpId={showRunHelp ? runHelpId : undefined}
                showBot={agentId === undefined}
              />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
