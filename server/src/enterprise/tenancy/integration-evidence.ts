// server/src/enterprise/tenancy/integration-evidence.ts
// MT111（Issue #154）：已启用集成的隔离与账户路由证据。
//
// 票面语义：对实际启用的外部集成（模型网关、观测后端等）提交隔离与账户
// 路由证据；未落地的设计不被当作已验证，计划中的配置也不算证据。本票
// 产出的是证据与状态，不是新功能实现。
//
// 结构（纯新增 + MT001 清单两处 expand-only 回写）：
//
//   1. 三类分类（AC1，闭集）：enabled-verified（已启用并验证——隔离与
//      付款账户路由各有仓内确定性/真实测试证据，且无需供应商侧即可完整
//      验证）/ enabled-unverified（已启用未验证——隔离与路由有本地确定性
//      证据，但供应商半边缺凭据未验证，AC3 的显式标记态）/ not-implemented
//      （未落地——只有设计或配置键映射，无真实消费者/证据）。三类各自
//      有依据：每条 registry 记录都带 basisRefs 指向真实仓内文件，测试
//      逐一核验文件存在——证据引用不存在即测试失败，编造不了。
//   2. 证据清单与 MT001 清单对账（AC4 回写）：registry 以 dependency 名
//      与 MT001 externalDependencies 逐条对齐；classifyIntegrationEvidence
//      输出 unmatchedInventory（清单里有、registry 没认领 = 缺口）与
//      unmatchedRegistry（registry 认领、清单看不见 = 清单提取缺口，
//      如 Bifrost 键经常量导出而非 environment.* 直读）。两侧任一非空
//      即非闭集，测试钉死。
//   3. 就绪闸（AC4）：integrationEvidenceReadiness——任何
//      enabled-unverified 或 not-implemented 项都让 ready=false 并列入
//      blockers（未验证项阻断 MT130 就绪；MT129/MT130 的就绪检查消费本
//      面，不在本票接装配）。
//   4. 本地确定性探针（AC2/AC3 半边）：模块只登记证据引用；行为性证据
//      由测试对真实 seam 复跑（Opik 企业提示拒绝、凭据形状脱敏、付款
//      账户类型闭集与派生键确定性、伪造 scope 拒绝），全部零供应商依赖。
//
// 边界（诚实披露）：
//   - 供应商半边（真实 Lago/Opik/Composio/沙箱等外部调用）在无外部凭据
//     的环境不可验证；integration 测试（opik-*.integration.test.ts 等）
//     需要显式 env 才跑，其存在不等于供应商验证已完成。
//   - Bifrost 模型网关在 MT001 清单提取器视野之外（键经
//     gateway/endpoint-config.ts 的常量导出而非 environment.* 直读）；
//     registry 以 inventoryVisibility: "extraction-gap" 如实登记，不借
//     清单不可见宣称「不在清单=无集成」。

/** 三类分类的闭集（AC1）。 */
export const INTEGRATION_EVIDENCE_CLASSES = [
  "enabled-verified",
  "enabled-unverified",
  "not-implemented",
] as const;
export type IntegrationEvidenceClass =
  (typeof INTEGRATION_EVIDENCE_CLASSES)[number];

/**
 * MT001 清单可见性：listed = 随真实配置键物化；extraction-gap = 真实键
 * 存在但提取器模式看不见（如 better-auth 的 process.env 直读、网关常量
 * 导出）；keys-absent = 键映射存在但无任何配置面读取（未落地面）。
 */
export type InventoryVisibility = "listed" | "extraction-gap" | "keys-absent";

