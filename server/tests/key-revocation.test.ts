import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createRequireUser } from "../src/auth/guards";
import {
  AccessGrantUseError,
  accessGrantRoutes,
  createAccessGrantService,
} from "../src/bot-services/access-grants";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceStore } from "../src/bot-services/store";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  billingCustomers,
  creditReservationAttribution,
  creditReservations,
  gatewayVirtualKeys,
} from "../src/db/schema";
import { createGatewayKeyRenewalService } from "../src/gateway/key-renewal";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.7 (#248): revocation must be IMMEDIATE — the retired authorization's key
 * versions stop working the moment the revocation commits, not when their fifteen minutes
 * run out.
 *
 * The four questions are the ticket's own: (1) a revoked grant's active key versions are
 * retired — locally in the same commit, and the gateway is asked to disable each remote key
 * so an old key cannot start new work there either; (2) a renewal after revocation is
 * refused before anything is dialed; (3) a gateway that cannot be reached does not soften
 * the revocation — the local invalidation lands anyway, the admission paths refuse
 * synchronously, and the failed disable is recorded; (4) the money facts are untouched —
 * settled consumption keeps its ledger and a pending hold keeps occupying its capacity.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const botStore = createBotServiceStore(database);
const issuer = createBindingOfferIssuer({ database, auditStore });

/** Every gateway-disable request the composed revocation seam received, in order. */
const remoteDisableCalls: Array<{
  grantId: string;
  gatewayVirtualKeyIds: string[];
}> = [];

const service = createAccessGrantService({
  database,
  botServices: botStore,
  auditStore,
  revokeGatewayKeys: async (input) => {
    remoteDisableCalls.push(input);
  },
});

const requireUser = createRequireUser(
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-openbot-test-user");
        if (!id) return null;
        return {
          user: {
            id,
            email: `${id}@example.test`,
            name: null,
            image: null,
            role: "user",
          },
        };
      },
    },
  },
  { rolesForUser: async () => ["user"] },
);

const app = accessGrantRoutes(requireUser, service);

const prefix = `b5-248-${randomUUID()}`;
const hint = (suffix = randomUUID().slice(0, 8)) => `slack:${prefix}-${suffix}`;

// Grant ids are the database's opaque UUIDs, so cleanup tracks exactly what this file created.
const createdGrantIds: string[] = [];
const createdKeyRowIds: string[] = [];
const createdReservationIds: string[] = [];
const createdCustomerExternalIds: string[] = [];

