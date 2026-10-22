// server/src/enterprise/tenancy/openmuse-personal-tenancy.ts
// MT062（Issue #105）：OpenMuse 目标、想法、记忆与财务产物的作用域。
//
// 票面语义（brief + Issue #105）：
//   AC1 个人域对象只对本人在当前范围可见；同团队他人不可读取——协会行
//      三元组（租户臂 RLS + restrictive 主体自读）先于一切根行读写；一切
//      不可见 = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形；列表不泄露
//      存在性（他人视角 = 永远空页）。
//   AC2 财务产物（含导出与附件）遵守账务可见性规则（与 MT073 一致）——
//      finance_artifact 的读取面在归属匹配之外按 MT073 判定门放行：
//      本人当前范围（协会行三元组）直读；同公司**显式授权**的公司财务
//      读者（assertCompanyFinanceReader——活跃成员 ∧ 授权行，缺一即同形
//      拒绝）可读；其余（无授权管理员、跨公司、同团队他人）= canonical
//      not-found（MT073 的单一 deny 形状纪律）。
//   AC3 既有精确动作提案/确认/取消行为回归通过——本模块零改动既有
//      openmuse-reviewed-actions 面（纯新增）；回归由既有套件钉死。
//   AC4 删除与恢复只影响本范围对象——scopedDelete/scopedRestore 的协会
//      门先于根行写：跨范围 id 对象面不可见（{outcome:"missing"} 零副作
//      用），恢复只复活本范围对象。
//
// 结构（纯新增，消费 MT005/MT011 既有出口与既有 openmuse-personal 权威
// store——归属协会表 openmuse_personal_scopes 是本模块的唯一新持久化
// 对象；根行存在性与 owner 一致性由 rows 缝在 pin 前核死）：
//
//   1. 归属（pinPersonalObject）：创建接线时固定 (公司, 囪队, 主体, 用户)
//      归属——create-once；同三元组幂等 existing；不同选择标识一律
//      OPENMUSE_PERSONAL_SCOPE_MISMATCH 响亮拒绝且已存行不动；缺有效成员
//      事实 WORKSPACE_MEMBERSHIP_REQUIRED（响亮创建门）。
//   2. 范围化读取（listPersonalObjects/readPersonalObject）：受限 data
//      通道 + 事务本地上下文 + 真实 RLS → 事务内公司（active + epoch）与
//      团队（active）事实重验 → 协会行三元组比对 → 委托既有 rows 缝读根
//      行。公司级撤销在列表面响亮拒绝（SCOPE_REVOKED）；团队级撤销 =
//      空页；对象面一律不可见。
//   3. 财务产物（readFinanceArtifact，AC2）：先协会门（归属三元组），后
//      MT073 判定门（公司财务读者）；两门都不开 = canonical not-found。
//      财务读者门只放行**同公司**（协会行 tenant 匹配）——跨公司授权不
//      存在（MT073 复合外键钉死），跨公司读者对本对象结构性不可见。
//   4. 删除与恢复（scopedDelete/scopedRestore，AC4）：协会门先于根行
//      tombstone/revive；不可见 = {outcome:"missing"} 且零根行副作用；
//      恢复只作用于本范围协会行钉住的对象。
//
// 事务纪律与 MT060/MT061 完全一致：assertTrustedScope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership → workspace-membership；
// 读共享、写排他）→ 成员事实重验 → 判定或执行。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：服务面供下游接线票复用（MT060 同例）。
//   - 协会表对三类根表（goals/ideas/memories）与 openmuse_files（财务产物
//     载体）无跨表外键（object_id 命名空间按 object_type 区分）；根行存在
//     性由 rows 缝核死，孤儿协会行由 MT117 回填/清理面处置。
//   - AC3 回归不在本模块：既有 reviewed-actions 行为零改动，回归证据 =
//     既有套件通过（见报告）。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  OPENMUSE_PERSONAL_OBJECT_TYPES,
  type OpenMusePersonalObjectType,
  type OpenMusePersonalScopeRow,
  openmusePersonalScopes,
} from "../../db/schema/openmuse-personal-tenancy";
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
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：一个个人域对象的 (公司, 团队, 主体, 用户, 来源) 事实。 */
export interface OpenMusePersonalScopeView {
  readonly objectType: OpenMusePersonalObjectType;
  readonly objectId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly attribution: "created" | "import";
  readonly createdAt: Date;
}

