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
//   5. T13-fix-2 (Codex FC-02)：派发者进程租约与崩溃恢复。dispatched CAS
//      同事务落 owner_incarnation/owner_lease_expires_at；owner 缺失或异于
//      本进程的 dispatched 行是死进程的孤儿，恒经查询面
//      （listDispatches/inspectDispatch）在读之前结算为 unknown
//      （DISPATCH_CRASH），绝不自动重发（单写者边界，与 §10 release 锁
//      单机语义一致；见 settleOrphanedDispatchesWithin）。

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  type PackageDispatchSummaryDTO,
  PackageDispatchSummaryDTOSchema,
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
  enterprisePackageRevisions as revisionRows,
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
import type { PackageReleaseFactsGate } from "../../plugin-packages/deployment-facts";
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

// ---------------------------------------------------------------------------
// PKG10（#469）：unknown 查询 / 核对 / 恢复面。只读取与写回派发事实；
// 状态机语义（T05）不变——本面永不派发、永不重发、永不删除。
// ---------------------------------------------------------------------------

/** PKG10 surface refusal codes（非 beginDispatch 词表；映射见 routes）。 */
export type PackageDispatchSurfaceCode =
  | "NOT_AVAILABLE"
  | "DISPATCH_NOT_UNKNOWN"
  | "VENDOR_QUERY_PROTOCOL_UNAVAILABLE"
  | "DISPATCH_ACCOUNT_UNAVAILABLE";

/**
 * 已验证的供应商查询协议（AC3 的「支持协议」半边）。只在核对时按原
 * operation 身份查询；repository 当前的 mcp/brokered transport 均未提供
 * 这种协议（无幂等查询接口），因此生产装配不注册——显式记录，核对面
 * 因此恒为「不可查询、不可自动重发」（见 index.ts 接线注释）。
 */
export type PackageVendorQueryProtocol = (input: {
  readonly access: ResolvedManagedAccess;
  readonly toolName: string;
  /** 原 operation 身份——协议只允许以此查询，不接受新调用形态。 */
  readonly operationId: string;
  readonly argsDigest: string;
  readonly effect: "read" | "write";
}) => Promise<
  | {
      readonly found: true;
      readonly outcome: "succeeded" | "failed";
      readonly effectStatus: "confirmed" | "none";
      readonly receiptRef?: Record<string, unknown>;
    }
  | { readonly found: false }
>;

export type PackageDispatchSurfaceResult<T> =
  | { readonly outcome: "found"; readonly value: T }
  | { readonly outcome: "refused"; readonly code: PackageDispatchSurfaceCode };

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
  /**
   * 崩溃/写超时后的 unknown 记账（人工/清扫入口；绝不自动重发）。生产中的
   * 自动恢复不经过本方法：T13-fix-2 的恢复路径由租约证据驱动，恒经查询面
   * （listDispatches/inspectDispatch）结算孤儿 dispatched 行（见
   * settleOrphanedDispatchesWithin）。
   */
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
  /**
   * PKG10：本安装的派发台账（脱敏摘要，含 unknown）。跨范围/未知安装
   * 同形 NOT_AVAILABLE；只读，不触发任何 transport。T13-fix-2：本面同时是
   * 崩溃恢复的生产入口——读之前先按租约证据结算孤儿 dispatched 行。
   */
  listDispatches(
    scope: PlatformScope,
    input: { installId: string },
  ): Promise<
    PackageDispatchSurfaceResult<readonly PackageDispatchSummaryDTO[]>
  >;
  /**
   * PKG10：单个派发的核对视图——事实 + 证据绑定（原账号/目标/参数摘要）
   * + 关联回执 + unknown 的不可自动重发原因与恢复门。T13-fix-2：与台账同
   * 为崩溃恢复的生产入口（读之前先按租约证据结算孤儿 dispatched 行）。只读。
   */
  inspectDispatch(
    scope: PlatformScope,
    input: { installId: string; operationId: string },
  ): Promise<
    PackageDispatchSurfaceResult<{
      dispatch: PackageDispatchSummaryDTO;
      evidence: {
        connectionId: string | null;
        accountHandle: string | null;
        connectorInstallId: string;
        argsDigest: string;
        connectionGeneration: number;
      };
      verification:
        | {
            kind: "unknown";
            canQueryVendor: boolean;
            noAutoResendReason:
              | "NO_VENDOR_QUERY_PROTOCOL"
              | "VENDOR_QUERY_UNRESOLVED";
            relatedReceipts: readonly PackageDispatchSummaryDTO[];
          }
        | { kind: "definite" }
        | { kind: "in_flight" };
      recovery:
        | { readonly ready: true }
        | { readonly ready: false; readonly refusalCode: string }
        | null;
    }>
  >;
  /**
   * PKG10：协议核对的写回半边。仅 unknown 行、仅原 operation 身份、仅原
   * 调用者本人（原账号的归属者）；无协议 → 拒绝；结果写回保留撤权前已
   * 发生的事实（prior 段）。本方法不派发、不重发。
   */
  verifyDispatch(
    scope: PlatformScope,
    input: { installId: string; operationId: string },
  ): Promise<
    PackageDispatchSurfaceResult<{
      outcome: "verified" | "unresolved";
      dispatch: PackageDispatchSummaryDTO;
    }>
  >;
  /**
   * PKG10：恢复门重验（只读探针）。以该 Run 快照当前的绑定重走派发链的
   * 全部门（成员/租约/pin/安装代次/发布状态/grant/连接代次/每调用重验），
   * 回答「后续动作现在能否通过」；args 仅作形状探针——真正的后续派发以
   * 自己的参数走完整链，绝不因探针通过而免验。
   */
  probeRecovery(
    scope: PlatformScope,
    input: {
      runId: string;
      attemptGeneration: number;
      bindingRef: string;
      args?: Record<string, unknown>;
    },
  ): Promise<
    | { readonly outcome: "ready" }
    | {
        readonly outcome: "refused";
        readonly code: PackageDispatchRefusalCode;
      }
  >;
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

