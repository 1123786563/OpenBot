import { HStack } from "@astryxdesign/core/HStack";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { VStack } from "@astryxdesign/core/VStack";
import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useRef } from "react";

import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setUpdateRouting } from "@/lib/bot-lifecycle/mutations";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deliveryQueryOptions, type Reachability } from "@/lib/delivery";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { mayOpenSetup } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";

/**
 * How each channel is turned on: Slack and Teams through an OpenTag pairing, text messages through Twilio, push through
 * the OpenBot phone app. Each is a setting where OpenBot runs, read at start-up, so the docs say what to set; the two
 * sections sit together there. The setup checklist links the same page for Slack and Teams.
 */
export const CHANNEL_SETUP_DOCS =
  "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md#slack-and-microsoft-teams-opentag-pairing";

const KIND_LABEL: Record<
  UpdateKind,
  {
    title: string;
    description: string;
    deliveryKind: Reachability["deliveries"][number]["kind"];
  }
> = {
  progress: {
    title: "Progress",
    description: "Replies and results from work you weren't watching.",
    deliveryKind: "reply",
  },
  decision: {
    title: "Approvals",
    description: "Requests to approve an action before a Bot proceeds.",
    deliveryKind: "approval",
  },
  question: {
    title: "Questions",
    description: "Things a Bot asked you and is waiting on.",
    deliveryKind: "question",
  },
  attention: {
    title: "Something needs you",
    description:
      "What your Bots' check-ins found, at most once an hour, every Bot in one message.",
    deliveryKind: "attention",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "SMS" },
];

/** Placeholder rows while the routing loads: the four kinds, claiming nothing. */
const LOADING_ROWS = ["a", "b", "c", "d"];

type RoutingChange = {
  kind: UpdateKind;
  transport: UpdateTransport;
  enabled: boolean;
  retry?: true;
};

/**
 * Which channels each kind of update may use, for every one of the person's Bots at once. How much
 * a given Bot sends is that Bot's own Notifications setting, on its page.
 */
