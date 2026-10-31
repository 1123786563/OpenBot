// server/src/enterprise/tenancy/plugin-catalog.ts
// MT031（Issue #74）：插件目录与安装归属——目录只读，安装不全局。
//
// 票面：MCP/Composio/OpenConnector 等插件的公共目录可全局只读浏览，但安装、
// 配置与连接都归属发起的公司/团队；另一公司看不到也调用不到这些安装。
//
// 结构（三件事，全部纯新增；resource-policy / not-found-semantics /
// credential-ownership 按票面只读消费——本文件复用其事务形状、canonical
// deny 形状与 SecretVault seam，绝不改动它们）：
//
//   1. 公共目录（enterprise_plugin_catalog，MT031 迁移）：全局共享的只读
//      目录——存储形状上没有 tenant_id 列，受限业务角色零写授权，本模块也
//      不暴露任何目录写方法（目录策展是部署级行为）。视图只含公共面
//      （kind/title/vendor/source/summary），结构上不含公司私有配置。
//   2. 安装归属（enterprise_plugin_installs / enterprise_plugin_connections）：
//      安装固定公司与团队（tenant_id + workspace_id 双 NOT NULL 复合外键，
//      跨公司安装行结构上不可能）；连接绑定在安装上、随安装级联消亡。
//      config 闭形（秘密载体键两层被拒：模块入口 + 存储 CHECK）；秘密经
//      SecretVault 密封进 envelope，明文永不入库。
//   3. 判定入口（createPluginCatalogDecisionService）：受信 Scope
//      （assertTrustedScope）→ 受限 data 事务（read committed + 超时 +
//      事务本地 set_config + advisory 共享锁，键序 tenant → principal →
//      membership → workspace-membership → install，与 resource-policy /
//      credential-ownership 完全一致）→ 真实 RLS 下读事实 → 判定。deny 只有
//      一种形状 { outcome: "deny", code: "RESOURCE_NOT_FOUND" }（MT011
//      canonical）：不存在、跨公司、跨团队、已停用、已卸载在对外语义上
//      不可区分。
//
// 「不触发供应商调用」的实现面：authorizeInvoke 的 allow 变体独占携带密封
// 材料（envelope）与脱敏视图，deny 变体在类型上没有任何可执行物——调用方
// 只能在 allow 分支触达供应商。本模块自己从不发起任何外部调用；供应商调用
// 面经注入的 onVendorCall 探针可观测：计数恰好发生在 allow 判定产生的那个
// 语句之后、返回之前——deny 后计数不变是模块自身效果的观测（比 MT027 的
// 测试侧探针深一层）。
//
// T06.05（Issue #577）：describeTemplate 把「市场全局模板」与「已安装私有
// 实例」分开——模板公共面对任何已认证 scope 可见，privateInstance 只按
// describe 门对本范围可见（跨公司/跨团队 = null），查看模板不授实例/
// 连接/执行（各自独立判定面不变）。
//
// 脱敏面：RedactedCatalogView / RedactedInstallView / RedactedConnectionView
// 类型上没有 envelope/plaintext 字段；安装视图只暴露 hasSecret 存在性布尔。
// 列表只含本范围（scope 团队成员资格内）的安装——计数与条目都不泄露跨范围
// 存在性。模块零 console、零 process.env；拒绝消息只含代码与字段路径，
// 绝不回显任何值（与 MT014/MT015/MT027 同一纪律）。

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  enterprisePluginCatalog as catalogRows,
  enterprisePluginConnections as connectionRows,
  enterprisePluginInstalls as installRows,
} from "../../db/schema/enterprise-plugins";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import type { SecretVault } from "./credential-ownership";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

export type PluginCatalogKind = "mcp" | "composio" | "open-connector";
export type PluginCatalogSource = "first-party" | "custom";
export type PluginInstallStatus = "active" | "disabled";

