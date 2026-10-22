// server/src/enterprise/tenancy/execution-artifacts.ts
// MT047（Issue #90）：执行侧快照、shell、文件、cancel/reset/cull 的归属。
//
// 票面语义：执行侧的快照、shell 命令、文件读写、取消、重置与清理操作都按归属
// 授权，工作目录与快照不跨公司/团队可见或可复用；cancel/reset/cull 只对有权
// 主体生效且操作留审计；清理任务不会删除其他范围的快照或工作目录。
//
// 结构（纯新增，只读消费既有事实源，不改任何既有文件语义）：
//
//   1. 归属判定（authorizeExecution）：受信 Scope（assertTrustedScope）→ data
//      通道事务（read committed + lock/statement timeout + set_config
//      'app.*' 事务本地 → advisory 共享锁，键序 tenant → principal →
//      membership → workspace-membership → bot，与 MT016 完全一致）→ 事务内
//      两级成员重验（公司 active 且 epoch === scope.memberEpoch；团队行存在
//      且 active）→ 读 enterprise_bot_ownership 权威行（真实 RLS：跨公司行
//      对本事务不可见）→ 行的 workspace 与受信 scope 同团队且 status='active'。
//      任一不成立 → MT011 canonical { outcome: "deny", code:
//      RESOURCE_NOT_FOUND }（不存在/跨公司/跨团队/撤权后对外不可区分——
//      错误与计数不泄露存在性）。机器身份（MT042 MachineScanIdentity）与
//      部署级共享 token 结构上无法进入本入口：入参只能是签发入口产生的
//      PlatformScope（结构≠信任，MT005 先例）。
//   2. 执行业务身份（ExecutionGrant）：authorizeExecution 通过判定后铸出的
//      受信对象（WeakSet 对象身份；手造同形对象、JSON 往返、structuredClone
//      一律无效——assertTrustedExecutionGrant 拒绝）。shell 与文件操作以它
//      授权，不以机器身份放大权限：网关拿到 grant 才能对执行面动手，而
//      grant 只能由归属判定铸出。
//   3. 命名与隔离（executionWorkspaceSegments / parseExecutionArtifactPath）：
//      执行状态目录固定为 <root>/tenants/<t>/workspaces/<w>/bots/<bot>（与
//      agent-sandbox 原生侧共享同一 shared/execution-scope.ts 定义，两侧不可
//      能对“一个 scope 的状态放在哪”产生分歧）。每个段都是校验过的 plain id，
//      一个 scope 永远命名不出爬进另一个 scope 树的路径。
//   4. 列举与下载（listExecutionArtifacts / downloadExecutionArtifact）：
//      都先过归属判定（deny = canonical not-found，不泄露存在性），再限制
//      在本 scope 自己的树里；调用方提供的 artifact 路径解析出的归属与本
//      scope 不一致 = not-found。
//   5. cancel/reset/cull（cancelExecution / resetExecutionWorkspace /
//      cullExecutionArtifacts）：先过归属判定；deny 时执行面适配器一个都不
//      被调用（不可见语义 = 无传播），allow 时逐面传播并把每次尝试写成审计
//      行（denied 也留审计——审计是内部事实，不向调用方回显存在性）。
//      cull 只枚举/只删除本 scope 段下的候选：清理任务拿到的候选清单即使
//      含其他 scope 的路径，过滤器也会在 remove 之前把它们全部排除。
//
// 供 #86（MT043 AC3 取消传播）使用的接口形态见文件底部「执行面适配器」：
// ExecutionTarget（tenantId/workspaceId/botId/runId?）+ ExecutionSurface
// （cancel/reset?）+ cancelExecution(scope, botId, { runId })。取消信号路径：
// 受信 Scope → 事务内归属重验 → ExecutionGrant → 逐面适配器 → 审计行。
// #86 的网关侧实现只需注册适配器（把 target 翻译成 gateway.stopComputer /
// SandboxClient.resetWorkspace / POST /session/:id/abort 等既有入口并带上
// shared/execution-scope.ts 的两个归属头），不需要新的 scope 承载入口。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由、不改 gateway.ts / codesandbox / capacity 的既有
//     签名（服务面供 #86/#92 等下游接线票复用，与 MT009/MT011/MT016 同例）；
//     执行面适配器由接线方注入，本模块只负责归属判定与传播编排。
//   - 审计落点是注入的 sink（ExecutionAuditSink），不新建数据库表：归属
//     事实全部来自 MT016 的 enterprise_bot_ownership（只读消费），本票零
//     schema 变更、零迁移。
//   - 列举/下载的物理读取是注入的 reader（测试给内存树，接线方给 fs）；
//     本模块不直接触磁盘。

