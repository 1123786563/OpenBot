// server/src/enterprise/tenancy/workshop-scope.ts
// MT057（Issue #100）：Workshop 会话、执行、产物与沙箱实例关联的作用域。
//
// 票面语义（Issue #100 正文）：
//   AC1 会话与执行记录固定归属；跨范围访问返回不可见语义。
//   AC2 沙箱实例只与同范围会话关联；回收后不复用给其他范围而不清理。
//   AC3 原匿名公开入口改为要求有效身份与受众（与 MT058 一致）。
//   AC4 调度与实例关联的一致性有测试覆盖。
//
// 结构（纯新增服务面 + 两张协会表（MT057 迁移），只读消费既有 workshop
// 权威 store 与 MT055 产物服务，不改任何既有文件语义——MT053 同型判例）：
//
//   1. 会话归属（AC1）：workshop_sessions（只有 owner_user_id 的个人形状）
//      在创建接线时经 pinWorkshopSession 固定 (公司, 团队, 主体, user)
//      归属——先验证会话行存在且 ownerUserId === 受信 scope 的 actorId
//      （本人会话；他人会话/不存在 → canonical not-found），再写协会行
//      （create-once；同三元组幂等 existing，不同选择标识响亮拒绝）。
//      turn、turn 事件、产物与调度行全部经 session_id cascade 挂在会话
//      下——归属随根行成立（Spec §4.2）。
//   2. 范围化读取（AC1）：readSession / listTurns / readTurn 都先过同一道
//      范围门（受限 data 通道 + 真实 RLS + 事务内成员事实重验 + 协会行
//      三元组比对）。执行记录（workshop_turns 的 status/事件流）对跨范围
//      ID = canonical RESOURCE_NOT_FOUND——不存在/跨团队/跨公司/他人/
//      撤权对外逐字节不可区分。列表面对公司级撤销响亮拒绝（SCOPE_REVOKED）。
//   3. 沙箱实例关联（AC2）：bindSandboxInstance 把一个 sandbox_instances
//      行绑定到同范围会话——判定链：实例行存在且其 bot 与会话行 bot 同一
//      （执行面同位）→ 会话协会行三元组与请求 scope 逐字一致 → 绑定行
//      create-once（instanceId 主键；同三元组幂等 existing）。跨范围重绑
//      在结构上不可能「静默换主」：已绑定实例换三元组的 pin 尝试得到
//      WORKSHOP_SANDBOX_BINDING_MISMATCH 响亮拒绝，且必须先由原范围
//      recycle（回收 = 判定 + 注入端口清理 + status 翻转）并清理绑定行
//      ——「回收后不复用给其他范围而不清理」由 create-once + 原范围
//      DELETE 授权钉死。recycleSandboxInstance 只对绑定三元组与请求
//      scope 一致的实例生效：跨范围回收请求折叠为 not-found，他人的
//      实例一个字节都不动。
//   4. 公开入口（AC3）：resolveWorkshopShareAccess 是原匿名解析入口
//      （workshop/sharing.ts resolveShareActor——「持有令牌即任何人」）
//      的企业面替代：入口签名要求受信 PlatformScope（有效身份），
//      受众判定经 MT058 分享授权（share-tokens.ts）——匿名调用在类型面
//      就不存在入口（手造 scope 被 assertTrustedScope 拒绝）。生产
//      /api/public/workshop 路由的改线属接线票；本票交付判定面与测试
//      钉死「无身份 = 拒绝且零元数据」。
//   5. 调度一致性（AC4）：listSchedules / readSchedule 经会话范围门后
//      委托既有 store；调度行只能经其会话到达（session_id cascade）。
//      一致性测试：绑定行的三元组 = 会话协会行的三元组（绑定守卫钉死
//      + 回收后重绑另一会话的拒绝路径）。
//
// 事务纪律与 MT053 完全一致：受信 Scope → read committed + lock/statement
// timeout → set_config('app.*', …, true) 事务本地 → advisory 锁（键序
// tenant → principal → membership → workspace-membership → session/
// instance；读共享、控制排他）→ 成员事实重验 → 判定或委托。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源）。哨兵码（确定性、零回显）：
// WORKSHOP_SESSION_ID_INVALID / WORKSHOP_INPUT_INVALID /
// WORKSHOP_SCOPE_MISMATCH / WORKSHOP_SANDBOX_BINDING_MISMATCH /
// WORKSHOP_SANDBOX_INSTANCE_INVALID / SCOPE_REVOKED。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由、不改 workshop/routes.ts / public-routes.ts /
//      sharing.ts 的既有签名与个人路径（服务面供下游接线票复用）；
//     workshop/sharing.ts 的 B14 匿名半边原样保留给非企业面。
//   - 既有个人会话（无协会行）在企业面不可见：不猜测回填（#158/#161
//     回填批的裁决域；Spec §9.2「不按猜测分配」）。
//   - 实例清理的物理半边（容器停止/目录删除）是注入端口（测试给记录
//     端口，接线方给 supervisor/gateway 既有入口——MT046 同例）；绑定
//     行的翻转与删除是本票的持久事实。
//   - 产物族的会话关联经 MT055（enterprise_artifact_scopes）独立成立；
//     本票的会话门是会话/执行/调度面，产物读仍走 MT055 服务门。