export interface IntegrationEvidenceEntry {
  /** 稳定 id（kebab-case，报告与测试引用）。 */
  readonly id: string;
  /** 与 MT001 externalDependencies[].dependency 逐字一致的对齐键。 */
  readonly dependency: string;
  readonly classification: IntegrationEvidenceClass;
  readonly inventoryVisibility: InventoryVisibility;
  /** 该集成真实读取的配置键面（示例键，非全集）。 */
  readonly configKeys: readonly string[];
  /**
   * 隔离与付款账户路由的证据引用（仓库根相对路径）。enabled-* 必须非空；
   * 测试逐一核验文件存在。
   */
  readonly basisRefs: readonly string[];
  /** 付款账户路由结论：n/a（无付款语义）| per-company（公司↔Customer 映射）| deployment-key（部署级凭据，路由在本地账户层）。 */
  readonly payerRouting: "n/a" | "per-company" | "deployment-key";
  /** 负责票据。 */
  readonly ownerTicket: string;
  readonly note?: string;
}

const t = (path: string) => path;

/**
 * 证据清单（MT111 交付本体）。分类依据见各条 note；basisRefs 全部为仓内
 * 真实文件（测试核验存在性）。付款账户路由词汇来自 MT069 payer-accounts
 * 模型（company/personal 闭集 + 稳定外部客户键）。
 */
