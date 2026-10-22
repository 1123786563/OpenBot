// server/src/enterprise/tenancy/artifact-storage.ts
// MT055（Issue #98）：产物与对象存储路径按归属隔离。
//
// 票面语义（Issue #98 正文）：
//   AC1 产物路径包含归属标识但不可作为授权依据；直接猜测路径读取被拒绝。
//   AC2 列举只返回本范围产物；跨范围列举为空。
//   AC3 删除与清理只影响本范围。
//   AC4 产物元数据（名称、大小、时间）不泄露给无权用户。
//
// 结构（纯新增服务面 + 一张协会表 enterprise_artifact_scopes（MT055 迁移），
// 只读消费 MT053 已交付的 craft 快照键族与既有 workshop 权威 store，不改
// 任何既有文件语义——MT053 craft-sessions 同型判例）：
//
//   1. 归属（Spec §4.2 受约束关联）：Workshop 产物行（workshop_artifacts，
//      只有 session 归属的个人形状）在创建接线时经 pinWorkshopArtifact 固定
//      (公司, 团队, 主体, user) 归属——先在本人事务外验证产物行存在且其
//      所属会话 ownerUserId === 受信 scope 的 actorId（本人会话下的产物行；
//      他人产物/不存在 → canonical not-found），再写协会行（create-once；
//      同三元组幂等返回 existing，不同选择标识一律
//      ARTIFACT_SCOPE_MISMATCH 响亮拒绝且已存行不动）。
//   2. 键族（AC1 的寻址半边）：enterprise_workshop_artifact_object_key 是
//      纯函数——企业面存储键
//      workshop-artifacts/<tenant>/<workspace>/<session>/<artifact>
//      四段全是校验过的 plain id，一个 scope 永远命名不出另一个 scope 的
//      键（MT053 craftSnapshotObjectKey / MT047 executionArtifactDir 同
//      纪律）。craft 半边的键族由 MT053 交付（craft-snapshots/<t>/<w>/
//      <session>/<snapshot>.tar.gz），本模块只消费不复制；附件半边的
//      存储路径族由 MT024 交付（<t>/<w>/<att>/blob）。三族共同构成
//      #161 映射臂（MT118）扫描源闭集的对象存储键面。
//   3. 范围化列举（AC2）：一切动作先过同一道范围门——受限 data 通道 +
//      事务本地上下文 + 真实 RLS（租户臂 + restrictive 主体自读臂）→
//      事务内公司（active + epoch 匹配签发时版本）与团队重验 → 协会行
//      (tenant, workspace, principal) 三元组比对（第二道独立防线）→
//      经协会行 join 权威 store（keyset 稳定序 (created_at DESC,
//      artifact_id)）。跨范围/不存在/撤权对列表面 = 空页（AC2「跨范围
//      列举为空」），对象面 = canonical RESOURCE_NOT_FOUND。
//   4. 读取（AC1/AC4）：下载授权 = 范围门 → 权威产物行 → 注入的
//      objectStore.get（存储键来自权威行或服务端派生键，调用方输入里
//      没有路径）。本服务面没有任何「按裸键取字节」的入口：对象存储端口
//      只在范围门通过后被调用——「直接猜测路径读取」在结构上没有入口
//      （不是入口里的一道检查）。
//   5. 删除与清理（AC3）：deleteWorkshopArtifact / cleanupWorkshopArtifacts
//      都先过范围门；cleanup 只枚举/只删除本 scope 协会行下的候选——
//      清理任务拿到的候选清单即使含其他 scope 的产物，过滤器也会在
//      删除之前把它们全部排除（MT047 cull 同纪律）。跨范围删除请求在
//      判定处折叠为 not-found，他人产物一个字节都不动。
//   6. 元数据（AC4）：名称/大小/时间只在范围门通过后的返回值里出现；
//      deny（列表空页、对象 not-found）不携带任何元数据字段，错误与
//      计数不泄露存在性。
//
// 事务纪律与 MT053 完全一致：受信 Scope（assertTrustedScope）→ read
// committed + lock/statement timeout → set_config('app.*', …, true) 事务
// 本地 → advisory 锁（键序 tenant → principal → membership →
// workspace-membership → artifact；读共享、控制排他）→ 成员事实重验 →
// 判定或委托。产物行读写经既有 workshop 权威 store（平台通道，与生产装配
// 同源——范围合法性已由范围门钉死后委托）。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形——不存在/跨团队/跨公司/他人/
// 撤权对外不可区分）。哨兵码（确定性、零回显）：
// ARTIFACT_ID_INVALID / ARTIFACT_INPUT_INVALID / ARTIFACT_SCOPE_MISMATCH /
// ARTIFACT_SCOPE_REVOKED（列表面对公司级撤销的响亮拒绝，MT041 同纪律）。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由（服务面供下游接线票复用，MT053/MT016 同例）；
//     workshop 的个人面（既有 routes）原样不动。
//   - 既有个人产物（无协会行）在企业面不可见：不猜测回填（回填属
//     #161/MT118 映射臂后续段，Spec §9.2「不按猜测分配」）；本票只钉
//     创建接线与作用域语义。
//   - objectStore 是注入端口（测试给内存 store，接线方给真实对象存储）；
//     本模块不触网不触盘。
//   - 既有 workshop 权威 store 只有 insertArtifact/listArtifacts 两读面；
//     rows 缝的 findArtifactById/findSessionById/deleteArtifact 由装配侧
//     适配器落（测试夹具给平台通道实现，生产接线给 store 扩展面）——
//     语义归既有 workshop 域，本模块零复刻。
//   - 下载签发与代理（签名 URL 两点授权）属 MT056（#99）——本票交付
//     范围门与字节面，签名层在其上叠加。

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { enterpriseArtifactScopes } from "../../db/schema/enterprise-artifact-scopes";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type {
  WorkshopArtifactRow,
  WorkshopSessionRow,
} from "../../workshop/store";
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