export function UpdateRoutingSection() {
  const queryClient = useQueryClient();
  const routing = useQuery(updateRoutingQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const heading = useRef<HTMLHeadingElement>(null);
  const deliveryStatusId = useId();
  const focusHeading = () => heading.current;
  const save = useMutation({
    mutationFn: async (change: RoutingChange) => {
      const [preferences, channels] = change.retry
        ? await Promise.all([
            routing.refetch({ throwOnError: true }),
            reach.refetch({ throwOnError: true }),
          ])
        : [routing, reach];
      if (!preferences.data || !channels.data?.available[change.transport]) {
        throw new Error("This delivery channel is unavailable.");
      }
      const current = preferences.data[change.kind];
      const allowed = (transport: UpdateTransport) =>
        current === "all" || current.includes(transport);
      if (allowed(change.transport) === change.enabled) return;
      const selected = TRANSPORTS.map(({ id }) => id).filter((id) =>
        id === change.transport ? change.enabled : allowed(id),
      );
      await setUpdateRouting({
        queryClient,
        kind: change.kind,
        transports: selected.length === TRANSPORTS.length ? "all" : selected,
      });
    },
  });
  const failed =
    save.isError || (save.isPending && save.variables?.retry)
      ? save.variables
      : undefined;
  const failedTransport = TRANSPORTS.find(({ id }) => id === failed?.transport);
  const failedName =
    failed && failedTransport
      ? `${KIND_LABEL[failed.kind].title} by ${failedTransport.label}`
      : undefined;
  /*
   * Who can turn a channel on: an admin, or the one person running OpenBot themselves (the same rule as Settings,
   * Setup). They get the way to; anyone else is told it's their admin's to do.
   */
  const user = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const setsUp = mayOpenSetup(user.data, capabilities.data);
  /*
   * Only the channels that can carry something get a switch. A channel that is not set up has nothing to choose, and
   * four rows of switches nobody can turn on said less than one sentence does. Its stored preference is kept as it is
   * and shows again once the channel is set up.
   */
  const shown = TRANSPORTS.filter(({ id }) => reach.data?.available[id]);
  const choosing = routing.isSuccess && reach.isSuccess && shown.length > 0;
  /*
   * OpenBot Desktop runs OpenBot on this computer, and every one of these channels needs OpenBot where the internet can
   * reach it (a phone, OpenTag, Twilio calling it). Its settings are the Desktop's own, so it gets no link to them.
   */
  const desktop = desktopShell() !== null;
  return (
    <PageSection
      // Said only above the switches: above the empty state it would point at nothing to choose.
      description={
        choosing
          ? "Choose where to receive each type of update when you’re away. All updates remain available in the web app."
          : undefined
      }
      headingRef={heading}
      title="Where updates go"
    >
      {routing.isPending || reach.isPending ? (
        <div
          aria-busy="true"
          aria-label="Loading where updates go"
          role="status"
        >
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <Fragment key={key}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Skeleton className="size-full" />
                  </ItemMedia>
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3 w-64" />
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </div>
      ) : routing.error ? (
        <ReadError
          focusAfterRetry={focusHeading}
          message="Couldn't load where your updates go."
          retry={routing.refetch}
          retryBelow
          retryLabel="Retry notification preferences"
          retrying={routing.isFetching}
        />
      ) : reach.error ? (
        <ReadError
          description="Check which channels are available before changing where updates go."
          focusAfterRetry={focusHeading}
          message="Couldn't check which channels are set up."
          retry={reach.refetch}
          retryBelow
          retryLabel="Retry delivery channels"
          retrying={reach.isFetching}
        />
      ) : shown.length === 0 ? (
        <PageEmpty
          action={
            setsUp && !desktop ? (
              // An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link.
              <a
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                )}
                href={CHANNEL_SETUP_DOCS}
                rel="noopener noreferrer"
                target="_blank"
              >
                How to set them up
              </a>
            ) : undefined
          }
          icon={IconRoute}
          title="Updates stay in OpenBot"
        >
          {desktop
            ? "Push, Slack, Microsoft Teams and text messages need OpenBot running on a server."
            : setsUp
              ? "Push, Slack, Microsoft Teams and text messages show up here once they're set up where OpenBot runs."
              : "Push, Slack, Microsoft Teams and text messages show up here once your admin sets them up."}
        </PageEmpty>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="grid grid-cols-2 items-start justify-start gap-x-3 gap-y-3 sm:gap-x-6 sm:pl-8 lg:grid-cols-4">
                    {shown.map(({ id, label }) => {
                      const checked = allowed(id);
                      const name = `${KIND_LABEL[kind].title} by ${label}`;
                      const latest = reach.data?.deliveries.find(
                        (delivery) =>
                          delivery.transport === id &&
                          delivery.kind === KIND_LABEL[kind].deliveryKind,
                      );
                      const notGettingThrough =
                        checked && latest?.state === "failed";
                      const statusId = `${deliveryStatusId}-${kind}-${id}`;
                      return (
                        <VStack
                          align="start"
                          className="min-w-0"
                          gap={1}
                          key={id}
                        >
                          <HStack align="center" gap={2}>
                            <AstryxSwitch
                              aria-describedby={
                                notGettingThrough ? statusId : undefined
                              }
                              isLabelHidden
                              isLoading={save.isPending}
                              label={name}
                              onChange={(enabled) =>
                                save.mutate({ kind, transport: id, enabled })
                              }
                              size="sm"
                              value={checked}
                            />
                            <span className="text-sm leading-tight">
                              {label}
                            </span>
                          </HStack>
                          {notGettingThrough ? (
                            latest.error ? (
                              <details className="max-w-full text-amber-700 text-sm dark:text-amber-400">
                                <summary
                                  className="min-h-11 cursor-pointer py-2"
                                  id={statusId}
                                >
                                  Latest {label} delivery failed
                                </summary>
                                <p className="[overflow-wrap:anywhere]">
                                  {latest.error}
                                </p>
                              </details>
                            ) : (
                              <p
                                className="text-amber-700 text-sm dark:text-amber-400"
                                id={statusId}
                              >
                                Latest {label} delivery failed
                              </p>
                            )
                          ) : null}
                        </VStack>
                      );
                    })}
                  </ItemFooter>
                </Item>
                {failed?.kind === kind && failedName ? (
                  <ReadError
                    description={
                      reach.data.available[failed.transport]
                        ? "The switches show your last saved preferences."
                        : "This channel is no longer set up."
                    }
                    focusAfterRetry={focusHeading}
                    message={`Couldn't save ${failedName}.`}
                    retry={() =>
                      save
                        .mutateAsync({ ...failed, retry: true })
                        .catch(() => undefined)
                    }
                    retryBelow
                    retryLabel={`Retry saving ${failedName}`}
                    retrying={save.isPending}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}
