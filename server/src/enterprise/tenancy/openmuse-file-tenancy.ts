// server/src/enterprise/tenancy/openmuse-file-tenancy.ts
// MT061（Issue #104）：OpenMuse 文件、PDF 检视/填写/传输与个人工作区的作用域。
//
// 票面语义（brief + Issue #104）：
//   AC1 文件列举、读取、处理与下载都要求当前范围与个人权限——协会行三元组
//      （租户臂 RLS + restrictive 主体自读）先于一切文件行读写；一切不可见
//      = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 PDF 填写/传输任务保存发起归属，执行时校验；撤权后失败而不是继续
//      ——openmuse_document_actions 行持久发起归属；执行侧机器身份 → 扫描
//      臂读权威行 → 真实签发入口重建受信 Scope（重建不制造 Scope）；撤权
//      后重建拒绝 = OPENMUSE_DOCUMENT_SCOPE_REVOKED（fail，不继续）。
//   AC3 个人工作区不跨公司共享；同一账号在两个公司的工作区互相不可见
//      ——传输目的地 = 当前 scope 的私有 Bot 工作区（MT059 服务解析，绝不
//      客户端声明）；另一公司 scope 对本文件与动作行结构性不可见。
//   AC4 外部文件引用（如邮件附件）按归属解析，不能凭 ID 跨范围取用
//      ——resolveExternalReference 以 (owner, sourceKey) 收敛查找文件后仍须
//      协会行三元组匹配；跨公司同账号 = canonical not-found。
//
// 结构（纯新增，消费 MT005/MT011/MT042/MT059 既有出口与既有 openmuse-files
// 权威 store——归属协会表与动作表是本模块的唯一新持久化对象）：
//
//   1. 归属（pinFileScope）：上传/导入接线时固定 (公司, 团队, 主体, 用户)
//      归属——create-once；同三元组幂等返回 existing，不同选择标识一律
//      OPENMUSE_FILE_SCOPE_MISMATCH 响亮拒绝且已存行不动；缺有效成员事实
//      WORKSPACE_MEMBERSHIP_REQUIRED（MT059/MT016 同字面量创建响亮门）。
//   2. 范围化读取（listFiles/readFile/resolveExternalReference）：受限 data
//      通道 + 事务本地上下文 + 真实 RLS → 事务内公司（active + epoch）与
//      团队（active）事实重验 → 协会行三元组比对（第二道独立防线）→ 委托
//      既有 rows 缝读文件行。缺席/跨团队/跨公司/他人/撤权对对象面全部折叠
//      为不可见；列表面对公司级撤销响亮拒绝（SCOPE_REVOKED）。
//   3. 文档动作（recordDocumentAction/authorizeDocumentAction，AC2/AC3）：
//      填写/传输在发起时写动作行（发起归属 = 行本体）；执行侧以机器身份经
//      operator 扫描臂读权威行（app.scan_sweep='on'），再经真实签发入口
//      （entrypoint="schedule"）产出受信 Scope——resolveTransferDestination
//      把传输目的地钉到该 scope 的私有 Bot（MT059 服务），跨公司 scope 得
//      到结构性不同的 Bot 工作区；撤权后 authorize 拒绝（哨兵码，零回显）。
//
// 事务纪律与 MT060 完全一致：assertTrustedScope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership → workspace-membership；
// 读共享、写排他）→ 成员事实重验 → 判定或执行。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形）。机器面哨兵码（确定性、零回显）：
// OPENMUSE_DOCUMENT_RECORD_MISSING / OPENMUSE_DOCUMENT_SCOPE_REVOKED。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：服务面供下游接线票复用（MT060/MT059 同例）。
//   - 字节物理隔离（对象存储路径分段）是 MT055 的交付；本模块管归属判定。
//   - 动作行不记传输结果（ledger 在 Bot 工作区内，F09 设计）；本模块管发起
//     归属与执行重建，结果事实归工作区侧。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  type OpenMuseDocumentActionRow,
  type OpenMuseFileScopeRow,
  openmuseDocumentActions,
  openmuseFileScopes,
} from "../../db/schema/openmuse-file-tenancy";
import type { PlatformScope } from "../contracts";
import { assertTrustedMachineIdentity } from "../runs/scan-executor";
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
import type { PersonalBotService } from "./personal-bot";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：一个文件的 (公司, 团队, 主体, 用户, 来源) 事实。 */
export interface OpenMuseFileScopeView {
  readonly fileId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly attribution: "created" | "import";
  readonly createdAt: Date;
}

