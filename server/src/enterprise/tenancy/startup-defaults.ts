// MT123（Issue #166）：启动装配净化域。
//
// 启动流程此前无条件保留三类部署级默认状态：
//
//   1. 默认公司 —— `config.deploymentId ?? tenantPackage.tenantId`：租户包的
//      tenantId 充当部署身份回退，成为进程范围的隐式"当前公司"（线程指纹、
//      计费客户键等部署派生键全部从它出发）。Spec §2：租户相关业务状态需按
//      公司/团队解析，不能保留部署范围的隐式当前公司。
//   2. 默认线程标识 —— `createThreadIdentity(部署默认公司)`：进程级单例，
//      全部 legacy mint 调用点共用一枚部署指纹。
//   3. 单用户绕过 —— OPENBOT_SINGLE_USER / OPENBOT_DEV_NO_AUTH 的 dev actor
//      种子与免认证 guard。
//
// 净化裁决（多租户模式）：
//
//   - 默认公司不存在：租户包 tenantId 不再充当隐式当前公司。显式 DEPLOYMENT_ID
//     只是部署命名（线程指纹区分部署所必需，与公司无关），不是公司身份；缺它
//     时线程身份一律 per-scope 派生，绝不落部署默认公司。
//   - 默认线程标识不装配：进程级种子仅剩显式 DEPLOYMENT_ID 一种来源；业务
//     线程身份由 `scopeThreadIdentity` 从 MT122 entry context 的作用域工厂
//     取得（`requireEntryBusiness(...).runtimeConfig()` 的 threadIdentitySeed
//     ← MT014 按 (tenantId, workspaceId) 确定性派生）——per-scope，永不读
//     进程全局。
//   - 单用户/开发绕过不装配：dev actor 不种子、dev guard 不挂载；config 与
//     env 双面残留进入就绪校验（判定口径与 MT013 evaluateDevBypassResidue
//     一致：显式关闭不算残留）。
//
// 单租户模式：三类默认状态原样保留（回归——解析输出与 legacy 启动表达式
// 逐字节同义；`devBypassMounted` 照旧跟随 `config.singleUser`）。开关关闭时
// 本模块对装配面零行为影响。
//
// 装配就绪校验（与 MT013 同纪律）：多租户模式下装配缺口逐项列全、一次
// 报齐——MT122 entry context 工厂缺席；显式 DEPLOYMENT_ID 缺席（否则线程
// 种子会落回租户包默认公司）；singleUser 开启；绕过 env 残留。verdict 拒绝
// 即以非 0 退出——带着缺口上线不是一个可选项。
//
// 输出契约：`resolveStartupDefaults` 的结果深冻结——净化域自身不引入任何
// 可变"当前公司/团队"载体的落点。

import { getLogger } from "../../../../shared/logger";
import {
  createThreadIdentity,
  type ThreadIdentity,
} from "../../channels/thread-identity";
import type { ResolvedRuntimeConfig } from "./runtime-config";

/** 启动装配事实（index.ts 从 config/env/装配结果提供；测试可任意注入）。 */
export interface StartupDefaultsFacts {
  /** OPENBOT_MULTITENANCY 的解析结果（config.multitenancy.enabled）。 */
  readonly multitenancy: boolean;
  /** 显式部署命名（DEPLOYMENT_ID）；是部署事实，不是公司身份。 */
  readonly deploymentId?: string;
  /** 租户包的 tenantId——单租户默认公司的既有来源；多租户下不再是。 */
  readonly tenantPackageTenantId?: string;
  /** config.singleUser：单用户绕过是否被 config 接受。 */
  readonly singleUser: boolean;
  /** OPENBOT_SINGLE_USER 原始值（残留判定用，与 MT013 同口径）。 */
  readonly singleUserEnvRaw?: string;
  /** OPENBOT_DEV_NO_AUTH 原始值（更名的旧名）。 */
  readonly devNoAuthEnvRaw?: string;
  /** MT122 部署入口上下文工厂是否已接入装配（index.ts enterpriseCapabilities.entry）。 */
  readonly entryContextWired: boolean;
}

