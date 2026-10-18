// server/src/enterprise/tenancy/routing-policy.ts
// MT077（Issue #120）：网络策略、能力开关、模型路由与模板按公司/团队
// 归属保存与生效；团队覆盖只收窄，不放大公司安全限制。
//
// 分层模型（MT014 runtime-config 的同款范式：公司基线 + 团队收窄覆盖 +
// 版本化存储 + 受限角色读取 + 归属派生缓存键）：
//
//   1. 公司治理策略文档（network / capabilities / modelRouting）是能力面
//      与安全底线；团队覆盖只能收窄——capability 覆盖只接受 false（把
//      开关关掉），network 覆盖的 egress mode 强度不得低于公司、rules
//      必须是公司规则清单的子集，路由覆盖必须是公司路由的子集且默认
//      路由落在有效面内。任何放大在 resolve 时响亮拒绝，绝不部分生效。
//   2. 平台模板目录是平台静态能力（MT075 分类，MT001 清单同源）：进程内
//      深冻结封闭清单，公司/团队面对它没有任何写路径。各范围安装的是
//      副本（enterprise_template_installs），模板更新只落本范围安装行，
//      结构上不可能回写平台目录（目录不是表，也没有任何语句引用它）。
//   3. 解析是纯函数：只依赖入参，绝不读取任何进程环境；输出深冻结，
//      缓存键由归属 + 版本确定性派生（MT014/MT015 缓存键规则）——策略
//      变更在下一个生效点立即可见，公司 A 的版本变化绝不移动公司 B 的
//      缓存键（无跨范围缓存污染）。
//   4. 读取路径经受限 ob_ent_data 角色 + 事务本地 app.tenant_id + RLS
//      （与 store.ts / resource-policy.ts / runtime-config.ts 同款事务
//      形状）；缺公司策略行是 GOVERNANCE_POLICY_NOT_FOUND——多租户模式
//      没有旧默认回退。安装写入经受限 ob_ent_operator 角色 + RLS，更新
//      另要求 app.workspace_id 上下文（行级收窄到该团队），并按安装行
//      revision 做乐观并发（CAS，杜绝丢失更新）。
//
// 拒绝消息只含代码、字段路径与索引，绝不回显任何值（egress 解析器的
// 错误文本内嵌规则值，一律不透传）。

import { and, eq, sql } from "drizzle-orm";
import {
  EGRESS_MODES,
  type EgressMode,
  type EgressRule,
  parseEgressRules,
} from "../../../../agent-computer/src/egress";
import {
  CAPABILITIES,
  type Capability,
  isCapability,
} from "../../admin/capabilities";
import {
  enterpriseGovernanceOverrides,
  enterpriseGovernancePolicies,
  enterpriseTemplateInstalls,
} from "../../db/schema/enterprise-governance-policy";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";

// ---------------------------------------------------------------------------
// 平台模板目录：平台静态能力，进程内深冻结封闭清单（无表、无写路径）
// ---------------------------------------------------------------------------

export interface PlatformTemplate {
  readonly ref: string;
  readonly title: string;
  readonly revision: number;
  readonly document: Readonly<Record<string, unknown>>;
}

