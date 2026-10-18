// server/src/enterprise/runs/scan-executor.ts
// MT042（Issue #85）：平台扫描的到期任务发现与按记录重建作用域执行。
//
// 票面：扫描器列出跨公司到期任务但不读业务内容（列表=元数据，载荷内容不可
// 见）；每项执行前从服务器持久化记录重建 Scope，队列消息里公司/团队字段不
// 被信任（重建=权威行，消息字段仅作路由提示）；机器身份不获得 dev-local-user
// 或普通用户权限（机器 Scope 与用户 Scope 类型隔离）；反序列化 Scope 被拒，
// 只有签发入口产生的 Scope 有效（MT005 scope-gate 先例：结构≠信任）。
//
// Spec §6「机器认证与业务身份分开……Worker 根据服务器持久化记录验证执行资
// 格，不能信任队列消息中任意 tenant_id，也不能把序列化 Scope 当可信 Scope。
// 平台扫描可发现所有公司的到期任务，但每个任务的执行、产物和费用回到自己的
// 作用域」；§5.3「公司范围机器读权限仅供明确平台任务，不可提供给普通业务接
// 口」；§11 A8。
//
// 数据流（一条链，四段）：
//   ① 到期发现：平台连接上元数据认领 work_items（FOR UPDATE SKIP LOCKED、
//      DB 时钟；RETURNING 只取 key/run_at/attempts——payload 列结构性地不
//      进入扫描面）。
//   ② 重建：operator 通道 + 事务本地 app.scan_sweep 上下文（MT042 迁移新增
//      的 job_ownership 扫描策略臂）读权威归属行；principal→user 经 operator
//      逐主体臂；再经真实签发入口 createScopeResolver（entrypoint="schedule"）
//      产出受信 Scope——重建不制造 Scope，只制造签发入口的输入。
//   ③ 租约：MT041 claimJobLease/finishJobLease/releaseJobLease（同一 lease
//      纪律；执行者 = {kind:"worker", id:<machine.id>}；他人活租约 → 跳过）。
//   ④ 执行：MT005 scope-gate 事务（两级成员重验 + 租户上下文 + 真实 RLS）内
//      运行回调；成功 → finishJobLease + 队列 finish；失败 → releaseJobLease
//      + 队列 release（新的一次 attempt）；撤权 → 机器码拒绝。
//
// 跨公司 deny：机器路径全部确定性哨兵码，拒绝理由不回显消息 payload/提示值；
// 用户可见面维持 MT041 canonical RESOURCE_NOT_FOUND（只读消费，零改动）。
//
// 冻结面：job-ownership.ts、scope-gate.ts、store.ts、connections.ts、
// work/queue.ts 只消费不改（work/queue 的 claim 会返回 payload，扫描面改用
// 本模块的元数据认领；offer/finish/release 语义与其逐字对齐）。

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { workItems } from "../../db/schema";
import { enterprisePrincipals } from "../../db/schema/enterprise-tenancy";
import { jobOwnership } from "../../db/schema/job-ownership";
import type { PlatformScope } from "../contracts";
import type { DataDatabase, OperatorDatabase } from "../tenancy/connections";
import { assertOperatorDatabase } from "../tenancy/connections";
import {
  JOB_LEASE_HELD,
  type JobExecutor,
  type JobKind,
  type JobOwnershipService,
} from "../tenancy/job-ownership";
import type { WorkspaceGate } from "../tenancy/scope-gate";

// ---------------------------------------------------------------------------
// 机器扫描身份：与用户 Scope 类型隔离的信任对象（AC3/AC4）
// ---------------------------------------------------------------------------

/**
 * 平台扫描的执行身份。与 `PlatformScope`（用户会话签发）是两个不相交通道：
 * 机器身份进不了 Scope 注册表（`assertTrustedScope` 拒绝），用户 Scope 也
 * 驱动不了扫描（本文件只认签发过的机器身份）。信任标记是签发时的 WeakSet
 * 对象身份——手造同形对象、JSON 往返、structuredClone 一律无效。
 */
export interface MachineScanIdentity {
  readonly kind: "machine-scan";
  readonly id: string;
}

const issuedMachineIdentities = new WeakSet<object>();

export const MACHINE_IDENTITY_INVALID = "MACHINE_IDENTITY_INVALID";

const ID_MAX = 200;

/**
 * 签发入口：机器身份只能由此产生。`dev-local-user` 与一切用户形 id 在这里
 * 被响亮拒绝——机器身份永远不是某个用户登录（AC3）。
 */
