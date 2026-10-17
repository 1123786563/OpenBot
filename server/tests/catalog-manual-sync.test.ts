import { afterAll, beforeEach, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  gatewayCatalogFetches,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayPriceSnapshots,
} from "../src/db/schema";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createEnterpriseGatewayCatalogStore,
  createGatewayCatalogService,
  type GatewayCatalogStore,
} from "../src/gateway/catalog";
import {
  gatewayAdminRoutes,
  type GatewayAdminRouteDeps,
} from "../src/gateway/admin-routes";
import {
  createEnterpriseGatewayCatalogSyncStore,
  createGatewayCatalogSyncService,
} from "../src/gateway/catalog-sync";
import type { GatewayEndpointConfig } from "../src/gateway/endpoint-config";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  createGatewayPriceSnapshotService,
} from "../src/gateway/price-snapshot";
import type { GatewayReadiness } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { startFakeGateway } from "./support/fake-gateway";

/*
 * Bifrost 03.5 (#227): the administrator's "sync now" trigger, served by the
 * same gateway admin surface every other administrator action uses, over the
 * real PostgreSQL on TEST_DATABASE_URL and the same programmable fake gateway
 * the 03.1/03.4 suites dial.
 *
 * What only this boundary can prove:
 *
 * - a member and an anonymous caller are refused, and nothing runs (no dial,
 *   no fetch row, no snapshot, no audit row);
 * - an administrator's trigger runs the SAME sync implementation 03.4's timer
 *   runs — the last-good rules, the append-only snapshots, the singleton state
 *   row — and answers the outcome (synced time, appended snapshot versions,
 *   or the layer's fixed reason code), so a failed manual sync never writes a
 *   partial anything;
 * - repeated triggers share the one in-flight run: the gateway is dialed
 *   once, one snapshot version is minted, and every trigger still gets its
 *   own audit row;
 * - every executed trigger is audited (operator, time, result), and a broken
 *   audit trail refuses the trigger rather than answering success unrecorded;
 * - a process that never wired the sync service answers a tagged 503 — the
 *   trigger never assembles a second, unprotected sync of its own.
 *
 * Append-only tables are attributed the 03.4 way: a unique provider per run,
 * a monotonic clock pushed past the fetch log, and audit rows scoped by this
 * suite's own actor ids (the trail's retention window refuses deletes of
 * fresh rows, so nothing here deletes what it wrote).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const catalogStore: GatewayCatalogStore =
  createEnterpriseGatewayCatalogStore(database);
const priceStore = createEnterpriseGatewayPriceSnapshotStore(database);
const syncStore = createEnterpriseGatewayCatalogSyncStore(database);

/** The audit event the route writes; kept in step with the route's constant. */
const SYNC_AUDIT_EVENT_TYPE = "gateway.catalog_sync_triggered";

const runId = randomUUID().slice(0, 8);
const admin = {
  userId: `manual-sync-admin-${runId}`,
  email: `manual-sync-admin-${runId}@openbot.test`,
};
const member = {
  userId: `manual-sync-member-${runId}`,
  email: `manual-sync-member-${runId}@openbot.test`,
};

/** Providers are unique per run: the price snapshot table is append-only. */
const PROVIDER = `manual-sync-${runId}`;

function readyReadiness(): GatewayReadiness {
  return {
    ready: true,
    blockingReasons: [],
    configVersion: 7,
    checkedAt: "2026-10-17T00:00:00.000Z",
  };
}

function catalogModelBody(entries: unknown[]) {
  return JSON.stringify({ object: "list", data: entries });
}

function manifestBody(): string {
  return catalogModelBody([
    {
      id: `${PROVIDER}/gpt-4o`,
      supported_methods: ["chat"],
      pricing: { prompt: "0.0000025", completion: "0.00001" },
    },
  ]);
}

/**
 * Monotonic test clock, the 03.4 suite's rule: every fetch stamps a strictly
 * later completion time than the one before, and each test pushes the clock
 * past the log's newest row first.
 */
let tick = Date.now();