/** 根行投影：rows 缝返回的存储形状（goal/idea/memory/文件行的最小面）。 */
export interface PersonalObjectRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  /** 根行的其余事实（标题/内容等），调用方按对象类型收窄。 */
  readonly snapshot: Readonly<Record<string, unknown>>;
}

/** 范围化列表条目：根行投影 + 归属事实。 */
export interface ScopedOpenMusePersonalObject {
  readonly ownership: OpenMusePersonalScopeView;
  readonly record: PersonalObjectRecord;
}

/** 单对象读取判定：allow 携带归属与根行；一切不可见 = canonical not-found。 */
export type PersonalReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMusePersonalScopeView;
      readonly record: PersonalObjectRecord;
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type PersonalScopePinResult =
  | {
      readonly status: "pinned";
      readonly ownership: OpenMusePersonalScopeView;
    }
  | {
      readonly status: "existing";
      readonly ownership: OpenMusePersonalScopeView;
    }
  | ResourceNotFoundVerdict;

/** AC2 财务产物读取的放行通道（audit 面）：本人范围 or 公司财务读者。 */
export type FinanceArtifactReadOutcome =
  | {
      readonly outcome: "allow";
      readonly via: "owner-scope" | "company-finance-reader";
      readonly ownership: OpenMusePersonalScopeView;
      readonly record: PersonalObjectRecord;
    }
  | ResourceNotFoundVerdict;

/** AC4 删除/恢复结局：不可见 = missing 且零根行副作用。 */
export type ScopedLifecycleOutcome =
  | { readonly outcome: "missing" }
  | { readonly outcome: "deleted"; readonly record: PersonalObjectRecord }
  | { readonly outcome: "restored"; readonly record: PersonalObjectRecord };

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_PERSONAL_SCOPE_INVALID =
  "OPENMUSE_PERSONAL_SCOPE_INVALID";
export const OPENMUSE_PERSONAL_SCOPE_MISMATCH =
  "OPENMUSE_PERSONAL_SCOPE_MISMATCH";
export const OPENMUSE_PERSONAL_CURSOR_INVALID =
  "OPENMUSE_PERSONAL_CURSOR_INVALID";
export const OPENMUSE_PERSONAL_TYPE_INVALID = "OPENMUSE_PERSONAL_TYPE_INVALID";
/** 创建响亮门（MT059/MT016/MT060 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_PERSONAL_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_PERSONAL_SCOPE_INVALID}: ${rule}`);
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

function requireObjectType(value: unknown): OpenMusePersonalObjectType {
  if (
    typeof value !== "string" ||
    !OPENMUSE_PERSONAL_OBJECT_TYPES.includes(
      value as OpenMusePersonalObjectType,
    )
  ) {
    throw new Error(
      `${OPENMUSE_PERSONAL_TYPE_INVALID}: objectType must be one of ${OPENMUSE_PERSONAL_OBJECT_TYPES.join("|")}`,
    );
  }
  return value as OpenMusePersonalObjectType;
}

/** 列表页大小：1..100。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 行缝：既有 openmuse-personal 权威 store 的最小投影 + 批量/生命周期面
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。create/patch 等语义全部归既有
 * openmuse-personal/{goals,ideas,memories}.ts 权威，本模块零复刻、只做
 * 范围门后的委托。tombstone/revive 是 AC4 的生命周期面（既有 rows 缝只有
 * tombstone；revive 由装配在 drizzle rows 上补——生产 wiring 票的接线点，
 * 测试夹具在本面之上实现，见边界披露）。
 */
