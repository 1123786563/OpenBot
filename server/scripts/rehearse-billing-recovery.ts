import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  lagoUsageEvents,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidRefunds,
  pilotProviderCostHolds,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "../tests/support/bifrost-evidence";

const config = z
  .object({
    REHEARSAL_SOURCE: z.url(),
    REHEARSAL_PROJECT: z.string().startsWith("openbot-108-"),
    REHEARSAL_ARTIFACTS: z.string(),
    REHEARSAL_LEGACY: z.string(),
    REHEARSAL_HEAD: z.string(),
  })
  .parse(process.env);
const restoredUrl = new URL(config.REHEARSAL_SOURCE);
assert.equal(restoredUrl.hostname, "127.0.0.1");
assert.equal(restoredUrl.pathname, "/recovery_source");
restoredUrl.pathname = "/recovery_restored";

const source = createDatabase(config.REHEARSAL_SOURCE, { max: 2 });
const restored = createDatabase(restoredUrl.href, { max: 2 });
const sourcePaid = createPaidCreditLedger(source);
const sourceCredit = createTestCreditLedger(source);
const paid = createPaidCreditLedger(restored);
const credit = createTestCreditLedger(restored);
const routeId = "recovery-original";
const replacementRoute = "recovery-replacement";
const productCode = "rehearsal-pack";
const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
type Db = typeof source;
type Account = Awaited<ReturnType<typeof enroll>>;
type ChannelEvidence = {
  reference: string;
  amountCents: number;
  paidAt: Date;
};
type RefundEvidence = {
  refundId: string;
  amountCents: number;
  orderReference: string;
};

function fixtureExec(
  args: string[],
  file?: { mode: "read" | "write"; path: string },
) {
  const io =
    file && openSync(file.path, file.mode === "read" ? "r" : "wx", 0o600);
  try {
    const result = Bun.spawnSync(args, {
      stdin: file?.mode === "read" ? io : "ignore",
      stdout: file?.mode === "write" ? io : "pipe",
      stderr: "inherit",
    });
    assert.equal(result.exitCode, 0, `${args[0]} failed`);
    return result.stdout?.toString() ?? "";
  } finally {
    if (io !== undefined) closeSync(io);
  }
}

const compose = [
  "docker",
  "compose",
  "--env-file",
  ".env.test",
  "-p",
  config.REHEARSAL_PROJECT,
  "-f",
  "scripts/billing-recovery/compose.yml",
  "exec",
  "-T",
  "postgres",
];
const dump = join(config.REHEARSAL_ARTIFACTS, "ledger.dump");

function exactlyOne<T>(rows: T[]) {
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  return row;
}

async function install(db: Db, id: string, price: number) {
  const draft = configure(emptyCatalog, {
    harnessImage,
    routes: {
      [id]: {
        model: "fixture-model",
        provider: "fixture-provider",
        gatewayRevision: "fixture-gateway",
        meteringRevision: "fixture-metering",
        maxInputTokens: 10,
        maxOutputTokens: 2,
        tools: false,
        price: { inputPerMillion: price, outputPerMillion: 0 },
      },
    },
  });
  const proposal = draft.routes[id];
  assert.ok(proposal);
  const { catalog } = publish(
    verify(draft, id, fixtureTraceReport(harnessImage, proposal), "fixture"),
    [id],
    id,
    "fixture",
  );
  await db
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value: catalog })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: catalog },
    });
}

async function enroll(subject: string) {
  const identity = { issuer: "https://rehearsal.example.test", subject };
  const batchId = crypto.randomUUID();
  await sourceCredit.enroll({ identity, batchId, amount: 100n });
  assert.ok(await sourceCredit.claim(identity, batchId));
  const accountId = await sourceCredit.accountOf(identity);
  assert.ok(accountId);
  return { identity, accountId };
}

async function buy(account: Account, tag: string) {
  const order = await sourcePaid.createOrder({
    accountId: account.accountId,
    channel: "alipay",
    productCode,
  });
  const channel: ChannelEvidence = {
    reference: `fixture-alipay-${tag}`,
    amountCents: 9_900,
    paidAt: new Date(),
  };
  const result = await sourcePaid.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: channel.reference,
    amountCents: channel.amountCents,
    paidAt: channel.paidAt,
  });
  assert.ok(result.entitlement);
  return { channel, order: result.order, entitlement: result.entitlement };
}

