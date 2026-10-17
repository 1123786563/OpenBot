// server/src/enterprise/tenancy/job-ownership.ts
// MT041（Issue #84）：任务、运行、触发与租约固定原始归属与配置版本。
//
// 票面：每个任务/运行/触发/租约在创建时固定公司、团队、发起主体、业务对
// 象与配置版本；用户之后切换团队不会改变已创建任务的归属。租约只能被同
// 一归属的执行者持有，跨范围认领被拒绝；配置版本变化后可追溯当时的执行
// 依据；任务列表与详情只返回有权范围（含管理视图）。
//
// 结构（四件事，全部纯新增；本文件不触碰既有业务表——归属经「受约束关联」
// (kind, object_id) → job_ownership，Spec §4.2 逐字形状）：
//
//   1. pinJobOwnership：创建时归属持久化。同一 (kind, objectId) 幂等（同
//      归属返回 existing、零写入）；后续请求携带不同选择标识一律
//      JOB_OWNERSHIP_MISMATCH 拒绝且已存归属不变——「切换团队不改变归属」
//      的实现面是这条守卫 + 迁移层零 UPDATE 授权（DB 结构不可变）。
//   2. 配置依据快照：pin 时写 creation 快照（每 job 一行）；每次执行经
//      recordJobExecutionBasis 追加 execution 快照。快照只增不改（无
//      UPDATE 授权），配置版本变化后历史行不变——当时的执行依据可追溯。
//      basis 是入参（两级 revision + resolved document），digest 对文档
//      的确定性 canonical JSON 计算 SHA-256——绑定内容，不只是版本号。
//   3. 租约：claim/renew/finish/release。认领前归属三比：pin 必须在认领
//      范围可见（RLS 租户臂——跨公司行结构性不可见）、workspace 与 pin
//      逐字相等（应用层第二道防线）、执行者匹配（续约/完结 WHERE 带持有
//      人）。时钟一律数据库的（now() + make_interval），与 work 队列同一
//      纪律：两个时钟假装一个时钟就是双重执行。
//   4. 列表/详情：成员视图（受信 Scope → 事务内成员重验 → workspace +
//      principal 过滤）与管理视图（真实受信 CompanyAdminContext → 本公司
//      全量）。一切拒绝 canonical RESOURCE_NOT_FOUND 逐字节同消息——不存
//      在、跨团队、跨公司不可区分（MT011 语义）。
//
// 事务纪律与 MT008/MT011/MT014 同款：受信身份对象（PlatformScope /
// CompanyAdminContext）→ read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → 受限角色真实 RLS。写路径
// operator 通道，读路径 data 通道。

import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { enterpriseMemberships } from "../../db/schema/enterprise-tenancy";
import {
  jobConfigSnapshots,
  jobLeases,
  jobOwnership,
} from "../../db/schema/job-ownership";
import type { PlatformScope } from "../../enterprise/contracts";
import type { DataDatabase, OperatorDatabase } from "./connections";
import { assertDataDatabase, assertOperatorDatabase } from "./connections";
import { assertTrustedScope } from "./store";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 封闭词表：哪些执行单元有归属。租约不设 kind——租约只存在于已 pin 的 job 上。 */
export type JobKind = "task" | "run" | "trigger";
const JOB_KINDS: ReadonlySet<string> = new Set(["task", "run", "trigger"]);

/** 执行者身份：worker（平台受限执行身份）或 principal（发起主体本人）。 */
export interface JobExecutor {
  readonly kind: "worker" | "principal";
  readonly id: string;
}

/** 归属范围：公司 + 团队。发起主体单列（principalId）。 */
export interface JobScope {
  readonly tenantId: string;
  readonly workspaceId: string;
}

/** 创建/执行时的配置依据：两级版本标识 + 解析后文档（digest 的原料）。 */
export interface JobConfigBasisInput {
  readonly companyRevision: number;
  readonly overrideRevision: number | null;
  readonly document: unknown;
}

