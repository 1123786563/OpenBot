import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "../../../tests/support/e2e-compat";
import type { Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  canonicalizeExpertDefinition,
  type ExpertDefinitionV1,
  ExpertVersionCatalog,
} from "../../src/enterprise/experts/version-catalog";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

const capabilityCheck = {
  current_user_matches: true,
  capability_attributes_ok: true,
  login_attributes_ok: true,
  login_has_expected_capability: true,
  capability_has_no_escalation_membership: true,
  login_has_no_other_memberships: true,
  no_protected_ownership: true,
  login_has_no_enterprise_privileges: true,
};

const forgedScope: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  actorId: "actor-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

async function trustedScope(): Promise<PlatformScope> {
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: "tenant-a",
                principalId: "principal-a",
                tenantStatus: "active",
                // The two scope resolvers read different halves of this one
                // canned row (store.ts:285 workspaceStatus, store.ts:952 the
                // bare team-membership status); carry all of them.
                workspaceStatus: "active",
                status: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
              },
            ],
          };
          return query;
        },
      }),
  } as unknown as Database;
  const directory = await verifyDirectoryDatabase(database);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    selectTenant: () => "tenant-a",
    selectWorkspace: () => "workspace-a",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

type CatalogExecutor = (
  statement: SQL,
  transaction: number,
  index: number,
) => unknown;

async function catalogWithExecutor(execute: CatalogExecutor) {
  let transactionCount = 0;
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transactionCount += 1;
      const transaction = transactionCount;
      let index = 0;
      return operation({
        execute: async (statement: SQL) =>
          execute(statement, transaction, index++),
      });
    },
  } as unknown as Database;
  const verified = await verifyDataDatabase(database);
  const catalog = new ExpertVersionCatalog(verified) as ExpertVersionCatalog & {
    readonly transactionCount: number;
  };
  Object.defineProperty(catalog, "transactionCount", {
    get: () => transactionCount,
  });
  return catalog;
}

function compiled(statement: SQL) {
  return new PgDialect().sqlToQuery(statement);
}

function storedRow(tenantId: string, definitionValue: ExpertDefinitionV1) {
  const canonical = canonicalizeExpertDefinition(tenantId, definitionValue);
  return {
    tenant_id: tenantId,
    expert_version_ref: canonical.expertVersionRef,
    schema_version: 1,
    agent_id: canonical.agentId,
    snapshot: canonical.definition,
  };
}

function definition(): ExpertDefinitionV1 {
  return {
    schemaVersion: 1,
    agentId: "bot-a",
    source: "user_profile",
    agentType: "built_in",
    systemPrompt: "Follow the registered Bot instructions.",
    behaviorVersion: "openbot-builtin-v1",
  };
}