async function refund(payment: Awaited<ReturnType<typeof buy>>) {
  const request = await sourcePaid.requestRefund(payment.order.id);
  const channel: RefundEvidence = {
    refundId: request.id,
    amountCents: payment.channel.amountCents,
    orderReference: payment.channel.reference,
  };
  const confirmation = await sourcePaid.confirmRefund(payment.order.id, true);
  assert.equal(confirmation.state, "confirmed");
  return channel;
}

async function reserve(
  ledger: typeof credit,
  account: Account,
  operationId: string,
) {
  const quote = await ledger.quote();
  assert.ok(quote);
  const request = {
    operationId,
    route: quote.route,
    priceVersion: quote.priceVersion,
    creditType: "paid",
  } as const;
  const result = await ledger.reserve(account.identity, request);
  assert.equal(result.state, "reserved");
  assert.ok(result.state === "reserved" && result.permit);
  return { ...request, permit: result.permit };
}

async function dispatch(
  ledger: typeof credit,
  account: Account,
  operationId: string,
) {
  const request = await reserve(ledger, account, operationId);
  assert.equal(
    (await ledger.beginDispatch(account.identity, request)).state,
    "dispatch",
  );
  return request;
}

async function readDispatch(db: Db, account: Account, id: string) {
  const operation = exactlyOne(
    await db
      .select()
      .from(testCreditOperations)
      .where(
        and(
          eq(testCreditOperations.accountId, account.accountId),
          eq(testCreditOperations.id, id),
        ),
      ),
  );
  const allocations = await db
    .select()
    .from(paidCreditAllocations)
    .where(
      and(
        eq(paidCreditAllocations.accountId, account.accountId),
        eq(paidCreditAllocations.operationId, id),
      ),
    )
    .orderBy(paidCreditAllocations.position);
  const hold = exactlyOne(
    await db
      .select()
      .from(pilotProviderCostHolds)
      .where(
        and(
          eq(pilotProviderCostHolds.accountId, account.accountId),
          eq(pilotProviderCostHolds.operationId, id),
        ),
      ),
  );
  return { operation, allocations, hold };
}

async function settle(
  ledger: typeof credit,
  account: Account,
  id: string,
  evidenceId: string,
) {
  const evidence = {
    evidenceId,
    outcome: "completed",
    inputTokens: 7n,
    outputTokens: 0n,
  } as const;
  await ledger.recordEvidence(account.accountId, id, evidence);
  const receipt = await ledger.settleRecorded(account.accountId, id);
  assert.equal(receipt?.chargedMicrocredits, "7");
  return receipt;
}

async function readPayment(db: Pick<Db, "select">, id: string) {
  const [order] = await db
    .select()
    .from(paidOrders)
    .where(eq(paidOrders.id, id));
  if (!order) return undefined;
  const entitlement = exactlyOne(
    await db
      .select()
      .from(paidEntitlements)
      .where(eq(paidEntitlements.orderId, id)),
  );
  const [refund] = await db
    .select()
    .from(paidRefunds)
    .where(eq(paidRefunds.orderId, id));
  return { order, entitlement, refund };
}

async function usageIds(db: Db, account: Account, id: string) {
  const evidence = await db
    .select({ id: testCreditEvidence.evidenceId })
    .from(testCreditEvidence)
    .where(
      and(
        eq(testCreditEvidence.accountId, account.accountId),
        eq(testCreditEvidence.operationId, id),
      ),
    );
  const outbox = await db
    .select({ id: lagoUsageEvents.eventId })
    .from(lagoUsageEvents)
    .where(
      and(
        eq(lagoUsageEvents.accountId, account.accountId),
        eq(lagoUsageEvents.operationId, id),
      ),
    );
  return { evidence: exactlyOne(evidence).id, outbox: exactlyOne(outbox).id };
}

type PaymentJournal = {
  channel: ChannelEvidence;
  retained: NonNullable<Awaited<ReturnType<typeof readPayment>>>;
} & (
  | { kind: "payment" }
  | {
      kind: "refund";
      refund: RefundEvidence;
      snapshot: NonNullable<Awaited<ReturnType<typeof readPayment>>>;
    }
);

async function requirePayment(db: Db, id: string) {
  const payment = await readPayment(db, id);
  assert.ok(payment);
  return payment;
}

