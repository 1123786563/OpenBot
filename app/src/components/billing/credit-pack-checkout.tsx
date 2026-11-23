import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import { z } from "zod";
import { PaymentDisputeDetails } from "@/components/billing/payment-dispute";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  beijingBillingTime,
  billingKeys,
  creditsText,
  paidSourcesQueryOptions,
  paymentDisputeSchema,
} from "@/lib/billing/queries";
import { ClientError, client } from "@/lib/client";

type Channel = "WeChat" | "Alipay";

const pack = z.object({
  priceCents: z.number().int().positive(),
  creditsMicrocredits: z.string().regex(/^\d+$/),
});
const offerProduct = pack.extend({
  version: z.number().int().positive(),
  currency: z.literal("CNY"),
});
const availability = z.object({
  available: z.boolean(),
  blockedReason: z.string().nullable(),
});
const packOffer = availability.extend({
  product: offerProduct.nullable(),
  pausedApplications: z.array(z.string()),
});
const periodSchema = pack.extend({
  id: z.uuid(),
  productCode: z.string(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  state: z.enum(["granted", "future", "frozen"]),
});
const subscriptionOffer = availability.extend({
  products: z.array(offerProduct.extend({ code: z.string() })),
  current: periodSchema.nullable(),
  next: periodSchema.nullable(),
  pausedApplications: z.array(z.string()),
});
type Product = z.infer<typeof offerProduct> & { code?: string };

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
  productCode: z.string().optional(),
  canRefundFuture: z.boolean().optional(),
  state: z.enum([
    "pending",
    "verified",
    "failed",
    "refund_pending",
    "refunded",
  ]),
  entitlementId: z.string().nullable(),
  creditsFrozen: z.boolean().optional(),
  dispute: paymentDisputeSchema.nullish(),
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

function OrderRow({
  order,
  channel,
  path,
  subscription,
}: {
  order: Order;
  channel: Channel;
  path: string;
  subscription: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirmRefund, setConfirmRefund] = useState(false);
  const sources = useQuery(paidSourcesQueryOptions());
  const source = sources.data?.find(
    ({ entitlementId }) => entitlementId === order.entitlementId,
  );
  const orderPath = `${path}/orders/${encodeURIComponent(order.id)}`;
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
        checkoutKeys(path).orders,
        checkoutKeys(path).offer,
        billingKeys.paidBalance,
        billingKeys.paidSources,
        billingKeys.bill,
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
        <ItemTitle>
          {subscription && order.productCode ? `${order.productCode} · ` : ""}
          {packText(order)}
        </ItemTitle>
        <ItemDescription>Order {order.id}</ItemDescription>
        {order.dispute ? (
          <PaymentDisputeDetails dispute={order.dispute} />
        ) : order.refund ? (
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
          <Text role="status">
            {subscription && order.state === "verified"
              ? "Payment confirmed"
              : states[order.state]}
          </Text>
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
          {order.state === "verified" &&
            !order.dispute &&
            !order.refund &&
            (!subscription || order.canRefundFuture) && (
              <Button
                label={subscription ? "Refund future period" : "Request refund"}
                onClick={() => {
                  refundAction.reset();
                  setConfirmRefund(true);
                }}
              />
            )}
          {order.dispute ? (
            <Button
              label="Check dispute status"
              isLoading={refundAction.isPending}
              onClick={() => refundAction.mutate("verify")}
            />
          ) : order.refund &&
            order.refund.state !== "confirmed" &&
            order.refund.state !== "failed" ? (
            <Button
              label="Check refund status"
              isLoading={refundAction.isPending}
              onClick={() => refundAction.mutate("verify")}
            />
          ) : null}
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
                the {channel} test channel.{" "}
                {subscription
                  ? "You can buy a replacement after the refund is confirmed."
                  : "If eligible, this order’s credits will be frozen while the refund is processed. Used credits require manual review."}
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

function checkoutKeys(path: string) {
  return {
    offer: [...billingKeys.all, path, "offer"],
    orders: [...billingKeys.all, path, "orders"],
  };
}

export function CreditPackCheckout() {
  return (
    <>
      <PaidCheckout kind="credit-pack" channel="WeChat" />
      <PaidCheckout kind="credit-pack" channel="Alipay" />
    </>
  );
}

export function SubscriptionCheckout() {
  return <PaidCheckout kind="subscription" channel="WeChat" />;
}

function PaidCheckout({
  kind,
  channel,
}:
  | { kind: "credit-pack"; channel: Channel }
  | { kind: "subscription"; channel: "WeChat" }) {
  const subscription = kind === "subscription";
  const path = `/api/billing/paid/${kind}${channel === "Alipay" ? "/alipay" : ""}`;
  const { offer: offerKey, orders: ordersKey } = checkoutKeys(path);
  const queryClient = useQueryClient();
  const offer = useQuery({
    queryKey: offerKey,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const data: unknown = await (await client(path, { signal })).json();
        if (subscription) return subscriptionOffer.parse(data);
        const { product, ...status } = packOffer.parse(data);
        return { ...status, products: product ? [product] : [] };
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
  const attempts = useRef(new Map<string, string>());
  const place = useMutation({
    mutationFn: async ({ code, version }: Product) => {
      const key = JSON.stringify([code, version]);
      const orderId = attempts.current.get(key) ?? crypto.randomUUID();
      attempts.current.set(key, orderId);
      await client(`${path}/orders`, {
        method: "POST",
        body: { version, orderId, ...(code ? { productCode: code } : {}) },
      });
      attempts.current.delete(key);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ordersKey }),
    onError: async (error) => {
      if (error instanceof ClientError && error.status === 409)
        await queryClient.invalidateQueries({ queryKey: offerKey });
    },
  });
  if (!offer.data && !offer.isError) return null;
  const periods = offer.data && "current" in offer.data ? offer.data : null;
  const paused = offer.data?.pausedApplications ?? [];
  return (
    <PageSection
      description={
        subscription
          ? "Periods use Beijing time. A renewal or plan change takes effect when your current period ends. Payments use the WeChat test channel."
          : `${channel} test channel. Orders use simulated payments and add long-lived paid credits.`
      }
      title={
        subscription
          ? "Test Monthly Subscription"
          : channel === "Alipay"
            ? "Alipay Test Credit Pack"
            : "Test Credit Pack"
      }
    >
      <PageRows>
        {periods ? (
          <>
            <PeriodRow label="Current period" period={periods.current} />
            <PeriodRow label="Next period" period={periods.next} />
          </>
        ) : null}
        {offer.data?.products.map((product: Product) => (
          <Item key={product.code ?? kind}>
            <ItemContent>
              <ItemTitle>
                {product.code ? `${product.code} · ` : ""}
                {packText(product)}
              </ItemTitle>
              {offer.data?.available ? (
                <HStack>
                  <Button
                    isDisabled={place.isPending}
                    label={
                      subscription
                        ? `Place test order for ${product.code}`
                        : channel === "Alipay"
                          ? "Place Alipay test order"
                          : "Place test order"
                    }
                    onClick={() => place.mutate(product)}
                  />
                </HStack>
              ) : null}
            </ItemContent>
          </Item>
        ))}
        {periods && !periods.products.length && !periods.blockedReason ? (
          <Item>
            <Text>No monthly plans are available.</Text>
          </Item>
        ) : null}
        {paused.length ||
        offer.data?.blockedReason ||
        offer.error ||
        place.error ? (
          <Item>
            <ItemContent>
              {paused.length ? (
                <Text>Paused application paths: {paused.join(", ")}</Text>
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
              {place.error ? (
                <Text role="alert">{place.error.message}</Text>
              ) : null}
            </ItemContent>
          </Item>
        ) : null}
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
            <OrderRow
              order={order}
              channel={channel}
              path={path}
              subscription={subscription}
            />
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}

function PeriodRow({
  label,
  period,
}: {
  label: string;
  period: z.infer<typeof periodSchema> | null;
}) {
  return (
    <Item>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {period ? (
          <>
            <ItemDescription>
              {period.productCode} · {packText(period)}
            </ItemDescription>
            <Text>
              {beijingBillingTime(period.periodStart)} to{" "}
              {beijingBillingTime(period.periodEnd)} (Beijing time)
            </Text>
            {period.state === "frozen" ? (
              <Text role="status">Refund pending</Text>
            ) : null}
          </>
        ) : (
          <ItemDescription>No paid period</ItemDescription>
        )}
      </ItemContent>
    </Item>
  );
}