/** 范围化列表条目：文件行投影 + 归属事实。 */
export interface ScopedOpenMuseFile {
  readonly ownership: OpenMuseFileScopeView;
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    readonly createdAt: Date;
  };
}

/** 单对象读取判定：allow 携带归属与文件行；一切不可见 = canonical not-found。 */
export type FileReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseFileScopeView;
      readonly file: ScopedOpenMuseFile["file"];
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type FileScopePinResult =
  | {
      readonly status: "pinned";
      readonly ownership: OpenMuseFileScopeView;
    }
  | { readonly status: "existing"; readonly ownership: OpenMuseFileScopeView }
  | ResourceNotFoundVerdict;

/** AC2/AC3 传输目的地：scope 的私有 Bot（MT059 服务解析，服务端派生）。 */
export type TransferDestinationResolution =
  | {
      readonly outcome: "allow";
      readonly botAgentId: string;
      readonly ownership: OpenMuseFileScopeView;
    }
  | ResourceNotFoundVerdict;

/** AC2 执行重建结果：受信 Scope + 权威事实；拒绝 = 确定性哨兵码（零回显）。 */
export type DocumentExecutionResolution =
  | {
      readonly ok: true;
      readonly scope: PlatformScope;
      readonly facts: {
        readonly fileId: string;
        readonly actionKind: "fill" | "transfer";
        readonly tenantId: string;
        readonly workspaceId: string;
        readonly principalId: string;
        readonly userId: string;
      };
    }
  | { readonly ok: false; readonly code: string };

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_FILE_SCOPE_INVALID = "OPENMUSE_FILE_SCOPE_INVALID";
export const OPENMUSE_FILE_SCOPE_MISMATCH = "OPENMUSE_FILE_SCOPE_MISMATCH";
export const OPENMUSE_FILE_CURSOR_INVALID = "OPENMUSE_FILE_CURSOR_INVALID";
export const OPENMUSE_DOCUMENT_KIND_INVALID = "OPENMUSE_DOCUMENT_KIND_INVALID";
export const OPENMUSE_DOCUMENT_RECORD_MISSING =
  "OPENMUSE_DOCUMENT_RECORD_MISSING";
export const OPENMUSE_DOCUMENT_SCOPE_REVOKED =
  "OPENMUSE_DOCUMENT_SCOPE_REVOKED";
/** 创建/发起响亮门（MT059/MT016 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_FILE_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_FILE_SCOPE_INVALID}: ${rule}`);
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

const DOCUMENT_ACTION_KINDS = ["fill", "transfer"] as const;

/** 列表页大小：1..100（与既有 openmuse-files 路由的合同上限一致）。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 行缝：既有 openmuse-files 权威 store 的最小投影 + 列表批量面
// ---------------------------------------------------------------------------

/**
 * 既有权威 store 的最小投影。upload/tombstone/appendVersion 等语义全部归
 * 既有 openmuse-files/store.ts 权威，本模块零复刻、只做范围门后的委托。
 * listFilesByIds 是范围化列表的批量取行面（装配在既有 rows 对象上适配，
 * 一查 inArray——MT060 listTasksByIds 同例）。
 */
