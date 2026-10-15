import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { parseConversionRateInput } from "../src/gateway/conversion-rate";
import { currentConversionRate, saveConversionRate } from "../src/gateway/conversion-rate-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.execute(sql`DELETE FROM gateway_conversion_rates`);
  await database.$client.close();
});

test("unset rate reads as undefined (billing not enabled), not as a default", async () => {
  expect(await currentConversionRate(database)).toBeUndefined();
});

test("saving creates immutable versions; precision is exact", async () => {
  const r = parseConversionRateInput("7.5");
  if (!r.ok) throw new Error(r.error);
  const v1 = await saveConversionRate(database, r.value, "admin-1");
  expect(v1.rateVersion).toBe(1);
  const read = await currentConversionRate(database);
  expect(read?.numerator).toBe(75n);
  expect(read?.denominator).toBe(10n);

  const r2 = parseConversionRateInput("0.300001");
  if (!r2.ok) throw new Error(r2.error);
  const v2 = await saveConversionRate(database, r2.value, "admin-2");
  expect(v2.rateVersion).toBe(2);
  expect((await currentConversionRate(database))?.numerator).toBe(300001n);
});
