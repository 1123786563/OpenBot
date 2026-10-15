import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RuntimeModelRoute } from "../../enterprise/models/runtime-adapter";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

export type ModelRouteSnapshotInput = {
  agentId: string;
  route: RuntimeModelRoute;
  nativeBaseUrl?: string;
};

export type SafeModelRouteSnapshot = {
  schemaVersion: 1;
  agentId: string;
  provider: "openai" | "anthropic";
  defaultModel: string;
  credentialSecretRef: string;
  plan: null | {
    provider: "chatgpt" | "claude";
    endpointFingerprint: string;
  };
  nativeBaseUrlFingerprint: string;
};

export type CanonicalModelRouteSnapshot = {
  routeRef: string;
  schemaVersion: 1;
  agentId: string;
  snapshot: SafeModelRouteSnapshot;
};

const fingerprintPattern = /^[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code);
  }
}

function nonEmptyString(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x20 || point === 0x7f;
    })
  ) {
    fail(code);
  }
  return value;
}

function secretKeyFor(secret: string | Uint8Array): Buffer {
  const input =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.from(secret);
  if (input.length < 16) fail("MODEL_ROUTE_KEY_INVALID");
  return createHmac("sha256", input)
    .update("openbot:model-route:v1:key")
    .digest();
}

function fingerprint(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(`openbot:model-route:v1:${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function normalizedNativeBaseUrl(
  provider: "openai" | "anthropic",
  baseUrl: string | undefined,
): string {
  if (!baseUrl?.trim()) return "default-destination:v1";
  const trimmed = baseUrl.trim();
  if (provider === "openai") return trimmed;
  const base = trimmed.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

function canonicalJson(snapshot: SafeModelRouteSnapshot): string {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    agentId: snapshot.agentId,
    provider: snapshot.provider,
    defaultModel: snapshot.defaultModel,
    credentialSecretRef: snapshot.credentialSecretRef,
    plan: snapshot.plan
      ? {
          provider: snapshot.plan.provider,
          endpointFingerprint: snapshot.plan.endpointFingerprint,
        }
      : null,
    nativeBaseUrlFingerprint: snapshot.nativeBaseUrlFingerprint,
  });
}

function routeReference(
  tenantId: string,
  snapshot: SafeModelRouteSnapshot,
): string {
  const digest = createHash("sha256")
    .update("openbot:model-route:v1:tenant\0", "utf8")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
  return `mroute:v1:${digest}`;
}

function canonicalFromSnapshot(
  tenantId: string,
  snapshot: SafeModelRouteSnapshot,
): CanonicalModelRouteSnapshot {
  return {
    routeRef: routeReference(tenantId, snapshot),
    schemaVersion: 1,
    agentId: snapshot.agentId,
    snapshot,
  };
}

export function canonicalizeModelRouteSnapshot(
  tenantId: string,
  input: ModelRouteSnapshotInput,
  modelCapabilitySecret: string | Uint8Array,
): CanonicalModelRouteSnapshot {
  if (typeof tenantId !== "string" || !tenantId)
    fail("MODEL_ROUTE_TENANT_INVALID");
  if (!isRecord(input)) fail("MODEL_ROUTE_INPUT_INVALID");
  assertKeys(
    input,
    ["agentId", "route", "nativeBaseUrl"],
    "MODEL_ROUTE_INPUT_INVALID",
  );
  const agentId = nonEmptyString(input.agentId, "MODEL_ROUTE_AGENT_INVALID");
  const route = input.route as unknown;
  if (!isRecord(route)) fail("MODEL_ROUTE_INPUT_INVALID");
  assertKeys(
    route,
    ["model", "credentialSecretRef", "planBotId"],
    "MODEL_ROUTE_INPUT_INVALID",
  );
  if (route.planBotId !== undefined && route.planBotId !== agentId)
    fail("MODEL_ROUTE_PLAN_BOT_MISMATCH");
  const model = route.model;
  if (!isRecord(model)) fail("MODEL_ROUTE_MODEL_INVALID");
  assertKeys(
    model,
    ["provider", "defaultModel", "plan"],
    "MODEL_ROUTE_MODEL_INVALID",
  );
  if (model.provider !== "openai" && model.provider !== "anthropic")
    fail("MODEL_ROUTE_PROVIDER_INVALID");
  const provider = model.provider;
  const defaultModel = nonEmptyString(
    model.defaultModel,
    "MODEL_ROUTE_MODEL_INVALID",
  );
  const credentialSecretRef = nonEmptyString(
    route.credentialSecretRef,
    "MODEL_ROUTE_CREDENTIAL_REF_INVALID",
  );
  const key = secretKeyFor(modelCapabilitySecret);
  let plan: SafeModelRouteSnapshot["plan"] = null;
  if (model.plan !== undefined) {
    if (!isRecord(model.plan)) fail("MODEL_ROUTE_PLAN_INVALID");
    assertKeys(
      model.plan,
      ["provider", "endpoint", "token"],
      "MODEL_ROUTE_PLAN_INVALID",
    );
    if (model.plan.provider !== "chatgpt" && model.plan.provider !== "claude")
      fail("MODEL_ROUTE_PLAN_INVALID");
    if (!(model.plan.endpoint instanceof URL)) fail("MODEL_ROUTE_PLAN_INVALID");
    const endpoint = new URL(model.plan.endpoint.href);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      fail("MODEL_ROUTE_PLAN_INVALID");
    if (typeof model.plan.token !== "string" || !model.plan.token)
      fail("MODEL_ROUTE_PLAN_INVALID");
    plan = {
      provider: model.plan.provider,
      endpointFingerprint: fingerprint(key, "plan-endpoint", endpoint.href),
    };
  }
  const nativeBaseUrl = input.nativeBaseUrl;
  if (nativeBaseUrl !== undefined && typeof nativeBaseUrl !== "string")
    fail("MODEL_ROUTE_BASE_URL_INVALID");
  const snapshot: SafeModelRouteSnapshot = {
    schemaVersion: 1,
    agentId,
    provider,
    defaultModel,
    credentialSecretRef,
    plan,
    nativeBaseUrlFingerprint: fingerprint(
      key,
      `native-base-url:${provider}`,
      normalizedNativeBaseUrl(provider, nativeBaseUrl),
    ),
  };
  return canonicalFromSnapshot(tenantId, snapshot);
}

type CatalogRow = {
  tenant_id: string;
  route_ref: string;
  schema_version: number;
  agent_id: string;
  snapshot: unknown;
};

type CatalogExecutor = {
  execute(statement: ReturnType<typeof sql>): Promise<unknown>;
};

function rowsOf(result: unknown): CatalogRow[] {
  if (Array.isArray(result)) return result as CatalogRow[];
  if (isRecord(result) && Array.isArray(result.rows))
    return result.rows as CatalogRow[];
  return [];
}

function parseStoredSnapshot(value: unknown): SafeModelRouteSnapshot {
  if (!isRecord(value)) fail("MODEL_ROUTE_CORRUPT");
  const allowed = [
    "schemaVersion",
    "agentId",
    "provider",
    "defaultModel",
    "credentialSecretRef",
    "plan",
    "nativeBaseUrlFingerprint",
  ];
  assertKeys(value, allowed, "MODEL_ROUTE_CORRUPT");
  if (Object.keys(value).length !== allowed.length || value.schemaVersion !== 1)
    fail("MODEL_ROUTE_CORRUPT");
  if (value.provider !== "openai" && value.provider !== "anthropic")
    fail("MODEL_ROUTE_CORRUPT");
  const snapshot: SafeModelRouteSnapshot = {
    schemaVersion: 1,
    agentId: nonEmptyString(value.agentId, "MODEL_ROUTE_CORRUPT"),
    provider: value.provider,
    defaultModel: nonEmptyString(value.defaultModel, "MODEL_ROUTE_CORRUPT"),
    credentialSecretRef: nonEmptyString(
      value.credentialSecretRef,
      "MODEL_ROUTE_CORRUPT",
    ),
    plan: null,
    nativeBaseUrlFingerprint: nonEmptyString(
      value.nativeBaseUrlFingerprint,
      "MODEL_ROUTE_CORRUPT",
    ),
  };
  if (!fingerprintPattern.test(snapshot.nativeBaseUrlFingerprint))
    fail("MODEL_ROUTE_CORRUPT");
  if (value.plan !== null) {
    if (!isRecord(value.plan)) fail("MODEL_ROUTE_CORRUPT");
    assertKeys(
      value.plan,
      ["provider", "endpointFingerprint"],
      "MODEL_ROUTE_CORRUPT",
    );
    if (
      Object.keys(value.plan).length !== 2 ||
      (value.plan.provider !== "chatgpt" && value.plan.provider !== "claude") ||
      typeof value.plan.endpointFingerprint !== "string" ||
      !fingerprintPattern.test(value.plan.endpointFingerprint)
    )
      fail("MODEL_ROUTE_CORRUPT");
    snapshot.plan = {
      provider: value.plan.provider,
      endpointFingerprint: value.plan.endpointFingerprint,
    };
  }
  return snapshot;
}

function verifyRow(
  tenantId: string,
  routeRef: string,
  row: CatalogRow,
): CanonicalModelRouteSnapshot {
  if (
    row.tenant_id !== tenantId ||
    row.route_ref !== routeRef ||
    row.schema_version !== 1
  )
    fail("MODEL_ROUTE_CORRUPT");
  const snapshot = parseStoredSnapshot(row.snapshot);
  if (row.agent_id !== snapshot.agentId) fail("MODEL_ROUTE_CORRUPT");
  const canonical = canonicalFromSnapshot(tenantId, snapshot);
  if (canonical.routeRef !== routeRef) fail("MODEL_ROUTE_CORRUPT");
  return canonical;
}

export class ModelRouteCatalogStore {
  private readonly database: DataDatabase;
  private readonly modelCapabilitySecret: string | Uint8Array;

  constructor(
    database: DataDatabase,
    modelCapabilitySecret: string | Uint8Array,
  ) {
    assertDataDatabase(database);
    this.database = database;
    this.modelCapabilitySecret = modelCapabilitySecret;
  }

  async put(
    scope: PlatformScope,
    input: ModelRouteSnapshotInput,
  ): Promise<CanonicalModelRouteSnapshot> {
    assertTrustedScope(scope);
    const canonical = canonicalizeModelRouteSnapshot(
      scope.tenantId,
      input,
      this.modelCapabilitySecret,
    );
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as CatalogExecutor;
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      const inserted = rowsOf(
        await tx.execute(sql`
        insert into enterprise_model_routes (tenant_id, route_ref, schema_version, agent_id, snapshot)
        values (${scope.tenantId}, ${canonical.routeRef}, 1, ${canonical.agentId}, ${JSON.stringify(canonical.snapshot)}::jsonb)
        on conflict (tenant_id, route_ref) do nothing
        returning tenant_id, route_ref, schema_version, agent_id, snapshot
      `),
      );
      if (inserted[0])
        return verifyRow(scope.tenantId, canonical.routeRef, inserted[0]);
      const existing = rowsOf(
        await tx.execute(sql`
        select tenant_id, route_ref, schema_version, agent_id, snapshot
        from enterprise_model_routes
        where tenant_id = ${scope.tenantId} and route_ref = ${canonical.routeRef}
      `),
      )[0];
      if (!existing) fail("MODEL_ROUTE_CONFLICT");
      let verified: CanonicalModelRouteSnapshot;
      try {
        verified = verifyRow(scope.tenantId, canonical.routeRef, existing);
      } catch (cause) {
        // The corrupt-row verification failure rides on cause so operators can
        // tell a drift conflict from a damaged catalog row.
        throw Object.assign(new Error("MODEL_ROUTE_CONFLICT"), { cause });
      }
      if (
        verified.schemaVersion !== canonical.schemaVersion ||
        verified.agentId !== canonical.agentId ||
        canonicalJson(verified.snapshot) !== canonicalJson(canonical.snapshot)
      )
        fail("MODEL_ROUTE_CONFLICT");
      return verified;
    });
  }

  async get(
    scope: PlatformScope,
    routeRef: string,
  ): Promise<CanonicalModelRouteSnapshot | null> {
    assertTrustedScope(scope);
    if (!/^mroute:v1:[a-f0-9]{64}$/.test(routeRef))
      fail("MODEL_ROUTE_REF_INVALID");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as CatalogExecutor;
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      const row = rowsOf(
        await tx.execute(sql`
        select tenant_id, route_ref, schema_version, agent_id, snapshot
        from enterprise_model_routes
        where tenant_id = ${scope.tenantId} and route_ref = ${routeRef}
      `),
      )[0];
      return row ? verifyRow(scope.tenantId, routeRef, row) : null;
    });
  }
}