async function advanceClockPastLog() {
  const [row] = await database
    .select({
      newest: sql<Date | null>`max(${gatewayCatalogFetches.fetchedAt})`,
    })
    .from(gatewayCatalogFetches);
  const newest = row?.newest ? new Date(row.newest).getTime() : 0;
  if (newest >= tick) tick = newest + 60_000;
}

let endpoint: GatewayEndpointConfig = {
  baseUrl: "http://127.0.0.1:1",
  requestTimeoutMs: 5_000,
  configVersion: 7,
};

function catalogService() {
  return createGatewayCatalogService({
    assertGatewayReady: async () => readyReadiness(),
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "admin-key" }),
    store: catalogStore,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  });
}

function priceService() {
  return createGatewayPriceSnapshotService({
    listCatalogEntries: () => catalogStore.readCatalogRefs(),
    store: priceStore,
    readRateVersion: async () => null,
    now: () => new Date(tick),
  });
}

/**
 * The very instance the routes drive in these tests — the same shape the
 * deployment wiring installs, so the single-flight cell under test is the
 * one a second click would join.
 */
function syncService() {
  return createGatewayCatalogSyncService({
    catalog: catalogService(),
    prices: priceService(),
    store: syncStore,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  });
}

const auditStore = createAuditStore(database);

/**
 * One deps instance per app: the sync service is created once and closed
 * over, the way the deployment wiring installs one instance the timer and
 * every trigger share — a fresh service per request would have its own
 * single-flight cell and the shared-run guarantee would be vacuous.
 */
function depsFor(overrides?: {
  syncService?: GatewayAdminRouteDeps["syncService"];
  auditStore?: GatewayAdminRouteDeps["auditStore"];
}): GatewayAdminRouteDeps {
  const service = syncService();
  return {
    syncService: overrides?.syncService ?? (() => service),
    auditStore: overrides?.auditStore ?? (() => auditStore),
  };
}

/** A requireUser stand-in that answers like the real guard: anonymous is refused. */
function actorAs(
  role: "admin" | "user" | "anonymous",
  identity?: { userId: string; email: string },
) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (role === "anonymous") {
      return context.json({ error: "Authentication required." }, 401);
    }
    const who = identity ?? (role === "admin" ? admin : member);
    const actor: AuthenticatedActor = {
      id: who.userId,
      email: who.email,
      role,
    };
    context.set("actor", actor);
    await next();
  };
  return guard;
}

/**
 * Audit rows are append-only within any retention window, so every test that
 * asserts on the trail scopes itself with its own run-unique actor id and
 * asserts exact counts against that actor alone.
 */
function testAdmin(suffix: string) {
  return { userId: `${admin.userId}-${suffix}`, email: `${admin.userId}-${suffix}@openbot.test` };
}

function appAs(
  role: "admin" | "user" | "anonymous",
  overrides?: {
    syncService?: GatewayAdminRouteDeps["syncService"];
    auditStore?: GatewayAdminRouteDeps["auditStore"];
    identity?: { userId: string; email: string };
  },
) {
  return gatewayAdminRoutes(actorAs(role, overrides?.identity), depsFor(overrides));
}

async function syncAttempts(): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(gatewayCatalogFetches)
    .where(like(gatewayCatalogFetches.source, "%"));
  return row?.count ?? 0;
}

async function fetchRowsForProvider(): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(gatewayCatalogFetches)
    .where(eq(gatewayCatalogFetches.source, "gateway:/v1/models"));
  return row?.count ?? 0;
}

async function auditRowsFor(actorId: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      actorUserId: auditEvents.actorUserId,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, SYNC_AUDIT_EVENT_TYPE),
        eq(auditEvents.actorUserId, actorId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt));
}

async function snapshotVersions(): Promise<number[]> {
  const rows = await database
    .select({ v: gatewayPriceSnapshots.snapshotVersion })
    .from(gatewayPriceSnapshots)
    .where(
      and(
        eq(gatewayPriceSnapshots.provider, PROVIDER),
        eq(gatewayPriceSnapshots.model, "gpt-4o"),
        eq(gatewayPriceSnapshots.capability, "chat"),
      ),
    )
    .orderBy(gatewayPriceSnapshots.snapshotVersion);
  return rows.map((row) => row.v);
}