/** 启动装配保留下来的默认状态（两种模式都深冻结）。 */
export interface StartupDefaults {
  readonly mode: "single-tenant" | "multitenancy";
  /**
   * 进程保留的部署范围默认公司。单租户：租户包 tenantId（legacy 回归）；
   * 多租户：恒为 null——不存在隐式当前公司。
   */
  readonly defaultCompanyTenantId: string | null;
  /**
   * 进程级线程身份种子。单租户：`deploymentId ?? 租户包 tenantId`（legacy
   * 回归）；多租户：仅显式 DEPLOYMENT_ID，缺它为 null（线程身份一律
   * per-scope 派生）。
   */
  readonly threadIdentitySeed: string | null;
  /** 单用户绕过是否装配（dev actor 种子 + dev guard）。多租户恒为 false。 */
  readonly devBypassMounted: boolean;
}

/** 一条就绪缺口：缺口源（config 字段/env 变量/装配面）与可审计说明。 */
export interface StartupDefaultsFinding {
  readonly source: string;
  readonly detail: string;
}

export type StartupAssemblyReadiness =
  | { readonly ok: true; readonly findings: readonly [] }
  | {
      readonly ok: false;
      readonly findings: readonly StartupDefaultsFinding[];
    };

/** 显式关闭（false/0/空/未设置）不算残留；其余任何值都是（MT013 同款）。 */
function residueValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return trimmed !== "false" && trimmed !== "0";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 单用户绕过的装配裁决（唯一规则源）：仅单租户且 config 接受时挂载；
 * 多租户模式恒不装配。dev actor 种子（index.ts 早期装配点，先于租户包
 * 加载）与 `resolveStartupDefaults` 的 devBypassMounted 都消费本函数——
 * 两个挂载点共用同一裁决，不会漂移。
 */
export function mountDevBypass(
  facts: Pick<StartupDefaultsFacts, "multitenancy" | "singleUser">,
): boolean {
  return !facts.multitenancy && facts.singleUser;
}

/**
 * 净化裁决：按模式解析启动装配允许保留的默认状态。纯函数——同一事实两次
 * 解析输出逐字段相同，入参不被突变，输出深冻结（净化域不引入可变当前
 * 公司/团队载体的落点）。
 */
export function resolveStartupDefaults(
  facts: StartupDefaultsFacts,
): StartupDefaults {
  if (!facts.multitenancy) {
    // 单租户回归：与 legacy 启动表达式逐字节同义
    // （createThreadIdentity(config.deploymentId ?? tenantPackage.tenantId)、
    // initializeDevActorUser(database, config.singleUser)）。
    return deepFreeze({
      mode: "single-tenant" as const,
      defaultCompanyTenantId: facts.tenantPackageTenantId ?? null,
      threadIdentitySeed:
        facts.deploymentId ?? facts.tenantPackageTenantId ?? null,
      devBypassMounted: mountDevBypass(facts),
    });
  }
  // 多租户净化：默认公司不存在；默认线程标识只认显式部署命名；单用户
  // 绕过恒不装配。
  return deepFreeze({
    mode: "multitenancy" as const,
    defaultCompanyTenantId: null,
    threadIdentitySeed: facts.deploymentId ?? null,
    devBypassMounted: false,
  });
}

/**
 * 装配就绪校验（与 MT013 同纪律：全部评估完才返回——缺口一次列全，而不是
 * 发现第一个就停）。单租户模式无就绪诉求：恒 ok，绕过开启与 env 残留都不
 * 阻断（那是单租户部署的既有行为）。
 */
