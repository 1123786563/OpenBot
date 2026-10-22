// server/src/enterprise/tenancy/job-control.ts
// MT043（Issue #86）：认领、重试与人工取消保持归属。
//
// 票面：任务认领、失败重试与人工取消都在原归属范围内进行；取消只对有权
// 主体生效，重试不会把任务漂移到别的公司或团队。
//
// 结构（纯新增服务面，零 schema 变更——复用 MT041 的 job_ownership /
// job_config_snapshots / job_leases 与 #90 的取消传播 seam）：
//
//   1. 授权（cancelJob/retryJob 共用）：受信 PlatformScope（MT005 集中授权
//      seam 的唯一产物，assertTrustedScope 拒手造同形对象）→ data 通道事务
//      内两级成员重验（公司 active 且 epoch 一致 + 团队行 active）→ 归属行
//      三比（tenant + workspace + principal 与 pin 逐字相等——成员视图语义：
//      本人发起、所选团队范围内）。任一不成立 → MT011 canonical
//      RESOURCE_NOT_FOUND：不存在、跨团队、跨公司、他人任务不可区分，错误
//      与副作用都不泄露存在性（不可见 = 零写入、零传播）。
//   2. 取消（cancelJob）：先传播后清租约——授权通过后把取消信号交给 #90
//      的 cancelExecution（ExecutionGrant 判定 + 逐面 ExecutionSurface +
//      审计行），再把 job_leases 的持有人三元组清空并落 finished_at。传播
//      的 bot 归属由 #90 的判定独立复核（异 workspace 的 bot = canonical
//      deny，一个执行面都不被调用）；job 取消与 bot 传播是两个对象的两个
//      判定，互不冒充。
//   3. 重试（retryJob）：授权同上；活租约被他人持有时按 MT041 哨兵码
//      JOB_LEASE_HELD 拒绝（重试是失败/过期后的动作，不是抢运行中的执行）；
//      通过后追加一条 purpose='execution' 的依据快照，内容逐字取自 creation
//      快照——重试执行按创建时的配置版本走，不重新解析当前配置（「配置版
//      本保持不变」的落点），并清掉死租约残留让下一次 claimJobLease 接管
//      （attempts 递增，重认领不是新任务）。归属三不变是 DB 结构事实：
//      job_ownership 无任何角色的 UPDATE 授权，本入口也不重 pin。
//
// 事务纪律与 MT041 同款：读路径 data 通道（真实 RLS），写路径 operator 通
// 道受限角色 + UPDATE 授权；read committed + lock/statement timeout；
// set_config('app.*', …, true) 事务本地；时钟一律数据库的（now()）。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由：cancelJob/retryJob 是网关层服务入口，路由装配
//     由接线票落（与 #90 seam 同例；票面 Verification 即测试文件）。
//   - 成员入口按成员视图语义只认发起主体本人；公司管理员的控制面不在本票
//     范围（管理视图读取已有 listJobsForCompanyAdmin，控制装配随路由票）。
//   - 取消传播依赖注入的 seam（ExecutionCancellationSeam，#90 服务满足该
//     结构）；未注入时取消仍清租约，传播报告 requested:false（部署没有可
//     传播面时与 #90 的空 surfaces 数组同义）。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  jobConfigSnapshots,
  jobLeases,
  jobOwnership,
} from "../../db/schema/job-ownership";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import type { SurfaceAttempt } from "./execution-artifacts";
import {
  JOB_LEASE_HELD,
  JOB_OWNERSHIP_INVALID,
  type JobKind,
  type JobOwnershipView,
  type JobRef,
} from "./job-ownership";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** #90 取消传播 seam 的结构面（createExecutionArtifactsService 满足它）。 */
export interface ExecutionCancellationSeam {
  cancelExecution(
    scope: PlatformScope,
    botId: string,
    input?: { readonly runId?: string },
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly attempts: readonly SurfaceAttempt[];
      }
    | ResourceNotFoundVerdict
  >;
}

/** 取消请求里调用方关联的执行侧对象（传播目标；归属由 seam 独立判定）。 */
export interface JobExecutionTargetInput {
  readonly botId?: string;
  readonly runId?: string;
}

export type CancelJobOutcome =
  | {
      readonly outcome: "cancelled";
      /** 清租约前的持有状态：cleared = 有持有人被清掉；idle = 本无活持有人。 */
      readonly lease: { readonly status: "cleared" | "idle" };
      /** 传播摘要：未关联执行对象时 requested:false；deny 与 allow 都如实回传。 */
      readonly propagation: {
        readonly requested: boolean;
        readonly verdict?: "allow" | "deny";
        readonly attempts?: readonly SurfaceAttempt[];
      };
    }
  | ResourceNotFoundVerdict;

export type RetryJobOutcome =
  | {
      readonly outcome: "retry-armed";
      /** 归属事实（重读自权威行——三不变的回答，不是调用方输入的回显）。 */
      readonly ownership: JobOwnershipView;
      /** 刚追加的重试执行依据：逐字等于 creation 快照（配置版本不变）。 */
      readonly retryBasis: {
        readonly companyRevision: number;
        readonly overrideRevision: number | null;
        readonly basisDigest: string;
        readonly purpose: "execution";
      };
    }
  | ResourceNotFoundVerdict;

