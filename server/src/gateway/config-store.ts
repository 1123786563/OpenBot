import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayConfigs } from "../db/schema/gateway";

export type GatewayEndpoint = { baseUrl: string; requestTimeoutMs: number };
export type GatewayConfigRecord = GatewayEndpoint & {
  configVersion: number;
  updatedBy: string;
  updatedAt: Date;
};

export const GATEWAY_CONFIG_TOPIC = "gateway_config_changed";
const GATEWAY_ENDPOINT_ERRORS = {
  missing: "Gateway base URL is required.",
  protocol: "Gateway base URL must be an http or https URL.",
  credentials: "Gateway base URL must not carry credentials.",
  path: "Gateway base URL must be the origin only, without a path, query or fragment.",
  timeout: "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
} as const;

export function parseGatewayEndpointInput(raw: {
  baseUrl?: unknown;
  requestTimeoutMs?: unknown;
}): { ok: true; value: GatewayEndpoint } | { ok: false; error: string } {
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (baseUrl === "") return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.missing };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  }
  if (parsed.username || parsed.password) return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.credentials };
  if (parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search || parsed.hash) {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.path };
  }
  const requestTimeoutMs = raw.requestTimeoutMs;
  if (typeof requestTimeoutMs !== "number" || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.timeout };
  }
  return { ok: true, value: { baseUrl: parsed.origin, requestTimeoutMs } };
}

const SINGLETON_ID = "default";

export async function saveGatewayEndpoint(
  database: Database,
  input: GatewayEndpoint,
  by: string,
): Promise<GatewayConfigRecord> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(gatewayConfigs)
      .values({ id: SINGLETON_ID, baseUrl: input.baseUrl, requestTimeoutMs: input.requestTimeoutMs, configVersion: 1, updatedBy: by })
      .onConflictDoUpdate({
        target: gatewayConfigs.id,
        set: {
          baseUrl: input.baseUrl,
          requestTimeoutMs: input.requestTimeoutMs,
          configVersion: sql`${gatewayConfigs.configVersion} + 1`,
          updatedBy: by,
          updatedAt: new Date(),
        },
      })
      .returning();
    await tx.execute(sql`select pg_notify(${GATEWAY_CONFIG_TOPIC}, ${String(rows[0].configVersion)})`);
    return rows[0] as GatewayConfigRecord;
  });
}

export async function readGatewayEndpoint(database: Database): Promise<GatewayConfigRecord | undefined> {
  const rows = await database.select().from(gatewayConfigs).where(eq(gatewayConfigs.id, SINGLETON_ID));
  return rows[0] as GatewayConfigRecord | undefined;
}
