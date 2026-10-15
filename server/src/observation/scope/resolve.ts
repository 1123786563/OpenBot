import type {
  ObservationScopeAdapter,
  ObservationScopeRequest,
  ObservationScopeResolution,
} from "./contracts";

export type ObservationScopeAdapters = {
  /** 首期唯一实现：工作台部署级命名空间。 */
  readonly workbench?: ObservationScopeAdapter;
  /** 企业 adapter 待企业租户 Spec 批准后注册。 */
  readonly enterprise?: ObservationScopeAdapter;
};

const unauthorized: ObservationScopeResolution = { ok: false, reason: "unauthorized" };
const unknownEnterprise: ObservationScopeResolution = {
  ok: false,
  reason: "unknown-enterprise-scope",
};

/**
 * 按来源分发到对应 adapter。企业来源 fail-closed：缺失、未知、未配置或
 * adapter 解析不出企业 scope 时一律拒绝，绝不回退到工作台范围（spec §5）。
 */
export function createObservationScopeResolver(adapters: ObservationScopeAdapters) {
  return {
    async resolve(request: ObservationScopeRequest): Promise<ObservationScopeResolution> {
      if (request.origin.source === "workbench") {
        return adapters.workbench?.resolveScope(request) ?? unauthorized;
      }

      const adapter = adapters.enterprise;
      if (!adapter || adapter.kind !== "enterprise") return unknownEnterprise;

      const resolved = await adapter.resolveScope(request);
      if (!resolved.ok) return resolved;
      // 解析结果必须是企业 scope；企业入口里混入工作台 scope 视为未配置。
      return resolved.scope.kind === "enterprise" ? resolved : unknownEnterprise;
    },
  };
}
