import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconClockPlay,
  IconHelpCircle,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

/* Key literals stay literal so `t(...)` sees a known key, not `string`. */
const KIND_LABEL = {
  routine: "botActivity.kind.routine",
  responsibility: "botActivity.kind.responsibility",
  handoff: "botActivity.kind.handoff",
  approval: "botActivity.kind.approval",
  question: "botActivity.kind.question",
  follow_up: "botActivity.kind.followUp",
} as const satisfies Record<ActivityKind, string>;

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
}: {
  agentId: string;
  item: ActivityItem;
}) {
  const { t } = useTranslation("computer");
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  const link = linkFor(item, agentId);
  const when = relativeTime(item.at);
  const control = item.stoppable ? (
    <Button
      disabled={stop.isPending}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {stop.isPending ? t("botActivity.stopping") : t("botActivity.stop")}
    </Button>
  ) : item.cancellable ? (
    <Button
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? t("botActivity.cancelling") : t("botActivity.cancel")}
    </Button>
  ) : null;
  const content = (
    <>
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {t(KIND_LABEL[item.kind])} ·{" "}
          {item.needsYou ? t("botActivity.needsYou") : item.status}
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
        <ItemActions>
          {link ? (
            <Button render={link} size="sm" variant="ghost">
              {t("botActivity.open")}
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
  items,
  title,
}: {
  agentId: string;
  empty: string;
  items: ActivityItem[];
  title: string;
}) {
  return (
    <PageSection title={title}>
      {items.length === 0 ? (
        <PageEmpty>{empty}</PageEmpty>
      ) : (
        <PageRows>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <Separator /> : null}
              <ActivityRow agentId={agentId} item={item} />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const { t } = useTranslation("computer");
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title={t("botActivity.title")}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("botActivity.loadError")}
        </p>
      </PageSection>
    );
  return (
    <>
      <ActivitySection
        agentId={agentId}
        empty={t("botActivity.emptyInProgress")}
        items={activity.data.inProgress}
        title={t("botActivity.inProgress")}
      />
      <ActivitySection
        agentId={agentId}
        empty={t("botActivity.emptyScheduled")}
        items={activity.data.scheduled}
        title={t("botActivity.scheduled")}
      />
      <ActivitySection
        agentId={agentId}
        empty={t("botActivity.emptyCompleted")}
        items={activity.data.completed}
        title={t("botActivity.completed")}
      />
    </>
  );
}
