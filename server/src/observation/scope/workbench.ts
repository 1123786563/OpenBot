import { createHash } from "node:crypto";
import type {
  ObservationScopeAdapter,
  ObservationScopeResolution,
} from "./contracts";

export type WorkbenchScopeOptions = {
  /** 部署级命名名。同一部署稳定即可，默认 default。 */
  readonly deploymentNamespace?: string;
};

/**
 * 工作台 adapter：部署级命名空间，所有已认证 actor 共享一个 scope。
 * scopeKey 不透明且无租户语义；Bot 级归属授权在资源层复用现有规则，
 * scope 本身不承载“谁能看哪个 Bot”的答案。
 */
export function createWorkbenchScopeAdapter(
  options: WorkbenchScopeOptions = {},
): ObservationScopeAdapter {
  const namespace = options.deploymentNamespace ?? "default";
  const scopeKey = `wb_${createHash("sha256")
    .update(`workbench:${namespace}`)
    .digest("hex")
    .slice(0, 16)}`;

  return {
    kind: "workbench",
    async resolveScope(request): Promise<ObservationScopeResolution> {
      // 最低防线：没有真实服务端 actor 一律拒绝，防止装配遗漏时静默放行。
      if (!request.actor.id || !request.actor.role) {
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: true, scope: { kind: "workbench", scopeKey } };
    },
  };
}
