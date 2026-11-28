import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createFlexpricePackRefundRoutes } from "../src/billing/flexprice-pack-refund";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #102/#103 callback scenarios at the channel seam: the original-route
 * refund contract is one per-order record that every replay converges on,
 * and a suspended account pauses purchases while its landed payments
 * refund in full.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const paidAt = new Date("2026-02-15T04:30:00.000Z"); // Beijing Feb 15 12:30
const ledger = () => createPaidCreditLedger(database, () => paidAt);
const run = crypto.randomUUID().slice(0, 8);
const applicationId = `refund-app-${run}`;

async function freshAccount(tag: string) {
  const [row] = await database
    .insert(testCreditAccounts)
    .values({ issuer: `paid-refund-${tag}`, subject: crypto.randomUUID() })
    .returning();
  return row.id;
}

async function boughtPack(accountId: string, ref: string) {
  await ledger().upsertProduct({
    code: "pack-refund-pilot",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 50n,
  });
  const order = await ledger().createOrder({
    accountId,
    productCode: "pack-refund-pilot",
    channel: "alipay",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: ref,
    amountCents: 9_900,
    paidAt,
  });
  if (!verified.entitlement) throw new Error("pack purchase granted nothing");
  return { order: verified.order, entitlementId: verified.entitlement.id };
}

test("an original-route refund runs once and replays converge", async () => {
  const account = await freshAccount("full");
  const { order } = await boughtPack(account, `ali-refund-full-${run}`);

  const requested = await ledger().requestRefund(order.id);
  expect(requested).toMatchObject({
    channel: "alipay",
    amountCents: 9_900,
    reason: "user_request",
    state: "requested",
  });
  expect((await ledger().entitlements(account))[0].effective).toBe("frozen");

  const confirmed = await ledger().confirmRefund(order.id, true);
  expect(confirmed).toMatchObject({ state: "confirmed" });
  expect((await ledger().entitlements(account))[0].effective).toBe("revoked");
  expect(
    (
      await database
        .select()
        .from(paidOrders)
        .where(inArray(paidOrders.id, [order.id]))
    )[0].state,
  ).toBe("refunded");

  // Replay on both ends: one record, one outcome — never a second refund.
  expect((await ledger().requestRefund(order.id)).state).toBe("confirmed");
  expect((await ledger().confirmRefund(order.id, true)).state).toBe(
    "confirmed",
  );
  expect(await ledger().refunds(account)).toHaveLength(1);
});

test("a failed refund unfreezes and can be retried", async () => {
  const account = await freshAccount("retry");
  const { order } = await boughtPack(account, `ali-refund-retry-${run}`);

  await ledger().requestRefund(order.id);
  const failed = await ledger().confirmRefund(order.id, false);
  expect(failed).toMatchObject({ state: "failed" });
  expect((await ledger().entitlements(account))[0].effective).toBe("active");
  expect(
    (
      await database
        .select()
        .from(paidOrders)
        .where(inArray(paidOrders.id, [order.id]))
    )[0].state,
  ).toBe("verified");

  const retried = await ledger().requestRefund(order.id);
  expect(retried).toMatchObject({ state: "requested" });
  expect((await ledger().confirmRefund(order.id, true)).state).toBe(
    "confirmed",
  );
  expect(await ledger().refunds(account)).toHaveLength(1);
});

test("confirming before requesting refuses", async () => {
  const account = await freshAccount("order");
  const { order } = await boughtPack(account, `ali-refund-oo-${run}`);
  await expect(ledger().confirmRefund(order.id, true)).rejects.toMatchObject({
    code: "not_verified",
  });
});