export interface JobControlServiceOptions {
  /** 受限 operator 通道：租约清空与依据快照写入（真实 RLS + UPDATE 授权）。 */
  readonly operator: OperatorDatabase;
  /** 受限 data 通道：成员视图可见性判定（真实 RLS）。 */
  readonly data: DataDatabase;
  /** #90 取消传播 seam；缺省 = 本部署无可传播面（取消只清租约）。 */
  readonly execution?: ExecutionCancellationSeam;
}

export interface JobControlService {
  cancelJob(
    viewer: PlatformScope,
    input: {
      kind: JobKind;
      objectId: string;
      execution?: JobExecutionTargetInput;
    },
  ): Promise<CancelJobOutcome>;
  retryJob(
    viewer: PlatformScope,
    input: { kind: JobKind; objectId: string },
  ): Promise<RetryJobOutcome>;
}

// ---------------------------------------------------------------------------
// 输入校验（与 MT041 同款哨兵码：形状错误响亮拒绝，不是存在性信号）
// ---------------------------------------------------------------------------

const JOB_KINDS: ReadonlySet<string> = new Set(["task", "run", "trigger"]);
const ID_MAX = 200;

function failInvalid(rule: string): never {
  throw new Error(`${JOB_OWNERSHIP_INVALID}: ${rule}`);
}

function requireKind(value: unknown): JobKind {
  if (typeof value !== "string" || !JOB_KINDS.has(value)) {
    failInvalid(`kind must be one of ${[...JOB_KINDS].sort().join(", ")}`);
  }
  return value as JobKind;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    failInvalid(
      `${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

function requireOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireId(value, field);
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

/** data 通道的归属三比 + 两级成员重验（一切入口的第一道门）。 */
async function visibleOwnership(
  data: DataDatabase,
  viewer: PlatformScope,
  ref: JobRef,
): Promise<{
  readonly ownership: JobOwnershipView;
  readonly liveLeaseHeld: boolean;
} | null> {
  return data.transaction(async (tx) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${viewer.tenantId}, true), set_config('app.workspace_id', ${viewer.workspaceId}, true), set_config('app.principal_id', ${viewer.principalId}, true), set_config('app.user_id', ${viewer.actorId}, true)`,
    );
    // 公司级重验：撤权（挂起）递增 epoch，已签发 scope 立即失效（fail-closed）。
    const [company] = await tx
      .select({
        status: enterpriseMemberships.status,
        epoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, viewer.tenantId),
          eq(enterpriseMemberships.principalId, viewer.principalId),
        ),
      )
      .limit(1);
    if (company?.status !== "active" || company.epoch !== viewer.memberEpoch) {
      throw new Error("SCOPE_REVOKED");
    }
    // 团队级重验：行存在且 active（移除删行、挂起翻 status，都落在这里）。
    const [team] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, viewer.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, viewer.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, viewer.principalId),
        ),
      )
      .limit(1);
    if (team?.status !== "active") {
      throw new Error("SCOPE_REVOKED");
    }
    // 归属三比（成员视图语义）：RLS 之后跨公司行本事务不可见；同公司异团队、
    // 同团队他人发起在这里过滤——三种「不是我的任务」与「不存在」共用同一
    // 个 null，不存在性不泄露。
    const [row] = await tx
      .select()
      .from(jobOwnership)
      .where(
        and(
          eq(jobOwnership.kind, ref.kind),
          eq(jobOwnership.objectId, ref.objectId),
          eq(jobOwnership.tenantId, viewer.tenantId),
          eq(jobOwnership.workspaceId, viewer.workspaceId),
          eq(jobOwnership.principalId, viewer.principalId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [creation] = await tx
      .select()
      .from(jobConfigSnapshots)
      .where(
        and(
          eq(jobConfigSnapshots.kind, ref.kind),
          eq(jobConfigSnapshots.objectId, ref.objectId),
          eq(jobConfigSnapshots.purpose, "creation"),
        ),
      )
      .limit(1);
    if (!creation) {
      // 归属行与 creation 快照同事务写入（MT041 结构）；缺行只可能是外部
      // 手工删数据——响亮失败，不伪装成合法视图。
      throw new Error(
        "JOB_OWNERSHIP_REQUIRED: creation basis snapshot missing",
      );
    }
    // 租约判活用 DB 时钟（与 MT041 认领/续约同一纪律：两个时钟假装一个
    // 时钟就是双重执行）。
    const [lease] = await tx
      .select({
        live: sql<boolean>`(${jobLeases.claimedBy} is not null and ${jobLeases.leaseUntil} > now())`,
      })
      .from(jobLeases)
      .where(
        and(eq(jobLeases.kind, ref.kind), eq(jobLeases.objectId, ref.objectId)),
      )
      .limit(1);
    const liveLeaseHeld = lease?.live === true;
    return {
      ownership: {
        kind: row.kind as JobKind,
        objectId: row.objectId,
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        principalId: row.principalId,
        createdAt: row.createdAt,
        creationBasis: {
          companyRevision: creation.companyRevision,
          overrideRevision: creation.overrideRevision,
          basisDigest: creation.basisDigest,
          capturedAt: creation.capturedAt as Date,
        },
      },
      liveLeaseHeld,
    };
  });
}