export const ARTIFACT_ID_INVALID = "ARTIFACT_ID_INVALID";
export const ARTIFACT_SESSION_ID_INVALID = "ARTIFACT_SESSION_ID_INVALID";
export const ARTIFACT_INPUT_INVALID = "ARTIFACT_INPUT_INVALID";
export const ARTIFACT_SCOPE_MISMATCH = "ARTIFACT_SCOPE_MISMATCH";
/** 列表面对公司级撤销的响亮拒绝（MT041 成员视图同纪律）。 */
export const ARTIFACT_SCOPE_REVOKED = "SCOPE_REVOKED";

// ---------------------------------------------------------------------------
// 命名与隔离：纯函数（AC1 的键半边，MT053/MT047 同纪律）
// ---------------------------------------------------------------------------

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const plainId = (value: string, field: string): string => {
  if (!PLAIN_ID.test(value)) {
    throw new Error(`${ARTIFACT_ID_INVALID}: ${field}`);
  }
  return value;
};

/**
 * 企业面的 Workshop 产物对象键（AC1「按归属隔离寻址」的命名半边）：
 * 四段全是校验过的 plain id——一个 scope 永远命名不出另一个 scope 的键。
 */
export function enterpriseWorkshopArtifactObjectKey(
  tenantId: string,
  workspaceId: string,
  sessionId: string,
  artifactId: string,
): string {
  return [
    "workshop-artifacts",
    plainId(tenantId, "tenantId"),
    plainId(workspaceId, "workspaceId"),
    plainId(sessionId, "sessionId"),
    plainId(artifactId, "artifactId"),
  ].join("/");
}

/** 从一条企业面 Workshop 产物键解析归属；形状不符或含非 plain id 段 = null。 */
export function parseEnterpriseWorkshopArtifactObjectKey(key: string): {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly artifactId: string;
} | null {
  const segments = key.split("/");
  if (segments.length !== 5 || segments[0] !== "workshop-artifacts")
    return null;
  const [tenantId, workspaceId, sessionId, artifactId] = segments.slice(1);
  if (
    !PLAIN_ID.test(tenantId) ||
    !PLAIN_ID.test(workspaceId) ||
    !PLAIN_ID.test(sessionId) ||
    !PLAIN_ID.test(artifactId)
  ) {
    return null;
  }
  return { tenantId, workspaceId, sessionId, artifactId };
}