import { and, eq, sql } from "drizzle-orm";
import {
  type ExecutionScope,
  executionWorkspaceSegments,
} from "../../../../shared/execution-scope";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 执行业务身份：受信对象（AC2）
// ---------------------------------------------------------------------------

/**
 * 执行业务身份：一次执行面操作的授权凭据。
 *
 * 只能由 authorizeExecution 在归属判定通过后铸出；结构与信任无关
 * （assertTrustedExecutionGrant 只认签发时的对象身份）。携带的正是传播
 * 需要的最小事实：公司、团队、Bot 与发起主体。
 */
export interface ExecutionGrant {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  readonly principalId: string;
}

const issuedExecutionGrants = new WeakSet<object>();

/** 手造、反序列化或克隆的 grant 一律无效（MT005 scope-gate 同款纪律）。 */
export function assertTrustedExecutionGrant(grant: ExecutionGrant): void {
  if (
    !grant ||
    typeof grant !== "object" ||
    !issuedExecutionGrants.has(grant)
  ) {
    throw new Error("UNVERIFIED_EXECUTION_GRANT");
  }
}

// ---------------------------------------------------------------------------
// 命名与隔离：纯函数（AC1/AC4 的路径半边）
// ---------------------------------------------------------------------------

/** 一个 scope 的执行状态根（Bot 目录的父目录），按归属命名。 */
export function executionArtifactRoot(
  root: string,
  scope: Pick<ExecutionScope, "tenantId" | "workspaceId">,
): string {
  return [
    root.replace(/\/+$/, ""),
    "tenants",
    scope.tenantId,
    "workspaces",
    scope.workspaceId,
    "bots",
  ].join("/");
}

/** 一个 Bot 的执行状态目录（快照与工作目录都住在它下面）。 */
export function executionArtifactDir(
  root: string,
  scope: Pick<ExecutionScope, "tenantId" | "workspaceId">,
  botId: string,
): string {
  return [
    root.replace(/\/+$/, ""),
    ...executionWorkspaceSegments(scope, botId),
  ].join("/");
}

/** 从一条执行状态路径解析出归属；形状不符或含非 plain id 段 = null。 */
export function parseExecutionArtifactPath(
  root: string,
  path: string,
): { tenantId: string; workspaceId: string; botId: string } | null {
  const base = root.replace(/\/+$/, "");
  if (!path.startsWith(`${base}/`)) return null;
  const segments = path.slice(base.length + 1).split("/");
  if (segments.length < 6) return null;
  const [literal, tenantId, literal2, workspaceId, literal3, botId] = segments;
  if (
    literal !== "tenants" ||
    literal2 !== "workspaces" ||
    literal3 !== "bots"
  ) {
    return null;
  }
  const plain = (value: string): boolean =>
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
  if (!plain(tenantId) || !plain(workspaceId) || !plain(botId)) return null;
  return { tenantId, workspaceId, botId };
}

/** 路径属于本 scope：tenant 与 workspace 两段都相等。 */
export function scopeOwnsArtifactPath(
  scope: Pick<ExecutionScope, "tenantId" | "workspaceId">,
  parsed: { tenantId: string; workspaceId: string } | null,
): boolean {
  return (
    parsed !== null &&
    parsed.tenantId === scope.tenantId &&
    parsed.workspaceId === scope.workspaceId
  );
}

/**
 * 清理候选过滤器（AC4）：一个清扫例程看到的候选可能横跨所有 scope，本函数
 * 把“可以动手”的集合收缩到发起 scope 自己的段内。跨公司/跨团队的路径在
 * remove 之前就被排除——清理任务不会删除其他范围的快照或工作目录。
 */
