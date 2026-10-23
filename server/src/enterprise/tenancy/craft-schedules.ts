// server/src/enterprise/tenancy/craft-schedules.ts
// MT054（Issue #97）：Craft 计划任务、子任务与应用连接的归属。
//
// 票面语义（Issue #97 正文）：
//   AC1 计划任务保存原始归属；触发执行时重建作用域（复用 MT042 规则）。
//   AC2 子任务不能引用其他范围的父任务或连接。
//   AC3 取消计划任务只影响本范围；跨范围请求被拒绝。
//   AC4 连接凭据通过 lease 取用，撤销后触发失败而不是静默使用他人凭据。
//
// 结构（纯新增服务面 + 一张协会表 enterprise_craft_schedule_scopes
// （MT054 迁移），只读消费 MT005/MT011/MT029/MT041/MT042 既有出口与既有
// craft 权威 store，不改任何既有文件语义——MT060 openmuse 任务域同型
// 判例）：
//
//   1. 归属（Spec §4.2 受约束关联，create-once）：
//      pinCraftSchedule——计划任务在创建接线时固定归属：先经 MT041
//      pinJobOwnership（kind='task'，租约的物理前置）再写协会行；本人
//      事务内验证 craft_scheduled_tasks 行存在且 user_id === 受信 scope
//      的 actorId（本人创建的行；他人任务/不存在 → canonical
//      not-found）。pinCraftSubtask——父任务协会行必须已在同一三元组
//      （跨范围/跨公司父 = canonical not-found——子任务结构性引用不到
//      其他范围的父任务，AC2 父半边）；pinCraftConnection——连接固定
//      credential_ref（创建时固定归属；凭据解析与 lease 取用发生在触发
//      时，AC4）。同三元组重放幂等 existing；不同选择标识一律
//      CRAFT_SCHEDULE_SCOPE_MISMATCH 响亮拒绝且已存行不动——「切换团队
//      不改变归属」的实现面（MT041 同款守卫 + 零 UPDATE 授权）。
//   2. 范围化列表/取消（AC1/AC3）：一切用户面动作先过同一道范围门——
//      受限 data 通道 + 事务本地上下文 + 真实 RLS（租户臂 + restrictive
//      主体自读臂）→ 事务内公司（active + epoch 匹配签发时版本）与团队
//      （active）事实重验 → 协会行三元组比对。取消经范围门后委托既有
//      权威 store（softDeleteTask / updateTask 状态矩阵——MT043 取消
//      传播的 craft 承载面）；跨范围/撤权 = {outcome:"missing"} 且零
//      副作用（不可见 = 无传播，MT047 同语义）；列表面对公司级撤销响亮
//      拒绝（SCOPE_REVOKED，MT041 成员视图同纪律）。
//   3. 触发的作用域重建（AC1，MT042 同构）：resolveForExecution——机器
//      身份（只读消费 MT042 签发/信任标记，本模块从不构造 Scope）→
//      operator 通道 + 事务本地 app.scan_sweep='on'（本票迁移自带的
//      扫描臂）读权威协会行 → 真实签发入口适配
//      （issueScheduleScope(entrypoint="schedule")）产出受信 Scope。
//      队列消息的路由提示（hint）从不参与判定——归属只有协会行一个
//      事实源（MT042 规则逐字）。
//   4. 触发执行 + 连接 lease（AC4）：runScheduledFire——重建 → 逐连接
//      验证：连接协会行必须在重建出的三元组内（跨范围连接结构性拒绝，
//      AC2 连接半边）→ 经注入的真实 CredentialLeaseService.validate
//      （purpose='connector-call'，MT029 六道校验不复制第二份）取用凭据。
//      lease 撤销/失效/不匹配 → 触发失败（failed，errorClass 机器码
//      CRAFT_SCHEDULE_LEASE_DENIED，零 work 执行），绝不静默改用他人
//      凭据——凭据的可达面只有「本人三元组内的连接 + 本人签发的 lease」，
//      他人同名 ref 凭据对本路径结构性不可见。
//   5. 租约：runUnderLease 消费 MT041 claim/finish/release（kind='task'，
//      pin 的物理前置）——认领前归属三比（RLS 租户臂 + workspace 逐字
//      相等 + 执行者匹配），他人活租约 = lease-held。
//
// 事务纪律与 MT016/MT022/MT060 完全一致：受信 Scope（assertTrustedScope）
// → read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁（键序 tenant → principal → membership →
// workspace-membership；读共享、写排他）→ 成员事实重验 → 判定或委托。
// 任务行读写经既有 craft 权威 store（平台通道，与生产装配同源——范围
// 合法性已由范围门钉死后委托）。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形——不存在/跨团队/跨公司/他人/
// 撤权对外不可区分）。哨兵码（确定性、零回显）：
// CRAFT_SCHEDULE_RECORD_MISSING / CRAFT_SCHEDULE_TASK_CANCELLED /
// CRAFT_SCHEDULE_SCOPE_MISMATCH / CRAFT_SCHEDULE_PARENT_NOT_FOUND /
// CRAFT_SCHEDULE_LEASE_DENIED / CRAFT_SCHEDULE_LEASE_HELD /
// CRAFT_SCHEDULE_WORKSPACE_MEMBERSHIP_REQUIRED / SCOPE_REVOKED。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由与调度器装配（服务面供下游接线票复用，
//     MT016/MT022/MT060 同例）；craft 的个人调度面（scheduled-tasks.ts
//     的既有 dispatcher/executor）原样不动。
//   - pin 的双写（MT041 pin → 协会行）是两个服务各自的事务，非原子：
//     MT041 pin 成功而协会行失败时，租约面可被归属范围认领但触发重建
//     （读协会行）仍拒绝——重放 pin 自愈（两级都幂等，MT060 同款边界）。
//   - 连接的凭据解析只经 MT029 lease 面（本模块不直接读凭据行——凭据
//     材料对执行路径零暴露）；「他人凭据不可达」由连接协会行的三元组
//     比对 + lease 的主体绑定共同钉死。
//   - 既有个人计划任务（无协会行）在企业面不可见：不猜测回填（Spec
//     §9.2「不按猜测分配」）；本票只钉创建接线与触发语义。