export function createJobControlService(
  options: JobControlServiceOptions,
): JobControlService {
  assertOperatorDatabase(options.operator);
  assertDataDatabase(options.data);
  const { operator, data } = options;
  const seam = options.execution;

  /** operator 通道：清空租约持有人并落 finished_at（取消的写半边）。 */
  const clearLeaseForCancel = async (
    viewer: PlatformScope,
    ref: JobRef,
  ): Promise<"cleared" | "idle"> =>
    operator.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${viewer.tenantId}, true)`,
      );
      const [cleared] = await tx
        .update(jobLeases)
        .set({
          claimedByKind: null,
          claimedBy: null,
          leaseUntil: null,
          finishedAt: sql`now()`,
          lastError: "cancelled",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobLeases.kind, ref.kind),
            eq(jobLeases.objectId, ref.objectId),
            sql`${jobLeases.claimedBy} is not null`,
          ),
        )
        .returning({ objectId: jobLeases.objectId });
      return cleared ? "cleared" : "idle";
    });

  /** operator 通道：追加重试依据（= creation 快照逐字）并清死租约残留。 */
  const armRetry = async (
    viewer: PlatformScope,
    ref: JobRef,
    creation: {
      companyRevision: number;
      overrideRevision: number | null;
      basisDigest: string;
    },
  ): Promise<void> =>
    operator.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${viewer.tenantId}, true)`,
      );
      await tx.insert(jobConfigSnapshots).values({
        kind: ref.kind,
        objectId: ref.objectId,
        purpose: "execution",
        companyRevision: creation.companyRevision,
        overrideRevision: creation.overrideRevision,
        basisDigest: creation.basisDigest,
      });
      // 只清「已不构成活租约」的残留（WHERE 带过期判定）：判读后到写入前
      // 的窗口里被他人抢先 claim 的活租约原样保留——重试不抢运行中的执行。
      await tx
        .update(jobLeases)
        .set({
          claimedByKind: null,
          claimedBy: null,
          leaseUntil: null,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobLeases.kind, ref.kind),
            eq(jobLeases.objectId, ref.objectId),
            sql`(${jobLeases.claimedBy} is null or ${jobLeases.leaseUntil} is null or ${jobLeases.leaseUntil} <= now())`,
          ),
        );
    });

  return {
    async cancelJob(viewer, input) {
      assertTrustedScope(viewer);
      const ref: JobRef = {
        kind: requireKind(input.kind),
        objectId: requireId(input.objectId, "objectId"),
      };
      const botId = requireOptionalId(
        input.execution?.botId,
        "execution.botId",
      );
      const runId = requireOptionalId(
        input.execution?.runId,
        "execution.runId",
      );
      const visible = await visibleOwnership(data, viewer, ref);
      if (visible === null) return notFoundVerdict();
      // 先传播后清租约：清掉租约与传播之间没有窗口能让重认领插队开新工。
      let propagation: {
        requested: boolean;
        verdict?: "allow" | "deny";
        attempts?: readonly SurfaceAttempt[];
      };
      if (seam && botId !== undefined) {
        const verdict = await seam.cancelExecution(viewer, botId, {
          ...(runId !== undefined ? { runId } : {}),
        });
        propagation =
          verdict.outcome === "allow"
            ? { requested: true, verdict: "allow", attempts: verdict.attempts }
            : { requested: true, verdict: "deny" };
      } else {
        propagation = { requested: false };
      }
      const leaseStatus = await clearLeaseForCancel(viewer, ref);
      return {
        outcome: "cancelled" as const,
        lease: { status: leaseStatus },
        propagation,
      };
    },

    async retryJob(viewer, input) {
      assertTrustedScope(viewer);
      const ref: JobRef = {
        kind: requireKind(input.kind),
        objectId: requireId(input.objectId, "objectId"),
      };
      const visible = await visibleOwnership(data, viewer, ref);
      if (visible === null) return notFoundVerdict();
      // 活租约被持有：重试是失败/过期后的动作，不抢运行中的执行（MT041
      // 哨兵码，状态冲突不是存在性信号——调用方本就有权看到这个 job）。
      if (visible.liveLeaseHeld) {
        throw new Error(
          `${JOB_LEASE_HELD}: a live lease is held; retry targets failed or expired attempts`,
        );
      }
      const creation = visible.ownership.creationBasis;
      await armRetry(viewer, ref, {
        companyRevision: creation.companyRevision,
        overrideRevision: creation.overrideRevision,
        basisDigest: creation.basisDigest,
      });
      return {
        outcome: "retry-armed" as const,
        ownership: visible.ownership,
        retryBasis: {
          companyRevision: creation.companyRevision,
          overrideRevision: creation.overrideRevision,
          basisDigest: creation.basisDigest,
          purpose: "execution" as const,
        },
      };
    },
  };
}
