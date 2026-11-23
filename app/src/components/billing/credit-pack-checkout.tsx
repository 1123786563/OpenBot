import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import { z } from "zod";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  billingKeys,
  creditsText,
  paidSourcesQueryOptions,
} from "@/lib/billing/queries";
import { ClientError, client } from "@/lib/client";

const channels = {
  WeChat: "/api/billing/paid/credit-pack",
  Alipay: "/api/billing/paid/credit-pack/alipay",
};
type Channel = keyof typeof channels;

const orderListKey = (channel: Channel) => [
  ...billingKeys.all,
  "credit-pack-orders",
  channel,
];

const pack = z.object({
  priceCents: z.number().int().positive(),
  creditsMicrocredits: z.string().regex(/^\d+$/),
});
const offerSchema = z.object({
  product: pack
    .extend({
      version: z.number().int().positive(),
      currency: z.literal("CNY"),
    })
    .nullable(),
  available: z.boolean(),
  blockedReason: z.string().nullable(),
  pausedApplications: z.array(z.string()),
});

const states = {
  pending: "Awaiting payment confirmation",
  verified: "Credits added",
  failed: "Closed",
  refund_pending: "Refund pending",
  refunded: "Refunded",
};

const refundStatuses = (channel: Channel) => ({
  requested: `Waiting for ${channel} refund processing.`,
  processing: `${channel} is processing your refund.`,
  manual_review: "Your refund is under manual review.",
  manual_owed: `${channel} could not return the funds. A manual refund is pending.`,
  confirmed: "Refund confirmed. Funds returned.",
  failed: "The refund failed. Any credits frozen for it are available again.",
});

const orderSchema = pack.extend({
  id: z.uuid(),
  state: z.enum([
    "pending",
    "verified",
    "failed",
    "refund_pending",
    "refunded",
  ]),
  entitlementId: z.string().nullable(),
  creditsFrozen: z.boolean().optional(),
  refund: z
    .object({
      id: z.uuid(),
      amountCents: z.number().int().positive(),
      state: z.enum([
        "requested",
        "processing",
        "manual_review",
        "manual_owed",
        "confirmed",
        "failed",
      ]),
    })
    .nullish(),
});
type Order = z.infer<typeof orderSchema>;

function packText({
  priceCents,
  creditsMicrocredits,
}: {
  priceCents: number;
  creditsMicrocredits: string;
}) {
  return `CN¥${(priceCents / 100).toFixed(2)} · ${creditsText(creditsMicrocredits)} credits`;
}