import { and, eq, sql } from "drizzle-orm";
import type { CraftScheduledTaskRow } from "../../craft/scheduled-tasks";
import {
  type CraftScheduleObjectKind,
  enterpriseCraftScheduleScopes,
} from "../../db/schema/enterprise-craft-schedules";
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
import type { CredentialLeaseService } from "./credential-lease";
import {
  JOB_LEASE_HELD,
  type JobConfigBasisInput,
  type JobExecutor,
  type JobOwnershipService,
} from "./job-ownership";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 哨兵码与词表
// ---------------------------------------------------------------------------

export const CRAFT_SCHEDULE_ID_INVALID = "CRAFT_SCHEDULE_ID_INVALID";
export const CRAFT_SCHEDULE_INPUT_INVALID = "CRAFT_SCHEDULE_INPUT_INVALID";
export const CRAFT_SCHEDULE_REF_INVALID = "CRAFT_SCHEDULE_REF_INVALID";
export const CRAFT_SCHEDULE_KIND_INVALID = "CRAFT_SCHEDULE_KIND_INVALID";
export const CRAFT_SCHEDULE_SCOPE_MISMATCH = "CRAFT_SCHEDULE_SCOPE_MISMATCH";
export const CRAFT_SCHEDULE_PARENT_NOT_FOUND =
  "CRAFT_SCHEDULE_PARENT_NOT_FOUND";
export const CRAFT_SCHEDULE_RECORD_MISSING = "CRAFT_SCHEDULE_RECORD_MISSING";
/**
 * 触发重建的权威任务行已被取消（软删除）：陈旧队列消息在 cancelSchedule
 * 之后到达时重建拒绝——已删除的任务不产出执行事实（fix2）。
 */