import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  enterpriseWorkshopSandboxBindings,
  enterpriseWorkshopScopes,
} from "../../db/schema/enterprise-workshop-scopes";
import type { WorkshopSessionRow, WorkshopTurnRow } from "../../workshop/store";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 哨兵码与词表
// ---------------------------------------------------------------------------

export const WORKSHOP_SESSION_ID_INVALID = "WORKSHOP_SESSION_ID_INVALID";
export const WORKSHOP_TURN_ID_INVALID = "WORKSHOP_TURN_ID_INVALID";
export const WORKSHOP_INPUT_INVALID = "WORKSHOP_INPUT_INVALID";
export const WORKSHOP_SCOPE_MISMATCH = "WORKSHOP_SCOPE_MISMATCH";
export const WORKSHOP_SANDBOX_INSTANCE_INVALID =
  "WORKSHOP_SANDBOX_INSTANCE_INVALID";
export const WORKSHOP_SANDBOX_BINDING_MISMATCH =
  "WORKSHOP_SANDBOX_BINDING_MISMATCH";
/** 列表面对公司级撤销的响亮拒绝（MT041 成员视图同纪律）。 */
export const WORKSHOP_SCOPE_REVOKED = "SCOPE_REVOKED";

// ---------------------------------------------------------------------------
// 行缝：既有 workshop 权威 store 的最小投影
// ---------------------------------------------------------------------------

/** 既有权威 store 的最小投影（语义归 workshop/store.ts，本模块零复刻）。 */
export interface WorkshopRows {
  findSessionById(sessionId: string): Promise<WorkshopSessionRow | undefined>;
  findSessionByChannel(
    channelId: string,
  ): Promise<WorkshopSessionRow | undefined>;
  listTurns(sessionId: string): Promise<readonly WorkshopTurnRow[]>;
  getTurn(turnId: string): Promise<WorkshopTurnRow | undefined>;
  listSchedules(sessionId: string): Promise<
    readonly {
      readonly id: string;
      readonly prompt: string;
      readonly rrule: string;
      readonly status: string;
      readonly nextRunAt: Date | null;
      readonly createdAt: Date;
    }[]
  >;
}

/** 沙箱实例行的权威事实投影（platform 通道行）。 */
export interface SandboxInstanceRows {
  findInstanceById(input: { readonly instanceId: string }): Promise<
    | {
        readonly instanceId: string;
        readonly botId: string;
        readonly status: string;
      }
    | undefined
  >;
}

/** 回收的物理半边（注入端口：容器停止/目录清理——MT046 同例）。 */
export interface SandboxRecyclePort {
  recycle(input: {
    readonly instanceId: string;
    readonly botId: string;
  }): Promise<void>;
}

/**
 * 分享受众判定端口（MT058 share-tokens 的解析入口形状；结构满足即可，
 * share-tokens.ts 的 createWorkshopShareService 是唯一生产实现）。AC3：
 * 企业面的分享解析要求有效身份（PlatformScope）+ 受众判定——原匿名
 * 承载段（resolveShareActor(token) 无身份）在结构上没有入口。
 */
