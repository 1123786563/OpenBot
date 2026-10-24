// server/src/enterprise/plugin-packages/dispatch.ts
// PKG05（Issue #464，Spec §9/§7.2）：受管工具派发——Run 钉扎之后的工具执行链。
//
// 结构（真实数据角色 + 真实 RLS，零缓存判定）：
//
//   1. resolveManagedAccess：把包资源连接解析成进程内访问对象。复用既有
//      判定（PluginCatalogDecisionService.authorizeInvoke 的安装/连接/
//      成员资格臂；MT027 SecretVault 解密封），不建平行表；包内 URL 永远
//      不成为目标——目标只来自 MT031 安装自身的 config。
//   2. beginDispatch：CAS `prepared → dispatched` 是唯一允许发送的线性化
//      点。事务取 Spec §8 锁序（成员 → install → grant(bot) →
//      connector-install → connection → operation；成员/事实锁取共享臂，
//      与停用/撤权的独占臂互斥——谁先提交谁赢），重验 Run/attempt lease、
//      原范围、Bot ownership、pin、包未撤回、install enabled/generation、
//      范围 grant（工具 ref/schema digest/effect）、连接 generation 与
//      账号实际权限（authorizeToolInvocation）。事务提交后才交 transport，
//      网络等待不持 DB 锁。
//   3. completeDispatch：按原 operation 写回真实结果。撤权不丢已发生
//      效果——完成写不做任何授权重验；failed 不暗示外部效果为 none；
//      crash/写超时记 unknown，绝不自动重发。
//   4. preparePackageTool/cancelPackageTool：callTool 包分支的审批前置
//      面——策略/审批门打开前先落 prepared 行并解析票面（effect/schema
//      digest/连接 generation），策略拒绝转 cancelled，审批挂起保留
//      prepared，批准后 dispatch 重验全部事实再放行（A07）。

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  packageToolRefFor,
  parsePackageToolRef,
} from "../../../../shared/enterprise/plugin-package-contracts";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import { enterpriseExpertVersions } from "../../db/schema/enterprise-expert-versions";
import {
  enterprisePackageDispatches as dispatchRows,
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterpriseRunPackagePins as pinRows,
} from "../../db/schema/enterprise-plugin-packages";
import {
  enterprisePluginCatalog,
  enterprisePluginConnections,
  enterprisePluginInstalls,
} from "../../db/schema/enterprise-plugins";
import { enterpriseRuns } from "../../db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PackageCatalogue } from "../../plugin-packages/catalogue";
import type { PackageToolTicket } from "../../plugins/package-tools";
import { transportFor } from "../../plugins/transport";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import type { SecretVault } from "../tenancy/credential-ownership";
import type { PluginCatalogDecisionService } from "../tenancy/plugin-catalog";
import { workspaceMembershipLockKey } from "../tenancy/scope-gate";
import { assertTrustedScope } from "../tenancy/store";
import type { ToolInvocationService } from "../tenancy/tool-invocation";
import { addedToolsOf, canonicalJson, sha256Hex } from "./plans";

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

export type PackageDispatchState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";

/**
 * 服务端内部拒绝词表（非 wire 词汇：这些码不进 HTTP，只进 store 分支的
 * 拒绝句与测试断言）。跨范围/不存在/无 lease/绑定不在 pin 内一律折叠成
 * canonical NOT_AVAILABLE——不泄露存在性；本人可见的事实（本人无连接、
 * Bot 不可用）用可解释码。
 */
export type PackageDispatchRefusalCode =
  | "NOT_AVAILABLE"
  | "RUN_LEASE_INVALID"
  | "PACKAGE_WITHDRAWN"
  | "CONNECTION_UNAVAILABLE"
  | "BOT_NOT_USABLE"
  | "CONNECTION_CHANGED"
  | "DUPLICATE_DISPATCH"
  | "ARGS_CHANGED";

export type PackageDispatchVerdict =
  | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode }
  | { readonly outcome: "ready" };

/** Spec §7.2 `BeginPackageDispatchInput`. */
export interface BeginPackageDispatchInput {
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly toolCallId: string;
  /**
   * Spec §7.2 `bindingId`：`pkg:<installId>:<resourceId>/<toolName>`，只解析
   * 到该 Run 快照（pin.allowed_tool_bindings）中的工具。
   */
  readonly bindingId: string;
  readonly args: Record<string, unknown>;
  /**
   * A07: when the call came through an approval proposal, the connection facts
   * that proposal was approved against. A re-bound connection (new row or new
   * generation) refuses the stale proposal at the CAS — never at the vendor.
   */
  readonly expectedConnection?: {
    readonly connectionId: string | null;
    readonly generation: number;
  };
}

/** Spec §9 `resolveManagedAccess` 的进程内访问对象。 */
export interface ResolvedManagedAccess {
  readonly connectorInstallId: string;
  readonly connectionId: string | null;
  readonly connectionGeneration: number;
  readonly catalogKind: string;
  /** 来自 MT031 安装自身 config 的受管端点；包内 URL 永远不进来。 */
  readonly url: string | null;
  /** envelope 解封出的凭据；仅进程内，永不入库/日志/模型。 */
  readonly token: string | null;
  readonly accountHandle: string | null;
  readonly actorId: string;
  readonly botId: string;
}

/** Spec §7.2 `DispatchPermit` — 进程内对象，永不落库、永不出进程。 */
export interface DispatchPermit {
  readonly operationId: string;
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly toolCallId: string;
  readonly installId: string;
  readonly resourceId: string;
  readonly toolName: string;
  readonly toolRef: string;
  readonly connectorInstallId: string;
  readonly connectionId: string | null;
  readonly connectionGeneration: number;
  readonly argsDigest: string;
  readonly effect: "read" | "write";
  readonly access: ResolvedManagedAccess;
}

/** Spec §7.2 `DispatchResult`（含既有工具回执事实）。 */
export interface PackageDispatchCompletion {
  readonly state: "succeeded" | "failed" | "unknown";
  /** none/confirmed/unknown — failed 不暗示 none。 */
  readonly effectStatus: "none" | "confirmed" | "unknown";
  readonly receiptRef?: Record<string, unknown>;
  readonly errorCode?: string;
}