// Restore the original IDs from a quiesced fixture journal only after comparing
// the complete batch to the channel fixtures. No checkout or gateway is called.
async function replayPayments(account: Account, history: PaymentJournal[]) {
  for (const entry of history) {
    const { order, entitlement, refund } = entry.retained;
    assert.equal(order.accountId, account.accountId);
    assert.equal(entitlement.accountId, account.accountId);
    assert.equal(order.channel, "alipay");
    assert.equal(
      order.priceCents,
      entry.channel.amountCents,
      "channel amount discrepancy",
    );
    assert.equal(order.channelOrderRef, entry.channel.reference);
    assert.deepEqual(order.verifiedAt, entry.channel.paidAt);
    assert.equal(entitlement.creditsMicrocredits, order.lockedMicrocredits);
    if (entry.kind === "refund") {
      assert.ok(refund?.confirmedAt);
      assert.equal(refund.id, entry.refund.refundId);
      assert.equal(refund.accountId, account.accountId);
      assert.equal(refund.channel, order.channel);
      assert.equal(refund.amountCents, entry.refund.amountCents);
      assert.equal(order.channelOrderRef, entry.refund.orderReference);
      assert.equal(refund.state, "confirmed");
      assert.equal(order.state, "refunded");
      assert.equal(entitlement.state, "revoked");
    } else {
      assert.equal(order.state, "verified");
      assert.equal(entitlement.state, "granted");
      assert.equal(refund, undefined);
    }
  }
  await restored.transaction(async (tx) => {
    for (const entry of history) {
      const { order, entitlement, refund } = entry.retained;
      const current = await readPayment(tx, order.id);
      if (current?.order.state === order.state) {
        assert.deepEqual(current, entry.retained);
        continue;
      }
      if (entry.kind === "refund") {
        assert.deepEqual(current, entry.snapshot);
        assert.ok(refund);
        await tx
          .update(paidOrders)
          .set({ state: "refunded" })
          .where(eq(paidOrders.id, order.id));
        await tx
          .update(paidEntitlements)
          .set({ state: "revoked" })
          .where(eq(paidEntitlements.id, entitlement.id));
        await tx.insert(paidRefunds).values(refund);
      } else {
        assert.equal(current, undefined);
        await tx.insert(paidOrders).values(order);
        await tx.insert(paidEntitlements).values(entitlement);
      }
      assert.deepEqual(await readPayment(tx, order.id), entry.retained);
    }
  });
}

async function replayDispatch(
  checkpoint: Awaited<ReturnType<typeof readDispatch>>,
) {
  const { operation, allocations, hold } = checkpoint;
  assert.equal(operation.state, "pending");
  assert.equal(hold.state, "held");
  assert.equal(
    allocations.reduce(
      (total, allocation) => total + allocation.amountMicrocredits,
      0n,
    ),
    operation.paidHoldMicrocredits,
  );
  await restored.transaction(async (tx) => {
    const existing = await tx
      .select({ id: testCreditOperations.id })
      .from(testCreditOperations)
      .where(
        and(
          eq(testCreditOperations.accountId, operation.accountId),
          eq(testCreditOperations.id, operation.id),
        ),
      );
    if (existing.length) return;
    await tx.insert(testCreditOperations).values(operation);
    await tx.insert(paidCreditAllocations).values(allocations);
    await tx.insert(pilotProviderCostHolds).values(hold);
  });
}

async function withLegacyApi<T>(
  account: Account,
  phase: "draining" | "drained",
  probe: (root: string) => Promise<T>,
) {
  const child = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "scripts/billing-recovery/legacy.mjs",
      restoredUrl.href,
      account.identity.issuer,
      account.identity.subject,
      phase,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const stdout = child.stdout.getReader();
  try {
    const { value } = await stdout.read();
    const port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(new TextDecoder().decode(value).trim());
    return await probe(`http://127.0.0.1:${port}`);
  } finally {
    stdout.releaseLock();
    child.kill();
    await child.exited;
  }
}

async function probeLegacy(
  root: string,
  operationId: string,
  state: "pending" | "settled",
) {
  const [operation, blocked, balance, quote] = await Promise.all([
    fetch(`${root}/operations/${operationId}`),
    fetch(`${root}/v1/dispatch`, { method: "POST" }),
    fetch(`${root}/balance`),
    fetch(`${root}/quote`),
  ]);
  assert.equal(operation.status, 200);
  assert.equal(blocked.status, 405);
  assert.equal(balance.status, 200);
  const receipt = z
    .object({ creditType: z.literal("test"), state: z.literal(state) })
    .parse(await operation.json());
  const price = z
    .object({ route: z.string().optional() })
    .parse(await quote.json());
  return {
    operation: receipt,
    quote: price,
    quoteStatus: quote.status,
    operationStatus: operation.status,
    dispatchStatus: blocked.status,
    balanceStatus: balance.status,
  };
}