export function cullableArtifactsInScope(
  root: string,
  scope: Pick<ExecutionScope, "tenantId" | "workspaceId">,
  candidates: readonly string[],
): readonly string[] {
  return candidates.filter((candidate) =>
    scopeOwnsArtifactPath(scope, parseExecutionArtifactPath(root, candidate)),
  );
}

// ---------------------------------------------------------------------------
// 审计：注入的 sink（AC3）
// ---------------------------------------------------------------------------

/** 一行执行面审计：归属标识俱全，永不含明文秘密、文件内容或命令文本。 */
export interface ExecutionAuditEvent {
  readonly action:
    | "execution.authorized"
    | "execution.artifact_list"
    | "execution.artifact_download"
    | "execution.cancel"
    | "execution.reset"
    | "execution.cull";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string | null;
  readonly principalId: string;
  readonly outcome: "allowed" | "denied";
  readonly reason?: "not-found" | "outside-scope";
  readonly surfaces?: readonly string[];
}

export interface ExecutionAuditSink {
  record(event: ExecutionAuditEvent): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// 执行面适配器：#86（MT043 AC3）的传播接口
// ---------------------------------------------------------------------------

/** 传播目标：归属三元组 + 可选 runId（对单一 run 的取消）。 */
export type ExecutionTarget = Readonly<{
  tenantId: string;
  workspaceId: string;
  botId: string;
  runId?: string;
}>;

export type ExecutionSurfaceOutcome =
  | "cancelled"
  | "not-running"
  | "cleared"
  | "absent"
  | "unavailable";

/** 一个执行面的适配器：把 target 翻译成该面的既有取消/重置入口。 */
export interface ExecutionSurface {
  /** 面名（审计行用），如 "computer" / "sandbox" / "native-runtime"。 */
  readonly surface: string;
  /** 停止该 Bot 的在途执行（计算机/浏览器/沙箱会话/run）。 */
  cancel(target: ExecutionTarget): Promise<{
    readonly outcome: ExecutionSurfaceOutcome;
    readonly detail?: string;
  }>;
  /** 清空该 Bot 的执行侧工作状态；没有该面的重置语义时可省略。 */
  reset?(target: ExecutionTarget): Promise<{
    readonly outcome: ExecutionSurfaceOutcome;
    readonly detail?: string;
  }>;
}

export interface SurfaceAttempt {
  readonly surface: string;
  readonly outcome: ExecutionSurfaceOutcome;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// 归属判定与服务
// ---------------------------------------------------------------------------

export type ExecutionOwnershipOutcome =
  | { readonly outcome: "allow"; readonly grant: ExecutionGrant }
  | ResourceNotFoundVerdict;

export interface ExecutionArtifactsServiceOptions {
  /** 受限 data 通道（真实 RLS）：归属事实的唯一读取面。 */
  readonly data: DataDatabase;
  /** 审计 sink：cancel/reset/cull 与列举/下载的授权结果都落在它上面。 */
  readonly audit: ExecutionAuditSink;
  /** 执行面适配器（#86 接线）；空数组 = 本部署没有可传播的执行面。 */
  readonly surfaces?: readonly ExecutionSurface[];
}

/** 列举结果：本 scope 自己树内的条目（相对路径），deny 时为空页。 */
export interface ArtifactListPage {
  readonly entries: readonly string[];
}

export function createExecutionArtifactsService(
  options: ExecutionArtifactsServiceOptions,
): {
  /**
   * 执行业务身份的签出入口（AC2）：判定 + 铸 grant。deny = canonical
   * not-found（跨公司/跨团队/撤权后不可区分）。
   */
  authorizeExecution(
    scope: PlatformScope,
    botId: string,
  ): Promise<ExecutionOwnershipOutcome>;
  /** 列举授权（AC1）：deny = 空页（计数不泄露存在性）。 */
  listExecutionArtifacts(
    scope: PlatformScope,
    botId: string,
    lister: {
      list(dir: string): Promise<readonly string[]>;
    },
    root: string,
  ): Promise<ArtifactListPage>;
  /** 下载授权（AC1）：deny = canonical not-found；路径归属不一致同 deny。 */
  downloadExecutionArtifact(
    scope: PlatformScope,
    botId: string,
    input: {
      readonly artifactPath: string;
      readonly root: string;
      open(path: string): Promise<Uint8Array>;
    },
  ): Promise<
    | { readonly outcome: "allow"; readonly bytes: Uint8Array }
    | ResourceNotFoundVerdict
  >;
  /** 取消传播（AC3，#86 的入口）：deny = 不传播；allow = 逐面 cancel + 审计。 */
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
  /** 重置传播（AC3）：deny = 不传播；allow = 逐面 reset（无 reset 的面跳过）。 */
  resetExecutionWorkspace(
    scope: PlatformScope,
    botId: string,
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly attempts: readonly SurfaceAttempt[];
      }
    | ResourceNotFoundVerdict
  >;
  /**
   * 清理（AC4）：候选由调用方枚举（清扫例程看到的可能是全部署的树），
   * 可动手集合收缩到本 scope 段内之后才逐个 remove。跨 scope 的路径一个
   * 都不会被删除，无论它出现在候选里的什么位置。
   */
  cullExecutionArtifacts(
    scope: PlatformScope,
    input: {
      readonly root: string;
      readonly candidates: readonly string[];
      remove(path: string): Promise<void>;
    },
  ): Promise<{
    readonly removed: readonly string[];
    readonly skipped: readonly string[];
  }>;
} {
  assertDataDatabase(options.data);
  const { data, audit } = options;
  const surfaces = options.surfaces ?? [];
  type Tx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

  const grantFor = (scope: PlatformScope, botId: string): ExecutionGrant => {
    const grant: ExecutionGrant = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      botId,
      principalId: scope.principalId,
    };
    issuedExecutionGrants.add(grant);
    return grant;
  };

