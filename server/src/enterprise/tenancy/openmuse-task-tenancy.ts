// server/src/enterprise/tenancy/openmuse-task-tenancy.ts
// MT060（Issue #103）：OpenMuse 任务/计划/监控/租约归属域的作用域面。
//
// 票面语义（brief + Issue #103）：
//   AC1 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义。
//   AC2 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用。
//   AC3 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览）。
//   AC4 后台触发遵守 MT042 的作用域重建规则。
//
// 结构（纯新增；既有文件零改动，消费 MT041/MT042/MT059/MT005/MT011 既有出
// 口与既有 openmuse-tasks 权威 store——归属协会表 openmuse_task_scopes 是
// 本模块的唯一新持久化对象）：
//
//   1. 归属（AC2 的「租约」半边 + Spec §4.2 受约束关联）：每个任务在创建接
//      线时经 pinTaskScope 固定 (公司, 团队, 主体, 用户, Bot) 归属——先经
//      MT059 私有 Bot 服务验证 botId 就是当前三元组的私有 Bot（外来 Bot =
//      canonical not-found），再经 MT041 pinJobOwnership（kind='task'，租
//      约的物理前置 + basis 形状校验），最后写协会行（create-once；同三元
//      组幂等返回 existing，不同选择标识一律响亮拒绝且已存行不动）。
//   2. 范围化读取/控制（AC1）：一切用户面动作先过同一道范围门——受限 data
//      通道 + 事务本地上下文 + 真实 RLS（租户臂 + restrictive 主体自读臂）
//      → 事务内公司（active + epoch 匹配签发时版本）与团队（active）事实
//      重验 → 协会行 (tenant, workspace, principal) 三元组比对（第二道独立
//      防线）。缺席/跨团队/跨公司/他人/撤权对对象面全部折叠为不可见：
//      详情 = MT011 canonical RESOURCE_NOT_FOUND、控制 = {outcome:"missing"}
//      （同语义零副作用——任何任务行读写都发生在范围门之后）；列表面对公
//      司级撤销响亮拒绝（SCOPE_REVOKED，MT041 成员视图同纪律）。范围门通过
//      后委托既有 openmuse-tasks 权威 store：取消/暂停/重试/恢复/答等沿用
//      其全部状态矩阵与队列再投递语义，本模块零复刻。
//   3. 锁（AC2 的「锁」半边）：归属写入路径的作用域限定 advisory 锁——键
//      = ("openmuse-task-tenancy","scope",tenant,workspace,principal) 派生，
//      同三元组写入串行、跨三元组（尤其跨公司）结构性不相交（键不同则
//      pg_advisory_xact_lock 互不等待）。读路径按 MT016/MT022 同序键族持
//      共享锁。键派生函数导出（scopeTaskLockKey）供测试与复审钉死。
//   4. 旧根回填预览（AC3）：previewLegacyBackfill 只读分类——
//      openmuse_tasks 中尚无协会行的根记录，按 owner 的 workspace
//      membership 行数分类：恰一条 → 可回填（行给出唯一三元组）；零条或
//      多条 → 受控隔离（no-membership / ambiguous-membership，Spec §9.2
//      「不按猜测分配」）。机器身份门卫（跨公司事实只对平台触发身份开放），
//      零写入——回填执行权在 MT117，注册迁移语句（legacy_task_backfill）
//      是执行本体，preview 与其可逐行对照。
//   5. 后台触发作用域重建（AC4，MT042 同构）：resolveForExecution /
//      runUnderLease——机器身份（MT042 签发/信任标记，只读消费）→ 任务 id
//      元数据 → operator 通道 + 事务本地 app.scan_sweep='on'（本票迁移自带
//      的扫描臂）读权威协会行 → 真实签发入口 createScopeResolver
//      （entrypoint="schedule"）产出受信 Scope（重建不制造 Scope）→ MT041
//      租约（claim/finish/release）→ MT005 gate 事务内执行回调。消息
//      payload/调用方 hint 从不参与判定（仅类型上收窄），拒绝零回显。
//
// 事务纪律与 MT016/MT022/MT059 完全一致：assertTrustedScope → read
// committed + lock/statement timeout → set_config('app.*', …, true) 事务本
// 地 → advisory 锁（键序 tenant → principal → membership →
// workspace-membership；读共享、写排他）→ 成员事实重验 → 判定或执行。事实
// 读取全部经受限通道与真实 RLS；任务行读写经既有 store（平台通道，与生产
// 装配同源，范围合法性已由范围门钉死）。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形——不存在/跨团队/跨公司/他人/撤
// 权对外不可区分）。机器面哨兵码（确定性、零回显）：
// OPENMUSE_TASK_RECORD_MISSING / OPENMUSE_TASK_SCOPE_REVOKED /
// OPENMUSE_TASK_LEASE_MISMATCH / OPENMUSE_TASK_EXECUTION_FAILED。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：服务面供下游接线票复用（MT016/MT022/MT059 同例）。
//     任务行的队列再投递语义由既有 store 承担（本模块消费不绕过）。
//   - pin 的双写（MT041 pin → 协会行）是两个服务各自的事务，非原子：MT041
//     pin 成功而协会行失败时，作用域面不可见、租约面可被归属范围认领但执
//     行重建（读协会行）仍拒绝——重放 pinTaskScope 自愈（两级都幂等）。
//   - 回填的执行在 MT117；本票交付注册迁移 + 只读 preview + 语义证明。
//   - runUnderLease 不触队列（work_items 的认领/完结归 sweep 调用方，与
//     MT041 租约服务不触队列同纪律）。

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  type OpenMuseTaskScopeRow,
  openmuseTaskScopes,
} from "../../db/schema/openmuse-task-tenancy";
import type {
  OpenMuseTaskStore,
  StoredOpenMuseTask,
} from "../../openmuse-tasks/store";
import type { PlatformScope } from "../contracts";
import { assertTrustedMachineIdentity } from "../runs/scan-executor";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
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
import type { PersonalBotService } from "./personal-bot";
import { type WorkspaceGate, workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：一个任务的 (公司, 团队, 主体, 用户, Bot, 来源) 事实。 */
export interface OpenMuseTaskScopeView {
  readonly taskId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly botId: string;
  readonly attribution: "created" | "backfill";
  readonly createdAt: Date;
}

/** 范围化列表条目：任务行 + 归属事实。 */
export interface ScopedOpenMuseTask {
  readonly ownership: OpenMuseTaskScopeView;
  readonly task: StoredOpenMuseTask;
}

/** 单对象读取判定。allow 携带任务行与归属；一切不可见 = canonical not-found。 */
export type TaskReadOutcome =
  | {
      readonly outcome: "allow";
      readonly task: StoredOpenMuseTask;
      readonly ownership: OpenMuseTaskScopeView;
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type TaskScopePinResult =
  | { readonly status: "pinned"; readonly ownership: OpenMuseTaskScopeView }
  | { readonly status: "existing"; readonly ownership: OpenMuseTaskScopeView }
  | ResourceNotFoundVerdict;

/** AC3 只读预览的回填候选：唯一归属给出确切三元组。 */
export interface BackfillCandidate {
  readonly taskId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly botId: string;
}

/** AC3 只读预览的隔离清单条目：确定性原因码，不猜测归属。 */
export interface IsolatedLegacyTask {
  readonly taskId: string;
  readonly reason: "no-membership" | "ambiguous-membership";
}

export interface LegacyBackfillPreview {
  readonly attributable: readonly BackfillCandidate[];
  readonly isolated: readonly IsolatedLegacyTask[];
}

/** AC4 重建的权威事实（协会行投影）。 */
export interface OpenMuseTaskExecutionFacts {
  readonly taskId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly botId: string;
}

/** AC4 重建结果：受信 Scope + 权威事实；一切拒绝 = 确定性哨兵码（零回显）。 */
export type ExecutionResolution =
  | {
      readonly ok: true;
      readonly scope: PlatformScope;
      readonly facts: OpenMuseTaskExecutionFacts;
    }
  | { readonly ok: false; readonly code: string };

/** AC4 租约执行结局：业务拒绝是结局而不是异常（MT042 同纪律）。 */
export type LeaseRunOutcome =
  | { readonly status: "executed" }
  | { readonly status: "lease-held" }
  | { readonly status: "released"; readonly reason: string }
  | { readonly status: "refused"; readonly code: string };

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_TASK_SCOPE_INVALID = "OPENMUSE_TASK_SCOPE_INVALID";
export const OPENMUSE_TASK_SCOPE_MISMATCH = "OPENMUSE_TASK_SCOPE_MISMATCH";
export const OPENMUSE_TASK_CURSOR_INVALID = "OPENMUSE_TASK_CURSOR_INVALID";
export const OPENMUSE_TASK_RECORD_MISSING = "OPENMUSE_TASK_RECORD_MISSING";
export const OPENMUSE_TASK_SCOPE_REVOKED = "OPENMUSE_TASK_SCOPE_REVOKED";
export const OPENMUSE_TASK_LEASE_MISMATCH = "OPENMUSE_TASK_LEASE_MISMATCH";
export const OPENMUSE_TASK_EXECUTION_FAILED = "OPENMUSE_TASK_EXECUTION_FAILED";
/** 创建响亮门（MT059/MT016 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_TASK_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_TASK_SCOPE_INVALID}: ${rule}`);
}

// ---------------------------------------------------------------------------
// 输入校验（形状错误响亮拒绝；错误只含规则，不回显值）
// ---------------------------------------------------------------------------

const ID_MAX = 200;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    failInvalid(
      `${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    failInvalid(`${field} must be a positive integer`);
  }
  return value;
}

/** 列表页大小：1..100（与既有 openmuse-tasks 路由的合同上限一致）。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 作用域限定锁键（AC2「锁」半边：跨公司键结构性不相交）
// ---------------------------------------------------------------------------

/**
 * 归属写入路径的作用域 advisory 键。同一三元组的写入串行；任何其他三元组
 * （尤其跨公司/跨团队）键不同、互不等待——「公司 A 的锁不阻塞公司 B」的
 * 实现面。导出供测试与复审钉死派生规则。
 */
export function scopeTaskLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "openmuse-task-tenancy",
    "scope",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

/** 单任务的控制序列化锁键（控制 CAS 前的排他点）。 */
function taskControlLockKey(taskId: string): string {
  return JSON.stringify(["openmuse-task-tenancy", "task", taskId]);
}

// ---------------------------------------------------------------------------
// 行缝：既有 openmuse-tasks 权威 store 的最小投影 + 列表批量面
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。get/requestCancel/requestPause/resumeTask/
 * retryTask/answerWait 的语义（状态矩阵与队列再投递）全部归既有
 * openmuse-tasks/store.ts 权威，本模块零复刻、只做范围门后的委托。
 * listTasksByIds 是范围化列表的批量取行面（下游装配在既有 rows 对象上
 * 适配，一查 inArray）。
 */
export type OpenMuseTaskTenancyRows = Pick<
  OpenMuseTaskStore,
  | "get"
  | "requestCancel"
  | "requestPause"
  | "resumeTask"
  | "retryTask"
  | "answerWait"
> & {
  listTasksByIds(taskIds: readonly string[]): Promise<StoredOpenMuseTask[]>;
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * AC3 只读回填分类的行投影：既有平台主库上 openmuse_tasks × 主体 × 工作区
 * 成员资格的原始分类行（与注册迁移 legacy_task_backfill 语句逐行同构）。
 */
export interface LegacyTaskBackfillRow {
  readonly task_id: string;
  readonly bot_id: string;
  readonly principal_id: string | null;
  readonly user_id: string | null;
  readonly membership_count: number | string;
  readonly only_tenant: string | null;
  readonly only_workspace: string | null;
}

export interface OpenMuseTaskTenancyService {
  /**
   * 创建接线时的归属固定（AC2 租约面 + Spec §4.2）。外来 Bot = canonical
   * not-found；同三元组重放幂等 existing；不同选择标识一律
   * OPENMUSE_TASK_SCOPE_MISMATCH（或 MT041 的 JOB_OWNERSHIP_MISMATCH——pin
   * 先行）响亮拒绝且已存归属不动。
   */
  pinTaskScope(
    scope: PlatformScope,
    input: {
      readonly taskId: string;
      /** 必须就是当前三元组的私有 Bot（MT059 服务验证）。 */
      readonly botId: string;
      /** MT041 执行依据快照的创建 basis（生产由装配经 MT014 解析）。 */
      readonly basis: JobConfigBasisInput;
    },
  ): Promise<TaskScopePinResult>;

  /**
   * 范围化列表（AC1）：只返回 (tenant, workspace, principal) 三元组下本人
   * 发起的任务；公司级撤销响亮拒绝（SCOPE_REVOKED，MT041 成员视图同纪律）。
   * 分页 keyset 稳定序 (created_at DESC, task_id DESC)。
   */
  listTasks(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly tasks: readonly ScopedOpenMuseTask[];
    readonly nextCursor?: string;
  }>;

  /** 范围化详情（AC1）：不可见 = canonical not-found。 */
  readTask(scope: PlatformScope, taskId: string): Promise<TaskReadOutcome>;

  /** 范围化取消（AC1）：不可见 = {outcome:"missing"} 且零副作用。 */
  cancelTask(
    scope: PlatformScope,
    taskId: string,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "terminal"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "cancelled"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "requested"; readonly task: StoredOpenMuseTask }
  >;

  /** 范围化暂停（AC1）：同取消的不可见语义。 */
  pauseTask(
    scope: PlatformScope,
    taskId: string,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "terminal"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "paused"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "requested"; readonly task: StoredOpenMuseTask }
  >;

  /** 范围化恢复（AC1）：既有 store 的恢复矩阵（含队列再投递）。 */
  resumeTask(
    scope: PlatformScope,
    taskId: string,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "terminal"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "resumed"; readonly task: StoredOpenMuseTask }
  >;

  /** 范围化重试（AC1）：既有 store 的重试矩阵（幂等键 + 队列再投递）。 */
  retryTask(
    scope: PlatformScope,
    taskId: string,
    retryKey: string | null,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "terminal"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "retried"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "replayed"; readonly task: StoredOpenMuseTask }
  >;

  /** 范围化答等（AC1）：既有 store 的答等矩阵（确切 waitId 消费）。 */
  answerWait(
    scope: PlatformScope,
    taskId: string,
    waitId: string,
    values: Record<string, unknown>,
  ): Promise<
    | { readonly outcome: "missing" }
    | { readonly outcome: "invalid"; readonly error: string }
    | { readonly outcome: "terminal"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "replayed"; readonly task: StoredOpenMuseTask }
    | { readonly outcome: "answered"; readonly task: StoredOpenMuseTask }
  >;

  /**
   * AC3 只读预览：旧根记录的回填分类（可回填 + 隔离清单），零写入，机器
   * 身份门卫。与注册迁移的 legacy_task_backfill 语句逐行可对照。
   */
  previewLegacyBackfill(machine: unknown): Promise<LegacyBackfillPreview>;

  /**
   * AC4 重建：任务 id 元数据 → 权威协会行（扫描臂）→ 真实签发入口的受信
   * Scope。hint 参数仅类型面收窄（消息字段路由提示），从不参与判定。
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
   * AC4 租约执行：重建 → MT041 租约 → MT005 gate 事务内 work。成功完结
   * 租约；失败以机器码释放（零业务错误回显）；他人活租约 = lease-held。
   */
  runUnderLease(
    machine: unknown,
    input: {
      readonly taskId: string;
      readonly executor: JobExecutor;
      readonly leaseMs: number;
      readonly hint?: unknown;
      readonly work: (context: {
        readonly scope: PlatformScope;
        readonly tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
        readonly facts: OpenMuseTaskExecutionFacts;
      }) => Promise<void>;
    },
  ): Promise<LeaseRunOutcome>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMuseTaskTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  /**
   * 既有 openmuse-tasks 平台主库通道（与生产装配同源——任务行读写本就 riding
   * 主库连接，设计 §2「与既有装配一致」）。唯一用途：机器身份门卫之后的 AC3
   * 跨公司只读回填分类（openmuse_tasks 无企业 RLS，受限通道不可见；分类 SQL
   * 与注册迁移 legacy_task_backfill 语句逐行对照）。
   */
  readonly platform: Database;
  readonly rows: OpenMuseTaskTenancyRows;
  /** MT041 归属/租约服务（pin + 租约消费）。 */
  readonly jobs: JobOwnershipService;
  /** MT059 私有 Bot 服务（绑定验证，只读消费）。 */
  readonly personalBots: PersonalBotService;
  /** MT005 gate（执行回调事务）。 */
  readonly gate: WorkspaceGate;
  /**
   * 签发入口适配：以权威协会行事实（user/tenant/workspace）经真实
   * createScopeResolver（entrypoint="schedule"）产出受信 Scope。本模块从不
   * 构造 Scope 对象。
   */
  readonly issueScheduleScope: (facts: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
  }) => Promise<PlatformScope>;
}): OpenMuseTaskTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows, jobs, personalBots, gate, platform } = deps;

  /** 事务开场（MT008/MT011/MT016/MT021/MT022 判定入口同一形状）。 */
  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership（MT016
    // 同序键族，读持共享锁）。
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

  /**
   * 事务内成员事实重验（MT021/MT022 同款切片）：公司级 = active 且
   * epoch === scope.memberEpoch；团队级 = active。
   */
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

  /**
   * 对象级范围门（AC1 的唯一判定入口）：协会行经真实 RLS（租户臂 +
   * restrictive 主体自读臂）+ 事务内成员事实重验 + 三元组比对。任何不成立
   * = null（不可见）——撤销也折叠进不可见，零存在泄漏（列表面另行响亮）。
   */
  const authorizeTask = async (
    scope: PlatformScope,
    taskId: string,
  ): Promise<OpenMuseTaskScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmuseTaskScopes)
        .where(eq(openmuseTaskScopes.taskId, taskId))
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

  /** 控制动作的范围门：不可见 = null → {outcome:"missing"}；控制序列化锁。 */
  const gatedControl = async (
    scope: PlatformScope,
    taskId: string,
  ): Promise<OpenMuseTaskScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      // 控制序列化锁：同任务的控制 CAS 串行（写路径排他键族）。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${taskControlLockKey(taskId)}, 0))`,
      );
      const [row] = await tx
        .select()
        .from(openmuseTaskScopes)
        .where(eq(openmuseTaskScopes.taskId, taskId))
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

  /** AC4 重建（MT042 同构）：权威协会行经扫描臂读取；hint 从不参与。 */
  const rebuildFacts = async (
    taskId: string,
  ): Promise<
    | { ok: true; facts: OpenMuseTaskExecutionFacts }
    | { ok: false; code: string }
  > =>
    operator.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      // 平台触发上下文：事务本地、提交即清。本票迁移自带的扫描臂——没有
      // 它，本查询与业务面的租户臂行为逐字相同（跨公司零行）。
      await tx.execute(sql`select set_config('app.scan_sweep', 'on', true)`);
      const [row] = await tx
        .select()
        .from(openmuseTaskScopes)
        .where(eq(openmuseTaskScopes.taskId, taskId))
        .limit(1);
      if (!row) {
        return { ok: false as const, code: OPENMUSE_TASK_RECORD_MISSING };
      }
      return {
        ok: true as const,
        facts: {
          taskId: row.taskId,
          tenantId: row.tenantId,
          workspaceId: row.workspaceId,
          principalId: row.principalId,
          userId: row.userId,
          botId: row.botId,
        },
      };
    });

  return {
    async pinTaskScope(scope, input) {
      assertTrustedScope(scope);
      const taskId = requireId(input.taskId, "taskId");
      const botId = requireId(input.botId, "botId");
      requirePositiveInt(input.basis?.companyRevision, "basis.companyRevision");
      if (
        input.basis?.overrideRevision !== null &&
        input.basis?.overrideRevision !== undefined &&
        typeof input.basis.overrideRevision !== "number"
      ) {
        failInvalid("basis.overrideRevision must be null or a number");
      }
      if (input.basis?.document === undefined) {
        failInvalid("basis.document is required");
      }
      // Bot 绑定验证（MT059 消费，只读）：外来 Bot 与不存在不可区分。
      const botOutcome = await personalBots.getPersonalBotById(scope, botId);
      if (botOutcome.outcome === "deny") {
        return notFoundVerdict();
      }
      // MT041 pin 先行（basis 形状校验在其事务内；失败 = 零行落库。同任务
      // 已 pin 到不同选择标识时 JOB_OWNERSHIP_MISMATCH 在这里响亮拒绝）。
      await jobs.pinJobOwnership({
        kind: "task",
        objectId: taskId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        principalId: scope.principalId,
        basis: input.basis,
      });
      // 协会行（create-once）：作用域排他锁下写入；同三元组幂等，不同三元
      // 组响亮拒绝且已存行不动。
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_TASK_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        // 归属写锁：同三元组串行；跨三元组键不同、互不等待（AC2「锁」）。
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${scopeTaskLockKey(scope.tenantId, scope.workspaceId, scope.principalId)}, 0))`,
        );
        const [inserted] = await tx
          .insert(openmuseTaskScopes)
          .values({
            taskId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
            botId,
            attribution: "created",
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            status: "pinned" as const,
            ownership: scopeViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(openmuseTaskScopes)
          .where(eq(openmuseTaskScopes.taskId, taskId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_TASK_SCOPE_MISMATCH}: task is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: scopeViewOf(existing),
        };
      });
    },

    async listTasks(scope, page) {
      assertTrustedScope(scope);
      if (
        typeof page?.limit !== "number" ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > LIST_LIMIT_MAX
      ) {
        failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
      }
      let cursor: { createdAt: Date; taskId: string } | undefined;
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor);
        if (!decoded) throw new Error(OPENMUSE_TASK_CURSOR_INVALID);
        cursor = decoded;
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error(OPENMUSE_TASK_SCOPE_REVOKED);
        }
        if (!facts.teamActive) {
          return { tasks: [] as ScopedOpenMuseTask[] };
        }
        const associationRows = await tx
          .select()
          .from(openmuseTaskScopes)
          .where(
            and(
              eq(openmuseTaskScopes.tenantId, scope.tenantId),
              eq(openmuseTaskScopes.workspaceId, scope.workspaceId),
              eq(openmuseTaskScopes.principalId, scope.principalId),
              ...(cursor
                ? [
                    sql`(${openmuseTaskScopes.createdAt}, ${openmuseTaskScopes.taskId}) < (${cursor.createdAt}, ${cursor.taskId})`,
                  ]
                : []),
            ),
          )
          .orderBy(
            sql`${openmuseTaskScopes.createdAt} DESC, ${openmuseTaskScopes.taskId} DESC`,
          )
          .limit(page.limit + 1);
        const hasMore = associationRows.length > page.limit;
        const visible = associationRows.slice(0, page.limit);
        if (visible.length === 0) {
          return { tasks: [] as ScopedOpenMuseTask[] };
        }
        const taskRows = await rows.listTasksByIds(
          visible.map((row) => row.taskId),
        );
        const taskById = new Map(taskRows.map((task) => [task.id, task]));
        const tasks: ScopedOpenMuseTask[] = [];
        for (const row of visible) {
          const task = taskById.get(row.taskId);
          // 根行在两次读取之间被删除（级联清协会行前的窗口）：条目消失，
          // 不占页位、不泄露存在性。
          if (!task) continue;
          tasks.push({ ownership: scopeViewOf(row), task });
        }
        const last = visible[visible.length - 1];
        return {
          tasks,
          ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
        };
      });
    },

    async readTask(scope, taskId) {
      assertTrustedScope(scope);
      const id = requireId(taskId, "taskId");
      const ownership = await authorizeTask(scope, id);
      if (!ownership) return notFoundVerdict();
      const task = await rows.get(ownership.userId, id);
      if (!task) return notFoundVerdict();
      return { outcome: "allow" as const, task, ownership };
    },

    async cancelTask(scope, taskId) {
      const ownership = await gatedControl(scope, taskId);
      if (!ownership) return { outcome: "missing" as const };
      // 既有 store 的取消矩阵（owner 检查与归属不变量双重成立）。
      return rows.requestCancel(ownership.userId, taskId);
    },

    async pauseTask(scope, taskId) {
      const ownership = await gatedControl(scope, taskId);
      if (!ownership) return { outcome: "missing" as const };
      return rows.requestPause(ownership.userId, taskId);
    },

    async resumeTask(scope, taskId) {
      const ownership = await gatedControl(scope, taskId);
      if (!ownership) return { outcome: "missing" as const };
      return rows.resumeTask(ownership.userId, taskId);
    },

    async retryTask(scope, taskId, retryKey) {
      const ownership = await gatedControl(scope, taskId);
      if (!ownership) return { outcome: "missing" as const };
      return rows.retryTask(ownership.userId, taskId, retryKey ?? null);
    },

    async answerWait(scope, taskId, waitId, values) {
      const ownership = await gatedControl(scope, taskId);
      if (!ownership) return { outcome: "missing" as const };
      return rows.answerWait(ownership.userId, taskId, waitId, values);
    },

    async previewLegacyBackfill(machine) {
      assertTrustedMachineIdentity(machine);
      // 只读分类（平台通道：openmuse_tasks 无企业 RLS，跨公司事实仅对签发
      // 的机器身份开放）。零写入——回填执行权在 MT117。
      const legacy = (await platform.execute(sql`
        select t."id" as task_id,
               t."bot_id" as bot_id,
               p."id" as principal_id,
               p."user_id" as user_id,
               count(wm."principal_id") as membership_count,
               (array_agg(wm."tenant_id" order by wm."tenant_id", wm."workspace_id"))[1] as only_tenant,
               (array_agg(wm."workspace_id" order by wm."tenant_id", wm."workspace_id"))[1] as only_workspace
        from "openmuse_tasks" t
        left join "enterprise_principals" p on p."user_id" = t."owner_user_id"
        left join "enterprise_workspace_memberships" wm on wm."principal_id" = p."id"
        where not exists (
          select 1 from "openmuse_task_scopes" s where s."task_id" = t."id"
        )
        group by t."id", t."bot_id", p."id", p."user_id"
        order by t."id" asc
      `)) as unknown;
      const list = (
        Array.isArray(legacy)
          ? legacy
          : ((legacy as { rows?: unknown[] })?.rows ?? [])
      ) as readonly LegacyTaskBackfillRow[];
      const attributable: BackfillCandidate[] = [];
      const isolated: IsolatedLegacyTask[] = [];
      for (const row of list) {
        const count = Number(row.membership_count ?? 0);
        if (!row.principal_id || count === 0) {
          isolated.push({ taskId: row.task_id, reason: "no-membership" });
        } else if (count > 1) {
          isolated.push({
            taskId: row.task_id,
            reason: "ambiguous-membership",
          });
        } else {
          attributable.push({
            taskId: row.task_id,
            tenantId: row.only_tenant as string,
            workspaceId: row.only_workspace as string,
            principalId: row.principal_id,
            userId: row.user_id as string,
            botId: row.bot_id,
          });
        }
      }
      return { attributable, isolated };
    },

    async resolveForExecution(machine, input) {
      assertTrustedMachineIdentity(machine);
      const taskId = requireId(input.taskId, "taskId");
      const rebuilt = await rebuildFacts(taskId);
      if (!rebuilt.ok) return rebuilt;
      try {
        const scope = await deps.issueScheduleScope({
          actorId: rebuilt.facts.userId,
          tenantId: rebuilt.facts.tenantId,
          workspaceId: rebuilt.facts.workspaceId,
        });
        return { ok: true as const, scope, facts: rebuilt.facts };
      } catch {
        // 签发入口重验失败（撤权/成员缺失）：确定性哨兵码，零回显。
        return { ok: false as const, code: OPENMUSE_TASK_SCOPE_REVOKED };
      }
    },

    async runUnderLease(machine, input) {
      assertTrustedMachineIdentity(machine);
      const taskId = requireId(input.taskId, "taskId");
      const rebuilt = await rebuildFacts(taskId);
      if (!rebuilt.ok) {
        return { status: "refused" as const, code: rebuilt.code };
      }
      const { facts } = rebuilt;
      let scope: PlatformScope;
      try {
        scope = await deps.issueScheduleScope({
          actorId: facts.userId,
          tenantId: facts.tenantId,
          workspaceId: facts.workspaceId,
        });
      } catch {
        return {
          status: "refused" as const,
          code: OPENMUSE_TASK_SCOPE_REVOKED,
        };
      }
      try {
        await jobs.claimJobLease({
          kind: "task",
          objectId: taskId,
          scope: { tenantId: facts.tenantId, workspaceId: facts.workspaceId },
          executor: input.executor,
          leaseMs: input.leaseMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith(JOB_LEASE_HELD)) {
          return { status: "lease-held" as const };
        }
        return {
          status: "refused" as const,
          code: OPENMUSE_TASK_LEASE_MISMATCH,
        };
      }
      try {
        await gate.transaction(scope, async (tx) => {
          await input.work({ scope, tx, facts });
        });
      } catch {
        await jobs
          .releaseJobLease({
            kind: "task",
            objectId: taskId,
            scope: { tenantId: facts.tenantId, workspaceId: facts.workspaceId },
            executor: input.executor,
            reason: OPENMUSE_TASK_EXECUTION_FAILED,
          })
          .catch(() => {});
        return {
          status: "released" as const,
          reason: OPENMUSE_TASK_EXECUTION_FAILED,
        };
      }
      await jobs.finishJobLease({
        kind: "task",
        objectId: taskId,
        scope: { tenantId: facts.tenantId, workspaceId: facts.workspaceId },
        executor: input.executor,
      });
      return { status: "executed" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射与游标（模块底部小件）
// ---------------------------------------------------------------------------

function scopeViewOf(row: OpenMuseTaskScopeRow): OpenMuseTaskScopeView {
  return {
    taskId: row.taskId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    botId: row.botId,
    attribution: row.attribution === "backfill" ? "backfill" : "created",
    createdAt: row.createdAt,
  };
}

const encodeCursor = (row: OpenMuseTaskScopeRow): string =>
  Buffer.from(
    JSON.stringify({
      c: row.createdAt.toISOString(),
      i: row.taskId,
    }),
    "utf8",
  ).toString("base64");

function decodeCursor(raw: string): { createdAt: Date; taskId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      c?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.i.length === 0
    ) {
      return null;
    }
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, taskId: parsed.i };
  } catch {
    return null;
  }
}
