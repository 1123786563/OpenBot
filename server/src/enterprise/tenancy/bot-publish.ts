// server/src/enterprise/tenancy/bot-publish.ts
// MT017（Issue #60）：Bot 发布受众与旧 public 语义的显式迁移。
//
// 票面语义：发布 Bot 必须选择明确受众（团队公共或指定范围）；历史 public
// 标记只有经显式迁移或显式发布才进入团队公共范围，绝不自动变成全公司或
// 全平台公开。取消发布后团队成员立即失去使用权；发布受众不能跨公司。
//
// 结构（纯新增三文件之一；既有文件零改动——发布状态落在 enterprise_resources
// 注册行（kind='bot'，visibility='workspace'），不写第二份权威（Spec §4.2
// 「不能通过新旧各写一份完成迁移」）。MT009 的团队公共动作规则（read 经 MT008 判定、run 带依赖校验、
// 管理动作拒绝、非成员 canonical not-found）因此原样适用于已发布 Bot：
// 本模块只做「发布/取消发布」两个 owner 动作与受众校验，绝不复刻判定）：
//
//   1. 发布 = 注册 + 显式受众：owner 在 MT016 归属可见性门内（行 active +
//      同团队 + 公司成员 active/epoch 匹配 + 团队成员 active）且 owner 判定
//      通过后，把该 Bot 的资源注册行置为 visibility='workspace'。无注册行
//      则以归属行服务端事实落一行（display_name 取归属行，kind='bot' 固定，
//      客户端不能指定任何归属/种类属性）；注册行已 'workspace' = 幂等
//      no-op；NULL/'private' → 'workspace'（owner 对自己 Bot 的显式选择，
//      与 MT008 管理**批量**迁移「绝不翻转 private」语义不同——那是清单
//      驱动的第三方动作，这里是属主本人的发布动作）。
//   2. 受众是显式输入，词表只含 "team"：缺受众 → PUBLISH_AUDIENCE_REQUIRED
//      （票面：必须选择明确受众，绝不隐式默认当前团队）；形状坏 →
//      PUBLISH_AUDIENCE_INVALID；type ≠ "team" → PUBLISH_AUDIENCE_UNSUPPORTED
//      （指定范围受众属后续票据）；受众 tenant ≠ 归属 tenant →
//      PUBLISH_AUDIENCE_CROSS_COMPANY（验收 4：响亮拒绝）；受众 workspace ≠
//      归属 workspace（同公司跨团队）→ PUBLISH_AUDIENCE_NOT_OWNING_TEAM
//      （fail-closed：跨团队共享是显式例外路径的业务，Spec §5.1，不在默认
//      团队公共规则内偷放行）。判定顺序：受众纯校验（不触库）→ 可见性门 →
//      owner 门——非成员对同一请求得到 canonical not-found，不泄露归属。
//   3. 取消发布 = visibility 回 NULL：团队公共使用路径立即关闭（MT008/
//      MT009 全部调用时判定，无缓存——发布前签发的 scope 下一次判定即
//      canonical not-found，scope 本身不携带任何内容权，验收 2 的「已运行
//      会话不泄露」由调用时重验保证）；显式 grant 路径与团队公共路径独立，
//      不受影响（MT009 验收 3 语义）；归属行与 MT016 归属可见性不动（发布
//      不改变归属；同团队经 MT016 面仍见归属对象，使用权经 MT009 面关闭
//      ——两表面语义见模块边界披露）。幂等：重复取消 / 未发布 / 注册行已
//      软删（status≠'active' 时团队公共本已不可达）一律 allow。
//   4. 注册行不变量守卫：同 (tenant, id) 注册行若 kind ≠ 'bot'、workspace
//      ≠ 归属团队，发布路径上 status ≠ 'active' → BOT_PUBLISH_STATE_CONFLICT
//      （不变量破坏响亮拒绝，绝不静默改写他人种类的行）。
//   5. 数据库层纵深防御：受众 workspace 的复合引用只允许写往本租户团队
//      （INSERT 值来自归属行服务端事实，跨公司受众在纯校验处已被拒；即便
//      校验被绕过，workspace_id 复合外键使跨租户行结构上不可能存在）。
//
// 事务纪律与 MT016/MT008/MT009 完全一致：受信 Scope（assertTrustedScope）
// → read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁。锁序：tenant → principal → membership →
// workspace-membership → bot（共享，MT016 键族，钉住归属事实）→ resource
// （排他，["enterprise","resource",tenant,id] MT008 键族——与判定读共享锁、
// MT008 迁移写排他锁串行化；bot → resource 单向边，无环）。写路径走受限
// operator 角色；UPDATE 行策略要求 app.tenant_id + app.resource_id 匹配
// （resource-visibility.ts 同款），visibility 列级 UPDATE 授权由 MT008
// 迁移授予。事实读取全部经真实 RLS。
//
// 边界（诚实披露）：
//   - 本模块只作用于 MT008/MT009 资源使用路径（read/run 及一切经注册表的
//     团队公共面）。MT016 归属可见性（同团队列表/详情）是已验收的独立
//     语义：取消发布后同团队成员经 MT016 面仍可见该归属（归属未变），
//     使用权（run、注册表 read）立即关闭。MT017 不改 MT016 文件、不重复
//     其判定。
//   - 指定范围受众（people/group）、团队管理者代发布、发布审计字段
//     （published_by/at）属后续票据；本票受众词表显式只含 "team"。
//   - 挂路由非本票范围：服务面供下游接线票复用（MT016 同例）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 受众模型（词表显式；指定范围受众是后续票据语义）
// ---------------------------------------------------------------------------

