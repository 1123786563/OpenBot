// server/src/enterprise/tenancy/craft-sessions.ts
// MT053（Issue #96）：Craft 会话、turn、消息与快照的作用域。
//
// 票面语义（Issue #96 正文）：
//   AC1 列表与详情只返回当前范围；跨范围 ID 返回不可见语义。
//   AC2 快照按归属存储与读取；下载需要授权。
//   AC3 团队公共 Craft 内容遵循 MT009 动作矩阵（可用不可改）。
//   AC4 撤权后立即失去访问。
//
// 结构（纯新增服务面 + 一张协会表 enterprise_craft_scopes（MT053 迁移），
// 只读消费 MT008/MT011/MT021 既有出口与既有 craft 权威 store，不改任何
// 既有文件语义——MT060 openmuse 任务域同型判例）：
//
//   1. 归属（Spec §4.2 受约束关联）：每个会话在创建接线时经
//      pinCraftSession 固定 (公司, 团队, 主体, user) 归属——先在本人
//      事务内验证 craft_sessions 行存在且 user_id === 受信 scope 的
//      actorId（本人创建的行；他人会话/不存在 → canonical not-found），
//      再写协会行（create-once；同三元组幂等返回 existing，不同选择标识
//      一律 CRAFT_SESSION_SCOPE_MISMATCH 响亮拒绝且已存行不动）。turn 与
//      消息（craft_messages）与快照行（craft_snapshots）经 session_id
//      cascade 挂在会话下——归属随根行成立，读经同一道范围门。
//   2. 范围化列表/详情（AC1）：一切动作先过同一道范围门——受限 data 通道
//      + 事务本地上下文 + 真实 RLS（租户臂 + restrictive 主体自读臂）→
//      事务内公司（active + epoch 匹配签发时版本）与团队（active）事实
//      重验 → 协会行 (tenant, workspace, principal) 三元组比对（第二道
//      独立防线）。缺席/跨团队/跨公司/他人/撤权对对象面全部折叠为不可
//      见：详情 = MT011 canonical RESOURCE_NOT_FOUND；列表面对公司级撤销
//      响亮拒绝（SCOPE_REVOKED，MT041 成员视图同纪律）。列表只经协会行
//      join 权威 store（keyset 稳定序 (created_at DESC, session_id)）。
//   3. 团队公共矩阵（AC3，MT009 语义的 craft 承载）：会话的公共事实 =
//      craft_sessions.sharing_scope='public_org'。读（详情/消息/快照列
//      表/下载）对同团队活跃成员放行（成员经 operator 的 workspace 读臂
//      确认「归属行存在且同团队」——存在性事实，不含属主主体标识）；写
//      动作（rename/sharing 翻转/删除）只属属主：非属主成员得到
//      TEAM_PUBLIC_ACTION_FORBIDDEN（成员本可见资源，该拒绝不新增信息，
//      与 MT009 管理动作拒绝同形），外部人（跨团队/跨公司/撤权）折叠为
//      canonical not-found。判定语义不复刻 MT009 的注册表面——craft 域
//      的公共事实只有 sharing_scope 一处定义。
//   4. 快照（AC2）：craftSnapshotObjectKey 是纯函数——企业面存储键
//      craft-snapshots/<tenant>/<workspace>/<session>/<snapshot>.tar.gz
//      四段全是校验过的 plain id，一个 scope 永远命名不出另一个 scope
//      的键（MT047 executionArtifactDir 同纪律）。下载授权 =
//      范围门（属主或公共矩阵）→ 权威行（craft_snapshots 经 store 读取，
//      storagePath 来自权威行，调用方输入里没有路径）→ 注入的
//      objectStore.get；跨范围 ID = canonical not-found 且 objectStore
//      零调用。
//   5. 撤权（AC4）：每个入口（含成员分支）都在事务内现读公司成员资格
//      （status active + epoch === scope.memberEpoch——撤权递增 epoch，
//      已签发 scope 立即失效，MT005/MT018/MT029 同款）；撤权后的读 =
//      不可见，写 = 不可见（不是 forbidden——撤权者不再是「可见资源上
//      的非属主成员」）。
//
// 事务纪律与 MT016/MT022/MT060 完全一致：受信 Scope（assertTrustedScope）
// → read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁（键序 tenant → principal → membership →
// workspace-membership → session；读共享、控制排他）→ 成员事实重验 →
// 判定或委托。会话行读写经既有 craft 权威 store（平台通道，与生产装配
// 同源——范围合法性已由范围门钉死后委托）。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形——不存在/跨团队/跨公司/他人/
// 撤权对外不可区分）。哨兵码（确定性、零回显）：
// CRAFT_SESSION_SCOPE_MISMATCH / CRAFT_SESSION_WORKSPACE_MEMBERSHIP_REQUIRED /
// SCOPE_REVOKED。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由（服务面供下游接线票复用，MT016/MT022/MT060
//     同例）；craft 的个人面（既有 routes）原样不动。
//   - 既有个人会话（无协会行）在企业面不可见：不猜测回填（回填属后续
//     票，Spec §9.2「不按猜测分配」）；本票只钉创建接线与作用域语义。
//   - objectStore 是注入端口（测试给内存 store，接线方给真实对象存储）；
//     本模块不触网不触盘。
//   - 快照「写入」的企业键派生（craftSnapshotObjectKey）供装配在企业
//     面存储时使用；既有 takeSnapshot 的个人面路径不在本票改动。

