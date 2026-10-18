// server/src/enterprise/tenancy/runtime-config.ts
// MT014（Issue #57）：公司运行配置装配。
//
// 模型配置、Bot 默认、线程标识、凭据引用与套餐映射按公司/团队解析，
// 而不是启动时装配一份全局配置（Spec §6：租户包加载从单个部署默认扩展
// 为公司配置装配；部署级基础设施继续共享，不经此模块）。
//
// 结构上的硬性规则（验收 2/3 的实现面）：
//   - 公司配置文档是能力面；团队覆盖只能收窄——allowlist 覆盖必须是公司
//     allowlist 的子集，默认模型/默认 Bot 必须落在有效能力面内，覆盖绝不
//     能引入公司未发布的能力（OVERRIDE_WIDENS_POLICY）。
//   - 个人凭据绝不因覆盖升级为团队凭据：覆盖引用公司标记为 personal 的
//     引用一律拒绝（PERSONAL_CREDENTIAL_NOT_UPGRADABLE）；公司条目不可被
//     团队条目遮蔽（OVERRIDE_REDECLARES_COMPANY_CREDENTIAL）；覆盖条目解
//     析后永远是 team 访问级别，覆盖文档里根本没有 access 字段可声明。
//   - 解析是纯函数：只依赖入参，绝不读取任何进程环境（环境变量、运行时
//     全局都不在本模块的输入面上），没有进程级"当前公司"可变全局状态。
//   - 凭据值不进本模块：文档只携带引用（ref 是寻址，不是秘密——Spec §6
//     「路径前缀/ID 编码只用于寻址」），所有拒绝消息只含代码、字段路径与
//     索引，绝不回显任何值。
//
// 读取路径经受限 ob_ent_data 角色 + 事务本地 app.tenant_id + RLS（与
// store.ts / resource-policy.ts 同款事务形状）；缺公司配置行是
// RUNTIME_CONFIG_NOT_FOUND——多租户模式没有旧默认回退（MT013 交互：
// 开关决定谁调用解析，绝不泄漏进解析结果）。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseRuntimeConfigOverrides,
  enterpriseRuntimeConfigs,
} from "../../db/schema/enterprise-runtime-config";
import { assertDataDatabase, type DataDatabase } from "./connections";

// ---------------------------------------------------------------------------
// 类型：公司运行配置模型
// ---------------------------------------------------------------------------

export type RuntimeModelProvider = "openai" | "anthropic";

/** 凭据的访问级别。personal 条目只参与「禁止升级」规则，绝不进入解析结果。 */
export type RuntimeCredentialAccess = "company" | "personal";

export interface CompanyRuntimeConfigDocument {
  model: {
    provider: RuntimeModelProvider;
    /** 凭据引用（寻址），必须指向本文档 credentials 中 access=company 的条目。 */
    credentialRef: string;
    defaultModel: string;
    /** 公司开放的模型能力面；团队覆盖只能收窄它。 */
    allowedModels: readonly string[];
  };
  botDefaults: {
    /** 公司发布的 Bot 能力面；团队覆盖只能在其中选择。 */
    availableAgentIds: readonly string[];
    defaultAgentId: string | null;
  };
  /**
   * 公司凭据引用登记表。只有引用，没有值——值在凭据库，绝不进配置文档。
   * access=personal 的条目存在只为钉死「覆盖不得升级个人凭据」这条规则。
   */
  credentials: readonly {
    purpose: string;
    ref: string;
    access: RuntimeCredentialAccess;
  }[];
  /** 套餐映射：公司级计费事实，团队不可覆盖（一家公司一个余额，ADR 0004）。 */
  planMapping: {
    billingExternalCustomerId: string;
    plan: string | null;
  };
}

