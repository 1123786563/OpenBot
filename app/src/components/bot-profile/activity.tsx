import { Text } from "@astryxdesign/core/Text";
import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconChevronRight,
  IconClockPlay,
  IconHelpCircle,
  IconHistory,
  IconListDetails,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type RefObject, useRef } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  type BotActivity,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { canKeepCachedRead } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  routine: "Routine",
  responsibility: "Goal",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

const STATUS_LABEL = new Map([
  ["active", "Active"],
  ["cancelled", "Cancelled"],
  ["delivered", "Result delivered"],
  ["done", "Finished"],
  ["failed", "Failed"],
  ["queued", "Waiting to start"],
  ["retrying", "Trying again"],
  ["running", "Running"],
  ["scheduled", "Scheduled"],
  ["skipped", "Skipped"],
  ["stopped", "Stopped"],
  ["succeeded", "Finished successfully"],
]);

function activityStatus(item: ActivityItem): string {
  const status = item.status.toLowerCase();
  if (status === "waiting for you" || (status === "waiting" && item.needsYou))
    return "Waiting for you";
  if (status === "waiting") return "Waiting for a response";
  const label = STATUS_LABEL.get(status) ?? item.status;
  return item.needsYou ? `${label} · Needs your attention` : label;
}

type ActivityAction = (
  item: ActivityItem,
  trigger: HTMLButtonElement,
  fallbackFocus: () => HTMLElement | null,
) => void;

function useActivityConfirmation(agentId: string) {
  const queryClient = useQueryClient();
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const request: ActivityAction = (item, trigger, fallbackFocus) => {
    const stopping = item.stoppable;
    const action = stopping ? stop : cancel;
    const activity = botActivityQueryOptions(agentId);
    requestConfirmation({
      title: stopping ? "Stop this delegated task?" : "Cancel this follow-up?",
      description: stopping
        ? `“${item.title}” will stop. Any work already done will remain.`
        : `“${item.title}” will no longer run at its scheduled time.`,
      confirmLabel: stopping ? "Stop task" : "Cancel follow-up",
      pendingLabel: stopping ? "Stopping…" : "Cancelling…",
      failureMessage: stopping
        ? "Couldn't confirm that the task stopped. Trying again checks whether it's still active before stopping it."
        : "Couldn't confirm that the follow-up was cancelled. Trying again checks whether it's still scheduled before cancelling it.",
      successMessage: stopping
        ? "Delegated task stopped."
        : "Follow-up cancelled.",
      fallbackFocus,
      trigger,
      refresh: () =>
        queryClient.invalidateQueries({ queryKey: activity.queryKey }),
      run: async () => {
        const latest = await queryClient.fetchQuery({
          ...activity,
          staleTime: 0,
          retry: false,
        });
        const candidates = [
          ...(latest?.inProgress ?? []),
          ...(latest?.scheduled ?? []),
        ];
        const target = candidates.find(
          ({ id, kind }) => id === item.id && kind === item.kind,
        );
        if (!(stopping ? target?.stoppable : target?.cancellable)) {
          throw new ActionUnavailable(
            stopping
              ? "This delegated task is no longer running or queued."
              : "This follow-up is no longer scheduled.",
          );
        }
        await action.mutateAsync({ agentId, id: item.id });
      },
    });
  };
  return { request, confirmation };
}

/** Where an item opens: its conversation when it has one, otherwise the screen that owns its kind. */
function linkFor(item: ActivityItem, agentId: string) {
  if (item.channelId)
    return (
      <Link to="/channel/$channelId" params={{ channelId: item.channelId }} />
    );
  switch (item.kind) {
    case "approval":
    case "question":
      return <Link params={{ agentId }} to="/bots/$agentId" />;
    case "responsibility":
      return <Link params={{ agentId }} to="/bots/$agentId/responsibilities" />;
    case "routine":
      return <Link params={{ agentId }} to="/bots/$agentId/routines" />;
    default:
      return null;
  }
}