const PLATFORM_TEMPLATE_ENTRIES: readonly PlatformTemplate[] = [
  {
    ref: "platform/welcome-playbook",
    title: "Welcome Playbook",
    revision: 3,
    document: {
      version: 3,
      sections: ["first-day", "tools", "escalation"],
      checklist: ["badge", "laptop", "accounts"],
    },
  },
  {
    ref: "platform/research-daily",
    title: "Research Daily",
    revision: 1,
    document: {
      version: 1,
      sections: ["scan", "digest"],
      schedule: "daily",
    },
  },
  {
    ref: "platform/support-triage",
    title: "Support Triage",
    revision: 2,
    document: {
      version: 2,
      sections: ["intake", "prioritize"],
      severityLevels: ["low", "normal", "high"],
    },
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const PLATFORM_TEMPLATES: readonly PlatformTemplate[] = deepFreeze(
  PLATFORM_TEMPLATE_ENTRIES,
);

/** Looks one template up in the platform catalog; unknown refs return null. */
export function findPlatformTemplate(
  templateRef: string,
): PlatformTemplate | null {
  const found = PLATFORM_TEMPLATES.find(
    (template) => template.ref === templateRef,
  );
  return found ?? null;
}

// ---------------------------------------------------------------------------
// 类型：公司治理策略与团队收窄覆盖
// ---------------------------------------------------------------------------

export type GovernanceEgressMode = EgressMode;
export type GovernanceEgressRule = EgressRule;

export interface CompanyGovernancePolicyDocument {
  network: {
    readonly mode: GovernanceEgressMode;
    readonly rules: readonly GovernanceEgressRule[];
  };
  /** 封闭能力集上的公司基线；每个开关都必须显式声明（无隐式默认）。 */
  capabilities: Readonly<Record<Capability, boolean>>;
  modelRouting: {
    readonly allowedRoutes: readonly string[];
    readonly defaultRoute: string;
  };
}

export interface TeamGovernanceOverridesDocument {
  network?: {
    readonly mode?: GovernanceEgressMode;
    readonly rules?: readonly GovernanceEgressRule[];
  };
  /** 覆盖值是布尔；true 是放大语义，resolve 时拒绝（CAPABILITY_OVERRIDE_WIDENS_POLICY）。 */
  capabilities?: Partial<Record<Capability, boolean>>;
  modelRouting?: {
    readonly allowedRoutes?: readonly string[];
    readonly defaultRoute?: string;
  };
}

export interface ResolvedGovernancePolicy {
  readonly scope: Readonly<{ tenantId: string; workspaceId: string }>;
  readonly revisions: Readonly<{
    company: number;
    override: number | null;
  }>;
  /** 缓存键含实际归属及策略版本（MT014/MT015 规则）。纯入参派生。 */
  readonly cacheKey: string;
  readonly network: Readonly<{
    readonly mode: GovernanceEgressMode;
    readonly rules: readonly GovernanceEgressRule[];
  }>;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly modelRouting: Readonly<{
    readonly allowedRoutes: readonly string[];
    readonly defaultRoute: string;
  }>;
}

// ---------------------------------------------------------------------------
// 拒绝：只含代码、字段路径与索引，绝不回显任何值（验收 2 专门测试钉死）
// ---------------------------------------------------------------------------

function failInvalid(path: string, rule: string): never {
  throw new Error(`GOVERNANCE_POLICY_INVALID: ${path} ${rule}`);
}

function failOverrideInvalid(path: string, rule: string): never {
  throw new Error(`GOVERNANCE_OVERRIDE_INVALID: ${path} ${rule}`);
}

// ---------------------------------------------------------------------------
// 文档解析：严格形状；未知键拒绝；egress 规则经真实解析器归一化
// ---------------------------------------------------------------------------

const ROUTE_REF_MAX = 200;
const EGRESS_RULES_MAX = 256;
const ROUTES_MAX = 256;
const INSTALL_DOCUMENT_MAX_SERIALIZED = 128 * 1024;

function objectAt(
  value: unknown,
  path: string,
  fail: (p: string, r: string) => never,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  fail: (p: string, r: string) => never,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a known field");
  }
}

function egressMode(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fail: (p: string, r: string) => never,
): GovernanceEgressMode {
  const value = source[key];
  if (
    typeof value !== "string" ||
    !(EGRESS_MODES as readonly string[]).includes(value)
  ) {
    fail(path, `must be one of ${EGRESS_MODES.join(", ")}`);
  }
  return value as GovernanceEgressMode;
}

/**
 * Parses an egress rule list through the shipped matcher's parser so the
 * company policy and the computer enforcement can never disagree about what
 * a rule means. Parser error text embeds rule values, so it is never
 * surfaced: failures collapse to path + index.
 */
function egressRules(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fail: (p: string, r: string) => never,
): GovernanceEgressRule[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > EGRESS_RULES_MAX) {
    fail(path, `must hold at most ${EGRESS_RULES_MAX} entries`);
  }
  const parsed = parseEgressRules(value);
  if (!parsed.ok) {
    fail(`${path} entry`, `at an offending index is not a valid egress rule`);
  }
  return parsed.rules;
}