export interface TeamRuntimeOverridesDocument {
  model?: {
    /** 收窄后的能力面（公司 allowlist 的子集，至少一个）。 */
    allowedModels?: readonly string[];
    defaultModel?: string;
  };
  botDefaults?: {
    defaultAgentId?: string | null;
  };
  /** 团队新增的凭据引用；解析后固定 access=team，无可声明的字段。 */
  credentials?: readonly { purpose: string; ref: string }[];
}

export interface ResolvedRuntimeConfig {
  readonly scope: Readonly<{ tenantId: string; workspaceId: string }>;
  readonly revisions: Readonly<{
    company: number;
    override: number | null;
  }>;
  /** 缓存键含实际归属及配置版本（Spec §6）。确定性派生，绝不引用进程状态。 */
  readonly cacheKey: string;
  readonly model: Readonly<{
    provider: RuntimeModelProvider;
    credentialRef: string;
    defaultModel: string;
    allowedModels: readonly string[];
  }>;
  readonly botDefaults: Readonly<{
    availableAgentIds: readonly string[];
    defaultAgentId: string | null;
  }>;
  /**
   * 线程标识种子：由入参归属（公司 + 团队）确定性派生，不是公司可声明的
   * 字段——两家公司声明同一个种子也不能让线程串门。下游把它交给
   * createThreadIdentity（channels/thread-identity.ts）铸造/认领线程 id。
   */
  readonly threadIdentitySeed: string;
  readonly credentials: readonly {
    readonly purpose: string;
    readonly ref: string;
    readonly access: RuntimeCredentialAccess | "team";
  }[];
  readonly planMapping: Readonly<{
    billingExternalCustomerId: string;
    plan: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// 拒绝：只含代码、字段路径与索引，绝不回显任何值（验收 3）
// ---------------------------------------------------------------------------

function failInvalid(path: string, rule: string): never {
  throw new Error(`RUNTIME_CONFIG_INVALID: ${path} ${rule}`);
}

function failOverrideInvalid(path: string, rule: string): never {
  throw new Error(`RUNTIME_OVERRIDE_INVALID: ${path} ${rule}`);
}

// ---------------------------------------------------------------------------
// 文档解析：严格形状；未知键拒绝（把误放进配置的机密挡在门外）
// ---------------------------------------------------------------------------

const REF_MAX = 200;
const PURPOSE_MAX = 64;
const MODEL_ID_MAX = 200;
const AGENT_ID_MAX = 128;

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

function requireString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  fail: (p: string, r: string) => never,
): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(path, `must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  fail: (p: string, r: string) => never,
): string | undefined {
  if (source[key] === undefined) return undefined;
  return requireString(source, key, path, max, fail);
}

function stringArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  maxEntries: number,
  entryMax: number,
  fail: (p: string, r: string) => never,
): string[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maxEntries) {
    fail(path, `must hold at most ${maxEntries} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = requireString(
      { value: entry } as Record<string, unknown>,
      "value",
      path,
      entryMax,
      fail,
    );
    if (seen.has(item)) fail(path, "must not repeat an entry");
    seen.add(item);
    return item;
  });
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

function credentialAccess(
  source: Record<string, unknown>,
  path: string,
): RuntimeCredentialAccess {
  const value = source.access;
  if (value === "company" || value === "personal") return value;
  failInvalid(path, 'must be "company" or "personal"');
}

/**
 * 解析公司运行配置文档。未知键、越界形状、能力面内部不一致（默认模型不
 * 在开放面内、模型凭据不是公司级凭据）一律响亮拒绝；消息只含字段路径与
 * 规则，绝不回显值。
 */
