import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import {
  billingAdmission,
  notConfiguredConversionRateState,
  parseConversionRate,
} from "../src/gateway/conversion-rate";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { truncateRateVersions } from "./support/rate-version-reset";

/*
 * Bifrost 01.3 — the USD→credits conversion rate is a required, exactly-rational configuration.
 *
 * Nothing here may fall back to a float or an implicit default: the rate is the deployment's own
 * exchange between provider dollars and its credit currency (Q9/Q14/Q19), so an unconfigured rate
 * means billing is simply not enabled, and a malformed one is refused with the reason. The same
 * validator must answer the process-start path (GATEWAY_CREDIT_CONVERSION_RATE in loadConfig) and
 * the administrator write path (the store below), so the two can never disagree.
 */

const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

function rate(
  numerator: bigint | number,
  denominator: bigint | number,
): {
  numerator: bigint;
  denominator: bigint;
} {
  return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
}

describe("parseConversionRate — the one validator both paths share", () => {
  test("a legal rational parses to exact bigint terms, reduced to lowest terms", () => {
    const parsed = parseConversionRate({
      numerator: "900",
      denominator: "1",
    });
    expect(parsed).toEqual({ ok: true, rate: rate(900n, 1n) });
    if (parsed.ok) {
      expect(typeof parsed.rate.numerator).toBe("bigint");
      expect(typeof parsed.rate.denominator).toBe("bigint");
    }

    // One third stays one third: no float ever touches it.
    expect(parseConversionRate({ numerator: "1", denominator: "3" })).toEqual({
      ok: true,
      rate: rate(1n, 3n),
    });

    // A non-reduced input is canonicalised, never silently kept ambiguous.
    expect(parseConversionRate({ numerator: "10", denominator: "4" })).toEqual({
      ok: true,
      rate: rate(5n, 2n),
    });
  });

  test("safe integers are accepted in both fields, matching the env-JSON style", () => {
    expect(parseConversionRate({ numerator: 100, denominator: 1 })).toEqual({
      ok: true,
      rate: rate(100n, 1n),
    });
  });

  test("extreme-but-legal rates keep exact precision at both ends", () => {
    // The smallest representable positive rate: 15 denominator digits.
    expect(
      parseConversionRate({ numerator: "1", denominator: "1000000000000000" }),
    ).toEqual({
      ok: true,
      rate: rate(1n, 1_000_000_000_000_000n),
    });
    // The largest legal value: the whole-credit ceiling the 32-bit ledger can settle.
    expect(
      parseConversionRate({ numerator: "21474836", denominator: "1" }),
    ).toEqual({ ok: true, rate: rate(21_474_836n, 1n) });
  });

  test("a zero term is refused with the reason it deserves", () => {
    const zeroNumerator = parseConversionRate({
      numerator: "0",
      denominator: "1",
    });
    expect(zeroNumerator.ok).toBe(false);
    if (!zeroNumerator.ok) {
      expect(zeroNumerator.issues).toEqual([
        {
          field: "numerator",
          code: "zero",
          message: expect.stringContaining(
            "zero conversion rate would make every dollar of provider cost free",
          ),
        },
      ]);
    }
    const zeroDenominator = parseConversionRate({
      numerator: "1",
      denominator: "0",
    });
    expect(zeroDenominator.ok).toBe(false);
    if (!zeroDenominator.ok) {
      expect(zeroDenominator.issues[0]).toMatchObject({
        field: "denominator",
        code: "zero",
      });
    }
  });

  test("negative terms are refused naming the field", () => {
    const negative = parseConversionRate({
      numerator: "-100",
      denominator: "1",
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.issues[0]).toMatchObject({
        field: "numerator",
        code: "negative",
      });
    }
    const negativeDenominator = parseConversionRate({
      numerator: "100",
      denominator: "-3",
    });
    expect(negativeDenominator.ok).toBe(false);
    if (!negativeDenominator.ok) {
      expect(negativeDenominator.issues[0]).toMatchObject({
        field: "denominator",
        code: "negative",
      });
    }
  });

  test("non-integer and malformed strings are refused as invalid_format", () => {
    for (const numerator of ["1.5", "abc", "1e3", "", " 12x", "0x10"]) {
      const parsed = parseConversionRate({ numerator, denominator: "1" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues[0]).toMatchObject({
          field: "numerator",
          code: "invalid_format",
        });
      }
    }
    // Floats are floats even when JSON calls them numbers.
    const float = parseConversionRate({ numerator: 1.5, denominator: 1 });
    expect(float.ok).toBe(false);
    if (!float.ok) {
      expect(float.issues[0]).toMatchObject({
        field: "numerator",
        code: "invalid_format",
      });
    }
    // Beyond Number.MAX_SAFE_INTEGER the JSON number is already lossy, so only strings carry it.
    const unsafe = parseConversionRate({
      numerator: 9_007_199_254_740_992,
      denominator: 1,
    });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.issues[0]).toMatchObject({
        field: "numerator",
        code: "invalid_format",
      });
    }
  });

  test("terms beyond the 15-digit precision cap are refused", () => {
    const parsed = parseConversionRate({
      numerator: "1",
      denominator: "1000000000000001",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]).toMatchObject({
        field: "denominator",
        code: "out_of_range",
      });
      expect(parsed.issues[0].message).toContain("15");
    }
    const hugeNumerator = parseConversionRate({
      numerator: "1000000000000001",
      denominator: "1",
    });
    expect(hugeNumerator.ok).toBe(false);
    if (!hugeNumerator.ok) {
      expect(hugeNumerator.issues[0]).toMatchObject({
        field: "numerator",
        code: "out_of_range",
      });
    }
  });

  test("a rate whose value cannot be settled in the ledger is refused", () => {
    // 21474836.47 credits is the 32-bit ceiling at ×100; anything above cannot be stored.
    const parsed = parseConversionRate({
      numerator: "21474837",
      denominator: "1",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]).toMatchObject({
        field: "rate",
        code: "out_of_range",
      });
      expect(parsed.issues[0].message).toContain("21474836");
    }
  });

  test("missing fields, wrong shapes and non-objects are refused", () => {
    const missing = parseConversionRate({ denominator: "1" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues[0]).toMatchObject({
        field: "numerator",
        code: "missing",
      });
    }
    for (const value of [null, [], "100", 100, true]) {
      const parsed = parseConversionRate(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues[0]).toMatchObject({ code: "invalid_shape" });
      }
    }
  });
});

