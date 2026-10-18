import type { AuthenticatedActor } from "../../auth/guards";

/**
 * 一个已授权的观测范围（spec §5 首期合同）。
 *
 * scopeKey 是服务端生成的内部不透明键，只用来给观测记录、游标、缓存、导出与评测任务
 * 划命名空间，不具有企业租户语义。浏览器、模型、AG-UI state 或 forwardedProps 提供的
 * scope 字符串永远不能构造成 ObservationScope；唯一入口是 adapter 的 resolveScope。
 */
export type ObservationScope = {
  readonly kind: "workbench" | "enterprise";
  readonly scopeKey: string;
};

/** 观测动作。企业 adapter 可按动作与资源决定授权；工作台首期不区分。 */
export type ObservationAction =
  | "view-runs"
  | "view-evaluations"
  | "manage-datasets"
  | "run-evaluations"
  | "export"
  | "manage-settings";

/**
 * 调用来源。只有服务端代码构造：工作台请求，或已认证的企业入口。
 * 企业来源必须携带该入口自己校验过的 scope 标识，且解析不到时拒绝访问，
 * 不能回退到工作台范围。
 */
export type ObservationOrigin =
  | { readonly source: "workbench" }
  | { readonly source: "enterprise"; readonly enterpriseScopeId: string };

export type ObservationScopeRequest = {
  /** 已认证的服务端 actor；不信任客户端自带身份。 */
  readonly actor: AuthenticatedActor;
  readonly origin: ObservationOrigin;
  readonly action: ObservationAction;
  /** 动作针对的 Bot。资源级授权由 adapter 决定，调用者说了不算。 */
  readonly botId?: string;
};

export type ObservationScopeFailure =
  /** 主体、资源或动作未获授权。 */
  | "unauthorized"
  /** 企业 scope 缺失、未知或未配置；fail-closed，绝不回退到工作台。 */
  | "unknown-enterprise-scope";

export type ObservationScopeResolution =
  | { readonly ok: true; readonly scope: ObservationScope }
  | { readonly ok: false; readonly reason: ObservationScopeFailure };

/**
 * 可替换的范围解析 seam：首期只有工作台 adapter；企业 adapter 待租户 Spec
 * 批准后注册，不需要改动调用方。
 */
export interface ObservationScopeAdapter {
  readonly kind: "workbench" | "enterprise";
  resolveScope(request: ObservationScopeRequest): Promise<ObservationScopeResolution>;
}

/** 把本地键（游标、缓存键、任务 ID）绑进 scope 命名空间。 */
export function namespacedObservationKey(
  scope: ObservationScope,
  localKey: string,
): string {
  return `${scope.scopeKey}:${localKey}`;
}

/** 验证一个已命名空间的键属于该 scope；跨 scope 串用游标/缓存/任务时返回 false。 */
export function observationKeyBelongsToScope(
  scope: ObservationScope,
  namespacedKey: string,
): boolean {
  return namespacedKey.startsWith(`${scope.scopeKey}:`);
}