export type PackageVendorCaller = (
  access: ResolvedManagedAccess,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

/** store 分支（plugins/package-tools.ts）消费的派发面。 */
export type PinnedToolBindingFact = {
  readonly installId: string;
  readonly resourceId: string;
  readonly toolRef: string;
  readonly schemaDigest: string;
  readonly effect: "read" | "write";
  readonly connectorInstallId: string;
};

export type PinnedToolsReader = (
  scope: PlatformScope,
  input: { botId: string; runId: string; attemptGeneration: number },
) => Promise<readonly PinnedToolBindingFact[]>;

/** callTool 包分支在审批门之前拿到的票面（无秘密；seam 类型单一事实源）。 */
export type { PackageToolTicket } from "../../plugins/package-tools";

export type PackageToolPrepareInput = {
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly toolCallId: string;
  readonly ref: string;
  readonly args: Record<string, unknown>;
  readonly botId: string;
};

export type PackageToolDispatchResult =
  | { readonly outcome: "ok"; readonly text: string; readonly isError: boolean }
  | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode };

export interface PackageDispatchService {
  /**
   * Spec §9 线性化点：重验全部事实后 CAS `prepared → dispatched`。返回的
   * permit 已携带解析好的受管访问对象（锁内解封）；网络等待在其后，不持
   * 任何 DB 锁。重复 toolCallId、任何事实失效 → typed refusal，transport
   * 调用次数为 0。
   */
  beginDispatch(
    scope: PlatformScope,
    input: BeginPackageDispatchInput,
  ): Promise<
    | { readonly outcome: "permit"; readonly permit: DispatchPermit }
    | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode }
  >;
  /** 按原 operation 写回真实结果；撤权后仍可写（不丢已发生效果）。 */
  completeDispatch(
    scope: PlatformScope,
    permit: DispatchPermit,
    completion: PackageDispatchCompletion,
  ): Promise<void>;
  /** 派发前取消（策略拒绝/审批拒绝）：prepared → cancelled。 */
  cancelDispatch(
    scope: PlatformScope,
    input: {
      runId: string;
      attemptGeneration: number;
      toolCallId: string;
    },
  ): Promise<void>;
  /** 崩溃/写超时后的 unknown 记账（人工/清扫入口；绝不自动重发）。 */
  markUnknown(
    scope: PlatformScope,
    input: {
      runId: string;
      attemptGeneration: number;
      toolCallId: string;
      errorCode?: string;
    },
  ): Promise<boolean>;
  /** 便捷链：begin → transport → complete；写超时/崩溃 → unknown。 */
  execute(
    scope: PlatformScope,
    input: BeginPackageDispatchInput,
  ): Promise<
    | {
        readonly outcome: "ok";
        readonly text: string;
        readonly isError: boolean;
        readonly state: PackageDispatchState;
      }
    | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode }
  >;
  /** 该 Run 快照当前仍可派发的工具绑定（readPinnedTools 的透传视图）。 */
  listPinnedTools(
    scope: PlatformScope,
    input: { botId: string; runId: string; attemptGeneration: number },
  ): Promise<readonly PinnedToolBindingFact[]>;
  /** Spec §9 的连接访问解析（判定面；无网络副作用）。 */
  resolveManagedAccess(
    scope: PlatformScope,
    input: {
      connectorInstallId: string;
      connectionId?: string;
      botId: string;
      toolRef: string;
    },
  ): Promise<
    | { readonly outcome: "allow"; readonly access: ResolvedManagedAccess }
    | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode }
  >;
  /** 读取一个派发行的当前事实（测试/审计面；不携带秘密）。 */
  readDispatch(
    scope: PlatformScope,
    input: { runId: string; attemptGeneration: number; toolCallId: string },
  ): Promise<{
    state: PackageDispatchState;
    argsDigest: string;
    effect: string;
    connectionGeneration: number;
    receiptRef: Record<string, unknown> | null;
    errorCode: string | null;
  } | null>;
  /** callTool 包分支：审批门前的完整重验 + prepared 落行。 */
  preparePackageTool(
    scope: PlatformScope,
    input: PackageToolPrepareInput,
  ): Promise<
    | { readonly outcome: "ticket"; readonly ticket: PackageToolTicket }
    | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode }
  >;
  /** callTool 包分支：审批门后的 CAS + transport + 完成写回。 */
  dispatchPackageTool(
    scope: PlatformScope,
    ticket: PackageToolTicket,
    args: Record<string, unknown>,
  ): Promise<PackageToolDispatchResult>;
}

export class PackageDispatchRefusedError extends Error {
  constructor(readonly code: PackageDispatchRefusalCode) {
    super(code);
    this.name = "PackageDispatchRefusedError";
  }
}

// ---------------------------------------------------------------------------
// 锁序（Spec §8）：成员 → install → grant(bot) → connector-install →
// connection → operation。停用/撤权/授权走独占臂；本模块的读与 CAS 走
// 共享臂（除 operation），因此「先停用则此后未 dispatched 的调用不再发
// 送；先 dispatched 则效果保留」由提交顺序决定，不靠时间戳。
// ---------------------------------------------------------------------------

type DataTransaction = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

/** The member-class keys, known from the trusted scope before any read. */
function memberLockKeys(scope: PlatformScope): string[] {
  return [
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
  ];
}

function packageInstallKey(scope: PlatformScope, installId: string): string {
  return JSON.stringify([
    "enterprise",
    "package-install",
    scope.tenantId,
    installId,
  ]);
}

function packageGrantKey(
  scope: PlatformScope,
  installId: string,
  botId: string,
): string {
  return JSON.stringify([
    "enterprise",
    "package-grant",
    scope.tenantId,
    installId,
    botId,
  ]);
}

function pluginInstallKey(scope: PlatformScope, installId: string): string {
  return JSON.stringify([
    "enterprise",
    "plugin-install",
    scope.tenantId,
    installId,
  ]);
}

function pluginConnectionKey(
  scope: PlatformScope,
  connectionId: string,
): string {
  return JSON.stringify([
    "enterprise",
    "plugin-connection",
    scope.tenantId,
    connectionId,
  ]);
}

function dispatchOperationKey(input: {
  tenantId: string;
  runId: string;
  attemptGeneration: number;
  toolCallId: string;
}): string {
  return JSON.stringify([
    "enterprise",
    "package-dispatch",
    input.tenantId,
    input.runId,
    input.attemptGeneration,
    input.toolCallId,
  ]);
}

async function takeSharedLocks(
  tx: DataTransaction,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
    );
  }
}

function refused(code: PackageDispatchRefusalCode): {
  readonly outcome: "refused";
  readonly code: PackageDispatchRefusalCode;
} {
  return { outcome: "refused", code };
}

