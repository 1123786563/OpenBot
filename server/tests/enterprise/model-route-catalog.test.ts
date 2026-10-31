import { describe, expect, it } from "../../../tests/support/e2e-compat";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  canonicalizeModelRouteSnapshot,
  ModelRouteCatalogStore,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

const forgedScope: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  actorId: "actor-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};
const modelCapabilitySecret = "model-capability-test-secret-long-enough";
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
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
                status: "active",
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

async function storeWithExecutor(
  execute: (statement: SQL, transaction: number, index: number) => unknown,
): Promise<ModelRouteCatalogStore & { readonly transactionCount: number }> {
  let transaction = 0;
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transaction += 1;
      const currentTransaction = transaction;
      let index = 0;
      return operation({
        execute: async (statement: SQL) =>
          execute(statement, currentTransaction, index++),
      });
    },
  } as unknown as Database;
  const verifiedDatabase = await verifyDataDatabase(database);
  const store = new ModelRouteCatalogStore(
    verifiedDatabase,
    modelCapabilitySecret,
  );
  return Object.assign(store, {
    get transactionCount() {
      return transaction;
    },
  });
}

function compiled(statement: SQL) {
  return new PgDialect().sqlToQuery(statement);
}

function input(): ModelRouteSnapshotInput {
  return {
    agentId: "bot-a",
    route: {
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      credentialSecretRef: "credential-a",
    },
  };
}