export type OpenMusePersonalTenancyRows = {
  /** owner 的一个活根行（tombstoned/外来 = null）。 */
  findOwnedObject(
    ownerUserId: string,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<PersonalObjectRecord | null>;
  /** owner 的一个根行（含 tombstoned——恢复面的读取半边）。 */
  findOwnedObjectIncludingTombstoned(
    ownerUserId: string,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<PersonalObjectRecord | null>;
  /** 范围化列表的批量取行面（一查 inArray——MT060 listTasksByIds 同例）。 */
  listOwnedObjectsByIds(
    ownerUserId: string,
    objectType: OpenMusePersonalObjectType,
    objectIds: readonly string[],
  ): Promise<readonly PersonalObjectRecord[]>;
  /** AC4 删除半边：owner 检查的软删（tombstone）。 */
  tombstoneOwnedObject(
    ownerUserId: string,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<PersonalObjectRecord | null>;
  /** AC4 恢复半边：清 deleted_at（既有 rows 缝由装配补齐的面）。 */
  reviveOwnedObject(
    ownerUserId: string,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<PersonalObjectRecord | null>;
};

/**
 * MT073 判定门的消费面（AC2「与 MT073 一致」）：注入真实
 * CompanyFinanceVisibilityService.assertCompanyFinanceReader——本模块不
 * 复刻授权规则，拒绝形状（COMPANY_FINANCE_REQUIRED 哨兵）也归它。
 */
export interface CompanyFinanceReaderGate {
  assertCompanyFinanceReader(input: {
    readonly tenantId: string;
    readonly principalId: string;
  }): Promise<unknown>;
  /**
   * 财务产物的归属三元组事实（object_type='finance_artifact' 的协会行），
   * 经 MT073 域自己的通道（主通道）读取——与 assertCompanyFinanceReader
   * 读授权行/成员行同一通道纪律。data 通道的 restrictive 主体自读臂会
   * 对他人行不可见，那是归属判定面的纪律；账务可见性是公司级事实，走
   * 账务域的通道。
   */
  lookupFinanceArtifactOwnership(objectId: string): Promise<{
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly userId: string;
  } | null>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenMusePersonalTenancyService {
  /**
   * 创建接线时的归属固定（AC1 写半边）。外来对象（根行不存在/非本人）=
   * canonical not-found；同三元组重放幂等 existing；不同选择标识一律
   * OPENMUSE_PERSONAL_SCOPE_MISMATCH 响亮拒绝且已存归属不动。
   */
  pinPersonalObject(
    scope: PlatformScope,
    input: {
      readonly objectType: OpenMusePersonalObjectType;
      readonly objectId: string;
      readonly attribution?: "created" | "import";
    },
  ): Promise<PersonalScopePinResult>;

  /**
   * 范围化列表（AC1）：只返回 (tenant, workspace, principal) 三元组下本人
   * 的对象；公司级撤销响亮拒绝（SCOPE_REVOKED）；团队级撤销 = 空页；同
   * 团队他人视角 = 空页（零泄漏）。分页 keyset 稳定序 (created_at DESC,
   * object_id DESC)。
   */
  listPersonalObjects(
    scope: PlatformScope,
    objectType: OpenMusePersonalObjectType,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly objects: readonly ScopedOpenMusePersonalObject[];
    readonly nextCursor?: string;
  }>;

  /** 范围化读取（AC1）：不可见 = canonical not-found。 */
  readPersonalObject(
    scope: PlatformScope,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<PersonalReadOutcome>;

  /**
   * AC2 财务产物读取：归属三元组直读（owner-scope）或同公司 MT073 财务
   * 读者（company-finance-reader）；其余 = canonical not-found。拒绝路径
   * 零根行读取（不泄露存在性）。
   */
  readFinanceArtifact(
    scope: PlatformScope,
    objectId: string,
  ): Promise<FinanceArtifactReadOutcome>;

  /**
   * AC4 删除半边：协会门先于根行 tombstone——跨范围 id =
   * {outcome:"missing"} 且零根行副作用。
   */
  scopedDelete(
    scope: PlatformScope,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<ScopedLifecycleOutcome>;

  /**
   * AC4 恢复半边：协会门先于根行 revive——只复活本范围协会行钉住的对
   * 象；跨范围（含同账号另一公司）= {outcome:"missing"} 零副作用。
   */
  scopedRestore(
    scope: PlatformScope,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<ScopedLifecycleOutcome>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMusePersonalTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: OpenMusePersonalTenancyRows;
  /** MT073 判定门（AC2，真实服务注入——本模块零复刻规则）。 */
  readonly financeReaders: CompanyFinanceReaderGate;
}): OpenMusePersonalTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows, financeReaders } = deps;

  /** 事务开场（MT060/MT061 判定入口同一形状）。 */
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

  /** 事务内成员事实重验（公司 active + epoch；团队 active）。 */
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
   * 对象级范围门（AC1 唯一判定入口）：协会行经真实 RLS + 事务内成员事实
   * 重验 + 三元组比对。任何不成立 = null（不可见，零存在泄漏）。
   */
  const authorizeObject = async (
    scope: PlatformScope,
    objectType: OpenMusePersonalObjectType,
    objectId: string,
  ): Promise<OpenMusePersonalScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmusePersonalScopes)
        .where(
          and(
            eq(openmusePersonalScopes.objectType, objectType),
            eq(openmusePersonalScopes.objectId, objectId),
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

  return {
    async pinPersonalObject(scope, input) {
      assertTrustedScope(scope);
      const objectType = requireObjectType(input.objectType);
      const objectId = requireId(input.objectId, "objectId");
      const attribution =
        input.attribution === undefined ? "created" : input.attribution;
      // 外来对象（根行不存在/非本人）与不存在不可区分。
      const owned = await rows.findOwnedObject(
        scope.actorId,
        objectType,
        objectId,
      );
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_PERSONAL_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(openmusePersonalScopes)
          .values({
            objectType,
            objectId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
            attribution,
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
          .from(openmusePersonalScopes)
          .where(
            and(
              eq(openmusePersonalScopes.objectType, objectType),
              eq(openmusePersonalScopes.objectId, objectId),
            ),
          )
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_PERSONAL_SCOPE_MISMATCH}: object is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: scopeViewOf(existing),
        };
      });
    },

    async listPersonalObjects(scope, objectTypeRaw, page) {
      assertTrustedScope(scope);
      const objectType = requireObjectType(objectTypeRaw);
      if (
        typeof page?.limit !== "number" ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > LIST_LIMIT_MAX
      ) {
        failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
      }
      let cursor: { createdAt: Date; objectId: string } | undefined;
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor);
        if (!decoded) throw new Error(OPENMUSE_PERSONAL_CURSOR_INVALID);
        cursor = decoded;
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { objects: [] as ScopedOpenMusePersonalObject[] };
        }
        const associationRows = await tx
          .select()
          .from(openmusePersonalScopes)
          .where(
            and(
              eq(openmusePersonalScopes.tenantId, scope.tenantId),
              eq(openmusePersonalScopes.workspaceId, scope.workspaceId),
              eq(openmusePersonalScopes.principalId, scope.principalId),
              eq(openmusePersonalScopes.objectType, objectType),
              ...(cursor
                ? [
                    sql`(${openmusePersonalScopes.createdAt}, ${openmusePersonalScopes.objectId}) < (${cursor.createdAt}, ${cursor.objectId})`,
                  ]
                : []),
            ),
          )
          .orderBy(
            sql`${openmusePersonalScopes.createdAt} DESC, ${openmusePersonalScopes.objectId} DESC`,
          )
          .limit(page.limit + 1);
        const hasMore = associationRows.length > page.limit;
        const visible = associationRows.slice(0, page.limit);
        if (visible.length === 0) {
          return { objects: [] as ScopedOpenMusePersonalObject[] };
        }
        const records = await rows.listOwnedObjectsByIds(
          scope.actorId,
          objectType,
          visible.map((row) => row.objectId),
        );
        const recordById = new Map(
          records.map((record) => [record.id, record]),
        );
        const objects: ScopedOpenMusePersonalObject[] = [];
        for (const row of visible) {
          const record = recordById.get(row.objectId);
          // 根行在两次读取之间被删除/tombstone：条目消失，不泄露存在性。
          if (!record) continue;
          objects.push({ ownership: scopeViewOf(row), record });
        }
        const last = visible[visible.length - 1];
        return {
          objects,
          ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
        };
      });
    },

    async readPersonalObject(scope, objectTypeRaw, objectId) {
      assertTrustedScope(scope);
      const objectType = requireObjectType(objectTypeRaw);
      const id = requireId(objectId, "objectId");
      const ownership = await authorizeObject(scope, objectType, id);
      if (!ownership) return notFoundVerdict();
      const record = await rows.findOwnedObject(
        ownership.userId,
        objectType,
        id,
      );
      if (!record) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, record };
    },

    async readFinanceArtifact(scope, objectId) {
      assertTrustedScope(scope);
      const id = requireId(objectId, "objectId");
      // 第一道门（归属三元组）：本人当前范围直读。
      const ownership = await authorizeObject(scope, "finance_artifact", id);
      if (ownership) {
        const record = await rows.findOwnedObject(
          ownership.userId,
          "finance_artifact",
          id,
        );
        if (record) {
          return {
            outcome: "allow" as const,
            via: "owner-scope" as const,
            ownership,
            record,
          };
        }
        // 归属行在而根行不在（已删）：继续走读者门只会更拒绝——统一
        // not-found（零存在性回显）。
      }
      // 第二道门（MT073 判定门）：同公司显式授权的公司财务读者。判定门
      // 先行（拒绝路径零归属/根行读取）；门后只放行**同公司**的财务产物
      // ——归属事实经 MT073 域自己的通道读取（见接口注释）。跨公司授权行
      // 不存在（MT073 复合外键钉死），跨公司读者对本对象结构性不可见。
      try {
        await financeReaders.assertCompanyFinanceReader({
          tenantId: scope.tenantId,
          principalId: scope.principalId,
        });
      } catch {
        return notFoundVerdict();
      }
      const readerOwned =
        await financeReaders.lookupFinanceArtifactOwnership(id);
      if (!readerOwned || readerOwned.tenantId !== scope.tenantId) {
        return notFoundVerdict();
      }
      const record = await rows.findOwnedObject(
        readerOwned.userId,
        "finance_artifact",
        id,
      );
      if (!record) return notFoundVerdict();
      return {
        outcome: "allow" as const,
        via: "company-finance-reader" as const,
        ownership: {
          objectType: "finance_artifact",
          objectId: id,
          tenantId: readerOwned.tenantId,
          workspaceId: readerOwned.workspaceId,
          principalId: readerOwned.principalId,
          userId: readerOwned.userId,
          attribution: "created" as const,
          createdAt: record.createdAt,
        },
        record,
      };
    },

    async scopedDelete(scope, objectTypeRaw, objectId) {
      assertTrustedScope(scope);
      const objectType = requireObjectType(objectTypeRaw);
      const id = requireId(objectId, "objectId");
      const ownership = await authorizeObject(scope, objectType, id);
      if (!ownership) return { outcome: "missing" as const };
      const tombstoned = await rows.tombstoneOwnedObject(
        ownership.userId,
        objectType,
        id,
      );
      if (!tombstoned) return { outcome: "missing" as const };
      return { outcome: "deleted" as const, record: tombstoned };
    },

    async scopedRestore(scope, objectTypeRaw, objectId) {
      assertTrustedScope(scope);
      const objectType = requireObjectType(objectTypeRaw);
      const id = requireId(objectId, "objectId");
      const ownership = await authorizeObject(scope, objectType, id);
      if (!ownership) return { outcome: "missing" as const };
      const revived = await rows.reviveOwnedObject(
        ownership.userId,
        objectType,
        id,
      );
      if (!revived) return { outcome: "missing" as const };
      return { outcome: "restored" as const, record: revived };
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射与游标（模块底部小件）
// ---------------------------------------------------------------------------

function scopeViewOf(row: OpenMusePersonalScopeRow): OpenMusePersonalScopeView {
  return {
    objectType: row.objectType as OpenMusePersonalObjectType,
    objectId: row.objectId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    attribution: row.attribution === "import" ? "import" : "created",
    createdAt: row.createdAt,
  };
}

const encodeCursor = (row: OpenMusePersonalScopeRow): string =>
  Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.objectId }),
    "utf8",
  ).toString("base64");

function decodeCursor(
  raw: string,
): { createdAt: Date; objectId: string } | null {
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
    return { createdAt, objectId: parsed.i };
  } catch {
    return null;
  }
}