async function run() {
  await install(source, routeId, 1_000_000);
  await sourcePaid.upsertProduct({
    code: productCode,
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 100n,
  });
  await sourceCredit.setPilotProviderCostLimit({
    limitMicrocredits: 1000n,
    by: "fixture",
  });
  await sourceCredit.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 500n,
    by: "fixture",
  });
  const a = await enroll("verified");
  const b = await enroll("discrepant");
  const existing = await buy(a, "before");
  const oldRefund = await buy(a, "before-refund");
  await refund(oldRefund);
  const laterRefundPayment = await buy(a, "after-refund");
  const refundSnapshot = await requirePayment(
    source,
    laterRefundPayment.order.id,
  );
  await dispatch(sourceCredit, a, "pre-snapshot-dispatched");
  fixtureExec(
    [...compose, "pg_dump", "-U", "postgres", "-Fc", "recovery_source"],
    { mode: "write", path: dump },
  );

  const later = await buy(a, "after");
  const refundEvidence = await refund(laterRefundPayment);
  const unmatched = await buy(b, "discrepancy");
  const postId = "post-snapshot-dispatched";
  const evidenceId = "trusted-usage-post-snapshot";
  await dispatch(sourceCredit, a, postId);
  const checkpoint = await readDispatch(source, a, postId);
  await settle(sourceCredit, a, postId, evidenceId);
  const expectedUsage = await readDispatch(source, a, postId);
  const expectedUsageIds = await usageIds(source, a, postId);
  const expectedBalance = await sourcePaid.paidBalance(a.accountId);
  const expectedExposure = await sourceCredit.pilotProviderCost();
  const expectedRouteCost = await sourceCredit.providerCost(routeId);
  const journal: PaymentJournal[] = [
    {
      kind: "payment",
      channel: later.channel,
      retained: await requirePayment(source, later.order.id),
    },
    {
      kind: "refund",
      channel: laterRefundPayment.channel,
      retained: await requirePayment(source, laterRefundPayment.order.id),
      refund: refundEvidence,
      snapshot: refundSnapshot,
    },
  ];

  fixtureExec([...compose, "createdb", "-U", "postgres", "recovery_restored"]);
  fixtureExec(
    [
      ...compose,
      "pg_restore",
      "-U",
      "postgres",
      "--exit-on-error",
      "-d",
      "recovery_restored",
    ],
    { mode: "read", path: dump },
  );
  await paid.beginRestore("rehearsal-operator");
  assert.equal(
    (await requirePayment(restored, existing.order.id)).order.state,
    "verified",
  );
  assert.equal(
    (await requirePayment(restored, oldRefund.order.id)).refund?.state,
    "confirmed",
  );
  assert.equal(
    (await readDispatch(restored, a, "pre-snapshot-dispatched")).operation
      .state,
    "pending",
  );
  assert.equal((await paid.entitlements(a.accountId)).length, 3);
  assert.deepEqual(
    await readPayment(restored, laterRefundPayment.order.id),
    refundSnapshot,
  );
  assert.equal(await credit.receipt(a.identity, postId), undefined);
  const freshOrder = (account: Account) =>
    paid.createOrder({
      accountId: account.accountId,
      channel: "alipay",
      productCode,
    });
  await assert.rejects(freshOrder(a), { code: "ledger_restoring" });
  await assert.rejects(freshOrder(b), { code: "ledger_restoring" });
  const quote = await credit.quote();
  assert.ok(quote);
  assert.deepEqual(
    await credit.reserve(a.identity, {
      operationId: "blocked-during-recovery",
      route: quote.route,
      priceVersion: quote.priceVersion,
    }),
    { state: "denied", reason: "unavailable" },
  );

  await assert.rejects(
    replayPayments(b, [
      {
        kind: "payment",
        channel: { ...unmatched.channel, amountCents: 9901 },
        retained: await requirePayment(source, unmatched.order.id),
      },
    ]),
    /channel amount discrepancy/,
  );
  assert.equal((await paid.entitlements(b.accountId)).length, 0);

  // Repeat all evidence while the account remains paused. The retained dispatch
  // restores its original source holds. Settlement applies the usage, not a new dispatch.
  for (let pass = 0; pass < 2; pass += 1) {
    await replayPayments(a, journal);
    await replayDispatch(checkpoint);
    await settle(credit, a, postId, evidenceId);
    assert.deepEqual(await usageIds(restored, a, postId), expectedUsageIds);
    const replayed = await readDispatch(restored, a, postId);
    assert.equal(replayed.operation.permit, expectedUsage.operation.permit);
    assert.deepEqual(replayed.operation.route, expectedUsage.operation.route);
    assert.equal(replayed.operation.paidChargeMicrocredits, 7n);
    assert.deepEqual(
      replayed.allocations.map(({ id, consumedMicrocredits }) => ({
        id,
        consumedMicrocredits,
      })),
      expectedUsage.allocations.map(({ id, consumedMicrocredits }) => ({
        id,
        consumedMicrocredits,
      })),
    );
    assert.equal(replayed.hold.state, "verified");
    assert.equal(replayed.hold.costMicrocredits, 7n);
    assert.deepEqual(await paid.paidBalance(a.accountId), expectedBalance);
    assert.deepEqual(await credit.pilotProviderCost(), expectedExposure);
    assert.deepEqual(await credit.providerCost(routeId), expectedRouteCost);
    await assert.rejects(freshOrder(a), { code: "ledger_restoring" });
  }
  assert.ok(await paid.resumeAccount(a.accountId));
  assert.equal((await freshOrder(a)).state, "pending");
  await assert.rejects(freshOrder(b), { code: "ledger_restoring" });

  const waiting = await reserve(credit, a, "rollback-waiting");
  const rollbackId = "rollback-in-flight";
  await dispatch(credit, a, rollbackId);
  const frozen = (await readDispatch(restored, a, rollbackId)).operation;
  const restorePending = "pre-snapshot-dispatched";
  await install(restored, replacementRoute, 10_000_000);
  assert.deepEqual(await credit.beginDispatch(a.identity, waiting), {
    state: "denied",
    reason: "route_unavailable",
  });
  assert.deepEqual(
    await credit.reserve(a.identity, {
      ...waiting,
      operationId: "rollback-blocked",
    }),
    { state: "denied", reason: "route_unavailable" },
  );
  assert.equal(frozen.paidHoldMicrocredits, 10n);
  const oldDuringDrain = await withLegacyApi(a, "draining", async (root) => {
    const before = await probeLegacy(root, rollbackId, "pending");
    assert.equal(before.quoteStatus, 503);
    await settle(credit, a, restorePending, "trusted-usage-pre-snapshot");
    await settle(credit, a, rollbackId, "trusted-usage-rollback");
    const after = await probeLegacy(root, rollbackId, "settled");
    return { before, after };
  });
  const drained = await readDispatch(restored, a, rollbackId);
  assert.equal(drained.operation.priceVersion, frozen.priceVersion);
  assert.deepEqual(drained.operation.route, frozen.route);
  assert.equal(drained.operation.paidChargeMicrocredits, 7n);
  assert.equal(drained.allocations[0]?.consumedMicrocredits, 7n);
  assert.equal(drained.hold.costMicrocredits, 7n);
  const pending = await restored
    .select({ id: testCreditOperations.id })
    .from(testCreditOperations)
    .where(eq(testCreditOperations.state, "pending"));
  assert.deepEqual(pending, []);
  const oldAfterDrain = await withLegacyApi(a, "drained", (root) =>
    probeLegacy(root, rollbackId, "settled"),
  );
  assert.equal(oldAfterDrain.quoteStatus, 200);
  assert.equal(oldAfterDrain.quote?.route, replacementRoute);
  await assert.rejects(freshOrder(b), { code: "ledger_restoring" });

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(dump)) hash.update(chunk);
  return {
    currentRevision: config.REHEARSAL_HEAD,
    legacyRevision: config.REHEARSAL_LEGACY,
    snapshotSha256: hash.digest("hex"),
    snapshot: {
      paymentOrderId: existing.order.id,
      refundId: (await requirePayment(source, oldRefund.order.id)).refund?.id,
      dispatchedOperation: restorePending,
    },
    replay: {
      passes: 2,
      orderId: later.order.id,
      channelReference: later.channel.reference,
      entitlementId: later.entitlement.id,
      refund: {
        orderId: laterRefundPayment.order.id,
        id: refundEvidence.refundId,
        channelReference: refundEvidence.orderReference,
      },
      operationId: postId,
      ...expectedUsageIds,
      balance: expectedBalance,
      sharedSupplierExposure: expectedExposure,
      routeSupplierExposure: expectedRouteCost,
      verifiedAccount: a.accountId,
      discrepantAccountStillPaused: b.accountId,
    },
    rollback: {
      oldDuringDrain,
      oldAfterDrain,
      operationId: rollbackId,
      priceVersion: frozen.priceVersion,
      charge: drained.operation.paidChargeMicrocredits,
      pendingCurrentOperations: pending.length,
    },
  };
}

try {
  const result = await run();
  const output = JSON.stringify(
    result,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  console.log(output);
} finally {
  await Promise.all([source.$client.close(), restored.$client.close()]);
}