export interface JobOwnershipView {
  readonly kind: JobKind;
  readonly objectId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly createdAt: Date;
  readonly creationBasis: {
    readonly companyRevision: number;
    readonly overrideRevision: number | null;
    readonly basisDigest: string;
    readonly capturedAt: Date;
  };
}

export interface JobConfigSnapshotView {
  readonly id: string;
  readonly kind: JobKind;
  readonly objectId: string;
  readonly purpose: "creation" | "execution";
  readonly companyRevision: number;
  readonly overrideRevision: number | null;
  readonly basisDigest: string;
  readonly capturedAt: Date;
}

export interface JobLeaseGrant {
  readonly status: "granted" | "held";
  readonly kind: JobKind;
  readonly objectId: string;
  readonly claimedByKind: JobExecutor["kind"];
  readonly claimedBy: string;
  readonly attempts: number;
  readonly leaseUntil: Date;
}

export interface JobRef {
  readonly kind: JobKind;
  readonly objectId: string;
}

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + 事实，绝不回显归属或业务对象内容以外的输入值
// ---------------------------------------------------------------------------

export const JOB_OWNERSHIP_INVALID = "JOB_OWNERSHIP_INVALID";
export const JOB_OWNERSHIP_MISMATCH = "JOB_OWNERSHIP_MISMATCH";
export const JOB_OWNERSHIP_REQUIRED = "JOB_OWNERSHIP_REQUIRED";
export const JOB_LEASE_SCOPE_MISMATCH = "JOB_LEASE_SCOPE_MISMATCH";
export const JOB_LEASE_HELD = "JOB_LEASE_HELD";
export const JOB_LEASE_NOT_HELD = "JOB_LEASE_NOT_HELD";

function failInvalid(rule: string): never {
  throw new Error(`${JOB_OWNERSHIP_INVALID}: ${rule}`);
}

/**
 * canonical not-found：与 MT011 唯一事实源同码同形。列表/详情的一切拒绝
 * （不存在/跨团队/跨公司）共用这一个字符串常量——逐字节同消息，无存在泄漏。
 */
const JOB_NOT_FOUND_MESSAGE =
  "RESOURCE_NOT_FOUND: job is not visible in this scope";

function jobNotFound(): never {
  throw new Error(JOB_NOT_FOUND_MESSAGE);
}

// ---------------------------------------------------------------------------
// 输入校验（JOBB_OWNERSHIP_INVALID 面：形状错误响亮拒绝）
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

function requireKind(value: unknown): JobKind {
  if (typeof value !== "string" || !JOB_KINDS.has(value)) {
    failInvalid(`kind must be one of ${[...JOB_KINDS].sort().join(", ")}`);
  }
  return value as JobKind;
}

function requireRevision(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    failInvalid(`${field} must be a positive integer`);
  }
  return value as number;
}

/**
 * 归属范围的输入校验：pin/租约路径的范围三比都以此为第一道门。
 */
function requireScope(scope: unknown): JobScope {
  if (!scope || typeof scope !== "object")
    failInvalid("scope must be an object");
  const candidate = scope as Partial<JobScope>;
  return {
    tenantId: requireId(candidate.tenantId, "scope.tenantId"),
    workspaceId: requireId(candidate.workspaceId, "scope.workspaceId"),
  };
}

function requireExecutor(executor: unknown): JobExecutor {
  if (!executor || typeof executor !== "object") {
    failInvalid("executor must be an object");
  }
  const candidate = executor as Partial<JobExecutor>;
  if (candidate.kind !== "worker" && candidate.kind !== "principal") {
    failInvalid('executor.kind must be "worker" or "principal"');
  }
  return { kind: candidate.kind, id: requireId(candidate.id, "executor.id") };
}

function requireLeaseMs(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1_000 ||
    (value as number) > 86_400_000
  ) {
    failInvalid("leaseMs must be an integer between 1000 and 86400000");
  }
  return value as number;
}