export function evaluateStartupAssemblyReadiness(
  facts: StartupDefaultsFacts,
): StartupAssemblyReadiness {
  if (!facts.multitenancy) return { ok: true, findings: [] };
  const findings: StartupDefaultsFinding[] = [];
  if (!facts.entryContextWired) {
    findings.push({
      source: "assembly.entryContext",
      detail:
        "the MT122 deployment entry-context factory is not wired into the assembly — business requests in multitenancy mode have no way to establish a per-request context",
    });
  }
  if (!facts.deploymentId?.trim()) {
    findings.push({
      source: "config.deploymentId",
      detail:
        "DEPLOYMENT_ID is unset — multitenancy mode keeps no implicit deployment company, so the thread-identity seed must be named explicitly instead of falling back to the tenant package's tenantId",
    });
  }
  if (facts.singleUser) {
    findings.push({
      source: "config.singleUser",
      detail:
        "OPENBOT_SINGLE_USER (or its former name OPENBOT_DEV_NO_AUTH) admits every request as the development administrator; the purified assembly refuses to mount it in multitenancy mode",
    });
  }
  if (residueValue(facts.singleUserEnvRaw)) {
    findings.push({
      source: "OPENBOT_SINGLE_USER",
      detail: `set to "${facts.singleUserEnvRaw}" — unset it (or set false/0) before multitenancy mode can boot`,
    });
  }
  if (residueValue(facts.devNoAuthEnvRaw)) {
    findings.push({
      source: "OPENBOT_DEV_NO_AUTH",
      detail: `set to "${facts.devNoAuthEnvRaw}" — the former name of OPENBOT_SINGLE_USER; unset it before multitenancy mode can boot`,
    });
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, findings: [] };
}

/**
 * 多租户模式启动装配就绪校验（MT123）的结构化审计记录：恰好一条，可审计。
 */
export interface StartupDefaultsRecord {
  readonly type: "multitenancy-startup-defaults-validation";
  readonly mode: "on";
  readonly accepted: boolean;
  readonly timestamp: string;
  readonly checks: {
    /** 净化后的装配默认状态快照（深冻结）。 */
    readonly defaults: StartupDefaults;
    /** 就绪缺口（通过时为空数组）。 */
    readonly findings: readonly StartupDefaultsFinding[];
  };
}

/** 组装结构化审计记录（记录与退出分两步，才可单测——MT013 同款）。 */
export function buildStartupDefaultsRecord(
  defaults: StartupDefaults,
  readiness: StartupAssemblyReadiness,
): StartupDefaultsRecord {
  return {
    type: "multitenancy-startup-defaults-validation",
    mode: "on",
    accepted: readiness.ok,
    timestamp: new Date().toISOString(),
    checks: {
      defaults,
      findings: [...readiness.findings],
    },
  };
}

/**
 * verdict：把启动装配净化记录写进启动日志（恰好一条结构化记录，可审计），
 * 然后按结果放行或以非 0 退出拒绝启动。log/exit 可注入供单测断言。
 */
export function applyStartupDefaultsVerdict(
  record: StartupDefaultsRecord,
  hooks: {
    log?: Pick<ReturnType<typeof getLogger>, "info">;
    exit?: (code: number) => void;
  } = {},
): void {
  const log = hooks.log ?? getLogger("server");
  log.info(
    record,
    record.accepted
      ? "startup assembly defaults passed — booting in multitenancy mode with no default company, no default thread identity and no single-user bypass"
      : "startup assembly defaults validation failed — refusing to boot (see the findings in this record)",
  );
  if (!record.accepted) {
    if (hooks.exit) hooks.exit(1);
    else process.exit(1);
  }
}

/**
 * per-scope 线程身份（消费 MT122 entry-context 的落点）。
 *
 * 入参必须来自 MT122 部署入口上下文：`requireEntryBusiness(context)
 * .runtimeConfig()` 的解析结果——其 threadIdentitySeed 由 MT014 按
 * (tenantId, workspaceId) 确定性派生，不是公司可声明字段。多租户模式下这
 * 是线程身份唯一合法来源：身份随 scope 走（两家公司、同公司两个团队各得
 * 各的指纹），每次调用返回新实例——不存在进程级共享可变身份对象，也绝不
 * 读进程全局默认。
 */
export function scopeThreadIdentity(
  resolved: ResolvedRuntimeConfig,
): ThreadIdentity {
  return createThreadIdentity(resolved.threadIdentitySeed);
}