export const INTEGRATION_EVIDENCE: readonly IntegrationEvidenceEntry[] = [
  {
    id: "postgres-main",
    dependency: "PostgreSQL（主库）",
    classification: "enabled-verified",
    inventoryVisibility: "listed",
    configKeys: ["DATABASE_URL"],
    basisRefs: [
      t("server/tests/multitenancy/rls-core.test.ts"),
      t("server/src/db/schema/enterprise-tenancy.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT001",
    note: "企业域核心表 RLS + FORCE；隔离由 rls-core 与各 multitenancy 套件在真实库验证，无需供应商侧。",
  },
  {
    id: "postgres-enterprise-directory",
    dependency: "PostgreSQL（企业目录库）",
    classification: "enabled-verified",
    inventoryVisibility: "listed",
    configKeys: ["ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"],
    basisRefs: [
      t("server/src/enterprise/tenancy/connections.ts"),
      t("server/tests/multitenancy/rls-core.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT005",
    note: "受限角色能力核验（capability catalog）在连接建立时执行；身份面套件真实走 ob_ent_directory。",
  },
  {
    id: "postgres-enterprise-data",
    dependency: "PostgreSQL（企业数据库）",
    classification: "enabled-verified",
    inventoryVisibility: "listed",
    configKeys: ["ENTERPRISE_TEST_DATA_DATABASE_URL"],
    basisRefs: [
      t("server/tests/multitenancy/bots-ownership.test.ts"),
      t("server/tests/multitenancy/conversations-list.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT016",
    note: "业务域归属与越权不可见由各 multitenancy 套件在真实 RLS 下验证。",
  },
  {
    id: "postgres-tenant-runtime",
    dependency: "PostgreSQL（租户运行时库）",
    classification: "enabled-verified",
    inventoryVisibility: "listed",
    configKeys: ["TENANT_STORAGE_RUNTIME_DATABASE_URL"],
    basisRefs: [
      t("server/src/enterprise/conversations/store.ts"),
      t("server/tests/multitenancy/conversation-messages.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT021",
    note: "会话存储按租户库隔离；消息/会话套件在专用库验证。",
  },
  {
    id: "redis-workshop",
    dependency: "Redis（workshop 总线与锁）",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["OPENBOT_REDIS_URL", "WORKSHOP_REQUIRE_REDIS"],
    basisRefs: [
      t("server/src/redis.ts"),
      t("server/tests/workshop-bus.test.ts"),
      t("server/tests/workshop-locks.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT057",
    note: "总线与锁有本地确定性测试；真实 Redis 实例下的行为未在本环境验证（AC3 显式标记）。",
  },
  {
    id: "opik-observability",
    dependency: "Opik 观测后端",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["OPIK_ENABLED", "OPIK_BASE_URL", "OPIK_API_KEY"],
    basisRefs: [
      t("server/src/ai-observability/scope.ts"),
      t("server/tests/opik-control-plane-auth.test.ts"),
      t("server/tests/opik-bindings.test.ts"),
      t("server/tests/multitenancy/observability-authz.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT110",
    note: "隔离三环（scope 签发弱集、绑定行归属、公司查询/导出/trace 链接门）全部本地验证；供应商半边（真实 Opik 实例）缺凭据未验证。MT111 回写后 MT001 清单可见 OPIK_* 键。",
  },
  {
    id: "bifrost-model-gateway",
    dependency: "Bifrost 模型网关",
    classification: "enabled-unverified",
    inventoryVisibility: "extraction-gap",
    configKeys: ["BIFROST_GATEWAY_URL", "BIFROST_GATEWAY_REQUEST_TIMEOUT_MS"],
    basisRefs: [
      t("server/src/gateway/endpoint-config.ts"),
      t("server/tests/gateway-credential.test.ts"),
      t("server/tests/gateway-customer-provisioning.integration.test.ts"),
      t("server/tests/multitenancy/payer-accounts.test.ts"),
    ],
    payerRouting: "per-company",
    ownerTicket: "MT069",
    note: "网关凭据与按公司 Customer 供给有本地测试；真实网关实例未验证。键经常量导出（GATEWAY_URL_VARIABLE）而非 environment.* 直读，MT001 提取器不可见——extraction-gap 如实登记，非「不在清单」。",
  },
  {
    id: "lago-billing",
    dependency: "Lago 计费",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["LAGO_API_URL", "LAGO_API_KEY"],
    basisRefs: [
      t("server/tests/billing-lago-client.test.ts"),
      t("server/tests/multitenancy/payer-accounts.test.ts"),
      t("server/tests/multitenancy/settlement-idempotency.test.ts"),
    ],
    payerRouting: "per-company",
    ownerTicket: "MT069",
    note: "公司↔Customer 映射与结算幂等本地验证；真实 Lago API 调用未验证。",
  },
  {
    id: "alipay",
    dependency: "支付宝",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["ALIPAY_APP_ID"],
    basisRefs: [
      t("server/tests/payment-alipay.test.ts"),
      t("server/tests/payment-callback-ownership.integration.test.ts"),
    ],
    payerRouting: "deployment-key",
    ownerTicket: "MT072",
    note: "回调按原记录解析付款账户有本地测试；沙箱/生产网关未验证。",
  },
  {
    id: "wxpay",
    dependency: "微信支付",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["WXPAY_APP_ID"],
    basisRefs: [
      t("server/tests/payment-wechat.test.ts"),
      t("server/tests/payment-callback-ownership.integration.test.ts"),
    ],
    payerRouting: "deployment-key",
    ownerTicket: "MT072",
    note: "同支付宝：本地回调归属测试在，供应商半边未验证。",
  },
  {
    id: "composio-directory",
    dependency: "Composio 应用目录",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["COMPOSIO_API_KEY"],
    basisRefs: [
      t("server/tests/composio-transport.test.ts"),
      t("server/tests/composio-access.test.ts"),
      t("server/tests/multitenancy/credential-lease.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT031",
    note: "连接归属与凭据租约有本地测试；Composio 目录服务未验证。",
  },
  {
    id: "openconnector",
    dependency: "OpenConnector",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["OPENCONNECTOR_BASE_URL"],
    basisRefs: [
      t("server/tests/openconnector-transport.test.ts"),
      t("server/tests/openconnector-access.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT031",
    note: "适配层本地测试在；真实 OpenConnector 实例未验证。",
  },
  {
    id: "github-app",
    dependency: "GitHub App",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["GITHUB_APP_ID"],
    basisRefs: [
      t("server/tests/config-github-app.test.ts"),
      t("server/tests/identity-github-callback.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT026",
    note: "回调归属绑定本地验证；GitHub 侧未验证。",
  },
  {
    id: "google-oauth",
    dependency: "Google OAuth",
    classification: "enabled-unverified",
    inventoryVisibility: "extraction-gap",
    configKeys: ["GOOGLE_OAUTH_CLIENT_ID"],
    basisRefs: [
      t("server/src/google-oauth-transport.ts"),
      t("server/tests/google-oauth-transport.test.ts"),
      t("server/tests/multitenancy/oauth-state.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT028",
    note: "state 绑定与回调归属本地验证；Google 端未验证。键经 better-auth 的 process.env 直读（src/index.ts 装配），提取器模式看不见——extraction-gap。",
  },
  {
    id: "agent-computer-service",
    dependency: "agent-computer 服务",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["AGENT_COMPUTER_URL"],
    basisRefs: [
      t("server/tests/computer-gateway.test.ts"),
      t("server/tests/multitenancy/computer-allocation.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT046",
    note: "分配/接管隔离本地验证；真实 agent-computer 服务未验证。",
  },
  {
    id: "computer-infrastructure",
    dependency: "computer 基础设施",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["COMPUTER_PROVIDER"],
    basisRefs: [
      t("server/tests/computer-provider.test.ts"),
      t("server/tests/computer-session-guard.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT046",
    note: "会话守卫本地验证；真实基础设施未验证。",
  },
  {
    id: "codesandbox",
    dependency: "代码沙箱",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["COMPUTER_SANDBOX_URL", "SANDBOX_TOKEN"],
    basisRefs: [
      t("server/tests/codesandbox-gateway.test.ts"),
      t("server/tests/codesandbox-client.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT046",
    note: "沙箱网关本地测试在；CodeSandbox API 未验证。",
  },
  {
    id: "smtp-mail",
    dependency: "SMTP 邮件",
    classification: "not-implemented",
    inventoryVisibility: "keys-absent",
    configKeys: [],
    basisRefs: [t("server/scripts/multitenancy/inventory.ts")],
    payerRouting: "n/a",
    ownerTicket: "MT044",
    note: "EXTERNAL_DEPS 有键映射，但配置面无任何 SMTP_* 读取（仓内无消费者）——未落地，不作已启用计。",
  },
  {
    id: "aws-ses",
    dependency: "AWS SES",
    classification: "not-implemented",
    inventoryVisibility: "keys-absent",
    configKeys: [],
    basisRefs: [t("server/scripts/multitenancy/inventory.ts")],
    payerRouting: "n/a",
    ownerTicket: "MT044",
    note: "键映射在、配置面读取不在——未落地。",
  },
  {
    id: "aws-sns",
    dependency: "AWS SNS",
    classification: "not-implemented",
    inventoryVisibility: "keys-absent",
    configKeys: [],
    basisRefs: [t("server/scripts/multitenancy/inventory.ts")],
    payerRouting: "n/a",
    ownerTicket: "MT044",
    note: "键映射在、配置面读取不在——未落地。",
  },
  {
    id: "intelligence-runtime",
    dependency: "Intelligence 运行时",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["INTELLIGENCE_URL"],
    basisRefs: [
      t("server/src/intelligence-client.ts"),
      t("server/tests/intelligence-authentication.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT050",
    note: "客户端鉴权本地验证；真实 Intelligence 运行时未验证。",
  },
  {
    id: "copilotkit-runtime",
    dependency: "CopilotKit Runtime",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["COPILOTKIT_PUBLIC_URL"],
    basisRefs: [
      t("server/src/copilot.ts"),
      t("server/tests/copilot.test.ts"),
      t("server/tests/copilot-usage-meter.test.ts"),
    ],
    payerRouting: "deployment-key",
    ownerTicket: "MT049",
    note: "用量计量按付款账户归属本地验证；CopilotKit 云端未验证。",
  },
  {
    id: "managed-agent",
    dependency: "受管 Agent（AG-UI）",
    classification: "enabled-unverified",
    inventoryVisibility: "listed",
    configKeys: ["MANAGED_AGENT_URL"],
    basisRefs: [
      t("server/tests/multitenancy/agent-adapters.test.ts"),
      t("server/tests/multitenancy/runs-protocol.test.ts"),
    ],
    payerRouting: "n/a",
    ownerTicket: "MT049",
    note: "适配器归属与运行协议本地验证；外部受管 Agent 端点未验证。",
  },
];

/** 就绪结论（AC4）：未验证项阻断 MT130 就绪。 */
export interface IntegrationEvidenceReadiness {
  readonly ready: boolean;
  /** 阻断就绪的条目（enabled-unverified 与 not-implemented 全集）。 */
  readonly blockers: readonly {
    readonly id: string;
    readonly dependency: string;
    readonly classification: IntegrationEvidenceClass;
  }[];
  /** 提取缺口（registry 认领、MT001 清单不可见）。 */
  readonly extractionGaps: readonly string[];
}

/**
 * 证据清单与 MT001 清单对账（AC4 回写半边）。
 *
 * 输入是 MT001 真实 externalDependencies 条目（dependency 名对齐键）；
 * 两侧差集都是缺口：unmatchedInventory = 清单有而证据没认领（覆盖缺口），
 * unmatchedRegistry = 证据认领而清单看不见（提取缺口，不是无集成）。
 */
export function classifyIntegrationEvidence(
  inventoryDependencies: readonly { dependency: string }[],
): {
  readonly entries: readonly IntegrationEvidenceEntry[];
  readonly unmatchedInventory: readonly string[];
  readonly unmatchedRegistry: readonly string[];
} {
  const inventoryNames = new Set(
    inventoryDependencies.map((d) => d.dependency),
  );
  const byName = new Map(INTEGRATION_EVIDENCE.map((e) => [e.dependency, e]));
  const unmatchedInventory = [...inventoryNames]
    .filter((name) => !byName.has(name))
    .sort();
  // registry-only 名单只允许是自宣告不可见的条目（extraction-gap /
  // keys-absent）；自宣告 listed 却不物化 = 对账失败。
  const unmatchedRegistry = [...byName.entries()]
    .filter(
      ([name, entry]) =>
        !inventoryNames.has(name) && entry.inventoryVisibility === "listed",
    )
    .map(([name]) => name)
    .sort();
  return {
    entries: INTEGRATION_EVIDENCE,
    unmatchedInventory,
    unmatchedRegistry,
  };
}

/** AC4：就绪闸。任何未验证/未落地项阻断；提取缺口单独披露不并入 blockers。 */
export function integrationEvidenceReadiness(
  inventoryDependencies: readonly { dependency: string }[],
): IntegrationEvidenceReadiness {
  const { entries, unmatchedInventory, unmatchedRegistry } =
    classifyIntegrationEvidence(inventoryDependencies);
  const blockers = entries
    .filter((entry) => entry.classification !== "enabled-verified")
    .map((entry) => ({
      id: entry.id,
      dependency: entry.dependency,
      classification: entry.classification,
    }));
  const extractionGaps = entries
    .filter((entry) => entry.inventoryVisibility === "extraction-gap")
    .map((entry) => entry.dependency)
    .sort();
  return {
    ready:
      blockers.length === 0 &&
      unmatchedRegistry.length === 0 &&
      unmatchedInventory.length === 0,
    blockers,
    extractionGaps,
  };
}

/**
 * AC3 的防伪造守卫：一条证据若声明供应商侧已验证（词面上），它必须是
 * 真的——本仓测试环境没有供应商凭据，因此任何此类声明都算编造。测试
 * 用它钉死「整张清单零供应商已验证声明」。
 */
export function isVendorClaimPresent(entry: IntegrationEvidenceEntry): boolean {
  const vendorVerifiedPattern =
    /供应商已验证|供应商半边已验证|vendor[- ]verified|live[- ]verified/;
  return (
    vendorVerifiedPattern.test(entry.note ?? "") ||
    entry.basisRefs.some((ref) => vendorVerifiedPattern.test(ref))
  );
}