export function parseCompanyRuntimeConfigDocument(
  value: unknown,
): CompanyRuntimeConfigDocument {
  const root = objectAt(value, "company", failInvalid);
  onlyKeys(
    root,
    ["model", "botDefaults", "credentials", "planMapping"],
    "company",
    failInvalid,
  );

  const model = objectAt(root.model, "company.model", failInvalid);
  onlyKeys(
    model,
    ["provider", "credentialRef", "defaultModel", "allowedModels"],
    "company.model",
    failInvalid,
  );
  const provider = model.provider;
  if (provider !== "openai" && provider !== "anthropic") {
    failInvalid("company.model.provider", 'must be "openai" or "anthropic"');
  }
  const credentialRef = requireString(
    model,
    "credentialRef",
    "company.model.credentialRef",
    REF_MAX,
    failInvalid,
  );
  const defaultModel = requireString(
    model,
    "defaultModel",
    "company.model.defaultModel",
    MODEL_ID_MAX,
    failInvalid,
  );
  const allowedModels = stringArray(
    model,
    "allowedModels",
    "company.model.allowedModels",
    256,
    MODEL_ID_MAX,
    failInvalid,
  );
  if (allowedModels.length < 1) {
    failInvalid("company.model.allowedModels", "must offer at least one model");
  }
  if (!allowedModels.includes(defaultModel)) {
    failInvalid(
      "company.model.defaultModel",
      "must be one of company.model.allowedModels",
    );
  }

  const botDefaults = objectAt(
    root.botDefaults,
    "company.botDefaults",
    failInvalid,
  );
  onlyKeys(
    botDefaults,
    ["availableAgentIds", "defaultAgentId"],
    "company.botDefaults",
    failInvalid,
  );
  const availableAgentIds = stringArray(
    botDefaults,
    "availableAgentIds",
    "company.botDefaults.availableAgentIds",
    1024,
    AGENT_ID_MAX,
    failInvalid,
  );
  let defaultAgentId: string | null = null;
  if (
    botDefaults.defaultAgentId !== undefined &&
    botDefaults.defaultAgentId !== null
  ) {
    defaultAgentId = requireString(
      botDefaults,
      "defaultAgentId",
      "company.botDefaults.defaultAgentId",
      AGENT_ID_MAX,
      failInvalid,
    );
    if (!availableAgentIds.includes(defaultAgentId)) {
      failInvalid(
        "company.botDefaults.defaultAgentId",
        "must be one of company.botDefaults.availableAgentIds",
      );
    }
  } else {
    defaultAgentId = null;
  }

  const rawCredentials = root.credentials;
  if (!Array.isArray(rawCredentials)) {
    failInvalid("company.credentials", "must be an array");
  }
  if (rawCredentials.length > 1024) {
    failInvalid("company.credentials", "must hold at most 1024 entries");
  }
  const refs = new Set<string>();
  const purposes = new Set<string>();
  const credentials = rawCredentials.map((entry, index) => {
    const record = objectAt(
      entry,
      `company.credentials[${index}]`,
      failInvalid,
    );
    onlyKeys(
      record,
      ["purpose", "ref", "access"],
      `company.credentials[${index}]`,
      failInvalid,
    );
    const purpose = requireString(
      record,
      "purpose",
      `company.credentials[${index}].purpose`,
      PURPOSE_MAX,
      failInvalid,
    );
    const ref = requireString(
      record,
      "ref",
      `company.credentials[${index}].ref`,
      REF_MAX,
      failInvalid,
    );
    const access = credentialAccess(
      record,
      `company.credentials[${index}].access`,
    );
    if (refs.has(ref)) {
      failInvalid(
        `company.credentials[${index}].ref`,
        "must not repeat a reference",
      );
    }
    if (purposes.has(purpose)) {
      failInvalid(
        `company.credentials[${index}].purpose`,
        "must not repeat a purpose",
      );
    }
    refs.add(ref);
    purposes.add(purpose);
    return { purpose, ref, access };
  });
  const modelCredential = credentials.find(
    (entry) => entry.ref === credentialRef,
  );
  if (modelCredential?.access !== "company") {
    failInvalid(
      "company.model.credentialRef",
      "must reference a company-access entry of company.credentials",
    );
  }

  const planMapping = objectAt(
    root.planMapping,
    "company.planMapping",
    failInvalid,
  );
  onlyKeys(
    planMapping,
    ["billingExternalCustomerId", "plan"],
    "company.planMapping",
    failInvalid,
  );
  const billingExternalCustomerId = requireString(
    planMapping,
    "billingExternalCustomerId",
    "company.planMapping.billingExternalCustomerId",
    REF_MAX,
    failInvalid,
  );
  let plan: string | null = null;
  if (planMapping.plan !== undefined && planMapping.plan !== null) {
    plan = requireString(
      planMapping,
      "plan",
      "company.planMapping.plan",
      128,
      failInvalid,
    );
  }

  return {
    model: { provider, credentialRef, defaultModel, allowedModels },
    botDefaults: { availableAgentIds, defaultAgentId },
    credentials,
    planMapping: { billingExternalCustomerId, plan },
  };
}