import { and, desc, eq, lt, sql } from "drizzle-orm";
import type {
  CraftMessageRow,
  CraftSessionRow,
  CraftSnapshotRow,
} from "../../craft/store";
import { enterpriseCraftScopes } from "../../db/schema/enterprise-craft-scopes";
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
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 哨兵码与词表
// ---------------------------------------------------------------------------

export const CRAFT_SESSION_ID_INVALID = "CRAFT_SESSION_ID_INVALID";
export const CRAFT_SESSION_INPUT_INVALID = "CRAFT_SESSION_INPUT_INVALID";
export const CRAFT_SESSION_SCOPE_MISMATCH = "CRAFT_SESSION_SCOPE_MISMATCH";
export const CRAFT_SESSION_WORKSPACE_MEMBERSHIP_REQUIRED =
  "CRAFT_SESSION_WORKSPACE_MEMBERSHIP_REQUIRED";
export const CRAFT_SESSION_SNAPSHOT_ID_INVALID =
  "CRAFT_SESSION_SNAPSHOT_ID_INVALID";
/** 列表面对公司级撤销的响亮拒绝（MT041 成员视图同纪律）。 */
export const CRAFT_SESSION_SCOPE_REVOKED = "SCOPE_REVOKED";
/** MT009 管理动作拒绝的同形词（成员可见资源上的非属主写）。 */
export const CRAFT_TEAM_PUBLIC_ACTION_FORBIDDEN =
  "TEAM_PUBLIC_ACTION_FORBIDDEN";

