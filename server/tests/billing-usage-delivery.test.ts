import { afterAll, beforeEach, describe, expect, mock, test } from "../../tests/support/bun-test-compat";
import { CreditReservationConflictError } from "../src/billing/credits-writer";
import { startUsageDeliverySweeps } from "../src/billing/maintenance";
import { createBillingService } from "../src/billing/service";
import { BillingError } from "../src/billing/types";
import {
  createCreditUsageTarget,
  createLagoUsageTarget,
  createUsageDelivery,
  MAX_DELIVERY_ATTEMPTS,
  MIN_BLOCK_AGE_MS,
  UsageDeliveryError,
} from "../src/billing/usage-delivery";
import type {
  UsageOutbox,
  UsageOutboxRecord,
} from "../src/billing/usage-outbox";

function makeRecord(eventId: string): UsageOutboxRecord {
  return {
    eventId,
    source: "llm",
    externalCustomerId: "cust",
    transactionId: `tx-${eventId}`,
    inputTokens: 3,
    outputTokens: 4,
    model: "m1",
    client: "web",
    occurredAt: new Date("2026-10-12T00:00:00Z"),
    runId: null,
    botId: null,
    ownerUserId: null,
    sessionId: null,
    status: null,
    reservationId: null,
    actualCostNumerator: null,
    actualCostDenominator: null,
    lagoStatus: "pending",
    creditsStatus: "pending",
    lagoLastErrorCode: null,
    creditsLastErrorCode: null,
    lagoAttempts: 0,
    creditsAttempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as UsageOutboxRecord;
}

function memoryOutbox(initial: UsageOutboxRecord[]) {
  const rows = new Map(initial.map((row) => [row.eventId, row]));
  const failures: string[] = [];
  const blocks: string[] = [];
  const outbox: UsageOutbox = {
    async record() {
      return { inserted: true };
    },
    async pending(limit) {
      return [...rows.values()]
        .filter(
          (r) => r.lagoStatus === "pending" || r.creditsStatus === "pending",
        )
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async markLagoDelivered(id) {
      const r = rows.get(id);
      if (r) r.lagoStatus = "delivered";
    },
    async markCreditsDelivered(id) {
      const r = rows.get(id);
      if (r) r.creditsStatus = "delivered";
    },
    async recordDeliveryFailure(id, target, code) {
      failures.push(`${id}:${target}:${code}`);
      const row = rows.get(id);
      if (!row) return { attempts: 0 };
      if (target === "lago") row.lagoAttempts += 1;
      else row.creditsAttempts += 1;
      return {
        attempts: target === "lago" ? row.lagoAttempts : row.creditsAttempts,
      };
    },
    async blockDelivery(id, target, code) {
      blocks.push(`${id}:${target}:${code}`);
      const row = rows.get(id);
      if (row) {
        if (target === "lago") {
          row.lagoStatus = "blocked" as typeof row.lagoStatus;
          row.lagoLastErrorCode = code;
        } else {
          row.creditsStatus = "blocked" as typeof row.creditsStatus;
          row.creditsLastErrorCode = code;
        }
      }
    },
  } as UsageOutbox & {
    blockDelivery(
      eventId: string,
      target: "lago" | "credits",
      failureCode: string,
    ): Promise<void>;
  };
  return { rows, failures, blocks, outbox };
}

describe("createUsageDelivery", () => {
  test("a record() rejection leaves the worker nothing to deliver", async () => {
    // The finish boundary: when the durable write fails there is no committed fact, so
    // neither Lago nor the credit ledger may run for that event.
    const calls: string[] = [];
    const outbox: UsageOutbox = {
      async record() {
        throw new Error("usage-outbox down");
      },
      async pending() {
        return [];
      },
      async markLagoDelivered() {},
      async markCreditsDelivered() {},
      async recordDeliveryFailure() {
        return { attempts: 0 };
      },
      async blockDelivery() {},
    };
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        calls.push("lago");
      },
      chargeCredits: async () => {
        calls.push("credits");
      },
      log: () => {},
    });
    expect(await delivery.runBatch(10)).toEqual({
      examined: 0,
      delivered: 0,
      failed: 0,
    });
    expect(calls).toEqual([]);
  });

  test("retries only the failed target and never repeats delivered effects", async () => {
    const { outbox, failures, rows } = memoryOutbox([makeRecord("e1")]);
    let lagoCalls = 0;
    let creditCalls = 0;
    let creditsFail = true;
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        lagoCalls += 1;
      },
      chargeCredits: async () => {
        creditCalls += 1;
        if (creditsFail) throw new UsageDeliveryError("credit_unavailable");
      },
      log: () => {},
    });

    expect(await delivery.runBatch(10)).toEqual({
      examined: 1,
      delivered: 0,
      failed: 1,
    });
    expect([lagoCalls, creditCalls]).toEqual([1, 1]);
    expect(failures).toEqual(["e1:credits:credit_unavailable"]);
    expect(rows.get("e1")?.lagoStatus).toBe("delivered");

    creditsFail = false;
    expect(await delivery.runBatch(10)).toEqual({
      examined: 1,
      delivered: 1,
      failed: 0,
    });
    expect([lagoCalls, creditCalls]).toEqual([1, 2]);

    expect(await delivery.runBatch(10)).toEqual({
      examined: 0,
      delivered: 0,
      failed: 0,
    });
    expect([lagoCalls, creditCalls]).toEqual([1, 2]);
  });

  test("the inverse failure retries only Lago", async () => {
    const { outbox } = memoryOutbox([makeRecord("e1")]);
    let lagoCalls = 0;
    let creditCalls = 0;
    let lagoFails = true;
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        lagoCalls += 1;
        if (lagoFails) throw new Error("secret-token boom");
      },
      chargeCredits: async () => {
        creditCalls += 1;
      },
      log: () => {},
    });
    expect(await delivery.runBatch(10)).toMatchObject({ failed: 1 });
    lagoFails = false;
    await delivery.runBatch(10);
    expect([lagoCalls, creditCalls]).toEqual([2, 1]);
  });

  test("a failing target does not stop the sibling or later records, and logs only stable fields", async () => {
    const { outbox, failures, rows } = memoryOutbox([
      makeRecord("e1"),
      makeRecord("e2"),
    ]);
    const logs: string[] = [];
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new Error("Bearer secret-token payload");
      },
      chargeCredits: async () => {},
      log: (m) => logs.push(m),
    });
    expect(await delivery.runBatch(10)).toEqual({
      examined: 2,
      delivered: 0,
      failed: 2,
    });
    expect(rows.get("e2")?.creditsStatus).toBe("delivered");
    expect(failures).toEqual([
      "e1:lago:delivery_failed",
      "e2:lago:delivery_failed",
    ]);
    expect(logs.join("\n")).toContain("event=e1");
    expect(logs.join("\n")).toContain("target=lago");
    expect(logs.join("\n")).toContain("code=delivery_failed");
    expect(logs.join("\n")).not.toContain("secret");
  });

  test("does not swallow outbox bookkeeping errors", async () => {
    const { outbox } = memoryOutbox([makeRecord("e1")]);
    outbox.markLagoDelivered = async () => {
      throw new Error("db down");
    };
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {},
      chargeCredits: async () => {},
      log: () => {},
    });
    await expect(delivery.runBatch(10)).rejects.toThrow("db down");
  });

  test("a failed failure-recording is propagated", async () => {
    const { outbox } = memoryOutbox([makeRecord("e1")]);
    outbox.recordDeliveryFailure = async () => {
      throw new Error("db down");
    };
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new Error("x");
      },
      chargeCredits: async () => {},
      log: () => {},
    });
    await expect(delivery.runBatch(10)).rejects.toThrow("db down");
  });

  test("legacy rows missing reservations converge to a blocked credit target without replaying", async () => {
    const { outbox, rows, failures, blocks } = memoryOutbox([
      makeRecord("legacy"),
    ]);
    const logs: string[] = [];
    let lagoCalls = 0;
    let creditCalls = 0;
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        lagoCalls += 1;
      },
      chargeCredits: async () => {
        creditCalls += 1;
        throw new UsageDeliveryError("missing_reservation");
      },
      log: (message) => logs.push(message),
    });

    expect(await delivery.runBatch(10)).toEqual({
      examined: 1,
      delivered: 0,
      failed: 1,
    });
    expect(rows.get("legacy")).toMatchObject({
      lagoStatus: "delivered",
      creditsStatus: "blocked",
      creditsLastErrorCode: "missing_reservation",
    });
    expect(failures).toEqual([]);
    expect(blocks).toEqual(["legacy:credits:missing_reservation"]);
    expect(logs).toHaveLength(1);

    expect(await delivery.runBatch(10)).toEqual({
      examined: 0,
      delivered: 0,
      failed: 0,
    });
    expect([lagoCalls, creditCalls]).toEqual([1, 1]);
    expect(logs).toHaveLength(1);
  });
});