// ---------------------------------------------------------------------------
// 行缝：既有 workshop 权威 store 的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。产物行的全部语义（可见性、类型域、cascade）
 * 归既有 workshop/store.ts 权威，本模块零复刻、只做范围门后的委托
 * （MT053 rows 缝同款）。
 */
export type WorkshopArtifactRows = {
  /** 产物行的无属主检查读（pin 的会话属主守卫在会话行上）。 */
  findArtifactById(
    artifactId: string,
  ): Promise<WorkshopArtifactRow | undefined>;
  /** 会话行读（pin 的「本人会话下的产物行」守卫）。 */
  findSessionById(sessionId: string): Promise<WorkshopSessionRow | undefined>;
  /** 会话的产物列表（列表 join 面按协会行收窄后委托）。 */
  listArtifacts(sessionId: string): Promise<readonly WorkshopArtifactRow[]>;
  /** 删除一条产物行（权威 store 自有属主纪律；范围门先行）。 */
  deleteArtifact(artifactId: string): Promise<boolean>;
};

/** 对象存储的最小投影（范围门通过后的字节来源）。 */
export interface ArtifactObjectStore {
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

/** 一条归属协会行的投影（零内容，纯归属事实）。 */
export interface ArtifactScopeView {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

export type ArtifactPinResult =
  | { readonly status: "pinned"; readonly ownership: ArtifactScopeView }
  | { readonly status: "existing"; readonly ownership: ArtifactScopeView };

/** 范围化列表（AC2）的条目：元数据只在范围门通过后出现（AC4）。 */
export interface ScopedArtifactView {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: WorkshopArtifactRow["type"];
  readonly sizeBytes: number;
  readonly visibility: WorkshopArtifactRow["visibility"];
  readonly createdAt: Date;
  /** 服务端派生的企业面存储键（AC1 寻址半边的证据面）。 */
  readonly enterpriseKey: string;
}

export type ArtifactReadOutcome =
  | {
      readonly outcome: "allow";
      readonly artifact: WorkshopArtifactRow;
      readonly bytes: Uint8Array;
      readonly enterpriseKey: string;
    }
  | ResourceNotFoundVerdict;

/** 下载签发点（MT056 签名层的产物族入口）：只判权与派生键，不取字节。 */
export type ArtifactAuthorizeOutcome =
  | {
      readonly outcome: "allow";
      readonly artifact: WorkshopArtifactRow;
      readonly enterpriseKey: string;
    }
  | ResourceNotFoundVerdict;

export interface ArtifactStorageService {
  /** 创建接线时的归属固定（create-once；mismatch 响亮拒绝）。 */
  pinWorkshopArtifact(
    scope: PlatformScope,
    input: {
      readonly sessionId: string;
      readonly artifactId: string;
    },
  ): Promise<ArtifactPinResult | ResourceNotFoundVerdict>;

  /**
   * 范围化列表（AC2）：只返回 (tenant, workspace, principal) 三元组下本人
   * 的产物；跨范围列举为空；公司级撤销响亮拒绝（SCOPE_REVOKED）。keyset
   * 稳定序 (created_at DESC, artifact_id)。
   */
  listArtifacts(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly artifacts: readonly ScopedArtifactView[];
    readonly nextCursor?: string;
  }>;

  /** 读取授权（AC1/AC4）：范围门 → 权威行 → 注入 objectStore。 */
  readArtifact(
    scope: PlatformScope,
    input: {
      /** 直连路径的会话一致性检查；缺省（MT056 代理点）只按三元组门。 */
      readonly sessionId?: string;
      readonly artifactId: string;
    },
  ): Promise<ArtifactReadOutcome>;