export interface WorkshopShareResolution {
  resolveShareAccess(
    scope: PlatformScope,
    input: { readonly token: string },
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly channelId: string;
        readonly sessionId: string;
        readonly via: "same-team" | "cross-team";
        readonly shareAction: "preview" | "preview_download";
      }
    | ResourceNotFoundVerdict
  >;
}

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

/** 一条会话归属协会行的投影（零内容，纯归属事实）。 */
export interface WorkshopSessionScopeView {
  readonly sessionId: string;
  readonly channelId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

export type WorkshopSessionPinResult =
  | { readonly status: "pinned"; readonly ownership: WorkshopSessionScopeView }
  | {
      readonly status: "existing";
      readonly ownership: WorkshopSessionScopeView;
    };

export type WorkshopSessionReadOutcome =
  | {
      readonly outcome: "allow";
      readonly session: WorkshopSessionRow;
    }
  | ResourceNotFoundVerdict;

export type WorkshopTurnReadOutcome =
  | {
      readonly outcome: "allow";
      readonly turn: WorkshopTurnRow;
      readonly sessionScope: WorkshopSessionScopeView;
    }
  | ResourceNotFoundVerdict;

export type SandboxBindResult =
  | { readonly status: "bound"; readonly instanceId: string }
  | { readonly status: "existing"; readonly instanceId: string };

export type SandboxRecycleOutcome =
  | {
      readonly outcome: "allow";
      readonly instanceId: string;
      readonly recycledAt: Date;
    }
  | ResourceNotFoundVerdict;

/** 一条沙箱绑定行的投影（一致性测试的读面）。 */
export type SandboxBindingView =
  | {
      readonly outcome: "allow";
      readonly binding: {
        readonly instanceId: string;
        readonly sessionId: string;
        readonly tenantId: string;
        readonly workspaceId: string;
        readonly principalId: string;
        readonly status: "bound" | "recycled";
      };
    }
  | ResourceNotFoundVerdict;

export interface WorkshopScopeService {
  /** 创建接线时的会话归属固定（create-once；mismatch 响亮拒绝）。 */
  pinWorkshopSession(
    scope: PlatformScope,
    input: { readonly channelId: string },
  ): Promise<WorkshopSessionPinResult | ResourceNotFoundVerdict>;

  /** 范围化列表（AC1）：三元组下本人的会话；公司撤销响亮拒绝。 */
  listSessions(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly sessions: readonly {
      readonly sessionId: string;
      readonly channelId: string;
      readonly status: WorkshopSessionRow["status"];
      readonly createdAt: Date;
    }[];
    readonly nextCursor?: string;
  }>;

  /** 会话详情（AC1）：不可见 = canonical not-found。 */
  readSession(
    scope: PlatformScope,
    input: { readonly channelId: string },
  ): Promise<WorkshopSessionReadOutcome>;

  /** 执行记录（AC1）：turn 列表经会话范围门。 */
  listTurns(
    scope: PlatformScope,
    input: { readonly channelId: string },
  ): Promise<
    | { readonly outcome: "allow"; readonly turns: readonly WorkshopTurnRow[] }
    | ResourceNotFoundVerdict
  >;

  /** 执行记录（AC1）：单 turn 经会话范围门（跨范围 ID = not-found）。 */
  readTurn(
    scope: PlatformScope,
    input: { readonly turnId: string },
  ): Promise<WorkshopTurnReadOutcome>;

  /**
   * 沙箱实例绑定（AC2）：同范围会话 + 同 Bot 的实例；create-once；跨
   * 三元组重绑响亮拒绝（不清不换）。
   */
  bindSandboxInstance(
    scope: PlatformScope,
    input: {
      readonly channelId: string;
      readonly instanceId: string;
    },
  ): Promise<SandboxBindResult | ResourceNotFoundVerdict>;