function requireBasis(basis: unknown): {
  companyRevision: number;
  overrideRevision: number | null;
  basisDigest: string;
} {
  if (!basis || typeof basis !== "object")
    failInvalid("basis must be an object");
  const candidate = basis as Partial<JobConfigBasisInput>;
  const companyRevision = requireRevision(
    candidate.companyRevision,
    "basis.companyRevision",
  );
  let overrideRevision: number | null = null;
  if (
    candidate.overrideRevision !== null &&
    candidate.overrideRevision !== undefined
  ) {
    overrideRevision = requireRevision(
      candidate.overrideRevision,
      "basis.overrideRevision",
    );
  } else if (candidate.overrideRevision === undefined) {
    failInvalid("basis.overrideRevision must be null or a positive integer");
  }
  if (candidate.document === undefined)
    failInvalid("basis.document is required");
  return {
    companyRevision,
    overrideRevision,
    basisDigest: digestOf(candidate.document),
  };
}

// ---------------------------------------------------------------------------
// 确定性 canonical JSON + SHA-256（执行依据的内容绑定）
// ---------------------------------------------------------------------------

/**
 * 确定性序列化：对象键排序、数组保序、undefined 归 null。同一文档无论以
 * 什么键序进来，digest 相同；文档变一个字节，digest 不同。
 */
function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === "object") {
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort())
        out[key] = walk(source[key]);
      return out;
    }
    if (
      typeof input === "string" ||
      typeof input === "number" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    // 函数/Symbol 等非 JSON 值在此处已经不可能伪装成合法文档：round-trip
    // 校验（requireBasis）会拒绝任何无法保真序列化的输入。
    return null;
  };
  return JSON.stringify(walk(value));
}

function digestOf(document: unknown): string {
  const canonical = canonicalJson(document);
  // Round-trip guard: a document that does not survive its own canonical
  // serialization (functions, cycles) is not a config basis — refuse loudly
  // rather than digesting a silently lossy projection.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(canonical);
  } catch {
    failInvalid("basis.document must be JSON-serializable");
  }
  if (canonicalJson(reparsed) !== canonical) {
    failInvalid("basis.document must be JSON-serializable");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface JobOwnershipPinResult {
  readonly status: "pinned" | "existing";
  readonly ownership: JobOwnershipView;
}

export interface JobOwnershipService {
  /** 创建时归属持久化：首次写入；同归属幂等；不同选择标识永不改写。 */
  pinJobOwnership(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    principalId: string;
    basis: JobConfigBasisInput;
  }): Promise<JobOwnershipPinResult>;
  /** 追加一次执行依据快照（append-only）。 */
  recordJobExecutionBasis(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    basis: JobConfigBasisInput;
  }): Promise<JobConfigSnapshotView>;
  /** 读取一个可见 job 的全部依据快照（时间序）——追溯面。 */
  listConfigSnapshots(
    viewer: PlatformScope,
    ref: JobRef,
  ): Promise<JobConfigSnapshotView[]>;
  /** 认领租约：同归属执行者授予；跨范围拒绝；活租约被他人持有时拒绝。 */
  claimJobLease(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    executor: JobExecutor;
    leaseMs: number;
  }): Promise<JobLeaseGrant>;
  /** 续约：仅当前持有人（且未完结）。 */
  renewJobLease(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    executor: JobExecutor;
    leaseMs: number;
  }): Promise<{ leaseUntil: Date }>;
  /** 完结：仅当前持有人；清 claim、落 finished_at。 */
  finishJobLease(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    executor: JobExecutor;
  }): Promise<{ finishedAt: Date }>;
  /** 释放：仅当前持有人；清 claim 立即回到可认领。 */
  releaseJobLease(input: {
    kind: JobKind;
    objectId: string;
    scope: JobScope;
    executor: JobExecutor;
    reason?: string;
  }): Promise<void>;
  /** 成员视图：只返回本人发起、所选团队范围内的 job。 */
  listJobs(
    viewer: PlatformScope,
    filter?: { kind?: JobKind },
  ): Promise<JobOwnershipView[]>;
  /** 成员详情：不可见即 canonical not-found。 */
  readJob(viewer: PlatformScope, ref: JobRef): Promise<JobOwnershipView>;
  /** 管理视图：本公司全量（跨团队、跨发起主体）。 */
  listJobsForCompanyAdmin(
    admin: CompanyAdminContext,
    filter?: { kind?: JobKind },
  ): Promise<JobOwnershipView[]>;
  /** 管理详情：本公司内任意 job；公司外 canonical not-found。 */
  readJobForCompanyAdmin(
    admin: CompanyAdminContext,
    ref: JobRef,
  ): Promise<JobOwnershipView>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