async function catalogRefs(): Promise<
  { provider: string; model: string; capability: string }[]
> {
  return database
    .select({
      provider: gatewayModelCatalogRefs.provider,
      model: gatewayModelCatalogRefs.model,
      capability: gatewayModelCatalogRefs.capability,
    })
    .from(gatewayModelCatalogRefs)
    .where(eq(gatewayModelCatalogRefs.provider, PROVIDER));
}

beforeEach(async () => {
  await database.delete(gatewayCatalogSyncState);
  await database.delete(gatewayModelCatalogRefs);
  await advanceClockPastLog();
});

afterAll(async () => {
  // The retention window refuses to delete rows it can still see, so this
  // suite leaves the rows it wrote — each scoped by run-unique actor ids.
  await database.$client.close();
});

describe("the manual sync trigger refuses callers who are not administrators", () => {
  test("a member is refused with 403 and nothing runs", async () => {
    const app = appAs("user");
    const beforeFetches = await syncAttempts();
    const beforeAudit = (await auditRowsFor(member.userId)).length;

    const response = await app.request("/catalog/sync", { method: "POST" });

    expect(response.status).toBe(403);
    expect(await syncAttempts()).toBe(beforeFetches);
    expect((await auditRowsFor(member.userId)).length).toBe(beforeAudit);
    const state = await syncStore.readSyncState();
    expect(state.lastAttemptAt).toBeNull();
  });

  test("an anonymous caller is refused with 401", async () => {
    const app = appAs("anonymous");
    const response = await app.request("/catalog/sync", { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("an administrator's trigger runs the same sync and answers the outcome", () => {
  test("success answers the synced time and the appended snapshot version count", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    const who = testAdmin("success");
    const app = appAs("admin", { identity: who });

    const response = await app.request("/catalog/sync", { method: "POST" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result:
        | {
            status: "ok";
            syncedAt: string;
            appended: number;
            skipped: number;
            record: { configVersion: number };
          }
        | { status: "failed"; reasonCode: string };
    };
    expect(body.result.status).toBe("ok");
    if (body.result.status !== "ok") throw new Error("expected ok");
    expect(body.result.appended).toBe(1);
    expect(body.result.skipped).toBe(0);
    expect(body.result.record.configVersion).toBe(7);
    expect(Number.isNaN(Date.parse(body.result.syncedAt))).toBe(false);

    // The same last-good rules the timer runs: refs and snapshot v1 landed.
    expect(await catalogRefs()).toEqual([
      { provider: PROVIDER, model: "gpt-4o", capability: "chat" },
    ]);
    expect(await snapshotVersions()).toEqual([1]);
    const state = await syncStore.readSyncState();
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
    expect(state.lastAttemptStatus).toBe("ok");

    // The trigger is audited: operator, result, and the outcome's own numbers.
    const rows = await auditRowsFor(who.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe("gateway_catalog");
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload.outcome).toBe("ok");
    expect(payload.trigger).toBe("manual");
    expect(payload.appended).toBe(1);
    await gateway.stop();
  });

  test("a failed sync answers the fixed reason and keeps the last-good snapshot", async () => {
    // One green sync first: the last-good snapshot and success time exist.
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    const who = testAdmin("failure");
    const app = appAs("admin", { identity: who });
    const first = await app.request("/catalog/sync", { method: "POST" });
    expect(first.status).toBe(200);
    const greenBefore = await syncStore.readSyncState();
    expect(greenBefore.lastSuccessfulSyncAt).not.toBeNull();

    // The gateway now refuses: the manual trigger must fail the same way the
    // timer's sync would — last-good kept, failure counted, reason recorded.
    gateway.respondWith({ kind: "response", status: 500, body: "boom" });
    await advanceClockPastLog();

    const response = await app.request("/catalog/sync", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result:
        | { status: "ok" }
        | { status: "failed"; stage: string; reasonCode: string; failedAt: string };
    };
    expect(body.result.status).toBe("failed");
    if (body.result.status !== "failed") throw new Error("expected failed");
    expect(body.result.stage).toBe("catalog");
    expect(body.result.reasonCode).toBe("catalog_fetch_invalid_response");

    // Last-good kept: same ref, same single snapshot version, success time moved by nothing.
    expect(await catalogRefs()).toEqual([
      { provider: PROVIDER, model: "gpt-4o", capability: "chat" },
    ]);
    expect(await snapshotVersions()).toEqual([1]);
    const state = await syncStore.readSyncState();
    expect(state.lastSuccessfulSyncAt).toBe(greenBefore.lastSuccessfulSyncAt);
    expect(state.consecutiveFailures).toBe(1);

    // Both triggers of this test are audited: the green one and the failed one.
    const rows = await auditRowsFor(who.userId);
    expect(rows).toHaveLength(2);
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload.outcome).toBe("failed");
    expect(payload.reasonCode).toBe("catalog_fetch_invalid_response");
    await gateway.stop();
  });
});

describe("repeated triggers share one sync", () => {
  test("a second click while a sync runs joins it: one dial, one snapshot, one result", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    const who = testAdmin("shared");
    // One instance handed to the routes — the shape production has: the
    // installed sync service is the very one the test watches. Its fetch is
    // gated before the dial, so the second click can arrive while the first
    // run is provably still in flight.
    let openTheGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    const realCatalog = catalogService();
    const service = createGatewayCatalogSyncService({
      catalog: {
        fetchCatalog: async () => {
          await gate;
          return realCatalog.fetchCatalog();
        },
      },
      prices: priceService(),
      store: syncStore,
      now: () => {
        tick += 1000;
        return new Date(tick);
      },
    });
    const app = appAs("admin", { identity: who, syncService: () => service });

    const first = app.request("/catalog/sync", { method: "POST" });
    while (!(await service.readSyncStatus()).inFlight) {
      await Bun.sleep(5);
    }
    const second = app.request("/catalog/sync", { method: "POST" });
    openTheGate();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { result: { status: string; syncedAt?: string } };
    const b2 = (await r2.json()) as { result: { status: string; syncedAt?: string } };
    expect(b1.result.status).toBe("ok");
    expect(b2.result.status).toBe("ok");
    expect(b2.result.syncedAt).toBe(b1.result.syncedAt);

    // One shared run: the gateway was dialed once and one snapshot version landed.
    const dialed = gateway.requests.filter(
      (request) => request.path === "/v1/models",
    );
    expect(dialed).toHaveLength(1);
    expect(await snapshotVersions()).toEqual([1]);

    // Every trigger is its own audited action, even when the sync was shared.
    const rows = await auditRowsFor(who.userId);
    expect(rows).toHaveLength(2);
    await gateway.stop();
  });

  test("every executed trigger is audited once per click, not per dial", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    const who = testAdmin("sequential");
    const app = appAs("admin", { identity: who });

    // Two sequential triggers: two syncs (the first completed before the
    // second starts), two audit rows, two fetch rows.
    const r1 = await app.request("/catalog/sync", { method: "POST" });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/catalog/sync", { method: "POST" });
    expect(r2.status).toBe(200);

    const rows = await auditRowsFor(who.userId);
    expect(rows).toHaveLength(2);
    expect(await fetchRowsForProvider()).toBeGreaterThanOrEqual(2);
    await gateway.stop();
  });
});

describe("a broken audit trail refuses the trigger", () => {
  test("a trigger whose audit row cannot be written does not answer success", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    const who = testAdmin("broken-audit");
    const app = appAs("admin", {
      identity: who,
      auditStore: () => ({
        insert: async () => {
          throw new Error("audit trail is down");
        },
      }),
    });

    const response = await app.request("/catalog/sync", { method: "POST" });

    // The sync ran, but an unaudited trigger is not a success: the route
    // surfaces the broken trail instead of answering 200.
    expect(response.status).toBe(500);
    const rows = await auditRowsFor(who.userId);
    expect(rows).toHaveLength(0);
    await gateway.stop();
  });
});

describe("a process that never wired the sync service refuses with 503", () => {
  test("the trigger never assembles a second sync of its own", async () => {
    const app = appAs("admin", { syncService: () => undefined });

    const response = await app.request("/catalog/sync", { method: "POST" });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("gateway_catalog_sync_unavailable");
  });
});
