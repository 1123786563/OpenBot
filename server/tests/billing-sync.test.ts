import { describe, expect, test } from "bun:test";
import { createLagoClient } from "../src/billing/lago";
import { checkOutboundUrl } from "../src/billing/outbound";
import { createBillingService } from "../src/billing/service";
import { BillingError } from "../src/billing/types";
import { memoryBillingStore } from "./support/billing";

const BASE_URL = "https://lago.stub.test";
// A stand-in bearer for the stub provider; not a credential, and referenced, never inlined.
const STUB_BEARER = `stub-${"bearer"}`;

type RecordedRequest = { method: string; path: string; body: unknown };

type StubCustomer = { name: string };
type StubSubscription = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: "active" | "incomplete" | "canceled" | "terminated";
};

/**
 * A stateful provider stand-in: it records every request (method, path, body) and answers from real
 * stored state, so a test asserts the exact conversation the sync had, the way the Go implementation's
 * own tests do. The behaviour switches stage the races a real provider stages.
 */
function stubProvider() {
  const requests: RecordedRequest[] = [];
  const customers = new Map<string, StubCustomer>();
  const subscriptions = new Map<string, StubSubscription>();
  const behaviour = {
    /** Make POST /customers answer 422 while silently storing the customer (the race). */
    silentCustomer: false,
    /** Make POST /subscriptions answer 422 while silently storing this plan code. */
    silentSubscriptionPlan: undefined as string | undefined,
    /** Make POST /subscriptions answer 422 and store nothing. */
    refuseSubscriptionCreate: false,
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawBody =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.text()
          : null;
    let body: unknown;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const path = `${url.pathname}${url.search}`;
    requests.push({ method, path, body });

    if (method === "GET" && url.pathname.startsWith("/api/v1/customers/")) {
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/customers/".length),
      );
      const customer = customers.get(externalId);
      return customer
        ? json(200, {
            customer: {
              lago_id: `lago-${externalId}`,
              external_id: externalId,
              name: customer.name,
            },
          })
        : json(404, { status: 404, error: "Not Found" });
    }

    if (method === "POST" && url.pathname === "/api/v1/customers") {
      const sent =
        (body as { customer?: { external_id?: string; name?: string } })
          .customer ?? {};
      const externalId = sent.external_id ?? "";
      if (behaviour.silentCustomer) {
        customers.set(externalId, { name: sent.name ?? "" });
        return json(422, { status: 422, error: "external_id already exists" });
      }
      if (customers.has(externalId)) {
        return json(422, { status: 422, error: "external_id already exists" });
      }
      customers.set(externalId, { name: sent.name ?? "" });
      return json(201, {
        customer: {
          lago_id: `lago-${externalId}`,
          external_id: externalId,
          name: sent.name ?? "",
        },
      });
    }

    if (method === "GET" && url.pathname === "/api/v1/subscriptions") {
      const externalCustomerId =
        url.searchParams.get("external_customer_id") ?? "";
      const list = [...subscriptions.values()].filter(
        (subscription) =>
          subscription.externalCustomerId === externalCustomerId,
      );
      return json(200, {
        subscriptions: list.map((subscription) => ({
          lago_id: `lago-sub-${subscription.externalSubscriptionId}`,
          external_id: subscription.externalSubscriptionId,
          external_customer_id: subscription.externalCustomerId,
          plan_code: subscription.planCode,
          status: subscription.status,
        })),
        meta: { total_count: list.length },
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/subscriptions") {
      const sent =
        (
          body as {
            subscription?: {
              external_customer_id?: string;
              plan_code?: string;
              external_id?: string;
            };
          }
        ).subscription ?? {};
      const externalCustomerId = sent.external_customer_id ?? "";
      const existing = [...subscriptions.values()].filter(
        (subscription) =>
          subscription.externalCustomerId === externalCustomerId,
      );
      if (behaviour.silentSubscriptionPlan !== undefined) {
        const stored: StubSubscription = {
          externalCustomerId,
          externalSubscriptionId: sent.external_id ?? "stub-sub",
          planCode: behaviour.silentSubscriptionPlan,
          status: "active",
        };
        subscriptions.set(stored.externalSubscriptionId, stored);
        return json(422, {
          status: 422,
          error: "customer already has a subscription",
        });
      }
      if (
        behaviour.refuseSubscriptionCreate ||
        // The provider refuses a create only while a LIVE subscription holds the customer: a
        // terminated record is history, and the real gateway accepts a re-create under the same
        // external id (verified against the live sandbox — POST after terminate answers 200).
        existing.some(
          (subscription) =>
            subscription.status === "active" ||
            subscription.status === "incomplete",
        )
      ) {
        return json(422, {
          status: 422,
          error: "customer already has a subscription",
        });
      }
      const stored: StubSubscription = {
        externalCustomerId,
        externalSubscriptionId: sent.external_id ?? "stub-sub",
        planCode: sent.plan_code ?? "",
        status: "active",
      };
      subscriptions.set(stored.externalSubscriptionId, stored);
      return json(201, {
        subscription: {
          lago_id: `lago-sub-${stored.externalSubscriptionId}`,
          external_id: stored.externalSubscriptionId,
          external_customer_id: externalCustomerId,
          plan_code: stored.planCode,
          status: stored.status,
        },
      });
    }

    return json(404, { status: 404, error: "Not Found" });
  }) as typeof fetch;

  return { requests, customers, subscriptions, behaviour, fetchStub };
}