/** 团队公共受众：受众词表当前唯一项（显式 tenant + workspace，绝不隐式）。 */
export interface BotPublishTeamAudience {
  readonly type: "team";
  readonly tenantId: string;
  readonly workspaceId: string;
}

/**
 * 发布受众。当前版本只有团队公共一项；扩展新受众（people/group）时在此
 * 显式追加并保持未知 type 的响亮拒绝（PUBLISH_AUDIENCE_UNSUPPORTED）。
 */
export type BotPublishAudience = BotPublishTeamAudience;

/** 发布事实视图（注册行版本号随行；深冻结，缓存/复用安全）。 */
export interface BotPublicationView {
  readonly agentId: string;
  readonly audience: BotPublishTeamAudience;
  readonly revision: number;
  readonly aclEpoch: number;
}

export type BotPublishDenyCode =
  | "PUBLISH_FORBIDDEN"
  | "PUBLISH_AUDIENCE_UNSUPPORTED"
  | "PUBLISH_AUDIENCE_CROSS_COMPANY"
  | "PUBLISH_AUDIENCE_NOT_OWNING_TEAM";

export type BotPublishVerdict =
  | { readonly outcome: "allow"; readonly publication: BotPublicationView }
  | ResourceNotFoundVerdict
  | { readonly outcome: "deny"; readonly code: BotPublishDenyCode };

export type BotUnpublishVerdict =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | {
      readonly outcome: "deny";
      readonly code: "PUBLISH_FORBIDDEN" | "BOT_PUBLISH_STATE_CONFLICT";
    };

// ---------------------------------------------------------------------------
// 输入校验（响亮拒绝；错误只含代码，绝不回显值）
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 256;

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertBotIdentity(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.trim().length === 0 ||
    agentId.length > MAX_ID_LENGTH
  ) {
    throw new Error("BOT_INPUT_INVALID");
  }
  return agentId;
}

type AudienceParseResult =
  | { readonly kind: "team"; readonly audience: BotPublishTeamAudience }
  | { readonly kind: "unsupported" };

/**
 * 受众纯校验（不触库）：缺失/形状问题的响亮拒绝在此抛出；词表与策略拒绝
 * 以判别结果返回，由调用方转为 verdict（顺序：受众校验先于任何数据库
 * 事实——校验只关于请求自身，不泄露归属存在性）。
 */
