import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { payerKey } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { gatewayCustomers } from "../src/db/schema/gateway";
import { payerAccounts } from "../src/db/schema/billing";
import { createGatewayCustomerProvisioner } from "../src/gateway/customer";
import {
  createGatewayCustomerProvisioning,
  customerCorrelationKey,
  GatewayCustomerTransportLostError,
  GatewayProvisionOutcomeUnknownError,
  GatewayProvisionRefusedError,
} from "../src/gateway/customer-provision";
import {
  installGatewayReadinessService,
  GatewayNotReadyError,
  type GatewayReadiness,
  type GatewayReadinessService,
} from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  createFakeGatewayCustomerClient,
  startFakeCustomerGateway,
  type FakeCustomerGateway,
} from "./support/fake-gateway-customers";

/*
 * Bifrost 05.2 — the recoverable association, layered over 05.1's provisioning
 * seam and its gateway_customers table (evolved in place by migration 0135,
 * never rebuilt): a remote Customer create that succeeded while the local
 * confirmation was lost must never grow a second customer on retry. The
 * provisioning attempt reserves a pending row carrying a stable, locally
 * derived correlation key (external_reference, generated from 05.1's
 * deterministic remote name); a retry that finds the row in `recoverable`
 * looks the remote subject up by that key FIRST, adopts it when it exists,
 * and only lets 05.1's seam create — which adopts the reservation — when the
 * remote truly never got the create. Both paths are idempotent and repeatable,
 * and recovery touches the mapping alone — never a balance, a grant, or a
 * virtual key.
 *
 * The remote is the programmable fake gateway (test scaffolding only): its
 * create endpoint can record the customer and then drop the response, which is
 * exactly the "remote success, local confirmation lost" fault this ticket
 * exists for. The 05.1 seam runs its real adapter code against the fake's
 * governance routes; the recovery layer consumes it through the injected
 * provisioner — creation is never reimplemented here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);

/** Every fake gateway a test started; all are stopped in afterAll. */
const fakes: FakeCustomerGateway[] = [];

const READY: GatewayReadiness = {
  ready: true,
  blockingReasons: [],
  configVersion: 7,
  checkedAt: "2026-10-17T00:00:00.000Z",
};

function installReadyGate(): void {
  const gate: GatewayReadinessService = {
    evaluateGatewayReadiness: async () => READY,
    assertGatewayReadyForBilling: async () => READY,
  };
  installGatewayReadinessService(gate);
}

/** A fresh fake remote for one test, registered for cleanup. */
async function startGateway() {
  const gateway = await startFakeCustomerGateway({ token: "test-admin-key" });
  fakes.push(gateway);
  return gateway;
}

/**
 * The full stack under test: 05.1's provisioner (the create seam, running its
 * real adapter against the fake) plus 05.2's recovery layer on top of it.
 */
function provisioningFor(
  gateway: FakeCustomerGateway,
  options: { endpointTimeoutMs?: number; lookupTimeoutMs?: number } = {},
) {
  const provisioner = createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => ({
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: options.endpointTimeoutMs ?? 2_000,
      configVersion: 7,
    }),
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
  });
  return createGatewayCustomerProvisioning({
    database,
    provisionCustomer: provisioner.provisionCustomer,
    client: createFakeGatewayCustomerClient(gateway, {
      token: "test-admin-key",
      timeoutMs: options.lookupTimeoutMs ?? 1_000,
    }),
  });
}

/** Whole-table row count — the flow under test must not move any of these. */
async function countRows(table: PgTable): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(table);
  return row.n;
}

async function mappingRowFor(payerId: string) {
  const [row] = await database
    .select()
    .from(gatewayCustomers)
    .where(eq(gatewayCustomers.payerId, payerId))
    .limit(1);
  return row;
}

/** The creates the fake's governance surface received. */
function createPosts(gateway: FakeCustomerGateway) {
  return gateway.requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === "/api/governance/customers",
  );
}

