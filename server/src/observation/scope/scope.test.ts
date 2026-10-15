import { describe, expect, test } from "bun:test";
import type { AuthenticatedActor } from "../../auth/guards";
import {
  namespacedObservationKey,
  observationKeyBelongsToScope,
  type ObservationScopeAdapter,
  type ObservationScope,
} from "./contracts";
import { createObservationScopeResolver } from "./resolve";
import { createWorkbenchScopeAdapter } from "./workbench";

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "user@example.com",
  role: "user",
};

/** A12 的“测试 adapter”：证明 seam 可替换，也充当第二个 scope 的来源。 */
function createTestEnterpriseAdapter(scopeId: string): ObservationScopeAdapter {
  return {
    kind: "enterprise",
    async resolveScope(request) {
      const origin = request.origin;
      if (origin.source !== "enterprise" || origin.enterpriseScopeId !== scopeId) {
        return { ok: false, reason: "unknown-enterprise-scope" };
      }
      return { ok: true, scope: { kind: "enterprise", scopeKey: `ent_${scopeId}` } };
    },
  };
}

async function resolveScope(adapters: Parameters<typeof createObservationScopeResolver>[0], scope: ObservationScope) {
  // ponytail: 直接复用 resolver 入口构造两个 scope，避免测试自己绕过 seam。
  const resolver = createObservationScopeResolver(adapters);
  const request = {
    actor,
    origin:
      scope.kind === "workbench"
        ? { source: "workbench" as const }
        : { source: "enterprise" as const, enterpriseScopeId: scope.scopeKey.slice(4) },
    action: "view-runs" as const,
  };
  const result = await resolver.resolve(request);
  if (!result.ok) throw new Error(`expected scope, got ${result.reason}`);
  return result.scope;
}

describe("workbench observation scope", () => {
  test("resolves a stable deployment-level scope for any authenticated actor", async () => {
    const adapter = createWorkbenchScopeAdapter();
    const other: AuthenticatedActor = { ...actor, id: "user-2", role: "admin" };

    const a = await adapter.resolveScope({ actor, origin: { source: "workbench" }, action: "view-runs" });
    const b = await adapter.resolveScope({ actor: other, origin: { source: "workbench" }, action: "export" });

    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("expected both scopes to resolve");
    expect(a.scope.scopeKey).toBe(b.scope.scopeKey);
    expect(a.scope.scopeKey).toMatch(/^wb_[0-9a-f]+$/);
  });

  test("rejects requests without a real server-side actor", async () => {
    const adapter = createWorkbenchScopeAdapter();
    const result = await adapter.resolveScope({
      actor: { ...actor, id: "" },
      origin: { source: "workbench" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("different deployments get different scope keys", async () => {
    const one = createWorkbenchScopeAdapter({ deploymentNamespace: "one" });
    const two = createWorkbenchScopeAdapter({ deploymentNamespace: "two" });
    const a = await one.resolveScope({ actor, origin: { source: "workbench" }, action: "view-runs" });
    const b = await two.resolveScope({ actor, origin: { source: "workbench" }, action: "view-runs" });
    if (!a.ok || !b.ok) throw new Error("expected both scopes to resolve");
    expect(a.scope.scopeKey).not.toBe(b.scope.scopeKey);
    expect(a.scope.kind).toBe("workbench");
  });
});

describe("scope isolation (spec A12)", () => {
  test("same resource IDs under two scopes never share namespaced keys", async () => {
    const workbench = await resolveScope(
      { workbench: createWorkbenchScopeAdapter() },
      { kind: "workbench", scopeKey: "ignored" },
    );
    const enterprise = await resolveScope(
      {
        workbench: createWorkbenchScopeAdapter(),
        enterprise: createTestEnterpriseAdapter("acme"),
      },
      { kind: "enterprise", scopeKey: "ent_acme" },
    );

    // 相同资源 ID：运行、游标、缓存键、评测任务。
    const localKeys = ["run:r1", "cursor:abc", "cache:bot-1", "task:42"];
    for (const key of localKeys) {
      const inWorkbench = namespacedObservationKey(workbench, key);
      const inEnterprise = namespacedObservationKey(enterprise, key);
      expect(inWorkbench).not.toBe(inEnterprise);
      // 跨 scope 串用游标/缓存/任务时必须被识别为不属于当前 scope。
      expect(observationKeyBelongsToScope(workbench, inEnterprise)).toBe(false);
      expect(observationKeyBelongsToScope(enterprise, inWorkbench)).toBe(false);
      expect(observationKeyBelongsToScope(workbench, inWorkbench)).toBe(true);
    }
  });
});

describe("fail-closed enterprise scope (spec §5)", () => {
  test("enterprise origin without a registered enterprise adapter never falls back to workbench", async () => {
    const resolver = createObservationScopeResolver({
      workbench: createWorkbenchScopeAdapter(),
    });
    const result = await resolver.resolve({
      actor,
      origin: { source: "enterprise", enterpriseScopeId: "acme" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unknown-enterprise-scope" });
  });

  test("an adapter that is not an enterprise adapter is not used for enterprise origins", async () => {
    const resolver = createObservationScopeResolver({
      workbench: createWorkbenchScopeAdapter(),
      enterprise: createWorkbenchScopeAdapter(), // 装配错误：注册的是工作台 adapter
    });
    const result = await resolver.resolve({
      actor,
      origin: { source: "enterprise", enterpriseScopeId: "acme" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unknown-enterprise-scope" });
  });

  test("unknown enterprise scope id is rejected", async () => {
    const resolver = createObservationScopeResolver({
      enterprise: createTestEnterpriseAdapter("acme"),
    });
    const result = await resolver.resolve({
      actor,
      origin: { source: "enterprise", enterpriseScopeId: "globex" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unknown-enterprise-scope" });
  });

  test("a registered enterprise origin cannot smuggle a workbench scope back", async () => {
    // ponytail: enterprise adapter 返回工作台 scope 视为未配置，防装配串线。
    const resolver = createObservationScopeResolver({
      workbench: createWorkbenchScopeAdapter(),
      enterprise: {
        kind: "enterprise",
        async resolveScope() {
          const wb = createWorkbenchScopeAdapter();
          return wb.resolveScope({ actor, origin: { source: "workbench" }, action: "view-runs" });
        },
      },
    });
    const result = await resolver.resolve({
      actor,
      origin: { source: "enterprise", enterpriseScopeId: "acme" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unknown-enterprise-scope" });
  });

  test("workbench origin without a workbench adapter is unauthorized, not enterprise", async () => {
    const resolver = createObservationScopeResolver({
      enterprise: createTestEnterpriseAdapter("acme"),
    });
    const result = await resolver.resolve({
      actor,
      origin: { source: "workbench" },
      action: "view-runs",
    });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });
});