/**
 * 密封材料 seam：直接消费 MT027 的 SecretVault 形状（credential-ownership.ts
 * 只读消费——生产装配接同一个 credentials.ts AES-GCM envelope）。
 */
export type { SecretVault } from "./credential-ownership";

/** 公共目录的脱敏视图：只含公共面，类型上没有 config/envelope 等私有面。 */
export interface RedactedCatalogView {
  readonly catalogId: string;
  readonly kind: PluginCatalogKind;
  readonly title: string;
  readonly vendor: string;
  readonly source: PluginCatalogSource;
  readonly summary: string;
}

/** 安装的脱敏视图：hasSecret 只暴露存在性布尔，类型上没有 envelope 字段。 */
export interface RedactedInstallView {
  readonly installId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly catalogId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly hasSecret: boolean;
  readonly status: PluginInstallStatus;
  readonly createdAt: string;
}

/** 连接的脱敏视图：vendor_ref 是非机密供应商侧别名；解绑 = 删行。 */
export interface RedactedConnectionView {
  readonly connectionId: string;
  readonly installId: string;
  readonly tenantId: string;
  readonly vendorRef: string;
  readonly createdAt: string;
}

/**
 * 调用判定。allow 独占携带密封材料（envelope，可为 null = 该安装无秘密）
 * 与脱敏视图；deny 是 canonical not-found，与「不存在」逐字节同形。
 */
export type PluginInvokeResolution =
  | {
      readonly outcome: "allow";
      readonly install: RedactedInstallView;
      readonly connection: RedactedConnectionView | null;
      readonly envelope: string | null;
    }
  | ResourceNotFoundVerdict;

export type PluginInstallResolution =
  | { readonly outcome: "allow"; readonly install: RedactedInstallView }
  | ResourceNotFoundVerdict;

/**
 * 模板视图判定（T06.05/#577）：全局目录条目对任何已认证 scope 可见，
 * 但视图绝不授私有安装——privateInstance 只在安装落于本 scope 的公司且
 * 其团队对 scope 主体持有 active 成员资格时非空（describe 门：与
 * describeInstall 同判；disabled 行对本范围属主如实可见）。跨公司/跨团队
 * 安装对模板视图为 null：模板与私有实例结构性分开。
 */
export type PluginTemplateResolution =
  | {
      readonly outcome: "allow";
      readonly template: RedactedCatalogView;
      readonly privateInstance: RedactedInstallView | null;
    }
  | ResourceNotFoundVerdict;

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

const INSTALL_STATUSES: readonly PluginInstallStatus[] = ["active", "disabled"];
const CONFIG_MAX_KEYS = 32;
const CONFIG_VALUE_MAX = 512;
const SECRET_MAX = 4096;
const VENDOR_REF_MAX = 512;

/**
 * 秘密载体键闭集：config 的模块入口拒绝与存储 CHECK（migration DDL 中的
 * ?| array[...]）保持同一闭集——两层独立防线，同一份清单。
 */
const CONFIG_SECRET_CARRIER_KEYS: readonly string[] = [
  "envelope",
  "plaintext",
  "secret",
  "value",
  "password",
  "token",
  "config",
  "apiKey",
  "api_key",
  "secretRef",
  "encryptedValue",
  "encrypted_value",
];

function requireString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`PLUGIN_INSTALL_INVALID: ${field}`);
  }
  return value;
}

function rejectExtraKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`${code}: unexpected field ${key}`);
    }
  }
}

/**
 * 闭形校验：config 只接受有限数量的平面 string/number/boolean 值，任何
 * 秘密载体键直接拒绝（秘密必须走指定的 sealed 通道，绝不混进 config）。
 */