function parseAudience(
  audience: BotPublishAudience | null | undefined,
): AudienceParseResult {
  if (audience === null || audience === undefined) {
    throw new Error("PUBLISH_AUDIENCE_REQUIRED");
  }
  if (typeof audience !== "object" || Array.isArray(audience)) {
    throw new Error("PUBLISH_AUDIENCE_INVALID");
  }
  const candidate = audience as { readonly type?: unknown };
  if (typeof candidate.type !== "string" || candidate.type.trim() === "") {
    throw new Error("PUBLISH_AUDIENCE_INVALID");
  }
  if (candidate.type !== "team") {
    return { kind: "unsupported" };
  }
  const team = audience as BotPublishTeamAudience;
  if (
    typeof team.tenantId !== "string" ||
    team.tenantId.trim() === "" ||
    team.tenantId.length > MAX_ID_LENGTH ||
    typeof team.workspaceId !== "string" ||
    team.workspaceId.trim() === "" ||
    team.workspaceId.length > MAX_ID_LENGTH
  ) {
    throw new Error("PUBLISH_AUDIENCE_INVALID");
  }
  return { kind: "team", audience: Object.freeze({ ...team }) };
}

/** 深冻结：调用方拿到不可变快照（与 MT014/MT016 输出同一纪律）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface BotPublishService {
  /**
   * 发布为团队公共：owner 动作。受众必须显式给出且指向归属团队；注册行
   * 落为 visibility='workspace' 后，团队成员按 MT009 规则获得 read/run。
   */
  publishBot(
    scope: PlatformScope,
    agentId: string,
    audience: BotPublishAudience | null | undefined,
  ): Promise<BotPublishVerdict>;
  /**
   * 取消发布：owner 动作。注册行 visibility 回 NULL，团队公共使用路径
   * 立即关闭（下一次判定即 not-found）；显式 grant 与归属可见性不受影响。
   * 幂等。
   */
  unpublishBot(
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotUnpublishVerdict>;
}

/**
 * 装配入口。发布/取消发布都是写动作——只依赖已验证 operator 通道；
 * 未验证通道在装配时拒绝（UNVERIFIED_DATABASE_CAPABILITY）。
 */