function routeRef(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fail: (p: string, r: string) => never,
): string {
  const value = source[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > ROUTE_REF_MAX
  ) {
    fail(
      path,
      `must be a non-empty string of at most ${ROUTE_REF_MAX} characters`,
    );
  }
  return value;
}

function routeList(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fail: (p: string, r: string) => never,
): string[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > ROUTES_MAX) {
    fail(path, `must hold at most ${ROUTES_MAX} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = routeRef({ value: entry }, "value", `${path}[${index}]`, fail);
    if (seen.has(item)) fail(`${path}[${index}]`, "must not repeat an entry");
    seen.add(item);
    return item;
  });
}

/**
 * 解析公司治理策略文档。未知键、越界形状、能力开关缺项、路由面内部
 * 不一致（默认路由不在开放面内）一律响亮拒绝；消息只含字段路径与规则。
 */
export function parseCompanyGovernancePolicyDocument(
  value: unknown,
): CompanyGovernancePolicyDocument {
  const root = objectAt(value, "company", failInvalid);
  onlyKeys(
    root,
    ["network", "capabilities", "modelRouting"],
    "company",
    failInvalid,
  );

  const network = objectAt(root.network, "company.network", failInvalid);
  onlyKeys(network, ["mode", "rules"], "company.network", failInvalid);
  const mode = egressMode(network, "mode", "company.network.mode", failInvalid);
  const rules = egressRules(
    network,
    "rules",
    "company.network.rules",
    failInvalid,
  );

  const capabilities = objectAt(
    root.capabilities,
    "company.capabilities",
    failInvalid,
  );
  onlyKeys(
    capabilities,
    [...CAPABILITIES],
    "company.capabilities",
    failInvalid,
  );
  for (const capability of CAPABILITIES) {
    const declared = capabilities[capability];
    if (typeof declared !== "boolean") {
      failInvalid(
        `company.capabilities.${capability}`,
        "must be a boolean — the company baseline declares every switch",
      );
    }
  }
  const capabilityBaseline = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, capabilities[capability]]),
  ) as Record<Capability, boolean>;

  const modelRouting = objectAt(
    root.modelRouting,
    "company.modelRouting",
    failInvalid,
  );
  onlyKeys(
    modelRouting,
    ["allowedRoutes", "defaultRoute"],
    "company.modelRouting",
    failInvalid,
  );
  const allowedRoutes = routeList(
    modelRouting,
    "allowedRoutes",
    "company.modelRouting.allowedRoutes",
    failInvalid,
  );
  if (allowedRoutes.length < 1) {
    failInvalid(
      "company.modelRouting.allowedRoutes",
      "must offer at least one route",
    );
  }
  const defaultRoute = routeRef(
    modelRouting,
    "defaultRoute",
    "company.modelRouting.defaultRoute",
    failInvalid,
  );
  if (!allowedRoutes.includes(defaultRoute)) {
    failInvalid(
      "company.modelRouting.defaultRoute",
      "must be one of company.modelRouting.allowedRoutes",
    );
  }

  return {
    network: { mode, rules },
    capabilities: capabilityBaseline,
    modelRouting: { allowedRoutes, defaultRoute },
  };
}

/**
 * 解析团队覆盖文档。只接受收窄字段：unknown 键一律拒绝；capability
 * 覆盖只接受 false 布尔值（true 连形状都没有语义——那是公司管理动作）；
 * 语义层的放大检查（mode 强度、规则/路由子集）在 resolve 时对照公司
 * 文档判定。
 */
export function parseTeamGovernanceOverridesDocument(
  value: unknown,
): TeamGovernanceOverridesDocument {
  const root = objectAt(value, "override", failOverrideInvalid);
  onlyKeys(
    root,
    ["network", "capabilities", "modelRouting"],
    "override",
    failOverrideInvalid,
  );

  let network: TeamGovernanceOverridesDocument["network"];
  if (root.network !== undefined) {
    const record = objectAt(
      root.network,
      "override.network",
      failOverrideInvalid,
    );
    onlyKeys(
      record,
      ["mode", "rules"],
      "override.network",
      failOverrideInvalid,
    );
    let networkMode: GovernanceEgressMode | undefined;
    let networkRules: GovernanceEgressRule[] | undefined;
    if (record.mode !== undefined) {
      networkMode = egressMode(
        record,
        "mode",
        "override.network.mode",
        failOverrideInvalid,
      );
    }
    if (record.rules !== undefined) {
      networkRules = egressRules(
        record,
        "rules",
        "override.network.rules",
        failOverrideInvalid,
      );
    }
    if (networkMode === undefined && networkRules === undefined) {
      failOverrideInvalid("override.network", "must narrow at least one field");
    }
    network = {
      ...(networkMode !== undefined ? { mode: networkMode } : {}),
      ...(networkRules !== undefined ? { rules: networkRules } : {}),
    };
  }

  let capabilities: TeamGovernanceOverridesDocument["capabilities"];
  if (root.capabilities !== undefined) {
    const record = objectAt(
      root.capabilities,
      "override.capabilities",
      failOverrideInvalid,
    );
    onlyKeys(
      record,
      [...CAPABILITIES],
      "override.capabilities",
      failOverrideInvalid,
    );
    if (Object.keys(record).length === 0) {
      failOverrideInvalid(
        "override.capabilities",
        "must narrow at least one field",
      );
    }
    const narrowed: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "boolean" || !isCapability(key)) {
        failOverrideInvalid(
          `override.capabilities.${key}`,
          "must be a boolean over the shipped capability set",
        );
      }
      // true is a valid shape but a widening semantic — rejected at resolve
      // time against the company document (CAPABILITY_OVERRIDE_WIDENS_POLICY).
      narrowed[key] = value;
    }
    capabilities = narrowed;
  }

  let modelRouting: TeamGovernanceOverridesDocument["modelRouting"];
  if (root.modelRouting !== undefined) {
    const record = objectAt(
      root.modelRouting,
      "override.modelRouting",
      failOverrideInvalid,
    );
    onlyKeys(
      record,
      ["allowedRoutes", "defaultRoute"],
      "override.modelRouting",
      failOverrideInvalid,
    );
    let overrideRoutes: string[] | undefined;
    let overrideDefaultRoute: string | undefined;
    if (record.allowedRoutes !== undefined) {
      overrideRoutes = routeList(
        record,
        "allowedRoutes",
        "override.modelRouting.allowedRoutes",
        failOverrideInvalid,
      );
      if (overrideRoutes.length < 1) {
        throw new Error(
          "OVERRIDE_MODEL_ROUTING_EMPTY: override.modelRouting.allowedRoutes must keep at least one route (an override narrows, it does not switch routing off)",
        );
      }
    }
    if (record.defaultRoute !== undefined) {
      overrideDefaultRoute = routeRef(
        record,
        "defaultRoute",
        "override.modelRouting.defaultRoute",
        failOverrideInvalid,
      );
    }
    if (overrideRoutes === undefined && overrideDefaultRoute === undefined) {
      failOverrideInvalid(
        "override.modelRouting",
        "must narrow at least one field",
      );
    }
    modelRouting = {
      ...(overrideRoutes !== undefined
        ? { allowedRoutes: overrideRoutes }
        : {}),
      ...(overrideDefaultRoute !== undefined
        ? { defaultRoute: overrideDefaultRoute }
        : {}),
    };
  }

  if (!network && !capabilities && !modelRouting) {
    failOverrideInvalid("override", "must narrow at least one field");
  }
  return {
    ...(network ? { network } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(modelRouting ? { modelRouting } : {}),
  };
}

// ---------------------------------------------------------------------------
// 解析：纯函数，只依赖入参（验收 4）
// ---------------------------------------------------------------------------

export interface ResolveGovernancePolicyInput {
  tenantId: string;
  workspaceId: string;
  company: CompanyGovernancePolicyDocument;
  companyRevision: number;
  override: TeamGovernanceOverridesDocument | null;
  overrideRevision: number | null;
}

const EGRESS_STRENGTH = Object.fromEntries(
  EGRESS_MODES.map((mode, index) => [mode, index]),
) as Readonly<Record<GovernanceEgressMode, number>>;

function canonicalRule(rule: GovernanceEgressRule): string {
  return rule.type === "cidr" && "ports" in rule
    ? JSON.stringify({ type: rule.type, value: rule.value, ports: rule.ports })
    : JSON.stringify({ type: rule.type, value: rule.value });
}

/**
 * 把公司治理策略与团队覆盖解析为该作用域的生效策略。
 *
 * 覆盖只能收窄：capability true、更弱的 egress mode、公司清单之外的
 * 规则/路由、落出有效路由面的默认路由都在这里响亮拒绝，绝不部分生效。
 * 输出深冻结——调用方拿到的是不可变快照，缓存键由归属与版本派生。
 */
export function resolveGovernancePolicy(
  input: ResolveGovernancePolicyInput,
): ResolvedGovernancePolicy {
  const tenantId = input.tenantId?.trim();
  if (!tenantId) throw new Error("TENANT_REQUIRED");
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) throw new Error("WORKSPACE_REQUIRED");
  const { company } = input;

  // --- 能力开关：覆盖里 true 一律是放大（专门测试钉死）；false 才是收窄。 ---
  const overrideCapabilities = input.override?.capabilities;
  const capabilities = { ...company.capabilities } as Record<
    Capability,
    boolean
  >;
  if (overrideCapabilities) {
    for (const [capability, declared] of Object.entries(overrideCapabilities)) {
      if (declared !== false) {
        throw new Error(
          `CAPABILITY_OVERRIDE_WIDENS_POLICY: override.capabilities.${capability} must not turn a capability on — a team override can only switch capabilities off`,
        );
      }
      capabilities[capability as Capability] = false;
    }
  }

  // --- 网络策略：mode 强度只增不减；rules 必须是公司规则清单子集。 ---
  const overrideNetwork = input.override?.network;
  let networkMode = company.network.mode;
  if (overrideNetwork?.mode !== undefined) {
    if (
      EGRESS_STRENGTH[overrideNetwork.mode] <
      EGRESS_STRENGTH[company.network.mode]
    ) {
      throw new Error(
        "NETWORK_OVERRIDE_WIDENS_POLICY: override.network.mode must not be weaker than the company egress mode",
      );
    }
    networkMode = overrideNetwork.mode;
  }
  let networkRules = company.network.rules;
  if (overrideNetwork?.rules !== undefined) {
    const companyRuleSet = new Set(
      company.network.rules.map((rule) => canonicalRule(rule)),
    );
    for (let index = 0; index < overrideNetwork.rules.length; index++) {
      if (!companyRuleSet.has(canonicalRule(overrideNetwork.rules[index]))) {
        throw new Error(
          `NETWORK_OVERRIDE_WIDENS_POLICY: override.network.rules entry at index ${index} is not covered by the company egress rules`,
        );
      }
    }
    networkRules = overrideNetwork.rules;
  }

  // --- 模型路由：路由子集 + 默认路由落在有效面内。 ---
  const overrideRouting = input.override?.modelRouting;
  const allowedRoutes =
    overrideRouting?.allowedRoutes ?? company.modelRouting.allowedRoutes;
  if (overrideRouting?.allowedRoutes !== undefined) {
    for (let index = 0; index < overrideRouting.allowedRoutes.length; index++) {
      if (
        !company.modelRouting.allowedRoutes.includes(
          overrideRouting.allowedRoutes[index],
        )
      ) {
        throw new Error(
          `OVERRIDE_WIDENS_POLICY: override.modelRouting.allowedRoutes entry at index ${index} is not offered by the company policy`,
        );
      }
    }
  }
  const defaultRoute =
    overrideRouting?.defaultRoute ?? company.modelRouting.defaultRoute;
  if (!allowedRoutes.includes(defaultRoute)) {
    throw new Error(
      "OVERRIDE_WIDENS_POLICY: override.modelRouting.defaultRoute is not within the effective route allowlist",
    );
  }

  return deepFreeze({
    scope: { tenantId, workspaceId },
    revisions: {
      company: input.companyRevision,
      override: input.overrideRevision,
    },
    cacheKey: `routing-policy/v1/t=${tenantId}/w=${workspaceId}/c=${input.companyRevision}/o=${input.overrideRevision ?? "-"}`,
    network: { mode: networkMode, rules: networkRules },
    capabilities,
    modelRouting: { allowedRoutes, defaultRoute },
  });
}

// ---------------------------------------------------------------------------
// 服务：受限数据通道上的读取路径（验收 1 的数据库面）
// ---------------------------------------------------------------------------

export interface RoutingPolicyResolveInput {
  tenantId: string;
  workspaceId: string;
}

export interface RoutingPolicyService {
  /**
   * 按公司/团队解析生效治理策略。调用方必须已用受信 Scope 证明该主体在
   * 该公司/团队的有效成员资格（与 runtime reader 同一契约）；本模块的
   * 数据库读取在受限角色 + 事务本地租户上下文 + RLS 下执行，跨公司的
   * 策略行按不可见处理。
   */
  resolve(input: RoutingPolicyResolveInput): Promise<ResolvedGovernancePolicy>;
}

/** 缺公司策略行的拒绝：多租户模式没有旧默认回退（绝不落到别的公司或部署默认）。 */
export const GOVERNANCE_POLICY_NOT_FOUND = "GOVERNANCE_POLICY_NOT_FOUND";

export function createRoutingPolicyService(
  data: DataDatabase,
): RoutingPolicyService {
  assertDataDatabase(data);
  return {
    async resolve({ tenantId, workspaceId }: RoutingPolicyResolveInput) {
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const [companyRow] = await tx
          .select({
            tenantId: enterpriseGovernancePolicies.tenantId,
            document: enterpriseGovernancePolicies.document,
            revision: enterpriseGovernancePolicies.revision,
          })
          .from(enterpriseGovernancePolicies)
          .where(eq(enterpriseGovernancePolicies.tenantId, tenantId))
          .limit(1);
        // RLS 让「别的公司的策略行」与「不存在的策略行」同为 0 行：不存在
        // 与跨公司不可见对外不可区分，都没有默认回退。
        if (!companyRow) throw new Error(GOVERNANCE_POLICY_NOT_FOUND);
        const [overrideRow] = await tx
          .select({
            document: enterpriseGovernanceOverrides.document,
            revision: enterpriseGovernanceOverrides.revision,
          })
          .from(enterpriseGovernanceOverrides)
          .where(
            and(
              eq(enterpriseGovernanceOverrides.tenantId, tenantId),
              eq(enterpriseGovernanceOverrides.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        return resolveGovernancePolicy({
          tenantId,
          workspaceId,
          company: parseCompanyGovernancePolicyDocument(companyRow.document),
          companyRevision: companyRow.revision,
          override: overrideRow
            ? parseTeamGovernanceOverridesDocument(overrideRow.document)
            : null,
          overrideRevision: overrideRow ? overrideRow.revision : null,
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 模板安装：读取（data 通道，跨范围不可见）与写入（operator 通道，CAS）
// ---------------------------------------------------------------------------

export interface TemplateInstallView {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly templateRef: string;
  readonly sourceRevision: number;
  readonly revision: number;
  readonly document: Readonly<Record<string, unknown>>;
}

export const TEMPLATE_UNKNOWN = "TEMPLATE_UNKNOWN";
export const TEMPLATE_INSTALL_NOT_FOUND = "TEMPLATE_INSTALL_NOT_FOUND";
export const TEMPLATE_INSTALL_ALREADY_EXISTS =
  "TEMPLATE_INSTALL_ALREADY_EXISTS";
export const TEMPLATE_INSTALL_REVISION_CONFLICT =
  "TEMPLATE_INSTALL_REVISION_CONFLICT";
export const TEMPLATE_INSTALL_ALREADY_CURRENT =
  "TEMPLATE_INSTALL_ALREADY_CURRENT";

/** 安装文档是该范围的客户内容副本：必须是对象且有界（防止文档当垃圾场）。 */
export function parseTemplateInstallDocument(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "TEMPLATE_INSTALL_DOCUMENT_INVALID: document must be a JSON object",
    );
  }
  if (JSON.stringify(value).length > INSTALL_DOCUMENT_MAX_SERIALIZED) {
    throw new Error(
      `TEMPLATE_INSTALL_DOCUMENT_INVALID: document must serialize to at most ${INSTALL_DOCUMENT_MAX_SERIALIZED} characters`,
    );
  }
  return value as Record<string, unknown>;
}

function requireInstallSelector(input: {
  tenantId: string;
  workspaceId: string;
  templateRef: string;
}): void {
  if (!input.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!input.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
  if (!input.templateRef?.trim()) throw new Error("TEMPLATE_REF_REQUIRED");
}

function requireExpectedRevision(expectedRevision: number): number {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("TEMPLATE_INSTALL_REVISION_INVALID");
  }
  return expectedRevision;
}

function toView(row: {
  tenantId: string;
  workspaceId: string;
  templateRef: string;
  sourceRevision: number;
  revision: number;
  document: unknown;
}): TemplateInstallView {
  return deepFreeze({
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    templateRef: row.templateRef,
    sourceRevision: row.sourceRevision,
    revision: row.revision,
    document: parseTemplateInstallDocument(row.document),
  });
}

export interface TemplateInstallReader {
  /** Reads one install of a team scope; any other scope's row reads as null. */
  read(
    tenantId: string,
    workspaceId: string,
    templateRef: string,
  ): Promise<TemplateInstallView | null>;
  /** Lists one team scope's installs; other teams' rows never appear. */
  list(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly TemplateInstallView[]>;
}

export function createTemplateInstallReader(
  data: DataDatabase,
): TemplateInstallReader {
  assertDataDatabase(data);
  return {
    async read(tenantId, workspaceId, templateRef) {
      requireInstallSelector({ tenantId, workspaceId, templateRef });
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const [row] = await tx
          .select()
          .from(enterpriseTemplateInstalls)
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, workspaceId),
              eq(enterpriseTemplateInstalls.templateRef, templateRef),
            ),
          )
          .limit(1);
        return row ? toView(row) : null;
      });
    },

    async list(tenantId, workspaceId) {
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const rows = await tx
          .select()
          .from(enterpriseTemplateInstalls)
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, workspaceId),
            ),
          )
          .orderBy(enterpriseTemplateInstalls.templateRef);
        return rows.map((row) => toView(row));
      });
    },
  };
}

export interface TemplateInstallWriterInstallInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly templateRef: string;
}

export interface TemplateInstallWriterUpdateInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly templateRef: string;
  readonly document: unknown;
  /** Optimistic concurrency: the install revision the caller last read. */
  readonly expectedRevision: number;
}

export interface TemplateInstallWriter {
  /**
   * Installs a platform template into one team scope by copying the frozen
   * catalog entry. The catalog itself is never written — there is no write
   * path to it anywhere in this module.
   */
  install(
    input: TemplateInstallWriterInstallInput,
  ): Promise<TemplateInstallView>;
  /**
   * Updates one install's customer content, scoped to its own
   * (tenant, workspace, ref) row and guarded by optimistic concurrency.
   */
  updateInstall(
    input: TemplateInstallWriterUpdateInput,
  ): Promise<TemplateInstallView>;
  /**
   * Refreshes one install's content from the current catalog revision
   * (the copy catches up; the platform template itself stays untouched).
   */
  syncToCatalogRevision(
    input: TemplateInstallWriterUpdateInput,
  ): Promise<TemplateInstallView>;
}

export function createTemplateInstallWriter(
  operator: OperatorDatabase,
): TemplateInstallWriter {
  assertOperatorDatabase(operator);
  const runInScope = async <T>(
    input: { tenantId: string; workspaceId: string },
    operation: (
      tx: Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> =>
    operator.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${input.tenantId}, true), set_config('app.workspace_id', ${input.workspaceId}, true)`,
      );
      return operation(tx);
    });

  return {
    async install(input) {
      requireInstallSelector(input);
      const template = findPlatformTemplate(input.templateRef);
      if (!template) throw new Error(TEMPLATE_UNKNOWN);
      return runInScope(input, async (tx) => {
        const inserted = await tx
          .insert(enterpriseTemplateInstalls)
          .values({
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            templateRef: input.templateRef,
            sourceRevision: template.revision,
            document: template.document as Record<string, unknown>,
            revision: 1,
          })
          .onConflictDoNothing()
          .returning();
        const row = inserted[0];
        if (!row) throw new Error(TEMPLATE_INSTALL_ALREADY_EXISTS);
        return toView(row);
      });
    },

    async updateInstall(input) {
      requireInstallSelector(input);
      const document = parseTemplateInstallDocument(input.document);
      const expectedRevision = requireExpectedRevision(input.expectedRevision);
      return runInScope(input, async (tx) => {
        const updated = await tx
          .update(enterpriseTemplateInstalls)
          .set({
            document,
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, input.tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, input.workspaceId),
              eq(enterpriseTemplateInstalls.templateRef, input.templateRef),
              eq(enterpriseTemplateInstalls.revision, expectedRevision),
            ),
          )
          .returning();
        const row = updated[0];
        if (row) return toView(row);
        // Distinguish "no such install (also: invisible cross-scope row)"
        // from "another writer moved first" without leaking either way.
        const [existing] = await tx
          .select({ revision: enterpriseTemplateInstalls.revision })
          .from(enterpriseTemplateInstalls)
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, input.tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, input.workspaceId),
              eq(enterpriseTemplateInstalls.templateRef, input.templateRef),
            ),
          )
          .limit(1);
        if (!existing) throw new Error(TEMPLATE_INSTALL_NOT_FOUND);
        throw new Error(TEMPLATE_INSTALL_REVISION_CONFLICT);
      });
    },

    async syncToCatalogRevision(input) {
      requireInstallSelector(input);
      const template = findPlatformTemplate(input.templateRef);
      if (!template) throw new Error(TEMPLATE_UNKNOWN);
      const expectedRevision = requireExpectedRevision(input.expectedRevision);
      return runInScope(input, async (tx) => {
        const updated = await tx
          .update(enterpriseTemplateInstalls)
          .set({
            document: template.document as Record<string, unknown>,
            sourceRevision: template.revision,
            revision: expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, input.tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, input.workspaceId),
              eq(enterpriseTemplateInstalls.templateRef, input.templateRef),
              eq(enterpriseTemplateInstalls.revision, expectedRevision),
              sql`${enterpriseTemplateInstalls.sourceRevision} <> ${template.revision}`,
            ),
          )
          .returning();
        const row = updated[0];
        if (row) return toView(row);
        const [existing] = await tx
          .select({
            revision: enterpriseTemplateInstalls.revision,
            sourceRevision: enterpriseTemplateInstalls.sourceRevision,
          })
          .from(enterpriseTemplateInstalls)
          .where(
            and(
              eq(enterpriseTemplateInstalls.tenantId, input.tenantId),
              eq(enterpriseTemplateInstalls.workspaceId, input.workspaceId),
              eq(enterpriseTemplateInstalls.templateRef, input.templateRef),
            ),
          )
          .limit(1);
        if (!existing) throw new Error(TEMPLATE_INSTALL_NOT_FOUND);
        if (existing.revision !== expectedRevision) {
          throw new Error(TEMPLATE_INSTALL_REVISION_CONFLICT);
        }
        throw new Error(TEMPLATE_INSTALL_ALREADY_CURRENT);
      });
    },
  };
}