export function createMachineScanIdentity(input: {
  id: unknown;
}): MachineScanIdentity {
  const id = input?.id;
  if (typeof id !== "string" || !id.trim() || id.length > ID_MAX) {
    throw new Error(
      `${MACHINE_IDENTITY_INVALID}: id must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  if (id === "dev-local-user") {
    throw new Error(
      `${MACHINE_IDENTITY_INVALID}: the local dev user is not a machine identity`,
    );
  }
  const identity: MachineScanIdentity = Object.freeze({
    kind: "machine-scan",
    id,
  });
  issuedMachineIdentities.add(identity);
  return identity;
}

/** 信任门：只有本进程签发入口产生的机器身份能通过（结构≠信任）。 */
export function assertTrustedMachineIdentity(
  value: unknown,
): asserts value is MachineScanIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    (value as MachineScanIdentity).kind !== "machine-scan" ||
    !issuedMachineIdentities.has(value)
  ) {
    throw new Error(
      `${MACHINE_IDENTITY_INVALID}: only an issued machine scan identity may drive a platform scan`,
    );
  }
}

// ---------------------------------------------------------------------------
// 拒绝：机器语义确定性哨兵码（不回显消息值，不泄露存在性差异）
// ---------------------------------------------------------------------------

export const SCAN_RECORD_MISSING = "SCAN_RECORD_MISSING";
export const SCAN_ITEM_MALFORMED = "SCAN_ITEM_MALFORMED";
export const SCAN_SCOPE_UNRESOLVED = "SCAN_SCOPE_UNRESOLVED";
export const SCAN_SCOPE_REVOKED = "SCAN_SCOPE_REVOKED";
export const SCAN_LEASE_MISMATCH = "SCAN_LEASE_MISMATCH";
export const SCAN_EXECUTION_FAILED = "SCAN_EXECUTION_FAILED";

// ---------------------------------------------------------------------------
// 扫描面类型
// ---------------------------------------------------------------------------

/** 平台扫描的队列 kind：work_items 里本票消费的消息类别。 */
export const SCAN_WORK_KIND = "enterprise.job.due";

const JOB_KINDS: ReadonlySet<string> = new Set(["task", "run", "trigger"]);

/** 一条到期任务的元数据。没有 payload 字段——载荷内容结构性地不可见（AC1）。 */
export interface ScannedItem {
  readonly jobKind: JobKind;
  readonly objectId: string;
  readonly attempts: number;
  readonly runAt: Date;
}

export type ScanOutcome =
  | { readonly status: "executed"; readonly item: ScannedItem }
  | {
      readonly status: "released";
      readonly item: ScannedItem;
      readonly reason: string;
    }
  | {
      readonly status: "refused";
      /** 键无法解析时没有可报告的 item——原始键值绝不回显。 */
      readonly item?: ScannedItem;
      readonly code: string;
    }
  | { readonly status: "lease-held"; readonly item: ScannedItem };

export interface ScanOptions {
  /** 单轮最多认领多少条到期任务（1..500，默认 10）。 */
  readonly limit?: number;
  /** MT041 任务租约时长（1000..3600000，默认 60000）。 */
  readonly leaseMs?: number;
  /** 队列认领租约时长（1000..3600000，默认 60000）。 */
  readonly workLeaseMs?: number;
  /** 队列 attempt 上限（超过即不再认领，默认 5，与 work/queue 同默认）。 */
  readonly maxAttempts?: number;
  /** 失败/跳过后队列重排的延迟（0..3600000，默认 30000）。 */
  readonly retryDelayMs?: number;
}

/** 执行回调的上下文：重建出的受信 Scope + 元数据 + gate 事务句柄。 */
export interface ScanExecuteContext {
  /** 经真实签发入口产出、且正在 MT005 gate 事务中重验过的受信 Scope。 */
  readonly scope: PlatformScope;
  readonly item: ScannedItem;
  /** gate 事务句柄（data 角色 + 租户上下文 + 真实 RLS）。 */
  readonly tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
}

export interface ScanExecutor {
  /**
   * 一轮扫描：到期发现 → 逐项重建 → 认领 → 门内执行 → 完结/释放。返回每项
   * 的确定性结局；业务拒绝是结局而不是异常（异常只属于基础设施故障）。
   */
  scanAndExecute(
    machine: MachineScanIdentity,
    options?: ScanOptions,
  ): Promise<ScanOutcome[]>;
}

export interface ScanExecutorDependencies {
  /** 平台连接（work_items 所在库；非租户域，无 RLS）。 */
  readonly platform: Database;
  /** operator 受限通道（重建读：扫描臂 + 逐主体臂）。 */
  readonly operator: OperatorDatabase;
  /** MT041 归属/租约服务（claim/finish/release 消费）。 */
  readonly jobOwnership: JobOwnershipService;
  /** MT005 scope-gate（执行回调在其事务内）。 */
  readonly gate: WorkspaceGate;
  /**
   * 签发入口适配：以权威行事实（actor/tenant/workspace）经真实
   * createScopeResolver 产出受信 Scope。本模块从不构造 Scope 对象。
   */
  issueScheduleScope(facts: {
    actorId: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<PlatformScope>;
  /** 业务执行回调：在 gate 事务内运行；抛错 = 本次执行失败（释放重试）。 */
  execute(context: ScanExecuteContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// 输入卫生
// ---------------------------------------------------------------------------

function requireInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

interface NormalizedOptions {
  limit: number;
  leaseMs: number;
  workLeaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

function normalizeOptions(options: ScanOptions | undefined): NormalizedOptions {
  const o = options ?? {};
  return {
    limit: requireInt(o.limit, 1, 500, 10, "limit"),
    leaseMs: requireInt(o.leaseMs, 1_000, 3_600_000, 60_000, "leaseMs"),
    workLeaseMs: requireInt(
      o.workLeaseMs,
      1_000,
      3_600_000,
      60_000,
      "workLeaseMs",
    ),
    maxAttempts: requireInt(o.maxAttempts, 1, 100, 5, "maxAttempts"),
    retryDelayMs: requireInt(
      o.retryDelayMs,
      0,
      3_600_000,
      30_000,
      "retryDelayMs",
    ),
  };
}

/**
 * 队列 key 的封闭语法 `<jobKind>:<objectId>`。jobKind 是封闭词表；objectId
 * 逐字保真（可含任意非空内容）。解析失败 = 消息格式缺陷，机器响亮拒绝。
 */
function parseWorkKey(
  key: unknown,
): { jobKind: JobKind; objectId: string } | null {
  if (typeof key !== "string") return null;
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const jobKind = key.slice(0, separator);
  const objectId = key.slice(separator + 1);
  if (!JOB_KINDS.has(jobKind)) return null;
  if (!objectId.trim() || objectId.length > ID_MAX) return null;
  return { jobKind: jobKind as JobKind, objectId };
}

interface RebuiltFacts {
  readonly actorId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

const sentinelOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export function createScanExecutor(
  deps: ScanExecutorDependencies,
): ScanExecutor {
  if (!deps || typeof deps !== "object") {
    throw new TypeError("SCAN_EXECUTOR_DEPENDENCIES_REQUIRED");
  }
  if (
    !deps.platform ||
    typeof deps.platform.transaction !== "function" ||
    typeof deps.execute !== "function" ||
    typeof deps.issueScheduleScope !== "function" ||
    typeof deps.gate?.transaction !== "function" ||
    typeof deps.jobOwnership?.claimJobLease !== "function"
  ) {
    throw new TypeError("SCAN_EXECUTOR_DEPENDENCIES_INVALID");
  }
  assertOperatorDatabase(deps.operator);

  const { platform, operator, gate, issueScheduleScope, execute } = deps;
  const jobs = deps.jobOwnership;

  /** 队列侧完结（仍是本机器的认领才有效；与 work/queue.finish 同形状）。 */
  const finishWorkItem = async (
    owner: string,
    key: string,
  ): Promise<boolean> => {
    const [finished] = await platform
      .update(workItems)
      .set({
        finishedAt: sql`now()`,
        claimedBy: null,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workItems.kind, SCAN_WORK_KIND),
          eq(workItems.key, key),
          eq(workItems.claimedBy, owner),
          isNull(workItems.finishedAt),
        ),
      )
      .returning({ key: workItems.key });
    return Boolean(finished);
  };

  /** 队列侧释放（延迟重排 + 机器码落 last_error；与 work/queue.release 同形状）。 */
  const releaseWorkItem = async (
    owner: string,
    key: string,
    delayMs: number,
    reason: string,
  ): Promise<void> => {
    await platform
      .update(workItems)
      .set({
        claimedBy: null,
        leaseUntil: null,
        runAt: sql`now() + make_interval(secs => ${delayMs / 1000})`,
        lastError: reason,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workItems.kind, SCAN_WORK_KIND),
          eq(workItems.key, key),
          eq(workItems.claimedBy, owner),
          isNull(workItems.finishedAt),
        ),
      );
  };

  /**
   * ① 到期发现（元数据认领）：与 work/queue 的 claim 同一 WHERE/时钟纪律，
   * 但 RETURNING 只含 key/run_at/attempts——payload 列不存在于本路径（AC1
   * 的实现面，MUT1 钉死）。键无法解析的认领行当场终结（重试永远不可能变
   * 好），由调用方产出无 item 的拒绝结局（原始键值零回显）。
   */
  const claimDueMetadata = async (
    owner: string,
    options: NormalizedOptions,
  ): Promise<
    {
      parsed: { jobKind: JobKind; objectId: string } | null;
      attempts: number;
      runAt: Date;
    }[]
  > => {
    return platform.transaction(async (tx) => {
      const due = await tx.execute(sql`
        update "work_items"
        set "claimed_by" = ${owner},
            "lease_until" = now() + make_interval(secs => ${options.workLeaseMs / 1000}),
            "attempts" = "work_items"."attempts" + 1,
            "updated_at" = now()
        where ("kind", "key") in (
          select "kind", "key"
          from "work_items"
          where "kind" = ${SCAN_WORK_KIND}
            and "finished_at" is null
            and "attempts" < ${options.maxAttempts}
            and "run_at" <= now()
            and ("lease_until" is null or "lease_until" <= now())
          order by "run_at" asc, "key" asc
          limit ${options.limit}
          for update skip locked
        )
        returning "key", "run_at", "attempts"
      `);
      const rows = (
        Array.isArray(due) ? due : ((due as { rows?: unknown[] })?.rows ?? [])
      ) as { key: string; run_at: Date; attempts: number }[];
      const claimed: {
        parsed: { jobKind: JobKind; objectId: string } | null;
        attempts: number;
        runAt: Date;
      }[] = [];
      for (const row of rows) {
        const parsed = parseWorkKey(row.key);
        if (parsed) {
          claimed.push({ parsed, attempts: row.attempts, runAt: row.run_at });
        } else {
          // 消息格式缺陷：确定性拒绝并终结（重试永远不可能变好）；原始键
          // 值不进入任何结局对象（零回显）。终结必须落在同一个事务里——
          // 跨连接的池复用会自我饿死。
          await tx
            .update(workItems)
            .set({
              finishedAt: sql`now()`,
              claimedBy: null,
              leaseUntil: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(workItems.kind, SCAN_WORK_KIND),
                eq(workItems.key, row.key),
                eq(workItems.claimedBy, owner),
                isNull(workItems.finishedAt),
              ),
            );
          claimed.push({
            parsed: null,
            attempts: row.attempts,
            runAt: row.run_at,
          });
        }
      }
      return claimed;
    });
  };

  /**
   * ② 重建（AC2 的实现面）：权威归属行经扫描臂读取（app.scan_sweep 上下文
   * 门控，MT042 迁移），principal→user 经 operator 逐主体臂。队列消息的
   * payload 从未参与——本函数的输入只有 (jobKind, objectId) 元数据。
   */
  const rebuildFacts = async (
    item: ScannedItem,
  ): Promise<{ ok: true; facts: RebuiltFacts } | { ok: false; code: string }> =>
    operator.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      // 平台扫描上下文：事务本地、提交即清。普通业务事务永不设置该键——
      // 没有它，本查询与 MT041 的租户臂行为逐字相同（跨公司零行）。
      await tx.execute(sql`select set_config('app.scan_sweep', 'on', true)`);
      const [pin] = await tx
        .select({
          tenantId: jobOwnership.tenantId,
          workspaceId: jobOwnership.workspaceId,
          principalId: jobOwnership.principalId,
        })
        .from(jobOwnership)
        .where(
          and(
            eq(jobOwnership.kind, item.jobKind),
            eq(jobOwnership.objectId, item.objectId),
          ),
        )
        .limit(1);
      if (!pin) {
        return { ok: false as const, code: SCAN_RECORD_MISSING };
      }
      await tx.execute(
        sql`select set_config('app.tenant_id', ${pin.tenantId}, true), set_config('app.operator_principal_id', ${pin.principalId}, true)`,
      );
      const [principal] = await tx
        .select({
          userId: enterprisePrincipals.userId,
          status: enterprisePrincipals.status,
        })
        .from(enterprisePrincipals)
        .where(eq(enterprisePrincipals.id, pin.principalId))
        .limit(1);
      if (principal?.status !== "active") {
        return { ok: false as const, code: SCAN_SCOPE_UNRESOLVED };
      }
      return {
        ok: true as const,
        facts: {
          actorId: principal.userId,
          tenantId: pin.tenantId,
          workspaceId: pin.workspaceId,
          principalId: pin.principalId,
        },
      };
    });

  /** ② → ⑤：单条已认领任务的重建、认领、门内执行与完结/释放。 */
  const executeClaimedItem = async (
    item: ScannedItem,
    executor: JobExecutor,
    owner: string,
    opts: NormalizedOptions,
    facts: RebuiltFacts,
  ): Promise<ScanOutcome> => {
    const workKind = item.jobKind;
    const workKey = `${workKind}:${item.objectId}`;
    const leaseScope = {
      tenantId: facts.tenantId,
      workspaceId: facts.workspaceId,
    };

    let scope: PlatformScope;
    try {
      scope = await issueScheduleScope(facts);
    } catch {
      // 签发入口的两级成员判定未通过（TENANT_FORBIDDEN / WORKSPACE_FORBIDDEN
      // / 目录事实缺失）：机器码拒绝；签发入口的内部细节不上浮。
      await releaseWorkItem(
        owner,
        workKey,
        opts.retryDelayMs,
        SCAN_SCOPE_UNRESOLVED,
      );
      return { status: "refused", code: SCAN_SCOPE_UNRESOLVED, item };
    }

    // ③ 租约：MT041 同一纪律。
    try {
      await jobs.claimJobLease({
        kind: item.jobKind,
        objectId: item.objectId,
        scope: leaseScope,
        executor,
        leaseMs: opts.leaseMs,
      });
    } catch (error) {
      const message = sentinelOf(error);
      if (message.startsWith(`${JOB_LEASE_HELD}`)) {
        // 他人活租约：不是失败也不是拒绝——跳过，稍后再看。
        await releaseWorkItem(
          owner,
          workKey,
          opts.retryDelayMs,
          JOB_LEASE_HELD,
        );
        return { status: "lease-held", item };
      }
      await releaseWorkItem(
        owner,
        workKey,
        opts.retryDelayMs,
        SCAN_LEASE_MISMATCH,
      );
      return { status: "refused", code: SCAN_LEASE_MISMATCH, item };
    }

    // ④ 执行：MT005 gate 事务内（两级成员重验 + 租户上下文 + 真实 RLS）。
    try {
      await gate.transaction(scope, (tx) => execute({ tx, scope, item }));
    } catch (error) {
      const message = sentinelOf(error);
      const revoked =
        message === "SCOPE_REVOKED" || message === "WORKSPACE_REVOKED";
      const code = revoked ? SCAN_SCOPE_REVOKED : SCAN_EXECUTION_FAILED;
      try {
        await jobs.releaseJobLease({
          kind: item.jobKind,
          objectId: item.objectId,
          scope: leaseScope,
          executor,
          reason: code,
        });
      } catch {
        // 释放失败：租约按 MT041 时钟自然过期，队列重试按 attempt 上限收敛。
      }
      await releaseWorkItem(owner, workKey, opts.retryDelayMs, code);
      return revoked
        ? { status: "refused", code, item }
        : { status: "released", reason: code, item };
    }

    // ⑤ 完结：先落租约（执行完成的权威事实），再落队列。
    await jobs.finishJobLease({
      kind: item.jobKind,
      objectId: item.objectId,
      scope: leaseScope,
      executor,
    });
    await finishWorkItem(owner, workKey);
    return { status: "executed", item };
  };

  return {
    async scanAndExecute(machine, options) {
      assertTrustedMachineIdentity(machine);
      const opts = normalizeOptions(options);
      const owner = machine.id;
      const executor: JobExecutor = { kind: "worker", id: machine.id };
      const claimed = await claimDueMetadata(owner, opts);

      const outcomes: ScanOutcome[] = [];
      for (const entry of claimed) {
        if (!entry.parsed) {
          outcomes.push({ status: "refused", code: SCAN_ITEM_MALFORMED });
          continue;
        }
        const item: ScannedItem = {
          ...entry.parsed,
          attempts: entry.attempts,
          runAt: entry.runAt,
        };
        // ② 重建：作用域事实只来自权威行；记录缺失是确定性拒绝。
        const rebuilt = await rebuildFacts(item);
        if (!rebuilt.ok) {
          await releaseWorkItem(
            owner,
            `${item.jobKind}:${item.objectId}`,
            opts.retryDelayMs,
            rebuilt.code,
          );
          outcomes.push({ status: "refused", code: rebuilt.code, item });
          continue;
        }
        outcomes.push(
          await executeClaimedItem(item, executor, owner, opts, rebuilt.facts),
        );
      }
      return outcomes;
    },
  };
}