describe("GATEWAY_CREDIT_CONVERSION_RATE at process start", () => {
  test("absent means unconfigured — legal at startup, billing stays disabled", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.gateway?.creditConversionRate).toBeUndefined();
  });

  test("a legal rational is carried exactly", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GATEWAY_CREDIT_CONVERSION_RATE: '{"numerator":"1","denominator":"3"}',
    });
    expect(config.gateway?.creditConversionRate).toEqual(rate(1n, 3n));
  });

  test("every illegal value refuses to start, with the specific reason", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE: '{"numerator":"0","denominator":"1"}',
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*zero/s);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE: '{"numerator":"-1","denominator":"1"}',
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*negative/s);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE: '{"numerator":"1.5","denominator":"1"}',
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*invalid/s);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE:
          '{"numerator":"1","denominator":"1000000000000001"}',
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*15/s);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE: "not json",
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*valid JSON/s);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_CREDIT_CONVERSION_RATE: '{"numerator":"100"}',
      }),
    ).toThrow(/GATEWAY_CREDIT_CONVERSION_RATE.*denominator.*missing/s);
  });
});

describe("billingAdmission — the explainable state downstream consumes", () => {
  test("unconfigured means billing is not enabled, and the state says why", () => {
    const admission = billingAdmission(notConfiguredConversionRateState());
    expect(admission).toEqual({
      enabled: false,
      reason: "conversion_rate_not_configured",
      explanation: expect.stringContaining("cannot be enabled") as unknown,
    });
  });

  test("a configured rate enables billing with the exact rational", () => {
    const admission = billingAdmission({
      configured: true,
      numerator: 1n,
      denominator: 3n,
      rateVersion: 2,
      source: "admin",
    });
    expect(admission).toEqual({
      enabled: true,
      numerator: 1n,
      denominator: 3n,
      rateVersion: 2,
    });
  });
});

