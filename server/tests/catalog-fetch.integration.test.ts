import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  gatewayCatalogFetches,
  gatewayModelCatalogRefs,
} from "../src/db/schema";
import {
  type CatalogFetchOutcome,
  createEnterpriseGatewayCatalogStore,
  createGatewayCatalogService,
  GATEWAY_CATALOG_MODELS_PATH,
  type GatewayCatalogStore,
} from "../src/gateway/catalog";
import type { GatewayEndpointConfig } from "../src/gateway/endpoint-config";
import type { GatewayReadiness } from "../src/gateway/readiness";
import { GatewayNotReadyError } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";

/*
 * Bifrost 03.1 — catalog fetch over a real PostgreSQL on TEST_DATABASE_URL
 * (tests/support/database.ts refuses the live database), against the same
 * programmable fake gateway the probe tests use. Test scaffolding only:
 * nothing in `server/src` imports the fake, and it must never become a
 * production fallback.
 *
 * What only this file can prove: the readiness gate stands *before* the dial
 * (a not-ready gate is a fetch that never happens — the spy stays silent),
 * a failed fetch leaves the last-good catalog exactly as it was while the
 * failure reason becomes displayable, a successful fetch replaces the whole
 * catalog in one transaction, and the database's unique key carries the
 * same-name-different-provider rule the normalization tests pin.
 */

const ENDPOINT: GatewayEndpointConfig = {
  baseUrl: "http://127.0.0.1:1",
  requestTimeoutMs: 5_000,
  configVersion: 7,
};

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store: GatewayCatalogStore =
  createEnterpriseGatewayCatalogStore(database);

/** A green gate: ready, version 7 — the answer every success presumes. */
function readyReadiness(): GatewayReadiness {
  return {
    ready: true,
    blockingReasons: [],
    configVersion: ENDPOINT.configVersion,
    checkedAt: "2026-10-17T00:00:00.000Z",
  };
}

/** A refusing gate, built the way the real one refuses. */
function notReadyError(...reasons: GatewayReadiness["blockingReasons"]) {
  const readiness: GatewayReadiness = {
    ready: false,
    blockingReasons: reasons,
    configVersion: ENDPOINT.configVersion,
    checkedAt: "2026-10-17T00:00:00.000Z",
  };
  return new GatewayNotReadyError(readiness, [
    {
      reason: reasons[0] ?? "gateway_readiness_probe_missing",
      message: "The gateway is not ready.",
    },
  ]);
}

function catalogModelBody(entries: unknown[]) {
  return JSON.stringify({ object: "list", data: entries });
}

