import { afterAll, afterEach, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { paymentOrders } from "../src/db/schema/payment";
import { createPayerAccount } from "../src/billing/payer";
import { deploymentExternalCustomerId } from "../src/billing/service";
import type { PaymentStore } from "../src/billing/payments/types";
import { createPaymentStore } from "../src/billing/payments/store";
import { attributeLegacyOrderOwnership } from "../src/billing/payments/legacy-owner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import type { Database } from "../src/db/client";

/*
 * Order ownership (ticket 10.1, AC14) against a real PostgreSQL on the dedicated test database:
 * an order's payment subject is a PayerRef bound at insert time, server-side — never a request
 * field — and every personal read scope filters on that binding, so another user's order and any
 * quarantined row (unknown_owner, legacy_deployment, or a pre-attribution NULL) are invisible to
 * a person while staying reachable to the internal paths that carry no scope. The legacy rows'
 * attribution is the write-once discipline of payer-legacy.ts applied to orders: explicit mapping
 * verbatim, quarantine otherwise, and a recorded verdict is never reclassified.
 *
 * Order matters here by design: the attribution tests run BEFORE the visibility tests, because
 * attribution scans every ownerless row in the database — a file that planted an ownerless row
 * first would shift the exact counts these tests pin.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store: PaymentStore = createPaymentStore(database);
const prefix = `own-${randomUUID().slice(0, 8)}`;
/** Attribution tests' own rows, so their scannedUnowned counts count only what they planted. */
const attrPrefix = `${prefix}-attr`;
const userA = `${prefix}-alice`;
const userB = `${prefix}-bob`;
const scopeA = { actorPayerRef: { kind: "personal" as const, id: userA } };
const scopeB = { actorPayerRef: { kind: "personal" as const, id: userB } };

afterAll(async () => {
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.createdBy, `${prefix}%`));
  await database.$client.close();
});

afterEach(async () => {
  // The deployment-scope partial unique index allows ONE pending order across the database;
  // every test closes what it opened so the next test's insert finds the slot free.
  const pending = await database
    .select({ id: paymentOrders.id, version: paymentOrders.version })
    .from(paymentOrders)
    .where(like(paymentOrders.createdBy, `${prefix}%`));
  for (const order of pending) {
    await store.cancelOrder(order.id, order.version);
  }
});

function orderInput(
  overrides: Partial<Parameters<PaymentStore["insertOrder"]>[0]> = {},
): Parameters<PaymentStore["insertOrder"]>[0] {
  return {
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
    checkoutPayload: null,
    ownerPayerRef: { kind: "personal", id: userA },
    ...overrides,
  };
}

/** One terminal legacy row inserted straight through drizzle, bypassing the store's rules. */
async function insertRawOrder(input: {
  id: string;
  planCode?: string;
  status?: "canceled" | "expired" | "paid";
  ownerPayerKind?: string | null;
  ownerPayerId?: string | null;
  createdBy?: string;
}) {
  await database.insert(paymentOrders).values({
    id: input.id,
    deploymentScope: "default",
    planCode: input.planCode ?? `legacy-${randomUUID().slice(0, 8)}`,
    provider: "alipay",
    amountCents: 1000,
    currency: "CNY",
    status: input.status ?? "expired",
    activationState: "pending",
    expiresAt: new Date(Date.now() - 60_000),
    createdBy: input.createdBy ?? prefix,
    ownerPayerKind: input.ownerPayerKind ?? null,
    ownerPayerId: input.ownerPayerId ?? null,
  });
}

test("insertOrder refuses an order with no ownerPayerRef and writes no row", async () => {
  const missing = orderInput();
  delete (missing as Record<string, unknown>).ownerPayerRef;
  expect(async () => {
    await store.insertOrder(missing);
  }).toThrow();
  const rows = await database
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(eq(paymentOrders.createdBy, prefix));
  expect(rows).toEqual([]);
});