function argsDigestOf(args: Record<string, unknown>): string {
  return sha256Hex(
    `openbot:package-dispatch-args:v1\u0000${canonicalJson(args)}`,
  );
}

interface ResolvedBinding {
  readonly installId: string;
  readonly resourceId: string;
  readonly toolName: string;
  readonly toolRef: string;
}

function resolveBinding(ref: string): ResolvedBinding | null {
  const parsed = parsePackageToolRef(ref);
  if (!parsed) return null;
  return {
    installId: parsed.installId,
    resourceId: parsed.resourceId,
    toolName: parsed.toolName,
    toolRef: `${parsed.resourceId}:${parsed.toolName}`,
  };
}

interface DispatchFacts {
  /** The run's admitted Bot (derived from the run row; never from input). */
  readonly botId: string;
  readonly installId: string;
  readonly packageKey: string;
  readonly version: string;
  readonly revision: number;
  readonly releaseDigest: string;
  readonly resourceId: string;
  readonly toolName: string;
  readonly toolRef: string;
  readonly schemaDigest: string;
  readonly effect: "read" | "write";
  readonly connectorInstallId: string;
  readonly connectionId: string | null;
  readonly connectionGeneration: number;
  readonly argsDigest: string;
}

type FactsResolution =
  | {
      readonly outcome: "facts";
      readonly facts: DispatchFacts;
      readonly envelope: string | null;
    }
  | { readonly outcome: "refused"; readonly code: PackageDispatchRefusalCode };

export interface CreatePackageDispatchInput {
  readonly data: DataDatabase;
  /** 撤回判定面；null 时派发一律 fail closed（只读浏览不受影响）。 */
  readonly catalogue: PackageCatalogue | null;
  /** 内容寻址制品根；null 时工具派发 fail closed。 */
  readonly artifactRoot: string | null;
  /** MT031 envelope 解封；null 时带 secret 的安装不可拨号（fail closed）。 */
  readonly vault: SecretVault | null;
  /** #75 每调用重验面（本模块是它的第一个生产消费者）。 */
  readonly toolInvocation: ToolInvocationService;
  /** MT031 安装/连接调用判定面（authorizeInvoke）。 */
  readonly catalogDecisions: PluginCatalogDecisionService;
  /** Run 钉扎工具读取（package runtime readPinnedTools）。 */
  readonly pinnedTools: PinnedToolsReader;
  /** 可控 transport（测试注入）；缺省仅 mcp kind 有真实拨号。 */
  readonly vendorCall?: PackageVendorCaller;
}

const DEFAULT_VENDOR: PackageVendorCaller = async (access, toolName, args) => {
  if (access.catalogKind !== "mcp") {
    // V1：brokered kind 的真实拨号不在本票接线（#75 领域）；未注入时 fail
    // closed，绝不用包内信息猜端点。
    throw new Error("PACKAGE_CONNECTOR_TRANSPORT_UNAVAILABLE");
  }
  if (!access.url) throw new Error("PACKAGE_CONNECTOR_ENDPOINT_MISSING");
  return transportFor("mcp").callTool(
    {
      url: access.url,
      ...(access.token ? { token: access.token } : {}),
      actorId: access.actorId,
      botId: access.botId,
    },
    toolName,
    args,
  );
};