function ActivityRow({
  agentId,
  item,
  live = false,
  onAction,
  wrapTitle = false,
}: {
  agentId: string;
  item: ActivityItem;
  onAction?: (item: ActivityItem, trigger: HTMLButtonElement) => void;
  wrapTitle?: boolean;
  /** Under way now: a pulsing dot on its icon, amber when it is waiting on the person. */
  live?: boolean;
}) {
  // Subscribes this row to the interface language, so choosing another one redraws its time in place.
  useTranslation();
  const Icon = ICONS[item.kind];
  const link = linkFor(item, agentId);
  const when = relativeTime(item.at);
  const label = item.stoppable ? "Stop" : "Cancel";
  const control =
    onAction && (item.stoppable || item.cancellable) ? (
      <Button
        aria-label={`${label} ${item.title}`}
        className="max-sm:min-h-11"
        onClick={(event) => onAction(item, event.currentTarget)}
        size="sm"
        variant="outline"
      >
        {label}
      </Button>
    ) : null;
  const content = (
    <>
      <ItemMedia className="relative" variant="icon">
        <Icon />
        {live ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full ring-2 ring-card",
              item.needsYou ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        ) : null}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle
          className={
            wrapTitle
              ? "line-clamp-none [overflow-wrap:anywhere]"
              : "block w-auto truncate"
          }
          title={wrapTitle ? undefined : item.title}
        >
          {item.title}
        </ItemTitle>
        <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
          {KIND_LABEL[item.kind]} · {activityStatus(item)}
          {when ? ` · ${when}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  if (control)
    return (
      <Item size="sm">
        {content}
        <ItemActions className="max-sm:basis-full max-sm:justify-end">
          {link ? (
            <Button
              aria-label={`Open ${item.title}`}
              className="max-sm:min-h-11"
              render={link}
              size="sm"
              variant="ghost"
            >
              Open
            </Button>
          ) : null}
          {control}
        </ItemActions>
      </Item>
    );
  return link ? (
    <Item render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item size="sm">{content}</Item>
  );
}

function ActivitySection({
  agentId,
  empty,
  initialLimit,
  items,
  live = false,
  headingRef,
  onAction,
  title,
}: {
  agentId: string;
  empty: string;
  initialLimit?: number;
  items: ActivityItem[];
  live?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onAction?: ActivityAction;
  title: string;
}) {
  const localHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? localHeading;
  const recent = items.slice(0, initialLimit ?? items.length);
  const earlier = items.slice(recent.length);
  const rows = (entries: ActivityItem[]) => (
    <PageRows>
      {entries.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 ? <Separator /> : null}
          <ActivityRow
            agentId={agentId}
            item={item}
            live={live}
            onAction={
              onAction
                ? (target, trigger) =>
                    onAction(target, trigger, () => heading.current)
                : undefined
            }
            wrapTitle
          />
        </Fragment>
      ))}
    </PageRows>
  );
  return (
    <PageSection
      className={items.length === 0 ? "mt-6" : undefined}
      headingRef={heading}
      title={title}
    >
      {items.length === 0 ? (
        <Text as="p" color="secondary" size="sm">
          {empty}
        </Text>
      ) : (
        rows(recent)
      )}
      {earlier.length > 0 ? (
        <details style={{ marginBlockStart: "var(--spacing-3)" }}>
          <summary
            style={{
              cursor: "pointer",
              minBlockSize: "var(--spacing-11)",
              paddingBlock: "var(--spacing-3)",
            }}
          >
            {earlier.length} earlier{" "}
            {earlier.length === 1 ? "completion" : "completions"}
          </summary>
          {rows(earlier)}
        </details>
      ) : null}
    </PageSection>
  );
}

/** How many running or scheduled items the Bot's page shows before "All activity". */
const GLANCE = 3;

/**
 * Running work first, then what is lined up, then the goals that wait to be asked, as many as the
 * Bot's page shows.
 */
function upcomingOf(activity: BotActivity | null | undefined) {
  return activity
    ? [
        ...activity.inProgress.map((item) => ({ item, live: true })),
        ...activity.scheduled.map((item) => ({ item, live: false })),
        ...(activity.onDemand ?? []).map((item) => ({ item, live: false })),
      ].slice(0, GLANCE)
    : [];
}

/**
 * The Bot page's view of its activity: what is under way and what is lined up, so either is seen
 * without opening anything, then a row to the full lists. Running work comes first, with its dot.
 *
 * Only when there is something running or lined up. With nothing to show, a whole section for one
 * row to the full lists is a heading over nothing; that row joins "For you" instead, through
 * `BotActivityRow`.
 *
 * The full lists used to sit here and ran on for screens; finished work is the long part and the
 * least urgent, so it lives only on the Activity page.
 */
export function BotActivityGlance({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  const heading = useRef<HTMLHeadingElement>(null);
  const { request, confirmation } = useActivityConfirmation(agentId);
  const upcoming = upcomingOf(activity.data);
  return (
    <>
      {confirmation}
      {activity.isPending || upcoming.length === 0 ? null : (
        <PageSection headingRef={heading} title="Activity">
          <PageRows>
            {upcoming.map(({ item, live }) => (
              <Fragment key={item.id}>
                <ActivityRow
                  agentId={agentId}
                  item={item}
                  live={live}
                  onAction={
                    activity.isSuccess
                      ? (target, trigger) =>
                          request(target, trigger, () => heading.current)
                      : undefined
                  }
                />
                <Separator />
              </Fragment>
            ))}
            <AllActivityItem activity={activity.data} agentId={agentId} />
          </PageRows>
        </PageSection>
      )}
    </>
  );
}

/**
 * The row to a Bot's activity, inside "For you", for when nothing is running or lined up and
 * `BotActivityGlance` draws no section of its own. Starts with a separator, because it follows the
 * card's other rows.
 */
export function BotActivityRow({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending || upcomingOf(activity.data).length > 0) return null;
  return (
    <>
      <Separator />
      <AllActivityItem
        activity={activity.data}
        agentId={agentId}
        title="Activity"
        withIcon
      />
    </>
  );
}

function AllActivityItem({
  activity,
  agentId,
  title = "All activity",
  withIcon = false,
}: {
  activity: BotActivity | null | undefined;
  agentId: string;
  title?: string;
  withIcon?: boolean;
}) {
  return (
    <Item
      render={<Link params={{ agentId }} to="/bots/$agentId/activity" />}
      size="sm"
    >
      {withIcon ? (
        <ItemMedia variant="icon">
          <IconHistory />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>
          {activity
            ? activitySummary(activity)
            : "Couldn't load this Bot's activity."}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * The Bot page's one line about its activity: what is running, what is lined up and which goals
 * wait to be asked. Finished work is only counted when there is nothing else to say. A goal that
 * runs only when asked is never "scheduled": it was, and a Bot with one routine read "2 scheduled".
 */
export function activitySummary(activity: BotActivity): string {
  const onDemand = activity.onDemand?.length ?? 0;
  const parts = [
    activity.inProgress.length
      ? `${activity.inProgress.length} in progress`
      : null,
    activity.scheduled.length ? `${activity.scheduled.length} scheduled` : null,
    onDemand ? `${onDemand} on demand` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return activity.completed.length
    ? "Nothing running or scheduled"
    : "No tasks, routines or goals yet";
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  const { request, confirmation } = useActivityConfirmation(agentId);
  const heading = useRef<HTMLHeadingElement>(null);
  const readable = canKeepCachedRead(activity.error) && activity.data !== null;
  const history = readable ? activity.data : undefined;
  const current = activity.isSuccess;
  return (
    <>
      {confirmation}
      {activity.isPending ? (
        <ReadStatus kind="loading" message="Loading Bot activity…" />
      ) : activity.isError ? (
        <section aria-label="Activity status" className="mt-4">
          <ReadError
            description={
              history ? "Showing the last loaded activity." : undefined
            }
            focusAfterRetry={() => heading.current}
            message="Couldn’t load this Bot’s activity"
            retry={activity.refetch}
            retryBelow
            retrying={activity.isFetching}
          />
        </section>
      ) : null}
      {history ? (
        <>
          <ActivitySection
            agentId={agentId}
            empty="Nothing is running or waiting on you."
            headingRef={heading}
            items={history.inProgress}
            live={current}
            onAction={current ? request : undefined}
            title="In progress"
          />
          <ActivitySection
            agentId={agentId}
            empty="Nothing is scheduled."
            items={history.scheduled}
            onAction={current ? request : undefined}
            title="Scheduled"
          />
          {history.onDemand?.length ? (
            <ActivitySection
              agentId={agentId}
              empty=""
              items={history.onDemand}
              title="On demand"
            />
          ) : null}
          <ActivitySection
            agentId={agentId}
            empty="No tasks, routines or goals have finished yet."
            initialLimit={5}
            items={history.completed}
            title="Completed"
          />
        </>
      ) : null}
      {readable ? <BotActionsSection agentId={agentId} /> : null}
    </>
  );
}

/**
 * Where this Bot's actions are: the audit trail, narrowed to it.
 *
 * The lists above are tasks, routines and goals. A file saved, a page opened or an app called in a
 * conversation is none of those, so a Bot could work all day and this page said nothing had
 * finished. Those actions are recorded once, in the trail, with whether each was allowed, blocked
 * or did not happen; this links there rather than keeping a second copy here. Only for someone who
 * can open the trail: Settings › Activity in the personal edition, Admin › Audit for an admin.
 */
function BotActionsSection({ agentId }: { agentId: string }) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const admin = useQuery(currentUserQueryOptions()).data?.role === "admin";
  if (!personal && !admin) return null;
  return (
    <PageSection title="Actions">
      <PageRows>
        <Item
          render={
            personal ? (
              <Link search={{ bot: agentId }} to="/settings/activity" />
            ) : (
              <Link search={{ bot: agentId }} to="/admin/audit" />
            )
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconListDetails />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Every action this Bot took</ItemTitle>
            <ItemDescription className="line-clamp-none">
              See the files, pages and apps it used, and which were allowed,
              blocked or didn't happen.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