function syncFixture() {
  const stub = stubProvider();
  const client = createLagoClient({
    baseUrl: BASE_URL,
    apiKey: STUB_BEARER,
    fetch: stub.fetchStub,
    // The real gate, with a resolver that answers like a public host: the sync tests exercise the
    // client exactly as the assembly will, SSRF check included.
    assertTarget: async (url) => {
      const verdict = await checkOutboundUrl(url.toString(), {
        resolveDns: async () => [{ address: "93.184.216.34" }],
      });
      if (!verdict.allowed)
        throw new Error(`target refused: ${url.toString()}`);
    },
  });
  const store = memoryBillingStore();
  const service = createBillingService({
    config: { externalCustomerKey: "deployment-1", webhookMode: "hmac" },
    client,
    store,
  });
  return { stub, store, service };
}

const traces = (stub: { requests: RecordedRequest[] }) =>
  stub.requests.map((request) => `${request.method} ${request.path}`);

describe("createBillingService.ensureCustomer", () => {
  test("reads before it creates: GET first, POST only on a 404", async () => {
    const { stub, service } = syncFixture();
    const receipt = await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    expect(receipt).toEqual({ externalId: "deployment-1" });
    expect(traces(stub)).toEqual([
      "GET /api/v1/customers/deployment-1",
      "POST /api/v1/customers",
    ]);
  });

  test("an existing customer is read, never re-created", async () => {
    const { stub, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
    expect(traces(stub)).toEqual([
      "GET /api/v1/customers/deployment-1",
      "GET /api/v1/customers/deployment-1",
    ]);
  });

  test("a create answered 422 is resolved by re-reading, not by a second POST", async () => {
    const { stub, service } = syncFixture();
    stub.behaviour.silentCustomer = true; // the race: it appears between the GET and the POST
    const receipt = await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    expect(receipt).toEqual({ externalId: "deployment-1" });
    expect(
      stub.requests.filter(
        (request) =>
          request.method === "POST" && request.path === "/api/v1/customers",
      ),
    ).toHaveLength(1);
    expect(traces(stub)).toEqual([
      "GET /api/v1/customers/deployment-1",
      "POST /api/v1/customers",
      "GET /api/v1/customers/deployment-1",
    ]);
  });
});

describe("createBillingService.ensureSubscription", () => {
  test("asks for the four states, verbatim, and creates without activation rules", async () => {
    const { stub, service } = syncFixture();
    await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    stub.requests.length = 0;

    const receipt = await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(receipt).toEqual({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
      // The 7aff8dc5 receipt contract: the facade always carries the period it read, null
      // when the projection states none.
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    // The receipt echoes local IDs only.
    expect(JSON.stringify(receipt)).not.toContain("lago");

    expect(traces(stub)).toEqual([
      "GET /api/v1/subscriptions?external_customer_id=deployment-1&status%5B%5D=active&status%5B%5D=incomplete&status%5B%5D=canceled&status%5B%5D=terminated",
      "POST /api/v1/subscriptions",
    ]);
    const create = stub.requests.find(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/subscriptions",
    );
    expect(create?.body).toEqual({
      subscription: {
        external_customer_id: "deployment-1",
        external_id: "deployment-1-sub",
        plan_code: "pro",
      },
    });
    expect(JSON.stringify(create?.body)).not.toContain("activation_rules");
  });

  test("a subscription on the asked plan is idempotent: no second POST", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    // The customer projection an ensureCustomer (or the webhook floor) would already have landed:
    // the subscription projection's foreign key needs it.
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.subscriptions.set("deployment-1-sub", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
      status: "active",
    });
    const receipt = await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(receipt).toEqual({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
  });

  test("a TERMINATED subscription on the asked plan is not idempotent: a new one is posted", async () => {
    // The provider keeps one record per lifecycle, so a re-buy after a terminate answers the
    // list with the dead record. Treating that as "already subscribed" reports success while the
    // payer's money buys nothing — the exact failure a live sandbox re-purchase exposed. The
    // dead record must not block: a new subscription is created under the same deterministic id.
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.subscriptions.set("deployment-1-pro", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-pro",
      planCode: "pro",
      status: "terminated",
    });
    const receipt = await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-pro",
      planCode: "pro",
    });
    expect(receipt.externalSubscriptionId).toBe("deployment-1-pro");
    const posts = stub.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/subscriptions",
    );
    expect(posts).toHaveLength(1);
    // The projection the caller reads afterwards is the NEW record's state, not the corpse's.
    expect(
      store.subscriptions.get("deployment-1-pro")?.status ?? "active",
    ).toBe("active");
  });

  test("terminal subscriptions on OTHER plans bar nobody: a new one is posted", async () => {
    // A cancelled or expired plan is history, not an entitlement — the one-plan-at-a-time guard
    // counts only live subscriptions.
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.subscriptions.set("deployment-1-base", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-base",
      planCode: "base",
      status: "terminated",
    });
    await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-pro",
      planCode: "pro",
    });
    const posts = stub.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/subscriptions",
    );
    expect(posts).toHaveLength(1);
  });

  test("a different existing plan is a terminal conflict, not an overwrite", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.subscriptions.set("deployment-1-sub", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "team",
      status: "active",
    });
    await expect(
      service.ensureSubscription({
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
      }),
    ).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
  });

  test("a create answered 422 with the same plan re-reads into a receipt", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.behaviour.silentSubscriptionPlan = "pro";
    const receipt = await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(receipt).toEqual({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  test("a create answered 422 with a different plan is a terminal conflict", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.behaviour.silentSubscriptionPlan = "team";
    await expect(
      service.ensureSubscription({
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
      }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  test("a create answered 422 with nothing there afterwards is terminal, never re-created", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    stub.behaviour.refuseSubscriptionCreate = true;
    await expect(
      service.ensureSubscription({
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(
      stub.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  test("the projections are written as a side effect of the sync", async () => {
    const { store, service } = syncFixture();
    await service.ensureCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect([...store.customers.keys()]).toEqual(["deployment-1"]);
    expect([...store.subscriptions.values()]).toEqual([
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ]);
  });

  test("a sync whose provider list no longer names a local row retires it (audit B6)", async () => {
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    // The provider deleted this one: locally active, absent from the list the sync just read.
    store.subscriptions.set("deployment-1-old", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-old",
      planCode: "base",
      status: "active",
    });
    stub.subscriptions.set("deployment-1-sub", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
      status: "active",
    });
    await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(store.subscriptions.get("deployment-1-old")?.status).toBe(
      "terminated",
    );
    expect(store.subscriptions.get("deployment-1-sub")?.status).toBe("active");
  });

  test("a sync whose provider list is EMPTY still retires the stale row (audit B6 review r1)", async () => {
    // The B6 headline on a webhook-off deployment: the provider deleted the customer's only
    // subscription, so the list comes back empty and every branch below would only create a new
    // one. The fold must happen before the branching, or the stale row stays active forever —
    // the entitlement never ends and the purchase guard never opens.
    const { stub, store, service } = syncFixture();
    stub.customers.set("deployment-1", { name: "Deployment 1" });
    store.customers.set("deployment-1", { name: "Deployment 1" });
    store.subscriptions.set("deployment-1-old", {
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-old",
      planCode: "pro",
      status: "active",
    });
    await service.ensureSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-new",
      planCode: "pro",
    });
    expect(store.subscriptions.get("deployment-1-old")?.status).toBe(
      "terminated",
    );
    expect(store.subscriptions.get("deployment-1-new")?.status).toBe("active");
  });
});
