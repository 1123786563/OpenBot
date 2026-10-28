// server/src/enterprise/authz/public.ts
// MOD04（Issue #624，根 #620）：M02 Access 的业务门面（A02 原位出口）。
//
// 三个能力，全部是**薄委托**——内件（tenancy/store.ts、authz/service.ts、
// tenancy/resource-policy.ts、tenancy/scope-gate.ts）零改动，判定/事务/锁序
// 语义逐字节不动：
//
//   resolveContext(request)
//     → createScopeResolver（tenancy/store.ts）签发半边的 resolve 本体：
//       服务端成员事实判定 + 受信 Scope 签发（WeakSet 信任标记 + freeze）。
//       选择器（tenant/workspace）只做选择，判定只依赖服务端事实。
//   authorizeAction(input)
//     → 三条既有判定入口，按 input.kind 一一对应：
//       · "check"    → createAuthz().check（authz/service.ts）：
//                       调用方已集齐的 AuthorizedResourceFacts 上的本地判定；
//       · "decide"   → ResourcePolicy DecisionService.decide
//                       （tenancy/resource-policy.ts）：受信 Scope + resourceId，
//                       事务内读判定事实后注册表求值（DB 路径）；
//       · "evaluate" → ResourcePolicyRegistry.evaluate：调用方经只读事实
//                       Adapter 集齐 ResourcePolicyFacts 后的纯注册表求值
//                       （interface-contracts C02 ResourceFacts 形状，无 DB）。
//   runInScope(scope, operation)
//     → createWorkspaceGate(...).transaction（tenancy/scope-gate.ts）**原方法
//       本体**（迁移期先封装不换协议，C01）：assertTrustedScope → read
//       committed + lock/statement timeout → set_config('app.*', …, true) →
//       advisory 共享锁（tenant → principal → membership →
//       workspace-membership）→ 公司/团队两级成员重验 → operation。
//       SCOPE_REVOKED / WORKSPACE_REVOKED 语义逐字节不动。
//
// 边界（Issue #624）：
//   - changeGrant（授权变更能力）不在本票：本门面无任何写方法（验收 4，
//     identity-access-public.test.ts 结构断言钉死）。
//   - M02 组内 import 自由、可 import M01；本文件实际只 import M02 组内文件，
//     跨组事实保持构造注入（与 M01 门面同一纪律）。
//   - 不做整目录 re-export：消费面 = 上述三能力 + 其输入/结果形状。

import type { PlatformScope, ScopeResolver } from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import {
  createShippedResourcePolicyRegistry,
  type ResourcePolicyDecisionService,
  type ResourcePolicyFacts,
  type ResourcePolicyRegistry,
  type ResourcePolicyVerdict,
} from "../tenancy/resource-policy";
import type { WorkspaceGate } from "../tenancy/scope-gate";
import {
  type AuthorizationInput,
  type AuthorizedResourceFacts,
  type Authz,
  createAuthz,
} from "./service";

// ---------------------------------------------------------------------------
// 输入/结果形状
// ---------------------------------------------------------------------------

/**
 * runInScope 的业务事务句柄：与 createWorkspaceGate(...).transaction 的
 * operation 参数同一类型（同连接事务，迁移期不换协议）。
 */
export type ScopedTransaction = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

/** 对象动作核验输入：三条既有判定入口的逐一对映。 */
export type AuthorizeActionInput =
  /** authz/service.ts createAuthz().check 的原签名（本地事实判定）。 */
  | {
      readonly kind: "check";
      readonly scope: PlatformScope;
      readonly resource: AuthorizedResourceFacts;
      readonly action: AuthorizationInput["action"];
    }
  /** resource-policy.ts DecisionService.decide 的原签名（事务内读事实）。 */
  | {
      readonly kind: "decide";
      readonly scope: PlatformScope;
      readonly resourceId: string;
      readonly policyVersion?: string;
    }
  /** resource-policy.ts Registry.evaluate 的原签名（纯事实求值，无 DB）。 */
  | {
      readonly kind: "evaluate";
      readonly facts: ResourcePolicyFacts;
      readonly policyVersion: string;
    };

/**
 * 对象动作核验结果：与各内件原返回逐字节同形——"check" → boolean，
 * "decide"/"evaluate" → ResourcePolicyVerdict（allow / deny{RESOURCE_NOT_FOUND}）。
 */
export type AuthorizeActionResult = boolean | ResourcePolicyVerdict;

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M02 Access 公开门面（本票能力面：解析/核验/事务重验，无授权变更）。 */
export interface Access {
  /** 解析可信业务上下文：委托签发半边（createScopeResolver 产物）resolve。 */
  resolveContext(request: Request): Promise<PlatformScope>;
  /** 对象动作核验：委托既有判定（check / decide / evaluate 三选一）。 */
  authorizeAction(input: AuthorizeActionInput): Promise<AuthorizeActionResult>;
  /** 事务重验：委托 createWorkspaceGate(...).transaction 原方法本体。 */
  runInScope<T>(
    scope: PlatformScope,
    operation: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T>;
}

/** 门面构造依赖：全部为 M02 既有工厂的产物（装配层构造后注入）。 */
export interface AccessDeps {
  /** 签发半边：createScopeResolver(directory, options) 的产物。 */
  readonly resolver: ScopeResolver;
  /** 事务重验半边：createWorkspaceGate(data) 的产物；runInScope 委托其本体。 */
  readonly gate: WorkspaceGate;
  /** 资源读取判定：createResourcePolicyService(data[, registry]) 的产物。 */
  readonly resourcePolicy: Pick<ResourcePolicyDecisionService, "decide">;
  /** 本地判定（缺省即时 createAuthz()——纯函数、无状态、零配置）。 */
  readonly authz?: Authz;
  /** 策略版本注册表（缺省 = 已发布版本套件 createShippedResourcePolicyRegistry）。 */
  readonly policyRegistry?: ResourcePolicyRegistry;
}

/**
 * 构造 M02 门面。零新策略、零缓存、零写入：每个能力逐项委托 deps 中的既有
 * 内件实例（判定、锁序、撤权与审计合同全部留在内件，逐字节不动）。
 */
export function createAccess(deps: AccessDeps): Access {
  const authz = deps.authz ?? createAuthz();
  const policyRegistry =
    deps.policyRegistry ?? createShippedResourcePolicyRegistry();
  const { resolver, gate, resourcePolicy } = deps;
  return {
    async resolveContext(request) {
      return resolver.resolve(request);
    },
    async authorizeAction(input) {
      if (input.kind === "check") {
        return authz.check({
          scope: input.scope,
          resource: input.resource,
          action: input.action,
        });
      }
      if (input.kind === "decide") {
        return resourcePolicy.decide(input.scope, input.resourceId, {
          policyVersion: input.policyVersion,
        });
      }
      return policyRegistry.evaluate(input.policyVersion, input.facts);
    },
    runInScope(scope, operation) {
      return gate.transaction(scope, operation);
    },
  };
}