export const CRAFT_SCHEDULE_TASK_CANCELLED = "CRAFT_SCHEDULE_TASK_CANCELLED";
export const CRAFT_SCHEDULE_LEASE_DENIED = "CRAFT_SCHEDULE_LEASE_DENIED";
export const CRAFT_SCHEDULE_LEASE_HELD = "CRAFT_SCHEDULE_LEASE_HELD";
export const CRAFT_SCHEDULE_WORKSPACE_MEMBERSHIP_REQUIRED =
  "CRAFT_SCHEDULE_WORKSPACE_MEMBERSHIP_REQUIRED";
export const CRAFT_SCHEDULE_SCOPE_REVOKED = "SCOPE_REVOKED";
/** 触发时连接凭据经 lease 取用的用途（MT029 词表内的连接器调用）。 */
export const CRAFT_SCHEDULE_CREDENTIAL_PURPOSE = "connector-call" as const;

// ---------------------------------------------------------------------------
// 行缝：既有 craft 权威 store 的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。任务行的全部语义（cron/状态矩阵/软删除/
 * run 历史）归既有 scheduled-tasks.ts 权威，本模块零复刻、只做范围门后
 * 的委托（MT060 rows 缝同款）。
 */
export type CraftSchedulesRows = {
  /** 属主自检读（pin 的「本人创建的行」守卫）。 */
  getTask(
    id: string,
    userId: string,
  ): Promise<CraftScheduledTaskRow | undefined>;
  /** 无属主检查的行读（触发重建读 run 上下文用）。 */
  getTaskById(id: string): Promise<CraftScheduledTaskRow | undefined>;
  /** 取消矩阵（AC3）：软删除（行 + run 历史保留，dispatch 不再投递）。 */
  softDeleteTask(id: string, userId: string): Promise<void>;
  /** 暂停/恢复（取消矩阵的另一臂；语义归权威 store）。 */
  updateTask(
    id: string,
    patch: {
      status?: "active" | "paused";
      nextRunAt?: Date | null;
      deleted?: boolean;
    },
  ): Promise<CraftScheduledTaskRow | undefined>;
  listTasks(userId: string): Promise<readonly CraftScheduledTaskRow[]>;
};

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

/** 一条归属协会行的投影（零内容，纯归属事实）。 */
export interface CraftScheduleScopeView {
  readonly kind: CraftScheduleObjectKind;
  readonly objectId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly parentObjectId: string | null;
  readonly credentialRef: string | null;
  readonly createdAt: Date;
}

/** 协会行写入的值形状（kind 与配套列的结构 CHECK 一一对应）。 */
export interface CraftScheduleScopeRowValues {
  readonly kind: CraftScheduleObjectKind;
  readonly objectId: string;
  readonly parentObjectId?: string | null;
  readonly credentialRef?: string | null;
}

export type CraftSchedulePinResult =
  | { readonly status: "pinned"; readonly ownership: CraftScheduleScopeView }
  | { readonly status: "existing"; readonly ownership: CraftScheduleScopeView };

/** 触发重建出的执行事实（协会行是唯一事实源）。 */
export interface CraftScheduleExecutionFacts {
  readonly taskId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  /** 该任务可见的连接（同三元组，按确定性 (kind, object_id) 序）。 */
  readonly connections: readonly {
    readonly connectionId: string;
    readonly credentialRef: string;
  }[];
}

export type ExecutionResolution =
  | {
      readonly outcome: "resolved";
      readonly scope: PlatformScope;
      readonly facts: CraftScheduleExecutionFacts;
    }
  | { readonly outcome: "missing"; readonly code: string };

export type LeaseRunOutcome =
  | { readonly outcome: "ran" }
  | { readonly outcome: "lease-held" }
  | { readonly outcome: "failed"; readonly errorClass: string }
  | { readonly outcome: "missing"; readonly code: string };