/** 写动作的闭集（AC3 矩阵的「不可改」半边）。 */
export const CRAFT_SESSION_WRITE_ACTIONS = [
  "rename",
  "share",
  "archive",
  "delete",
] as const;
export type CraftSessionWriteAction =
  (typeof CRAFT_SESSION_WRITE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// 命名与隔离：纯函数（AC2 的键半边，MT047 同纪律）
// ---------------------------------------------------------------------------

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const plainId = (value: string, field: string): string => {
  if (!PLAIN_ID.test(value)) {
    throw new Error(`${CRAFT_SESSION_ID_INVALID}: ${field}`);
  }
  return value;
};

/**
 * 企业面的快照对象键（AC2「按归属存储」的命名半边）：四段全是校验过的
 * plain id——一个 scope 永远命名不出另一个 scope 的键。
 */
export function craftSnapshotObjectKey(
  tenantId: string,
  workspaceId: string,
  sessionId: string,
  snapshotId: string,
): string {
  return [
    "craft-snapshots",
    plainId(tenantId, "tenantId"),
    plainId(workspaceId, "workspaceId"),
    plainId(sessionId, "sessionId"),
    `${plainId(snapshotId, "snapshotId")}.tar.gz`,
  ].join("/");
}

/** 从一条企业面快照键解析归属；形状不符或含非 plain id 段 = null。 */
export function parseCraftSnapshotObjectKey(key: string): {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly snapshotId: string;
} | null {
  const segments = key.split("/");
  if (segments.length !== 5 || segments[0] !== "craft-snapshots") return null;
  const [_literal, tenantId, workspaceId, sessionId, file] = segments;
  const snapshotId = file.endsWith(".tar.gz")
    ? file.slice(0, -".tar.gz".length)
    : "";
  if (
    !PLAIN_ID.test(tenantId) ||
    !PLAIN_ID.test(workspaceId) ||
    !PLAIN_ID.test(sessionId) ||
    !PLAIN_ID.test(snapshotId)
  ) {
    return null;
  }
  return { tenantId, workspaceId, sessionId, snapshotId };
}

// ---------------------------------------------------------------------------
// 行缝：既有 craft 权威 store 的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。会话/消息/快照行的全部语义（状态矩阵、
 * transcript 顺序、cascade）归既有 craft/store.ts 权威，本模块零复刻、
 * 只做范围门后的委托（MT060 rows 缝同款）。
 */
export type CraftSessionsRows = {
  /** 属主自检读（pin 的「本人创建的行」守卫）。 */
  findSession(
    sessionId: string,
    userId: string,
  ): Promise<CraftSessionRow | undefined>;
  /** 无属主检查的行读（范围门认证后属主从行取——store 自有纪律）。 */
  findSessionById(sessionId: string): Promise<CraftSessionRow | undefined>;
  /**
   * 按页内协会行点名的权威行批量读（列表 join 面）。不沿
   * listUserSessions 的最新-100 便利窗——那是个人侧边栏的分页，不是
   * 企业列表的 join 契约：协会行收窄过的页里每一行都必须可达。
   */
  findSessionsByIds(
    sessionIds: readonly string[],
  ): Promise<readonly CraftSessionRow[]>;
  updateSession(
    sessionId: string,
    patch: {
      name?: string | null;
      sharingScope?: "private" | "public_org";
      status?: "initializing" | "active" | "idle" | "failed";
    },
  ): Promise<CraftSessionRow | undefined>;
  deleteSession(sessionId: string, userId: string): Promise<boolean>;
  getMessages(sessionId: string): Promise<readonly CraftMessageRow[]>;
  listSnapshots(sessionId: string): Promise<readonly CraftSnapshotRow[]>;
};

/** 对象存储的最小投影（AC2 下载授权后的字节来源）。 */
export interface CraftSnapshotObjectStore {
  get(key: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

/** 一条归属协会行的投影（零内容，纯归属事实）。 */
export interface CraftSessionScopeView {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

export type CraftSessionPinResult =
  | { readonly status: "pinned"; readonly ownership: CraftSessionScopeView }
  | { readonly status: "existing"; readonly ownership: CraftSessionScopeView };

/** 详情读（AC1）：属主或团队公共矩阵的成员。 */
export type CraftSessionReadOutcome =
  | {
      readonly outcome: "allow";
      readonly via: "owner" | "team-public";
      readonly session: CraftSessionRow;
      readonly messages: readonly CraftMessageRow[];
    }
  | ResourceNotFoundVerdict;

/** 写动作（AC3）：属主放行；非属主成员 forbidden；外部人不可见。 */
export type CraftSessionWriteOutcome =
  | {
      readonly outcome: "allow";
      readonly action: CraftSessionWriteAction;
      readonly session: CraftSessionRow;
    }
  | {
      readonly outcome: "forbidden";
      readonly code: typeof CRAFT_TEAM_PUBLIC_ACTION_FORBIDDEN;
    }
  | ResourceNotFoundVerdict;

export type CraftSnapshotDownloadOutcome =
  | {
      readonly outcome: "allow";
      readonly via: "owner" | "team-public";
      readonly snapshot: CraftSnapshotRow;
      readonly bytes: Uint8Array;
      readonly enterpriseKey: string;
    }
  | ResourceNotFoundVerdict;

export interface CraftSessionsService {
  /** 创建接线时的归属固定（create-once；mismatch 响亮拒绝）。 */
  pinCraftSession(
    scope: PlatformScope,
    input: { readonly sessionId: string },
  ): Promise<CraftSessionPinResult | ResourceNotFoundVerdict>;

  /**
   * 范围化列表（AC1）：只返回 (tenant, workspace, principal) 三元组下本人
   * 的会话；公司级撤销响亮拒绝（SCOPE_REVOKED）。keyset 稳定序
   * (created_at DESC, session_id DESC)。
   */
  listSessions(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly sessions: readonly {
      readonly sessionId: string;
      readonly name: string | null;
      readonly status: CraftSessionRow["status"];
      readonly sharingScope: CraftSessionRow["sharingScope"];
      readonly createdAt: Date;
      readonly lastActivityAt: Date;
    }[];
    readonly nextCursor?: string;
  }>;

  /** 范围化详情（AC1，含 turn/消息 transcript）：不可见 = canonical。 */
  readSession(
    scope: PlatformScope,
    sessionId: string,
  ): Promise<CraftSessionReadOutcome>;

  /** 写动作（AC3 矩阵）：rename/share/archive/delete；range 外输入响亮拒绝。 */
  writeSession(
    scope: PlatformScope,
    input: {
      readonly sessionId: string;
      readonly action: CraftSessionWriteAction;
      readonly patch?: {
        readonly name?: string | null;
        readonly sharingScope?: "private" | "public_org";
        readonly status?: "initializing" | "active" | "idle" | "failed";
      };
    },
  ): Promise<CraftSessionWriteOutcome>;

  /** 快照列表（AC2）：经范围门（属主或成员）后的权威行。 */
  listSnapshots(
    scope: PlatformScope,
    sessionId: string,
  ): Promise<
    | {
        readonly outcome: "allow";
        readonly snapshots: readonly CraftSnapshotRow[];
      }
    | ResourceNotFoundVerdict
  >;

  /** 快照下载授权（AC2）：范围门 → 权威行 → 注入 objectStore。 */
  downloadSnapshot(
    scope: PlatformScope,
    input: { readonly sessionId: string; readonly snapshotId: string },
  ): Promise<CraftSnapshotDownloadOutcome>;
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

/** 归属写的作用域限定 advisory 锁键（同三元组串行，跨三元组互不等待）。 */
export function scopeCraftSessionLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise-craft-sessions",
    "scope",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

/** 单会话控制序列化锁键（写 CAS 前的排他点）。 */
function sessionControlLockKey(sessionId: string): string {
  return JSON.stringify(["enterprise-craft-sessions", "session", sessionId]);
}

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

export function createCraftSessionsService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: CraftSessionsRows;
  readonly objectStore: CraftSnapshotObjectStore;
}): CraftSessionsService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);
  const { data, operator, rows, objectStore } = deps;

  /** 事务开场（MT016/MT022/MT060 判定入口同一形状）。 */
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

  /** 事务内成员事实重验（MT021/MT022 同款切片）。 */
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
    row: typeof enterpriseCraftScopes.$inferSelect,
  ): CraftSessionScopeView => ({
    sessionId: row.sessionId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  });

  /**
   * 对象级范围门（AC1 的唯一判定入口）：协会行经真实 RLS（租户臂 +
   * restrictive 主体自读臂）+ 事务内成员事实重验 + 三元组比对。任何不
   * 成立 = null（不可见）——撤销也折叠进不可见，零存在泄漏。
   */
  const authorizeSession = async (
    scope: PlatformScope,
    sessionId: string,
  ): Promise<CraftSessionScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(enterpriseCraftScopes)
        .where(eq(enterpriseCraftScopes.sessionId, sessionId))
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
   * 团队公共门（AC3 的成员半边）：同团队活跃成员 + 归属行（workspace 读
   * 臂）+ 会话行 sharing_scope='public_org'。非成员/撤权/非公共 → null
   * （不可见）；成员但非公共 → null（私有会话对成员同样不可见——列表与
   * 详情都拿不到存在性）。
   */
  const authorizeTeamPublic = async (
    scope: PlatformScope,
    sessionId: string,
  ): Promise<{ readonly session: CraftSessionRow } | null> =>
    operator.transaction(async (tx) => {
      await beginContext(tx, scope);
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
      if (
        company?.status !== "active" ||
        company?.epoch !== scope.memberEpoch ||
        team?.status !== "active"
      ) {
        return null;
      }
      const [row] = await tx
        .select({ sessionId: enterpriseCraftScopes.sessionId })
        .from(enterpriseCraftScopes)
        .where(
          and(
            eq(enterpriseCraftScopes.sessionId, sessionId),
            eq(enterpriseCraftScopes.tenantId, scope.tenantId),
            eq(enterpriseCraftScopes.workspaceId, scope.workspaceId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const session = await rows.findSessionById(sessionId);
      if (session?.sharingScope !== "public_org") return null;
      return { session };
    });

  return {
    async pinCraftSession(scope, input) {
      assertTrustedScope(scope);
      const sessionId = plainId(input.sessionId, "sessionId");
      // 本人创建的行守卫：他人会话/不存在不可区分（canonical not-found）。
      const own = await rows.findSession(sessionId, scope.actorId);
      if (!own) return DENY_VERDICT;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return DENY_VERDICT;
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${scopeCraftSessionLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          )}, 0))`,
        );
        const [inserted] = await tx
          .insert(enterpriseCraftScopes)
          .values({
            sessionId,
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
          .from(enterpriseCraftScopes)
          .where(eq(enterpriseCraftScopes.sessionId, sessionId))
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
        throw new Error(CRAFT_SESSION_SCOPE_MISMATCH);
      });
    },

    async listSessions(scope, page) {
      assertTrustedScope(scope);
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: limit`);
      }
      // 成员事实在 data 事务内现读（MT041 成员视图同纪律：公司级撤销对
      // 列面响亮，不折叠为空页——空页与「没有会话」不可区分的要求只适用
      // 于对象面）。
      const memberOk = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        return facts.companyActive && facts.teamActive;
      });
      if (!memberOk) throw new Error(CRAFT_SESSION_SCOPE_REVOKED);
      const scopeRows = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conditions = [
          eq(enterpriseCraftScopes.tenantId, scope.tenantId),
          eq(enterpriseCraftScopes.workspaceId, scope.workspaceId),
          eq(enterpriseCraftScopes.principalId, scope.principalId),
        ];
        if (page.cursor !== undefined) {
          const parsed = new Date(String(page.cursor));
          if (Number.isNaN(parsed.getTime())) {
            throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: cursor`);
          }
          conditions.push(lt(enterpriseCraftScopes.createdAt, parsed));
        }
        return tx
          .select({
            sessionId: enterpriseCraftScopes.sessionId,
            createdAt: enterpriseCraftScopes.createdAt,
          })
          .from(enterpriseCraftScopes)
          .where(and(...conditions))
          .orderBy(desc(enterpriseCraftScopes.createdAt))
          .limit(page.limit + 1);
      });
      const pageRows = scopeRows.slice(0, page.limit);
      const authoritative = await rows.findSessionsByIds(
        pageRows.map((scopeRow) => scopeRow.sessionId),
      );
      const authoritativeById = new Map(
        authoritative.map((row) => [row.id, row]),
      );
      const sessions = pageRows.flatMap((scopeRow) => {
        const session = authoritativeById.get(scopeRow.sessionId);
        // 权威行已删除 = 不可见（既有语义）。origin 过滤与
        // store.listUserSessions 同语义对齐：非交互起源不出现在 craft
        // 列表面（join 不放宽也不收紧）。
        if (session?.origin !== "INTERACTIVE") return [];
        return [
          {
            sessionId: session.id,
            name: session.name,
            status: session.status,
            sharingScope: session.sharingScope,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
          },
        ];
      });
      return {
        sessions,
        ...(scopeRows.length > page.limit
          ? {
              nextCursor:
                pageRows[pageRows.length - 1]?.createdAt.toISOString(),
            }
          : {}),
      };
    },

    async readSession(scope, sessionId) {
      assertTrustedScope(scope);
      plainId(sessionId, "sessionId");
      const ownership = await authorizeSession(scope, sessionId);
      if (ownership !== null) {
        const session = await rows.findSessionById(sessionId);
        if (!session) return DENY_VERDICT;
        return {
          outcome: "allow" as const,
          via: "owner" as const,
          session,
          messages: await rows.getMessages(sessionId),
        };
      }
      const memberView = await authorizeTeamPublic(scope, sessionId);
      if (memberView !== null) {
        return {
          outcome: "allow" as const,
          via: "team-public" as const,
          session: memberView.session,
          messages: await rows.getMessages(sessionId),
        };
      }
      return DENY_VERDICT;
    },

    async writeSession(scope, input) {
      assertTrustedScope(scope);
      const sessionId = plainId(input.sessionId, "sessionId");
      if (
        !CRAFT_SESSION_WRITE_ACTIONS.includes(
          input.action as CraftSessionWriteAction,
        )
      ) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: action`);
      }
      if (input.action === "rename" && input.patch?.name === undefined) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: patch.name`);
      }
      if (input.action === "share" && input.patch?.sharingScope === undefined) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: patch.sharingScope`);
      }
      // 运行时闭集校验：TS 类型挡不住 JS 调用方，脏 sharingScope/status
      // 会经 updateSession 直达权威行（sharingScope 是团队公共可见性判据）。
      if (
        input.patch?.sharingScope !== undefined &&
        !["private", "public_org"].includes(input.patch.sharingScope)
      ) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: patch.sharingScope`);
      }
      if (
        input.patch?.status !== undefined &&
        !["initializing", "active", "idle", "failed"].includes(
          input.patch.status,
        )
      ) {
        throw new Error(`${CRAFT_SESSION_INPUT_INVALID}: patch.status`);
      }
      const ownership = await authorizeSession(scope, sessionId);
      if (ownership === null) {
        // 非属主但同团队活跃成员、会话公共 → forbidden（不是不可见——
        // 成员本可见该资源，MT009 管理动作拒绝同形）。
        const memberView = await authorizeTeamPublic(scope, sessionId);
        if (memberView !== null) {
          return {
            outcome: "forbidden" as const,
            code: CRAFT_TEAM_PUBLIC_ACTION_FORBIDDEN,
          };
        }
        return DENY_VERDICT;
      }
      // 控制序列化锁：同会话的写 CAS 串行。
      await operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${sessionControlLockKey(sessionId)}, 0))`,
        );
      });
      if (input.action === "delete") {
        // 删除前的权威行是结果的一部分（删除后行已不可读）。
        const before = await rows.findSessionById(sessionId);
        const deleted = await rows.deleteSession(sessionId, scope.actorId);
        if (!deleted || !before) return DENY_VERDICT;
        return {
          outcome: "allow" as const,
          action: input.action,
          session: before,
        };
      }
      const updated = await rows.updateSession(sessionId, {
        ...(input.patch?.name !== undefined ? { name: input.patch.name } : {}),
        ...(input.patch?.sharingScope !== undefined
          ? { sharingScope: input.patch.sharingScope }
          : {}),
        ...(input.patch?.status !== undefined
          ? { status: input.patch.status }
          : {}),
      });
      if (!updated) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        action: input.action,
        session: updated,
      };
    },

    async listSnapshots(scope, sessionId) {
      assertTrustedScope(scope);
      plainId(sessionId, "sessionId");
      const ownership = await authorizeSession(scope, sessionId);
      if (ownership === null) {
        const memberView = await authorizeTeamPublic(scope, sessionId);
        if (memberView === null) return DENY_VERDICT;
      }
      const session = await rows.findSessionById(sessionId);
      if (!session) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        snapshots: await rows.listSnapshots(sessionId),
      };
    },

    async downloadSnapshot(scope, input) {
      assertTrustedScope(scope);
      const sessionId = plainId(input.sessionId, "sessionId");
      plainId(input.snapshotId, "snapshotId");
      const ownership = await authorizeSession(scope, sessionId);
      let via: "owner" | "team-public";
      if (ownership !== null) {
        via = "owner";
      } else {
        const memberView = await authorizeTeamPublic(scope, sessionId);
        if (memberView === null) return DENY_VERDICT;
        via = "team-public";
      }
      const session = await rows.findSessionById(sessionId);
      if (!session) return DENY_VERDICT;
      const snapshot = (await rows.listSnapshots(sessionId)).find(
        (candidate) => candidate.id === input.snapshotId,
      );
      if (!snapshot) return DENY_VERDICT;
      // 下载授权（AC2）：路径来自权威行，调用方输入里没有路径；字节经注入
      // objectStore。企业面键派生一并返回（存储命名半边的证据面）。
      const bytes = await objectStore.get(snapshot.storagePath);
      return {
        outcome: "allow" as const,
        via,
        snapshot,
        bytes,
        enterpriseKey: craftSnapshotObjectKey(
          scope.tenantId,
          scope.workspaceId,
          sessionId,
          input.snapshotId,
        ),
      };
    },
  };
}