afterAll(async () => {
  // Children before parents: keys and attribution name grants/reservations, reservations name
  // customers, grants name bots, offers name bots. Audit rows stay: append-only by design.
  if (createdKeyRowIds.length > 0) {
    await database
      .delete(gatewayVirtualKeys)
      .where(inArray(gatewayVirtualKeys.id, createdKeyRowIds));
  }
  if (createdGrantIds.length > 0) {
    await database
      .delete(creditReservationAttribution)
      .where(inArray(creditReservationAttribution.grantId, createdGrantIds));
    await database
      .delete(accessGrants)
      .where(inArray(accessGrants.grantId, createdGrantIds));
  }
  if (createdReservationIds.length > 0) {
    await database
      .delete(creditReservations)
      .where(inArray(creditReservations.id, createdReservationIds));
  }
  if (createdCustomerExternalIds.length > 0) {
    await database
      .delete(billingCustomers)
      .where(inArray(billingCustomers.externalId, createdCustomerExternalIds));
  }
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

async function registeredBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  const existing = await botStore.getBotService(botId);
  if (existing) return existing;
  return botStore.register({
    botId,
    displayName: `Key Revocation Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
}

async function confirmedGrant(
  userId: string,
  botSuffix: string,
  identity = hint(),
) {
  await registeredBot(botSuffix);
  const botId = `${prefix}-${botSuffix}`;
  const offer = await issuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await service.confirm(userId, offer.bindingCode);
  createdGrantIds.push(grant.grantId);
  return { grant, botId };
}

/** One locally-recorded active key version, as a claim or renewal would have written it. */
async function activeKeyVersion(
  grant: { grantId: string; userId: string },
  botId: string,
  credentialVersion: number,
) {
  const [row] = await database
    .insert(gatewayVirtualKeys)
    .values({
      id: `gvk-${randomUUID()}`,
      grantId: grant.grantId,
      botId,
      gatewayCustomerId: `${prefix}-customer`,
      gatewayVirtualKeyId: `vk-${prefix}-${credentialVersion}-${randomUUID()}`,
      valueHash: randomUUID().replace(/-/g, "").repeat(4),
      credentialVersion,
      status: "active",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  if (row) createdKeyRowIds.push(row.id);
  return row;
}

function request(
  path: string,
  userId: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (userId) headers["x-openbot-test-user"] = userId;
  return app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

test("revocation retires every active key version of the grant: the rows flip to revoked in the same commit and the gateway is asked to disable each remote key", async () => {
  const userId = `${prefix}-retire`;
  const { grant, botId } = await confirmedGrant(userId, "retire");
  const v1 = await activeKeyVersion(grant, botId, 1);
  const v2 = await activeKeyVersion(grant, botId, 2);

  const response = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { revoked: boolean };
  expect(body.revoked).toBe(true);

  // The retirement is local and immediate: no version of this grant reads active anymore.
  const rows = await database
    .select()
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.grantId, grant.grantId));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.status).toBe("revoked");
  }

  // And the gateway was asked to disable exactly the remote keys this grant still held —
  // that disable is what makes an old key unable to start new work at the gateway.
  expect(remoteDisableCalls).toHaveLength(1);
  expect(remoteDisableCalls[0]?.grantId).toBe(grant.grantId);
  expect(remoteDisableCalls[0]?.gatewayVirtualKeyIds.sort()).toEqual(
    [v1.gatewayVirtualKeyId, v2.gatewayVirtualKeyId].sort(),
  );

  // The admission seam the next request would ride refuses, synchronously, from the row.
  await expect(
    service.resolveForBot(grant.grantId, { botId }),
  ).rejects.toThrow(AccessGrantUseError);
});

test("a revocation whose gateway disable fails still takes effect: the local invalidation lands, the refusal stays synchronous, and the failure is recorded", async () => {
  // The deployment-composed seam is total on purpose; this is its vocabulary under a
  // gateway that cannot be reached.
  const { createGrantKeyRevocator } = await import("../src/gateway/key-revocation");
  const failingRevocator = createGrantKeyRevocator({
    deactivationClient: {
      deactivateVirtualKey: async () => {
        throw new Error("renewal_vk_unreachable: no connection to the gateway");
      },
    },
    auditStore,
  });
  const unreachableService = createAccessGrantService({
    database,
    botServices: botStore,
    auditStore,
    revokeGatewayKeys: failingRevocator,
  });
  const unreachableApp = accessGrantRoutes(requireUser, unreachableService);
  const unreachableServiceForAdmission = unreachableService;

  const userId = `${prefix}-unreachable`;
  const { grant, botId } = await confirmedGrant(userId, "unreachable");
  const v1 = await activeKeyVersion(grant, botId, 1);

  const response = await unreachableApp.request(
    `/grants/${grant.grantId}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-openbot-test-user": userId },
    },
  );
  // The revocation itself succeeds: a dead gateway does not un-revoke the person's grant.
  expect(response.status).toBe(200);
  const body = (await response.json()) as { revoked: boolean };
  expect(body.revoked).toBe(true);

  // The version is invalid here, now — no expiry grace, no "sync later".
  const [row] = await database
    .select()
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.id, v1.id));
  expect(row?.status).toBe("revoked");
  await expect(
    unreachableServiceForAdmission.resolveForBot(grant.grantId, { botId }),
  ).rejects.toThrow(AccessGrantUseError);

  // The failed disable is visible: one audit event names the grant and the remote key.
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "gateway.key_revocation_deactivation_failed"),
        eq(auditEvents.targetId, v1.gatewayVirtualKeyId),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toMatchObject({
    grantId: grant.grantId,
    gatewayVirtualKeyId: v1.gatewayVirtualKeyId,
  });
});

test("renewal after revocation is refused as the one uniform grant refusal, before anything is dialed", async () => {
  let dialed = 0;
  let provisioned = 0;
  const userId = `${prefix}-renew`;
  const { grant, botId } = await confirmedGrant(userId, "renew");
  await activeKeyVersion(grant, botId, 1);
  await request(`/grants/${grant.grantId}/revoke`, userId, { method: "POST" });

  const renewal = createGatewayKeyRenewalService({
    database,
    resolveForBot: service.resolveForBot,
    provisionCustomer: async () => {
      provisioned += 1;
      return { customerId: `${prefix}-cust`, provisionState: "existing" as const };
    },
    listSelectableModels: async () => [],
    assertCatalogFresh: async () => ({
      fresh: true,
      reasonCode: "catalog_fresh",
      detail: {},
    }),
    createClient: {
      createVirtualKey: async () => {
        dialed += 1;
        throw new Error("the renewal must not dial the gateway for a dead grant");
      },
    },
    deactivationClient: {
      deactivateVirtualKey: async () => {
        dialed += 1;
        throw new Error("the renewal must not dial the gateway for a dead grant");
      },
    },
    keyTtlMinutes: 15,
  });

  await expect(
    renewal.renewKeyForGrant(grant.grantId, { botId }),
  ).rejects.toThrow(AccessGrantUseError);
  // Nothing was dialed and no account was provisioned: the refusal is entirely local.
  expect(dialed).toBe(0);
  expect(provisioned).toBe(0);
});

