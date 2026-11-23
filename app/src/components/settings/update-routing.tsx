import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deliveryQueryOptions } from "@/lib/delivery";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { mayOpenSetup } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * How each channel is turned on: Slack and Teams through an OpenTag pairing, text messages through Twilio, push through
 * the OpenBot phone app. Each is a setting where OpenBot runs, read at start-up, so the docs say what to set; the two
 * sections sit together there. The setup checklist links the same page for Slack and Teams.
 */
export const CHANNEL_SETUP_DOCS =
  "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md#slack-and-microsoft-teams-opentag-pairing";

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "Progress",
    description: "Replies and results from work you weren't watching.",
  },
  decision: {
    title: "Decisions",
    description: "Approvals a Bot needs before it acts.",
  },
  question: {
    title: "Questions",
    description: "Things a Bot asked you and is waiting on.",
  },
  attention: {
    title: "Something needs you",
    description:
      "What your Bots' check-ins found, at most once an hour, every Bot in one message.",
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

/**
 * Which channels each kind of update may use, for every one of the person's Bots at once. How much
 * a given Bot sends is that Bot's own Notifications setting, on its page.
 */
export function UpdateRoutingSection() {
  const routing = useQuery(updateRoutingQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const save = useMutation({
    ...setUpdateRoutingMutationOptions(queryClient),
    /*
     * A switch that silently springs back is a tap that "didn't take": the revert is right (the
     * server refused), and this line under the switches says so instead of nothing at all.
     */
    onError: () => setSaveFailed(true),
    onMutate: () => setSaveFailed(false),
  });
  const [saveFailed, setSaveFailed] = useState(false);
  /*
   * Who can turn a channel on: an admin, or the one person running OpenBot themselves (the same rule as Settings,
   * Setup). They get the way to; anyone else is told it's their admin's to do.
   */
  const user = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const setsUp = mayOpenSetup(user.data, capabilities.data);
  /*
   * A channel this deployment has not set up can carry nothing, so its switch is off and disabled
   * whatever the stored preference says, rather than on beside a channel that delivers nothing. The
   * preference itself is left alone: an administrator who configures Slack later finds it as the
   * person last set it. When the deployment's channels could not be read, the preference is shown
   * as it is rather than every channel claimed unavailable.
   */
  const configured = (transport: UpdateTransport) =>
    reach.data ? reach.data.available[transport] : true;
  /*
   * Only the channels that can carry something get a switch. A channel that is not set up has nothing to choose, and
   * four rows of switches nobody can turn on said less than one sentence does. Its stored preference is kept as it is
   * and shows again once the channel is set up.
   */
  const shown = TRANSPORTS.filter((transport) => configured(transport.id));
  const choosing =
    !routing.isPending &&
    !reach.isPending &&
    !routing.error &&
    shown.length > 0;
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load where your updates go.
          </p>
          <Button
            disabled={routing.isFetching}
            onClick={() => void routing.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {routing.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
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
                    <ItemDescription>
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="flex-wrap justify-start gap-x-6 gap-y-3 pl-8">
                    {shown.map(({ id, label }) => {
                      const checked = allowed(id);
                      const name = `${KIND_LABEL[kind].title} by ${label}`;
                      const setChecked = (next: boolean) => {
                        const selected = TRANSPORTS.map((t) => t.id).filter(
                          (key) => (key === id ? next : allowed(key)),
                        );
                        save.mutate({
                          kind,
                          transports:
                            selected.length === TRANSPORTS.length
                              ? "all"
                              : selected,
                        });
                      };
                      /*
                       * A channel switched on whose newest delivery failed is a promise the page
                       * breaks silently: the switch says SMS, nothing arrives. The reason (the
                       * delivery's own error) is on the hint's tooltip.
                       */
                      const latest = reach.data?.deliveries.find(
                        (delivery) => delivery.transport === id,
                      );
                      const notGettingThrough =
                        checked && latest?.state === "failed";
                      return (
                        <div
                          className="flex items-center gap-2 text-sm"
                          key={id}
                        >
                          <AstryxSwitch
                            isLabelHidden
                            isLoading={save.isPending}
                            label={name}
                            onChange={setChecked}
                            size="sm"
                            value={checked}
                          />
                          <span className="leading-tight whitespace-nowrap">
                            {label}
                          </span>
                          {notGettingThrough ? (
                            <span
                              className="leading-tight text-amber-700 text-xs dark:text-amber-400"
                              title={latest.error ?? undefined}
                            >
                              Recent deliveries are failing.
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
      {saveFailed ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't save that. The switches show what the server last saved.
        </p>
      ) : null}
      {/*
       * The channels read failing costs the switches their setup state, not the page its
       * preferences, so it is said beside them rather than instead of them.
       */}
      {!routing.isPending && !reach.isPending && reach.error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't check which channels are set up.
          </p>
          <Button
            disabled={reach.isFetching}
            onClick={() => void reach.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {reach.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
    </PageSection>
  );
}