/*
 * The administrator write path. Same validator, durable storage: a dedicated PostgreSQL test
 * database is required (support/database.ts refuses to fall back to any other), so these run
 * wherever the rest of the DB suite runs and never silently skip.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const GATEWAY_CONVERSION_RATE_KEY = "gateway_conversion_rate";

async function cleanupStoredRate() {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_CONVERSION_RATE_KEY));
  // 01.4 appends every save to the append-only `gateway_rate_versions` history; the test reset
  // goes through the trigger-disable path in the shared support helper (owner-only DDL — test
  // tooling, never a production mutation path). Version numbering below is absolute on a clean
  // history, so a leftover from a failed earlier run must not survive.
  await truncateRateVersions(database);
}

afterAll(async () => {
  await cleanupStoredRate();
  await database.$client.close();
});

describe("conversion rate store — admin writes and readConversionRate()", () => {
  test("nothing stored and no environment rate means not configured, with the reason", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({ database });
    expect(await store.readConversionRate()).toEqual({
      configured: false,
      reason: "not_configured",
      explanation: expect.stringContaining("conversion rate") as unknown,
    });
  });

  test("an environment rate is served with rateVersion 0 until an admin saves", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({
      database,
      environmentRate: rate(900n, 1n),
    });
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 900n,
      denominator: 1n,
      rateVersion: 0,
      source: "environment",
    });
  });

  test("an illegal admin write is refused with the reason and stores nothing", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({ database });
    for (const input of [
      { numerator: "0", denominator: "1" },
      { numerator: "-5", denominator: "1" },
      { numerator: "1.5", denominator: "1" },
      { numerator: "1", denominator: "1000000000000001" },
      { numerator: "21474837", denominator: "1" },
      "not an object",
      { numerator: "1" },
    ]) {
      const saved = await store.save(input, "admin@openbot.test");
      expect(saved.ok).toBe(false);
      if (!saved.ok) {
        expect(saved.issues.length).toBeGreaterThan(0);
      }
    }
    expect(await store.readConversionRate()).toEqual({
      configured: false,
      reason: "not_configured",
      explanation: expect.stringContaining("conversion rate") as unknown,
    });
  });

  test("a legal admin save round-trips exactly and increments rateVersion", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({
      database,
      environmentRate: rate(900n, 1n),
    });
    const first = await store.save(
      { numerator: "1", denominator: "3" },
      "admin@openbot.test",
    );
    expect(first).toEqual({
      ok: true,
      numerator: 1n,
      denominator: 3n,
      rateVersion: 1,
    });
    // The admin row wins over the environment value the moment it exists.
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 1n,
      denominator: 3n,
      rateVersion: 1,
      source: "admin",
    });

    const second = await store.save(
      { numerator: "10", denominator: "4" },
      "admin@openbot.test",
    );
    expect(second).toEqual({
      ok: true,
      numerator: 5n,
      denominator: 2n, // canonical, reduced
      rateVersion: 2,
    });

    // A restarted server reads the same exact value, no float drift anywhere.
    const restarted = createDatabase(testDatabaseUrl(), TEST_POOL);
    try {
      const restartedStore = createConversionRateStore({
        database: restarted,
      });
      expect(await restartedStore.readConversionRate()).toEqual({
        configured: true,
        numerator: 5n,
        denominator: 2n,
        rateVersion: 2,
        source: "admin",
      });
    } finally {
      await restarted.$client.close();
    }
  });

  test("extreme legal rates round-trip exactly through the store", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({ database });
    const tiny = await store.save(
      { numerator: "1", denominator: "1000000000000000" },
      "admin@openbot.test",
    );
    expect(tiny).toEqual({
      ok: true,
      numerator: 1n,
      denominator: 1_000_000_000_000_000n,
      rateVersion: 1,
    });
    const huge = await store.save(
      { numerator: "21474836", denominator: "1" },
      "admin@openbot.test",
    );
    expect(huge).toEqual({
      ok: true,
      numerator: 21_474_836n,
      denominator: 1n,
      rateVersion: 2,
    });
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 21_474_836n,
      denominator: 1n,
      rateVersion: 2,
      source: "admin",
    });
  });

  test("two concurrent saves get distinct versions, never a duplicate", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({ database });
    const other = createConversionRateStore({ database });
    const [a, b] = await Promise.all([
      store.save({ numerator: "1", denominator: "3" }, "admin@openbot.test"),
      other.save({ numerator: "2", denominator: "3" }, "other@openbot.test"),
    ]);
    expect([a.rateVersion, b.rateVersion].sort()).toEqual([1, 2]);
    // Whichever write won the race is the exact value the next read returns.
    const state = await store.readConversionRate();
    expect(state.configured).toBe(true);
    expect(state.configured === true ? state.rateVersion : 0).toBe(2);
  });

  test("a tampered stored row is refused loudly, not silently treated as unconfigured", async () => {
    await cleanupStoredRate();
    await database.insert(enterpriseSettings).values({
      key: GATEWAY_CONVERSION_RATE_KEY,
      value: { value: { numerator: "0", denominator: "1" }, rateVersion: 1 },
      updatedBy: "someone-with-database-access",
      updatedAt: new Date(),
    });
    const store = createConversionRateStore({ database });
    await expect(store.readConversionRate()).rejects.toThrow(
      /stored conversion rate row .* is invalid.*zero/s,
    );
    // The tampered row never serves as a fallback for an illegal write either.
    const saved = await store.save(
      { numerator: "100", denominator: "1" },
      "admin@openbot.test",
    );
    expect(saved).toEqual({
      ok: true,
      numerator: 100n,
      denominator: 1n,
      rateVersion: 2,
    });
    // And the legal write repaired the row: reads serve it again.
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 100n,
      denominator: 1n,
      rateVersion: 2,
      source: "admin",
    });
  });

  test("startup validation and admin writes agree on every input", async () => {
    await cleanupStoredRate();
    const store = createConversionRateStore({ database });
    const battery: unknown[] = [
      { numerator: "0", denominator: "1" },
      { numerator: "-1", denominator: "3" },
      { numerator: "1.5", denominator: "1" },
      { numerator: 1.5, denominator: 1 },
      { numerator: "1", denominator: "1000000000000001" },
      { numerator: "21474837", denominator: "1" },
      { numerator: "abc", denominator: "1" },
      { numerator: "1" },
      "bogus",
      null,
      { numerator: "3", denominator: "7" },
      { numerator: 12, denominator: 6 },
    ];
    for (const input of battery) {
      const serialized =
        typeof input === "string" ? input : JSON.stringify(input);
      const parsed = parseConversionRate(input);
      const startup = (() => {
        try {
          loadConfig({
            ...baseEnvironment,
            GATEWAY_CREDIT_CONVERSION_RATE: serialized,
          });
          return { accepted: true as const };
        } catch {
          return { accepted: false as const };
        }
      })();
      const admin = await store.save(input, "admin@openbot.test");
      // One validator, two doors: the conclusions are the same verdict.
      expect(parsed.ok).toBe(startup.accepted);
      expect(admin.ok).toBe(startup.accepted);
      if (!admin.ok && !parsed.ok) {
        expect(admin.issues).toEqual(parsed.issues);
      }
    }
    // The battery's legal writes ("3"/"7" then 12/6) left the last exact value.
    expect(await store.readConversionRate()).toEqual({
      configured: true,
      numerator: 2n,
      denominator: 1n,
      rateVersion: 2,
      source: "admin",
    });
  });
});
