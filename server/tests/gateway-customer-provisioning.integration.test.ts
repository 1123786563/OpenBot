import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { payerKey } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { gatewayCustomers } from "../src/db/schema/gateway";
import {
  createGatewayCustomerProvisioner,
  GatewayCustomerProvisionError,
  gatewayCustomerName,
  provisionCustomer as provisionCustomerForDeployment,
  readGatewayCustomerMapping,
} from "../src/gateway/customer";
import {
  GatewayNotReadyError,
  type GatewayReadiness,
  type GatewayReadinessService,
  installGatewayReadinessService,
} from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 05.1 (#242) against a real PostgreSQL (tests/support/database.ts refuses the live
 * `openbot` database) and a fake gateway management surface (Bun.serve, test-only — the
 * production path dials the configured endpoint with the resolved admin credential, exactly
 * what 01.1/01.2 installed). The fake mirrors the Bifrost governance API this ticket
 * integrates with: `POST /api/governance/customers` creates by unique name (a duplicate name
 * is a 409), `GET /api/governance/customers?search=` lists by substring, and every call must
 * carry the admin bearer credential.
 *
 * The guarantees under test are the ticket's acceptance criteria: a burst of concurrent
 * provisions for one personal user leaves exactly one valid mapping row (the database's unique
 * indexes arbitrate, not a read-check), duplicate provisions answer the same customerId without
 * creating a second remote or local entity, a gateway that is not ready refuses provisioning
 * before anything is dialed, and provisioning creates no billing customer, grant, ledger row,
 * reservation or payer account — a mapping, nothing more.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);

/** One fake gateway for the whole file; each test uses its own payer ids suffixed with `run`. */
const fake = startFakeGateway();

/** The extra pools the concurrency test opens; closed alongside the main one. */
const extraDatabases: ReturnType<typeof createDatabase>[] = [];

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

/** A gate that passes, the way 01.7's installed service answers on a ready deployment. */
function readyGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: true,
    blockingReasons: [],
    configVersion: endpoint.configVersion,
    checkedAt: new Date().toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => readiness,
  };
}

/** A gate that refuses, the way 01.7's service answers when a condition is unmet. */
function refusingGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: false,
    blockingReasons: ["gateway_readiness_probe_missing"],
    configVersion: endpoint.configVersion,
    checkedAt: new Date().toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => {
      throw new GatewayNotReadyError(readiness, [
        {
          reason: "gateway_readiness_probe_missing",
          message: "No successful probe is on file (test gate).",
        },
      ]);
    },
  };
}

function provisionerFor(overrides?: {
  gate?: GatewayReadinessService;
  baseUrl?: string;
  requestTimeoutMs?: number;
  adminKey?: string;
}) {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => ({
      ...endpoint,
      baseUrl: overrides?.baseUrl ?? endpoint.baseUrl,
      requestTimeoutMs:
        overrides?.requestTimeoutMs ?? endpoint.requestTimeoutMs,
    }),
    resolveGatewayAdminCredential: async () => ({
      adminKey: overrides?.adminKey ?? "test-admin-key",
    }),
    gate: overrides?.gate ?? readyGate(),
  });
}

function ref(n: number) {
  return { kind: "personal" as const, id: `cust-${n}-${run}` };
}

async function mappingRowCount(payerId: string): Promise<number> {
  const rows = await database.execute(
    sql`SELECT count(*) AS n FROM gateway_customers WHERE payer_id = ${payerId}`,
  );
  return Number(rows[0].n);
}

