/**
 * The gateway endpoint a deployment's administrator saves (Bifrost ticket 01.1, #207).
 *
 * The singleton `gateway_configs` row is the runtime source of truth; the environment (config.ts)
 * is only a deployment-level default seam. Every successful save increments `config_version`
 * inside the same transaction and announces the new version with `pg_notify` on
 * {@link GATEWAY_CONFIG_TOPIC} — the same commit-delivered-change pattern the enterprise settings
 * store uses (admin/settings-store.ts), so every API server can drop its cached view the moment
 * one of them saves.
 *
 * The input carries no version: the only thing a save can do is move forward, which is what makes
 * `configVersion` monotonic and an old version unwritable — there is no path that writes it back.
 *
 * Reads return {@link GatewayEndpointConfig} and nothing else. No secret is stored in this row, so
 * no secret can leak out of one; `updatedBy`/`updatedAt` stay internal bookkeeping.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayConfigs } from "../db/schema/gateway";
import type { GatewayEndpoint } from "./endpoint";

export type { GatewayEndpoint } from "./endpoint";
export { parseGatewayEndpointInput } from "./endpoint";

/** The readonly, non-sensitive shape every downstream ticket (01.2, 01.5, 01.7) consumes. */
export type GatewayEndpointConfig = {
  baseUrl: string;
  requestTimeoutMs: number;
  /** Monotonic: every successful save produces a strictly greater integer. */
  configVersion: number;
};

/** The topic a commit-delivered `pg_notify` names when the gateway configuration changes. */
export const GATEWAY_CONFIG_TOPIC = "gateway_config_changed";

/** The full row, internal bookkeeping included. Never returned by a read interface. */
export type GatewayConfigRecord = GatewayEndpoint & {
  configVersion: number;
  updatedBy: string;
  updatedAt: Date;
};

const SINGLETON_ID = "default";

export async function saveGatewayEndpoint(
  database: Database,
  input: GatewayEndpoint,
  by: string,
): Promise<GatewayEndpointConfig> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(gatewayConfigs)
      .values({
        id: SINGLETON_ID,
        baseUrl: input.baseUrl,
        requestTimeoutMs: input.requestTimeoutMs,
        configVersion: 1,
        updatedBy: by,
      })
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
    await tx.execute(
      sql`select pg_notify(${GATEWAY_CONFIG_TOPIC}, ${String(rows[0].configVersion)})`,
    );
    return {
      baseUrl: rows[0].baseUrl,
      requestTimeoutMs: rows[0].requestTimeoutMs,
      configVersion: rows[0].configVersion,
    };
  });
}

export async function readGatewayEndpoint(
  database: Database,
): Promise<GatewayEndpointConfig | undefined> {
  const rows = await database
    .select({
      baseUrl: gatewayConfigs.baseUrl,
      requestTimeoutMs: gatewayConfigs.requestTimeoutMs,
      configVersion: gatewayConfigs.configVersion,
    })
    .from(gatewayConfigs)
    .where(eq(gatewayConfigs.id, SINGLETON_ID));
  return rows[0];
}