/**
 * 解析团队覆盖文档。只接受收窄字段：unknown 键（包括试图声明 access 或
 * 换 provider/凭据）一律拒绝——覆盖连「表达扩大」的形状都没有。
 */
export function parseTeamRuntimeOverridesDocument(
  value: unknown,
): TeamRuntimeOverridesDocument {
  const root = objectAt(value, "override", failOverrideInvalid);
  onlyKeys(
    root,
    ["model", "botDefaults", "credentials"],
    "override",
    failOverrideInvalid,
  );

  let model: TeamRuntimeOverridesDocument["model"];
  if (root.model !== undefined) {
    const record = objectAt(root.model, "override.model", failOverrideInvalid);
    onlyKeys(
      record,
      ["allowedModels", "defaultModel"],
      "override.model",
      failOverrideInvalid,
    );
    model = {};
    if (record.allowedModels !== undefined) {
      const allowedModels = stringArray(
        record,
        "allowedModels",
        "override.model.allowedModels",
        256,
        MODEL_ID_MAX,
        failOverrideInvalid,
      );
      if (allowedModels.length < 1) {
        // 语义拒绝（不是形状拒绝）：收窄到空等于把团队运行时关掉，那是
        // 公司管理动作，不是团队覆盖的表达范围。
        throw new Error(
          "OVERRIDE_MODEL_ALLOWLIST_EMPTY: override.model.allowedModels must keep at least one model (an override narrows, it does not switch the runtime off)",
        );
      }
      model.allowedModels = allowedModels;
    }
    const defaultModel = optionalString(
      record,
      "defaultModel",
      "override.model.defaultModel",
      MODEL_ID_MAX,
      failOverrideInvalid,
    );
    if (defaultModel !== undefined) model.defaultModel = defaultModel;
    if (Object.keys(model).length === 0) {
      failOverrideInvalid("override.model", "must narrow at least one field");
    }
  }

  let botDefaults: TeamRuntimeOverridesDocument["botDefaults"];
  if (root.botDefaults !== undefined) {
    const record = objectAt(
      root.botDefaults,
      "override.botDefaults",
      failOverrideInvalid,
    );
    onlyKeys(
      record,
      ["defaultAgentId"],
      "override.botDefaults",
      failOverrideInvalid,
    );
    if (record.defaultAgentId === undefined) {
      failOverrideInvalid(
        "override.botDefaults",
        "must narrow at least one field",
      );
    }
    botDefaults = {
      defaultAgentId:
        record.defaultAgentId === null
          ? null
          : requireString(
              record,
              "defaultAgentId",
              "override.botDefaults.defaultAgentId",
              AGENT_ID_MAX,
              failOverrideInvalid,
            ),
    };
  }

  let credentials: TeamRuntimeOverridesDocument["credentials"];
  if (root.credentials !== undefined) {
    const raw = root.credentials;
    if (!Array.isArray(raw)) {
      failOverrideInvalid("override.credentials", "must be an array");
    }
    if (raw.length > 256) {
      failOverrideInvalid(
        "override.credentials",
        "must hold at most 256 entries",
      );
    }
    const purposes = new Set<string>();
    credentials = raw.map((entry, index) => {
      const record = objectAt(
        entry,
        `override.credentials[${index}]`,
        failOverrideInvalid,
      );
      onlyKeys(
        record,
        ["purpose", "ref"],
        `override.credentials[${index}]`,
        failOverrideInvalid,
      );
      const purpose = requireString(
        record,
        "purpose",
        `override.credentials[${index}].purpose`,
        PURPOSE_MAX,
        failOverrideInvalid,
      );
      const ref = requireString(
        record,
        "ref",
        `override.credentials[${index}].ref`,
        REF_MAX,
        failOverrideInvalid,
      );
      if (purposes.has(purpose)) {
        failOverrideInvalid(
          `override.credentials[${index}].purpose`,
          "must not repeat a purpose",
        );
      }
      purposes.add(purpose);
      return { purpose, ref };
    });
  }

  if (!model && !botDefaults && !credentials) {
    failOverrideInvalid("override", "must narrow at least one field");
  }
  return {
    ...(model ? { model } : {}),
    ...(botDefaults ? { botDefaults } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

// ---------------------------------------------------------------------------
// 解析：纯函数，只依赖入参（验收 4）
// ---------------------------------------------------------------------------

export interface ResolveRuntimeConfigInput {
  tenantId: string;
  workspaceId: string;
  company: CompanyRuntimeConfigDocument;
  companyRevision: number;
  override: TeamRuntimeOverridesDocument | null;
  overrideRevision: number | null;
}

/**
 * 把公司配置与团队覆盖解析为该作用域的运行配置。
 *
 * 覆盖只能收窄：任何试图扩大能力面的形状都在这里响亮拒绝，绝不部分生效。
 * 输出深冻结——调用方拿到的是不可变快照，缓存键由归属与版本派生。
 */
export function resolveRuntimeConfig(
  input: ResolveRuntimeConfigInput,
): ResolvedRuntimeConfig {
  const tenantId = input.tenantId?.trim();
  if (!tenantId) throw new Error("TENANT_REQUIRED");
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) throw new Error("WORKSPACE_REQUIRED");
  const { company } = input;

  const override = input.override;
  const overrideAllowedModels = override?.model?.allowedModels;
  const allowedModels = overrideAllowedModels ?? company.model.allowedModels;
  if (overrideAllowedModels) {
    for (let index = 0; index < overrideAllowedModels.length; index++) {
      if (!company.model.allowedModels.includes(overrideAllowedModels[index])) {
        throw new Error(
          `OVERRIDE_WIDENS_POLICY: override.model.allowedModels entry at index ${index} is not offered by the company policy`,
        );
      }
    }
  }
  const defaultModel =
    override?.model?.defaultModel ?? company.model.defaultModel;
  if (!allowedModels.includes(defaultModel)) {
    throw new Error(
      "OVERRIDE_WIDENS_POLICY: override.model.defaultModel is not within the effective allowlist",
    );
  }

  let defaultAgentId = company.botDefaults.defaultAgentId;
  const overrideAgent = override?.botDefaults?.defaultAgentId;
  if (overrideAgent !== undefined) {
    if (
      overrideAgent !== null &&
      !company.botDefaults.availableAgentIds.includes(overrideAgent)
    ) {
      throw new Error(
        "OVERRIDE_WIDENS_POLICY: override.botDefaults.defaultAgentId is not published by the company",
      );
    }
    defaultAgentId = overrideAgent;
  }

  const teamCredentials = (override?.credentials ?? []).map((entry, index) => {
    const declared = company.credentials.find(
      (candidate) => candidate.ref === entry.ref,
    );
    if (declared?.access === "personal") {
      throw new Error(
        `PERSONAL_CREDENTIAL_NOT_UPGRADABLE: override.credentials entry at index ${index} names a personal-scope reference`,
      );
    }
    if (declared) {
      throw new Error(
        `OVERRIDE_REDECLARES_COMPANY_CREDENTIAL: override.credentials entry at index ${index} shadows a company entry`,
      );
    }
    return { purpose: entry.purpose, ref: entry.ref, access: "team" as const };
  });

  return deepFreeze({
    scope: { tenantId, workspaceId },
    revisions: {
      company: input.companyRevision,
      override: input.overrideRevision,
    },
    cacheKey: `runtime-config/v1/t=${tenantId}/w=${workspaceId}/c=${input.companyRevision}/o=${input.overrideRevision ?? "-"}`,
    model: {
      provider: company.model.provider,
      credentialRef: company.model.credentialRef,
      defaultModel,
      allowedModels,
    },
    botDefaults: {
      availableAgentIds: company.botDefaults.availableAgentIds,
      defaultAgentId,
    },
    threadIdentitySeed: JSON.stringify([tenantId, workspaceId]),
    credentials: [
      ...company.credentials
        .filter((entry) => entry.access === "company")
        .map((entry) => ({
          purpose: entry.purpose,
          ref: entry.ref,
          // The filter above is the only source here: the company surface.
          access: "company" as const,
        })),
      ...teamCredentials,
    ],
    planMapping: {
      billingExternalCustomerId: company.planMapping.billingExternalCustomerId,
      plan: company.planMapping.plan,
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 服务：受限数据通道上的读取路径（验收 1 的数据库面）
// ---------------------------------------------------------------------------

export interface RuntimeConfigResolveInput {
  tenantId: string;
  workspaceId: string;
}

export interface RuntimeConfigService {
  /**
   * 按公司/团队解析运行配置。调用方必须已用受信 Scope 证明该主体在该
   * 公司/团队的有效成员资格（与 resource reader 同一契约）；本模块的
   * 数据库读取在受限角色 + 事务本地租户上下文 + RLS 下执行，跨公司的
   * 配置行按不可见处理。
   */
  resolve(input: RuntimeConfigResolveInput): Promise<ResolvedRuntimeConfig>;
}

/** 缺公司配置行的拒绝：多租户模式没有旧默认回退（绝不落到别的公司或部署默认）。 */
export const RUNTIME_CONFIG_NOT_FOUND = "RUNTIME_CONFIG_NOT_FOUND";

export function createRuntimeConfigService(
  data: DataDatabase,
): RuntimeConfigService {
  assertDataDatabase(data);
  return {
    async resolve({ tenantId, workspaceId }: RuntimeConfigResolveInput) {
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
            tenantId: enterpriseRuntimeConfigs.tenantId,
            document: enterpriseRuntimeConfigs.document,
            revision: enterpriseRuntimeConfigs.revision,
          })
          .from(enterpriseRuntimeConfigs)
          .where(eq(enterpriseRuntimeConfigs.tenantId, tenantId))
          .limit(1);
        // RLS 让「别的公司的配置行」与「不存在的配置行」同为 0 行：不存在
        // 与跨公司不可见对外不可区分，都没有默认回退。
        if (!companyRow) throw new Error(RUNTIME_CONFIG_NOT_FOUND);
        const [overrideRow] = await tx
          .select({
            document: enterpriseRuntimeConfigOverrides.document,
            revision: enterpriseRuntimeConfigOverrides.revision,
          })
          .from(enterpriseRuntimeConfigOverrides)
          .where(
            and(
              eq(enterpriseRuntimeConfigOverrides.tenantId, tenantId),
              eq(enterpriseRuntimeConfigOverrides.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        return resolveRuntimeConfig({
          tenantId,
          workspaceId,
          company: parseCompanyRuntimeConfigDocument(companyRow.document),
          companyRevision: companyRow.revision,
          override: overrideRow
            ? parseTeamRuntimeOverridesDocument(overrideRow.document)
            : null,
          overrideRevision: overrideRow ? overrideRow.revision : null,
        });
      });
    },
  };
}