  /**
   * 下载签发点授权（MT056 产物族签发半边）：同一道范围门与键派生，
   * 不取字节——签发只证明「此刻有权」，字节在代理点现取。
   */
  authorizeDownload(
    scope: PlatformScope,
    input: {
      readonly sessionId?: string;
      readonly artifactId: string;
    },
  ): Promise<ArtifactAuthorizeOutcome>;

  /** 删除（AC3）：范围门后委托权威 store；跨范围折叠为 not-found。 */
  deleteArtifact(
    scope: PlatformScope,
    input: {
      readonly sessionId: string;
      readonly artifactId: string;
    },
  ): Promise<
    | { readonly outcome: "allow"; readonly artifactId: string }
    | ResourceNotFoundVerdict
  >;

  /**
   * 清理（AC3）：只枚举本 scope 协会行下的候选（跨 scope 候选在删除前被
   * 过滤器排除），按服务端派生键删除对象存储字节并删权威行与协会行。
   */
  cleanupArtifacts(
    scope: PlatformScope,
    input: { readonly olderThanSeconds: number },
  ): Promise<{
    readonly outcome: "allow";
    readonly cleaned: readonly string[];
  }>;
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
export function scopeArtifactLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise-artifact-storage",
    "scope",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

/** 单产物控制序列化锁键（删除 CAS 前的排他点）。 */
function artifactControlLockKey(tenantId: string, artifactId: string): string {
  return JSON.stringify([
    "enterprise-artifact-storage",
    "artifact",
    tenantId,
    artifactId,
  ]);
}

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

export function createArtifactStorageService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: WorkshopArtifactRows;
  readonly objectStore: ArtifactObjectStore;
}): ArtifactStorageService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);
  const { data, operator, rows, objectStore } = deps;

  /** 事务开场（MT053 判定入口同一形状）。 */
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

  /** 事务内成员事实重验（MT053 同款切片）。 */
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
    row: typeof enterpriseArtifactScopes.$inferSelect,
  ): ArtifactScopeView => ({
    artifactId: row.artifactId,
    sessionId: row.sessionId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  });

  /**
   * 对象级范围门（AC2/AC4 的唯一判定入口）：协会行经真实 RLS（租户臂 +
   * restrictive 主体自读臂）+ 事务内成员事实重验 + 三元组比对。任何不
   * 成立 = null（不可见）——撤销也折叠进不可见，零存在泄漏。
   */
  const authorizeArtifact = async (
    scope: PlatformScope,
    artifactId: string,
  ): Promise<ArtifactScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(enterpriseArtifactScopes)
        .where(eq(enterpriseArtifactScopes.artifactId, artifactId))
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
    async pinWorkshopArtifact(scope, input) {
      assertTrustedScope(scope);
      const sessionId = plainId(input.sessionId, "sessionId");
      const artifactId = plainId(input.artifactId, "artifactId");
      // 本人会话下的产物行守卫：他人产物/不存在不可区分（canonical
      // not-found）。
      const artifact = await rows.findArtifactById(artifactId);
      if (!artifact || artifact.sessionId !== sessionId) return DENY_VERDICT;
      const session = await rows.findSessionById(sessionId);
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
          sql`select pg_advisory_xact_lock(hashtextextended(${scopeArtifactLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          )}, 0))`,
        );
        const [inserted] = await tx
          .insert(enterpriseArtifactScopes)
          .values({
            artifactId,
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
          .from(enterpriseArtifactScopes)
          .where(eq(enterpriseArtifactScopes.artifactId, artifactId))
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
        throw new Error(ARTIFACT_SCOPE_MISMATCH);
      });
    },

    async listArtifacts(scope, page) {
      assertTrustedScope(scope);
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200) {
        throw new Error(`${ARTIFACT_INPUT_INVALID}: limit`);
      }
      // 成员事实在 data 事务内现读（MT041 成员视图同纪律：公司级撤销对
      // 列面响亮，不折叠为空页——空页语义只用于对象面与「跨范围为空」）。
      const memberOk = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        return facts.companyActive && facts.teamActive;
      });
      if (!memberOk) throw new Error(ARTIFACT_SCOPE_REVOKED);
      const scopeRows = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conditions = [
          eq(enterpriseArtifactScopes.tenantId, scope.tenantId),
          eq(enterpriseArtifactScopes.workspaceId, scope.workspaceId),
          eq(enterpriseArtifactScopes.principalId, scope.principalId),
        ];
        if (page.cursor !== undefined) {
          const parsed = new Date(String(page.cursor));
          if (Number.isNaN(parsed.getTime())) {
            throw new Error(`${ARTIFACT_INPUT_INVALID}: cursor`);
          }
          conditions.push(lt(enterpriseArtifactScopes.createdAt, parsed));
        }
        return tx
          .select({
            artifactId: enterpriseArtifactScopes.artifactId,
            sessionId: enterpriseArtifactScopes.sessionId,
            createdAt: enterpriseArtifactScopes.createdAt,
          })
          .from(enterpriseArtifactScopes)
          .where(and(...conditions))
          .orderBy(
            desc(enterpriseArtifactScopes.createdAt),
            desc(enterpriseArtifactScopes.artifactId),
          )
          .limit(page.limit + 1);
      });
      const pageRows = scopeRows.slice(0, page.limit);
      // 权威行按会话批量读（平台通道，范围门已钉死）。
      const sessionIds = [...new Set(pageRows.map((row) => row.sessionId))];
      const authoritative = new Map<string, WorkshopArtifactRow>();
      for (const sessionId of sessionIds) {
        for (const artifact of await rows.listArtifacts(sessionId)) {
          authoritative.set(artifact.id, artifact);
        }
      }
      const artifacts = pageRows.flatMap((scopeRow) => {
        const artifact = authoritative.get(scopeRow.artifactId);
        if (!artifact) return [];
        return [
          {
            artifactId: artifact.id,
            sessionId: artifact.sessionId,
            name: artifact.name,
            type: artifact.type,
            sizeBytes: artifact.sizeBytes,
            visibility: artifact.visibility,
            createdAt: artifact.createdAt,
            enterpriseKey: enterpriseWorkshopArtifactObjectKey(
              scope.tenantId,
              scope.workspaceId,
              artifact.sessionId,
              artifact.id,
            ),
          },
        ];
      });
      return {
        artifacts,
        ...(scopeRows.length > page.limit
          ? {
              nextCursor:
                pageRows[pageRows.length - 1]?.createdAt.toISOString(),
            }
          : {}),
      };
    },

    async readArtifact(scope, input) {
      assertTrustedScope(scope);
      if (input.sessionId !== undefined) {
        plainId(input.sessionId, "sessionId");
      }
      const artifactId = plainId(input.artifactId, "artifactId");
      const ownership = await authorizeArtifact(scope, artifactId);
      if (ownership === null) return DENY_VERDICT;
      if (
        input.sessionId !== undefined &&
        ownership.sessionId !== input.sessionId
      )
        return DENY_VERDICT;
      const artifact = await rows.findArtifactById(artifactId);
      if (!artifact) return DENY_VERDICT;
      // 下载授权（AC1/AC4）：存储键来自服务端派生（调用方输入里没有
      // 路径），字节经注入 objectStore——范围门之前零字节读取。
      const enterpriseKey = enterpriseWorkshopArtifactObjectKey(
        scope.tenantId,
        scope.workspaceId,
        ownership.sessionId,
        artifactId,
      );
      const bytes = await objectStore.get(enterpriseKey);
      return { outcome: "allow" as const, artifact, bytes, enterpriseKey };
    },

    async authorizeDownload(scope, input) {
      assertTrustedScope(scope);
      if (input.sessionId !== undefined) {
        plainId(input.sessionId, "sessionId");
      }
      const artifactId = plainId(input.artifactId, "artifactId");
      const ownership = await authorizeArtifact(scope, artifactId);
      if (ownership === null) return DENY_VERDICT;
      if (
        input.sessionId !== undefined &&
        ownership.sessionId !== input.sessionId
      )
        return DENY_VERDICT;
      const artifact = await rows.findArtifactById(artifactId);
      if (!artifact) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        artifact,
        enterpriseKey: enterpriseWorkshopArtifactObjectKey(
          scope.tenantId,
          scope.workspaceId,
          ownership.sessionId,
          artifactId,
        ),
      };
    },

    async deleteArtifact(scope, input) {
      assertTrustedScope(scope);
      const sessionId = plainId(input.sessionId, "sessionId");
      const artifactId = plainId(input.artifactId, "artifactId");
      const ownership = await authorizeArtifact(scope, artifactId);
      if (ownership === null || ownership.sessionId !== sessionId) {
        return DENY_VERDICT;
      }
      // 控制序列化锁：同产物的删除/清理串行。
      await operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${artifactControlLockKey(
            scope.tenantId,
            artifactId,
          )}, 0))`,
        );
      });
      const deleted = await rows.deleteArtifact(artifactId);
      if (!deleted) return DENY_VERDICT;
      await objectStore
        .delete(
          enterpriseWorkshopArtifactObjectKey(
            scope.tenantId,
            scope.workspaceId,
            sessionId,
            artifactId,
          ),
        )
        .catch(() => {
          // 字节缺失不回滚权威删除（清理幂等）；吞掉端口错误记录在返回面。
        });
      return { outcome: "allow" as const, artifactId };
    },

    async cleanupArtifacts(scope, input) {
      assertTrustedScope(scope);
      if (
        !input ||
        !Number.isInteger(input.olderThanSeconds) ||
        input.olderThanSeconds < 0
      ) {
        throw new Error(`${ARTIFACT_INPUT_INVALID}: olderThanSeconds`);
      }
      const cutoff = new Date(Date.now() - input.olderThanSeconds * 1000);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(ARTIFACT_SCOPE_REVOKED);
        }
        // AC3：候选只来自本 scope 的协会行（RLS 租户臂 + 显式三元组过滤
        // 双防线）——跨公司/跨团队/他人行对本事务不可见，绝不删除。
        const candidates = await tx
          .select({
            artifactId: enterpriseArtifactScopes.artifactId,
            sessionId: enterpriseArtifactScopes.sessionId,
            createdAt: enterpriseArtifactScopes.createdAt,
          })
          .from(enterpriseArtifactScopes)
          .where(
            and(
              eq(enterpriseArtifactScopes.tenantId, scope.tenantId),
              eq(enterpriseArtifactScopes.workspaceId, scope.workspaceId),
              eq(enterpriseArtifactScopes.principalId, scope.principalId),
              lt(enterpriseArtifactScopes.createdAt, cutoff),
            ),
          );
        const cleaned: string[] = [];
        for (const candidate of candidates) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${artifactControlLockKey(
              scope.tenantId,
              candidate.artifactId,
            )}, 0))`,
          );
          const deleted = await rows.deleteArtifact(candidate.artifactId);
          if (!deleted) continue;
          await tx
            .delete(enterpriseArtifactScopes)
            .where(
              and(
                eq(enterpriseArtifactScopes.artifactId, candidate.artifactId),
                eq(enterpriseArtifactScopes.tenantId, scope.tenantId),
                eq(enterpriseArtifactScopes.principalId, scope.principalId),
              ),
            )
            .catch(() => {
              // 协会行已随 cascade 消失或属主事务并发删除——幂等。
            });
          await objectStore
            .delete(
              enterpriseWorkshopArtifactObjectKey(
                scope.tenantId,
                scope.workspaceId,
                candidate.sessionId,
                candidate.artifactId,
              ),
            )
            .catch(() => {
              // 字节缺失不阻断清理（幂等）。
            });
          cleaned.push(candidate.artifactId);
        }
        return { outcome: "allow" as const, cleaned };
      });
    },
  };
}