test("insertOrder refuses the quarantined unknown_owner kind, a blank id and an unknown kind", async () => {
  expect(async () => {
    await store.insertOrder(
      orderInput({
        ownerPayerRef: { kind: "unknown_owner", id: "openbot-deployment-x" },
      }),
    );
  }).toThrow();
  expect(async () => {
    await store.insertOrder(
      orderInput({ ownerPayerRef: { kind: "personal", id: " padded" } }),
    );
  }).toThrow();
  expect(async () => {
    await store.insertOrder(
      orderInput({
        ownerPayerRef: {
          kind: "galactic_emperor" as unknown as "personal",
          id: userA,
        },
      }),
    );
  }).toThrow();
});

test("the order binds the resolved PayerRef verbatim while createdBy stays the audit actor", async () => {
  const { order } = await store.insertOrder(
    orderInput({ createdBy: `${prefix}-clerk` }),
  );
  expect(order.ownerPayerRef).toEqual({ kind: "personal", id: userA });
  expect(order.createdBy).toBe(`${prefix}-clerk`);
});

test("legacy attribution refuses to run without an explicit claimed deployment id", async () => {
  expect(async () => {
    await attributeLegacyOrderOwnership(database, {
      legacyDeploymentId: "  ",
    });
  }).toThrow();
  expect(async () => {
    await attributeLegacyOrderOwnership(database, {
      legacyDeploymentId: "",
    });
  }).toThrow();
});

test("legacy attribution quarantines unexplained orders as unknown_owner on the deployment key", async () => {
  const unclaimedTenant = `tenant-${randomUUID().slice(0, 8)}`;
  await insertRawOrder({ id: `${attrPrefix}-a`, createdBy: attrPrefix });
  const report = await attributeLegacyOrderOwnership(database, {
    legacyDeploymentId: unclaimedTenant,
  });
  expect(report.scannedUnowned).toBe(1);
  expect(report.quarantinedUnknownOwner).toBe(1);
  expect(report.attributedFromMapping).toBe(0);
  const [row] = await database
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, `${attrPrefix}-a`));
  expect(row?.ownerPayerKind).toBe("unknown_owner");
  // Not the order id, not a made-up subject: the derived legacy key the deployment would have
  // billed through — the identity nobody vouched for.
  expect(row?.ownerPayerId).toBe(deploymentExternalCustomerId(unclaimedTenant));
});

test("legacy attribution copies an explicit 02.2 mapping verbatim and is write-once idempotent", async () => {
  const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
  await createPayerAccount(database, {
    kind: "legacy_deployment",
    id: tenantId,
  });
  await insertRawOrder({ id: `${attrPrefix}-b`, createdBy: attrPrefix });
  const first = await attributeLegacyOrderOwnership(database, {
    legacyDeploymentId: tenantId,
  });
  expect(first.scannedUnowned).toBe(1);
  expect(first.attributedFromMapping).toBe(1);
  expect(first.quarantinedUnknownOwner).toBe(0);
  const [afterFirst] = await database
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, `${attrPrefix}-b`));
  expect(afterFirst?.ownerPayerKind).toBe("legacy_deployment");
  expect(afterFirst?.ownerPayerId).toBe(tenantId);

  // A second pass finds nothing unowned and changes nothing.
  const second = await attributeLegacyOrderOwnership(database, {
    legacyDeploymentId: tenantId,
  });
  expect(second.scannedUnowned).toBe(0);
  expect(second.outcomes).toEqual([]);

  // A row quarantined while its tenant was unclaimed STAYS quarantined after the mapping
  // appears: a recorded verdict is never reclassified — the operator's remedy is a new,
  // explicitly decided mapping pass, not a silent flip.
  const lateClaimedTenant = `tenant-${randomUUID().slice(0, 8)}`;
  await insertRawOrder({ id: `${attrPrefix}-c`, createdBy: attrPrefix });
  const pre = await attributeLegacyOrderOwnership(database, {
    legacyDeploymentId: lateClaimedTenant,
  });
  expect(pre.quarantinedUnknownOwner).toBe(1);
  await createPayerAccount(database, {
    kind: "legacy_deployment",
    id: lateClaimedTenant,
  });
  const post = await attributeLegacyOrderOwnership(database, {
    legacyDeploymentId: lateClaimedTenant,
  });
  expect(post.scannedUnowned).toBe(0);
  const [stillQuarantined] = await database
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, `${attrPrefix}-c`));
  expect(stillQuarantined?.ownerPayerKind).toBe("unknown_owner");
  expect(stillQuarantined?.ownerPayerId).toBe(
    deploymentExternalCustomerId(lateClaimedTenant),
  );
});