export interface CraftSchedulesService {
  /** 计划任务的归属固定（AC1）：MT041 pin 先行 + 协会行 create-once。 */
  pinCraftSchedule(
    scope: PlatformScope,
    input: {
      readonly taskId: string;
      /** MT041 执行依据快照的创建 basis（生产由装配经 MT014 解析）。 */
      readonly basis: JobConfigBasisInput;
    },
  ): Promise<CraftSchedulePinResult | ResourceNotFoundVerdict>;

  /**
   * 子任务的归属固定（AC2 父半边）：父任务协会行必须已在同一三元组——
   * 跨范围/跨公司父 = canonical not-found（子任务结构性引用不到）。
   */
  pinCraftSubtask(
    scope: PlatformScope,
    input: {
      readonly subtaskId: string;
      readonly parentTaskId: string;
      readonly basis: JobConfigBasisInput;
    },
  ): Promise<CraftSchedulePinResult | ResourceNotFoundVerdict>;

  /**
   * 应用连接的归属固定（AC2 连接半边 + AC4 前半）：credential_ref 创建
   * 时固定；触发时经 lease 解析——本入口不读凭据行。
   */
  pinCraftConnection(
    scope: PlatformScope,
    input: { readonly connectionId: string; readonly credentialRef: string },
  ): Promise<CraftSchedulePinResult | ResourceNotFoundVerdict>;

  /** 范围化列表（AC1）：本人三元组下的任务；公司级撤销响亮拒绝。 */
  listSchedules(scope: PlatformScope): Promise<{
    readonly tasks: readonly {
      readonly taskId: string;
      readonly name: string;
      readonly status: CraftScheduledTaskRow["status"];
      readonly deleted: boolean;
      readonly createdAt: Date;
    }[];
  }>;

  /**
   * 范围化取消（AC3）：只影响本范围；跨范围 = {outcome:"missing"} 且
   * 权威 store 零调用。取消矩阵（软删除）语义归权威 store。
   */
  cancelSchedule(
    scope: PlatformScope,
    taskId: string,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "cancelled"; readonly task: CraftScheduledTaskRow }
    | { readonly outcome: "not-found" }
  >;

  /**
   * AC1 触发重建（MT042 同构）：机器身份 → 扫描臂读权威协会行 → 真实
   * 签发入口的受信 Scope。hint（队列消息路由提示）从不参与判定。
   */
  resolveForExecution(
    machine: unknown,
    input: {
      readonly taskId: string;
      /** 队列消息的路由提示——本方法刻意不读它（MT042 规则）。 */
      readonly hint?: unknown;
    },
  ): Promise<ExecutionResolution>;

  /**
   * AC4 触发执行：重建 → 连接 lease 逐条验证（跨范围连接结构性拒绝；
   * lease 撤销/失效 = failed，零 work）→ MT041 租约 → work(scope)。
   */
  runScheduledFire(
    machine: unknown,
    input: {
      readonly taskId: string;
      readonly executor: JobExecutor;
      readonly leaseMs: number;
      readonly hint?: unknown;
      /** 本次触发携带的连接 lease（装配在触发前经 MT029 issue 签发）。 */
      readonly connectionLeases: readonly {
        readonly connectionId: string;
        readonly leaseId: string;
      }[];
      readonly work: (context: {
        readonly scope: PlatformScope;
        readonly facts: CraftScheduleExecutionFacts;
        readonly credentials: readonly {
          readonly connectionId: string;
          readonly credentialId: string;
        }[];
      }) => Promise<void>;
    },
  ): Promise<LeaseRunOutcome>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

/** 机器身份的签发标记（MT042 同款：签发入口盖章，本模块只认标记）。 */
const machineIdentities = new WeakSet<object>();

/** 机器身份的签出入口（接线方在触发器装配处调用；测试经此标记）。 */
export function issueCraftScheduleMachineIdentity(): object {
  const identity: Record<string, never> = {};
  machineIdentities.add(identity);
  return identity;
}

/** 归属写的作用域限定 advisory 锁键。 */
export function scopeCraftScheduleLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise-craft-schedules",
    "scope",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const requireId = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !PLAIN_ID.test(value)) {
    throw new Error(`${CRAFT_SCHEDULE_ID_INVALID}: ${field}`);
  }
  return value;
};
const requireRef = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new Error(`${CRAFT_SCHEDULE_REF_INVALID}: ${field}`);
  }
  return value;
};