// PKG10 read helpers: one column set, one strict-DTO mapper, one visibility
// probe — the ledger surface never widens beyond what beginDispatch wrote.

const DISPATCH_COLUMNS = {
  operationId: dispatchRows.operationId,
  runId: dispatchRows.runId,
  attemptGeneration: dispatchRows.attemptGeneration,
  toolCallId: dispatchRows.toolCallId,
  installId: dispatchRows.installId,
  resourceId: dispatchRows.resourceId,
  toolRef: dispatchRows.toolRef,
  effect: dispatchRows.effect,
  state: dispatchRows.state,
  receiptRef: dispatchRows.receiptRef,
  errorCode: dispatchRows.errorCode,
  createdAt: dispatchRows.createdAt,
  completedAt: dispatchRows.completedAt,
} as const;

interface DispatchLedgerRow {
  readonly operationId: string;
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly toolCallId: string;
  readonly installId: string;
  readonly resourceId: string;
  readonly toolRef: string;
  readonly effect: string;
  readonly state: string;
  readonly receiptRef: unknown;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** The PKG10 evidence columns a verification view binds to (AC3). */
const DISPATCH_EVIDENCE_COLUMNS = {
  ...DISPATCH_COLUMNS,
  connectorInstallId: dispatchRows.connectorInstallId,
  connectionId: dispatchRows.connectionId,
  connectionGeneration: dispatchRows.connectionGeneration,
  argsDigest: dispatchRows.argsDigest,
} as const;

/** Strict wire shape at the seam: anything wider is a contract break, not a leak. */
function dispatchSummaryOf(row: DispatchLedgerRow): PackageDispatchSummaryDTO {
  return PackageDispatchSummaryDTOSchema.parse({
    operationId: row.operationId,
    runId: row.runId,
    attemptGeneration: row.attemptGeneration,
    toolCallId: row.toolCallId,
    installId: row.installId,
    resourceId: row.resourceId,
    toolRef: row.toolRef,
    effect: row.effect,
    state: row.state,
    receiptRef: (row.receiptRef as Record<string, unknown> | null) ?? null,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}

function surfaceRefused(code: PackageDispatchSurfaceCode): {
  readonly outcome: "refused";
  readonly code: PackageDispatchSurfaceCode;
} {
  return { outcome: "refused", code };
}

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function installVisibleUnder(
  tx: DataTransaction,
  scope: PlatformScope,
  installId: string,
): Promise<boolean> {
  const [install] = await tx
    .select({ id: installRows.id })
    .from(installRows)
    .where(
      and(
        eq(installRows.tenantId, scope.tenantId),
        eq(installRows.workspaceId, scope.workspaceId),
        eq(installRows.id, installId),
      ),
    )
    .limit(1);
  return install !== undefined;
}

/** `notes:lookup` → `lookup`（与 dispatchPackageTool 的 toolNameOf 同式）。 */
function toolNameOfRef(resourceId: string, toolRef: string): string {
  return toolRef.slice(resourceId.length + 1);
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
  /**
   * T13-fix-1 (Codex FC-01)：部署侧共享撤回事实面（可选）。注入时
   * beginDispatch 先取与部署命令同一把跨进程 release 锁，并两臂检查前重读
   * 当前索引事实——「撤回先提交→transport 0 / dispatch 先提交→已 dispatched
   * 保留」跨进程线性化成立。未注入时维持启动快照判定（既有测试注入面的
   * 行为不变；生产装配恒注入）。
   */
  readonly releaseFacts?: PackageReleaseFactsGate | null;
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
  /**
   * PKG10：已验证的供应商查询协议（可选）。生产装配不注册——当前仓库
   * 的 mcp/brokered transport 均无幂等查询协议（callTool 之外无按
   * operation 查询的接口），显式留空即「不可核对、不可自动重发」；测试
   * 注入用（package-unknown.test.ts 的协议路径）。
   */
  readonly vendorQuery?: PackageVendorQueryProtocol;
  /**
   * T13-fix-2 (Codex FC-02)：派发者进程租约身份的显式覆盖。缺省取本进程的
   * PROCESS_INCARNATION；只有测试（同库新装配模拟重启后的新进程）需要传入。
   */
  readonly incarnation?: string;
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

/**
 * T13-fix-2 (Codex FC-02)：派发者进程租约的身份与窗口。 incarnation 在进程
 * 内生成（模块加载即进程启动），生产装配每进程恰好一个 dispatch 服务，因此
 * 本常量即「本进程」的身份；测试以 `incarnation` 注入覆盖来模拟重启后的新
 * 进程。租约窗口只是崩溃恢复的证据事实（owner 承诺的结算期限），不是自动
 * 重发的触发器——恢复判定只看 owner incarnation 是否为本进程（单写者边界，
 * 与 §10 release 锁单机语义一致）。
 */
const PROCESS_INCARNATION = randomUUID();
const OWNER_LEASE_WINDOW_MS = 15 * 60_000;

export function createPackageDispatchService(
  input: CreatePackageDispatchInput,
): PackageDispatchService {
  const {
    data,
    catalogue,
    releaseFacts,
    artifactRoot,
    vault,
    toolInvocation,
    catalogDecisions,
  } = input;
  const vendorCall: PackageVendorCaller = input.vendorCall ?? DEFAULT_VENDOR;
  // PKG10：查询协议只在显式注册时存在；未注册即「不可核对、不可自动重发」。
  const vendorQuery: PackageVendorQueryProtocol | undefined = input.vendorQuery;
  // T13-fix-2：本装配的派发者租约身份（见 PROCESS_INCARNATION 注释）。
  const ownerIncarnation = input.incarnation ?? PROCESS_INCARNATION;

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
    // 显式 ORDER BY 让选取在历史残留重复行（同作用域多行）下也确定：
    // 最新 created_at 优先，id 兜底打破平局；写侧 bind 收敛保证新数据
    // 每作用域只一行（OCR R5-H-B）。
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
      )
      .orderBy(
        desc(enterprisePluginConnections.createdAt),
        desc(enterprisePluginConnections.id),
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
    /*
     * PKG06 (#465) 升级后一个 install 的 currentVersion 会前移，而旧 Run 的
     * pin 仍钉在旧 revision：门 4 因此拆成两半——
     *   (a) PIN 侧：按 pin.revision 读不可变 revision 行，解析该
     *       releaseVersion 的发布事实并核对 digest==pin.releaseDigest
     *       （制品漂移/发布丢失 → PACKAGE_WITHDRAWN；旧 Run 保留旧版本）。
     *   (b) 当前侧：install 当前版本的 manifest 决定 declared 契约——
     *       新 revision 已移除/变更的工具（digest/effect 不同）即使仍在
     *       旧 pin 与旧 grant 内也立即不可派发（#465 AC3、§10 交集语义）；
     *       两版本契约相同的工具继续放行（pin ∩ 当前有效 grant）。
     */
    const [pinnedRevision] = await tx
      .select({
        releaseVersion: revisionRows.releaseVersion,
        artifactDigest: revisionRows.artifactDigest,
      })
      .from(revisionRows)
      .where(
        and(
          eq(revisionRows.tenantId, scope.tenantId),
          eq(revisionRows.installId, binding.installId),
          eq(revisionRows.revision, pin.revision),
        ),
      )
      .limit(1);
    if (
      !pinnedRevision ||
      pinnedRevision.artifactDigest !== pin.releaseDigest
    ) {
      return refused("PACKAGE_WITHDRAWN");
    }
    if (releaseFacts) {
      // T13-fix-1 (Codex FC-01)：部署侧当前事实（pin 臂）——在共享 release
      // 锁内重读当前部署索引，读取后到 dispatched CAS 提交之间撤回无法落
      // 锁；「撤回先提交→transport 0」跨进程成立。读取失败/不在当前索引/
      // 摘要不符/非 published 一律 fail closed；boot 快照臂保留为门未注入
      // 部署（既有测试面）的兜底。listed 与此无关（发现面正交）。
      try {
        const pinnedDeployed = await releaseFacts.readFreshFacts(
          install.packageKey,
          pinnedRevision.releaseVersion,
        );
        if (
          pinnedDeployed?.artifactDigest !== pin.releaseDigest ||
          pinnedDeployed?.state !== "published"
        ) {
          return refused("PACKAGE_WITHDRAWN");
        }
      } catch {
        return refused("PACKAGE_WITHDRAWN");
      }
    }
    const pinnedRelease = await catalogue.resolveRelease(
      install.packageKey,
      pinnedRevision.releaseVersion,
    );
    if (
      !pinnedRelease?.verified ||
      !pinnedRelease.manifest ||
      pinnedRelease.artifactDigest !== pin.releaseDigest
    ) {
      // 发布撤回/制品漂移：不能新派发此版本。
      return refused("PACKAGE_WITHDRAWN");
    }
    if (pinnedRelease.state !== "published") {
      // PKG08 (#467)：安全撤回——旧 Run 的旧 pin 同样不能新派发。判定在
      // 与 dispatched CAS 同一事务、同一锁序内：撤回先提交（目录快照已换）
      // 则此处拒绝、transport 0 次；先 dispatched 则效果按下方完成写保留。
      return refused("PACKAGE_WITHDRAWN");
    }
    const currentRelease = await catalogue.resolveRelease(
      install.packageKey,
      install.version,
    );
    if (!currentRelease?.verified || !currentRelease.manifest) {
      return refused("PACKAGE_WITHDRAWN");
    }
    if (currentRelease.state !== "published") {
      // PKG08 (#467)：install 当前版本被撤回同样阻断（不依赖 pin 侧）。
      return refused("PACKAGE_WITHDRAWN");
    }
    if (releaseFacts) {
      // T13-fix-1 (Codex FC-01)：部署侧当前事实（install 当前版本臂）——
      // 同一锁窗口内重读；摘要与 boot 快照交叉核对（同版本异摘要不可能经
      // 部署通道发生，出现即索引漂移 → fail closed）。
      try {
        const currentDeployed = await releaseFacts.readFreshFacts(
          install.packageKey,
          install.version,
        );
        if (
          currentDeployed?.state !== "published" ||
          currentDeployed?.artifactDigest !== currentRelease.artifactDigest
        ) {
          return refused("PACKAGE_WITHDRAWN");
        }
      } catch {
        return refused("PACKAGE_WITHDRAWN");
      }
    }
    const declared = addedToolsOf(currentRelease.manifest).find(
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

  /**
   * T13-fix-2 (Codex FC-02)：崩溃恢复路径（生产恢复入口，证据规则 a——
   * 单写者边界）。把 owner incarnation 缺失（存量行）或异于本装配的
   * `dispatched` 行按「派发者已死」结算为 unknown（DISPATCH_CRASH 系语义，
   * 与 markUnknown 同一 SET 形状），绝不自动重发；本装配自己的 in-flight
   * 行（owner 即本 incarnation）不受影响。仅被恒经查询面
   * （listDispatches/inspectDispatch）在同一事务内、于读之前调用——台账与
   * 详情读到的永远先经一次结算，进程重启后第一次台账读即完成恢复。单实例
   * 部署边界（多进程共享一库时另一存活进程的 in-flight 行会被结算）与 §10
   * release 锁单机语义一致，见 Run 报告披露。
   */
  const settleOrphanedDispatchesWithin = async (
    tx: DataTransaction,
    scope: PlatformScope,
    installId: string,
  ): Promise<void> => {
    await tx
      .update(dispatchRows)
      .set({
        state: "unknown",
        receiptRef: { effectStatus: "unknown" },
        errorCode: "DISPATCH_CRASH",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dispatchRows.tenantId, scope.tenantId),
          eq(dispatchRows.workspaceId, scope.workspaceId),
          eq(dispatchRows.installId, installId),
          eq(dispatchRows.state, "dispatched"),
          // The lease evidence decides: a missing owner (pre-lease row) or a
          // foreign incarnation means the dispatching process is gone.
          or(
            isNull(dispatchRows.ownerIncarnation),
            ne(dispatchRows.ownerIncarnation, ownerIncarnation),
          ),
        ),
      );
  };

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
       * T13-fix-1 (Codex FC-01)：共享 release 锁。在取任何数据库锁之前获取
       * （部署命令只持这一把锁——锁序无环），持有直到 dispatched CAS 的事务
       * 提交之后：撤回无法落在锁内 fresh-facts 读取与 CAS 提交之间，故
       * 「撤回先提交→transport 0 / dispatch 先提交→已 dispatched 保留」跨
       * 进程线性化成立。transport 拨号在本区间之外（permit 返回后才发生）。
       * 锁超时（部署侧长时间持锁/陈旧锁竞态）按 fail closed 拒绝：transport
       * 0，typed refusal——事实不可核实即不可派发，绝不让其变成 500。
       */
      let releaseLock: Awaited<
        ReturnType<NonNullable<PackageReleaseFactsGate["acquireReleaseLock"]>>
      > | null = null;
      if (releaseFacts) {
        try {
          releaseLock = await releaseFacts.acquireReleaseLock();
        } catch {
          return refused("NOT_AVAILABLE");
        }
      }
      try {
        /*
         * The decision surfaces FIRST, each in its own short transaction:
         * #75's per-call Bot/account revalidation and MT031's install/
         * connection invoke gate. They are never called from inside the CAS
         * transaction (that would need a second pooled connection while this
         * one is held — a deadlock on a single-connection pool, and needless
         * contention on any other). The CAS transaction below re-reads every
         * fact they checked directly; neither surface is a substitute for
         * those reads.
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
        return await openTransaction(scope, async (tx) => {
          /*
           * Spec §8 lock order, staged because the connector-install and
           * connection ids only become known from the pin: member class first
           * (shared, from the trusted scope), then a lock-free read of the
           * pin's binding learns the lower-class ids, and every class is then
           * locked IN ORDER before the revalidation reads — install →
           * grant(bot) → connector-install → connection → operation. The
           * pre-lock read is only to learn ids; every authorization fact is
           * re-read under the locks below by resolveFacts.
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
            .set({
              state: "dispatched",
              // T13-fix-2 (Codex FC-02): the lease evidence rides the SAME
              // transaction as the CAS — who dispatched (this assembly's
              // process incarnation) and the settle-by window it promised.
              // Crash recovery reads exactly these facts.
              ownerIncarnation,
              ownerLeaseExpiresAt: new Date(Date.now() + OWNER_LEASE_WINDOW_MS),
              updatedAt: new Date(),
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
      } finally {
        await releaseLock?.release();
      }
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
        const inserted = await tx
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
          .onConflictDoNothing()
          .returning({ operationId: dispatchRows.operationId });
        if (inserted.length === 0) {
          // R2-H3: the (tenant, run, attemptGeneration, toolCallId) row
          // already exists — the insert was swallowed, so the ticket must
          // describe the LEDGER row (what beginDispatch CAS's and transport
          // executes), never this call's fresh resolution.
          const [standing] = await tx
            .select({
              state: dispatchRows.state,
              installId: dispatchRows.installId,
              resourceId: dispatchRows.resourceId,
              toolRef: dispatchRows.toolRef,
              connectorInstallId: dispatchRows.connectorInstallId,
              connectionId: dispatchRows.connectionId,
              connectionGeneration: dispatchRows.connectionGeneration,
              argsDigest: dispatchRows.argsDigest,
              effect: dispatchRows.effect,
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
          if (standing?.state !== "prepared") {
            // Already dispatched (or cancelled): the same duplicate gate the
            // beginDispatch CAS answers. A vanished row cannot happen (no
            // DELETE policy) and folds into the canonical refusal.
            return refused("DUPLICATE_DISPATCH");
          }
          const rowToolName = toolNameOfRef(
            standing.resourceId,
            standing.toolRef,
          );
          return {
            outcome: "ticket" as const,
            ticket: {
              runId: rawInput.runId,
              attemptGeneration: rawInput.attemptGeneration,
              toolCallId: rawInput.toolCallId,
              installId: standing.installId,
              resourceId: standing.resourceId,
              toolName: rowToolName,
              toolRef: standing.toolRef,
              ref: packageToolRefFor(
                standing.installId,
                standing.resourceId,
                rowToolName,
              ),
              // Descriptive only (no row column): the binding resolved for
              // this call; every ledger-binding field above is the row's.
              schemaDigest: resolution.facts.schemaDigest,
              effect: standing.effect as "read" | "write",
              connectorInstallId: standing.connectorInstallId,
              connectionId: standing.connectionId,
              connectionGeneration: standing.connectionGeneration,
              argsDigest: standing.argsDigest,
            },
          };
        }
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

    // -------------------------------------------------------------------------
    // PKG10（#469）：unknown 查询 / 核对 / 恢复面。全部只读或按原 operation
    // 写回；绝不派发、绝不重发、绝不删除（无 DELETE 策略，台账 append/
    // update-only）。失权调用者的 scope 在路由解析层即告失效；这里的显式
    // 谓词 + RLS 是第二、三道独立防线。
    // -------------------------------------------------------------------------

    async listDispatches(scope, rawInput) {
      assertTrustedScope(scope);
      if (
        !rawInput ||
        typeof rawInput.installId !== "string" ||
        !rawInput.installId.trim() ||
        rawInput.installId.length > 128
      ) {
        return surfaceRefused("NOT_AVAILABLE");
      }
      return openTransaction(scope, async (tx) => {
        if (!(await installVisibleUnder(tx, scope, rawInput.installId))) {
          return surfaceRefused("NOT_AVAILABLE");
        }
        // T13-fix-2 (Codex FC-02)：台账读即恢复入口——先结算孤儿 dispatched
        // 行，本进程重启后第一次台账读即把崩溃行呈现为 unknown。
        await settleOrphanedDispatchesWithin(tx, scope, rawInput.installId);
        const rows = await tx
          .select(DISPATCH_COLUMNS)
          .from(dispatchRows)
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.installId, rawInput.installId),
            ),
          )
          .orderBy(desc(dispatchRows.createdAt), desc(dispatchRows.operationId))
          .limit(50);
        return {
          outcome: "found" as const,
          value: rows.map((row) => dispatchSummaryOf(row)),
        };
      });
    },

    async inspectDispatch(scope, rawInput) {
      assertTrustedScope(scope);
      if (
        !rawInput ||
        typeof rawInput.installId !== "string" ||
        !rawInput.installId.trim() ||
        rawInput.installId.length > 128 ||
        typeof rawInput.operationId !== "string" ||
        !OPERATION_ID_PATTERN.test(rawInput.operationId)
      ) {
        return surfaceRefused("NOT_AVAILABLE");
      }
      const read = await openTransaction(scope, async (tx) => {
        if (!(await installVisibleUnder(tx, scope, rawInput.installId))) {
          return surfaceRefused("NOT_AVAILABLE");
        }
        // T13-fix-2 (Codex FC-02)：详情读同走恢复入口——被查看安装的孤儿
        // dispatched 行先结算，dead owner 的行不再以 in_flight 形象示人。
        await settleOrphanedDispatchesWithin(tx, scope, rawInput.installId);
        const [row] = await tx
          .select({
            ...DISPATCH_EVIDENCE_COLUMNS,
            accountHandle: enterprisePluginConnections.vendorRef,
          })
          .from(dispatchRows)
          .leftJoin(
            enterprisePluginConnections,
            and(
              eq(enterprisePluginConnections.tenantId, dispatchRows.tenantId),
              eq(enterprisePluginConnections.id, dispatchRows.connectionId),
            ),
          )
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.installId, rawInput.installId),
              eq(dispatchRows.operationId, rawInput.operationId),
            ),
          )
          .limit(1);
        if (!row) return surfaceRefused("NOT_AVAILABLE");
        // 关联回执：同 Run 已确定（succeeded/failed）的其他派发——核对面
        // 展示给处理人对照的「已有回执」，不伪造本调用的结果。
        const related =
          row.state === "unknown"
            ? await tx
                .select(DISPATCH_COLUMNS)
                .from(dispatchRows)
                .where(
                  and(
                    eq(dispatchRows.tenantId, scope.tenantId),
                    eq(dispatchRows.workspaceId, scope.workspaceId),
                    eq(dispatchRows.runId, row.runId),
                    inArray(dispatchRows.state, ["succeeded", "failed"]),
                    ne(dispatchRows.operationId, row.operationId),
                  ),
                )
                .orderBy(desc(dispatchRows.completedAt))
                .limit(10)
            : [];
        return { outcome: "found" as const, row, related };
      });
      if (read.outcome === "refused") return read;
      const { row, related } = read;
      const evidence = {
        connectionId: row.connectionId,
        accountHandle: row.accountHandle ?? null,
        connectorInstallId: row.connectorInstallId,
        argsDigest: row.argsDigest,
        connectionGeneration: row.connectionGeneration,
      };
      if (row.state === "unknown") {
        const verification = {
          kind: "unknown" as const,
          canQueryVendor: vendorQuery !== undefined,
          noAutoResendReason: (vendorQuery
            ? "VENDOR_QUERY_UNRESOLVED"
            : "NO_VENDOR_QUERY_PROTOCOL") as
            | "NO_VENDOR_QUERY_PROTOCOL"
            | "VENDOR_QUERY_UNRESOLVED",
          relatedReceipts: related.map((entry) => dispatchSummaryOf(entry)),
        };
        // 恢复门在只读事务之外探针（probe 自开事务；绝不嵌套）。
        const probe = await this.probeRecovery(scope, {
          runId: row.runId,
          attemptGeneration: row.attemptGeneration,
          bindingRef: packageToolRefFor(
            row.installId,
            row.resourceId,
            toolNameOfRef(row.resourceId, row.toolRef),
          ),
        });
        return {
          outcome: "found" as const,
          value: {
            dispatch: dispatchSummaryOf(row),
            evidence,
            verification,
            recovery:
              probe.outcome === "ready"
                ? { ready: true as const }
                : { ready: false as const, refusalCode: probe.code },
          },
        };
      }
      return {
        outcome: "found" as const,
        value: {
          dispatch: dispatchSummaryOf(row),
          evidence,
          verification:
            row.state === "succeeded" || row.state === "failed"
              ? { kind: "definite" as const }
              : { kind: "in_flight" as const },
          recovery: null,
        },
      };
    },

    async verifyDispatch(scope, rawInput) {
      assertTrustedScope(scope);
      if (
        !rawInput ||
        typeof rawInput.installId !== "string" ||
        !rawInput.installId.trim() ||
        rawInput.installId.length > 128 ||
        typeof rawInput.operationId !== "string" ||
        !OPERATION_ID_PATTERN.test(rawInput.operationId)
      ) {
        return surfaceRefused("NOT_AVAILABLE");
      }
      // 1) 读原行 + Run 发起人。只有原调用者本人能触发核对——供应商查询
      //    拨的是他们自己绑定的原账号；他人（含管理员）经查询面保留事实。
      const read = await openTransaction(scope, async (tx) => {
        const [row] = await tx
          .select(DISPATCH_EVIDENCE_COLUMNS)
          .from(dispatchRows)
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.workspaceId, scope.workspaceId),
              eq(dispatchRows.installId, rawInput.installId),
              eq(dispatchRows.operationId, rawInput.operationId),
            ),
          )
          .limit(1);
        if (!row) return null;
        const [run] = await tx
          .select({ principalId: enterpriseRuns.principalId })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, row.runId),
            ),
          )
          .limit(1);
        return { row, initiator: run?.principalId ?? null };
      });
      if (!read || read.initiator !== scope.principalId) {
        // 跨范围/不存在/非本人：同一 NOT_AVAILABLE 形状，不泄露存在性。
        return surfaceRefused("NOT_AVAILABLE");
      }
      const row = read.row;
      if (row.state !== "unknown") {
        return surfaceRefused("DISPATCH_NOT_UNKNOWN");
      }
      if (!vendorQuery) {
        // 无已验证协议（当前生产装配恒走此臂）：拒绝路径，transport 0 次。
        return surfaceRefused("VENDOR_QUERY_PROTOCOL_UNAVAILABLE");
      }
      // 2) 解析原账号访问（只读；envelope 仅进程内解封）。原连接行消失或
      //    换绑到他人时无法按原账号查询——拒绝，绝不借用别的账号。
      const binding: ResolvedBinding = {
        installId: row.installId,
        resourceId: row.resourceId,
        toolName: toolNameOfRef(row.resourceId, row.toolRef),
        toolRef: row.toolRef,
      };
      const staged = await openTransaction(scope, (tx) =>
        readBindingTargets(
          tx,
          scope,
          row.runId,
          row.attemptGeneration,
          binding,
        ),
      );
      const accessResolution = await openTransaction(scope, async (tx) => {
        await takeSharedLocks(tx, [
          ...memberLockKeys(scope),
          pluginInstallKey(scope, row.connectorInstallId),
          ...(row.connectionId
            ? [pluginConnectionKey(scope, row.connectionId)]
            : []),
        ]);
        const resolution = await resolveManagedAccessWithin(
          tx,
          scope,
          staged.botId ?? "",
          row.connectorInstallId,
          row.connectionId ?? undefined,
        );
        if (resolution.outcome !== "allow") return resolution;
        // OCR-fix-B (B3): the resolution may have auto-selected the caller's
        // CURRENT connection when the row carries none. A null connectionId
        // is the explicit no-connection fact of the original operation — the
        // vendor query must dial the original connection identity (id, and
        // generation when there was one), never a newer binding. Any drift
        // refuses here; the surface maps it to DISPATCH_ACCOUNT_UNAVAILABLE
        // and no vendor dial happens under another account.
        if (
          resolution.facts.connectionId !== row.connectionId ||
          (row.connectionId !== null &&
            resolution.facts.connectionGeneration !== row.connectionGeneration)
        ) {
          return refused("CONNECTION_UNAVAILABLE");
        }
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
      if (accessResolution.outcome !== "allow") {
        return surfaceRefused("DISPATCH_ACCOUNT_UNAVAILABLE");
      }
      // 3) 仅按原 operation 身份查询；参数摘要随行作证据绑定。
      const query = await vendorQuery({
        access: accessResolution.access,
        toolName: binding.toolName,
        operationId: row.operationId,
        argsDigest: row.argsDigest,
        effect: row.effect as "read" | "write",
      });
      if (!query.found) {
        // 协议无匹配：行保持 unknown 原样，不改写任何事实。
        return {
          outcome: "found" as const,
          value: {
            outcome: "unresolved" as const,
            dispatch: dispatchSummaryOf(row),
          },
        };
      }
      // 4) 写回：不做 grant 重验（效果已发生）；prior 段保留撤权前的
      //    unknown 事实（不丢弃）。CAS 仅在 unknown 行上生效。
      const verifiedAt = new Date();
      const written = await openTransaction(scope, async (tx) => {
        const updated = await tx
          .update(dispatchRows)
          .set({
            state: query.outcome,
            receiptRef: {
              effectStatus: query.effectStatus,
              isError: query.outcome === "failed",
              verifiedVia: "vendor_query",
              operationId: row.operationId,
              evidence: {
                connectionId: row.connectionId,
                accountHandle: accessResolution.access.accountHandle,
                connectorInstallId: row.connectorInstallId,
                argsDigest: row.argsDigest,
                connectionGeneration: row.connectionGeneration,
              },
              vendorReceipt: query.receiptRef ?? null,
              prior: {
                state: "unknown",
                errorCode: row.errorCode,
                receiptRef:
                  (row.receiptRef as Record<string, unknown> | null) ?? null,
              },
            },
            errorCode: null,
            completedAt: verifiedAt,
            updatedAt: verifiedAt,
          })
          .where(
            and(
              eq(dispatchRows.tenantId, scope.tenantId),
              eq(dispatchRows.operationId, row.operationId),
              eq(dispatchRows.state, "unknown"),
            ),
          )
          .returning(DISPATCH_COLUMNS);
        return updated[0] ?? null;
      });
      if (!written) {
        // 并发下已被写回：按现状拒绝，调用者重读。
        return surfaceRefused("DISPATCH_NOT_UNKNOWN");
      }
      return {
        outcome: "found" as const,
        value: {
          outcome: "verified" as const,
          dispatch: dispatchSummaryOf(written),
        },
      };
    },

    async probeRecovery(scope, rawInput) {
      assertTrustedScope(scope);
      if (
        !rawInput ||
        typeof rawInput.runId !== "string" ||
        !rawInput.runId.trim() ||
        !Number.isSafeInteger(rawInput.attemptGeneration) ||
        rawInput.attemptGeneration <= 0 ||
        typeof rawInput.bindingRef !== "string"
      ) {
        return { outcome: "refused", code: "NOT_AVAILABLE" as const };
      }
      const binding = resolveBinding(rawInput.bindingRef);
      if (!binding) {
        return { outcome: "refused", code: "NOT_AVAILABLE" as const };
      }
      const preTargets = await readTargets(
        scope,
        rawInput.runId,
        rawInput.attemptGeneration,
        binding,
      );
      if (!preTargets.botId) {
        return { outcome: "refused", code: "RUN_LEASE_INVALID" as const };
      }
      const surfacesBefore = await authorizeSurfaces(
        scope,
        preTargets.botId,
        binding.toolRef,
        preTargets.connectorInstallId,
      );
      if (surfacesBefore) return surfacesBefore;
      return openTransaction(scope, async (tx) => {
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
        const resolution = await resolveFacts(
          tx,
          scope,
          null,
          rawInput.runId,
          rawInput.attemptGeneration,
          binding,
          rawInput.args ?? {},
        );
        if (resolution.outcome !== "facts") {
          return { outcome: "refused", code: resolution.code };
        }
        return { outcome: "ready" as const };
      });
    },
  };
}