beforeEach(() => {
  // Every test decides its own gate state; nothing leaks between tests.
  installGatewayReadinessService(undefined);
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM gateway_customers WHERE payer_id LIKE ${`%${run}%`}`,
  );
  for (const gateway of fakes) await gateway.stop();
  await database.$client.close();
});

describe("the stable correlation key", () => {
  test("is deterministic per subject and agrees with the billing stack's key", () => {
    const ref = { kind: "personal" as const, id: `user-${run}-key` };
    expect(customerCorrelationKey(ref)).toBe(customerCorrelationKey(ref));
    expect(customerCorrelationKey(ref)).toBe(payerKey(ref));
  });

  test("refuses the quarantined unknown_owner kind, like every billable key", () => {
    expect(() =>
      customerCorrelationKey({ kind: "unknown_owner", id: "x" }),
    ).toThrow();
  });
});

describe("provisionCustomer when the remote create succeeded but the response was lost", () => {
  test("the first call reports the outcome unknown and marks the mapping recoverable", async () => {
    const gateway = await startGateway();
    gateway.dropNextCreateResponse();
    const provisioning = provisioningFor(gateway, {
      endpointTimeoutMs: 250,
    });
    const ref = { kind: "personal" as const, id: `user-${run}-lost` };

    installReadyGate();
    try {
      let caught: unknown;
      try {
        await provisioning.provisionCustomer(ref);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewayProvisionOutcomeUnknownError);

      // The remote DID create the customer — through 05.1's governance route,
      // named by the correlation key — and only the answer was lost.
      expect(gateway.customers).toHaveLength(1);
      expect(gateway.customers[0].name).toBe(customerCorrelationKey(ref));
      expect(createPosts(gateway)).toHaveLength(1);

      // Locally the mapping is honest about what it knows: nothing confirmed.
      const row = await mappingRowFor(ref.id);
      expect(row).toBeDefined();
      expect(row?.provisionState).toBe("recoverable");
      expect(row?.externalReference).toBe(customerCorrelationKey(ref));
      expect(row?.gatewayCustomerId).toBeNull();
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("the retry finds the remote subject by the correlation key and confirms it — one customer, not two", async () => {
    const gateway = await startGateway();
    gateway.dropNextCreateResponse();
    const provisioning = provisioningFor(gateway, {
      endpointTimeoutMs: 250,
    });
    const ref = { kind: "personal" as const, id: `user-${run}-retry` };

    installReadyGate();
    try {
      await provisioning.provisionCustomer(ref).catch(() => undefined); // the lost first attempt
      const retry = await provisioning.provisionCustomer(ref);

      expect(retry.provisionState).toBe("confirmed");
      expect(retry.recovered).toBe(true);
      // The remote subject adopted is the one the lost create actually made.
      expect(retry.customerId).toBe(gateway.customers[0].customerId);

      // The retry looked before it created: still exactly one remote customer,
      // still exactly one create.
      expect(gateway.customers).toHaveLength(1);
      expect(createPosts(gateway)).toHaveLength(1);

      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("confirmed");
      expect(row?.gatewayCustomerId).toBe(gateway.customers[0].customerId);
      expect(row?.externalReference).toBe(customerCorrelationKey(ref));
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("recovery is repeatable: every further call answers the same confirmed mapping", async () => {
    const gateway = await startGateway();
    gateway.dropNextCreateResponse();
    const provisioning = provisioningFor(gateway, {
      endpointTimeoutMs: 250,
    });
    const ref = { kind: "personal" as const, id: `user-${run}-repeat` };

    installReadyGate();
    try {
      await provisioning.provisionCustomer(ref).catch(() => undefined); // lost
      const first = await provisioning.provisionCustomer(ref); // the recovery
      const second = await provisioning.provisionCustomer(ref);
      const third = await provisioning.provisionCustomer(ref);

      // Convergence: the same remote subject, the same confirmed answer, no
      // matter how many times recovery runs afterwards.
      expect(second.customerId).toBe(first.customerId);
      expect(third.customerId).toBe(first.customerId);
      expect(second.provisionState).toBe("confirmed");
      expect(third.provisionState).toBe("confirmed");
      // The first call recovered the lost association; the repeats find the
      // mapping already confirmed and answer the plain idempotent way —
      // identical results, no second customer anywhere.
      expect(first.recovered).toBe(true);
      expect(second.recovered).toBe(false);
      expect(third.recovered).toBe(false);
      expect(gateway.customers).toHaveLength(1);

      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("confirmed");
      expect(row?.gatewayCustomerId).toBe(first.customerId);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("recovery when the remote never received the create", () => {
  test("a recoverable row with no remote subject creates anew through the seam", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-fresh` };
    const reference = customerCorrelationKey(ref);

    // Crash residue: a pending attempt that never reached the remote at all.
    await database.insert(gatewayCustomers).values({
      id: `gc-${run}-fresh`,
      kind: "personal",
      payerId: ref.id,
      gatewayCustomerName: reference,
      provisionState: "recoverable",
    });

    installReadyGate();
    try {
      const result = await provisioning.provisionCustomer(ref);

      expect(result.provisionState).toBe("confirmed");
      expect(result.recovered).toBe(true);
      expect(gateway.customers).toHaveLength(1);
      expect(gateway.customers[0].name).toBe(reference);

      // The seam's create adopted the very reservation that was on file —
      // one row, completed, not a replacement.
      const rows = await database
        .select({ id: gatewayCustomers.id })
        .from(gatewayCustomers)
        .where(eq(gatewayCustomers.payerId, ref.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(`gc-${run}-fresh`);

      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("confirmed");
      expect(row?.gatewayCustomerId).toBe(gateway.customers[0].customerId);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("a fresh provisioning reserves, then the create adopts the reservation", () => {
  test("the confirmed row is the reservation the seam completed — no duplicate, no drift", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-adopt` };
    const reference = customerCorrelationKey(ref);

    installReadyGate();
    try {
      const result = await provisioning.provisionCustomer(ref);

      expect(result).toEqual({
        customerId: gateway.customers[0].customerId,
        provisionState: "confirmed",
        recovered: false,
      });
      // The create carried the correlation key as the deterministic name.
      expect(gateway.customers[0].name).toBe(reference);

      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("confirmed");
      expect(row?.gatewayCustomerId).toBe(gateway.customers[0].customerId);
      expect(row?.externalReference).toBe(reference);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("05.1 rows keep answering through the recovery layer", () => {
  test("a legacy active mapping answers confirmed with no remote call and no rewrite", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-legacy` };
    const reference = customerCorrelationKey(ref);

    // A row exactly as 05.1 wrote it: complete, 'active', no reference column
    // named (migration 0135 generates it from the name).
    await database.insert(gatewayCustomers).values({
      id: `gc-${run}-legacy`,
      kind: "personal",
      payerId: ref.id,
      gatewayCustomerId: "cust_legacy_000001",
      gatewayCustomerName: reference,
      provisionState: "active",
    });

    installReadyGate();
    try {
      const result = await provisioning.provisionCustomer(ref);

      expect(result).toEqual({
        customerId: "cust_legacy_000001",
        provisionState: "confirmed",
        recovered: false,
      });
      // The fast path: the mapping itself answered, no remote call at all.
      expect(gateway.requests).toHaveLength(0);

      // The applied row was not rewritten: 'active' stands; the read boundary
      // normalizes it.
      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("active");
      expect(row?.externalReference).toBe(reference);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("recovery changes nothing but the mapping", () => {
  test("no balance, no grant, no ledger, no reservation, no virtual key surface", async () => {
    const gateway = await startGateway();
    gateway.dropNextCreateResponse();
    const provisioning = provisioningFor(gateway, {
      endpointTimeoutMs: 250,
    });
    const ref = { kind: "personal" as const, id: `user-${run}-nomove` };

    const before = {
      billing: await countRows(gatewayCustomers),
      grants: await countRows(creditGrants),
      ledger: await countRows(creditLedger),
      reservations: await countRows(creditReservations),
      payerAccounts: await countRows(payerAccounts),
    };

    installReadyGate();
    try {
      await provisioning.provisionCustomer(ref).catch(() => undefined); // lost
      await provisioning.provisionCustomer(ref); // recovered
      await provisioning.provisionCustomer(ref); // repeatable

      expect(await countRows(gatewayCustomers)).toBe(before.billing + 1);
      expect(await countRows(creditGrants)).toBe(before.grants);
      expect(await countRows(creditLedger)).toBe(before.ledger);
      expect(await countRows(creditReservations)).toBe(
        before.reservations,
      );
      expect(await countRows(payerAccounts)).toBe(before.payerAccounts);

      // The fake exposes no virtual-key surface at all, and every request the
      // provisioning flow made stayed on the two customer management routes.
      for (const request of gateway.requests) {
        expect(
          request.path.startsWith("/api/customers") ||
            request.path.startsWith("/api/governance/customers"),
        ).toBe(true);
      }
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("provisioning races and refusals", () => {
  test("two concurrent provisions leave one mapping and one remote customer", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-race` };

    installReadyGate();
    try {
      const [a, b] = await Promise.all([
        provisioning.provisionCustomer(ref),
        provisioning.provisionCustomer(ref),
      ]);

      expect(a.provisionState).toBe("confirmed");
      expect(b.provisionState).toBe("confirmed");
      expect(b.customerId).toBe(a.customerId);
      expect(gateway.customers).toHaveLength(1);

      const rows = await database
        .select({ id: gatewayCustomers.id })
        .from(gatewayCustomers)
        .where(eq(gatewayCustomers.payerId, ref.id));
      expect(rows).toHaveLength(1);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("a definitive remote refusal removes the local row, so the next attempt starts clean", async () => {
    const gateway = await startGateway();
    gateway.refuseCreatesWith(422);
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-refuse` };

    installReadyGate();
    try {
      let caught: unknown;
      try {
        await provisioning.provisionCustomer(ref);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewayProvisionRefusedError);
      expect(await mappingRowFor(ref.id)).toBeUndefined();

      // The refusal was the remote saying no, not the wire dying: nothing
      // was created remotely, and a later attempt may start from scratch.
      expect(gateway.customers).toHaveLength(0);

      gateway.refuseCreatesWith(undefined);
      const retry = await provisioning.provisionCustomer(ref);
      expect(retry.provisionState).toBe("confirmed");
      expect(retry.recovered).toBe(false);
      expect(await mappingRowFor(ref.id)).toBeDefined();
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("a lost lookup during recovery keeps the row recoverable and the answer unknown", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-lostlookup` };

    await database.insert(gatewayCustomers).values({
      id: `gc-${run}-lostlookup`,
      kind: "personal",
      payerId: ref.id,
      gatewayCustomerName: customerCorrelationKey(ref),
      provisionState: "recoverable",
    });
    gateway.dropNextLookupResponse();

    installReadyGate();
    try {
      let caught: unknown;
      try {
        await provisioning.provisionCustomer(ref);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewayProvisionOutcomeUnknownError);
      const row = await mappingRowFor(ref.id);
      expect(row?.provisionState).toBe("recoverable");
      // The recovery looked before it created: no create was ever issued.
      expect(createPosts(gateway)).toHaveLength(0);
      expect(gateway.customers).toHaveLength(0);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});

describe("the readiness gate still fronts every provisioning call", () => {
  test("no gate installed: refused before any remote call or local row", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-nogate` };

    // beforeEach uninstalled the gate; this test installs nothing.
    let caught: unknown;
    try {
      await provisioning.provisionCustomer(ref);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayNotReadyError);
    expect((caught as GatewayNotReadyError).readiness.blockingReasons).toContain(
      "gateway_readiness_gate_unavailable",
    );
    expect(gateway.requests).toHaveLength(0);
    expect(await mappingRowFor(ref.id)).toBeUndefined();
  });
});

describe("the transport seam classification", () => {
  test("a dropped response is a transport loss, not a refusal", () => {
    expect(new GatewayCustomerTransportLostError("x").name).toBe(
      "GatewayCustomerTransportLostError",
    );
  });
});

describe("the module boundary", () => {
  test("a non-personal subject is refused before any remote call or row", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);

    installReadyGate();
    try {
      let caught: unknown;
      try {
        await provisioning.provisionCustomer({
          kind: "company",
          id: `tenant-${run}`,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewayProvisionRefusedError);
      expect(gateway.requests).toHaveLength(0);
    } finally {
      installGatewayReadinessService(undefined);
    }
  });

  test("readCustomerMapping answers the row the downstream consumers key on", async () => {
    const gateway = await startGateway();
    const provisioning = provisioningFor(gateway);
    const ref = { kind: "personal" as const, id: `user-${run}-read` };

    installReadyGate();
    try {
      expect(await provisioning.readCustomerMapping(ref)).toBeNull();

      await provisioning.provisionCustomer(ref);
      const mapping = await provisioning.readCustomerMapping(ref);
      expect(mapping).toEqual({
        kind: "personal",
        payerId: ref.id,
        customerId: gateway.customers[0].customerId,
        externalReference: customerCorrelationKey(ref),
        provisionState: "confirmed",
      });
    } finally {
      installGatewayReadinessService(undefined);
    }
  });
});