test("a lost future-period claim is owed its refund per order", async () => {
  const account = await freshAccount("lost");
  await ledger().upsertProduct({
    code: "plan-refund-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 100n,
  });
  const first = await ledger().createOrder({
    accountId: account,
    productCode: "plan-refund-monthly",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: first.id,
    channel: "wechat",
    channelOrderRef: `wx-lost-1-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  const second = await ledger().createOrder({
    accountId: account,
    productCode: "plan-refund-monthly",
    channel: "wechat",
  });
  const loser = await ledger().createOrder({
    accountId: account,
    productCode: "plan-refund-monthly",
    channel: "alipay",
  });
  const claimed = await ledger().verifyOrder({
    orderId: second.id,
    channel: "wechat",
    channelOrderRef: `wx-lost-2-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  expect(claimed.claimed).toBe(true);
  const lost = await ledger().verifyOrder({
    orderId: loser.id,
    channel: "alipay",
    channelOrderRef: `ali-lost-2-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  expect(lost.claimed).toBe(false);
  const owed = lost.refund;
  if (!owed) throw new Error("the lost claim booked no refund");
  expect(owed).toMatchObject({
    state: "requested",
    reason: "duplicate_future_period",
  });
  // The refund already exists; requesting again converges on it.
  const refund = await ledger().requestRefund(
    loser.id,
    "duplicate_future_period",
  );
  expect(refund.id).toBe(owed.id);
  expect(await ledger().refunds(account)).toHaveLength(1);
});

test("suspension pauses purchases and refunds landed payments in full", async () => {
  const account = await freshAccount("susp");
  await ledger().upsertProduct({
    code: "pack-refund-pilot",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 50n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "pack-refund-pilot",
    channel: "wechat",
  });
  await ledger().suspendAccount(account, true);
  await expect(
    ledger().createOrder({
      accountId: account,
      productCode: "pack-refund-pilot",
      channel: "wechat",
    }),
  ).rejects.toMatchObject({ code: "account_suspended" });

  // The delayed callback for the pre-suspension order: money in, no grant,
  // full refund owed through the original channel.
  const landed = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-susp-1-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  expect(landed.claimed).toBe(false);
  expect(landed.refund).toMatchObject({
    state: "requested",
    reason: "account_suspended",
    channel: "wechat",
    amountCents: 9_900,
  });
  expect(await ledger().entitlements(account)).toHaveLength(0);

  // Replayed callback: same record, no second refund and no grant.
  const replay = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-susp-1-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  expect(replay.replayed).toBe(true);
  expect(replay.refunded).toBe(true);

  // In-flight refunds continue while suspended.
  expect((await ledger().confirmRefund(order.id, true)).state).toBe(
    "confirmed",
  );

  await ledger().suspendAccount(account, false);
  const after = await ledger().createOrder({
    accountId: account,
    productCode: "pack-refund-pilot",
    channel: "wechat",
  });
  expect(after.state).toBe("pending");
});

test("a dispute blocks its source, settles dispatched work, and reconciles the used part", async () => {
  const account = await freshAccount("dispute");
  await ledger().upsertProduct({
    code: "pack-refund-pilot",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 100n,
  });
  await ledger().upsertProduct({
    code: "pack-b",
    kind: "credit_pack",
    priceCents: 4_900,
    creditsMicrocredits: 50n,
  });
  const disputed = await ledger().createOrder({
    accountId: account,
    productCode: "pack-refund-pilot",
    channel: "alipay",
  });
  await ledger().verifyOrder({
    orderId: disputed.id,
    channel: "alipay",
    channelOrderRef: `ali-disp-a-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  const other = await ledger().createOrder({
    accountId: account,
    productCode: "pack-b",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: other.id,
    channel: "wechat",
    channelOrderRef: `wx-disp-b-${run}`,
    amountCents: 4_900,
    paidAt: new Date(paidAt.getTime() + 60_000),
  });

  // 30 consumed from the disputed pack, another 40 still held by an
  // operation that already dispatched.
  await ledger().allocate({
    accountId: account,
    operationId: "disp-op-1",
    amountMicrocredits: 30n,
  });
  await ledger().settleAllocation({
    accountId: account,
    operationId: "disp-op-1",
    chargeMicrocredits: 30n,
  });
  await ledger().allocate({
    accountId: account,
    operationId: "disp-op-2",
    amountMicrocredits: 40n,
  });

  // The dispute freezes the source; its staff handler is on the record.
  const dispute = await ledger().requestRefund(
    disputed.id,
    "dispute",
    "staff-a",
  );
  expect(dispute).toMatchObject({ state: "requested", openedBy: "staff-a" });
  const sources = await ledger().entitlements(account);
  expect(
    sources.find(({ orderId }) => orderId === disputed.id)?.effective,
  ).toBe("frozen");

  // New reservations skip the frozen source; the other pack still funds.
  const allocated = await ledger().allocate({
    accountId: account,
    operationId: "disp-op-3",
    amountMicrocredits: 10n,
  });
  expect(allocated.state).toBe("allocated");
  const offered = await ledger().paidSources(account);
  expect(offered).toHaveLength(1);
  expect(offered[0]?.remainingMicrocredits).toBe("40");

  // Dispatched work settles per its original reservation despite the freeze.
  const settled = await ledger().settleAllocation({
    accountId: account,
    operationId: "disp-op-2",
    chargeMicrocredits: 25n,
  });
  expect(settled.state).toBe("settled");

  // Confirmation revokes only the remaining credits and books the used
  // part's RMB share to manual reconciliation (9 900 × 55 / 100).
  const confirmed = await ledger().confirmRefund(disputed.id, true);
  expect(confirmed).toMatchObject({
    state: "confirmed",
    usedMicrocredits: 55n,
    manualReviewCents: 5_445,
  });
  const after = await ledger().entitlements(account);
  const revokedRow = after.find(({ orderId }) => orderId === disputed.id);
  expect(revokedRow?.effective).toBe("revoked");
  // Consumed records survive; a replayed notice collects nothing twice.
  expect(revokedRow?.consumedMicrocredits).toBe(55n);
  const replay = await ledger().confirmRefund(disputed.id, true);
  expect(replay.id).toBe(confirmed.id);
  expect(
    (await ledger().entitlements(account)).find(
      ({ orderId }) => orderId === disputed.id,
    )?.consumedMicrocredits,
  ).toBe(55n);
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      inArray(
        testCreditAccounts.issuer,
        [
          "full",
          "retry",
          "order",
          "lost",
          "susp",
          "dispute",
          "suspension-clock",
          "flexprice",
        ].map((tag) => `paid-refund-${tag}`),
      ),
    );
  const ids = accounts.map(({ id }) => id);
  if (ids.length > 0) {
    await database
      .delete(paidRefunds)
      .where(inArray(paidRefunds.accountId, ids));
    await database
      .delete(paidCreditAllocations)
      .where(inArray(paidCreditAllocations.accountId, ids));
    await database
      .delete(paidEntitlements)
      .where(inArray(paidEntitlements.accountId, ids));
    await database.delete(paidOrders).where(inArray(paidOrders.accountId, ids));
    await database
      .delete(testCreditAccounts)
      .where(inArray(testCreditAccounts.id, ids));
  }
  await database
    .delete(paidProducts)
    .where(
      inArray(paidProducts.code, [
        "pack-refund-pilot",
        "plan-refund-monthly",
        "pack-b",
        "pack-flexprice-refund",
      ]),
    );
  await database
    .delete(billingApplications)
    .where(eq(billingApplications.id, applicationId));
  await database.$client.close();
});

test("suspension is attributed to the channel timestamp even across repeated suspension and resume", async () => {
  const accountId = await freshAccount("suspension-clock");
  let at = paidAt;
  const service = createPaidCreditLedger(database, () => at);
  await service.upsertProduct({
    code: "pack-refund-pilot",
    kind: "credit_pack",
    priceCents: 9900,
    creditsMicrocredits: 50n,
  });
  const place = () =>
    service.createOrder({
      accountId,
      productCode: "pack-refund-pilot",
      channel: "alipay",
    });
  const before = await place();
  const during = await place();
  const verify = (id: string, time: Date) =>
    service.verifyOrder({
      orderId: id,
      channel: "alipay",
      channelOrderRef: id,
      amountCents: 9900,
      paidAt: time,
    });
  const start = new Date(+paidAt + 1000);
  at = start;
  await service.suspendAccount(accountId, true);
  at = new Date(+start + 1000);
  await service.suspendAccount(accountId, true);
  expect((await verify(before.id, paidAt)).claimed).toBe(true);
  await service.suspendAccount(accountId, false);
  expect((await verify(during.id, start)).refund).toMatchObject({
    orderId: during.id,
    reason: "account_suspended",
    amountCents: 9900,
    channel: "alipay",
  });
  expect(await service.entitlements(accountId)).toHaveLength(1);
});

async function boughtFlexpricePack(channel: "alipay" | "wechat") {
  const accountId = await freshAccount("flexprice");
  await ledger().upsertProduct({
    code: "pack-flexprice-refund",
    kind: "credit_pack",
    priceCents: 7900,
    creditsMicrocredits: 50n,
  });
  const orderId = crypto.randomUUID();
  await database
    .insert(billingApplications)
    .values({
      id: applicationId,
      name: "Refund fixture",
      operator: "platform",
      resourcePrefix: applicationId,
      approvedAt: paidAt,
      approvedBy: "fixture",
    })
    .onConflictDoNothing();
  await ledger().createOrder({
    accountId,
    channel: "alipay",
    productCode: "pack-flexprice-refund",
    testPack: {
      id: orderId,
      version: 1,
      merchant: "alipay",
      applicationIds: [applicationId],
      live: true,
      flexprice: true,
    },
  });
  const invoiceId = `inv-${orderId}`;
  const paymentId = `pay-${orderId}`;
  await ledger().linkFlexpriceInvoice({ orderId, invoiceId });
  await ledger().verifyOrder({
    orderId,
    channel,
    channelOrderRef: paymentId,
    amountCents: 7900,
    currency: "CNY",
    paidAt,
    flexpriceInvoiceId: invoiceId,
  });
  return {
    accountId,
    orderId,
    invoiceId,
    paymentId,
    channel,
    amountCents: 7900,
  };
}

test("an approved Flexprice pack refund is frozen until the original receipt is confirmed", async () => {
  const order = await boughtFlexpricePack("alipay");
  const { accountId, orderId } = order;
  const refund = await ledger().approveFlexpricePackRefund({
    accountId,
    orderId,
    by: "operator",
  });
  expect((await ledger().entitlements(accountId))[0].effective).toBe("frozen");
  expect((await ledger().confirmRefund(orderId, false)).state).toBe(
    "requested",
  );
  const receipt = {
    ...order,
    refundId: refund.id,
    state: "confirmed",
  } satisfies Parameters<
    ReturnType<typeof ledger>["applyFlexpricePackRefund"]
  >[0];
  await expect(
    ledger().applyFlexpricePackRefund({ ...receipt, amountCents: 7899 }),
  ).rejects.toMatchObject({ code: "verification_mismatch" });
  await ledger().applyFlexpricePackRefund(receipt);
  await ledger().applyFlexpricePackRefund(receipt);
  expect((await ledger().entitlements(accountId))[0].effective).toBe("revoked");
  expect(await ledger().refunds(accountId)).toHaveLength(1);
});

test("a reservation and a whole-pack refund cannot both claim the credits", async () => {
  const { accountId, orderId } = await boughtFlexpricePack("wechat");
  const [reservation, refund] = await Promise.all([
    ledger().allocate({
      accountId,
      operationId: "refund-race",
      amountMicrocredits: 50n,
    }),
    ledger().approveFlexpricePackRefund({ accountId, orderId, by: "operator" }),
  ]);
  if (reservation.state === "allocated") {
    expect(refund).toMatchObject({
      state: "manual_review",
      reason: "reserved_credits",
    });
    expect(
      await ledger().flexpricePackRefundDispatch({ accountId, orderId }),
    ).toBeUndefined();
  } else {
    expect(refund.state).toBe("requested");
    expect((await ledger().entitlements(accountId))[0].effective).toBe(
      "frozen",
    );
  }
});

test("only an admin can submit or verify the original merchant refund", async () => {
  const order = await boughtFlexpricePack("wechat");
  const calls: string[] = [];
  let state: "unknown" | "failed" = "unknown";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const expected = `/v1/invoices/${order.invoiceId}/payments/${order.paymentId}/original-refund`;
      if (
        new URL(request.url).pathname !== expected ||
        request.headers.get("x-api-key") !== "fixture"
      )
        return new Response(null, { status: 404 });
      calls.push(request.method);
      return Response.json({
        invoiceId: order.invoiceId,
        paymentId: order.paymentId,
        channel: order.channel,
        amountCents: order.amountCents,
        state,
      });
    },
  });
  const api = createFlexpricePackRefundRoutes(
    ledger(),
    async (context, next) => {
      context.set("actor", {
        id: "operator",
        email: "operator@example.test",
        role: context.req.header("admin") ? "admin" : "user",
      });
      await next();
    },
    { baseUrl: upstream.url.origin, apiKey: "fixture" },
  );
  const path = `/accounts/${order.accountId}/credit-pack-orders/${order.orderId}/refund`;
  const call = (action: string, admin = true) =>
    api.request(`${path}/${action}`, {
      method: "POST",
      headers: admin ? { admin: "fixture" } : {},
    });
  try {
    expect((await call("approve", false)).status).toBe(403);
    expect((await call("verify", false)).status).toBe(403);
    expect(calls).toEqual([]);
    const submitted = await call("approve");
    expect(submitted.status).toBe(202);
    const { refundId } = await submitted.json();
    expect((await ledger().entitlements(order.accountId))[0].effective).toBe(
      "frozen",
    );
    state = "failed";
    expect(await (await call("verify")).json()).toEqual({
      refundId,
      state: "failed",
    });
    expect((await ledger().entitlements(order.accountId))[0].effective).toBe(
      "active",
    );
    expect(await (await call("approve")).json()).toMatchObject({
      refundId,
      state: "failed",
    });
    expect(calls).toEqual(["POST", "GET"]);
  } finally {
    await upstream.stop(true);
  }
});

