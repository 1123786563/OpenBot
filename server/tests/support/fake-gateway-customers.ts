import {
  type GatewayCustomerClient,
  GatewayCustomerTransportLostError,
} from "../../src/gateway/customer-provision";

/*
 * A programmable fake Bifrost gateway for the provisioning recovery tests
 * (Bifrost 05.2). It speaks BOTH management surfaces the flow under test
 * touches:
 *
 *   - 05.1's create path (`POST /api/governance/customers`, create by unique
 *     name, a duplicate name is a 409) — the seam consumed by the recovery
 *     layer, so the real 05.1 adapter code runs in these tests; and
 *   - 05.2's recovery lookup (`GET /api/customers?external_reference=…`) — the
 *     read the recovery layer resolves a lost outcome with.
 *
 * Decisive for this ticket, the fake can RECORD a create and then drop the
 * response, which is exactly the "remote success, local confirmation lost"
 * fault the recovery flow exists for.
 *
 * It is test scaffolding only: nothing in `server/src` imports this file, and
 * it must never become a production fallback. The production HTTP adapters for
 * Bifrost's real management surface are separately verified pieces; this fake
 * fixes only the two contracts the flow consumes.
 */

/** One customer the fake remote holds. */
export type FakeRemoteCustomer = {
  customerId: string;
  /**
   * The deterministic remote name (= the correlation key): 05.1 creates by it,
   * 05.2's recovery looks the subject up by it.
   */
  name: string;
};

/** One request the fake received, in order. */
export type FakeCustomerGatewayRequest = {
  method: string;
  /** Path including the query string, e.g. `/api/governance/customers?search=…`. */
  path: string;
  authorization: string | undefined;
};

export type FakeCustomerGateway = {
  baseUrl: string;
  requests: FakeCustomerGatewayRequest[];
  /** The customers the fake remote currently holds, in creation order. */
  customers: FakeRemoteCustomer[];
  /**
   * Arm a one-shot fault: the next create records the customer but never
   * answers — the client's own timeout has to end the request.
   */
  dropNextCreateResponse(): void;
  /** Arm a one-shot fault: the next lookup is recorded but never answered. */
  dropNextLookupResponse(): void;
  /**
   * Make every subsequent create answer with this status (a definitive
   * refusal), or `undefined` to answer normally again.
   */
  refuseCreatesWith(status: number | undefined): void;
  stop(): Promise<void>;
};

export async function startFakeCustomerGateway(options: {
  /** The bearer token the fake requires on every request. */
  token: string;
}): Promise<FakeCustomerGateway> {
  const { token } = options;
  // Per-instance, so ids do not depend on how many fakes the process started before.
  let fakeCounter = 0;
  const customers: FakeRemoteCustomer[] = [];
  const requests: FakeCustomerGatewayRequest[] = [];
  let dropNextCreate = false;
  let dropNextLookup = false;
  let refuseCreateStatus: number | undefined;
  // Released on stop() so a hung request handler cannot leak the server.
  let release: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const pathWithQuery = `${url.pathname}${url.search}`;
      const authorization = request.headers.get("authorization") ?? undefined;
      requests.push({
        method: request.method,
        path: pathWithQuery,
        authorization,
      });

      if (authorization !== `Bearer ${token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // 05.1's create: one customer per unique deterministic name.
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/customers"
      ) {
        // Consume the armed fault on arrival, whatever this create's outcome:
        // a fault outrun by a 409/422 must not leak into a later case.
        const dropThisCreate = dropNextCreate;
        dropNextCreate = false;
        const body = (await request.json()) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name : "";
        if (name.length === 0) {
          return Response.json({ error: "name is required" }, { status: 422 });
        }
        const existing = customers.find((customer) => customer.name === name);
        if (existing) {
          // The name is unique remotely: a duplicate create is a 409, exactly
          // what 05.1's adapter resolves by listing the name.
          return Response.json(
            { error: "customer name already exists" },
            { status: 409 },
          );
        }
        if (refuseCreateStatus !== undefined) {
          return Response.json(
            { error: "customer create refused" },
            { status: refuseCreateStatus },
          );
        }
        fakeCounter += 1;
        const customer: FakeRemoteCustomer = {
          customerId: `cust_${fakeCounter.toString().padStart(6, "0")}`,
          name,
        };
        customers.push(customer);
        if (dropThisCreate) {
          await stopped; // the response is lost, exactly as armed
        }
        return Response.json(
          { customer: { id: customer.customerId } },
          { status: 201 },
        );
      }

      // 05.1's resolve: list by name (substring at the gateway; the adapter
      // matches exactly).
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        const search = url.searchParams.get("search") ?? "";
        return Response.json({
          customers: customers
            .filter((customer) => customer.name.includes(search))
            .map((customer) => ({
              id: customer.customerId,
              name: customer.name,
            })),
        });
      }

      // 05.2's recovery lookup: the subject a reference names, or a definitive
      // 404 when the remote holds none.
      if (request.method === "GET" && url.pathname === "/api/customers") {
        // Same consume-on-arrival contract as the create fault above.
        const dropThisLookup = dropNextLookup;
        dropNextLookup = false;
        if (dropThisLookup) {
          await stopped;
        }
        const reference = url.searchParams.get("external_reference") ?? "";
        const found = customers.find((customer) => customer.name === reference);
        if (!found) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({ customer_id: found.customerId });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    customers,
    dropNextCreateResponse() {
      dropNextCreate = true;
    },
    dropNextLookupResponse() {
      dropNextLookup = true;
    },
    refuseCreatesWith(status) {
      refuseCreateStatus = status;
    },
    async stop() {
      release();
      await server.stop(true);
    },
  };
}

/**
 * The HTTP client over the fake's recovery-lookup surface, speaking the
 * `GatewayCustomerClient` seam. Transport failures — timeout, connection
 * reset, response never arrived — are classified as
 * `GatewayCustomerTransportLostError` ("the remote MAY have succeeded"),
 * which is the only signal the recovery layer may treat as outcome-unknown;
 * every other error is a definitive refusal of the read. Creating is not this
 * client's business — 05.1's provisioner owns the create.
 */
export function createFakeGatewayCustomerClient(
  gateway: FakeCustomerGateway,
  options: { token: string; timeoutMs?: number },
): GatewayCustomerClient {
  const timeoutMs = options.timeoutMs ?? 2000;

  const lost = (operation: string, error: unknown) =>
    new GatewayCustomerTransportLostError(
      `The ${operation} request to the gateway customer surface got no answer (timeout after ${timeoutMs}ms): the remote outcome is unknown. ${error instanceof Error ? error.message : String(error)}`,
    );

  return {
    async findCustomerByExternalReference(externalReference) {
      let response: Response;
      try {
        response = await fetch(
          `${gateway.baseUrl}/api/customers?external_reference=${encodeURIComponent(externalReference)}`,
          {
            headers: { authorization: `Bearer ${options.token}` },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch (error) {
        throw lost("customer lookup", error);
      }
      // A definitive 404 is an answer: the remote does not hold the subject.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `The gateway customer lookup failed: HTTP ${response.status}.`,
        );
      }
      let body: { customer_id?: unknown };
      try {
        body = (await response.json()) as { customer_id?: unknown };
      } catch (error) {
        throw new Error(
          `The gateway customer lookup answered with a non-JSON body: ${String(error)}`,
        );
      }
      if (typeof body.customer_id !== "string") {
        // "" would masquerade as a found customer; the contract is string | null.
        throw new Error(
          "The gateway customer lookup answered without a customer_id string.",
        );
      }
      return { customerId: body.customer_id };
    },
  };
}