describe("model route catalog", () => {
  it("canonicalizes stable safe identity and separates tenants", () => {
    const route = input();
    const first = canonicalizeModelRouteSnapshot(
      "tenant-a",
      route,
      modelCapabilitySecret,
    );
    const reordered = canonicalizeModelRouteSnapshot(
      "tenant-a",
      {
        route: {
          credentialSecretRef: route.route.credentialSecretRef,
          model: {
            defaultModel: route.route.model.defaultModel,
            provider: route.route.model.provider,
          },
        },
        agentId: route.agentId,
      },
      modelCapabilitySecret,
    );
    const otherTenant = canonicalizeModelRouteSnapshot(
      "tenant-b",
      input(),
      modelCapabilitySecret,
    );
    expect(first).toEqual(reordered);
    expect(first.routeRef).toMatch(/^mroute:v1:[a-f0-9]{64}$/);
    expect(first.routeRef).not.toBe(otherTenant.routeRef);
    expect(JSON.stringify(first.snapshot)).not.toContain("secret");
  });

  it.each([
    { schemaVersion: 2, agentId: "bot-a" },
    { schemaVersion: 1, agentId: "bot-a", token: "secret" },
    { schemaVersion: 1, agentId: "bot-a", extra: true },
  ])("rejects unsupported or unsafe snapshot data %#", (snapshot) => {
    expect(() =>
      canonicalizeModelRouteSnapshot(
        "tenant-a",
        {
          ...input(),
          route: { ...input().route, model: snapshot as never },
        },
        modelCapabilitySecret,
      ),
    ).toThrow();
  });

  it("rejects invalid model identity and mismatched plan Bot", () => {
    expect(() =>
      canonicalizeModelRouteSnapshot(
        "tenant-a",
        {
          ...input(),
          route: {
            ...input().route,
            model: { provider: "unknown", defaultModel: "x" } as never,
          },
        },
        modelCapabilitySecret,
      ),
    ).toThrow();
    expect(() =>
      canonicalizeModelRouteSnapshot(
        "tenant-a",
        {
          ...input(),
          route: { ...input().route, planBotId: "bot-b" },
        },
        modelCapabilitySecret,
      ),
    ).toThrow();
  });

  it("fingerprints normalized destinations without storing endpoints or tokens", () => {
    const first = canonicalizeModelRouteSnapshot(
      "tenant-a",
      {
        ...input(),
        nativeBaseUrl: "https://models.example/v1/",
        route: {
          ...input().route,
          model: {
            provider: "openai",
            defaultModel: "gpt-5.6-terra",
            plan: {
              provider: "chatgpt",
              endpoint: new URL("https://plan.example/run?tenant=a#route"),
              token: "live-plan-secret",
            },
          },
        },
      },
      modelCapabilitySecret,
    );
    const changedEndpoint = canonicalizeModelRouteSnapshot(
      "tenant-a",
      {
        ...input(),
        nativeBaseUrl: "https://models.example/v2/",
        route: {
          ...input().route,
          model: {
            provider: "openai",
            defaultModel: "gpt-5.6-terra",
            plan: {
              provider: "chatgpt",
              endpoint: new URL("https://plan.example/run?tenant=b#route"),
              token: "other-live-secret",
            },
          },
        },
      },
      modelCapabilitySecret,
    );
    expect(first.routeRef).not.toBe(changedEndpoint.routeRef);
    expect(JSON.stringify(first.snapshot)).not.toContain("plan.example");
    expect(JSON.stringify(first.snapshot)).not.toContain("live-plan-secret");
  });

  it("rejects an unverified database handle before retaining or using it", () => {
    let transactionCalled = false;
    const database = {
      transaction: () => {
        transactionCalled = true;
        throw new Error("unexpected_transaction");
      },
    };
    expect(
      () =>
        new ModelRouteCatalogStore(database as never, modelCapabilitySecret),
    ).toThrow("UNVERIFIED_DATABASE_CAPABILITY");
    expect(transactionCalled).toBe(false);
  });

  it("rejects forged scopes before canonicalization or transactions", async () => {
    const store = await storeWithExecutor(() => []);
    await expect(store.put(forgedScope, input())).rejects.toThrow(
      "UNVERIFIED_SCOPE",
    );
    await expect(
      store.get(forgedScope, `mroute:v1:${"1".repeat(64)}`),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    expect(store.transactionCount).toBe(0);
  });

  it("uses tenant-qualified predicates and compares immutable conflict rows", async () => {
    const statements: SQL[] = [];
    const store = await storeWithExecutor((statement) => {
      statements.push(statement);
      return [];
    });
    const scope = await trustedScope();
    await expect(store.put(scope, input())).rejects.toThrow(
      "MODEL_ROUTE_CONFLICT",
    );
    await expect(
      store.get(scope, `mroute:v1:${"1".repeat(64)}`),
    ).resolves.toBeNull();
    const catalogQueries = statements
      .map(compiled)
      .filter((query) => query.sql.includes("enterprise_model_routes"));
    const insertQuery = catalogQueries.find((query) =>
      query.sql.toLowerCase().includes("insert into enterprise_model_routes"),
    );
    const readQueries = catalogQueries.filter(
      (query) =>
        query.sql.toLowerCase().includes("select") &&
        query.sql.toLowerCase().includes("from enterprise_model_routes"),
    );
    expect(insertQuery?.sql).toMatch(/\(tenant_id,\s*route_ref/);
    expect(insertQuery?.params).toContain(scope.tenantId);
    expect(readQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of readQueries) {
      expect(query.sql).toMatch(
        /where tenant_id\s*=\s*\$\d+\s+and route_ref\s*=/i,
      );
      expect(query.params).toContain(scope.tenantId);
    }
  });

  it("fails closed for missing and corrupt catalog reads", async () => {
    const store = await storeWithExecutor((_statement, transaction, index) => {
      return transaction === 2 && index === 1
        ? [
            {
              tenant_id: "tenant-a",
              route_ref: `mroute:v1:${"0".repeat(64)}`,
              schema_version: 1,
              agent_id: "bot-a",
              snapshot: {
                schemaVersion: 1,
                agentId: "bot-a",
                provider: "openai",
              },
            },
          ]
        : [];
    });
    const scope = await trustedScope();
    await expect(
      store.get(scope, `mroute:v1:${"1".repeat(64)}`),
    ).resolves.toBeNull();
    await expect(
      store.get(scope, `mroute:v1:${"0".repeat(64)}`),
    ).rejects.toThrow("MODEL_ROUTE_CORRUPT");
  });

  it("accepts exact conflict rows and rejects mismatches", async () => {
    const canonical = canonicalizeModelRouteSnapshot(
      "tenant-a",
      input(),
      modelCapabilitySecret,
    );
    const row = {
      tenant_id: "tenant-a",
      route_ref: canonical.routeRef,
      schema_version: 1,
      agent_id: canonical.agentId,
      snapshot: canonical.snapshot,
    };
    let selected: unknown = row;
    const store = await storeWithExecutor((_statement, _transaction, index) =>
      index === 2 && selected ? [selected] : [],
    );
    const scope = await trustedScope();
    await expect(store.put(scope, input())).resolves.toEqual(canonical);
    selected = { ...row, agent_id: "different-agent" };
    await expect(store.put(scope, input())).rejects.toThrow(
      "MODEL_ROUTE_CONFLICT",
    );
  });
});

it("catalog_conflict_preserves_corrupt_cause", async () => {
  const canonical = canonicalizeModelRouteSnapshot(
    "tenant-a",
    input(),
    modelCapabilitySecret,
  );
  const row = {
    tenant_id: "tenant-a",
    route_ref: canonical.routeRef,
    schema_version: 1,
    agent_id: canonical.agentId,
    snapshot: canonical.snapshot,
  };
  const selected: unknown = { ...row, schema_version: 99 };
  const store = await storeWithExecutor((_statement, _transaction, index) =>
    index === 2 && selected ? [selected] : [],
  );
  const scope = await trustedScope();
  let conflict: unknown;
  try {
    await store.put(scope, input());
  } catch (error) {
    conflict = error;
  }
  expect((conflict as Error).message).toBe("MODEL_ROUTE_CONFLICT");
  // The corrupt-row verification failure rides on cause for diagnostics.
  expect((conflict as { cause?: unknown }).cause).toBeInstanceOf(Error);
  expect(((conflict as { cause?: Error }).cause as Error).message).not.toBe(
    "MODEL_ROUTE_CONFLICT",
  );
});