function OrderRow({ order, channel }: { order: Order; channel: Channel }) {
  const queryClient = useQueryClient();
  const [confirmRefund, setConfirmRefund] = useState(false);
  const sources = useQuery(paidSourcesQueryOptions());
  const source = sources.data?.find(
    ({ entitlementId }) => entitlementId === order.entitlementId,
  );
  const orderPath = `${channels[channel]}/orders/${encodeURIComponent(order.id)}`;
  const checkout = useMutation({
    mutationFn: async () => {
      const url = z.url().parse(
        await client<unknown>(`${orderPath}/checkout`, "checkoutUrl", {
          method: "POST",
        }),
      );
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
        throw new Error("The test checkout URL is invalid.");
      return url;
    },
  });
  const refreshCredits = () =>
    Promise.all(
      [
        orderListKey(channel),
        billingKeys.paidBalance,
        billingKeys.paidSources,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  const verify = useMutation({
    mutationFn: async (): Promise<Order> =>
      orderSchema.parse(
        await (await client(`${orderPath}/verify`, { method: "POST" })).json(),
      ),
    onSuccess: refreshCredits,
  });
  const refundAction = useMutation({
    mutationFn: (action: "request" | "verify") =>
      client(`${orderPath}/refund${action === "verify" ? "/verify" : ""}`, {
        method: "POST",
      }),
    onSuccess: () => setConfirmRefund(false),
    onSettled: refreshCredits,
  });
  return (
    <Item>
      <ItemContent>
        <ItemTitle>{packText(order)}</ItemTitle>
        <ItemDescription>Order {order.id}</ItemDescription>
        {order.refund ? (
          <>
            <Text>
              Refund amount CN¥{(order.refund.amountCents / 100).toFixed(2)}
            </Text>
            <Text role="status">
              {order.creditsFrozen ? "Credits frozen. " : ""}
              {refundStatuses(channel)[order.refund.state]}
            </Text>
          </>
        ) : (
          <Text role="status">{states[order.state]}</Text>
        )}
        {source ? (
          <Link href={`#paid-source-${source.entitlementId}`}>
            View paid credit source
          </Link>
        ) : null}
        <HStack gap={2} wrap="wrap">
          {order.state === "pending" &&
            (checkout.data ? (
              <Link href={checkout.data} isExternalLink>
                Open test checkout
              </Link>
            ) : (
              <Button
                isDisabled={checkout.isPending}
                label="Prepare test checkout"
                onClick={() => checkout.mutate()}
              />
            ))}
          {(order.state === "pending" || order.state === "failed") && (
            <Button
              isDisabled={verify.isPending}
              label="Check payment"
              onClick={() => verify.mutate()}
            />
          )}
          {order.state === "verified" && !order.refund && (
            <Button
              label="Request refund"
              onClick={() => {
                refundAction.reset();
                setConfirmRefund(true);
              }}
            />
          )}
          {order.refund &&
            order.refund.state !== "confirmed" &&
            order.refund.state !== "failed" && (
              <Button
                label="Check refund status"
                isLoading={refundAction.isPending}
                onClick={() => refundAction.mutate("verify")}
              />
            )}
        </HStack>
        {verify.data?.state === "pending" && order.state === "pending" ? (
          <Text role="status">
            The channel has yet to confirm this payment.
          </Text>
        ) : null}
        {checkout.error || verify.error ? (
          <Text role="alert">{(checkout.error ?? verify.error)?.message}</Text>
        ) : null}
        {refundAction.error && (!confirmRefund || order.refund) ? (
          <Text role="alert">{refundAction.error.message}</Text>
        ) : null}
        {confirmRefund && !order.refund ? (
          <Dialog
            isOpen
            purpose="form"
            onOpenChange={(open) => {
              if (!open && !refundAction.isPending) setConfirmRefund(false);
            }}
          >
            <VStack gap={3}>
              <DialogHeader title={`Request ${channel} refund`} />
              <Text>
                Request CN¥{(order.priceCents / 100).toFixed(2)} back through
                the {channel} test channel. If eligible, this order’s credits
                will be frozen while the refund is processed. Used credits
                require manual review.
              </Text>
              {refundAction.error ? (
                <Text role="alert">{refundAction.error.message}</Text>
              ) : null}
              <HStack justify="end" gap={2} wrap="wrap">
                <Button
                  label="Cancel"
                  isDisabled={refundAction.isPending}
                  onClick={() => setConfirmRefund(false)}
                />
                <Button
                  label="Confirm refund request"
                  variant="primary"
                  isLoading={refundAction.isPending}
                  onClick={() => refundAction.mutate("request")}
                />
              </HStack>
            </VStack>
          </Dialog>
        ) : null}
      </ItemContent>
    </Item>
  );
}

export function CreditPackCheckout() {
  return (
    <>
      <ChannelCheckout channel="WeChat" />
      <ChannelCheckout channel="Alipay" />
    </>
  );
}

function ChannelCheckout({ channel }: { channel: Channel }) {
  const path = channels[channel];
  const offerKey = [...billingKeys.all, "credit-pack-offer", channel];
  const ordersKey = orderListKey(channel);
  const queryClient = useQueryClient();
  const offer = useQuery({
    queryKey: offerKey,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return offerSchema.parse(await (await client(path, { signal })).json());
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const orders = useQuery({
    queryKey: ordersKey,
    enabled: Boolean(offer.data) || offer.isError,
    retry: false,
    queryFn: async ({ signal }) =>
      z
        .array(orderSchema)
        .parse(await (await client(`${path}/orders`, { signal })).json()),
  });
  const attempt = useRef<{ orderId: string; version: number }>(null);
  const place = useMutation({
    mutationFn: async (version: number) => {
      if (attempt.current?.version !== version)
        attempt.current = { version, orderId: crypto.randomUUID() };
      await client(`${path}/orders`, { method: "POST", body: attempt.current });
    },
    onSuccess: async () => {
      attempt.current = null;
      await queryClient.invalidateQueries({ queryKey: ordersKey });
    },
    onError: async (error) => {
      if (error instanceof ClientError && error.status === 409)
        await queryClient.invalidateQueries({ queryKey: offerKey });
    },
  });
  if (!offer.data && !offer.isError) return null;
  const product = offer.data?.product;
  return (
    <PageSection
      description={`${channel} test channel. Orders use simulated payments and add long-lived paid credits.`}
      title={
        channel === "WeChat" ? "Test Credit Pack" : "Alipay Test Credit Pack"
      }
    >
      <PageRows>
        <Item>
          <ItemContent>
            {product ? <ItemTitle>{packText(product)}</ItemTitle> : null}
            {offer.data?.pausedApplications.length ? (
              <Text>
                Paused application paths:{" "}
                {offer.data.pausedApplications.join(", ")}
              </Text>
            ) : null}
            {offer.data?.blockedReason ? (
              <Text>{offer.data.blockedReason}</Text>
            ) : null}
            {offer.error ? (
              <HStack gap={2} wrap="wrap" align="center">
                <Text role="alert">{offer.error.message}</Text>
                <Button
                  isDisabled={offer.isFetching}
                  label="Retry offer"
                  onClick={() => void offer.refetch()}
                />
              </HStack>
            ) : null}
            {product && offer.data?.available && (
              <HStack>
                <Button
                  isDisabled={place.isPending}
                  label={
                    channel === "WeChat"
                      ? "Place test order"
                      : "Place Alipay test order"
                  }
                  onClick={() => place.mutate(product.version)}
                />
              </HStack>
            )}
            {place.error ? (
              <Text role="alert">{place.error.message}</Text>
            ) : null}
          </ItemContent>
        </Item>
        {orders.isError ? (
          <Item>
            <Text role="alert">{orders.error.message}</Text>
            <Button
              isDisabled={orders.isFetching}
              label="Retry orders"
              onClick={() => void orders.refetch()}
            />
          </Item>
        ) : null}
        {orders.data?.map((order) => (
          <Fragment key={order.id}>
            <Separator />
            <OrderRow order={order} channel={channel} />
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
