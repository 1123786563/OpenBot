import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

export type ExpertDefinitionV1 = Readonly<{
  schemaVersion: 1;
  agentId: string;
  source: "tenant_package" | "user_profile" | "team_bot";
  agentType: "built_in";
  systemPrompt: string;
  behaviorVersion: string;
}>;
export type ExpertVersionRef = string & {
  readonly __brand: "ExpertVersionRef";
};
export type CanonicalExpertDefinition = Readonly<{
  expertVersionRef: ExpertVersionRef;
  schemaVersion: 1;
  agentId: string;
  definition: ExpertDefinitionV1;
}>;

function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}
function boundedString(value: unknown, max: number, code: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    fail(code);
  return value;
}
function canonicalJson(definition: ExpertDefinitionV1): string {
  return JSON.stringify({
    schemaVersion: definition.schemaVersion,
    agentId: definition.agentId,
    source: definition.source,
    agentType: definition.agentType,
    systemPrompt: definition.systemPrompt,
    behaviorVersion: definition.behaviorVersion,
  });
}
function reference(
  tenantId: string,
  definition: ExpertDefinitionV1,
): ExpertVersionRef {
  const digest = createHash("sha256")
    .update("openbot:expert:v1\0", "utf8")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(definition), "utf8")
    .digest("hex");
  return `expert:v1:${digest}` as ExpertVersionRef;
}
export function canonicalizeExpertDefinition(
  tenantId: string,
  input: unknown,
): CanonicalExpertDefinition {
  if (typeof tenantId !== "string" || !tenantId || tenantId.includes("\0"))
    fail("EXPERT_TENANT_INVALID");
  if (!record(input)) fail("EXPERT_DEFINITION_INVALID");
  keys(
    input,
    [
      "schemaVersion",
      "agentId",
      "source",
      "agentType",
      "systemPrompt",
      "behaviorVersion",
    ],
    "EXPERT_DEFINITION_INVALID",
  );
  if (
    Object.keys(input).length !== 6 ||
    input.schemaVersion !== 1 ||
    input.agentType !== "built_in"
  )
    fail("EXPERT_DEFINITION_INVALID");
  if (
    input.source !== "tenant_package" &&
    input.source !== "user_profile" &&
    input.source !== "team_bot"
  )
    fail("EXPERT_DEFINITION_INVALID");
  const definition: ExpertDefinitionV1 = Object.freeze({
    schemaVersion: 1,
    agentId: boundedString(input.agentId, 512, "EXPERT_DEFINITION_INVALID"),
    source: input.source,
    agentType: "built_in",
    systemPrompt: boundedString(
      input.systemPrompt,
      100_000,
      "EXPERT_DEFINITION_INVALID",
    ).trim(),
    behaviorVersion: boundedString(
      input.behaviorVersion,
      128,
      "EXPERT_DEFINITION_INVALID",
    ),
  });
  return Object.freeze({
    expertVersionRef: reference(tenantId, definition),
    schemaVersion: 1,
    agentId: definition.agentId,
    definition,
  });
}
type Row = {
  tenant_id: string;
  expert_version_ref: string;
  schema_version: number;
  agent_id: string;
  snapshot: unknown;
};
type Executor = {
  execute(statement: ReturnType<typeof sql>): Promise<unknown>;
};
function rowsOf(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (record(value) && Array.isArray(value.rows)) return value.rows as Row[];
  // Unrecognized executor result shape is a contract regression, not an empty
  // result: fail closed instead of reporting a misleading conflict.
  throw new TypeError("EXPERT_VERSION_ROWS_INVALID");
}
function snapshotOf(row: Row): unknown {
  if (typeof row.snapshot !== "string") return row.snapshot;
  try {
    return JSON.parse(row.snapshot) as unknown;
  } catch (cause) {
    // Stored-row corruption is a row-integrity failure like the field
    // mismatches around it; the cause keeps the JSON.parse detail for triage.
    throw Object.assign(new Error("EXPERT_VERSION_CORRUPT"), { cause });
  }
}
function verify(
  tenantId: string,
  ref: string,
  row: Row,
): CanonicalExpertDefinition {
  if (
    row.tenant_id !== tenantId ||
    row.expert_version_ref !== ref ||
    row.schema_version !== 1
  )
    fail("EXPERT_VERSION_CORRUPT");
  const canonical = canonicalizeExpertDefinition(tenantId, snapshotOf(row));
  if (row.agent_id !== canonical.agentId || canonical.expertVersionRef !== ref)
    fail("EXPERT_VERSION_CORRUPT");
  return canonical;
}
export class ExpertVersionCatalog {
  constructor(private readonly database: DataDatabase) {
    assertDataDatabase(database);
  }
  async putOrGet(
    scope: PlatformScope,
    definition: ExpertDefinitionV1,
  ): Promise<ExpertVersionRef> {
    assertTrustedScope(scope);
    const canonical = canonicalizeExpertDefinition(scope.tenantId, definition);
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as Executor;
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      const inserted = rowsOf(
        await tx.execute(sql`
        insert into enterprise_expert_versions (tenant_id, expert_version_ref, schema_version, agent_id, snapshot)
        values (${scope.tenantId}, ${canonical.expertVersionRef}, 1, ${canonical.agentId}, ${JSON.stringify(canonical.definition)}::jsonb)
        on conflict (tenant_id, expert_version_ref) do nothing
        returning tenant_id, expert_version_ref, schema_version, agent_id, snapshot
      `),
      );
      if (inserted[0])
        return verify(scope.tenantId, canonical.expertVersionRef, inserted[0])
          .expertVersionRef;
      const existing = rowsOf(
        await tx.execute(sql`
        select tenant_id, expert_version_ref, schema_version, agent_id, snapshot
        from enterprise_expert_versions
        where tenant_id = ${scope.tenantId} and expert_version_ref = ${canonical.expertVersionRef}
      `),
      )[0];
      if (!existing) fail("EXPERT_VERSION_CONFLICT");
      let verified: CanonicalExpertDefinition;
      try {
        verified = verify(
          scope.tenantId,
          canonical.expertVersionRef,
          existing,
        );
      } catch (cause) {
        // The corrupt-row verification failure rides on cause so operators
        // can tell a drift conflict from a damaged catalog row (OCR R10).
        throw Object.assign(new Error("EXPERT_VERSION_CONFLICT"), { cause });
      }
      if (
        canonicalJson(verified.definition) !==
        canonicalJson(canonical.definition)
      )
        fail("EXPERT_VERSION_CONFLICT");
      return verified.expertVersionRef;
    });
  }
  async resolve(
    scope: PlatformScope,
    ref: ExpertVersionRef,
  ): Promise<ExpertDefinitionV1 | null> {
    assertTrustedScope(scope);
    if (typeof ref !== "string" || !/^expert:v1:[a-f0-9]{64}$/.test(ref))
      fail("EXPERT_VERSION_REF_INVALID");
    return this.database.transaction(async (transaction) => {
      const tx = transaction as unknown as Executor;
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      const row = rowsOf(
        await tx.execute(sql`
        select tenant_id, expert_version_ref, schema_version, agent_id, snapshot
        from enterprise_expert_versions
        where tenant_id = ${scope.tenantId} and expert_version_ref = ${ref}
      `),
      )[0];
      return row ? verify(scope.tenantId, ref, row).definition : null;
    });
  }

  /**
   * Re-verifies a stored Expert version on a caller-supplied transaction, so
   * Run admission can check the immutable row in the same transaction that
   * persists the Run and reserves its budget. Returns null when the ref has no
   * row under this tenant; corrupt rows fail closed exactly like `resolve`.
   */
  async resolveInTransaction(
    scope: PlatformScope,
    tx: Executor,
    ref: ExpertVersionRef,
  ): Promise<CanonicalExpertDefinition | null> {
    assertTrustedScope(scope);
    if (typeof ref !== "string" || !/^expert:v1:[a-f0-9]{64}$/.test(ref))
      fail("EXPERT_VERSION_REF_INVALID");
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    const row = rowsOf(
      await tx.execute(sql`
        select tenant_id, expert_version_ref, schema_version, agent_id, snapshot
        from enterprise_expert_versions
        where tenant_id = ${scope.tenantId} and expert_version_ref = ${ref}
      `),
    )[0];
    return row ? verify(scope.tenantId, ref, row) : null;
  }
}