test("a personal read scope sees only orders owned by that same personal ref", async () => {
  // The deployment holds ONE pending purchase at a time (the pending-scope unique index), so
  // the other user's row is a raw PAID row: it does not fight for the slot, and it is still
  // live for the current-purchase read.
  const mine = await store.insertOrder(orderInput());
  const theirsId = `${prefix}-b-paid`;
  await insertRawOrder({
    id: theirsId,
    status: "paid",
    ownerPayerKind: "personal",
    ownerPayerId: userB,
  });
  // The owner reads their own order…
  expect((await store.readOrder(mine.order.id, scopeA))?.id).toBe(mine.order.id);
  // …another user's scoped read answers null (the route renders that as 404)…
  expect(await store.readOrder(theirsId, scopeA)).toBeNull();
  // …the ownerless internal read (callbacks, sweeper, admin cancel) still answers any row…
  expect((await store.readOrder(theirsId))?.id).toBe(theirsId);
  // …and the "current purchase" read is scoped the same way.
  expect((await store.readLatestLiveOrder(scopeA))?.id).toBe(mine.order.id);
  expect((await store.readLatestLiveOrder(scopeB))?.id).toBe(theirsId);
});

test("quarantined and pre-attribution rows are invisible to every personal scope", async () => {
  await insertRawOrder({
    id: `${prefix}-legacy`,
    ownerPayerKind: "legacy_deployment",
    ownerPayerId: "tenant-legacy",
  });
  await insertRawOrder({
    id: `${prefix}-unknown`,
    ownerPayerKind: "unknown_owner",
    ownerPayerId: "openbot-deployment-ghost",
  });
  await insertRawOrder({ id: `${prefix}-unattributed` });
  for (const id of [
    `${prefix}-legacy`,
    `${prefix}-unknown`,
    `${prefix}-unattributed`,
  ]) {
    expect(await store.readOrder(id, scopeA)).toBeNull();
    expect(await store.readOrder(id, scopeB)).toBeNull();
  }
});

test("the window reads (list and count) filter identically by owner", async () => {
  await store.insertOrder(orderInput());
  await store.insertOrder(
    orderInput({
      planCode: `pro-${randomUUID().slice(0, 8)}`,
      ownerPayerRef: { kind: "personal", id: userB },
    }),
  );
  await insertRawOrder({
    id: `${prefix}-stranger`,
    ownerPayerKind: "unknown_owner",
    ownerPayerId: "k",
  });
  const window = { from: null, to: null, limit: 50, offset: 0 };
  const listed = await store.listOrdersInWindow({ ...window, scope: scopeA });
  expect(listed.length).toBeGreaterThan(0);
  for (const order of listed) {
    expect(order.ownerPayerRef).toEqual({ kind: "personal", id: userA });
  }
  const counted = await store.countOrdersInWindow({ ...window, scope: scopeA });
  expect(counted).toBe(listed.length);
  const unscoped = await store.countOrdersInWindow({ ...window });
  expect(unscoped).toBeGreaterThanOrEqual(listed.length + 2);
});

test("the derived deployment key the quarantine records is the legacy billing key itself", () => {
  // Pins the derivation the quarantine names, so an operator querying unknown_owner rows joins
  // on the same string the old stack wrote: openbot-deployment-<tenantId>.
  expect(deploymentExternalCustomerId("t1")).toBe("openbot-deployment-t1");
});