test("a repeated revocation neither re-disables remote keys nor rewrites history", async () => {
  const userId = `${prefix}-idem`;
  const { grant, botId } = await confirmedGrant(userId, "idem");
  await activeKeyVersion(grant, botId, 1);

  const first = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(first.status).toBe(200);
  expect(((await first.json()) as { revoked: boolean }).revoked).toBe(true);
  const callsAfterFirst = remoteDisableCalls.length;

  const second = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(second.status).toBe(200);
  expect(((await second.json()) as { revoked: boolean }).revoked).toBe(false);

  // The idempotent no-op goes nowhere near the gateway seam and writes no second audit event.
  expect(remoteDisableCalls.length).toBe(callsAfterFirst);
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.revoked"),
        eq(auditEvents.targetId, grant.grantId),
      ),
    );
  expect(events).toHaveLength(1);
});

test("revocation leaves settled consumption and pending holds exactly as they were", async () => {
  const userId = `${prefix}-money`;
  const { grant, botId } = await confirmedGrant(userId, "money");

  // One pending hold (an unconfirmed consumption's occupancy) standing on this grant.
  const customerExternalId = `${prefix}-money-cust`;
  await database
    .insert(billingCustomers)
    .values({ externalId: customerExternalId });
  createdCustomerExternalIds.push(customerExternalId);
  const [reservation] = await database
    .insert(creditReservations)
    .values({
      id: `res-${randomUUID()}`,
      externalCustomerId: customerExternalId,
      idempotencyKey: `${prefix}-money-idem`,
      maximum: 100,
      status: "reserved",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  if (reservation) createdReservationIds.push(reservation.id);
  await database.insert(creditReservationAttribution).values({
    reservationId: reservation.id,
    grantId: grant.grantId,
    botId,
  });

  const before = {
    ledger: (await database.select({ n: count() }).from(creditReservations))[0]
      ?.n,
  };

  const response = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(response.status).toBe(200);

  // The hold still occupies capacity under the same grant: settlement responsibility is
  // exactly where revocation found it.
  const [afterReservation] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservation.id));
  expect(afterReservation?.status).toBe("reserved");
  expect(afterReservation?.maximum).toBe(100);
  expect(afterReservation?.terminalAt).toBeNull();
  const [attribution] = await database
    .select()
    .from(creditReservationAttribution)
    .where(eq(creditReservationAttribution.reservationId, reservation.id));
  expect(attribution?.grantId).toBe(grant.grantId);

  const after = {
    ledger: (await database.select({ n: count() }).from(creditReservations))[0]
      ?.n,
  };
  expect(after).toEqual(before);
});

test("a grant that never held a key revokes without touching the gateway seam", async () => {
  const userId = `${prefix}-nokeys`;
  const { grant } = await confirmedGrant(userId, "nokeys");
  const callsBefore = remoteDisableCalls.length;

  const response = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { revoked: boolean }).revoked).toBe(true);
  expect(remoteDisableCalls.length).toBe(callsBefore);
});

test("a revocation whose audit write fails still asks the gateway to disable every retired key", async () => {
  // F1 (run5 audit): the audit row is fail-closed, but it sits AFTER the commit. If the
  // only way to reach the gateway seam is through that write, a transient audit failure
  // leaves the remote key alive with nothing recording it. The seam must run regardless.
  const userId = `${prefix}-auditfail`;
  const { grant, botId } = await confirmedGrant(userId, "auditfail");
  await activeKeyVersion(grant, botId, 1);

  const seamCalls: string[][] = [];
  const failingAuditStore = {
    insert: async (event: { eventType: string }) => {
      if (event.eventType === "model_access.revoked") {
        throw new Error("audit_events insert failed");
      }
      return auditStore.insert(event as never);
    },
  } as unknown as typeof auditStore;
  const svc = createAccessGrantService({
    database,
    botServices: botStore,
    auditStore: failingAuditStore,
    revokeGatewayKeys: async ({ gatewayVirtualKeyIds }) => {
      seamCalls.push([...gatewayVirtualKeyIds]);
    },
  });

  await expect(svc.revokeForUser(grant.grantId, userId)).rejects.toThrow(
    "audit_events insert failed",
  );

  // The commit stands (the person's answer is true), the trail refused to name it,
  // and the remote disable was still attempted exactly once for the retired key.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grant.grantId));
  expect(row?.status).toBe("revoked");
  expect(seamCalls).toHaveLength(1);
  expect(seamCalls[0]).toHaveLength(1);
});