export function createCraftSchedulesService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: CraftSchedulesRows;
  /** MT041 归属/租约服务（pin + 租约消费）。 */
  readonly jobs: JobOwnershipService;
  /** MT029 凭据 lease 服务（AC4 校验点，真实服务注入）。 */
  readonly leases: CredentialLeaseService;
  /**
   * 签发入口适配：以权威协会行事实经真实 createScopeResolver
   * （entrypoint="schedule"）产出受信 Scope。本模块从不构造 Scope。
   */
  readonly issueScheduleScope: (facts: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
  }) => Promise<PlatformScope>;
}): CraftSchedulesService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);
  const { data, operator, rows, jobs, leases, issueScheduleScope } = deps;

  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
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
  };

  const readMembershipFacts = async (tx: DataTx, scope: PlatformScope) => {
    const [company] = await tx
      .select({
        status: enterpriseMemberships.status,
        epoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    const [team] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    return {
      companyActive:
        company?.status === "active" && company?.epoch === scope.memberEpoch,
      teamActive: team?.status === "active",
    };
  };

  const scopeViewOf = (
    row: typeof enterpriseCraftScheduleScopes.$inferSelect,
  ): CraftScheduleScopeView => ({
    kind: row.kind,
    objectId: row.objectId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    parentObjectId: row.parentObjectId,
    credentialRef: row.credentialRef,
    createdAt: row.createdAt,
  });

  /** 协会行的 create-once 写入（同三元组幂等；mismatch 响亮拒绝）。 */
  const insertScopeRow = async (
    tx: OperatorTx,
    scope: PlatformScope,
    values: CraftScheduleScopeRowValues,
  ): Promise<CraftSchedulePinResult> => {
    const [inserted] = await tx
      .insert(enterpriseCraftScheduleScopes)
      .values({
        kind: values.kind,
        objectId: values.objectId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        userId: scope.actorId,
        ...(values.parentObjectId !== undefined
          ? { parentObjectId: values.parentObjectId }
          : {}),
        ...(values.credentialRef !== undefined
          ? { credentialRef: values.credentialRef }
          : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { status: "pinned" as const, ownership: scopeViewOf(inserted) };
    }
    const [existing] = await tx
      .select()
      .from(enterpriseCraftScheduleScopes)
      .where(
        and(
          eq(enterpriseCraftScheduleScopes.kind, values.kind),
          eq(enterpriseCraftScheduleScopes.objectId, values.objectId),
        ),
      )
      .limit(1);
    if (
      existing &&
      existing.tenantId === scope.tenantId &&
      existing.workspaceId === scope.workspaceId &&
      existing.principalId === scope.principalId &&
      existing.userId === scope.actorId &&
      (existing.parentObjectId ?? null) === (values.parentObjectId ?? null) &&
      (existing.credentialRef ?? null) === (values.credentialRef ?? null)
    ) {
      return {
        status: "existing" as const,
        ownership: scopeViewOf(existing),
      };
    }
    throw new Error(CRAFT_SCHEDULE_SCOPE_MISMATCH);
  };

  /** 范围门 + 会员重验 + 协会行写入的公共外壳（前置守卫在事务前完成）。 */
  const pinUnderScope = async (
    scope: PlatformScope,
    values: CraftScheduleScopeRowValues,
  ): Promise<CraftSchedulePinResult | ResourceNotFoundVerdict> =>
    operator.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) {
        return DENY_VERDICT;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${scopeCraftScheduleLockKey(
          scope.tenantId,
          scope.workspaceId,
          scope.principalId,
        )}, 0))`,
      );
      return insertScopeRow(tx, scope, values);
    });

  /** 对象级范围门（AC1/AC3 的唯一判定入口）；不成立 = null（不可见）。 */
  const authorizeSchedule = async (
    scope: PlatformScope,
    kind: CraftScheduleObjectKind,
    objectId: string,
  ): Promise<CraftScheduleScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(enterpriseCraftScheduleScopes)
        .where(
          and(
            eq(enterpriseCraftScheduleScopes.kind, kind),
            eq(enterpriseCraftScheduleScopes.objectId, objectId),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (
        row.tenantId !== scope.tenantId ||
        row.workspaceId !== scope.workspaceId ||
        row.principalId !== scope.principalId
      ) {
        return null;
      }
      return scopeViewOf(row);
    });

  /**
   * AC4 重建（MT042 同构）：权威协会行经扫描臂读取；hint 从不参与。
   * 重建前先核权威任务行状态：cancelSchedule 的软删除是取消的事实源，
   * 协会行只是归属——已删除的任务拒绝重建（陈旧队列消息不能复活它）。
   */
  const rebuildFacts = async (
    taskId: string,
  ): Promise<
    | { ok: true; facts: CraftScheduleExecutionFacts }
    | { ok: false; code: string }
  > => {
    const task = await rows.getTaskById(taskId);
    if (task === undefined) {
      return { ok: false as const, code: CRAFT_SCHEDULE_RECORD_MISSING };
    }
    if (task.deleted) {
      return { ok: false as const, code: CRAFT_SCHEDULE_TASK_CANCELLED };
    }
    return operator.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      await tx.execute(sql`select set_config('app.scan_sweep', 'on', true)`);
      const [task] = await tx
        .select()
        .from(enterpriseCraftScheduleScopes)
        .where(
          and(
            eq(enterpriseCraftScheduleScopes.kind, "scheduled_task"),
            eq(enterpriseCraftScheduleScopes.objectId, taskId),
          ),
        )
        .limit(1);
      if (!task) {
        return { ok: false as const, code: CRAFT_SCHEDULE_RECORD_MISSING };
      }
      const connections = await tx
        .select({
          objectId: enterpriseCraftScheduleScopes.objectId,
          credentialRef: enterpriseCraftScheduleScopes.credentialRef,
        })
        .from(enterpriseCraftScheduleScopes)
        .where(
          and(
            eq(enterpriseCraftScheduleScopes.kind, "connection"),
            eq(enterpriseCraftScheduleScopes.tenantId, task.tenantId),
            eq(enterpriseCraftScheduleScopes.workspaceId, task.workspaceId),
            eq(enterpriseCraftScheduleScopes.principalId, task.principalId),
          ),
        )
        .orderBy(enterpriseCraftScheduleScopes.objectId);
      return {
        ok: true as const,
        facts: {
          taskId: task.objectId,
          tenantId: task.tenantId,
          workspaceId: task.workspaceId,
          principalId: task.principalId,
          userId: task.userId,
          connections: connections.map((row) => ({
            connectionId: row.objectId,
            credentialRef: row.credentialRef ?? "",
          })),
        },
      };
    });
  };

  const requireMachine = (machine: unknown): object => {
    if (
      typeof machine !== "object" ||
      machine === null ||
      !machineIdentities.has(machine)
    ) {
      throw new Error("UNVERIFIED_CRAFT_SCHEDULE_MACHINE_IDENTITY");
    }
    return machine;
  };

  return {
    async pinCraftSchedule(scope, input) {
      assertTrustedScope(scope);
      const taskId = requireId(input.taskId, "taskId");
      // 本人创建的行守卫（他人任务/不存在不可区分）。
      const own = await rows.getTask(taskId, scope.actorId);
      if (!own) return DENY_VERDICT;
      // MT041 pin 先行（basis 形状校验在其事务内；失败 = 零行落库）。
      await jobs.pinJobOwnership({
        kind: "task",
        objectId: taskId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        principalId: scope.principalId,
        basis: input.basis,
      });
      return pinUnderScope(scope, {
        kind: "scheduled_task",
        objectId: taskId,
      });
    },

    async pinCraftSubtask(scope, input) {
      assertTrustedScope(scope);
      const subtaskId = requireId(input.subtaskId, "subtaskId");
      const parentTaskId = requireId(input.parentTaskId, "parentTaskId");
      // AC2 父半边：父任务协会行必须已在同一三元组——跨范围/跨公司父 =
      // canonical not-found（子任务结构性引用不到其他范围的父任务）。
      const parent = await authorizeSchedule(
        scope,
        "scheduled_task",
        parentTaskId,
      );
      if (parent === null) {
        return DENY_VERDICT;
      }
      await jobs.pinJobOwnership({
        kind: "task",
        objectId: subtaskId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        principalId: scope.principalId,
        basis: input.basis,
      });
      return pinUnderScope(scope, {
        kind: "subtask",
        objectId: subtaskId,
        parentObjectId: parentTaskId,
      });
    },

    async pinCraftConnection(scope, input) {
      assertTrustedScope(scope);
      const connectionId = requireId(input.connectionId, "connectionId");
      const credentialRef = requireRef(input.credentialRef, "credentialRef");
      // AC4 前半：连接固定 credential_ref（创建时归属）；不读凭据行——
      // 凭据解析只发生在触发时的 lease 面。
      return pinUnderScope(scope, {
        kind: "connection",
        objectId: connectionId,
        credentialRef,
      });
    },

    async listSchedules(scope) {
      assertTrustedScope(scope);
      const memberOk = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        return facts.companyActive && facts.teamActive;
      });
      if (!memberOk) throw new Error(CRAFT_SCHEDULE_SCOPE_REVOKED);
      const scopeRows = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        return tx
          .select({ objectId: enterpriseCraftScheduleScopes.objectId })
          .from(enterpriseCraftScheduleScopes)
          .where(
            and(
              eq(enterpriseCraftScheduleScopes.kind, "scheduled_task"),
              eq(enterpriseCraftScheduleScopes.tenantId, scope.tenantId),
              eq(enterpriseCraftScheduleScopes.workspaceId, scope.workspaceId),
              eq(enterpriseCraftScheduleScopes.principalId, scope.principalId),
            ),
          );
      });
      const pinnedIds = new Set(scopeRows.map((row) => row.objectId));
      const authoritative = await rows.listTasks(scope.actorId);
      const tasks = authoritative.flatMap((row) =>
        pinnedIds.has(row.id)
          ? [
              {
                taskId: row.id,
                name: row.name,
                status: row.status,
                deleted: row.deleted,
                createdAt: row.createdAt,
              },
            ]
          : [],
      );
      return { tasks };
    },

    async cancelSchedule(scope, taskId) {
      assertTrustedScope(scope);
      requireId(taskId, "taskId");
      const ownership = await authorizeSchedule(
        scope,
        "scheduled_task",
        taskId,
      );
      if (ownership === null) {
        // 跨范围/撤权/不存在 = {outcome:"missing"} 且权威 store 零调用
        // （AC3：不可见 = 无传播）。
        return { outcome: "missing" as const };
      }
      // 取消矩阵归权威 store（软删除：行 + run 历史保留，dispatch 不再
      // 投递）。属主行守卫在 store 自带（userId）。
      await rows.softDeleteTask(taskId, scope.actorId);
      const after = await rows.getTaskById(taskId);
      if (!after) return { outcome: "not-found" as const };
      return { outcome: "cancelled" as const, task: after };
    },

    async resolveForExecution(machine, input) {
      requireMachine(machine);
      const taskId = requireId(input.taskId, "taskId");
      // hint（路由提示）刻意不读——归属只有协会行一个事实源（MT042）。
      const rebuilt = await rebuildFacts(taskId);
      if (!rebuilt.ok) {
        return { outcome: "missing" as const, code: rebuilt.code };
      }
      const scope = await issueScheduleScope({
        actorId: rebuilt.facts.userId,
        tenantId: rebuilt.facts.tenantId,
        workspaceId: rebuilt.facts.workspaceId,
      });
      return { outcome: "resolved" as const, scope, facts: rebuilt.facts };
    },

    async runScheduledFire(machine, input) {
      requireMachine(machine);
      const taskId = requireId(input.taskId, "taskId");
      const rebuilt = await rebuildFacts(taskId);
      if (!rebuilt.ok) {
        return { outcome: "missing" as const, code: rebuilt.code };
      }
      const scope = await issueScheduleScope({
        actorId: rebuilt.facts.userId,
        tenantId: rebuilt.facts.tenantId,
        workspaceId: rebuilt.facts.workspaceId,
      });
      // AC2 连接半边 + AC4：连接协会行必须在重建三元组内（rebuildFacts
      // 已按三元组收窄）；本次触发携带的 lease 逐条经真实 MT029 服务
      // 校验。撤销/失效/不匹配 = failed（零 work），绝不静默改用他人凭据。
      const connectionsById = new Map(
        rebuilt.facts.connections.map((connection) => [
          connection.connectionId,
          connection,
        ]),
      );
      const credentials: {
        readonly connectionId: string;
        readonly credentialId: string;
      }[] = [];
      for (const supplied of input.connectionLeases) {
        const connection = connectionsById.get(supplied.connectionId);
        if (connection === undefined) {
          return {
            outcome: "failed" as const,
            errorClass: CRAFT_SCHEDULE_LEASE_DENIED,
          };
        }
        const validation = await leases.validate(scope, {
          leaseId: supplied.leaseId,
          purpose: CRAFT_SCHEDULE_CREDENTIAL_PURPOSE,
          // MT029 六检查点的闭集：触发时取用凭据 = credentials.access。
          checkpoint: "credentials.access",
        });
        if (!("outcome" in validation) || validation.outcome !== "allow") {
          return {
            outcome: "failed" as const,
            errorClass: CRAFT_SCHEDULE_LEASE_DENIED,
          };
        }
        credentials.push({
          connectionId: supplied.connectionId,
          credentialId: validation.credentialId,
        });
      }
      // AC1 租约半边：MT041 claim（归属三比在其内）→ work → finish。
      // 他人活租约 = claim 响亮抛错（MT041 状态机）→ lease-held。
      try {
        await jobs.claimJobLease({
          kind: "task",
          objectId: taskId,
          scope: {
            tenantId: rebuilt.facts.tenantId,
            workspaceId: rebuilt.facts.workspaceId,
          },
          executor: input.executor,
          leaseMs: input.leaseMs,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith(JOB_LEASE_HELD)
        ) {
          return { outcome: "lease-held" as const };
        }
        throw error;
      }
      try {
        await input.work({ scope, facts: rebuilt.facts, credentials });
        await jobs.finishJobLease({
          kind: "task",
          objectId: taskId,
          scope: {
            tenantId: rebuilt.facts.tenantId,
            workspaceId: rebuilt.facts.workspaceId,
          },
          executor: input.executor,
        });
        return { outcome: "ran" as const };
      } catch (error) {
        await jobs.releaseJobLease({
          kind: "task",
          objectId: taskId,
          scope: {
            tenantId: rebuilt.facts.tenantId,
            workspaceId: rebuilt.facts.workspaceId,
          },
          executor: input.executor,
        });
        const errorClass =
          error instanceof Error && error.message.trim() !== ""
            ? error.message.slice(0, 120)
            : "CRAFT_SCHEDULE_EXECUTION_FAILED";
        return { outcome: "failed" as const, errorClass };
      }
    },
  };
}
