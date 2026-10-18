import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { botServiceRoutes } from "../src/bot-services/auth";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  billingCustomers,
  credentials,
  creditReservations,
} from "../src/db/schema";
import { gatewayCustomers, gatewayVirtualKeys } from "../src/db/schema/gateway";
import { gatewayKeyStatusView } from "../src/gateway/credential-bundle";
import {
  createGatewayCustomerProvisioner,
  type GatewayCustomerProvisioner,
} from "../src/gateway/customer";
import {
  createDeploymentKeyIssuer,
  createGatewayKeyIssuer,
  createGatewayVirtualKeyClient,
  createKeyIssuanceRoutes,
} from "../src/gateway/key-issuance";
import {
  DEFAULT_VIRTUAL_KEY_TTL_MINUTES,
  gatewayKeyUsableForNewRequest,
  MAX_VIRTUAL_KEY_TTL_MINUTES,
  resolveVirtualKeyTtlMinutes,
  virtualKeyTtlMinutesProblem,
  VIRTUAL_KEY_TTL_MINUTES_VARIABLE,
} from "../src/gateway/key-expiry";
import type {
  GatewayReadiness,
  GatewayReadinessService,
} from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.5 (#246): the short-lived virtual key's term. A key is minted with an expiry —
 * fifteen minutes unless the deployment says otherwise — and once the clock passes that
 * instant the key may start no new request. This file answers the ticket's own questions:
 *
 * - the term is a deployment configuration with a legal range, and an illegal value is
 *   refused with a reason that names the variable (boot refuses; nothing half-applies);
 * - the expiry verdict draws the line at the exact instant (`now == expiresAt` is expired,
 *   the same boundary Bifrost's `IsExpiredAt` keeps on the request path), as a pure read;
 * - issuance threads the one term everywhere at once: the local record, the answer's
 *   bundle, the audit payload and the remote create all name the same instant;
 * - after the term, nothing is deleted and nothing is released: the key record survives
 *   (it must — it is part of what an already-incurred consumption's settlement side names)
 *   and a pending reservation is column-for-column untouched (06.8/08.x: expiry is never
 *   release evidence).
 *
 * The clock is injected, never slept on; PostgreSQL is the dedicated test database (the
 * ticket forbids falling back to a development database), and the gateway is the same
 * fake-management-surface pattern the 05.3 issuance tests run against.
 */

describe("05.5 virtual key TTL configuration", () => {
  test("unset environment resolves to the 15-minute default", () => {
    expect(resolveVirtualKeyTtlMinutes({})).toBe(
      DEFAULT_VIRTUAL_KEY_TTL_MINUTES,
    );
    expect(DEFAULT_VIRTUAL_KEY_TTL_MINUTES).toBe(15);
    expect(
      resolveVirtualKeyTtlMinutes({ [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: "  " }),
    ).toBe(15);
  });

  test("a configured value inside the legal range resolves as-is", () => {
    expect(resolveVirtualKeyTtlMinutes({ [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: "1" })).toBe(1);
    expect(resolveVirtualKeyTtlMinutes({ [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: "30" })).toBe(30);
    expect(
      resolveVirtualKeyTtlMinutes({
        [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: String(MAX_VIRTUAL_KEY_TTL_MINUTES),
      }),
    ).toBe(MAX_VIRTUAL_KEY_TTL_MINUTES);
    expect(virtualKeyTtlMinutesProblem("TTL", 15)).toBeUndefined();
    expect(virtualKeyTtlMinutesProblem("TTL", 1440)).toBeUndefined();
  });

  test("zero, negative, fractional, non-numeric and over-ceiling values are refused with a reason naming the variable", () => {
    for (const raw of ["0", "-5", "0.5", "abc", "1441", "1e9"]) {
      let message = "";
      try {
        resolveVirtualKeyTtlMinutes({ [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toContain(VIRTUAL_KEY_TTL_MINUTES_VARIABLE);
      expect(message.length).toBeGreaterThan(VIRTUAL_KEY_TTL_MINUTES_VARIABLE.length);
    }
    // The raw validator answers for programmatic callers too.
    for (const value of [0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1441]) {
      const problem = virtualKeyTtlMinutesProblem(VIRTUAL_KEY_TTL_MINUTES_VARIABLE, value);
      expect(problem).toBeDefined();
      expect(problem).toContain(VIRTUAL_KEY_TTL_MINUTES_VARIABLE);
    }
    // The ceiling itself is a whole number of minutes, named for the reason it bounds.
    expect(MAX_VIRTUAL_KEY_TTL_MINUTES).toBe(1440);
  });
});

describe("05.5 expiry verdict", () => {
  const expiresAt = new Date("2026-01-01T00:15:00.000Z");

  test("a key whose term has not run out is usable", () => {
    expect(
      gatewayKeyUsableForNewRequest(
        { status: "active", expiresAt },
        new Date("2026-01-01T00:14:59.999Z"),
      ),
    ).toEqual({ usable: true });
  });

  test("a null expiresAt (a pre-05.5 record) never expires by the clock", () => {
    expect(
      gatewayKeyUsableForNewRequest(
        { status: "active", expiresAt: null },
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toEqual({ usable: true });
  });

  test("at the exact expiry instant the key is refused", () => {
    // The same boundary Bifrost's IsExpiredAt keeps: now == expires_at is expired.
    expect(
      gatewayKeyUsableForNewRequest(
        { status: "active", expiresAt },
        new Date("2026-01-01T00:15:00.000Z"),
      ),
    ).toEqual({
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: "2026-01-01T00:15:00.000Z",
    });
  });

  test("after expiry the verdict names the reason and the expired-at instant", () => {
    expect(
      gatewayKeyUsableForNewRequest(
        { status: "active", expiresAt },
        new Date("2026-01-01T00:16:00.000Z"),
      ),
    ).toEqual({
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: "2026-01-01T00:15:00.000Z",
    });
  });

  test("a row the state sync already marked expired is refused without consulting the clock", () => {
    expect(
      gatewayKeyUsableForNewRequest(
        { status: "expired", expiresAt: null },
        new Date("2026-01-01T00:00:00.000Z"),
      ).usable,
    ).toBe(false);
  });

  test("a Date and an ISO-string expiresAt decide identically", () => {
    const row = { status: "active", expiresAt: "2026-01-01T00:15:00.000Z" };
    expect(
      gatewayKeyUsableForNewRequest(row, new Date("2026-01-01T00:16:00.000Z")),
    ).toEqual(
      gatewayKeyUsableForNewRequest(
        { status: "active", expiresAt },
        new Date("2026-01-01T00:16:00.000Z"),
      ),
    );
  });
});

/*
 * The integration half: a real PostgreSQL (the dedicated test database), the real grant
 * flow (04.5), the real provisioner (05.1) and the real key-claim route (05.3/05.4) — with
 * the gateway itself a fake management surface, the same pattern the 05.3 issuance tests
 * run, and the clock a variable the tests move. No test sleeps on real time.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const prefix = `b5-246-${run}`;

/** The term under test: the deployment default, so the fast-forward is exactly Q13's 15. */
const TTL_MINUTES = DEFAULT_VIRTUAL_KEY_TTL_MINUTES;

/** The controllable clock: every issuance and every verdict reads it through `now`. */
let clock = new Date("2026-01-01T00:00:00.000Z");
const now = () => new Date(clock.getTime());

const encryptionKey = randomBytes(32).toString("base64");
const auditStore = createAuditStore(database);
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});

const fake = startFakeGateway();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

function readyGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: true,
    blockingReasons: [],
    configVersion: endpoint.configVersion,
    checkedAt: clock.toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => readiness,
  };
}

function provisionerFor(
  gate: GatewayReadinessService = readyGate(),
): GatewayCustomerProvisioner["provisionCustomer"] {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    gate,
  }).provisionCustomer;
}

/** The issuer under test: real seams, fake gateway, the injected clock. */
function expiryIssuer(ttlMinutes: number = TTL_MINUTES) {
  return createGatewayKeyIssuer({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer: provisionerFor(),
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    }),
    auditStore,
    keyTtlMinutes: ttlMinutes,
    now,
  });
}

/** The bot-facing app: the real 04.2 door with the claim route and bundle sources mounted. */
function claimApp() {
  return botServiceRoutes({
    authenticate: registry.authenticate,
    keys: createKeyIssuanceRoutes({
      issue: expiryIssuer().issueKeyForGrant,
      bundle: {
        readGatewayEndpoint: async () => endpoint,
        listSelectableModels: async () => [
          { provider: "fake-provider", model: "expiry-chat", capability: "chat" },
        ],
      },
    }),
  });
}

async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: `Expiry Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

const offerIssuer = createBindingOfferIssuer({ database, auditStore });

async function confirmGrant(userId: string, botId: string, identity: string) {
  const offer = await offerIssuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await registry.modelAccess.confirm(userId, offer.bindingCode);
  return grant;
}

function claimKey(
  app: ReturnType<typeof botServiceRoutes>,
  secret: string,
  grantId: unknown,
) {
  return app.request("/keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ grantId }),
  });
}

/** A fake Bifrost management surface that records the whole virtual-key create body. */
function startFakeGateway() {
  const customers = new Map<string, { id: string }>();
  const vkCreateBodies: Record<string, unknown>[] = [];
  const vkCustomerIds: string[] = [];

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== "Bearer test-admin-key") {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/customers"
      ) {
        const name = ((await request.json()) as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) {
          return json(400, { error: "Customer name is required" });
        }
        if (customers.has(name)) {
          return json(409, { error: "A customer with this name already exists" });
        }
        const id = crypto.randomUUID();
        customers.set(name, { id });
        return json(200, { message: "ok", customer: { id, name } });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/virtual-keys"
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        vkCreateBodies.push(body);
        vkCustomerIds.push(
          typeof body.customer_id === "string" ? body.customer_id : "",
        );
        const id = crypto.randomUUID();
        const value = `sk-bf-${crypto.randomUUID()}`;
        return json(200, {
          message: "Virtual key created successfully",
          virtual_key: { id, name: body.name, value },
        });
      }
      return json(404, { error: "not found" });
    },
  });

  return {
    server,
    /** Create bodies whose customer was created under this run's prefix. */
    vkBodiesForRun(): Record<string, unknown>[] {
      return vkCreateBodies.filter((_, index) =>
        [...customers.entries()].some(
          ([name, entry]) =>
            entry.id === vkCustomerIds[index] && name.includes(run),
        ),
      );
    },
    stop() {
      void server.stop(true);
    },
  };
}

afterAll(async () => {
  // Children before parents; audit rows stay (append-only by design, ids are per-run).
  await database
    .delete(creditReservations)
    .where(like(creditReservations.idempotencyKey, `${prefix}-%`));
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `${prefix}-%`));
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.botId, `${prefix}-%`));
  await database
    .delete(gatewayCustomers)
    .where(like(gatewayCustomers.payerId, `${prefix}-%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}-%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}-%`));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
  await database.$client.close();
  fake.stop();
});

describe("05.5 issuance applies the term", () => {
  test("the deployment issuer refuses to compose on an illegal configured term", () => {
    // The composition throw is what refuses the boot: an illegal term must not
    // half-apply to some later issuance while the deployment looks healthy.
    let message = "";
    try {
      createDeploymentKeyIssuer({
        database: {} as never,
        modelAccess: {} as never,
        environment: { [VIRTUAL_KEY_TTL_MINUTES_VARIABLE]: "0" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain(VIRTUAL_KEY_TTL_MINUTES_VARIABLE);
  });

  test("the issuer core refuses a composition that names an illegal term", () => {
    let message = "";
    try {
      createGatewayKeyIssuer({
        database: {} as never,
        resolveForBot: {} as never,
        provisionCustomer: {} as never,
        client: {} as never,
        keyTtlMinutes: 0,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("keyTtlMinutes");
  });

  test("the minted key's expiresAt lands in the local record, the answer and the bundle identically", async () => {
    const { botId, secret } = await credentialedBot("term-record");
    const grant = await confirmGrant(
      `${prefix}-term-user`,
      botId,
      "idp:term-record",
    );
    clock = new Date("2026-01-01T00:00:00.000Z");
    const expectedExpiry = new Date(
      clock.getTime() + TTL_MINUTES * 60_000,
    ).toISOString();

    const response = await claimKey(claimApp(), secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: { keyId: string; expiresAt: string | null };
      bundle: { expiresAt: string | null };
    };
    expect(body.key.expiresAt).toBe(expectedExpiry);
    expect(body.bundle.expiresAt).toBe(expectedExpiry);

    const [row] = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.id, body.key.keyId));
    expect(row?.expiresAt?.toISOString()).toBe(expectedExpiry);
  });

  test("the remote create carries expires_at and delete_after_expire=false", async () => {
    const { botId, secret } = await credentialedBot("term-remote");
    const grant = await confirmGrant(
      `${prefix}-term-remote-user`,
      botId,
      "idp:term-remote",
    );
    clock = new Date("2026-01-02T00:00:00.000Z");
    const expectedExpiry = new Date(
      clock.getTime() + TTL_MINUTES * 60_000,
    ).toISOString();

    const response = await claimKey(claimApp(), secret, grant.grantId);
    expect(response.status).toBe(200);

    const mine = fake
      .vkBodiesForRun()
      .find(
        (body) =>
          typeof body.name === "string" &&
          body.name.startsWith(`openbot:${grant.grantId}:`),
      );
    expect(mine).toBeDefined();
    expect(mine?.expires_at).toBe(expectedExpiry);
    expect(mine?.delete_after_expire).toBe(false);
  });

  test("the audit payload names the same expiresAt and never the secret", async () => {
    const { botId, secret } = await credentialedBot("term-audit");
    const grant = await confirmGrant(
      `${prefix}-term-audit-user`,
      botId,
      "idp:term-audit",
    );
    clock = new Date("2026-01-03T00:00:00.000Z");
    const expectedExpiry = new Date(
      clock.getTime() + TTL_MINUTES * 60_000,
    ).toISOString();

    const response = await claimKey(claimApp(), secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: { keyId: string };
      bundle: { secret: string };
    };
    expect(body.bundle.secret).toBeTruthy();

    const [event] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "gateway.key_issued"),
          eq(auditEvents.targetId, body.key.keyId),
        ),
      );
    expect(event).toBeDefined();
    const payload = event!.payload as { expiresAt?: string | null };
    expect(payload.expiresAt).toBe(expectedExpiry);
    // The plaintext rides the claim answer only — never the audit trail.
    expect(JSON.stringify(event)).not.toContain(body.bundle.secret);
  });
});

describe("05.5 after the clock passes the term", () => {
  /** One key minted at T0 with the 15-minute default, plus what it owes. */
  async function keyAtTerm() {
    const { botId, secret } = await credentialedBot(
      `expiry-gate-${randomUUID().slice(0, 8)}`,
    );
    const grant = await confirmGrant(
      `${prefix}-expiry-user`,
      botId,
      "idp:expiry-gate",
    );
    clock = new Date("2026-02-01T00:00:00.000Z");
    const response = await claimKey(claimApp(), secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: { keyId: string; expiresAt: string | null };
    };
    const [row] = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.id, body.key.keyId));
    expect(row).toBeDefined();
    return row!;
  }

  /** A reserved hold on this user's account: consumption that already happened. */
  async function reservedHold() {
    const customer = `${prefix}-expiry-customer`;
    await database
      .insert(billingCustomers)
      .values({ externalId: customer })
      .onConflictDoNothing();
    const id = `res-${randomUUID()}`;
    const inserted = {
      id,
      externalCustomerId: customer,
      idempotencyKey: `${prefix}-expiry-hold`,
      maximum: 10_000,
      status: "reserved" as const,
      expiresAt: new Date(clock.getTime() + 3_600_000),
    };
    await database.insert(creditReservations).values(inserted);
    return inserted;
  }

  test("a key fast-forwarded past its term is refused for new requests", async () => {
    const row = await keyAtTerm();
    const term = row.expiresAt!;

    // One minute before the term the key still starts new requests.
    expect(
      gatewayKeyUsableForNewRequest(row, new Date(term.getTime() - 60_000)),
    ).toEqual({ usable: true });

    // Fast-forward past the term (T0 + 15min + 1min): the key is refused.
    clock = new Date(term.getTime() + 60_000);
    expect(gatewayKeyUsableForNewRequest(row, now())).toEqual({
      usable: false,
      reason: "gateway_key_expired",
      expiredAt: term.toISOString(),
    });
  });

  test("expiry deletes nothing: the key record survives intact and stays queryable via the status view", async () => {
    const row = await keyAtTerm();
    clock = new Date(row.expiresAt!.getTime() + 60_000);
    expect(gatewayKeyUsableForNewRequest(row, now()).usable).toBe(false);

    // The verdict is a pure read — re-select the row: every column it had, it still has.
    const [after] = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.id, row.id));
    expect(after).toBeDefined();
    expect(after).toEqual(row);

    // The status contract (05.4 → 05.10) still answers for the expired key.
    expect(gatewayKeyStatusView(after!)).toEqual({
      keyId: row.id,
      status: row.status,
      expiresAt: row.expiresAt!.toISOString(),
      credentialVersion: row.credentialVersion,
    });

    // And the table holds no fewer keys for this grant than before the fast-forward.
    const [{ count }] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.grantId, row.grantId));
    expect(count).toBe(1);
  });

  test("expiry releases nothing: a pre-existing reserved settlement row is column-for-column unchanged", async () => {
    const hold = await reservedHold();
    const row = await keyAtTerm();
    const [before] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, hold.id));
    expect(before?.status).toBe("reserved");

    // The clock crosses the key's term — the moment a naive implementation would
    // "clean up" what the key left behind. Nothing may change but the clock.
    clock = new Date(row.expiresAt!.getTime() + 60_000);
    expect(gatewayKeyUsableForNewRequest(row, now()).usable).toBe(false);

    const [after] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, hold.id));
    expect(after).toEqual(before);
    expect(after?.status).toBe("reserved");
  });
});
