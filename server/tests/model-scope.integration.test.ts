import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase, type Database } from "../src/db/client";
import {
  auditEvents,
  billingCustomers,
  creditReservations,
} from "../src/db/schema";
import {
  createEnterpriseGatewayCatalogStore,
  type CatalogEntry,
} from "../src/gateway/catalog";
import { gatewayAdminRoutes } from "../src/gateway/admin-routes";
import {
  createEnterpriseGatewayModelScopeStore,
  createGatewayModelScopeService,
  type GatewayModelScopeService,
} from "../src/gateway/model-scope";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.7 (#229, AC10/AC19/Q4/Q17) — the administrator's model open
 * scope, over a real PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts
 * refuses the live database).
 *
 * What only this file can prove:
 *
 * - a model the catalog holds but no administrator opened is NOT selectable
 *   or invocable: `isModelOpen` is false, and a sync that adds models widens
 *   nothing (默认未开放);
 * - opening and closing are administrator actions with a recorded reason and
 *   an audit row each (开放与关闭操作都有审计记录与原因), and both refuse
 *   without a reason, an unknown ref, or an unpriced/unknown-priced ref;
 * - closing a model leaves every previously locked price snapshot and every
 *   existing credit reservation exactly as they were — the scope change is
 *   admission-bound, never retrospective (开放范围变更不影响既有预留);
 * - the admin routes carry the same authorization as the rest of the gateway
 *   surface (member and anonymous refused) and refuse with displayable codes.
 *
 * The catalog table is replaceable and the scope table is updatable, so the
 * suite resets both; the price snapshot and audit tables are append-only, so
 * every test isolates itself with unique provider names and unique target ids
 * instead of cleaning up.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

// The AC4 seed rows, deleted again in afterAll (see there for why).
let seededReservationRows:
  | { customer: string; reservationId: string }
  | undefined;
const catalogStore = createEnterpriseGatewayCatalogStore(database);
const priceStore = createEnterpriseGatewayPriceSnapshotStore(database);
const auditStore = createAuditStore(database);

/** Monotonic test clock so append-only rows keep a strict order. */
let tick = Date.now();

function nextId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function chatRef(provider: string, model = "gpt-4o") {
  return { provider, model, capability: "chat" as const };
}