test("manual review can release a reserved pack but cannot refund spent credits", async () => {
  for (const consumed of [false, true]) {
    const { accountId, orderId } = await boughtFlexpricePack("alipay");
    const operationId = "review";
    const input = { accountId, orderId, by: "operator" };
    expect(
      (
        await ledger().allocate({
          accountId,
          operationId,
          amountMicrocredits: 10n,
        })
      ).state,
    ).toBe("allocated");
    const held = await ledger().approveFlexpricePackRefund(input);
    expect(held).toMatchObject({
      state: "manual_review",
      reason: "reserved_credits",
    });
    if (consumed) {
      await ledger().settleAllocation({
        accountId,
        operationId,
        chargeMicrocredits: 10n,
      });
      expect(await ledger().approveFlexpricePackRefund(input)).toMatchObject({
        id: held.id,
        state: "manual_review",
        reason: "used_credits",
      });
      expect((await ledger().entitlements(accountId))[0].effective).toBe(
        "active",
      );
    } else {
      await ledger().releaseAllocation(accountId, operationId);
      expect(await ledger().approveFlexpricePackRefund(input)).toMatchObject({
        id: held.id,
        state: "requested",
      });
      expect((await ledger().entitlements(accountId))[0].effective).toBe(
        "frozen",
      );
    }
  }
});
