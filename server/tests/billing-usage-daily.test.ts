import { expect, test } from "bun:test";
import { createBillingService } from "../src/billing/service";

/**
 * An ISO-8601 stamp built from local-clock parts, so "the same local day" in an event's timestamp
 * and in the expected bucket date mean the same thing whatever timezone the test machine runs in
 * (a fixed UTC stamp would bucket differently east of UTC, which is a fact of the feature, not a
 * property of these fixtures).
 */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

/** The server-local day of a stamp, spelled the way the bucket dates are spelled. */
function dayKeyOf(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Token counts ride in the event's properties under the provider's wire names, exactly as the
// Lago adapter's records spell them (lago.ts `LagoEventRecord`).
function event(overrides: Record<string, unknown>) {
  return {
    transactionId: crypto.randomUUID(),
    code: "llm.tokens",
    timestamp: localIso(2026, 10, 3, 12),
    properties: {},
    ...overrides,
  };
}

function serviceWith(events: ReturnType<typeof event>[], pages = 1) {
  const listEventsCalls: number[] = [];
  const service = createBillingService({
    config: { externalCustomerKey: "cust", webhookMode: "off" },
    store: {
      readSubscriptions: async () => [
        {
          externalCustomerId: "cust",
          externalSubscriptionId: "sub-1",
          planCode: "pro",
          status: "active",
        },
      ],
    } as never,
    client: {
      getUsage: async () => ({
        status: 200,
        body: {
          fromDatetime: "2026-10-01T00:00:00Z",
          toDatetime: "2026-11-01T00:00:00Z",
          charges: [],
        },
      }),
      listEvents: async (_sub: string, _perPage: number, page: number) => {
        listEventsCalls.push(page);
        return {
          status: 200,
          body: {
            events: pages >= page ? events : [],
            totalCount: events.length,
            totalPages: pages,
            currentPage: page,
            nextPage: page < pages ? page + 1 : null,
          },
        };
      },
    } as never,
    planEntitlements: new Map(),
  });
  return { service, listEventsCalls };
}

test("usageDaily buckets events by server-local day", async () => {
  const { service } = serviceWith([
    event({
      timestamp: localIso(2026, 10, 3, 12),
      properties: { tokens: 100, input_tokens: 30, output_tokens: 70 },
    }),
    event({
      timestamp: localIso(2026, 10, 3, 23, 30),
      properties: { tokens: 50, input_tokens: 20, output_tokens: 30 },
    }),
    event({
      timestamp: localIso(2026, 10, 4, 8),
      properties: { tokens: 10, input_tokens: 4, output_tokens: 6 },
    }),
    event({ timestamp: localIso(2026, 10, 5, 8), properties: {} }),
  ]);
  const daily = await service.usageDaily();
  expect(daily.truncated).toBe(false);
  expect(daily.fromDatetime).toBe("2026-10-01T00:00:00Z");
  expect(daily.toDatetime).toBe("2026-11-01T00:00:00Z");
  expect(daily.days).toEqual([
    {
      date: dayKeyOf(localIso(2026, 10, 3, 12)),
      tokens: 150,
      inputTokens: 50,
      outputTokens: 100,
      calls: 2,
    },
    {
      date: dayKeyOf(localIso(2026, 10, 4, 8)),
      tokens: 10,
      inputTokens: 4,
      outputTokens: 6,
      calls: 1,
    },
    {
      date: dayKeyOf(localIso(2026, 10, 5, 8)),
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 1,
    },
  ]);
});

test("usageDaily stops at the page ceiling and reports truncation", async () => {
  // pages=60: after the 50th page the provider still offers a next one.
  const { service, listEventsCalls } = serviceWith([event({})], 60);
  const daily = await service.usageDaily();
  expect(daily.truncated).toBe(true);
  expect(listEventsCalls.length).toBe(50);
});

test("usageDaily is cached for the TTL window", async () => {
  const { service, listEventsCalls } = serviceWith([event({})], 1);
  await service.usageDaily();
  await service.usageDaily();
  expect(listEventsCalls.length).toBe(1);
});

test("usageDaily answers empty days without an active subscription", async () => {
  const service = createBillingService({
    config: { externalCustomerKey: "cust", webhookMode: "off" },
    store: { readSubscriptions: async () => [] } as never,
    client: {} as never,
    planEntitlements: new Map(),
  });
  const daily = await service.usageDaily();
  expect(daily).toEqual({ days: [], truncated: false });
});