/**
 * Monotonic test clock: every fetch the suite runs stamps a strictly later
 * completion time than the one before, so the append-only fetch log's
 * "latest" read is attributable to the test that just ran — the log cannot
 * be truncated, so timestamps are the only attribution there is. The clock
 * is pushed past the log's own newest row before each test, so stale rows
 * from earlier runs (which nobody can delete) can never outrank fresh ones,
 * no matter where this machine's wall clock stands.
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

type ServiceOverrides = Parameters<typeof createGatewayCatalogService>[0];

function service(overrides: Partial<ServiceOverrides>) {
  return createGatewayCatalogService({
    assertGatewayReady: async () => readyReadiness(),
    readGatewayEndpoint: async () => ENDPOINT,
    resolveGatewayAdminCredential: async () => ({ adminKey: "admin-key" }),
    store,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
    ...overrides,
  });
}

async function persistedRefs() {
  return database
    .select()
    .from(gatewayModelCatalogRefs)
    .orderBy(gatewayModelCatalogRefs.provider, gatewayModelCatalogRefs.model);
}

beforeEach(async () => {
  await database.delete(gatewayModelCatalogRefs);
  await advanceClockPastLog();
  // The append-only fetch log cannot be deleted; each test asserts on the
  // rows it can attribute (fetchedAt timestamps it controls).
});

afterAll(async () => {
  await database.$client.close();
});

describe("the gate stands before the dial", () => {
  test("a not-ready gate means no fetch: the dial spy is never called", async () => {
    let dialed = 0;
    const fetchImpl: typeof fetch = () => {
      dialed += 1;
      throw new Error("the catalog fetch must not dial the network");
    };

    const outcome = await service({
      assertGatewayReady: async () => {
        throw notReadyError("gateway_readiness_probe_not_ok");
      },
      fetchImpl,
    }).fetchCatalog();

    expect(dialed).toBe(0);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_gate_not_ready");
      expect(outcome.readinessReasons).toEqual([
        "gateway_readiness_probe_not_ok",
      ]);
    }
    // Nothing leaked into the last-good catalog either.
    expect(await persistedRefs()).toEqual([]);
    // And the refusal is displayable after the fact.
    const latest = await store.readLatestFetchOutcome();
    expect(latest?.status).toBe("failed");
    if (latest?.status === "failed") {
      expect(latest.reasonCode).toBe("catalog_fetch_gate_not_ready");
    }
  });

  test("a missing installed gate refuses without dialing", async () => {
    let dialed = 0;
    const fetchImpl: typeof fetch = () => {
      dialed += 1;
      throw new Error("the catalog fetch must not dial the network");
    };
    const { assertGatewayReadyForBilling } = await import(
      "../src/gateway/readiness"
    );
    const outcome = await service({
      assertGatewayReady: () => assertGatewayReadyForBilling(undefined),
      fetchImpl,
    }).fetchCatalog();
    expect(dialed).toBe(0);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_gate_not_ready");
      expect(outcome.readinessReasons).toEqual([
        "gateway_readiness_gate_unavailable",
      ]);
    }
  });
});

describe("a successful fetch replaces the catalog", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("refs land with their raw entries and the fetch record", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-4o", supported_methods: ["chat"] },
        { id: "azure/gpt-4o", supported_methods: ["chat"] },
        { id: "openai/text-embedding-3-small", supported_methods: ["embed"] },
        { id: "openai/whisper-1" },
      ]),
    });

    const svc = service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
      fetchImpl: undefined,
    });
    const outcome: CatalogFetchOutcome = await svc.fetchCatalog();

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.record.source).toBe("gateway:/v1/models");
    expect(outcome.record.rawItemCount).toBe(4);
    expect(outcome.record.configVersion).toBe(ENDPOINT.configVersion);
    expect(Number.isNaN(Date.parse(outcome.record.fetchedAt))).toBe(false);

    const refs = await persistedRefs();
    // Same name, two providers: two rows. The unknown-capability model is
    // kept as unknown with its reason, not dropped and not called chat.
    expect(refs).toHaveLength(4);
    expect(
      refs
        .map((row) => `${row.provider}|${row.model}|${row.capability}`)
        .sort(),
    ).toEqual(
      [
        "azure|gpt-4o|chat",
        "openai|gpt-4o|chat",
        "openai|text-embedding-3-small|embedding",
        "openai|whisper-1|unknown",
      ].sort(),
    );

    const unknownRow = refs.find((row) => row.model === "whisper-1");
    expect(unknownRow?.capability).toBe("unknown");
    expect(unknownRow?.unknownReason).toBe("catalog_capability_no_signal");
    expect((unknownRow?.rawEntry as { id?: string })?.id).toBe(
      "openai/whisper-1",
    );

    // listModelRefs exposes the plain triple contract downstream consumes.
    const listRefs = await svc.listModelRefs();
    expect(listRefs).toContainEqual({
      provider: "azure",
      model: "gpt-4o",
      capability: "chat",
    });
    expect(listRefs).toHaveLength(4);

    const latest = await store.readLatestFetchOutcome();
    expect(latest?.status).toBe("ok");
    if (latest?.status === "ok") {
      expect(latest.record.rawItemCount).toBe(4);
      expect(latest.record.configVersion).toBe(ENDPOINT.configVersion);
    }
  });

  test("a second successful fetch replaces the whole catalog, not a merge", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-5", supported_methods: ["chat"] },
      ]),
    });
    const svc = service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
    });
    const outcome = await svc.fetchCatalog();
    expect(outcome.status).toBe("ok");

    const refs = await persistedRefs();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.model).toBe("gpt-5");
  });
});

describe("a failed fetch keeps the last-good catalog", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("upstream 500 after the gate: last-good untouched, failure displayable", async () => {
    // Seed last-good with one good fetch.
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-4o", supported_methods: ["chat"] },
      ]),
    });
    const svc = service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
    });
    expect((await svc.fetchCatalog()).status).toBe("ok");
    const before = await persistedRefs();
    expect(before).toHaveLength(1);

    // Now the gateway breaks.
    gateway.respondWith({ kind: "response", status: 500, body: "{}" });
    const outcome = await svc.fetchCatalog();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_invalid_response");
    }

    const after = await persistedRefs();
    expect(after).toEqual(before);

    const latest = await store.readLatestFetchOutcome();
    expect(latest?.status).toBe("failed");
    if (latest?.status === "failed") {
      expect(latest.reasonCode).toBe("catalog_fetch_invalid_response");
    }
  });

  test("an unreachable gateway records the failure and keeps last-good", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-4o", supported_methods: ["chat"] },
      ]),
    });
    const svc = service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
    });
    expect((await svc.fetchCatalog()).status).toBe("ok");

    // Point the service at a port nothing listens on.
    const outcome = await service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: "http://127.0.0.1:9",
        requestTimeoutMs: 500,
      }),
    }).fetchCatalog();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_unreachable");
    }
    expect(await persistedRefs()).toHaveLength(1);
  });

  test("an unauthenticated answer is a failure, never a partial catalog", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 401,
      body: '{"error":"nope"}',
    });
    const outcome = await service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
    }).fetchCatalog();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_unauthenticated");
    }
    expect(await persistedRefs()).toEqual([]);
  });
});

describe("pagination", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("next_page_token is followed and both pages land", async () => {
    let page = 0;
    gateway = await startFakeGateway({ kind: "hang" });
    // Rewrite the response per request: page 0 carries a token, page 1 ends it.
    gateway.respondWith({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-4o", supported_methods: ["chat"] },
      ]),
    });
    const originalFetch = globalThis.fetch;
    const pagingFetch: typeof fetch = async (_input, init) => {
      page += 1;
      const body =
        page === 1
          ? JSON.stringify({
              data: [{ id: "openai/gpt-4o", supported_methods: ["chat"] }],
              next_page_token: "token-2",
            })
          : catalogModelBody([
              { id: "azure/gpt-4o", supported_methods: ["chat"] },
            ]);
      const fake = await startFakeGateway({
        kind: "response",
        status: 200,
        body,
      });
      try {
        return await originalFetch(
          `${fake.baseUrl}${GATEWAY_CATALOG_MODELS_PATH}`,
          init,
        );
      } finally {
        await fake.stop();
      }
    };

    const outcome = await service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: "http://unused",
      }),
      fetchImpl: pagingFetch,
    }).fetchCatalog();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.record.rawItemCount).toBe(2);
    }
    const refs = await persistedRefs();
    expect(refs).toHaveLength(2);
    expect(page).toBeGreaterThanOrEqual(2);
    await gateway.stop();
  });

  test("a pagination loop that exceeds the page cap fails whole — no partial catalog", async () => {
    let dialed = 0;
    const endlessFetch: typeof fetch = async () => {
      dialed += 1;
      return new Response(
        JSON.stringify({
          data: [{ id: "openai/more", supported_methods: ["chat"] }],
          next_page_token: `token-${dialed}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const outcome = await service({
      readGatewayEndpoint: async () => ENDPOINT,
      fetchImpl: endlessFetch,
      maxPages: 3,
    }).fetchCatalog();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reasonCode).toBe("catalog_fetch_pagination_exceeded");
    }
    expect(dialed).toBe(3);
    expect(await persistedRefs()).toEqual([]);
  });
});

describe("the database carries the identity rule", () => {
  test("the same model name on two providers persists as two rows", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: catalogModelBody([
        { id: "openai/gpt-4o", supported_methods: ["chat"] },
        { id: "azure/gpt-4o", supported_methods: ["chat"] },
      ]),
    });
    const svc = service({
      readGatewayEndpoint: async () => ({
        ...ENDPOINT,
        baseUrl: gateway.baseUrl,
      }),
    });
    expect((await svc.fetchCatalog()).status).toBe("ok");
    const refs = await persistedRefs();
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map((row) => row.provider))).toEqual(
      new Set(["openai", "azure"]),
    );

    // The unique index itself: a second row for a triple that already exists
    // is a database refusal, not a silent merge.
    let duplicateRejected = false;
    try {
      await database.insert(gatewayModelCatalogRefs).values({
        provider: "openai",
        model: "gpt-4o",
        capability: "chat",
        capabilitySource: "supported_methods",
        rawEntry: { id: "openai/gpt-4o", supported_methods: ["chat"] },
        configVersion: ENDPOINT.configVersion,
        fetchedAt: new Date(),
      });
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);
  });
});