export function createPackageDispatchService(
  input: CreatePackageDispatchInput,
): PackageDispatchService {
  const {
    data,
    catalogue,
    artifactRoot,
    vault,
    toolInvocation,
    catalogDecisions,
  } = input;
  const vendorCall: PackageVendorCaller = input.vendorCall ?? DEFAULT_VENDOR;

  /**
   * 连接/账号访问解析（Spec §9 resolveManagedAccess）。判定面只读、无网络：
   *   - 安装/成员资格臂交给 authorizeInvoke（canonical deny，allow 独占携带
   *     envelope）；
   *   - 账号臂：MT031 连接必须属于该安装且 bound_by 就是当前调用者本人
   *     （V1 只允许本人在原范围授权的账号；发布者/管理员/他人/跨团队拒绝）；
   *   - 端点只来自受管安装自身的 config，秘密只经 vault 解封到进程内。
   */
  const resolveManagedAccessWithin = async (
    tx: DataTransaction,
    scope: PlatformScope,
    botId: string,
    connectorInstallId: string,
    requestedConnectionId: string | undefined,
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly access: ResolvedManagedAccess;
        readonly facts: {
          connectionId: string | null;
          connectionGeneration: number;
          catalogKind: string;
          url: string | null;
          envelope: string | null;
        };
      }
    | ReturnType<typeof refused>
  > => {
    const [install] = await tx
      .select({
        id: enterprisePluginInstalls.id,
        catalogId: enterprisePluginInstalls.catalogId,
        config: enterprisePluginInstalls.config,
        status: enterprisePluginInstalls.status,
      })
      .from(enterprisePluginInstalls)
      .where(
        and(
          eq(enterprisePluginInstalls.tenantId, scope.tenantId),
          eq(enterprisePluginInstalls.workspaceId, scope.workspaceId),
          eq(enterprisePluginInstalls.id, connectorInstallId),
        ),
      )
      .limit(1);
    if (install?.status !== "active") {
      return refused("NOT_AVAILABLE");
    }
    const [catalog] = await tx
      .select({ kind: enterprisePluginCatalog.kind })
      .from(enterprisePluginCatalog)
      .where(eq(enterprisePluginCatalog.id, install.catalogId))
      .limit(1);
    if (!catalog) return refused("NOT_AVAILABLE");

    // 账号臂：本人在原范围的连接。多条时取指定者，否则取本人最近绑定。
    const connections = await tx
      .select({
        id: enterprisePluginConnections.id,
        boundBy: enterprisePluginConnections.boundBy,
        vendorRef: enterprisePluginConnections.vendorRef,
        generation: enterprisePluginConnections.generation,
      })
      .from(enterprisePluginConnections)
      .where(
        and(
          eq(enterprisePluginConnections.tenantId, scope.tenantId),
          eq(enterprisePluginConnections.installId, connectorInstallId),
          ...(requestedConnectionId
            ? [eq(enterprisePluginConnections.id, requestedConnectionId)]
            : []),
        ),
      );
    const own = connections.find(
      (connection) => connection.boundBy === scope.principalId,
    );
    const accountBearing =
      catalog.kind === "composio" || catalog.kind === "open-connector";
    if (requestedConnectionId && !own) {
      // 指定的连接不是本人绑定：他人/跨团队账号不得借用（V1）。
      return refused("CONNECTION_UNAVAILABLE");
    }
    if (accountBearing && !own) {
      // 账号型连接必须有本人账号：无连接 = 需要连接，而不是回退部署凭据。
      return refused("CONNECTION_UNAVAILABLE");
    }

    const config = (install.config ?? {}) as Record<string, unknown>;
    const url = typeof config.url === "string" ? config.url : null;
    const envelope = await readEnvelope(tx, scope, connectorInstallId);
    return {
      outcome: "allow",
      access: {
        connectorInstallId,
        connectionId: own?.id ?? null,
        connectionGeneration: own?.generation ?? 1,
        catalogKind: catalog.kind,
        url,
        token: null,
        accountHandle: own?.vendorRef ?? null,
        actorId: scope.actorId,
        botId,
      },
      facts: {
        connectionId: own?.id ?? null,
        connectionGeneration: own?.generation ?? 1,
        catalogKind: catalog.kind,
        url,
        envelope,
      },
    };
  };

  /**
   * The install's sealed secret, read under the data role. Null when the
   * install carries none; a read failure fails the resolution closed.
   */
  const readEnvelope = async (
    tx: DataTransaction,
    scope: PlatformScope,
    connectorInstallId: string,
  ): Promise<string | null> => {
    const [row] = await tx
      .select({ envelope: enterprisePluginInstalls.envelope })
      .from(enterprisePluginInstalls)
      .where(
        and(
          eq(enterprisePluginInstalls.tenantId, scope.tenantId),
          eq(enterprisePluginInstalls.workspaceId, scope.workspaceId),
          eq(enterprisePluginInstalls.id, connectorInstallId),
        ),
      )
      .limit(1);
    return row?.envelope ?? null;
  };

  /**
   * Lock-free id discovery for the staged §8 lock order: the pin's binding
   * names the connector install (and its own connection row) for THIS
   * binding, and the run names its admitted Bot. Authorization is NOT decided
   * here — resolveFacts re-reads and re-decides everything under the locks.
   */
  const readBindingTargets = async (
    tx: DataTransaction,
    scope: PlatformScope,
    runId: string,
    attemptGeneration: number,
    binding: ResolvedBinding,
  ): Promise<{
    botId: string | null;
    connectorInstallId: string | null;
    connectionId: string | null;
  }> => {
    const [pin] = await tx
      .select({
        allowedToolBindings: pinRows.allowedToolBindings,
      })
      .from(pinRows)
      .where(
        and(
          eq(pinRows.tenantId, scope.tenantId),
          eq(pinRows.workspaceId, scope.workspaceId),
          eq(pinRows.runId, runId),
          eq(pinRows.attemptGeneration, attemptGeneration),
          eq(pinRows.installId, binding.installId),
        ),
      )
      .limit(1);
    if (!pin) {
      return { botId: null, connectorInstallId: null, connectionId: null };
    }
    const pinBinding = (
      Array.isArray(pin.allowedToolBindings)
        ? (pin.allowedToolBindings as Record<string, unknown>[])
        : []
    ).find(
      (entry) =>
        entry &&
        entry.resourceId === binding.resourceId &&
        entry.toolRef === binding.toolRef,
    );
    const connectorInstallId =
      typeof pinBinding?.connectorInstallId === "string"
        ? pinBinding.connectorInstallId
        : null;
    let connectionId: string | null = null;
    if (connectorInstallId) {
      const [connection] = await tx
        .select({ id: enterprisePluginConnections.id })
        .from(enterprisePluginConnections)
        .where(
          and(
            eq(enterprisePluginConnections.tenantId, scope.tenantId),
            eq(enterprisePluginConnections.installId, connectorInstallId),
            eq(enterprisePluginConnections.boundBy, scope.principalId),
          ),
        )
        .limit(1);
      connectionId = connection?.id ?? null;
    }
    const [run] = await tx
      .select({ expertVersionRef: enterpriseRuns.expertVersionRef })
      .from(enterpriseRuns)
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, runId),
        ),
      )
      .limit(1);
    let botId: string | null = null;
    if (run) {
      const [admitted] = await tx
        .select({ agentId: enterpriseExpertVersions.agentId })
        .from(enterpriseExpertVersions)
        .where(
          and(
            eq(enterpriseExpertVersions.tenantId, scope.tenantId),
            eq(enterpriseExpertVersions.expertVersionRef, run.expertVersionRef),
          ),
        )
        .limit(1);
      botId = admitted?.agentId ?? null;
    }
    return { botId, connectorInstallId, connectionId };
  };

  /**
   * Spec §8 锁序下的事实重验（判定核心；无写入）。每一步失败都返回 typed
   * refusal：跨范围、不存在、lease 失效、绑定不在快照内一律同形。
   */
  const resolveFacts = async (
    tx: DataTransaction,
    scope: PlatformScope,
    /** The caller-asserted Bot (store branch). Null = derive from the run. */
    expectedBotId: string | null,
    runId: string,
    attemptGeneration: number,
    binding: ResolvedBinding,
    args: Record<string, unknown>,
    expectedConnection?: {
      readonly connectionId: string | null;
      readonly generation: number;
    },
  ): Promise<FactsResolution> => {
    // —— 门 0：调用者自身事实（每事务重验；撤权即死）。 ——
    const [member] = await tx
      .select({
        companyStatus: enterpriseMemberships.status,
        companyEpoch: enterpriseMemberships.epoch,
        teamStatus: enterpriseWorkspaceMemberships.status,
      })
      .from(enterpriseMemberships)
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseMemberships.tenantId,
          ),
          eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
          eq(
            enterpriseWorkspaceMemberships.principalId,
            enterpriseMemberships.principalId,
          ),
        ),
      )
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    if (
      member?.companyStatus !== "active" ||
      member.companyEpoch !== scope.memberEpoch ||
      member.teamStatus !== "active"
    ) {
      return refused("NOT_AVAILABLE");
    }

    // —— 门 1：Run/attempt lease（活跃、代次一致、租约未过期、发起人即
    // 调用者本人、原范围未变）。 ——
    const [run] = await tx
      .select({
        workspaceId: enterpriseRuns.workspaceId,
        principalId: enterpriseRuns.principalId,
        status: enterpriseRuns.status,
        attemptGeneration: enterpriseRuns.attemptGeneration,
        leaseExpiresAt: enterpriseRuns.leaseExpiresAt,
        expertVersionRef: enterpriseRuns.expertVersionRef,
      })
      .from(enterpriseRuns)
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, runId),
        ),
      )
      .limit(1);
    if (
      !run ||
      run.workspaceId !== scope.workspaceId ||
      run.principalId !== scope.principalId ||
      run.attemptGeneration !== attemptGeneration ||
      run.leaseExpiresAt.getTime() <= Date.now() ||
      !(run.status === "running" || run.status === "waiting_approval")
    ) {
      return refused("RUN_LEASE_INVALID");
    }

    // —— 门 2：admitted bot 绑定（L-3）+ Bot ownership。 ——
    const [admitted] = await tx
      .select({ agentId: enterpriseExpertVersions.agentId })
      .from(enterpriseExpertVersions)
      .where(
        and(
          eq(enterpriseExpertVersions.tenantId, scope.tenantId),
          eq(enterpriseExpertVersions.expertVersionRef, run.expertVersionRef),
        ),
      )
      .limit(1);
    const botId = admitted?.agentId;
    if (!botId) return refused("NOT_AVAILABLE");
    if (expectedBotId !== null && expectedBotId !== botId) {
      return refused("NOT_AVAILABLE");
    }
    const [ownership] = await tx
      .select({
        status: enterpriseBotOwnership.status,
        workspaceId: enterpriseBotOwnership.workspaceId,
      })
      .from(enterpriseBotOwnership)
      .where(
        and(
          eq(enterpriseBotOwnership.tenantId, scope.tenantId),
          eq(enterpriseBotOwnership.agentId, botId),
        ),
      )
      .limit(1);
    if (
      ownership?.status !== "active" ||
      ownership.workspaceId !== scope.workspaceId
    ) {
      return refused("NOT_AVAILABLE");
    }

    // —— 门 3：pin。绑定必须在该 Run 快照内（旧 pin 不吸收新工具）。 ——
    const [pin] = await tx
      .select({
        installId: pinRows.installId,
        revision: pinRows.revision,
        releaseDigest: pinRows.releaseDigest,
        allowedToolBindings: pinRows.allowedToolBindings,
        installGeneration: pinRows.installGeneration,
      })
      .from(pinRows)
      .where(
        and(
          eq(pinRows.tenantId, scope.tenantId),
          eq(pinRows.workspaceId, scope.workspaceId),
          eq(pinRows.runId, runId),
          eq(pinRows.attemptGeneration, attemptGeneration),
          eq(pinRows.installId, binding.installId),
        ),
      )
      .limit(1);
    if (!pin) return refused("NOT_AVAILABLE");
    const pinBindings = Array.isArray(pin.allowedToolBindings)
      ? (pin.allowedToolBindings as Record<string, unknown>[])
      : [];
    const pinBinding = pinBindings.find(
      (entry) =>
        entry &&
        entry.resourceId === binding.resourceId &&
        entry.toolRef === binding.toolRef,
    );
    if (!pinBinding) return refused("NOT_AVAILABLE");

    // —— 门 4：install enabled + generation 未漂移 + 包未撤回。 ——
    const [install] = await tx
      .select({
        packageKey: installRows.packageKey,
        version: installRows.currentVersion,
        status: installRows.status,
        generation: installRows.generation,
      })
      .from(installRows)
      .where(
        and(
          eq(installRows.tenantId, scope.tenantId),
          eq(installRows.workspaceId, scope.workspaceId),
          eq(installRows.id, binding.installId),
        ),
      )
      .limit(1);
    if (install?.status !== "enabled") {
      return refused("NOT_AVAILABLE");
    }
    if (install.generation !== pin.installGeneration) {
      return refused("NOT_AVAILABLE");
    }
    if (!catalogue || artifactRoot === null) {
      // 没有受管目录/制品根：不做任何派发（fail closed；浏览面不受影响）。
      return refused("NOT_AVAILABLE");
    }
    const release = await catalogue.resolveRelease(
      install.packageKey,
      install.version,
    );
    if (
      !release?.verified ||
      !release.manifest ||
      release.artifactDigest !== pin.releaseDigest
    ) {
      // 发布撤回/制品漂移：不能新派发此版本。
      return refused("PACKAGE_WITHDRAWN");
    }
    const declared = addedToolsOf(release.manifest).find(
      (tool) => tool.ref === binding.toolRef,
    );
    if (!declared) return refused("NOT_AVAILABLE");

    // —— 门 5：范围 grant（工具 ref/schema digest/effect）。 ——
    const [grant] = await tx
      .select({
        schemaDigest: grantRows.schemaDigest,
        effect: grantRows.effect,
        connectorInstallId: grantRows.connectorInstallId,
      })
      .from(grantRows)
      .where(
        and(
          eq(grantRows.tenantId, scope.tenantId),
          eq(grantRows.workspaceId, scope.workspaceId),
          eq(grantRows.installId, binding.installId),
          eq(grantRows.botId, botId),
          eq(grantRows.resourceId, binding.resourceId),
          eq(grantRows.toolRef, binding.toolRef),
          isNull(grantRows.revokedAt),
        ),
      )
      .limit(1);
    if (
      !grant ||
      grant.schemaDigest !== declared.schemaDigest ||
      grant.effect !== declared.effect ||
      !grant.connectorInstallId
    ) {
      // 无活跃授权，或授权的契约与当前修订声明不一致（需重新授权，A06）。
      return refused("NOT_AVAILABLE");
    }
    if (
      pinBinding.schemaDigest !== declared.schemaDigest ||
      pinBinding.effect !== declared.effect ||
      pinBinding.connectorInstallId !== grant.connectorInstallId
    ) {
      return refused("NOT_AVAILABLE");
    }

    // —— 门 6：连接 generation 与本人账号（resolveManagedAccess）。 ——
    const accessResolution = await resolveManagedAccessWithin(
      tx,
      scope,
      botId,
      grant.connectorInstallId,
      undefined,
    );
    if (accessResolution.outcome !== "allow") return accessResolution;
    if (accessResolution.access.catalogKind === "mcp") {
      if (!accessResolution.access.url) return refused("NOT_AVAILABLE");
    }
    if (
      expectedConnection &&
      (accessResolution.facts.connectionId !==
        expectedConnection.connectionId ||
        accessResolution.facts.connectionGeneration !==
          expectedConnection.generation)
    ) {
      // The connection was re-bound (or its generation moved) while the
      // approval waited: the approved action no longer describes this call.
      return refused("CONNECTION_CHANGED");
    }

    return {
      outcome: "facts",
      facts: {
        botId,
        installId: binding.installId,
        packageKey: install.packageKey,
        version: install.version,
        revision: pin.revision,
        releaseDigest: pin.releaseDigest,
        resourceId: binding.resourceId,
        toolName: binding.toolName,
        toolRef: binding.toolRef,
        schemaDigest: declared.schemaDigest,
        effect: declared.effect,
        connectorInstallId: grant.connectorInstallId,
        connectionId: accessResolution.facts.connectionId,
        connectionGeneration: accessResolution.facts.connectionGeneration,
        argsDigest: argsDigestOf(args),
      },
      envelope: accessResolution.facts.envelope,
    };
  };

  /**
   * The two explicit decision surfaces this chain must pass through before any
   * facts are read for the CAS: #75's per-call Bot/account revalidation and
   * MT031's install/connection invoke gate. Both answer canonical not-found on
   * anything cross-scope.
   */
  const authorizeSurfaces = async (
    scope: PlatformScope,
    botId: string,
    toolRef: string,
    connectorInstallId: string | null,
  ): Promise<ReturnType<typeof refused> | null> => {
    const invocation = await toolInvocation.authorizeToolInvocation(scope, {
      agentId: botId,
      toolName: toolRef,
    });
    if (invocation.outcome !== "allow") {
      return refused(
        invocation.outcome === "deny" &&
          invocation.code === "TOOL_BOT_NOT_USABLE"
          ? "BOT_NOT_USABLE"
          : "NOT_AVAILABLE",
      );
    }
    if (connectorInstallId) {
      const invoke = await catalogDecisions.authorizeInvoke(scope, {
        installId: connectorInstallId,
      });
      if (invoke.outcome !== "allow") return refused("NOT_AVAILABLE");
    }
    return null;
  };

  /**
   * The admitted Bot and the binding's connector install, read in their own
   * short transaction so the decision surfaces can run before the CAS
   * transaction opens its connection. Nothing here decides anything: the CAS
   * transaction re-reads all of it under its locks.
   */
  const readTargets = async (
    scope: PlatformScope,
    runId: string,
    attemptGeneration: number,
    binding: ResolvedBinding,
  ): Promise<{
    botId: string | null;
    connectorInstallId: string | null;
  }> =>
    openTransaction(scope, (tx) =>
      readBindingTargets(tx, scope, runId, attemptGeneration, binding).then(
        (targets) => ({
          botId: targets.botId,
          connectorInstallId: targets.connectorInstallId,
        }),
      ),
    );

  const openTransaction = async <T>(
    scope: PlatformScope,
    operation: (tx: DataTransaction) => Promise<T>,
  ): Promise<T> =>
    data.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
      );
      return operation(tx);
    });

  const accessOf = async (
    tx: DataTransaction,
    scope: PlatformScope,
    botId: string,
    facts: DispatchFacts,
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly access: ResolvedManagedAccess;
      }
    | ReturnType<typeof refused>
  > => {
    const resolution = await resolveManagedAccessWithin(
      tx,
      scope,
      botId,
      facts.connectorInstallId,
      undefined,
    );
    if (resolution.outcome !== "allow") return resolution;
    if (resolution.facts.envelope !== null && !vault) {
      return refused("NOT_AVAILABLE");
    }
    const token =
      resolution.facts.envelope !== null && vault
        ? await vault.open(resolution.facts.envelope)
        : null;
    return {
      outcome: "allow",
      access: {
        ...resolution.access,
        token,
      },
    };
  };

  return {
    async beginDispatch(scope, rawInput) {
      assertTrustedScope(scope);
      if (
        !rawInput ||
        typeof rawInput.toolCallId !== "string" ||
        !rawInput.toolCallId.trim() ||
        rawInput.toolCallId.length > 256 ||
        !Number.isSafeInteger(rawInput.attemptGeneration) ||
        rawInput.attemptGeneration <= 0 ||
        typeof rawInput.runId !== "string" ||
        !rawInput.runId.trim() ||
        typeof rawInput.bindingId !== "string"
      ) {
        return refused("NOT_AVAILABLE");
      }
      const binding = resolveBinding(rawInput.bindingId);
      if (!binding) return refused("NOT_AVAILABLE");
      /*
       * The decision surfaces FIRST, each in its own short transaction: #75's
       * per-call Bot/account revalidation and MT031's install/connection
       * invoke gate. They are never called from inside the CAS transaction
       * (that would need a second pooled connection while this one is held —
       * a deadlock on a single-connection pool, and needless contention on any
       * other). The CAS transaction below re-reads every fact they checked
       * directly; neither surface is a substitute for those reads.
       */
      const preTargets = await readTargets(
        scope,
        rawInput.runId,
        rawInput.attemptGeneration,
        binding,
      );
      if (!preTargets.botId) return refused("RUN_LEASE_INVALID");
      const surfacesBefore = await authorizeSurfaces(
        scope,
        preTargets.botId,
        binding.toolRef,
        preTargets.connectorInstallId,
      );
      if (surfacesBefore) return surfacesBefore;
      return openTransaction(scope, async (tx) => {
        /*
         * Spec §8 lock order, staged because the connector-install and
         * connection ids only become known from the pin: member class first
         * (shared, from the trusted scope), then a lock-free read of the pin's
         * binding learns the lower-class ids, and every class is then locked
         * IN ORDER before the revalidation reads — install → grant(bot) →
         * connector-install → connection → operation. The pre-lock read is
         * only to learn ids; every authorization fact is re-read under the
         * locks below by resolveFacts.
         */
        await takeSharedLocks(tx, memberLockKeys(scope));
        const staged = await readBindingTargets(
          tx,
          scope,
          rawInput.runId,
          rawInput.attemptGeneration,
          binding,
        );
        await takeSharedLocks(tx, [
          packageInstallKey(scope, binding.installId),
          packageGrantKey(scope, staged.botId ?? "", binding.installId),
          ...(staged.connectorInstallId
            ? [pluginInstallKey(scope, staged.connectorInstallId)]
            : []),
          ...(staged.connectionId
            ? [pluginConnectionKey(scope, staged.connectionId)]
            : []),
        ]);
        // Spec §8 operation level: exclusive on the dispatch identity.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${dispatchOperationKey(
            {
              tenantId: scope.tenantId,
              runId: rawInput.runId,
              attemptGeneration: rawInput.attemptGeneration,
              toolCallId: rawInput.toolCallId,
            },
          )}, 0))`,
        );
        const resolution = await resolveFacts(
          tx,
          scope,
          null,
          rawInput.runId,
          rawInput.attemptGeneration,
          binding,
          rawInput.args,
          rawInput.expectedConnection,
        );
        if (resolution.outcome !== "facts") return resolution;
        const access = await accessOf(
          tx,
          scope,
          resolution.facts.botId,
          resolution.facts,
        );
        if (access.outcome !== "allow") return access;
        const operationId = randomUUID();
        await tx
          .insert(dispatchRows)
          .values({
            tenantId: scope.tenantId,
            operationId,
            workspaceId: scope.workspaceId,
            runId: rawInput.runId,
            attemptGeneration: rawInput.attemptGeneration,
            toolCallId: rawInput.toolCallId,
            installId: resolution.facts.installId,
            revision: resolution.facts.revision,
            resourceId: resolution.facts.resourceId,
            toolRef: resolution.facts.toolRef,
            connectorInstallId: resolution.facts.connectorInstallId,
            connectionId: resolution.facts.connectionId,
            connectionGeneration: resolution.facts.connectionGeneration,
            argsDigest: resolution.facts.argsDigest,
            effect: resolution.facts.effect,
            state: "prepared",
          })
          .onConflictDoNothing();
        const dispatched = await tx
          .update(dispatchRows)
          .set({ state: "dispatched", updatedAt: new Date() })
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.runId, rawInput.runId),
              eq(dispatchRows.attemptGeneration, rawInput.attemptGeneration),
              eq(dispatchRows.toolCallId, rawInput.toolCallId),
              eq(dispatchRows.state, "prepared"),
            ),
          )
          .returning({ operationId: dispatchRows.operationId });
        if (dispatched.length === 0) {
          // Another caller already CAS'd this tool call (or cancelled it):
          // the transport must NOT be invoked a second time.
          return refused("DUPLICATE_DISPATCH");
        }
        return {
          outcome: "permit" as const,
          permit: {
            operationId: dispatched[0]?.operationId ?? operationId,
            runId: rawInput.runId,
            attemptGeneration: rawInput.attemptGeneration,
            toolCallId: rawInput.toolCallId,
            installId: resolution.facts.installId,
            resourceId: resolution.facts.resourceId,
            toolName: resolution.facts.toolName,
            toolRef: resolution.facts.toolRef,
            connectorInstallId: resolution.facts.connectorInstallId,
            connectionId: resolution.facts.connectionId,
            connectionGeneration: resolution.facts.connectionGeneration,
            argsDigest: resolution.facts.argsDigest,
            effect: resolution.facts.effect,
            access: access.access,
          },
        };
      });
    },

    async completeDispatch(scope, permit, completion) {
      assertTrustedScope(scope);
      // 撤权不丢已发生效果：完成写不做授权重验，只认 permit 的身份。
      await openTransaction(scope, async (tx) => {
        const updated = await tx
          .update(dispatchRows)
          .set({
            state: completion.state,
            receiptRef: completion.receiptRef ?? null,
            errorCode: completion.errorCode ?? null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.operationId, permit.operationId),
              eq(dispatchRows.state, "dispatched"),
            ),
          )
          .returning({ operationId: dispatchRows.operationId });
        if (updated.length === 0) {
          throw new Error("PACKAGE_DISPATCH_COMPLETION_STALE");
        }
      });
    },

    async cancelDispatch(scope, rawInput) {
      assertTrustedScope(scope);
      await openTransaction(scope, async (tx) => {
        await tx
          .update(dispatchRows)
          .set({
            state: "cancelled",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.runId, rawInput.runId),
              eq(dispatchRows.attemptGeneration, rawInput.attemptGeneration),
              eq(dispatchRows.toolCallId, rawInput.toolCallId),
              eq(dispatchRows.state, "prepared"),
            ),
          );
      });
    },

    async markUnknown(scope, rawInput) {
      assertTrustedScope(scope);
      return openTransaction(scope, async (tx) => {
        const updated = await tx
          .update(dispatchRows)
          .set({
            state: "unknown",
            receiptRef: { effectStatus: "unknown" },
            errorCode: rawInput.errorCode ?? "DISPATCH_CRASH",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.runId, rawInput.runId),
              eq(dispatchRows.attemptGeneration, rawInput.attemptGeneration),
              eq(dispatchRows.toolCallId, rawInput.toolCallId),
              eq(dispatchRows.state, "dispatched"),
            ),
          )
          .returning({ operationId: dispatchRows.operationId });
        return updated.length > 0;
      });
    },

    async execute(scope, rawInput) {
      const begun = await this.beginDispatch(scope, rawInput);
      if (begun.outcome !== "permit") return begun;
      const permit = begun.permit;
      try {
        const result = await vendorCall(
          permit.access,
          permit.toolName,
          rawInput.args,
        );
        const state = result.isError ? "failed" : "succeeded";
        await this.completeDispatch(scope, permit, {
          state,
          effectStatus: "confirmed",
          receiptRef: { effectStatus: "confirmed", isError: result.isError },
        });
        return {
          outcome: "ok" as const,
          text: result.text,
          isError: result.isError,
          state,
        };
      } catch (error) {
        // 写动作超时/崩溃：效果不明 → unknown，绝不自动重发。读动作失败
        // 无外部效果 → failed(effectStatus none)。
        const isWrite = permit.effect === "write";
        await this.completeDispatch(scope, permit, {
          state: isWrite ? "unknown" : "failed",
          effectStatus: isWrite ? "unknown" : "none",
          errorCode: "DISPATCH_TRANSPORT_ERROR",
          receiptRef: { effectStatus: isWrite ? "unknown" : "none" },
        });
        throw error;
      }
    },

    async listPinnedTools(scope, rawInput) {
      assertTrustedScope(scope);
      return input.pinnedTools(scope, rawInput);
    },

    async resolveManagedAccess(scope, rawInput) {
      assertTrustedScope(scope);
      return openTransaction(scope, async (tx) => {
        await takeSharedLocks(tx, [
          ...memberLockKeys(scope),
          pluginInstallKey(scope, rawInput.connectorInstallId),
        ]);
        const resolution = await resolveManagedAccessWithin(
          tx,
          scope,
          rawInput.botId,
          rawInput.connectorInstallId,
          rawInput.connectionId,
        );
        if (resolution.outcome !== "allow") return resolution;
        if (resolution.facts.envelope !== null && !vault) {
          return refused("NOT_AVAILABLE");
        }
        const token =
          resolution.facts.envelope !== null && vault
            ? await vault.open(resolution.facts.envelope)
            : null;
        return {
          outcome: "allow" as const,
          access: { ...resolution.access, token },
        };
      });
    },

    async readDispatch(scope, rawInput) {
      assertTrustedScope(scope);
      return openTransaction(scope, async (tx) => {
        const [row] = await tx
          .select({
            state: dispatchRows.state,
            argsDigest: dispatchRows.argsDigest,
            effect: dispatchRows.effect,
            connectionGeneration: dispatchRows.connectionGeneration,
            receiptRef: dispatchRows.receiptRef,
            errorCode: dispatchRows.errorCode,
          })
          .from(dispatchRows)
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.runId, rawInput.runId),
              eq(dispatchRows.attemptGeneration, rawInput.attemptGeneration),
              eq(dispatchRows.toolCallId, rawInput.toolCallId),
            ),
          )
          .limit(1);
        if (!row) return null;
        return {
          state: row.state as PackageDispatchState,
          argsDigest: row.argsDigest,
          effect: row.effect,
          connectionGeneration: row.connectionGeneration,
          receiptRef: (row.receiptRef as Record<string, unknown>) ?? null,
          errorCode: row.errorCode,
        };
      });
    },

    async preparePackageTool(scope, rawInput) {
      assertTrustedScope(scope);
      const binding = resolveBinding(rawInput.ref);
      if (!binding) return refused("NOT_AVAILABLE");
      if (
        typeof rawInput.toolCallId !== "string" ||
        !rawInput.toolCallId.trim() ||
        rawInput.toolCallId.length > 256 ||
        !Number.isSafeInteger(rawInput.attemptGeneration) ||
        rawInput.attemptGeneration <= 0
      ) {
        return refused("NOT_AVAILABLE");
      }
      const preTargets = await readTargets(
        scope,
        rawInput.runId,
        rawInput.attemptGeneration,
        binding,
      );
      if (!preTargets.botId) return refused("RUN_LEASE_INVALID");
      if (preTargets.botId !== rawInput.botId) return refused("NOT_AVAILABLE");
      const surfacesBefore = await authorizeSurfaces(
        scope,
        preTargets.botId,
        binding.toolRef,
        preTargets.connectorInstallId,
      );
      if (surfacesBefore) return surfacesBefore;
      return openTransaction(scope, async (tx) => {
        // Same staged §8 order as beginDispatch (see there for the rationale).
        await takeSharedLocks(tx, memberLockKeys(scope));
        const staged = await readBindingTargets(
          tx,
          scope,
          rawInput.runId,
          rawInput.attemptGeneration,
          binding,
        );
        await takeSharedLocks(tx, [
          packageInstallKey(scope, binding.installId),
          packageGrantKey(scope, rawInput.botId, binding.installId),
          ...(staged.connectorInstallId
            ? [pluginInstallKey(scope, staged.connectorInstallId)]
            : []),
          ...(staged.connectionId
            ? [pluginConnectionKey(scope, staged.connectionId)]
            : []),
        ]);
        const resolution = await resolveFacts(
          tx,
          scope,
          rawInput.botId,
          rawInput.runId,
          rawInput.attemptGeneration,
          binding,
          rawInput.args,
        );
        if (resolution.outcome !== "facts") return resolution;
        const operationId = randomUUID();
        await tx
          .insert(dispatchRows)
          .values({
            tenantId: scope.tenantId,
            operationId,
            workspaceId: scope.workspaceId,
            runId: rawInput.runId,
            attemptGeneration: rawInput.attemptGeneration,
            toolCallId: rawInput.toolCallId,
            installId: resolution.facts.installId,
            revision: resolution.facts.revision,
            resourceId: resolution.facts.resourceId,
            toolRef: resolution.facts.toolRef,
            connectorInstallId: resolution.facts.connectorInstallId,
            connectionId: resolution.facts.connectionId,
            connectionGeneration: resolution.facts.connectionGeneration,
            argsDigest: resolution.facts.argsDigest,
            effect: resolution.facts.effect,
            state: "prepared",
          })
          .onConflictDoNothing();
        return {
          outcome: "ticket" as const,
          ticket: {
            runId: rawInput.runId,
            attemptGeneration: rawInput.attemptGeneration,
            toolCallId: rawInput.toolCallId,
            installId: resolution.facts.installId,
            resourceId: resolution.facts.resourceId,
            toolName: resolution.facts.toolName,
            toolRef: resolution.facts.toolRef,
            ref: packageToolRefFor(
              resolution.facts.installId,
              resolution.facts.resourceId,
              resolution.facts.toolName,
            ),
            schemaDigest: resolution.facts.schemaDigest,
            effect: resolution.facts.effect,
            connectorInstallId: resolution.facts.connectorInstallId,
            connectionId: resolution.facts.connectionId,
            connectionGeneration: resolution.facts.connectionGeneration,
            argsDigest: resolution.facts.argsDigest,
          },
        };
      });
    },

    async dispatchPackageTool(scope, ticket, args) {
      assertTrustedScope(scope);
      // A07: the approval proposal is bound to the exact arguments it was
      // approved for; a changed argument set is a different action.
      if (argsDigestOf(args) !== ticket.argsDigest) {
        return refused("ARGS_CHANGED");
      }
      const begun = await this.beginDispatch(scope, {
        runId: ticket.runId,
        attemptGeneration: ticket.attemptGeneration,
        toolCallId: ticket.toolCallId,
        bindingId: ticket.ref,
        args,
        expectedConnection: {
          connectionId: ticket.connectionId,
          generation: ticket.connectionGeneration,
        },
      });
      if (begun.outcome !== "permit") return begun;
      const permit = begun.permit;
      try {
        const result = await vendorCall(permit.access, permit.toolName, args);
        const state = result.isError ? "failed" : "succeeded";
        await this.completeDispatch(scope, permit, {
          state,
          effectStatus: "confirmed",
          receiptRef: { effectStatus: "confirmed", isError: result.isError },
        });
        return {
          outcome: "ok" as const,
          text: result.text,
          isError: result.isError,
        };
      } catch (error) {
        const isWrite = permit.effect === "write";
        await this.completeDispatch(scope, permit, {
          state: isWrite ? "unknown" : "failed",
          effectStatus: isWrite ? "unknown" : "none",
          errorCode: "DISPATCH_TRANSPORT_ERROR",
          receiptRef: { effectStatus: isWrite ? "unknown" : "none" },
        }).catch(() => undefined);
        throw error;
      }
    },
  };
}