describe("Expert version catalog", () => {
  it("derives stable tenant-bound content references", () => {
    const first = canonicalizeExpertDefinition("tenant-a", definition());
    const reordered = canonicalizeExpertDefinition("tenant-a", {
      behaviorVersion: "openbot-builtin-v1",
      systemPrompt: "Follow the registered Bot instructions.",
      agentType: "built_in",
      source: "user_profile",
      agentId: "bot-a",
      schemaVersion: 1,
    });
    expect(first).toEqual(reordered);
    expect(first.expertVersionRef).toMatch(/^expert:v1:[a-f0-9]{64}$/);
    expect(first.expertVersionRef).not.toBe(
      canonicalizeExpertDefinition("tenant-b", definition()).expertVersionRef,
    );
  });

  it.each([
    { systemPrompt: "changed" },
    { agentId: "bot-b" },
    { source: "team_bot" },
    { behaviorVersion: "openbot-builtin-v2" },
  ])("changes identity when executable definition changes: %o", (change) => {
    expect(
      canonicalizeExpertDefinition("tenant-a", definition()).expertVersionRef,
    ).not.toBe(
      canonicalizeExpertDefinition("tenant-a", {
        ...definition(),
        ...change,
      }).expertVersionRef,
    );
  });

  it.each([
    { ...definition(), displayName: "Bot" },
    { ...definition(), schemaVersion: 2 },
    { ...definition(), agentType: "remote" },
    { ...definition(), systemPrompt: "  " },
  ])("rejects noncanonical or unsupported definition: %o", (invalid) => {
    expect(() => canonicalizeExpertDefinition("tenant-a", invalid)).toThrow();
  });

  it("inserts through the verified data capability after tenant context", async () => {
    const statements: SQL[] = [];
    const row = storedRow("tenant-a", definition());
    const catalog = await catalogWithExecutor((statement) => {
      statements.push(statement);
      return compiled(statement).sql.toLowerCase().includes("insert into")
        ? [row]
        : [];
    });
    const scope = await trustedScope();
    const ref = await catalog.putOrGet(scope, definition());
    const queries = statements.map(compiled);

    expect(ref).toBe(row.expert_version_ref);
    expect(catalog.transactionCount).toBe(1);
    expect(queries[0].sql).toContain("set_config('app.tenant_id'");
    expect(queries[0].params).toContain(scope.tenantId);
    expect(queries[1].sql.toLowerCase()).toContain(
      "insert into enterprise_expert_versions",
    );
    expect(queries[1].sql).toContain("on conflict");
    expect(queries[1].params).toContain(scope.tenantId);
    expect(queries[1].params).toContain(ref);
  });

  it("returns an exact conflict row and rejects altered payload or metadata", async () => {
    const row = storedRow("tenant-a", definition());
    let selected: unknown = row;
    const catalog = await catalogWithExecutor(
      (statement, _transaction, index) => {
        const query = compiled(statement).sql.toLowerCase();
        if (query.includes("insert into")) return [];
        return query.includes("from enterprise_expert_versions") && index === 2
          ? selected
            ? [selected]
            : []
          : [];
      },
    );
    const scope = await trustedScope();

    await expect(catalog.putOrGet(scope, definition())).resolves.toBe(
      row.expert_version_ref,
    );
    selected = {
      ...row,
      snapshot: { ...row.snapshot, systemPrompt: "altered" },
    };
    await expect(catalog.putOrGet(scope, definition())).rejects.toThrow(
      "EXPERT_VERSION_CONFLICT",
    );
    selected = { ...row, agent_id: "other-agent" };
    await expect(catalog.putOrGet(scope, definition())).rejects.toThrow(
      "EXPERT_VERSION_CONFLICT",
    );
    selected = null;
    await expect(catalog.putOrGet(scope, definition())).rejects.toThrow(
      "EXPERT_VERSION_CONFLICT",
    );
  });

  it("resolves stored rows, returns null for missing rows, and rejects corruption", async () => {
    const row = storedRow("tenant-a", definition());
    let selected: unknown = row;
    const catalog = await catalogWithExecutor((statement) => {
      const query = compiled(statement).sql.toLowerCase();
      return query.includes("from enterprise_expert_versions") && selected
        ? [selected]
        : [];
    });
    const scope = await trustedScope();

    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).resolves.toEqual(row.snapshot);
    selected = null;
    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).resolves.toBeNull();
    selected = { ...row, tenant_id: "tenant-b" };
    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).rejects.toThrow("EXPERT_VERSION_CORRUPT");
    selected = {
      ...row,
      snapshot: { ...row.snapshot, behaviorVersion: "tampered" },
    };
    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).rejects.toThrow("EXPERT_VERSION_CORRUPT");
    // Rows may store the snapshot as a JSON string; parsing it must restore
    // the definition, and an unparseable string is row corruption, not an
    // invalid expert definition.
    selected = { ...row, snapshot: JSON.stringify(row.snapshot) };
    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).resolves.toEqual(row.snapshot);
    selected = { ...row, snapshot: "{not-json" };
    await expect(
      catalog.resolve(scope, row.expert_version_ref as never),
    ).rejects.toThrow("EXPERT_VERSION_CORRUPT");
  });

  it("keeps cross-tenant references isolated and rejects invalid scopes and refs", async () => {
    const statements: SQL[] = [];
    const catalog = await catalogWithExecutor((statement) => {
      statements.push(statement);
      return [];
    });
    const scope = await trustedScope();
    const otherTenantRef = storedRow(
      "tenant-b",
      definition(),
    ).expert_version_ref;

    await expect(catalog.resolve(scope, otherTenantRef)).resolves.toBeNull();
    const read = statements
      .map(compiled)
      .find((query) =>
        query.sql.toLowerCase().includes("from enterprise_expert_versions"),
      );
    expect(read?.sql).toMatch(
      /where tenant_id\s*=\s*\$\d+\s+and expert_version_ref\s*=/i,
    );
    expect(read?.params).toContain(scope.tenantId);
    expect(read?.params).toContain(otherTenantRef);
    const beforeForgedScope = catalog.transactionCount;
    await expect(catalog.resolve(forgedScope, otherTenantRef)).rejects.toThrow(
      "UNVERIFIED_SCOPE",
    );
    expect(catalog.transactionCount).toBe(beforeForgedScope);
    const beforeMalformedRef = catalog.transactionCount;
    await expect(
      catalog.resolve(scope, "invalid-ref" as never),
    ).rejects.toThrow("EXPERT_VERSION_REF_INVALID");
    expect(catalog.transactionCount).toBe(beforeMalformedRef);
    expect(catalog.transactionCount).toBe(1);
  });
});
