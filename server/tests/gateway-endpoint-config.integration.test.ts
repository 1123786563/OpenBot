import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { gatewayConfigs } from "../src/db/schema/gateway";
import {
  parseGatewayEndpointInput,
  readGatewayEndpoint,
  saveGatewayEndpoint,
} from "../src/gateway/config-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.execute(sql`DELETE FROM gateway_configs`);
  await database.$client.close();
});

describe("gateway endpoint persistence", () => {
  test("save then read is stable, and each save bumps configVersion", async () => {
    const first = parseGatewayEndpointInput({ baseUrl: "https://bifrost.example.com", requestTimeoutMs: 10_000 });
    if (!first.ok) throw new Error(first.error);
    const saved1 = await saveGatewayEndpoint(database, first.value, "admin-1");
    expect(saved1.configVersion).toBe(1);

    const saved2 = await saveGatewayEndpoint(database, first.value, "admin-1");
    expect(saved2.configVersion).toBe(2);

    const read = await readGatewayEndpoint(database);
    expect(read?.baseUrl).toBe("https://bifrost.example.com");
    expect(read?.configVersion).toBe(2);
    expect(read?.updatedBy).toBe("admin-1");
  });

  test("a fresh reader (restart) sees the same row", async () => {
    const read = await readGatewayEndpoint(database);
    const rows = await database.select().from(gatewayConfigs).where(eq(gatewayConfigs.id, "default"));
    expect(rows).toHaveLength(1);
    expect(read?.configVersion).toBe(rows[0].configVersion);
  });

  test("the stored row carries no credential-like columns", async () => {
    const rows = await database.select().from(gatewayConfigs);
    const columns = Object.keys(rows[0]);
    expect(columns.some((c) => /secret|token|password|key/i.test(c))).toBe(false);
  });
});