  /**
   * 沙箱实例回收（AC2）：只对绑定三元组一致的实例生效；回收 = 判定 +
   * 注入端口清理 + status 翻转。跨范围回收 = not-found（零端口调用）。
   */
  recycleSandboxInstance(
    scope: PlatformScope,
    input: { readonly instanceId: string },
  ): Promise<SandboxRecycleOutcome>;

  /** 绑定行读面（AC4 一致性测试；同 scope 才可见）。 */
  readSandboxBinding(
    scope: PlatformScope,
    input: { readonly instanceId: string },
  ): Promise<SandboxBindingView>;

  /** 调度（AC4）：经会话范围门后委托权威 store。 */
  listSchedules(
    scope: PlatformScope,
    input: { readonly channelId: string },
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly schedules: readonly {
          readonly id: string;
          readonly prompt: string;
          readonly rrule: string;
          readonly status: string;
          readonly nextRunAt: Date | null;
          readonly createdAt: Date;
        }[];
      }
    | ResourceNotFoundVerdict
  >;

  /**
   * 分享解析入口（AC3）：有效身份（受信 Scope）+ 会话归属门 + 受众判定
   * （MT058 端口）。原匿名入口（无身份只凭令牌）在结构上没有入口——
   * token 从未单独成为授权事实。
   */
  resolveWorkshopShareAccess(
    scope: PlatformScope,
    input: {
      readonly token: string;
      readonly channelId: string;
    },
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly channelId: string;
        readonly sessionId: string;
        readonly via: "same-team" | "cross-team";
        readonly shareAction: "preview" | "preview_download";
      }
    | ResourceNotFoundVerdict
  >;
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

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const plainId = (value: string, field: string, code: string): string => {
  if (!PLAIN_ID.test(value)) {
    throw new Error(`${code}: ${field}`);
  }
  return value;
};

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

export function createWorkshopScopeService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: WorkshopRows;
  readonly instances: SandboxInstanceRows;
  readonly recyclePort: SandboxRecyclePort;
  /** MT058 受众判定端口（AC3；生产实现 = share-tokens.ts）。 */
  readonly shareResolution?: WorkshopShareResolution;
}): WorkshopScopeService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);
  const { data, operator, rows, instances, recyclePort, shareResolution } =
    deps;

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
    row: typeof enterpriseWorkshopScopes.$inferSelect,
  ): WorkshopSessionScopeView => ({
    sessionId: row.sessionId,
    channelId: row.channelId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  });

  /**
   * 频道→会话范围门（AC1 唯一判定入口）。channelId 是 workshop 路由的
   * 寻址键；协会行按 (tenant, channel) 取后三元组比对——任何不成立 =
   * null（不可见）。
   */
  const authorizeByChannel = async (
    scope: PlatformScope,
    channelId: string,
  ): Promise<WorkshopSessionScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(enterpriseWorkshopScopes)
        .where(
          and(
            eq(enterpriseWorkshopScopes.tenantId, scope.tenantId),
            eq(enterpriseWorkshopScopes.channelId, channelId),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (
        row.workspaceId !== scope.workspaceId ||
        row.principalId !== scope.principalId
      ) {
        return null;
      }
      return scopeViewOf(row);
    });

  /** turn → 会话范围门：turn 行存在 → 其 session 的协会行三元组比对。 */
  const authorizeByTurn = async (
    scope: PlatformScope,
    turnId: string,
  ): Promise<{
    readonly ownership: WorkshopSessionScopeView;
    readonly turn: WorkshopTurnRow;
  } | null> => {
    const turn = await rows.getTurn(turnId);
    if (!turn) return null;
    const [row] = await data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return [];
      return tx
        .select()
        .from(enterpriseWorkshopScopes)
        .where(eq(enterpriseWorkshopScopes.sessionId, turn.sessionId))
        .limit(1);
    });
    if (!row) return null;
    if (
      row.tenantId !== scope.tenantId ||
      row.workspaceId !== scope.workspaceId ||
      row.principalId !== scope.principalId
    ) {
      return null;
    }
    return { ownership: scopeViewOf(row), turn };
  };

  const sessionControlLockKey = (sessionId: string): string =>
    JSON.stringify(["enterprise-workshop-scope", "session", sessionId]);
  const instanceControlLockKey = (instanceId: string): string =>
    JSON.stringify(["enterprise-workshop-scope", "instance", instanceId]);

  return {
    async pinWorkshopSession(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      // 本人会话守卫：他人会话/不存在不可区分（canonical not-found）。
      const session = await rows.findSessionByChannel(channelId);
      if (!session || session.ownerUserId !== scope.actorId) {
        return DENY_VERDICT;
      }
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return DENY_VERDICT;
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${sessionControlLockKey(
            session.id,
          )}, 0))`,
        );
        const [inserted] = await tx
          .insert(enterpriseWorkshopScopes)
          .values({
            sessionId: session.id,
            channelId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
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
          .from(enterpriseWorkshopScopes)
          .where(eq(enterpriseWorkshopScopes.sessionId, session.id))
          .limit(1);
        if (
          existing &&
          existing.tenantId === scope.tenantId &&
          existing.workspaceId === scope.workspaceId &&
          existing.principalId === scope.principalId &&
          existing.userId === scope.actorId
        ) {
          return {
            status: "existing" as const,
            ownership: scopeViewOf(existing),
          };
        }
        // 不同选择标识：响亮拒绝，已存归属不动（create-once 纪律）。
        throw new Error(WORKSHOP_SCOPE_MISMATCH);
      });
    },

    async listSessions(scope, page) {
      assertTrustedScope(scope);
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200) {
        throw new Error(`${WORKSHOP_INPUT_INVALID}: limit`);
      }
      const memberOk = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        return facts.companyActive && facts.teamActive;
      });
      if (!memberOk) throw new Error(WORKSHOP_SCOPE_REVOKED);
      const scopeRows = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conditions = [
          eq(enterpriseWorkshopScopes.tenantId, scope.tenantId),
          eq(enterpriseWorkshopScopes.workspaceId, scope.workspaceId),
          eq(enterpriseWorkshopScopes.principalId, scope.principalId),
        ];
        if (page.cursor !== undefined) {
          const parsed = new Date(String(page.cursor));
          if (Number.isNaN(parsed.getTime())) {
            throw new Error(`${WORKSHOP_INPUT_INVALID}: cursor`);
          }
          conditions.push(lt(enterpriseWorkshopScopes.createdAt, parsed));
        }
        return tx
          .select({
            sessionId: enterpriseWorkshopScopes.sessionId,
            channelId: enterpriseWorkshopScopes.channelId,
            createdAt: enterpriseWorkshopScopes.createdAt,
          })
          .from(enterpriseWorkshopScopes)
          .where(and(...conditions))
          .orderBy(
            desc(enterpriseWorkshopScopes.createdAt),
            desc(enterpriseWorkshopScopes.sessionId),
          )
          .limit(page.limit + 1);
      });
      const pageRows = scopeRows.slice(0, page.limit);
      // 权威行按会话读（平台通道，范围门已钉死）。
      const views = [] as {
        readonly sessionId: string;
        readonly channelId: string;
        readonly status: WorkshopSessionRow["status"];
        readonly createdAt: Date;
      }[];
      for (const scopeRow of pageRows) {
        const session = await rows.findSessionById(scopeRow.sessionId);
        if (!session) continue;
        views.push({
          sessionId: session.id,
          channelId: scopeRow.channelId,
          status: session.status,
          createdAt: session.createdAt,
        });
      }
      return {
        sessions: views,
        ...(scopeRows.length > page.limit
          ? {
              nextCursor:
                pageRows[pageRows.length - 1]?.createdAt.toISOString(),
            }
          : {}),
      };
    },

    async readSession(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      const ownership = await authorizeByChannel(scope, channelId);
      if (ownership === null) return DENY_VERDICT;
      const session = await rows.findSessionById(ownership.sessionId);
      if (!session) return DENY_VERDICT;
      return { outcome: "allow" as const, session };
    },

    async listTurns(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      const ownership = await authorizeByChannel(scope, channelId);
      if (ownership === null) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        turns: await rows.listTurns(ownership.sessionId),
      };
    },

    async readTurn(scope, input) {
      assertTrustedScope(scope);
      const turnId = plainId(input.turnId, "turnId", WORKSHOP_TURN_ID_INVALID);
      const authorized = await authorizeByTurn(scope, turnId);
      if (authorized === null) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        turn: authorized.turn,
        sessionScope: authorized.ownership,
      };
    },

    async bindSandboxInstance(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      const instanceId = plainId(
        input.instanceId,
        "instanceId",
        WORKSHOP_SANDBOX_INSTANCE_INVALID,
      );
      // AC2 前半：实例只与同范围会话关联——会话范围门先行。
      const ownership = await authorizeByChannel(scope, channelId);
      if (ownership === null) return DENY_VERDICT;
      const session = await rows.findSessionById(ownership.sessionId);
      if (!session) return DENY_VERDICT;
      const instance = await instances.findInstanceById({ instanceId });
      if (!instance) return DENY_VERDICT;
      // 已回收实例的容器/工作目录已被物理清理：不得把绑定行翻回 bound。
      if (instance.status === "recycled") return DENY_VERDICT;
      // 执行面同位：实例的 Bot 就是会话的 Bot（不同 Bot 的实例不是本
      // 会话的执行面——拒绝且不泄露细节）。
      if (instance.botId !== session.botId) return DENY_VERDICT;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return DENY_VERDICT;
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${instanceControlLockKey(
            instanceId,
          )}, 0))`,
        );
        const [inserted] = await tx
          .insert(enterpriseWorkshopSandboxBindings)
          .values({
            instanceId,
            sessionId: ownership.sessionId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return { status: "bound" as const, instanceId };
        }
        const [existing] = await tx
          .select()
          .from(enterpriseWorkshopSandboxBindings)
          .where(eq(enterpriseWorkshopSandboxBindings.instanceId, instanceId))
          .limit(1);
        if (
          existing &&
          existing.tenantId === scope.tenantId &&
          existing.workspaceId === scope.workspaceId &&
          existing.principalId === scope.principalId &&
          existing.sessionId === ownership.sessionId
        ) {
          // 同范围重绑：物理清理已在 recycle 时点发生，生命周期翻回
          // bound（列级 UPDATE 只动 status/recycled_at——归属不可变）。
          if (existing.status === "recycled") {
            await tx
              .update(enterpriseWorkshopSandboxBindings)
              .set({ status: "bound", recycledAt: null, updatedAt: new Date() })
              .where(
                eq(enterpriseWorkshopSandboxBindings.instanceId, instanceId),
              );
            return { status: "bound" as const, instanceId };
          }
          return { status: "existing" as const, instanceId };
        }
        // 跨范围重绑（或换会话）：响亮拒绝——绑定事实 create-once，换
        // 主必须先由原范围 recycle + 清理（AC2「不清不换」）。
        throw new Error(WORKSHOP_SANDBOX_BINDING_MISMATCH);
      });
    },

    async recycleSandboxInstance(scope, input) {
      assertTrustedScope(scope);
      const instanceId = plainId(
        input.instanceId,
        "instanceId",
        WORKSHOP_SANDBOX_INSTANCE_INVALID,
      );
      // 回收只对绑定三元组与请求 scope 一致的实例生效：跨范围回收请求
      // 折叠为 not-found，注入端口一个都不被调用（不可见 = 零副作用）。
      const authorized = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) return null;
        const [row] = await tx
          .select()
          .from(enterpriseWorkshopSandboxBindings)
          .where(eq(enterpriseWorkshopSandboxBindings.instanceId, instanceId))
          .limit(1);
        if (!row) return null;
        // 幂等：已回收（status='recycled'）的实例在这里就 deny，物理回收
        // 端口零调用——不重复产生停止容器/清目录的副作用。
        if (
          row.status !== "bound" ||
          row.tenantId !== scope.tenantId ||
          row.workspaceId !== scope.workspaceId ||
          row.principalId !== scope.principalId
        ) {
          return null;
        }
        return row;
      });
      if (authorized === null) return DENY_VERDICT;
      const instance = await instances.findInstanceById({ instanceId });
      if (!instance) return DENY_VERDICT;
      // 物理半边先清（容器/工作目录），持久半边后翻——失败时状态行
      // 不被误标已回收（清理失败原样上抛）。
      await recyclePort.recycle({ instanceId, botId: instance.botId });
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 持久半边翻转前在写事务内重验成员事实（与 bind 同款）：授权读
        // 与本事务之间发生的公司/团队撤权在此收口。
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return DENY_VERDICT;
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${instanceControlLockKey(
            instanceId,
          )}, 0))`,
        );
        const recycledAt = new Date();
        const updated = await tx
          .update(enterpriseWorkshopSandboxBindings)
          .set({ status: "recycled", recycledAt, updatedAt: new Date() })
          .where(
            and(
              eq(enterpriseWorkshopSandboxBindings.instanceId, instanceId),
              eq(enterpriseWorkshopSandboxBindings.tenantId, scope.tenantId),
              eq(
                enterpriseWorkshopSandboxBindings.principalId,
                scope.principalId,
              ),
              eq(enterpriseWorkshopSandboxBindings.status, "bound"),
            ),
          )
          .returning({
            instanceId: enterpriseWorkshopSandboxBindings.instanceId,
          });
        if (updated.length === 0) return DENY_VERDICT;
        return { outcome: "allow" as const, instanceId, recycledAt };
      });
    },

    async readSandboxBinding(scope, input) {
      assertTrustedScope(scope);
      const instanceId = plainId(
        input.instanceId,
        "instanceId",
        WORKSHOP_SANDBOX_INSTANCE_INVALID,
      );
      const row = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) return null;
        const [found] = await tx
          .select()
          .from(enterpriseWorkshopSandboxBindings)
          .where(eq(enterpriseWorkshopSandboxBindings.instanceId, instanceId))
          .limit(1);
        if (!found) return null;
        if (
          found.tenantId !== scope.tenantId ||
          found.workspaceId !== scope.workspaceId ||
          found.principalId !== scope.principalId
        ) {
          return null;
        }
        return found;
      });
      if (row === null) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        binding: {
          instanceId: row.instanceId,
          sessionId: row.sessionId,
          tenantId: row.tenantId,
          workspaceId: row.workspaceId,
          principalId: row.principalId,
          status: row.status,
        },
      };
    },

    async listSchedules(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      const ownership = await authorizeByChannel(scope, channelId);
      if (ownership === null) return DENY_VERDICT;
      const schedules = await rows.listSchedules(ownership.sessionId);
      return {
        outcome: "allow" as const,
        schedules: schedules.map((schedule) => ({
          id: schedule.id,
          prompt: schedule.prompt,
          rrule: schedule.rrule,
          status: schedule.status,
          nextRunAt: schedule.nextRunAt,
          createdAt: schedule.createdAt,
        })),
      };
    },

    async resolveWorkshopShareAccess(scope, input) {
      assertTrustedScope(scope);
      const channelId = plainId(
        input.channelId,
        "channelId",
        WORKSHOP_SESSION_ID_INVALID,
      );
      // 会话归属门先行：跨范围频道 = canonical not-found（不进入受众
      // 判定，零存在泄露）。注意 same-team 受众对同团队成员放行、
      // cross-team 对受众团队放行——门与会话属主三元组比对放开的
      // 是「同公司可见」半边，受众半边由 MT058 端口判定。
      if (!shareResolution) return DENY_VERDICT;
      // 会话归属门先行（AC1 唯一判定入口，同 listSchedules 等面）：跨范围
      // 频道 = canonical deny，不进入受众判定，零存在泄露。
      if ((await authorizeByChannel(scope, channelId)) === null) {
        return DENY_VERDICT;
      }
      const resolved = await shareResolution.resolveShareAccess(scope, {
        token: input.token,
      });
      if (!("outcome" in resolved) || resolved.outcome !== "allow") {
        return DENY_VERDICT;
      }
      // URL 寻址一致性：解析出的会话频道与请求频道一致（B14 同款）。
      if (resolved.channelId !== channelId) return DENY_VERDICT;
      return resolved;
    },
  };
}