describe("a permanent delivery failure ends in a terminal state (audit C1)", () => {
  test("a provider refusal blocks on the first attempt", async () => {
    const { outbox, rows } = memoryOutbox([makeRecord("ev-1")]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new UsageDeliveryError("provider_refused");
      },
      chargeCredits: async () => {},
    });
    await delivery.runBatch(10);
    expect(rows.get("ev-1")?.lagoStatus).toBe("blocked");
    expect(rows.get("ev-1")?.lagoLastErrorCode).toBe("provider_refused");
  });

  test("a reservation conflict blocks the credits target instead of retrying forever", async () => {
    const { outbox, rows } = memoryOutbox([
      {
        ...makeRecord("ev-2"),
        reservationId: "cr-1",
      },
    ]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {},
      chargeCredits: async () => {
        throw new CreditReservationConflictError("already released");
      },
    });
    await delivery.runBatch(10);
    expect(rows.get("ev-2")?.creditsStatus).toBe("blocked");
  });

  test("a transient failure stays pending until the attempt ceiling, then blocks", async () => {
    // Restated for the age gate: makeRecord's default createdAt is "now" (a young row, which the
    // ceiling alone may no longer block), so this case pins the old-row half explicitly.
    const { outbox, rows } = memoryOutbox([
      {
        ...makeRecord("ev-3"),
        createdAt: new Date(Date.now() - MIN_BLOCK_AGE_MS - 60_000),
      },
    ]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new UsageDeliveryError("unreachable");
      },
      chargeCredits: async () => {},
    });
    for (let pass = 0; pass < MAX_DELIVERY_ATTEMPTS - 1; pass += 1) {
      await delivery.runBatch(10);
      expect(rows.get("ev-3")?.lagoStatus).toBe("pending");
    }
    await delivery.runBatch(10);
    expect(rows.get("ev-3")?.lagoStatus).toBe("blocked");
    expect(rows.get("ev-3")?.lagoAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  test("a young row exhausted by a short outage stays pending with its attempts recorded (review r1)", async () => {
    const { outbox, rows } = memoryOutbox([makeRecord("ev-5")]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new UsageDeliveryError("unreachable");
      },
      chargeCredits: async () => {},
    });
    for (let pass = 0; pass < MAX_DELIVERY_ATTEMPTS; pass += 1) {
      await delivery.runBatch(10);
      expect(rows.get("ev-5")?.lagoStatus).toBe("pending");
    }
    expect(rows.get("ev-5")?.lagoAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  test("an exhausted row older than the block age blocks (review r1)", async () => {
    const { outbox, rows } = memoryOutbox([
      {
        ...makeRecord("ev-6"),
        createdAt: new Date(Date.now() - MIN_BLOCK_AGE_MS - 60_000),
      },
    ]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {
        throw new UsageDeliveryError("unreachable");
      },
      chargeCredits: async () => {},
    });
    for (let pass = 0; pass < MAX_DELIVERY_ATTEMPTS - 1; pass += 1) {
      await delivery.runBatch(10);
      expect(rows.get("ev-6")?.lagoStatus).toBe("pending");
    }
    await delivery.runBatch(10);
    expect(rows.get("ev-6")?.lagoStatus).toBe("blocked");
    expect(rows.get("ev-6")?.lagoAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  test("a delivered target never counts attempts", async () => {
    const { outbox, rows } = memoryOutbox([makeRecord("ev-4")]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {},
      chargeCredits: async () => {},
    });
    await delivery.runBatch(10);
    expect(rows.get("ev-4")?.lagoStatus).toBe("delivered");
    expect(rows.get("ev-4")?.lagoAttempts).toBe(0);
  });
});

describe("createCreditUsageTarget", () => {
  test("settles the persisted reservation with the exact rational actual cost", async () => {
    const calls: unknown[] = [];
    const settle = createCreditUsageTarget({
      settleReservation: async (input) => {
        calls.push(input);
        return {
          chargedCents: 7,
          appliedCents: 7,
          releasedCents: 18,
          remainder: { numerator: 0n, denominator: 1n },
        };
      },
    });
    await settle({
      ...makeRecord("e-credit"),
      reservationId: "cr_123",
      actualCostNumerator: "7",
      actualCostDenominator: "2",
    });
    expect(calls).toEqual([
      {
        reservationId: "cr_123",
        actual: { numerator: 7n, denominator: 2n },
        title: "LLM token usage",
        requestId: "e-credit",
        model: "m1",
        client: "web",
      },
    ]);
  });

  test("legacy rows without a reservation fail with a stable missing-reservation code", async () => {
    const settle = createCreditUsageTarget({
      settleReservation: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(settle(makeRecord("legacy"))).rejects.toEqual(
      new UsageDeliveryError("missing_reservation"),
    );
  });
});

describe("createLagoUsageTarget", () => {
  test("maps the persisted facts onto the delivery-grade call", async () => {
    const calls: unknown[] = [];
    const send = createLagoUsageTarget({
      deliverUsage: async (input) => {
        calls.push(input);
      },
    });
    await send(makeRecord("e1"));
    expect(calls).toEqual([
      {
        metricCode: "llm_tokens",
        transactionId: "tx-e1",
        externalCustomerId: "cust",
        timestamp: new Date("2026-10-12T00:00:00Z"),
        properties: {
          input_tokens: 3,
          output_tokens: 4,
          tokens: 7,
          model: "m1",
          client: "web",
          source: "llm",
        },
      },
    ]);
    await send({
      ...makeRecord("e2"),
      source: "code_run",
      runId: "run-e2",
      botId: "bot-e2",
      ownerUserId: "owner-e2",
      sessionId: "session-e2",
      status: "completed",
    });
    expect(calls[1]).toEqual({
      metricCode: "code_run_tokens",
      transactionId: "tx-e2",
      externalCustomerId: "cust",
      timestamp: new Date("2026-10-12T00:00:00Z"),
      properties: {
        input_tokens: 3,
        output_tokens: 4,
        tokens: 7,
        model: "m1",
        client: "web",
        source: "code_run",
        run_id: "run-e2",
        bot_id: "bot-e2",
        owner_user_id: "owner-e2",
        session_id: "session-e2",
        status: "completed",
      },
    });
  });
});

describe("BillingService.deliverUsage", () => {
  const input = {
    metricCode: "llm_tokens",
    transactionId: "tx",
    properties: { tokens: 1 },
    timestamp: new Date(1_000_000),
    externalCustomerId: "cust",
  };
  function service(opts: {
    rows?: { status: string; externalSubscriptionId: string }[];
    post?: () => Promise<{ status: number; body: null }>;
  }) {
    const posted: unknown[] = [];
    const svc = createBillingService({
      config: { externalCustomerKey: "cust", webhookMode: "off" },
      store: { readSubscriptions: async () => opts.rows ?? [] } as never,
      client: {
        postEvent: async (e: unknown) => {
          posted.push(e);
          return opts.post ? opts.post() : { status: 200, body: null };
        },
      } as never,
    });
    return { svc, posted };
  }
  const active = [{ status: "active", externalSubscriptionId: "sub" }];

  test("resolves when the provider accepts or deduplicates", async () => {
    for (const status of [200, 202]) {
      const { svc, posted } = service({
        rows: active,
        post: async () => ({ status, body: null }),
      });
      await svc.deliverUsage(input);
      expect(posted).toHaveLength(1);
    }
  });

  test("rejects when there is no active subscription, without posting", async () => {
    const { svc, posted } = service({ rows: [] });
    await expect(svc.deliverUsage(input)).rejects.toMatchObject({
      code: "no_active_subscription",
    });
    expect(posted).toHaveLength(0);
  });

  test("rejects on provider refusal", async () => {
    for (const status of [404, 422]) {
      const { svc } = service({
        rows: active,
        post: async () => ({ status, body: null }),
      });
      await expect(svc.deliverUsage(input)).rejects.toMatchObject({
        code: "provider_refused",
      });
    }
  });

  test("propagates transient failures", async () => {
    const { svc } = service({
      rows: active,
      post: async () => {
        throw new BillingError("unreachable");
      },
    });
    await expect(svc.deliverUsage(input)).rejects.toMatchObject({
      code: "unreachable",
    });
  });
});

describe("startUsageDeliverySweeps", () => {
  test("delays the first run, repeats, and stops", async () => {
    let runs = 0;
    const handle = startUsageDeliverySweeps(
      {
        runBatch: async () => {
          runs += 1;
          return { examined: 0, delivered: 0, failed: 0 };
        },
      },
      { firstRunMs: 30, intervalMs: 20, limit: 5, log: () => {} },
    );
    expect(runs).toBe(0);
    await Bun.sleep(45);
    expect(runs).toBeGreaterThanOrEqual(1);
    handle.stop();
    const after = runs;
    await Bun.sleep(60);
    expect(runs).toBe(after);
  });

  test("a failing pass is logged by name only and retried", async () => {
    const logs: string[] = [];
    let runs = 0;
    const handle = startUsageDeliverySweeps(
      {
        runBatch: async () => {
          runs += 1;
          throw new Error("postgres://user:pw@host");
        },
      },
      { firstRunMs: 5, intervalMs: 10, log: (m) => logs.push(m) },
    );
    await Bun.sleep(50);
    handle.stop();
    expect(runs).toBeGreaterThan(1);
    expect(logs[0]).not.toContain("postgres");
  });
});

describe("a sweep pass is single-instance (audit C3)", () => {
  // The guard's dedicated connection is faked — mock.module replaces postgres for the
  // already-imported sweeper — so the tests pin the lock protocol without a second database: a
  // pass that cannot take the advisory lock is skipped, and the connection that holds it is
  // ended (ending the connection IS the release of a session lock) after a successful pass AND
  // after a throwing one. A leaked lock silently disables every later sweep on every replica,
  // so the throwing half is the one that matters.
  const guard = { held: true, events: [] as string[] };
  mock.module("postgres", () => ({
    default: () => {
      const connection = (() =>
        Promise.resolve([{ held: guard.held }])) as unknown as {
        (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ): Promise<{ held: boolean }[]>;
        end: (options?: unknown) => Promise<void>;
      };
      connection.end = async () => {
        guard.events.push("end");
      };
      return connection;
    },
  }));

  beforeEach(() => {
    guard.held = true;
    guard.events = [];
  });
  afterAll(() => {
    // The module mock must not follow postgres into other test files.
    mock.restore();
  });

  const lock = {
    databaseUrl: "postgres://single-instance-guard-test",
    key: 4_192_005,
  };

  test("a pass is skipped when the advisory lock is held elsewhere", async () => {
    guard.held = false;
    let passes = 0;
    const sweeps = startUsageDeliverySweeps(
      {
        runBatch: async () => {
          passes += 1;
          return { examined: 0, delivered: 0, failed: 0 };
        },
      },
      { firstRunMs: 0, intervalMs: 5, lock },
    );
    await Bun.sleep(20);
    sweeps.stop();
    expect(passes).toBe(0);
  });

  test("a successful pass runs and ends the connection that holds the lock", async () => {
    let passes = 0;
    const sweeps = startUsageDeliverySweeps(
      {
        runBatch: async () => {
          passes += 1;
          guard.events.push("ran");
          return { examined: 0, delivered: 0, failed: 0 };
        },
      },
      { firstRunMs: 0, intervalMs: 5, lock },
    );
    await Bun.sleep(20);
    sweeps.stop();
    expect(passes).toBeGreaterThanOrEqual(1);
    // The pass that ran also released: its end follows its run (passes serialize, so nothing
    // else can land between the two).
    const firstRun = guard.events.indexOf("ran");
    expect(firstRun).toBeGreaterThanOrEqual(0);
    expect(guard.events[firstRun + 1]).toBe("end");
  });

  test("a throwing pass still ends the connection that holds the lock", async () => {
    let attempts = 0;
    const sweeps = startUsageDeliverySweeps(
      {
        runBatch: async () => {
          attempts += 1;
          guard.events.push("threw");
          throw new Error("boom");
        },
      },
      { firstRunMs: 0, intervalMs: 5, log: () => {}, lock },
    );
    await Bun.sleep(20);
    sweeps.stop();
    // The throw wedged neither the sweeper (it kept retrying) nor the lock: every throwing pass
    // is followed by its release.
    expect(attempts).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < guard.events.length; i += 1) {
      if (guard.events[i] === "threw") {
        expect(guard.events[i + 1]).toBe("end");
      }
    }
  });
});