beforeAll(() => {
  // The zero-arg production entry reads the installed gate; this file pins the
  // process-wide state it depends on and restores nothing (other files install their own
  // or, like this one, run with the gate uninstalled).
  installGatewayReadinessService(undefined);
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM gateway_customers WHERE payer_id LIKE ${`%-${run}`}`,
  );
  for (const extra of extraDatabases) await extra.$client.close();
  await database.$client.close();
  fake.stop();
});

/**
 * A fake of the Bifrost governance customer surface this ticket integrates with: unique
 * names (a duplicate create is a 409), substring search over names, bearer-authenticated.
 * The behavior variants (delay, auth refusal, garbage bodies, unexpected statuses) stand
 * in for the failure modes the adapter must classify.
 */
function startFakeGateway() {
  /** name -> { id, createAttempts: how many POSTs named it } */
  const customers = new Map<string, { id: string; createAttempts: number }>();
  const calls = { create: 0, list: 0 };
  let delayMs = 0;
  let respondWith: "valid" | "not-json" | "customer-without-id" | "status-500" =
    "valid";
  /** Names the create surface knows but the search surface pretends not to have. */
  let hiddenFromSearch = new Set<string>();
  /**
   * All create handling serialized through one chain: Bifrost enforces name uniqueness
   * inside a database transaction, and a test fake must not reintroduce the exact
   * check-then-act race this ticket exists to close.
   */
  let createChain: Promise<unknown> = Promise.resolve();

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
        const response = createChain.then(() => handleCreate(request));
        createChain = response.catch(() => undefined);
        return response;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        calls.list += 1;
        const search = url.searchParams.get("search") ?? "";
        const matched = [...customers.entries()]
          .filter(
            ([name]) => name.includes(search) && !hiddenFromSearch.has(name),
          )
          .map(([name, entry]) => ({ id: entry.id, name }));
        return json(200, {
          customers: matched,
          count: matched.length,
          total_count: matched.length,
        });
      }
      return json(404, { error: "not found" });
    },
  });

  async function handleCreate(request: Request): Promise<Response> {
    calls.create += 1;
    let name: unknown;
    try {
      name = ((await request.json()) as { name?: unknown }).name;
    } catch {
      return json(400, { error: "Invalid JSON" });
    }
    if (typeof name !== "string" || name.length === 0) {
      return json(400, { error: "Customer name is required" });
    }
    const entry = customers.get(name);
    if (entry) {
      entry.createAttempts += 1;
      return json(409, {
        error: "A customer with this name already exists",
      });
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const id = crypto.randomUUID();
    customers.set(name, { id, createAttempts: 1 });
    if (respondWith === "customer-without-id") {
      return json(200, { message: "ok", customer: { name } });
    }
    if (respondWith === "not-json") {
      return new Response("<html>not the management api</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (respondWith === "status-500") {
      return json(500, { error: "failed to create customer" });
    }
    return json(200, {
      message: "Customer created successfully",
      customer: { id, name },
    });
  }

  return {
    server,
    customers,
    calls,
    /** How many distinct remote customers this fake created for names ending in `run`. */
    remoteCustomerCountForRun() {
      let n = 0;
      for (const [name] of customers) {
        if (name.endsWith(`-${run}`)) n += 1;
      }
      return n;
    },
    stage(next: {
      delayMs?: number;
      respondWith?: typeof respondWith;
      hideFromSearch?: string[];
    }) {
      if (next.delayMs !== undefined) delayMs = next.delayMs;
      if (next.respondWith !== undefined) respondWith = next.respondWith;
      if (next.hideFromSearch !== undefined) {
        hiddenFromSearch = new Set(next.hideFromSearch);
      }
    },
    stop() {
      server.stop(true);
    },
  };
}

describe("gatewayCustomerName derives the deterministic remote name from the payer ref", () => {
  test("a personal ref maps to its payer key", () => {
    const subject = ref(1);
    expect(gatewayCustomerName(subject)).toBe(payerKey(subject));
    expect(gatewayCustomerName(subject)).toBe(`openbot-personal-cust-1-${run}`);
  });

  test("a non-personal payer has no personal gateway principal and is refused", () => {
    // The gateway Customer is the personal user's governance principal (AC01 names two
    // *people*); company and quarantined kinds are not this module's subjects.
    expect(() =>
      gatewayCustomerName({ kind: "company", id: `tenant-${run}` }),
    ).toThrow(TypeError);
    expect(() =>
      gatewayCustomerName({ kind: "unknown_owner", id: `x-${run}` }),
    ).toThrow(TypeError);
    expect(fake.calls.create).toBe(0);
  });
});

describe("duplicate provisioning answers the same customerId without a second entity", () => {
  test("the second provision takes the fast path: same id, one row, no remote call", async () => {
    const subject = ref(2);
    const provisioner = provisionerFor();

    const first = await provisioner.provisionCustomer(subject);
    expect(first.customerId).toBeString();
    expect(first.provisionState).toBe("active");

    const createsBefore = fake.calls.create;
    const second = await provisioner.provisionCustomer(subject);
    expect(second.customerId).toBe(first.customerId);
    expect(second.provisionState).toBe("active");
    expect(fake.calls.create).toBe(createsBefore); // fast path never dials

    expect(await mappingRowCount(subject.id)).toBe(1);
    expect(
      fake.customers.get(gatewayCustomerName(subject))?.createAttempts,
    ).toBe(1);
    expect(fake.remoteCustomerCountForRun()).toBe(1);
  });
});

describe("concurrent provisioning leaves exactly one valid mapping", () => {
  test("six connections racing the same ref all answer the one customerId", async () => {
    const subject = ref(3);
    const createsBefore = fake.calls.create;
    const remoteBefore = fake.remoteCustomerCountForRun();

    // Separate database instances = separate connection pools: the unique index — not
    // event-loop luck — decides which mapping row survives.
    const lanes = Array.from({ length: 6 }, () => {
      const lane = createDatabase(testDatabaseUrl(), { max: 1 });
      extraDatabases.push(lane);
      return createGatewayCustomerProvisioner({
        database: lane,
        readGatewayEndpoint: async () => endpoint,
        resolveGatewayAdminCredential: async () => ({
          adminKey: "test-admin-key",
        }),
        gate: readyGate(),
      });
    });

    const answers = await Promise.all(
      lanes.map((lane) => lane.provisionCustomer(subject)),
    );

    const ids = new Set(answers.map((answer) => answer.customerId));
    expect(ids.size).toBe(1);
    expect(answers.every((answer) => answer.provisionState === "active")).toBe(
      true,
    );
    expect(await mappingRowCount(subject.id)).toBe(1);

    // The remote side converged on one entity too: six creates raced the unique name,
    // one won, the other five were refused with a 409 and resolved the winner by name
    // instead of minting a second customer.
    const name = gatewayCustomerName(subject);
    expect(fake.customers.get(name)?.createAttempts).toBe(
      fake.calls.create - createsBefore,
    );
    // Exactly one new remote entity exists after the burst.
    expect(fake.remoteCustomerCountForRun()).toBe(remoteBefore + 1);
  });
});

describe("a gateway that is not ready refuses provisioning before anything is dialed", () => {
  test("the gate's refusal is the end of the path: no remote call, no row", async () => {
    const subject = ref(4);
    const createsBefore = fake.calls.create;
    const provisioner = provisionerFor({ gate: refusingGate() });

    const rejection = await Promise.all([
      provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      ),
    ]).then(([error]) => error as unknown);

    expect(rejection).toBeInstanceOf(GatewayNotReadyError);
    const notReady = rejection as GatewayNotReadyError;
    expect(notReady.readiness.ready).toBe(false);
    expect(notReady.readiness.blockingReasons).toContain(
      "gateway_readiness_probe_missing",
    );
    expect(fake.calls.create).toBe(createsBefore);
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("with no gate installed at all, the zero-arg deployment entry refuses too", async () => {
    const subject = ref(5);
    const rejection = await provisionCustomerForDeployment(
      database,
      subject,
    ).then(
      () => null,
      (error) => error,
    );
    expect(rejection).toBeInstanceOf(GatewayNotReadyError);
    expect(
      (rejection as GatewayNotReadyError).readiness.blockingReasons,
    ).toContain("gateway_readiness_gate_unavailable");
    expect(await mappingRowCount(subject.id)).toBe(0);
  });
});

describe("a remote customer that already exists resolves by name instead of minting a second", () => {
  test("409 with no local row converges on the pre-existing remote entity", async () => {
    const subject = ref(6);
    const name = gatewayCustomerName(subject);
    // Simulate the crash gap 05.2 recovers from: the remote customer exists, the local
    // mapping never landed. Provisioning must adopt that entity, not create another.
    const preExisting = { id: crypto.randomUUID(), createAttempts: 0 };
    fake.customers.set(name, preExisting);

    const provisioner = provisionerFor();
    const result = await provisioner.provisionCustomer(subject);
    expect(result.customerId).toBe(preExisting.id);
    expect(await mappingRowCount(subject.id)).toBe(1);
    expect(fake.customers.get(name)?.createAttempts).toBe(1); // one refused create

    const [row] = await database
      .select()
      .from(gatewayCustomers)
      .where(
        and(
          eq(gatewayCustomers.kind, subject.kind),
          eq(gatewayCustomers.payerId, subject.id),
        ),
      )
      .limit(1);
    expect(row?.gatewayCustomerId).toBe(preExisting.id);
    expect(row?.gatewayCustomerName).toBe(name);
  });
});

describe("provisioning creates a mapping and nothing else", () => {
  test("no billing customer, grant, ledger, reservation or payer account appears", async () => {
    const subject = ref(7);
    const provisioner = provisionerFor();
    const { customerId } = await provisioner.provisionCustomer(subject);
    expect(customerId).toBeString();

    const key = payerKey(subject);
    const counts = await database.execute(sql`
			SELECT
				(SELECT count(*) FROM billing_customers WHERE external_id = ${key}) AS billing_customers,
				(SELECT count(*) FROM credit_grants WHERE external_customer_id = ${key}) AS grants,
				(SELECT count(*) FROM credit_ledger WHERE external_customer_id = ${key}) AS ledger,
				(SELECT count(*) FROM credit_reservations WHERE external_customer_id = ${key}) AS reservations,
				(SELECT count(*) FROM payer_accounts WHERE kind = ${subject.kind} AND payer_id = ${subject.id}) AS payer_accounts
		`);
    expect(Number(counts[0].billing_customers)).toBe(0);
    expect(Number(counts[0].grants)).toBe(0);
    expect(Number(counts[0].ledger)).toBe(0);
    expect(Number(counts[0].reservations)).toBe(0);
    expect(Number(counts[0].payer_accounts)).toBe(0);
    expect(await mappingRowCount(subject.id)).toBe(1);
  });
});

describe("the persisted mapping is readable for the downstream consumers", () => {
  test("readGatewayCustomerMapping answers the row 05.3/05.8 will key on", async () => {
    const subject = ref(8);
    const provisioner = provisionerFor();
    expect(await readGatewayCustomerMapping(database, subject)).toBeNull();

    const { customerId } = await provisioner.provisionCustomer(subject);
    const mapping = await readGatewayCustomerMapping(database, subject);
    expect(mapping).not.toBeNull();
    expect(mapping?.gatewayCustomerId).toBe(customerId);
    expect(mapping?.kind).toBe("personal");
    expect(mapping?.payerId).toBe(subject.id);
    expect(mapping?.gatewayCustomerName).toBe(gatewayCustomerName(subject));
    expect(mapping?.provisionState).toBe("active");
  });
});

describe("every remote failure mode is a typed refusal, never a partial mapping", () => {
  test("an unreachable gateway refuses with its reason and writes nothing", async () => {
    const subject = ref(9);
    const provisioner = provisionerFor({ baseUrl: "http://127.0.0.1:9" });
    const rejection = await provisioner.provisionCustomer(subject).then(
      () => null,
      (error) => error,
    );
    expect(rejection).toBeInstanceOf(GatewayCustomerProvisionError);
    expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
      "gateway_customer_unreachable",
    );
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a gateway that stalls past the deadline is a timeout", async () => {
    const subject = ref(10);
    fake.stage({ delayMs: 500 });
    try {
      const provisioner = provisionerFor({ requestTimeoutMs: 80 });
      const rejection = await provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      );
      expect(rejection).toBeInstanceOf(GatewayCustomerProvisionError);
      expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
        "gateway_customer_timeout",
      );
    } finally {
      fake.stage({ delayMs: 0 });
    }
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a refused admin credential is unauthenticated, not a silent failure", async () => {
    const subject = ref(11);
    const provisioner = provisionerFor({ adminKey: "wrong-key" });
    const rejection = await provisioner.provisionCustomer(subject).then(
      () => null,
      (error) => error,
    );
    expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
      "gateway_customer_unauthenticated",
    );
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a 200 whose body is not the management API's answer is invalid_response", async () => {
    const subject = ref(12);
    fake.stage({ respondWith: "not-json" });
    try {
      const provisioner = provisionerFor();
      const rejection = await provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      );
      expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
        "gateway_customer_invalid_response",
      );
    } finally {
      fake.stage({ respondWith: "valid" });
    }
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a create answer without a customer id is invalid_response too", async () => {
    const subject = ref(13);
    fake.stage({ respondWith: "customer-without-id" });
    try {
      const provisioner = provisionerFor();
      const rejection = await provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      );
      expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
        "gateway_customer_invalid_response",
      );
    } finally {
      fake.stage({ respondWith: "valid" });
    }
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("an unexpected remote status is a typed refusal, not a guessed mapping", async () => {
    const subject = ref(14);
    fake.stage({ respondWith: "status-500" });
    try {
      const provisioner = provisionerFor();
      const rejection = await provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      );
      expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
        "gateway_customer_unexpected_status",
      );
    } finally {
      fake.stage({ respondWith: "valid" });
    }
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a duplicate provision that finds the name held elsewhere refuses loudly", async () => {
    const subject = ref(15);
    // A hand-placed row (an operator, a migration) already holds this subject's
    // deterministic remote name under a different payer. Provisioning must refuse —
    // never borrow the foreign row, never mint a second mapping.
    await database.execute(sql`
			INSERT INTO gateway_customers (id, kind, payer_id, gateway_customer_id, gateway_customer_name, provision_state)
			VALUES (${`gc-stray-${run}`}, 'personal', ${`stray-holder-${run}`}, ${`remote-stray-${run}`}, ${gatewayCustomerName(subject)}, 'active')
		`);

    const provisioner = provisionerFor();
    const rejection = await provisioner.provisionCustomer(subject).then(
      () => null,
      (error) => error,
    );
    expect(rejection).toBeInstanceOf(GatewayCustomerProvisionError);
    expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
      "gateway_customer_mapping_conflict",
    );
    expect(await mappingRowCount(subject.id)).toBe(0);
  });

  test("a 409 the gateway cannot resolve by name is a loud refusal", async () => {
    const subject = ref(16);
    // The create surface answers 409 while the search surface claims the name does not
    // exist: only reachable when the two disagree. The answer is a refusal — never a
    // second entity, never a guessed id.
    const name = gatewayCustomerName(subject);
    fake.customers.set(name, {
      id: `remote-unlisted-${run}`,
      createAttempts: 0,
    });
    fake.stage({ hideFromSearch: [name] });
    try {
      const provisioner = provisionerFor();
      const rejection = await provisioner.provisionCustomer(subject).then(
        () => null,
        (error) => error,
      );
      expect(rejection).toBeInstanceOf(GatewayCustomerProvisionError);
      expect((rejection as GatewayCustomerProvisionError).reasonCode).toBe(
        "gateway_customer_remote_conflict_unresolved",
      );
    } finally {
      fake.stage({ hideFromSearch: [] });
    }
    expect(await mappingRowCount(subject.id)).toBe(0);
  });
});