function catalogEntry(provider: string, model = "gpt-4o"): CatalogEntry {
  return {
    ref: chatRef(provider, model),
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}`, supported_methods: ["chat"] },
  };
}

function fullyPricedDims(): PriceSnapshotDims {
  // Every necessary dimension the v1 wire can price carries a known amount —
  // the shape 03.3's own classification tests call fully priced.
  return mapPriceDims({
    id: "openai/gpt-4o",
    pricing: {
      prompt: "0.0000025000",
      completion: "0.0000100000",
      request: "0.0",
      image: "0.0036130000",
      web_search: "0.0250000000",
      internal_reasoning: "0.0001000000",
      input_cache_read: "0.0000012500",
      input_cache_write: "0.0000031250",
    },
  });
}

function unpricedDims(): PriceSnapshotDims {
  return mapPriceDims({ id: "openai/gpt-4o" });
}

function appendInput(
  modelRef: ReturnType<typeof chatRef>,
  dims: PriceSnapshotDims,
): PriceSnapshotAppendInput {
  tick += 1_000;
  return {
    ref: modelRef,
    dims,
    fetchedAt: new Date(tick).toISOString(),
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: null,
  };
}
/** Replace the whole last-good catalog, the way a successful sync does. */
async function syncCatalog(providers: { provider: string; model?: string }[]) {
  tick += 1_000;
  await catalogStore.replaceCatalog({
    entries: providers.map((p) => catalogEntry(p.provider, p.model)),
    record: {
      fetchedAt: new Date(tick).toISOString(),
      source: "gateway:/v1/models",
      rawItemCount: providers.length,
      configVersion: 7,
    },
  });
}

async function latestAuditRow(targetId: string) {
  const [row] = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "gateway.model_scope_changed"),
        eq(auditEvents.targetId, targetId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  return row;
}

async function auditRowCount(targetId: string) {
  const rows = await database
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "gateway.model_scope_changed"),
        eq(auditEvents.targetId, targetId),
      ),
    );
  return rows.length;
}

function service(): GatewayModelScopeService {
  return createGatewayModelScopeService({
    catalog: catalogStore,
    priceSnapshots: priceStore,
    scopes: createEnterpriseGatewayModelScopeStore(database),
    audit: auditStore,
    now: () => {
      tick += 1_000;
      return new Date(tick);
    },
  });
}

/** A requireUser stand-in that answers like the real guard. */
function actorAs(role: "admin" | "user" | "anonymous") {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (role === "anonymous") {
      return context.json({ error: "Authentication required." }, 401);
    }
    const actor: AuthenticatedActor = {
      id: `model-scope-${role}`,
      email: `model-scope-${role}@openbot.test`,
      role,
    };
    context.set("actor", actor);
    await next();
  };
  return guard;
}

function routesWith(serviceInstance: GatewayModelScopeService | undefined) {
  return gatewayAdminRoutes(actorAs("admin"), {
    modelScopeService: () => serviceInstance,
  });
}

beforeAll(async () => {
  // The catalog and scope tables are replaceable/updatable; clear them so the
  // suite starts from a known-empty directory. Append-only tables are not
  // touched (unique providers isolate instead).
  const { gatewayModelOpenScopes, gatewayModelCatalogRefs } = await import(
    "../src/db/schema"
  );
  await database.delete(gatewayModelOpenScopes);
  await database.delete(gatewayModelCatalogRefs);
});

afterAll(async () => {
  // The AC4 reservation must not outlive this file: on the shared test
  // database its 60s expiry later names it to every recovery suite's scan,
  // which rejects the `reservation-` id shape outright.
  if (seededReservationRows) {
    await database
      .delete(creditReservations)
      .where(eq(creditReservations.id, seededReservationRows.reservationId));
    await database
      .delete(billingCustomers)
      .where(eq(billingCustomers.externalId, seededReservationRows.customer));
  }
  await database.$client.close();
});

describe("default closed (同步新增的模型默认未开放)", () => {
  test("a cataloged model no administrator opened is not open", async () => {
    const provider = nextId("default-closed");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);

    const scope = service();
    expect(await scope.isModelOpen(modelRef)).toBe(false);

    // The admin view says the same: cataloged, never acted on, closed by default.
    const view = await scope.listAdminCatalog();
    const entry = view.find((candidate) => candidate.ref.provider === provider);
    expect(entry).toBeDefined();
    expect(entry?.open).toBe(false);
    expect(entry?.scope).toBeNull();
  });

  test("a sync that adds models opens none of them and closes none that were opened", async () => {
    const provider = nextId("sync-widen");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);

    const scope = service();
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);
    const opened = await scope.openModel({
      ref: modelRef,
      reason: "reviewed pricing",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(opened.ok).toBe(true);

    // The next sync adds a second model: the new one is closed, the opened
    // one keeps its administrator's decision.
    const second = nextId("sync-widen");
    await syncCatalog([{ provider }, { provider: second }]);
    expect(await scope.isModelOpen(chatRef(second))).toBe(false);
    expect(await scope.isModelOpen(modelRef)).toBe(true);
  });

  test("a delisted model is not open even though an administrator opened it", async () => {
    const provider = nextId("delisted");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);

    const scope = service();
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);
    expect(
      (
        await scope.openModel({
          ref: modelRef,
          reason: "temporary window",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);
    expect(await scope.isModelOpen(modelRef)).toBe(true);

    // The gateway stops listing the model: not selectable, not invocable.
    await syncCatalog([]);
    expect(await scope.isModelOpen(modelRef)).toBe(false);
  });
});

describe("opening and closing refuse without their preconditions", () => {
  test("a missing reason is refused", async () => {
    const provider = nextId("no-reason");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);

    const scope = service();
    for (const reason of ["", "   "]) {
      const opened = await scope.openModel({
        ref: modelRef,
        reason,
        actor: { userId: "admin-1", email: "admin@openbot.test" },
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reasonCode).toBe("model_scope_reason_required");
      }
    }
    expect(await scope.isModelOpen(modelRef)).toBe(false);
  });

  test("a ref outside the catalog cannot be opened or closed", async () => {
    const provider = nextId("not-in-catalog");
    const modelRef = chatRef(provider);

    const scope = service();
    const opened = await scope.openModel({
      ref: modelRef,
      reason: "ghost model",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reasonCode).toBe("model_scope_ref_not_in_catalog");
    }
    const closed = await scope.closeModel({
      ref: modelRef,
      reason: "ghost model",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.reasonCode).toBe("model_scope_ref_not_in_catalog");
    }
  });

  test("a ref with no price snapshot cannot be opened", async () => {
    const provider = nextId("price-missing");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);

    const scope = service();
    const opened = await scope.openModel({
      ref: modelRef,
      reason: "no prices synced yet",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reasonCode).toBe("model_scope_price_missing");
    }
    expect(await scope.isModelOpen(modelRef)).toBe(false);
  });

  test("a ref whose price status is unknown cannot be opened", async () => {
    const provider = nextId("price-unknown");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([appendInput(modelRef, unpricedDims())]);

    const scope = service();
    const opened = await scope.openModel({
      ref: modelRef,
      reason: "prices are gaps",
      actor: { userId: "admin-1", email: "admin@openbot.test" },
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reasonCode).toBe("model_scope_price_unknown");
    }
    expect(await scope.isModelOpen(modelRef)).toBe(false);
  });
});

describe("open and close are audited with their reasons", () => {
  test("opening records the reason, the actor and the audit row", async () => {
    const provider = nextId("open-audit");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);

    const scope = service();
    const opened = await scope.openModel({
      ref: modelRef,
      reason: "contract approved for pilot",
      actor: { userId: "admin-7", email: "admin7@openbot.test" },
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.record.state).toBe("open");
      expect(opened.record.reason).toBe("contract approved for pilot");
      expect(opened.record.changedBy).toBe("admin7@openbot.test");
    }
    expect(await scope.isModelOpen(modelRef)).toBe(true);

    const stored = await scope.getScope(modelRef);
    expect(stored?.state).toBe("open");
    expect(stored?.reason).toBe("contract approved for pilot");

    const row = await latestAuditRow(`${provider}|gpt-4o|chat`);
    expect(row).toBeDefined();
    expect(row?.actorUserId).toBe("admin-7");
    expect(row?.payload).toMatchObject({
      provider,
      model: "gpt-4o",
      capability: "chat",
      state: "open",
      previousState: null,
      reason: "contract approved for pilot",
    });
  });

  test("closing records the reason, the previous state and its own audit row", async () => {
    const provider = nextId("close-audit");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);

    const scope = service();
    expect(
      (
        await scope.openModel({
          ref: modelRef,
          reason: "opened for the pilot",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);
    const before = await auditRowCount(`${provider}|gpt-4o|chat`);

    const closed = await scope.closeModel({
      ref: modelRef,
      reason: "vendor contract paused",
      actor: { userId: "admin-2", email: "admin2@openbot.test" },
    });
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.record.state).toBe("closed");
      expect(closed.record.reason).toBe("vendor contract paused");
    }

    expect(await scope.isModelOpen(modelRef)).toBe(false);
    const after = await auditRowCount(`${provider}|gpt-4o|chat`);
    expect(after).toBe(before + 1);

    const row = await latestAuditRow(`${provider}|gpt-4o|chat`);
    expect(row?.actorUserId).toBe("admin-2");
    expect(row?.payload).toMatchObject({
      provider,
      model: "gpt-4o",
      capability: "chat",
      state: "closed",
      previousState: "open",
      reason: "vendor contract paused",
    });
  });

  test("a closed model is neither selectable nor invocable and its reason is displayable", async () => {
    const provider = nextId("closed-select");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);

    const scope = service();
    expect(
      (
        await scope.openModel({
          ref: modelRef,
          reason: "opened",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await scope.closeModel({
          ref: modelRef,
          reason: "pricing re-check pending",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);

    // The selection/invocation gate (consumed by 03.8 and 06.2) refuses.
    expect(await scope.isModelOpen(modelRef)).toBe(false);

    // And the admin view carries the reason a user-facing screen can show.
    const view = await scope.listAdminCatalog();
    const entry = view.find((c) => c.ref.provider === provider);
    expect(entry?.open).toBe(false);
    expect(entry?.scope?.state).toBe("closed");
    expect(entry?.scope?.reason).toBe("pricing re-check pending");
  });
});

describe("a scope change does not touch locked snapshots or existing reservations (AC4)", () => {
  test("closing a model leaves its locked snapshot and live reservation intact", async () => {
    const provider = nextId("locked-reservation");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);

    // The snapshot a running request locked, through the real store.
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);
    const locked = await priceStore.latestPriceSnapshot(modelRef);
    expect(locked).toBeDefined();

    // A live reservation on the locked account, as the billing tables hold it.
    const customer = nextId("reservation-customer");
    const reservationId = nextId("reservation");
    seededReservationRows = { customer, reservationId };
    await database.insert(billingCustomers).values({ externalId: customer });
    await database.insert(creditReservations).values({
      id: reservationId,
      externalCustomerId: customer,
      idempotencyKey: nextId("idem"),
      maximum: 10_000,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const scope = service();
    expect(
      (
        await scope.openModel({
          ref: modelRef,
          reason: "opened",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);

    expect(
      (
        await scope.closeModel({
          ref: modelRef,
          reason: "closed while reservation in flight",
          actor: { userId: "admin-1", email: "admin@openbot.test" },
        })
      ).ok,
    ).toBe(true);

    // New selections and admissions are refused…
    expect(await scope.isModelOpen(modelRef)).toBe(false);

    // …but the locked basis resolves to the same snapshot, still version 1…
    const stillLocked = await priceStore.priceSnapshot(
      modelRef,
      locked!.snapshotVersion,
    );
    expect(stillLocked).toBeDefined();
    expect(stillLocked?.dims).toEqual(locked!.dims);
    const latest = await priceStore.latestPriceSnapshot(modelRef);
    expect(latest?.snapshotVersion).toBe(locked!.snapshotVersion);

    // …and the live reservation is exactly as it was.
    const [reservation] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId))
      .limit(1);
    expect(reservation?.status).toBe("reserved");
    expect(reservation?.maximum).toBe(10_000);
    expect(reservation?.charged).toBeNull();
    expect(reservation?.released).toBeNull();
  });
});

describe("the admin routes carry the surface's authorization and codes", () => {
  test("member and anonymous are refused on the model routes", async () => {
    const scope = service();
    const adminApp = new Hono<{ Variables: AppVariables }>();
    adminApp.route(
      "/api/admin/gateway",
      gatewayAdminRoutes(actorAs("user"), {
        modelScopeService: () => scope,
      }),
    );
    const memberRead = await adminApp.request("/api/admin/gateway/models");
    expect(memberRead.status).toBe(403);

    const anonymousApp = new Hono<{ Variables: AppVariables }>();
    anonymousApp.route(
      "/api/admin/gateway",
      gatewayAdminRoutes(actorAs("anonymous"), {
        modelScopeService: () => scope,
      }),
    );
    const anonymousRead = await anonymousApp.request(
      "/api/admin/gateway/models",
    );
    expect(anonymousRead.status).toBe(401);
  });

  test("the models read answers the catalog view; the scope action opens and closes", async () => {
    const provider = nextId("routes");
    await syncCatalog([{ provider }]);
    const modelRef = chatRef(provider);
    await priceStore.appendSnapshots([
      appendInput(modelRef, fullyPricedDims()),
    ]);

    const adminApp = new Hono<{ Variables: AppVariables }>();
    adminApp.route("/api/admin/gateway", routesWith(service()));

    const read = await adminApp.request("/api/admin/gateway/models");
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      models: {
        ref: { provider: string };
        open: boolean;
        priceStatus: string;
      }[];
    };
    const entry = body.models.find((m) => m.ref.provider === provider);
    expect(entry?.open).toBe(false);
    expect(entry?.priceStatus).toBe("known");

    const open = await adminApp.request("/api/admin/gateway/models/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model: "gpt-4o",
        capability: "chat",
        state: "open",
        reason: "route open",
      }),
    });
    expect(open.status).toBe(200);

    const close = await adminApp.request("/api/admin/gateway/models/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model: "gpt-4o",
        capability: "chat",
        state: "closed",
        reason: "route close",
      }),
    });
    expect(close.status).toBe(200);

    const bad = await adminApp.request("/api/admin/gateway/models/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model: "gpt-4o",
        capability: "chat",
        state: "open",
        reason: "",
      }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { code: string };
    expect(badBody.code).toBe("model_scope_reason_required");
  });

  test("a process without the service answers a tagged 503", async () => {
    const adminApp = new Hono<{ Variables: AppVariables }>();
    adminApp.route("/api/admin/gateway", routesWith(undefined));
    const read = await adminApp.request("/api/admin/gateway/models");
    expect(read.status).toBe(503);
    const body = (await read.json()) as { code: string };
    expect(body.code).toBe("gateway_model_scope_unavailable");
  });
});
