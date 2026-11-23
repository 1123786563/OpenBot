import { IconDeviceMobile, IconDevices, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { DeviceAction } from "@/components/astryx-pilot/device-action";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  deliveryQueryOptions,
  type Reachability,
  removePushDeviceMutationOptions,
} from "@/lib/delivery";
import { queryClient } from "@/query-client";

/** Placeholder rows while a list loads: enough to hold its shape, claiming nothing. */
const LOADING_ROWS = ["a", "b", "c", "d"];

const PLATFORM: Record<"ios" | "android", string> = {
  ios: "iOS",
  android: "Android",
};

type Delivery = Reachability["deliveries"][number];

/** Each channel as the switches under "Where updates go" name it. */
const CHANNEL: Record<Delivery["transport"], string> = {
  push: "Push",
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "SMS",
};

/**
 * What a delivery was about, as the kind of update it was routed under in "Where updates go", so a
 * row can be matched to the switch that let it through: a Bot's reply goes out as Progress, an
 * approval as a Decision, and a check-in ping as Something needs you.
 */
const KIND: Record<Delivery["kind"], string> = {
  reply: "Progress",
  approval: "Decision",
  question: "Question",
  attention: "Something needs you",
};

/**
 * Where a delivery got to. `accepted` is the provider taking it without saying yet that it arrived,
 * and `unknown` is a send that may or may not have gone; the error under the row says which.
 */
const STATE: Record<Delivery["state"], string> = {
  queued: "Waiting to send",
  running: "Sending",
  accepted: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  unknown: "Not confirmed",
  opted_out: "Not sent",
};

/** The phones that receive push notifications for every one of the person's Bots. */
export function NativeDevices() {
  const reach = useQuery(deliveryQueryOptions());
  const remove = useMutation(removePushDeviceMutationOptions(queryClient));
  /*
   * Removal asks first: it takes push notifications off a phone the person may not be holding,
   * and the row that named what would be lost disappears the moment it happens.
   */
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const error = reach.error ?? remove.error;
  return (
    <AstryxSurface className="min-w-0">
      <PageSection
        description="Sign in to the OpenBot app on your phone and turn on notifications to add it here."
        title="Your devices"
      >
        {confirmation}
        {reach.error ? (
          /*
           * A failed read is the section's whole answer: the empty state below must not claim
           * "No devices yet" about a list that could not be read, and the failure gets its own
           * Retry instead of a reload.
           */
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p className="text-destructive text-sm" role="alert">
              Couldn't load your devices.
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
        ) : error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't remove this device. Try again.
          </p>
        ) : null}
        {reach.isPending ? (
          <div aria-busy="true" aria-label="Loading your devices" role="status">
            <PageRows>
              {LOADING_ROWS.map((key, index) => (
                <Fragment key={key}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <Skeleton className="size-full" />
                    </ItemMedia>
                    <ItemContent className="gap-1.5">
                      <Skeleton className="h-3.5 w-28" />
                    </ItemContent>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
          </div>
        ) : /* Under a failed read the empty state must not render at all: it would say
               "No devices yet" about a list nobody could read. */
        reach.error ? null : !reach.data || reach.data.devices.length === 0 ? (
          <PageEmpty icon={IconDevices} title="No devices yet">
            Phones and computers you sign in on show up here.
          </PageEmpty>
        ) : (
          <PageRows>
            {reach.data.devices.map((device, index) => (
              <Fragment key={device.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconDeviceMobile />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{PLATFORM[device.platform]}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <DeviceAction
                      onClick={() =>
                        requestConfirmation({
                          title: `Remove this ${PLATFORM[device.platform]} device?`,
                          description:
                            "It stops receiving push notifications for your Bots. Signing in on it again adds it back.",
                          confirmLabel: "Remove device",
                          pendingLabel: "Removing…",
                          failureMessage:
                            "Couldn't remove that device. Try again.",
                          variant: "destructive",
                          run: async () => {
                            await remove.mutateAsync(device.id);
                          },
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Remove
                    </DeviceAction>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
    </AstryxSurface>
  );
}

/** What was sent to the person outside the web app, most recent first, with any failure. */
export function RecentDeliveries() {
  const reach = useQuery(deliveryQueryOptions());
  return (
    <PageSection title="Recent deliveries">
      {reach.error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load your recent deliveries.
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
      {reach.isPending ? (
        <div
          aria-busy="true"
          aria-label="Loading recent deliveries"
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
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-64" />
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </div>
      ) : /* Same rule as the devices above: no empty state over an unreadable list. */
      reach.error ? null : !reach.data || reach.data.deliveries.length === 0 ? (
        <PageEmpty icon={IconSend} title="No deliveries yet">
          Notifications sent to your devices show up here.
        </PageEmpty>
      ) : (
        <PageRows>
          {reach.data.deliveries.map((delivery, index) => (
            <Fragment key={delivery.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSend />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{KIND[delivery.kind]}</ItemTitle>
                  <ItemDescription>
                    {CHANNEL[delivery.transport]} · {STATE[delivery.state]} ·{" "}
                    {new Date(delivery.createdAt).toLocaleString()}
                  </ItemDescription>
                  {delivery.error ? (
                    <ItemDescription className="line-clamp-none text-destructive">
                      {delivery.error}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