  /** 归属判定（事务内重验，MT016 判定入口的执行侧切片）。 */
  const ownershipVerdict = async (
    scope: PlatformScope,
    botId: string,
  ): Promise<ExecutionOwnershipOutcome> => {
    assertTrustedScope(scope);
    return data.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
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
        JSON.stringify(["enterprise", "bot", scope.tenantId, botId]),
      ]) {
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
        );
      }
      // 公司级重验：撤权（挂起）递增 epoch，已签发 scope 立即失效（fail-closed）。
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
      // 团队级重验：行存在且 active（移除删行、挂起翻 status，都落在这里）。
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
      // 归属行：RLS 之后跨公司行本事务不可见；同公司异团队 = 行在但
      // workspace 不匹配 → 与不存在不可区分。
      const [row] = await tx
        .select({
          workspaceId: enterpriseBotOwnership.workspaceId,
          status: enterpriseBotOwnership.status,
        })
        .from(enterpriseBotOwnership)
        .where(
          and(
            eq(enterpriseBotOwnership.tenantId, scope.tenantId),
            eq(enterpriseBotOwnership.agentId, botId),
          ),
        )
        .limit(1);
      const allowed =
        company?.status === "active" &&
        company.epoch === scope.memberEpoch &&
        team?.status === "active" &&
        row?.status === "active" &&
        row.workspaceId === scope.workspaceId;
      return allowed
        ? { outcome: "allow" as const, grant: grantFor(scope, botId) }
        : notFoundVerdict();
    });
  };

  async function propagate(
    action: "execution.cancel" | "execution.reset",
    scope: PlatformScope,
    botId: string,
    runId: string | undefined,
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly attempts: readonly SurfaceAttempt[];
      }
    | ResourceNotFoundVerdict
  > {
    const verdict = await ownershipVerdict(scope, botId);
    if (verdict.outcome === "deny") {
      // 不可见 = 无传播：执行面一个都不被调用，且调用方拿到的形状与
      // “Bot 不存在”逐字节一致。审计留 denied 行（内部事实）。
      await audit.record({
        action,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "denied",
        reason: "not-found",
        surfaces: surfaces.map((surface) => surface.surface),
      });
      return verdict;
    }
    const target: ExecutionTarget = {
      tenantId: verdict.grant.tenantId,
      workspaceId: verdict.grant.workspaceId,
      botId: verdict.grant.botId,
      ...(runId !== undefined ? { runId } : {}),
    };
    assertTrustedExecutionGrant(verdict.grant);
    const attempts: SurfaceAttempt[] = [];
    for (const surface of surfaces) {
      try {
        const attempt =
          action === "execution.cancel"
            ? await surface.cancel(target)
            : surface.reset
              ? await surface.reset(target)
              : { outcome: "unavailable" as const, detail: "no reset seam" };
        attempts.push({
          surface: surface.surface,
          outcome: attempt.outcome,
          ...(attempt.detail !== undefined ? { detail: attempt.detail } : {}),
        });
      } catch (error) {
        // 一个面失败不终止传播：其他面的取消仍然发生，失败以 unavailable
        // 落进同一行审计（detail 是错误类别，不是消息文本——不回显值）。
        attempts.push({
          surface: surface.surface,
          outcome: "unavailable",
          detail: error instanceof Error ? error.name : "Error",
        });
      }
    }
    await audit.record({
      action,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      botId,
      principalId: scope.principalId,
      outcome: "allowed",
      surfaces: attempts.map((attempt) => attempt.surface),
    });
    return { outcome: "allow", attempts };
  }

  return {
    async authorizeExecution(scope, botId) {
      const verdict = await ownershipVerdict(scope, botId);
      // 授权本身不逐次落审计：shell/文件的每一次动作已有 computer 审计面
      // （gateway 的 write/writeControlEvent）承载；这里只对治理动作与
      // 产物面（列举/下载/cancel/reset/cull）留行，避免审计行淹没动作行。
      return verdict;
    },

    async listExecutionArtifacts(scope, botId, lister, root) {
      const verdict = await ownershipVerdict(scope, botId);
      if (verdict.outcome === "deny") {
        // 空页，不是错误：非成员的列表为空、计数为 0（issue 验收 3）。
        await audit.record({
          action: "execution.artifact_list",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          outcome: "denied",
          reason: "not-found",
        });
        return { entries: [] };
      }
      const entries = await lister.list(
        executionArtifactDir(root, scope, botId),
      );
      await audit.record({
        action: "execution.artifact_list",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { entries };
    },

    async downloadExecutionArtifact(scope, botId, input) {
      const verdict = await ownershipVerdict(scope, botId);
      // 路径归属先行：一个解析到别家 scope 的路径不让 open 碰磁盘。
      const parsed = parseExecutionArtifactPath(input.root, input.artifactPath);
      const pathInScope = scopeOwnsArtifactPath(scope, parsed);
      if (
        verdict.outcome === "deny" ||
        !pathInScope ||
        parsed?.botId !== botId
      ) {
        await audit.record({
          action: "execution.artifact_download",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          outcome: "denied",
          ...(pathInScope
            ? { reason: "not-found" as const }
            : { reason: "outside-scope" as const }),
        });
        return notFoundVerdict();
      }
      const bytes = await input.open(input.artifactPath);
      await audit.record({
        action: "execution.artifact_download",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow", bytes };
    },

    cancelExecution(scope, botId, input) {
      return propagate("execution.cancel", scope, botId, input?.runId);
    },

    resetExecutionWorkspace(scope, botId) {
      return propagate("execution.reset", scope, botId, undefined);
    },

    async cullExecutionArtifacts(scope, input) {
      // F2（round3 评审）：cull 是删除类操作且候选可来自全部署树——与其余
      // 四个公开入口同一纪律，scope 必须先过受信断言，过滤器才可信。
      assertTrustedScope(scope);
      // 候选先过 scope 过滤器（AC4）：跨公司/跨团队路径在 remove 之前出局。
      const removable = cullableArtifactsInScope(
        input.root,
        scope,
        input.candidates,
      );
      const skipped = input.candidates.filter(
        (candidate) => !removable.includes(candidate),
      );
      // cull 是 scope 级治理动作：主体是受信 scope，不需要逐 Bot 判定（候选
      // 集合本身就已被本 scope 的段限定），但审计行携带归属三元组。
      const removed: string[] = [];
      for (const path of removable) {
        await input.remove(path);
        removed.push(path);
      }
      await audit.record({
        action: "execution.cull",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId: null,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { removed, skipped };
    },
  };
}
