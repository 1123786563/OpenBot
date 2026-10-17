import { describe, expect, it } from "../../../tests/support/e2e-compat";
import type { Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type CanonicalModelRouteSnapshot,
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { rebindModelRoute } from "../../src/enterprise/runs/model-route-rebind";
import { verifyDirectoryDatabase } from "../../src/enterprise/tenancy/connections";
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

function nativeAdmission(): ModelRouteSnapshotInput {
  return {
    agentId: "bot-a",
    route: {
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      credentialSecretRef: "credential-a",
    },
  };
}

function anthropicAdmission(): ModelRouteSnapshotInput {
  return {
    agentId: "bot-a",
    route: {
      model: { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
      credentialSecretRef: "credential-a",
    },
  };
}

function planAdmission(): ModelRouteSnapshotInput {
  return {
    agentId: "bot-a",
    route: {
      planBotId: "bot-a",
      model: {
        provider: "openai",
        defaultModel: "gpt-5.6-terra",
        plan: {
          provider: "chatgpt",
          endpoint: new URL("https://plan.example/run"),
          token: "admitted-plan-token",
        },
      },
      credentialSecretRef: "credential-a",
    },
  };
}

type FakeCatalogRow = {
  tenantId: string;
  canonical: CanonicalModelRouteSnapshot;
};

function fakeCatalog(rows: FakeCatalogRow[]) {
  const calls: Array<{ tenantId: string; routeRef: string }> = [];
  const catalog = {
    get: async (scope: PlatformScope, routeRef: string) => {
      calls.push({ tenantId: scope.tenantId, routeRef });
      const row = rows.find(
        (candidate) =>
          candidate.tenantId === scope.tenantId &&
          candidate.canonical.routeRef === routeRef,
      );
      return row ? row.canonical : null;
    },
  };
  return { catalog, calls };
}

function currentRouteSpy(result: ModelRouteSnapshotInput | null) {
  const agentIds: string[] = [];
  const currentRouteForAgent = async (agentId: string) => {
    agentIds.push(agentId);
    return result;
  };
  return { agentIds, currentRouteForAgent };
}

async function harness(options: {
  admitted?: ModelRouteSnapshotInput;
  current?: ModelRouteSnapshotInput | null;
  rows?: FakeCatalogRow[];
  routeRef?: string;
}) {
  const scope = await trustedScope();
  const admitted = options.admitted ?? nativeAdmission();
  const stored = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    admitted,
    modelCapabilitySecret,
  );
  const rows = options.rows ?? [
    { tenantId: scope.tenantId, canonical: stored },
  ];
  const { catalog, calls } = fakeCatalog(rows);
  const spy = currentRouteSpy(
    options.current === undefined ? admitted : options.current,
  );
  const routeRef = options.routeRef ?? stored.routeRef;
  const promise = rebindModelRoute({
    scope,
    routeRef,
    catalog,
    currentRouteForAgent: spy.currentRouteForAgent,
    modelCapabilitySecret,
  });
  return {
    scope,
    admitted,
    stored,
    rows,
    catalog,
    calls,
    spy,
    routeRef,
    promise,
  };
}

describe("model route rebinding", () => {
  it("rebinds an admitted native route to the identical current server route", async () => {
    const current = nativeAdmission();
    const { promise, spy, calls } = await harness({ current });
    await expect(promise).resolves.toEqual(current.route);
    expect(spy.agentIds).toEqual(["bot-a"]);
    expect(calls.length).toBe(1);
  });

  it("rebinds an admitted plan route and tolerates plan token rotation", async () => {
    const current = planAdmission();
    current.route.model.plan!.token = "rotated-plan-token";
    const { promise, spy } = await harness({
      admitted: planAdmission(),
      current,
    });
    await expect(promise).resolves.toEqual(current.route);
    expect(spy.agentIds).toEqual(["bot-a"]);
  });

  it("returns null without asking for a current route when the row is missing", async () => {
    const { promise, spy, calls } = await harness({ rows: [] });
    await expect(promise).resolves.toBeNull();
    expect(spy.agentIds).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("returns null when the current server route is unavailable", async () => {
    const { promise, spy } = await harness({ current: null });
    await expect(promise).resolves.toBeNull();
    expect(spy.agentIds).toEqual(["bot-a"]);
  });

  it("refuses a forged agent ID answered by the current-route callback", async () => {
    const current = { ...nativeAdmission(), agentId: "bot-b" };
    const { promise, spy } = await harness({ current });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_AGENT_MISMATCH");
    expect(spy.agentIds).toEqual(["bot-a"]);
  });

  it("cannot rebind another tenant's row or reference", async () => {
    const otherTenant = canonicalizeModelRouteSnapshot(
      "tenant-b",
      nativeAdmission(),
      modelCapabilitySecret,
    );
    const local = canonicalizeModelRouteSnapshot(
      "tenant-a",
      nativeAdmission(),
      modelCapabilitySecret,
    );
    expect(otherTenant.routeRef).not.toBe(local.routeRef);
    const { promise, calls } = await harness({
      rows: [{ tenantId: "tenant-b", canonical: otherTenant }],
      routeRef: otherTenant.routeRef,
    });
    await expect(promise).resolves.toBeNull();
    expect(calls).toEqual([
      { tenantId: "tenant-a", routeRef: otherTenant.routeRef },
    ]);
  });

  it("refuses provider drift such as a post-admission BOT_PROVIDER override", async () => {
    const current = anthropicAdmission();
    const { promise } = await harness({ current });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_DRIFT");
  });

  it("refuses default-model drift such as a post-admission BOT_MODEL override", async () => {
    const current = nativeAdmission();
    current.route.model.defaultModel = "gpt-5.6-sonnet";
    const { promise } = await harness({ current });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_DRIFT");
  });

  it("refuses credential-reference drift before any credential read", async () => {
    const current = nativeAdmission();
    current.route.credentialSecretRef = "credential-b";
    const { promise, spy, calls } = await harness({ current });
    let credentialReads = 0;
    const rebound = await promise.then(
      (route) => {
        credentialReads += 1;
        return route;
      },
      (error: Error) => error,
    );
    expect(credentialReads).toBe(0);
    expect(rebound).toBeInstanceOf(Error);
    expect((rebound as Error).message).toBe("MODEL_ROUTE_DRIFT");
    expect(spy.agentIds).toEqual(["bot-a"]);
    expect(calls.length).toBe(1);
  });

  it("refuses plan endpoint drift while provider and model match", async () => {
    const current = planAdmission();
    current.route.model.plan!.endpoint = new URL(
      "https://plan.example/different",
    );
    const { promise } = await harness({ current });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_DRIFT");
  });

  it("refuses plan presence drift in both directions", async () => {
    const withoutPlan = await harness({
      admitted: planAdmission(),
      current: nativeAdmission(),
    });
    await expect(withoutPlan.promise).rejects.toThrow("MODEL_ROUTE_DRIFT");
    const withPlan = await harness({
      admitted: nativeAdmission(),
      current: planAdmission(),
    });
    await expect(withPlan.promise).rejects.toThrow("MODEL_ROUTE_DRIFT");
  });

  it("refuses native base-URL drift for OpenAI in both directions", async () => {
    const customThenDefault = await harness({
      admitted: {
        ...nativeAdmission(),
        nativeBaseUrl: "https://models.example/v1",
      },
      current: nativeAdmission(),
    });
    await expect(customThenDefault.promise).rejects.toThrow(
      "MODEL_ROUTE_DRIFT",
    );
    const defaultThenCustom = await harness({
      admitted: nativeAdmission(),
      current: {
        ...nativeAdmission(),
        nativeBaseUrl: "https://proxy.example/v1",
      },
    });
    await expect(defaultThenCustom.promise).rejects.toThrow(
      "MODEL_ROUTE_DRIFT",
    );
  });

  it("refuses native base-URL drift for Anthropic in both directions", async () => {
    const customThenDefault = await harness({
      admitted: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic.example",
      },
      current: anthropicAdmission(),
    });
    await expect(customThenDefault.promise).rejects.toThrow(
      "MODEL_ROUTE_DRIFT",
    );
    const defaultThenCustom = await harness({
      admitted: anthropicAdmission(),
      current: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic-proxy.example",
      },
    });
    await expect(defaultThenCustom.promise).rejects.toThrow(
      "MODEL_ROUTE_DRIFT",
    );
  });

  it("accepts equivalent normalized Anthropic base URLs", async () => {
    const withVersion = await harness({
      admitted: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic.example",
      },
      current: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic.example/v1",
      },
    });
    await expect(withVersion.promise).resolves.toBeTruthy();
    const withTrailingSlash = await harness({
      admitted: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic.example/v1",
      },
      current: {
        ...anthropicAdmission(),
        nativeBaseUrl: "https://anthropic.example/",
      },
    });
    await expect(withTrailingSlash.promise).resolves.toBeTruthy();
  });

  it("rejects a forged scope before any catalog read", async () => {
    const scope = forgedScope;
    const stored = canonicalizeModelRouteSnapshot(
      scope.tenantId,
      nativeAdmission(),
      modelCapabilitySecret,
    );
    const { catalog, calls } = fakeCatalog([
      { tenantId: scope.tenantId, canonical: stored },
    ]);
    const spy = currentRouteSpy(nativeAdmission());
    await expect(
      rebindModelRoute({
        scope,
        routeRef: stored.routeRef,
        catalog,
        currentRouteForAgent: spy.currentRouteForAgent,
        modelCapabilitySecret,
      }),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    expect(calls).toEqual([]);
    expect(spy.agentIds).toEqual([]);
  });

  it("rejects an empty route reference before any catalog read", async () => {
    const { promise, calls } = await harness({ routeRef: "" });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_REF_INVALID");
    expect(calls).toEqual([]);
  });

  it("propagates catalog corruption as refusal", async () => {
    const scope = await trustedScope();
    const catalog = {
      get: async () => {
        throw new Error("MODEL_ROUTE_CORRUPT");
      },
    };
    const spy = currentRouteSpy(nativeAdmission());
    await expect(
      rebindModelRoute({
        scope,
        routeRef: `mroute:v1:${"1".repeat(64)}`,
        catalog,
        currentRouteForAgent: spy.currentRouteForAgent,
        modelCapabilitySecret,
      }),
    ).rejects.toThrow("MODEL_ROUTE_CORRUPT");
    expect(spy.agentIds).toEqual([]);
  });

  it("propagates an invalid current route as refusal", async () => {
    const invalid = {
      agentId: "bot-a",
      route: {
        model: { provider: "openai" },
        credentialSecretRef: "credential-a",
      },
    } as unknown as ModelRouteSnapshotInput;
    const { promise, spy } = await harness({ current: invalid });
    await expect(promise).rejects.toThrow("MODEL_ROUTE_MODEL_INVALID");
    expect(spy.agentIds).toEqual(["bot-a"]);
  });
});