const leaseHolderKey = (executor: JobExecutor) => ({
  claimedByKind: executor.kind,
  claimedBy: executor.id,
});

export function createJobOwnershipService(
  operator: OperatorDatabase,
  data: DataDatabase,
): JobOwnershipService {
  assertOperatorDatabase(operator);
  assertDataDatabase(data);

  const pinRow = { kind: jobOwnership.kind, objectId: jobOwnership.objectId };
  const leaseRow = {
    kind: jobLeases.kind,
    objectId: jobLeases.objectId,
    claimedByKind: jobLeases.claimedByKind,
    claimedBy: jobLeases.claimedBy,
  };

  const refWhere = (ref: JobRef) =>
    and(eq(pinRow.kind, ref.kind), eq(pinRow.objectId, ref.objectId));

  return {
    async pinJobOwnership({ kind, objectId, scope, principalId, basis }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const owner = requireId(principalId, "principalId");
      const snapshot = requireBasis(basis);
      return operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        // Create-once：命中已存归属时什么也不写；读回已存行决定幂等还是拒绝。
        const [inserted] = await tx
          .insert(jobOwnership)
          .values({
            kind: jobKind,
            objectId: id,
            tenantId: jobScope.tenantId,
            workspaceId: jobScope.workspaceId,
            principalId: owner,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          const [creationRow] = await tx
            .insert(jobConfigSnapshots)
            .values({
              kind: jobKind,
              objectId: id,
              purpose: "creation",
              companyRevision: snapshot.companyRevision,
              overrideRevision: snapshot.overrideRevision,
              basisDigest: snapshot.basisDigest,
            })
            .returning();
          return {
            status: "pinned" as const,
            ownership: viewOf(inserted, creationRow),
          };
        }
        const [existing] = await tx
          .select()
          .from(jobOwnership)
          .where(refWhere({ kind: jobKind, objectId: id }))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== jobScope.tenantId ||
          existing.workspaceId !== jobScope.workspaceId ||
          existing.principalId !== owner
        ) {
          // 后续请求携带不同选择标识：拒绝，且已存归属一行未动。
          throw new Error(
            `${JOB_OWNERSHIP_MISMATCH}: job is already pinned to a different ownership`,
          );
        }
        const [creation] = await tx
          .select()
          .from(jobConfigSnapshots)
          .where(
            and(
              eq(jobConfigSnapshots.kind, jobKind),
              eq(jobConfigSnapshots.objectId, id),
              eq(jobConfigSnapshots.purpose, "creation"),
            ),
          )
          .limit(1);
        return {
          status: "existing" as const,
          ownership: viewOf(existing, creation),
        };
      });
    },

    async recordJobExecutionBasis({ kind, objectId, scope, basis }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const snapshot = requireBasis(basis);
      return operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        // 依据快照只落在已 pin 的 job 上；pin 不可见即响亮拒绝（服务端调用
        // 方本来就知道归属——这里缺 pin 是编程错误，不是存在性信号）。
        const [pin] = await tx
          .select({ workspaceId: jobOwnership.workspaceId })
          .from(jobOwnership)
          .where(refWhere({ kind: jobKind, objectId: id }))
          .limit(1);
        if (!pin || pin.workspaceId !== jobScope.workspaceId) {
          throw new Error(
            `${JOB_OWNERSHIP_REQUIRED}: job is not pinned in this scope`,
          );
        }
        const [row] = await tx
          .insert(jobConfigSnapshots)
          .values({
            kind: jobKind,
            objectId: id,
            purpose: "execution",
            companyRevision: snapshot.companyRevision,
            overrideRevision: snapshot.overrideRevision,
            basisDigest: snapshot.basisDigest,
          })
          .returning();
        return snapshotViewOf(row);
      });
    },

    async listConfigSnapshots(viewer, ref) {
      assertTrustedScope(viewer);
      const jobKind = requireKind(ref.kind);
      const id = requireId(ref.objectId, "objectId");
      return data.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${viewer.tenantId}, true), set_config('app.principal_id', ${viewer.principalId}, true), set_config('app.user_id', ${viewer.actorId}, true)`,
        );
        await revalidateMembership(tx, viewer);
        await assertMemberVisible(tx, viewer, { kind: jobKind, objectId: id });
        const rows = await tx
          .select()
          .from(jobConfigSnapshots)
          .where(
            and(
              eq(jobConfigSnapshots.kind, jobKind),
              eq(jobConfigSnapshots.objectId, id),
            ),
          )
          .orderBy(
            asc(jobConfigSnapshots.capturedAt),
            asc(jobConfigSnapshots.id),
          );
        return rows.map(snapshotViewOf);
      });
    },

    async claimJobLease({ kind, objectId, scope, executor, leaseMs }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const holder = requireExecutor(executor);
      const ms = requireLeaseMs(leaseMs);
      return operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        // 归属三比第一道：pin 必须在认领范围可见。跨公司的 pin 对本事务
        // 结构性不可见（RLS），与「未 pin」不可区分——统一拒绝，零泄漏。
        const [pin] = await tx
          .select({
            tenantId: jobOwnership.tenantId,
            workspaceId: jobOwnership.workspaceId,
          })
          .from(jobOwnership)
          .where(refWhere({ kind: jobKind, objectId: id }))
          .limit(1);
        if (!pin) {
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: no ownership pin visible in the claimed scope`,
          );
        }
        // 归属三比第二道：workspace 逐字相等（同公司跨团队在这里被拒）。
        if (
          pin.tenantId !== jobScope.tenantId ||
          pin.workspaceId !== jobScope.workspaceId
        ) {
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: claimed scope does not match the pinned ownership`,
          );
        }
        // 首次租约：原子插入。命中已存行时走下面的状态机。
        const [inserted] = await tx
          .insert(jobLeases)
          .values({
            kind: jobKind,
            objectId: id,
            tenantId: jobScope.tenantId,
            workspaceId: jobScope.workspaceId,
            ...leaseHolderKey(holder),
            leaseUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
            attempts: 1,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) return grantView(inserted);
        const [current] = await tx
          .select()
          .from(jobLeases)
          .where(and(eq(leaseRow.kind, jobKind), eq(leaseRow.objectId, id)))
          .limit(1);
        if (!current) {
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: lease row vanished mid-claim`,
          );
        }
        const liveForOther =
          current.claimedBy !== null &&
          current.claimedBy !== holder.id &&
          current.leaseUntil !== null &&
          current.leaseUntil.getTime() > Date.now();
        if (liveForOther) {
          throw new Error(
            `${JOB_LEASE_HELD}: a live lease is held by another executor`,
          );
        }
        const iAmLive =
          current.claimedBy === holder.id &&
          current.claimedByKind === holder.kind &&
          current.leaseUntil !== null &&
          current.leaseUntil.getTime() > Date.now();
        if (iAmLive) {
          // iAmLive 已证明持有人与租期非空；行形状 CHECK 也强制成对。
          return {
            status: "held" as const,
            kind: jobKind,
            objectId: id,
            claimedByKind: holder.kind,
            claimedBy: holder.id,
            attempts: current.attempts,
            leaseUntil: current.leaseUntil as Date,
          };
        }
        // 过期（无论前持有人是谁）或已释放：同归属的下一个执行者接管。
        const [reclaimed] = await tx
          .update(jobLeases)
          .set({
            ...leaseHolderKey(holder),
            leaseUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
            attempts: sql`${jobLeases.attempts} + 1`,
            finishedAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(leaseRow.kind, jobKind),
              eq(leaseRow.objectId, id),
              sql`(${jobLeases.claimedBy} is null or ${jobLeases.leaseUntil} is null or ${jobLeases.leaseUntil} <= now())`,
            ),
          )
          .returning();
        if (!reclaimed) {
          // 并发窗口内被他人抢先：宁可误报冲突也不双重授予。
          throw new Error(
            `${JOB_LEASE_HELD}: lease was just taken by another executor`,
          );
        }
        return grantView(reclaimed);
      });
    },

    async renewJobLease({ kind, objectId, scope, executor, leaseMs }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const holder = requireExecutor(executor);
      const ms = requireLeaseMs(leaseMs);
      return operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        const [current] = await tx
          .select()
          .from(jobLeases)
          .where(and(eq(leaseRow.kind, jobKind), eq(leaseRow.objectId, id)))
          .limit(1);
        if (!current) {
          // 跨公司续约：行不可见（RLS）——与同范围语义统一为范围拒绝。
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: no lease visible in the claimed scope`,
          );
        }
        const mine = await tx
          .update(jobLeases)
          .set({
            leaseUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(leaseRow.kind, jobKind),
              eq(leaseRow.objectId, id),
              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql`${jobLeases.finishedAt} is null`,
            ),
          )
          .returning({ leaseUntil: jobLeases.leaseUntil });
        if (mine.length === 0) {
          throw new Error(
            `${JOB_LEASE_NOT_HELD}: lease is not held by this executor`,
          );
        }
        // 行形状 CHECK：被持有的行 lease_until 必非空。
        return { leaseUntil: mine[0].leaseUntil as Date };
      });
    },

    async finishJobLease({ kind, objectId, scope, executor }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const holder = requireExecutor(executor);
      const finishedAt = await operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        const [current] = await tx
          .select({ claimedBy: leaseRow.claimedBy })
          .from(jobLeases)
          .where(and(eq(leaseRow.kind, jobKind), eq(leaseRow.objectId, id)))
          .limit(1);
        if (!current) {
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: no lease visible in the claimed scope`,
          );
        }
        const [done] = await tx
          .update(jobLeases)
          .set({
            claimedByKind: null,
            claimedBy: null,
            leaseUntil: null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(leaseRow.kind, jobKind),
              eq(leaseRow.objectId, id),
              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql`${jobLeases.finishedAt} is null`,
            ),
          )
          .returning({ finishedAt: jobLeases.finishedAt });
        if (!done) {
          throw new Error(
            `${JOB_LEASE_NOT_HELD}: lease is not held by this executor`,
          );
        }
        return done.finishedAt as Date;
      });
      return { finishedAt };
    },

    async releaseJobLease({ kind, objectId, scope, executor, reason }) {
      const jobKind = requireKind(kind);
      const id = requireId(objectId, "objectId");
      const jobScope = requireScope(scope);
      const holder = requireExecutor(executor);
      await operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${jobScope.tenantId}, true)`,
        );
        const [current] = await tx
          .select({ claimedBy: leaseRow.claimedBy })
          .from(jobLeases)
          .where(and(eq(leaseRow.kind, jobKind), eq(leaseRow.objectId, id)))
          .limit(1);
        if (!current) {
          throw new Error(
            `${JOB_LEASE_SCOPE_MISMATCH}: no lease visible in the claimed scope`,
          );
        }
        const [released] = await tx
          .update(jobLeases)
          .set({
            claimedByKind: null,
            claimedBy: null,
            leaseUntil: null,
            lastError: reason ?? null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(leaseRow.kind, jobKind),
              eq(leaseRow.objectId, id),
              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql`${jobLeases.finishedAt} is null`,
            ),
          )
          .returning({ objectId: leaseRow.objectId });
        if (!released) {
          throw new Error(
            `${JOB_LEASE_NOT_HELD}: lease is not held by this executor`,
          );
        }
      });
    },

    async listJobs(viewer, filter) {
      assertTrustedScope(viewer);
      return data.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${viewer.tenantId}, true), set_config('app.principal_id', ${viewer.principalId}, true), set_config('app.user_id', ${viewer.actorId}, true)`,
        );
        await revalidateMembership(tx, viewer);
        return listVisible(
          tx,
          viewer.tenantId,
          viewer.workspaceId,
          viewer.principalId,
          filter,
        );
      });
    },

    async readJob(viewer, ref) {
      assertTrustedScope(viewer);
      const jobKind = requireKind(ref.kind);
      const id = requireId(ref.objectId, "objectId");
      return data.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${viewer.tenantId}, true), set_config('app.principal_id', ${viewer.principalId}, true), set_config('app.user_id', ${viewer.actorId}, true)`,
        );
        await revalidateMembership(tx, viewer);
        const rows = await memberRows(
          tx,
          viewer.tenantId,
          viewer.workspaceId,
          viewer.principalId,
          {
            kind: jobKind,
            objectId: id,
          },
        );
        if (rows.length === 0) jobNotFound();
        return rows[0];
      });
    },

    async listJobsForCompanyAdmin(admin, filter) {
      assertTrustedAdminContext(admin);
      return data.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${admin.tenantId}, true)`,
        );
        return listVisible(tx, admin.tenantId, null, null, filter);
      });
    },

    async readJobForCompanyAdmin(admin, ref) {
      assertTrustedAdminContext(admin);
      const jobKind = requireKind(ref.kind);
      const id = requireId(ref.objectId, "objectId");
      return data.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${admin.tenantId}, true)`,
        );
        const rows = await memberRows(tx, admin.tenantId, null, null, {
          kind: jobKind,
          objectId: id,
        });
        if (rows.length === 0) jobNotFound();
        return rows[0];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 事务内共享件：成员重验、可见性、视图拼装
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

/**
 * 事务内成员重验（与 resource reader 同一契约）：成员停用/主体停用/租户停
 * 用/epoch 漂移任一发生即 SCOPE_REVOKED——已签发的 Scope 在业务事务里再验
 * 一次，撤销即时生效（Spec §5.2）。
 */
async function revalidateMembership(
  tx: Tx,
  viewer: PlatformScope,
): Promise<void> {
  const [membership] = await tx
    .select({
      epoch: enterpriseMemberships.epoch,
      memberStatus: enterpriseMemberships.status,
    })
    .from(enterpriseMemberships)
    .where(
      and(
        eq(enterpriseMemberships.tenantId, viewer.tenantId),
        eq(enterpriseMemberships.principalId, viewer.principalId),
      ),
    )
    .limit(1);
  if (membership?.memberStatus !== "active") {
    throw new Error("SCOPE_REVOKED");
  }
  if (membership.epoch !== viewer.memberEpoch) {
    throw new Error("SCOPE_REVOKED");
  }
}

/** 成员视图过滤：本人发起 + 所选团队范围。 */
async function memberRows(
  tx: Tx,
  tenantId: string,
  workspaceId: string | null,
  principalId: string | null,
  filter: { kind?: JobKind; objectId?: string },
): Promise<JobOwnershipView[]> {
  const conditions = [eq(jobOwnership.tenantId, tenantId)];
  if (workspaceId !== null) {
    conditions.push(eq(jobOwnership.workspaceId, workspaceId));
  }
  if (principalId !== null) {
    conditions.push(eq(jobOwnership.principalId, principalId));
  }
  if (filter.kind) conditions.push(eq(jobOwnership.kind, filter.kind));
  if (filter.objectId)
    conditions.push(eq(jobOwnership.objectId, filter.objectId));
  const rows = await tx
    .select()
    .from(jobOwnership)
    .where(and(...conditions))
    .orderBy(
      asc(jobOwnership.createdAt),
      asc(jobOwnership.kind),
      asc(jobOwnership.objectId),
    );
  return Promise.all(rows.map((row) => withCreationBasis(tx, row)));
}

async function listVisible(
  tx: Tx,
  tenantId: string,
  workspaceId: string | null,
  principalId: string | null,
  filter?: { kind?: JobKind },
): Promise<JobOwnershipView[]> {
  return memberRows(tx, tenantId, workspaceId, principalId, filter ?? {});
}

/** 成员可见性检查（追溯面复用详情语义：不可见即 canonical not-found）。 */
async function assertMemberVisible(
  tx: Tx,
  viewer: PlatformScope,
  ref: JobRef,
): Promise<void> {
  const rows = await tx
    .select({ objectId: jobOwnership.objectId })
    .from(jobOwnership)
    .where(
      and(
        eq(jobOwnership.tenantId, viewer.tenantId),
        eq(jobOwnership.workspaceId, viewer.workspaceId),
        eq(jobOwnership.principalId, viewer.principalId),
        eq(jobOwnership.kind, ref.kind),
        eq(jobOwnership.objectId, ref.objectId),
      ),
    )
    .limit(1);
  if (rows.length === 0) jobNotFound();
}

async function withCreationBasis(
  tx: Tx,
  row: typeof jobOwnership.$inferSelect,
): Promise<JobOwnershipView> {
  const [creation] = await tx
    .select()
    .from(jobConfigSnapshots)
    .where(
      and(
        eq(jobConfigSnapshots.kind, row.kind),
        eq(jobConfigSnapshots.objectId, row.objectId),
        eq(jobConfigSnapshots.purpose, "creation"),
      ),
    )
    .limit(1);
  return viewOf(row, creation);
}

function viewOf(
  row: typeof jobOwnership.$inferSelect,
  creation: typeof jobConfigSnapshots.$inferSelect | undefined | null,
): JobOwnershipView {
  if (!creation) {
    // 归属行与 creation 快照同事务写入：缺快照只可能是外部手工删数据，
    // 响亮失败而不是伪装成合法视图。
    throw new Error(
      `${JOB_OWNERSHIP_REQUIRED}: creation basis snapshot missing`,
    );
  }
  return {
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
      // 快照行的 captured_at 由 DB now() 缺省填充，必非空。
      capturedAt: creation.capturedAt as Date,
    },
  };
}

function snapshotViewOf(
  row: typeof jobConfigSnapshots.$inferSelect,
): JobConfigSnapshotView {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    objectId: row.objectId,
    purpose: row.purpose as "creation" | "execution",
    companyRevision: row.companyRevision,
    overrideRevision: row.overrideRevision,
    basisDigest: row.basisDigest,
    capturedAt: row.capturedAt,
  };
}

function grantView(row: typeof jobLeases.$inferSelect): JobLeaseGrant {
  return {
    status: "granted",
    kind: row.kind as JobKind,
    objectId: row.objectId,
    claimedByKind: row.claimedByKind as JobExecutor["kind"],
    claimedBy: row.claimedBy ?? "",
    attempts: row.attempts,
    // 已授予行的租期必非空（行形状 CHECK）。
    leaseUntil: row.leaseUntil as Date,
  };
}