export type OpenMuseFileTenancyRows = {
  /** owner 的一个活文件行（tombstoned/外来 = null，与 store 语义一致）。 */
  findOwnedFile(
    ownerUserId: string,
    fileId: string,
  ): Promise<ScopedOpenMuseFile["file"] | null>;
  listFilesByIds(
    ownerUserId: string,
    fileIds: readonly string[],
  ): Promise<readonly ScopedOpenMuseFile["file"][]>;
  /**
   * 外部引用收敛查找（AC4）：按 (owner, sourceKey) 找活文件行——这是既有
   * store.findByIdempotencyKey 的投影；跨范围判定在本模块的协会门。
   */
  findFileByIdempotencyKey(
    ownerUserId: string,
    sourceKey: string,
  ): Promise<ScopedOpenMuseFile["file"] | null>;
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenMuseFileTenancyService {
  /**
   * 上传/导入接线时的归属固定（AC1 写半边）。外来文件（根行不存在/非本
   * 人）= canonical not-found；同三元组重放幂等 existing；不同选择标识
   * 一律 OPENMUSE_FILE_SCOPE_MISMATCH 响亮拒绝且已存归属不动。
   */
  pinFileScope(
    scope: PlatformScope,
    input: {
      readonly fileId: string;
      /** created = 本地上传；import = 外部引用（邮件附件）导入（AC4 事实）。 */
      readonly attribution?: "created" | "import";
    },
  ): Promise<FileScopePinResult>;

  /**
   * 范围化列表（AC1）：只返回 (tenant, workspace, principal) 三元组下本人
   * 的文件；公司级撤销响亮拒绝（SCOPE_REVOKED）；团队级撤销 = 空页。
   * 分页 keyset 稳定序 (created_at DESC, file_id DESC)。
   */
  listFiles(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly files: readonly ScopedOpenMuseFile[];
    readonly nextCursor?: string;
  }>;

  /** 范围化读取（AC1）：不可见 = canonical not-found。 */
  readFile(scope: PlatformScope, fileId: string): Promise<FileReadOutcome>;

  /**
   * AC4 外部引用解析：(owner, sourceKey) 收敛查找后仍须协会行三元组匹配；
   * 同账号跨公司取用（甚至同公司他人）= canonical not-found。
   */
  resolveExternalReference(
    scope: PlatformScope,
    input: { readonly sourceKey: string },
  ): Promise<FileReadOutcome>;

  /**
   * AC2 发起归属：填写/传输在发起时写动作行（发起归属 = 行本体；同键重放
   * 幂等 existing）。文件不属于当前 scope = canonical not-found。
   */
  recordDocumentAction(
    scope: PlatformScope,
    input: {
      readonly fileId: string;
      readonly actionKind: (typeof DOCUMENT_ACTION_KINDS)[number];
    },
  ): Promise<
    | { readonly status: "recorded"; readonly facts: DocumentActionFacts }
    | { readonly status: "existing"; readonly facts: DocumentActionFacts }
    | ResourceNotFoundVerdict
  >;

  /**
   * AC2 执行重建：机器身份 → 动作行（扫描臂）→ 真实签发入口的受信
   * Scope。撤权后拒绝（OPENMUSE_DOCUMENT_SCOPE_REVOKED）——动作失败而不
   * 是继续。hint 参数仅类型面收窄，从不参与判定（MT042 规则）。
   */
  authorizeDocumentAction(
    machine: unknown,
    input: {
      readonly fileId: string;
      readonly actionKind: (typeof DOCUMENT_ACTION_KINDS)[number];
      /** 队列消息的路由提示——本方法刻意不读它（MT042 规则）。 */
      readonly hint?: unknown;
    },
  ): Promise<DocumentExecutionResolution>;

  /**
   * AC3 传输目的地：当前 scope 的私有 Bot 工作区（MT059 服务解析——目的地
   * 由服务端从 scope 派生，绝不接受客户端声明）；文件不属于本 scope =
   * canonical not-found。跨公司 scope 解析同一文件得到 not-found，各自
   * 解析自己的文件得到结构性不同的 Bot。
   */
  resolveTransferDestination(
    scope: PlatformScope,
    fileId: string,
  ): Promise<TransferDestinationResolution>;
}

/** 动作行的权威事实投影。 */
export interface DocumentActionFacts {
  readonly fileId: string;
  readonly actionKind: "fill" | "transfer";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMuseFileTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: OpenMuseFileTenancyRows;
  /** MT059 私有 Bot 服务（AC3 传输目的地解析，只读消费）。 */
  readonly personalBots: PersonalBotService;
  /**
   * 签发入口适配：以动作行事实（user/tenant/workspace）经真实
   * createScopeResolver（entrypoint="schedule"）产出受信 Scope。本模块从
   * 不构造 Scope 对象（MT042 同纪律）。
   */
  readonly issueScheduleScope: (facts: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
  }) => Promise<PlatformScope>;
}): OpenMuseFileTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows, personalBots } = deps;

  /** 事务开场（MT060 判定入口同一形状）。 */
  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership（读共享）。
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
  const authorizeFile = async (
    scope: PlatformScope,
    fileId: string,
  ): Promise<OpenMuseFileScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmuseFileScopes)
        .where(eq(openmuseFileScopes.fileId, fileId))
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

  /** AC2 执行重建（MT042/MT060 同构）：动作行经扫描臂读取；hint 从不参与。 */
  const rebuildActionFacts = async (
    fileId: string,
    actionKind: string,
  ): Promise<{ ok: true; facts: DocumentActionFacts } | { ok: false }> =>
    operator.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      // 平台触发上下文：事务本地、提交即清（MT061 迁移自带的扫描臂）。
      await tx.execute(sql`select set_config('app.scan_sweep', 'on', true)`);
      const [row] = await tx
        .select()
        .from(openmuseDocumentActions)
        .where(
          and(
            eq(openmuseDocumentActions.fileId, fileId),
            eq(openmuseDocumentActions.actionKind, actionKind),
          ),
        )
        .limit(1);
      if (!row) return { ok: false as const };
      return { ok: true as const, facts: factsOf(row) };
    });

  const requireActionKind = (
    value: unknown,
  ): (typeof DOCUMENT_ACTION_KINDS)[number] => {
    if (
      typeof value !== "string" ||
      !DOCUMENT_ACTION_KINDS.includes(value as "fill" | "transfer")
    ) {
      throw new Error(
        `${OPENMUSE_DOCUMENT_KIND_INVALID}: actionKind must be one of ${DOCUMENT_ACTION_KINDS.join("|")}`,
      );
    }
    return value as (typeof DOCUMENT_ACTION_KINDS)[number];
  };

  return {
    async pinFileScope(scope, input) {
      assertTrustedScope(scope);
      const fileId = requireId(input.fileId, "fileId");
      const attribution =
        input.attribution === undefined ? "created" : input.attribution;
      // 外来文件（根行不存在/非本人/tombstoned）与不存在不可区分。
      const owned = await rows.findOwnedFile(scope.actorId, fileId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_FILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(openmuseFileScopes)
          .values({
            fileId,
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
          .from(openmuseFileScopes)
          .where(eq(openmuseFileScopes.fileId, fileId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_FILE_SCOPE_MISMATCH}: file is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: scopeViewOf(existing),
        };
      });
    },

    async listFiles(scope, page) {
      assertTrustedScope(scope);
      if (
        typeof page?.limit !== "number" ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > LIST_LIMIT_MAX
      ) {
        failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
      }
      let cursor: { createdAt: Date; fileId: string } | undefined;
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor);
        if (!decoded) throw new Error(OPENMUSE_FILE_CURSOR_INVALID);
        cursor = decoded;
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { files: [] as ScopedOpenMuseFile[] };
        }
        const associationRows = await tx
          .select()
          .from(openmuseFileScopes)
          .where(
            and(
              eq(openmuseFileScopes.tenantId, scope.tenantId),
              eq(openmuseFileScopes.workspaceId, scope.workspaceId),
              eq(openmuseFileScopes.principalId, scope.principalId),
              ...(cursor
                ? [
                    sql`(${openmuseFileScopes.createdAt}, ${openmuseFileScopes.fileId}) < (${cursor.createdAt}, ${cursor.fileId})`,
                  ]
                : []),
            ),
          )
          .orderBy(
            sql`${openmuseFileScopes.createdAt} DESC, ${openmuseFileScopes.fileId} DESC`,
          )
          .limit(page.limit + 1);
        const hasMore = associationRows.length > page.limit;
        const visible = associationRows.slice(0, page.limit);
        if (visible.length === 0) {
          return { files: [] as ScopedOpenMuseFile[] };
        }
        const fileRows = await rows.listFilesByIds(
          scope.actorId,
          visible.map((row) => row.fileId),
        );
        const fileById = new Map(fileRows.map((file) => [file.id, file]));
        const files: ScopedOpenMuseFile[] = [];
        for (const row of visible) {
          const file = fileById.get(row.fileId);
          // 根行在两次读取之间被删除/tombstone：条目消失，不泄露存在性。
          if (!file) continue;
          files.push({ ownership: scopeViewOf(row), file });
        }
        const last = visible[visible.length - 1];
        return {
          files,
          ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
        };
      });
    },

    async readFile(scope, fileId) {
      assertTrustedScope(scope);
      const id = requireId(fileId, "fileId");
      const ownership = await authorizeFile(scope, id);
      if (!ownership) return notFoundVerdict();
      const file = await rows.findOwnedFile(ownership.userId, id);
      if (!file) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, file };
    },

    async resolveExternalReference(scope, input) {
      assertTrustedScope(scope);
      const sourceKey = requireId(input.sourceKey, "sourceKey");
      // 收敛查找是 owner 级的（既有 store 语义）；协会门决定范围可见性。
      const converged = await rows.findFileByIdempotencyKey(
        scope.actorId,
        sourceKey,
      );
      if (!converged) return notFoundVerdict();
      const ownership = await authorizeFile(scope, converged.id);
      if (!ownership) return notFoundVerdict();
      return {
        outcome: "allow" as const,
        ownership,
        file: converged,
      };
    },

    async recordDocumentAction(scope, input) {
      assertTrustedScope(scope);
      const fileId = requireId(input.fileId, "fileId");
      const actionKind = requireActionKind(input.actionKind);
      // 动作的对象必须是当前 scope 的文件（AC1 门先于动作写）。
      const ownership = await authorizeFile(scope, fileId);
      if (!ownership) return notFoundVerdict();
      const owned = await rows.findOwnedFile(scope.actorId, fileId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_FILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(openmuseDocumentActions)
          .values({
            fileId,
            actionKind,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return { status: "recorded" as const, facts: factsOf(inserted) };
        }
        const [existing] = await tx
          .select()
          .from(openmuseDocumentActions)
          .where(
            and(
              eq(openmuseDocumentActions.fileId, fileId),
              eq(openmuseDocumentActions.actionKind, actionKind),
            ),
          )
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId
        ) {
          throw new Error(
            `${OPENMUSE_FILE_SCOPE_MISMATCH}: document action is already owned by a different scope`,
          );
        }
        return { status: "existing" as const, facts: factsOf(existing) };
      });
    },

    async authorizeDocumentAction(machine, input) {
      assertTrustedMachineIdentity(machine);
      const fileId = requireId(input.fileId, "fileId");
      const actionKind = requireActionKind(input.actionKind);
      const rebuilt = await rebuildActionFacts(fileId, actionKind);
      if (!rebuilt.ok) {
        return { ok: false as const, code: OPENMUSE_DOCUMENT_RECORD_MISSING };
      }
      try {
        const scope = await deps.issueScheduleScope({
          actorId: rebuilt.facts.userId,
          tenantId: rebuilt.facts.tenantId,
          workspaceId: rebuilt.facts.workspaceId,
        });
        return { ok: true as const, scope, facts: rebuilt.facts };
      } catch {
        // 签发入口重验失败（撤权/成员缺失）：确定性哨兵码，零回显——
        // 撤权后动作失败而不是继续（AC2）。
        return { ok: false as const, code: OPENMUSE_DOCUMENT_SCOPE_REVOKED };
      }
    },

    async resolveTransferDestination(scope, fileId) {
      assertTrustedScope(scope);
      const id = requireId(fileId, "fileId");
      const ownership = await authorizeFile(scope, id);
      if (!ownership) return notFoundVerdict();
      const owned = await rows.findOwnedFile(scope.actorId, id);
      if (!owned) return notFoundVerdict();
      // 目的地由服务端从 scope 派生：当前三元组的私有 Bot（MT059）。
      const outcome = await personalBots.ensurePersonalBot(scope, {
        displayName: `MT061 transfer workspace ${scope.tenantId}/${scope.workspaceId}`,
      });
      if (outcome.outcome !== "allow") {
        return notFoundVerdict();
      }
      return {
        outcome: "allow" as const,
        botAgentId: outcome.bot.agentId,
        ownership,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射与游标（模块底部小件）
// ---------------------------------------------------------------------------

function scopeViewOf(row: OpenMuseFileScopeRow): OpenMuseFileScopeView {
  return {
    fileId: row.fileId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    attribution: row.attribution === "import" ? "import" : "created",
    createdAt: row.createdAt,
  };
}

function factsOf(row: OpenMuseDocumentActionRow): DocumentActionFacts {
  return {
    fileId: row.fileId,
    actionKind: row.actionKind === "transfer" ? "transfer" : "fill",
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
  };
}

const encodeCursor = (row: OpenMuseFileScopeRow): string =>
  Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.fileId }),
    "utf8",
  ).toString("base64");

function decodeCursor(raw: string): { createdAt: Date; fileId: string } | null {
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
    return { createdAt, fileId: parsed.i };
  } catch {
    return null;
  }
}