export function createBotPublishService(channels: {
  readonly operator: OperatorDatabase;
}): BotPublishService {
  assertOperatorDatabase(channels.operator);
  const { operator } = channels;

  type Tx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (
    tx: Tx,
    scope: {
      readonly tenantId: string;
      readonly workspaceId?: string;
      readonly principalId?: string;
      readonly actorId?: string;
    },
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId ?? ""}, true), set_config('app.principal_id', ${scope.principalId ?? ""}, true), set_config('app.user_id', ${scope.actorId ?? ""}, true)`,
    );
  };

  /** 锁序：tenant → principal → membership → workspace-membership。 */
  const baseLockKeys = (scope: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly workspaceId: string;
  }): readonly string[] => [
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
  ];

  const takeLocks = async (
    tx: Tx,
    keys: readonly { readonly key: string; readonly exclusive: boolean }[],
  ): Promise<void> => {
    for (const { key, exclusive } of keys) {
      await tx.execute(
        exclusive
          ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const botLockKey = (tenantId: string, agentId: string): string =>
    JSON.stringify(["enterprise", "bot", tenantId, agentId]);

  const resourceLockKey = (tenantId: string, resourceId: string): string =>
    JSON.stringify(["enterprise", "resource", tenantId, resourceId]);

  /**
   * 归属可见性门（MT016 readVisibleOwnership 同款事实切片，本模块本地
   * 镜像——bots-ownership.ts 是已验收交付，本票不改其文件）：行存在
   * （RLS 租户过滤后）+ status='active' + 行 workspace 与受信 scope 同
   * 团队 + 调用者公司成员（active + epoch 匹配签发时版本）与团队成员
   * active。任一不成立 → null（canonical not-found 的唯一来源）。
   * 额外带回 displayName 与 owner，供注册行落库与 owner 门使用。
   */
  const readVisibleOwnership = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ): Promise<{
    readonly displayName: string;
    readonly ownerPrincipalId: string;
  } | null> => {
    const [row] = await tx
      .select({
        workspaceId: enterpriseBotOwnership.workspaceId,
        ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
        displayName: enterpriseBotOwnership.displayName,
        status: enterpriseBotOwnership.status,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseBotOwnership)
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseBotOwnership.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            enterpriseBotOwnership.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, enterpriseBotOwnership.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseBotOwnership.tenantId, scope.tenantId),
          eq(enterpriseBotOwnership.agentId, agentId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      row.status !== "active" ||
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    return {
      displayName: row.displayName,
      ownerPrincipalId: row.ownerPrincipalId,
    };
  };

  /** 注册行读取（operator 角色、租户 RLS + app.resource_id 行策略上下文）。 */
  const readRegistration = async (
    tx: Tx,
    tenantId: string,
    agentId: string,
  ): Promise<{
    readonly kind: string;
    readonly workspaceId: string;
    readonly status: string;
    readonly visibility: string | null;
    readonly revision: number;
    readonly aclEpoch: number;
  } | null> => {
    const [row] = await tx
      .select({
        kind: enterpriseResources.kind,
        workspaceId: enterpriseResources.workspaceId,
        status: enterpriseResources.status,
        visibility: enterpriseResources.visibility,
        revision: enterpriseResources.revision,
        aclEpoch: enterpriseResources.aclEpoch,
      })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, agentId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  return {
    async publishBot(scope, agentId, audience) {
      // 输入形状先于信任判定：缺公司/团队上下文与未签发 scope 得到各自的
      // 明确拒绝码（两者都是响亮拒绝，顺序不泄露任何信息）。
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertBotIdentity(agentId);
      // 受众纯校验（不触库）：缺失/形状问题在此响亮抛出；词表拒绝转为
      // verdict——校验只关于请求自身，先于任何数据库事实，不泄露归属。
      const parsed = parseAudience(audience);
      if (parsed.kind === "unsupported") {
        return Object.freeze({
          outcome: "deny",
          code: "PUBLISH_AUDIENCE_UNSUPPORTED",
        });
      }
      const audienceTeam = parsed.audience;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 锁序：基础键共享 → bot 共享（钉住归属事实）→ resource 排他
        // （注册行的发布写，与判定读/迁移写串行化）。
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: false },
          {
            key: resourceLockKey(scope.tenantId, agentId),
            exclusive: true,
          },
        ]);
        const ownership = await readVisibleOwnership(tx, scope, agentId);
        if (!ownership) return notFoundVerdict();
        if (ownership.ownerPrincipalId !== scope.principalId) {
          return Object.freeze({
            outcome: "deny",
            code: "PUBLISH_FORBIDDEN",
          });
        }
        // 受众策略：跨公司受众响亮拒绝（验收 4）；同公司跨团队受众同样
        // 响亮拒绝（默认团队公共规则只服务归属团队，Spec §5.1）。
        if (audienceTeam.tenantId !== scope.tenantId) {
          return Object.freeze({
            outcome: "deny",
            code: "PUBLISH_AUDIENCE_CROSS_COMPANY",
          });
        }
        if (audienceTeam.workspaceId !== scope.workspaceId) {
          return Object.freeze({
            outcome: "deny",
            code: "PUBLISH_AUDIENCE_NOT_OWNING_TEAM",
          });
        }
        // UPDATE 行策略要求 app.resource_id 匹配行（resource-visibility
        // 同款）；对同事务内后续注册行读写一并生效。
        await tx.execute(
          sql`select set_config('app.resource_id', ${agentId}, true)`,
        );
        const registration = await readRegistration(
          tx,
          scope.tenantId,
          agentId,
        );
        if (registration) {
          // 不变量守卫：注册行必须是本归属团队的本 Bot 注册——绝不静默
          // 改写他人种类的行。
          if (
            registration.kind !== "bot" ||
            registration.workspaceId !== scope.workspaceId
          ) {
            throw new Error("BOT_PUBLISH_STATE_CONFLICT");
          }
          if (
            registration.status === "active" &&
            registration.visibility === "workspace"
          ) {
            // 幂等：已是团队公共（不推进任何版本号）。
            return Object.freeze({
              outcome: "allow",
              publication: deepFreeze({
                agentId,
                audience: audienceTeam,
                revision: registration.revision,
                aclEpoch: registration.aclEpoch,
              }),
            });
          }
          const [updated] = await tx
            .update(enterpriseResources)
            .set({ visibility: "workspace" })
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                eq(enterpriseResources.id, agentId),
                eq(enterpriseResources.status, "active"),
              ),
            )
            .returning({
              revision: enterpriseResources.revision,
              aclEpoch: enterpriseResources.aclEpoch,
            });
          if (!updated) {
            // 注册行在锁内不可能消失；status 守卫未命中却无返回行属于
            // 不变量破坏，响亮拒绝。
            throw new Error("BOT_PUBLISH_STATE_CONFLICT");
          }
          return Object.freeze({
            outcome: "allow",
            publication: deepFreeze({
              agentId,
              audience: audienceTeam,
              revision: updated.revision,
              aclEpoch: updated.aclEpoch,
            }),
          });
        }
        // 无注册行：以归属行服务端事实落一行（display_name 取归属行，
        // kind='bot' 固定；客户端不能指定任何归属/种类属性）。workspace
        // 复合外键使跨租户行结构上不可能存在（纵深防御第二道）。
        const [inserted] = await tx
          .insert(enterpriseResources)
          .values({
            tenantId: scope.tenantId,
            id: agentId,
            workspaceId: scope.workspaceId,
            kind: "bot",
            displayName: ownership.displayName,
            visibility: "workspace",
          })
          .returning({
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
          });
        if (!inserted) {
          // 注册行刚在锁内核验过；无返回行属于不变量破坏，响亮拒绝
          //（与上方 update 分支同款）。
          throw new Error("BOT_PUBLISH_STATE_CONFLICT");
        }
        return Object.freeze({
          outcome: "allow",
          publication: deepFreeze({
            agentId,
            audience: audienceTeam,
            revision: inserted.revision,
            aclEpoch: inserted.aclEpoch,
          }),
        });
      });
    },

    async unpublishBot(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertBotIdentity(agentId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: false },
          {
            key: resourceLockKey(scope.tenantId, agentId),
            exclusive: true,
          },
        ]);
        const ownership = await readVisibleOwnership(tx, scope, agentId);
        if (!ownership) return notFoundVerdict();
        if (ownership.ownerPrincipalId !== scope.principalId) {
          return Object.freeze({
            outcome: "deny",
            code: "PUBLISH_FORBIDDEN",
          });
        }
        await tx.execute(
          sql`select set_config('app.resource_id', ${agentId}, true)`,
        );
        const registration = await readRegistration(
          tx,
          scope.tenantId,
          agentId,
        );
        // 不变量守卫与发布路径同款：漂移的注册行绝不触碰（先于幂等判定，
        // 非 active/非团队公共的漂移行同样响亮拒绝，不被幂等 allow 吞掉）。
        if (
          registration &&
          (registration.kind !== "bot" ||
            registration.workspaceId !== scope.workspaceId)
        ) {
          return Object.freeze({
            outcome: "deny",
            code: "BOT_PUBLISH_STATE_CONFLICT",
          });
        }
        // 幂等语义：无注册行 / 已软删 / 本就不是团队公共 → 已处于「非
        // 团队公共」目标态，allow（重复取消、从未发布都是合法重放）。
        if (
          registration?.status !== "active" ||
          registration.visibility !== "workspace"
        ) {
          return Object.freeze({ outcome: "allow" });
        }
        await tx
          .update(enterpriseResources)
          .set({ visibility: null })
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, agentId),
              eq(enterpriseResources.status, "active"),
              eq(enterpriseResources.visibility, "workspace"),
            ),
          );
        return Object.freeze({ outcome: "allow" });
      });
    },
  };
}