function requireClosedConfig(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PLUGIN_INSTALL_INVALID: config");
  }
  const config = value as Record<string, unknown>;
  const keys = Object.keys(config);
  if (keys.length > CONFIG_MAX_KEYS) {
    throw new Error("PLUGIN_INSTALL_INVALID: config");
  }
  for (const key of keys) {
    if (CONFIG_SECRET_CARRIER_KEYS.includes(key)) {
      throw new Error("PLUGIN_INSTALL_INVALID: config");
    }
    const entry = config[key];
    if (
      !["string", "number", "boolean"].includes(typeof entry) ||
      entry === null
    ) {
      throw new Error("PLUGIN_INSTALL_INVALID: config");
    }
    if (typeof entry === "string" && entry.length > CONFIG_VALUE_MAX) {
      throw new Error("PLUGIN_INSTALL_INVALID: config");
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// 归属写面（受限 operator 通道；缺通道 fail-closed——装配侧保持 null）
// ---------------------------------------------------------------------------

export interface PluginCatalogAdminService {
  /** 安装一个目录条目到本公司某团队；秘密经 vault 密封后入库。 */
  install(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly installedBy: string;
    readonly catalogId: string;
    readonly config?: Record<string, unknown>;
    readonly secret?: string;
  }): Promise<{ readonly installId: string }>;
  /** 卸载本范围安装（删除行，连接级联）；他司/不存在 = removed:false。 */
  uninstall(input: {
    readonly tenantId: string;
    readonly installId: string;
  }): Promise<{ readonly removed: boolean }>;
  /** 停用/启用本范围安装（状态闸门）；他司/不存在 = updated:false。 */
  setEnabled(input: {
    readonly tenantId: string;
    readonly installId: string;
    readonly status: PluginInstallStatus;
  }): Promise<{ readonly updated: boolean }>;
  /** 在本范围安装上绑定一条连接；安装不存在/跨公司 = FK 兜底。 */
  bindConnection(input: {
    readonly tenantId: string;
    readonly installId: string;
    readonly boundBy: string;
    readonly vendorRef: string;
  }): Promise<{ readonly connectionId: string }>;
  /** 解绑本范围连接（删除行）；他司/不存在 = removed:false。 */
  unbindConnection(input: {
    readonly tenantId: string;
    readonly connectionId: string;
  }): Promise<{ readonly removed: boolean }>;
}

export function createPluginCatalogAdminService(
  operator: OperatorDatabase,
  vault: SecretVault,
): PluginCatalogAdminService {
  assertOperatorDatabase(operator);
  return {
    async install(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(
        input as unknown as Record<string, unknown>,
        [
          "tenantId",
          "workspaceId",
          "installedBy",
          "catalogId",
          "config",
          "secret",
        ],
        "PLUGIN_INSTALL_INVALID",
      );
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const workspaceId = requireString(
        input.workspaceId,
        "workspaceId",
        1,
        128,
      );
      const installedBy = requireString(
        input.installedBy,
        "installedBy",
        1,
        128,
      );
      const catalogId = requireString(input.catalogId, "catalogId", 1, 128);
      const config = requireClosedConfig(input.config);
      if (input.secret !== undefined) {
        requireString(input.secret, "secret", 1, SECRET_MAX);
      }
      const installId = randomUUID();
      const envelope =
        input.secret === undefined ? null : await vault.seal(input.secret);
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.insert(installRows).values({
          tenantId,
          id: installId,
          catalogId,
          workspaceId,
          installedBy,
          config,
          envelope,
          status: "active",
        });
      });
      return { installId };
    },

    async uninstall(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(
        input as unknown as Record<string, unknown>,
        ["tenantId", "installId"],
        "PLUGIN_UNINSTALL_INVALID",
      );
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const installId = requireString(input.installId, "installId", 1, 128);
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const deleted = await tx
          .delete(installRows)
          .where(
            and(
              eq(installRows.tenantId, tenantId),
              eq(installRows.id, installId),
            ),
          )
          .returning({ id: installRows.id });
        return { removed: deleted.length > 0 };
      });
    },

    async setEnabled(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(
        input as unknown as Record<string, unknown>,
        ["tenantId", "installId", "status"],
        "PLUGIN_SETSTATUS_INVALID",
      );
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const installId = requireString(input.installId, "installId", 1, 128);
      if (!INSTALL_STATUSES.includes(input.status)) {
        throw new Error("PLUGIN_SETSTATUS_INVALID: status");
      }
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const updated = await tx
          .update(installRows)
          .set({ status: input.status, updatedAt: new Date() })
          .where(
            and(
              eq(installRows.tenantId, tenantId),
              eq(installRows.id, installId),
            ),
          )
          .returning({ id: installRows.id });
        return { updated: updated.length > 0 };
      });
    },

    async bindConnection(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(
        input as unknown as Record<string, unknown>,
        ["tenantId", "installId", "boundBy", "vendorRef"],
        "PLUGIN_BIND_INVALID",
      );
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const installId = requireString(input.installId, "installId", 1, 128);
      const boundBy = requireString(input.boundBy, "boundBy", 1, 128);
      const vendorRef = requireString(
        input.vendorRef,
        "vendorRef",
        1,
        VENDOR_REF_MAX,
      );
      const connectionId = randomUUID();
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        // 重绑收敛（OCR R5-H-B）：同 (install, boundBy) 作用域旧行——含
        // 历史残留的重复行——先删再插，一个作用域恒一行，派发的「最近
        // 绑定」选取因此总有唯一答案；旧 proposal 钉扎的连接随之失效。
        await tx
          .delete(connectionRows)
          .where(
            and(
              eq(connectionRows.tenantId, tenantId),
              eq(connectionRows.installId, installId),
              eq(connectionRows.boundBy, boundBy),
            ),
          );
        await tx.insert(connectionRows).values({
          tenantId,
          id: connectionId,
          installId,
          boundBy,
          vendorRef,
        });
      });
      return { connectionId };
    },

    async unbindConnection(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(
        input as unknown as Record<string, unknown>,
        ["tenantId", "connectionId"],
        "PLUGIN_UNBIND_INVALID",
      );
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const connectionId = requireString(
        input.connectionId,
        "connectionId",
        1,
        128,
      );
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const deleted = await tx
          .delete(connectionRows)
          .where(
            and(
              eq(connectionRows.tenantId, tenantId),
              eq(connectionRows.id, connectionId),
            ),
          )
          .returning({ id: connectionRows.id });
        return { removed: deleted.length > 0 };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 事实形状 + 判定
// ---------------------------------------------------------------------------

interface InstallFacts {
  readonly install: {
    readonly id: string;
    readonly tenantId: string;
    readonly catalogId: string;
    readonly workspaceId: string;
    readonly config: unknown;
    readonly envelope: string | null;
    readonly status: string;
    readonly createdAt: Date;
  } | null;
  readonly companyMembership: { status: string; epoch: number } | null;
  readonly workspaceMembershipStatus: string | null;
}

interface ConnectionFacts {
  readonly connection: {
    readonly id: string;
    readonly installId: string;
    readonly tenantId: string;
    readonly vendorRef: string;
    readonly createdAt: Date;
  } | null;
  readonly installFacts: InstallFacts;
}

function redactedInstallView(
  install: NonNullable<InstallFacts["install"]>,
): RedactedInstallView {
  return Object.freeze({
    installId: install.id,
    tenantId: install.tenantId,
    workspaceId: install.workspaceId,
    catalogId: install.catalogId,
    config: Object.freeze({ ...(install.config as Record<string, unknown>) }),
    hasSecret: install.envelope !== null,
    status: install.status as PluginInstallStatus,
    createdAt: install.createdAt.toISOString(),
  });
}

function redactedConnectionView(
  connection: NonNullable<ConnectionFacts["connection"]>,
): RedactedConnectionView {
  return Object.freeze({
    connectionId: connection.id,
    installId: connection.installId,
    tenantId: connection.tenantId,
    vendorRef: connection.vendorRef,
    createdAt: connection.createdAt.toISOString(),
  });
}

/**
 * 判定核心：公司成员资格 active 且 epoch 与 scope 一致 + 团队成员资格
 * active + 目录条目存在。invoke 额外要求安装 active（停用是调用闸门）；
 * describe 允许 disabled 行（本范围事实如实可见：属主需要看到它被停用）。
 * deny 全部折叠为 canonical not-found。
 */
function decideInstall(
  scope: PlatformScope,
  facts: InstallFacts,
  gate: "invoke" | "describe",
): boolean {
  const install = facts.install;
  if (!install) return false;
  if (gate === "invoke" && install.status !== "active") return false;
  if (!facts.companyMembership) return false;
  if (facts.companyMembership.status !== "active") return false;
  if (facts.companyMembership.epoch !== scope.memberEpoch) return false;
  return facts.workspaceMembershipStatus === "active";
}

/**
 * 判定入口：受信 Scope → 受限角色事务 → 事实读取 → 判定。
 */
export interface PluginCatalogDecisionService {
  /** 公共目录（全局只读）：每家公司看到同一份公共条目。 */
  listCatalog(scope: PlatformScope): Promise<readonly RedactedCatalogView[]>;
  /**
   * 模板视图（T06.05）：公共模板面 + 本范围私有安装（无权/跨范围 =
   * null——查看模板不授私有实例/连接/执行，那些走各自独立判定面）。
   */
  describeTemplate(
    scope: PlatformScope,
    catalogId: string,
  ): Promise<PluginTemplateResolution>;
  /** 本范围安装列表（scope 团队成员资格内；计数不泄露跨范围存在性）。 */
  listInstalls(scope: PlatformScope): Promise<readonly RedactedInstallView[]>;
  /** 脱敏详情；跨范围/不存在 = canonical not-found。 */
  describeInstall(
    scope: PlatformScope,
    installId: string,
  ): Promise<PluginInstallResolution>;
  /**
   * 业务调用判定（安装 ID 或连接 ID）：allow 独占携带密封材料；deny =
   * canonical not-found。注入的 onVendorCall 恰在 allow 判定产生时触发。
   */
  authorizeInvoke(
    scope: PlatformScope,
    ref: { readonly installId: string } | { readonly connectionId: string },
  ): Promise<PluginInvokeResolution>;
  /** 本范围某安装的连接列表；他司安装同形为空列表（计数不泄露存在性）。 */
  listConnections(
    scope: PlatformScope,
    installId: string,
  ): Promise<readonly RedactedConnectionView[]>;
}

/** 事务本地上下文 + advisory 共享锁（键序/键形与 credential-ownership 一致）。 */
async function pluginReadTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  operation: (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership → install
    // （install 级共享锁在操作内取；同一事务取多把 install 锁时按 install id
    // 排序，describeTemplate 的多安装读取即此款。）
    for (const key of [
      JSON.stringify(["enterprise", "tenant", scope.tenantId]),
      JSON.stringify(["enterprise", "principal", scope.principalId]),
      JSON.stringify([
        "enterprise",
        "membership",
        scope.tenantId,
        scope.principalId,
      ]),
      workspaceMembershipLockKey(
        scope.tenantId,
        scope.workspaceId,
        scope.principalId,
      ),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
    return operation(tx);
  });
}

function installLockKey(tenantId: string, installId: string): string {
  return JSON.stringify(["enterprise", "plugin-install", tenantId, installId]);
}

/**
 * 判定服务。事实读取全部经受限 data 角色与真实 RLS：跨公司安装行对本事务
 * 不可见（事实即为「不存在」），判定内的租户/成员比对是第二道独立防线
 * （纵深防御）。供应商调用面经注入探针可观测：onVendorCall 恰在 allow
 * 判定产生时触发一次，deny/错误路径绝不触发。
 */
export function createPluginCatalogDecisionService(
  data: DataDatabase,
  probes?: { readonly onVendorCall?: () => void },
): PluginCatalogDecisionService {
  assertDataDatabase(data);
  const notifyVendorCall = (): void => {
    try {
      probes?.onVendorCall?.();
    } catch {
      // 探针是观测面不是判定面：观测者故障绝不影响判定结果。
    }
  };

  /** 读取单个安装的判定事实（调用方已在 pluginReadTransaction 内）。 */
  const readInstallFacts = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: PlatformScope,
    installId: string,
    installKey: string,
  ): Promise<InstallFacts> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${installKey}, 0))`,
    );
    const [row] = await tx
      .select({
        id: installRows.id,
        tenantId: installRows.tenantId,
        catalogId: installRows.catalogId,
        workspaceId: installRows.workspaceId,
        config: installRows.config,
        envelope: installRows.envelope,
        status: installRows.status,
        createdAt: installRows.createdAt,
        membershipStatus: enterpriseMemberships.status,
        membershipEpoch: enterpriseMemberships.epoch,
        workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
      })
      .from(installRows)
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, installRows.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, installRows.tenantId),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            installRows.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(installRows.tenantId, scope.tenantId),
          eq(installRows.id, installId),
        ),
      )
      .limit(1);
    if (!row) {
      return {
        install: null,
        companyMembership: null,
        workspaceMembershipStatus: null,
      };
    }
    return {
      install: {
        id: row.id,
        tenantId: row.tenantId,
        catalogId: row.catalogId,
        workspaceId: row.workspaceId,
        config: row.config,
        envelope: row.envelope,
        status: row.status,
        createdAt: row.createdAt,
      },
      companyMembership:
        row.membershipStatus == null || row.membershipEpoch == null
          ? null
          : { status: row.membershipStatus, epoch: row.membershipEpoch },
      workspaceMembershipStatus: row.workspaceMembershipStatus ?? null,
    };
  };

  /** 读取单条连接及其所属安装的判定事实（同一事务内）。 */
  const readConnectionFacts = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: PlatformScope,
    connectionId: string,
  ): Promise<ConnectionFacts> => {
    const [row] = await tx
      .select({
        id: connectionRows.id,
        installId: connectionRows.installId,
        tenantId: connectionRows.tenantId,
        vendorRef: connectionRows.vendorRef,
        createdAt: connectionRows.createdAt,
      })
      .from(connectionRows)
      .where(
        and(
          eq(connectionRows.tenantId, scope.tenantId),
          eq(connectionRows.id, connectionId),
        ),
      )
      .limit(1);
    if (!row) {
      return {
        connection: null,
        installFacts: {
          install: null,
          companyMembership: null,
          workspaceMembershipStatus: null,
        },
      };
    }
    // 连接的复合外键保证它与安装同公司；安装事实按连接指向的安装读取，
    // advisory 锁以安装行为键（连接的变更与安装共享同一租户写序）。
    const installFacts = await readInstallFacts(
      tx,
      scope,
      row.installId,
      installLockKey(scope.tenantId, row.installId),
    );
    return { connection: row, installFacts };
  };

  return {
    async listCatalog(scope) {
      assertTrustedScope(scope);
      return pluginReadTransaction(data, scope, async (tx) => {
        const rows = await tx
          .select({
            id: catalogRows.id,
            kind: catalogRows.kind,
            title: catalogRows.title,
            vendor: catalogRows.vendor,
            source: catalogRows.source,
            metadata: catalogRows.metadata,
          })
          .from(catalogRows)
          .orderBy(asc(catalogRows.id));
        return rows.map((row) =>
          Object.freeze({
            catalogId: row.id,
            kind: row.kind as PluginCatalogKind,
            title: row.title,
            vendor: row.vendor,
            source: row.source as PluginCatalogSource,
            summary: String(
              (row.metadata as { summary?: unknown }).summary ?? "",
            ),
          }),
        );
      });
    },

    async describeTemplate(scope, catalogId) {
      assertTrustedScope(scope);
      if (typeof catalogId !== "string" || !catalogId.trim()) {
        return DENY_VERDICT;
      }
      return pluginReadTransaction(data, scope, async (tx) => {
        const [template] = await tx
          .select({
            id: catalogRows.id,
            kind: catalogRows.kind,
            title: catalogRows.title,
            vendor: catalogRows.vendor,
            source: catalogRows.source,
            metadata: catalogRows.metadata,
          })
          .from(catalogRows)
          .where(eq(catalogRows.id, catalogId))
          .limit(1);
        if (!template) return DENY_VERDICT;
        // 安装锁与 readInstallFacts 同族（共享锁）；候选集先按 id 预扫再
        // 逐把获取，多把按 id 排序防交叉死锁。
        const candidates = await tx
          .select({ id: installRows.id })
          .from(installRows)
          .where(
            and(
              eq(installRows.tenantId, scope.tenantId),
              eq(installRows.catalogId, catalogId),
            ),
          );
        for (const id of candidates.map((row) => row.id).sort()) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${installLockKey(scope.tenantId, id)}, 0))`,
          );
        }
        // 本范围私有安装（describe 门：公司 active+epoch 一致 + 安装所在
        // 团队对 scope 主体 active；RLS 使跨公司安装行对本事务不可见——
        // 判定内比对是第二道防线）。资格逐行评估，多条命中取最早已安装的
        // 有资格行（确定性答案）：其他团队的更早安装不遮蔽本团队自己的。
        const installs = await tx
          .select({
            id: installRows.id,
            tenantId: installRows.tenantId,
            catalogId: installRows.catalogId,
            workspaceId: installRows.workspaceId,
            config: installRows.config,
            envelope: installRows.envelope,
            status: installRows.status,
            createdAt: installRows.createdAt,
            membershipStatus: enterpriseMemberships.status,
            membershipEpoch: enterpriseMemberships.epoch,
            workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(installRows)
          .leftJoin(
            enterpriseMemberships,
            and(
              eq(enterpriseMemberships.tenantId, installRows.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
            ),
          )
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, installRows.tenantId),
              eq(
                enterpriseWorkspaceMemberships.workspaceId,
                installRows.workspaceId,
              ),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(
            and(
              eq(installRows.tenantId, scope.tenantId),
              eq(installRows.catalogId, catalogId),
            ),
          )
          .orderBy(asc(installRows.createdAt), asc(installRows.id));
        const install = installs.find(
          (row) =>
            row.membershipStatus === "active" &&
            row.membershipEpoch === scope.memberEpoch &&
            row.workspaceMembershipStatus === "active",
        );
        return {
          outcome: "allow" as const,
          template: Object.freeze({
            catalogId: template.id,
            kind: template.kind as PluginCatalogKind,
            title: template.title,
            vendor: template.vendor,
            source: template.source as PluginCatalogSource,
            summary: String(
              (template.metadata as { summary?: unknown }).summary ?? "",
            ),
          }),
          privateInstance: install ? redactedInstallView(install) : null,
        };
      });
    },

    async listInstalls(scope) {
      assertTrustedScope(scope);
      return pluginReadTransaction(data, scope, async (tx) => {
        const rows = await tx
          .select({
            id: installRows.id,
            tenantId: installRows.tenantId,
            catalogId: installRows.catalogId,
            workspaceId: installRows.workspaceId,
            config: installRows.config,
            envelope: installRows.envelope,
            status: installRows.status,
            createdAt: installRows.createdAt,
            workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(installRows)
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, installRows.tenantId),
              eq(
                enterpriseWorkspaceMemberships.workspaceId,
                installRows.workspaceId,
              ),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(eq(installRows.tenantId, scope.tenantId))
          .orderBy(asc(installRows.createdAt), asc(installRows.id));
        // 团队可见性：只含 scope 主体持有 active 成员资格的团队的安装。
        return rows
          .filter((row) => row.workspaceMembershipStatus === "active")
          .map((row) =>
            redactedInstallView({
              id: row.id,
              tenantId: row.tenantId,
              catalogId: row.catalogId,
              workspaceId: row.workspaceId,
              config: row.config,
              envelope: row.envelope,
              status: row.status,
              createdAt: row.createdAt,
            }),
          );
      });
    },

    async describeInstall(scope, installId) {
      assertTrustedScope(scope);
      if (typeof installId !== "string" || !installId.trim()) {
        return DENY_VERDICT;
      }
      return pluginReadTransaction(data, scope, async (tx) => {
        const installKey = installLockKey(scope.tenantId, installId);
        const facts = await readInstallFacts(tx, scope, installId, installKey);
        if (!decideInstall(scope, facts, "describe") || !facts.install) {
          return DENY_VERDICT;
        }
        return {
          outcome: "allow" as const,
          install: redactedInstallView(facts.install),
        };
      });
    },

    async authorizeInvoke(scope, ref) {
      assertTrustedScope(scope);
      if (typeof ref !== "object" || ref === null) {
        return DENY_VERDICT;
      }
      const installId = (ref as { installId?: unknown }).installId;
      const connectionId = (ref as { connectionId?: unknown }).connectionId;
      const hasInstallId = typeof installId === "string" && installId.trim();
      const hasConnectionId =
        typeof connectionId === "string" && connectionId.trim();
      if (hasInstallId === hasConnectionId) {
        // 恰好一个引用面；两者皆无或皆有 = 同一 canonical deny（无存在性信号）。
        return DENY_VERDICT;
      }
      return pluginReadTransaction(data, scope, async (tx) => {
        if (hasInstallId) {
          const key = installLockKey(scope.tenantId, installId as string);
          const facts = await readInstallFacts(
            tx,
            scope,
            installId as string,
            key,
          );
          if (!decideInstall(scope, facts, "invoke") || !facts.install) {
            return DENY_VERDICT;
          }
          notifyVendorCall();
          return {
            outcome: "allow" as const,
            install: redactedInstallView(facts.install),
            connection: null,
            envelope: facts.install.envelope,
          };
        }
        const facts = await readConnectionFacts(
          tx,
          scope,
          connectionId as string,
        );
        if (!facts.connection) return DENY_VERDICT;
        if (
          !decideInstall(scope, facts.installFacts, "invoke") ||
          !facts.installFacts.install
        ) {
          return DENY_VERDICT;
        }
        notifyVendorCall();
        return {
          outcome: "allow" as const,
          install: redactedInstallView(facts.installFacts.install),
          connection: redactedConnectionView(facts.connection),
          envelope: facts.installFacts.install.envelope,
        };
      });
    },

    async listConnections(scope, installId) {
      assertTrustedScope(scope);
      if (typeof installId !== "string" || !installId.trim()) {
        return [];
      }
      return pluginReadTransaction(data, scope, async (tx) => {
        // 他司/不存在/无权安装 → 同形空列表：计数不泄露存在性。
        const [install] = await tx
          .select({ id: installRows.id })
          .from(installRows)
          .where(
            and(
              eq(installRows.tenantId, scope.tenantId),
              eq(installRows.id, installId),
            ),
          )
          .limit(1);
        if (!install) return [];
        const rows = await tx
          .select({
            id: connectionRows.id,
            installId: connectionRows.installId,
            tenantId: connectionRows.tenantId,
            vendorRef: connectionRows.vendorRef,
            createdAt: connectionRows.createdAt,
          })
          .from(connectionRows)
          .where(
            and(
              eq(connectionRows.tenantId, scope.tenantId),
              eq(connectionRows.installId, installId),
            ),
          )
          .orderBy(asc(connectionRows.createdAt), asc(connectionRows.id));
        return rows.map(redactedConnectionView);
      });
    },
  };
}
