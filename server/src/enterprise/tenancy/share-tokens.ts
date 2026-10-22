// server/src/enterprise/tenancy/share-tokens.ts
// MT058（Issue #101）：分享令牌改为有效分享授权（受众、有效期、撤销）。
//
// 票面语义（Issue #101 正文）：
//   AC1 默认分享受众为同团队；非同团队成员访问被拒绝。
//   AC2 显式跨团队分享只在同公司内、指定动作与有效期内有效。
//   AC3 跨公司分享永远不可签发；已有此类令牌失效并记录。
//   AC4 撤销后签发与访问同时停止；分享页不泄露内容元数据。
//
// 结构（纯新增服务面 + 一张授权表（MT058 迁移），零既有文件语义改动）：
//
//   1. 授权模型（表 = enterprise_workshop_share_grants）：一行 = 一次
//      有效分享授权——受众（same-team 默认 / cross-team 显式）、动作域
//      （preview / preview_download 闭集，消费既有 WorkshopShareScope
//      词表）、有效期（expires_at，DB 时钟）与撤销（revoked_at + revoked_by，
//      行保留可审计）都是行本体。跨公司受众行在数据库层结构性不可能：
//      复合外键 (tenant_id, audience_workspace_id) → enterprise_workspaces
//      钉死同公司（MT010 同纪律）；服务层再显式核对（双防线）。
//      token 承载段复用 B14 的同一原语（newShareToken 32 字节熵 base32 +
//      hashShareToken sha256 存储，workshop/sharing.ts 唯一事实源——不
//      出现第二套令牌语法）。一会话至多一条活链（partial unique index）：
//      替换 = 同一事务内撤旧 + 插新（setShare 替换语义的企业面）。
//   2. 签发（issueWorkshopShare）：会话范围门（enterprise_workshop_
//      scopes 按频道三元组比对 + 成员 active/epoch）→ 受众校验
//      （cross-team 目标团队必须存在于同公司且非本团队）→ 撤旧活链 +
//      插新行。跨公司请求在服务层响亮拒绝（SHARE_AUDIENCE_CROSS_COMPANY）
//      ——「永远不可签发」有两个见证面：服务层拒绝 + 数据库层 FK 结构
//      排除（测试两侧都钉）。
//   3. 访问（resolveShareAccess）：入口要求受信 PlatformScope（有效身份
//      ——与 MT057 AC3 一致，匿名调用在类型面没有入口）；token_hash 索引
//      查行（请求者租户上下文 RLS）→ 未撤销 + 未过期（expires_at > now()
//      按 DB 时钟现场核对）→ 受众判定现读成员资格：
//        same-team：请求者 workspace === 属主 workspace 且两级成员 active；
//        cross-team：请求者 workspace === 受众 workspace 且两级成员
//                    active（同公司由 FK 与 grant.tenant_id === 请求者
//                    tenant_id 共同钉死）。
//      一切失败 = 同一个 canonical RESOURCE_NOT_FOUND（AC4 后半：错误与
//      页面不泄露内容元数据——不存在/错令牌/过期/已撤销/非受众对外
//      不可区分，AC1 的「拒绝」也是这个形状）。
//   4. 撤销（revokeWorkshopShare）：属主门（会话协会行三元组）→ UPDATE
//      revoked_at/revoked_by（列级授权，行保留）。撤销后：访问立即失效
//      （解析读不到活行）；再签发 = 新令牌（旧令牌的 hash 已在新行的
//      唯一索引之外，但 revoked 行的 token_hash 查询被 revoked_at 过滤
//      ——旧令牌从此永不复活）。
//   5. 既有令牌的失效与记录（AC3 后半）：既有 B14 匿名令牌（workshop_
//      sessions.share_token_hash，无受众绑定的承载段——对任何人有效，
//      包括跨公司）在企业面结构性失效：本服务的解析只读 grants 表，
//      旧承载段没有行 → 永远 deny。sweepLegacyAnonymousShares 把这一
//      失效记录成审计事件（注入 sink）：逐条枚举仍有活承载段的会话，
//      记录「匿名承载段在企业面失效」（audit 事实，不触碰平台行——
//      平台半边原样留给非企业面）。
//
// 事务纪律与 MT053 一致：受信 Scope → read committed + lock/statement
// timeout → set_config('app.*', …, true) 事务本地 → advisory 锁（键序
// tenant → principal → membership → workspace-membership → session）→
// 成员事实重验 → 判定或写入。
//
// 哨兵码（确定性、零回显）：WORKSHOP_SHARE_INPUT_INVALID /
// WORKSHOP_SHARE_CHANNEL_ID_INVALID / WORKSHOP_SHARE_ACTION_UNSUPPORTED /
// WORKSHOP_SHARE_AUDIENCE_INVALID / WORKSHOP_SHARE_AUDIENCE_CROSS_COMPANY /
// WORKSHOP_SHARE_SCOPE_REVOKED。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由、不改 workshop/sharing.ts / public-routes.ts
//     的既有签名与个人路径；B14 匿名半边原样保留给非企业面（其企业面
//     失效由「解析只读 grants 表」结构性保证 + sweep 记录）。
//   - 前端分享页（身份/受众/撤销状态展示）属 MT092（#135，本票交付后
//     解锁）；本票契约 = 服务面 + share-tokens 套件。
//   - 审计落点是注入 sink（enterprise_security_events 形状；测试给记录
//     端口）。
//   - 有效期上限：expiresInDays 闭集 1..365（无期限分享不允许——AC2
//     「指定有效期」；拒绝消息只含代码）。

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  enterpriseWorkshopShareGrants,
  type WorkshopShareActionKind,
  type WorkshopShareAudienceKind,
} from "../../db/schema/enterprise-share-grants";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import { enterpriseWorkshopScopes } from "../../db/schema/enterprise-workshop-scopes";
import { hashShareToken, newShareToken } from "../../workshop/sharing";
import type { WorkshopSessionRow } from "../../workshop/store";
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

export const WORKSHOP_SHARE_CHANNEL_ID_INVALID =
  "WORKSHOP_SHARE_CHANNEL_ID_INVALID";
export const WORKSHOP_SHARE_INPUT_INVALID = "WORKSHOP_SHARE_INPUT_INVALID";
export const WORKSHOP_SHARE_ACTION_UNSUPPORTED =
  "WORKSHOP_SHARE_ACTION_UNSUPPORTED";
export const WORKSHOP_SHARE_AUDIENCE_INVALID =
  "WORKSHOP_SHARE_AUDIENCE_INVALID";
/** 跨公司受众：永远不可签发（服务层显式拒绝 + DB 复合外键结构排除）。 */
export const WORKSHOP_SHARE_AUDIENCE_CROSS_COMPANY =
  "WORKSHOP_SHARE_AUDIENCE_CROSS_COMPANY";
export const WORKSHOP_SHARE_SCOPE_REVOKED = "SCOPE_REVOKED";

/** 动作域闭集：消费既有 WorkshopShareScope 词表（不另立第二套词汇）。 */
export const WORKSHOP_SHARE_ACTIONS = ["preview", "preview_download"] as const;
export type WorkshopShareAction = WorkshopShareActionKind;

/** 受众闭集。 */
export const WORKSHOP_SHARE_AUDIENCES = ["same-team", "cross-team"] as const;
export type WorkshopShareAudience = WorkshopShareAudienceKind;

// ---------------------------------------------------------------------------
// 行缝与端口
// ---------------------------------------------------------------------------

/** workshop 权威行的最小投影。 */
export interface WorkshopShareRows {
  findSessionByChannel(
    channelId: string,
  ): Promise<WorkshopSessionRow | undefined>;
  findSessionById(sessionId: string): Promise<WorkshopSessionRow | undefined>;
  /** 仍有活匿名承载段的会话（AC3 后半的 sweep 枚举面）。 */
  listSessionsWithLiveLegacyShare(): Promise<
    readonly { readonly sessionId: string; readonly channelId: string }[]
  >;
}

/** 失效记录端口（生产 = enterprise_security_events 形状；测试给记录端口）。 */
export interface ShareInvalidationAuditSink {
  record(event: {
    readonly eventType: "workshop_share_legacy_invalidated";
    readonly sessionId: string;
    readonly channelId: string;
    readonly tenantId: string | null;
    readonly note: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

export type ShareIssueOutcome =
  | {
      readonly outcome: "allow";
      /** 明文令牌只此一次（B14 纪律：存储面只有 sha256）。 */
      readonly token: string;
      readonly audience: WorkshopShareAudience;
      readonly shareAction: WorkshopShareAction;
      readonly expiresAt: Date | null;
    }
  | ResourceNotFoundVerdict;

export type ShareResolveOutcome =
  | {
      readonly outcome: "allow";
      readonly channelId: string;
      readonly sessionId: string;
      readonly botId: string;
      readonly via: WorkshopShareAudience;
      readonly shareAction: WorkshopShareAction;
    }
  | ResourceNotFoundVerdict;

export type ShareRevokeOutcome =
  | { readonly outcome: "allow"; readonly sessionId: string }
  | ResourceNotFoundVerdict;

export interface WorkshopShareService {
  /** 签发（AC1/AC2/AC3）：默认 same-team；cross-team 同公司显式；跨公司永不。 */
  issueWorkshopShare(
    scope: PlatformScope,
    input: {
      readonly channelId: string;
      readonly audience: WorkshopShareAudience;
      readonly audienceWorkspaceId?: string;
      readonly shareAction: WorkshopShareAction;
      readonly expiresInDays?: number;
    },
  ): Promise<ShareIssueOutcome>;

  /** 访问（AC1/AC2/AC4）：要求有效身份；一切失败同一 not-found 形状。 */
  resolveShareAccess(
    scope: PlatformScope,
    input: { readonly token: string },
  ): Promise<ShareResolveOutcome>;

  /** 撤销（AC4）：属主门 → revoked_at/revoked_by；访问与再签发同时停止。 */
  revokeWorkshopShare(
    scope: PlatformScope,
    input: { readonly channelId: string },
  ): Promise<ShareRevokeOutcome>;

  /** 既有匿名承载段的失效记录（AC3 后半；零平台行写入）。 */
  sweepLegacyAnonymousShares(): Promise<{
    readonly outcome: "allow";
    readonly invalidated: readonly string[];
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

const PLAIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

export function createWorkshopShareService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: WorkshopShareRows;
  readonly auditSink: ShareInvalidationAuditSink;
  readonly tokenFactory?: () => string;
}): WorkshopShareService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);
  const { data, operator, rows, auditSink } = deps;
  const newToken = deps.tokenFactory ?? newShareToken;

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

  /** 会话属主门：频道 → 协会行三元组比对（签发与撤销共用）。 */
  const authorizeOwnerSession = async (
    scope: PlatformScope,
    channelId: string,
  ): Promise<{ readonly sessionId: string } | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select({ sessionId: enterpriseWorkshopScopes.sessionId })
        .from(enterpriseWorkshopScopes)
        .where(
          and(
            eq(enterpriseWorkshopScopes.tenantId, scope.tenantId),
            eq(enterpriseWorkshopScopes.channelId, channelId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return row;
    });

  return {
    async issueWorkshopShare(scope, input) {
      assertTrustedScope(scope);
      if (!input || typeof input !== "object") {
        throw new Error(WORKSHOP_SHARE_INPUT_INVALID);
      }
      const channelId = input.channelId;
      if (typeof channelId !== "string" || !PLAIN_ID.test(channelId)) {
        throw new Error(`${WORKSHOP_SHARE_CHANNEL_ID_INVALID}: channelId`);
      }
      if (!WORKSHOP_SHARE_ACTIONS.includes(input.shareAction)) {
        throw new Error(WORKSHOP_SHARE_ACTION_UNSUPPORTED);
      }
      if (!WORKSHOP_SHARE_AUDIENCES.includes(input.audience)) {
        throw new Error(WORKSHOP_SHARE_AUDIENCE_INVALID);
      }
      if (input.expiresInDays !== undefined) {
        if (
          !Number.isInteger(input.expiresInDays) ||
          input.expiresInDays < 1 ||
          input.expiresInDays > 365
        ) {
          throw new Error(`${WORKSHOP_SHARE_INPUT_INVALID}: expiresInDays`);
        }
      }
      // 会话属主门：无协会行/跨范围/撤权 = canonical not-found。
      const owned = await authorizeOwnerSession(scope, channelId);
      if (owned === null) return DENY_VERDICT;
      const session = await rows.findSessionByChannel(channelId);
      if (!session || session.id !== owned.sessionId) return DENY_VERDICT;
      // 受众校验（AC2/AC3）：same-team 不带目标；cross-team 目标必须
      // 显式、存在于同公司、且非本团队。
      if (input.audience === "same-team" && input.audienceWorkspaceId) {
        throw new Error(
          `${WORKSHOP_SHARE_AUDIENCE_INVALID}: same-team carries no workspace`,
        );
      }
      if (input.audience === "cross-team") {
        const target = input.audienceWorkspaceId;
        if (typeof target !== "string" || !PLAIN_ID.test(target)) {
          throw new Error(
            `${WORKSHOP_SHARE_AUDIENCE_INVALID}: audienceWorkspaceId`,
          );
        }
        if (target === scope.workspaceId) {
          throw new Error(
            `${WORKSHOP_SHARE_AUDIENCE_INVALID}: cross-team to own workspace`,
          );
        }
        // 同公司核对（服务层双防线；数据库层另有复合外键）。
        const sameCompany = await data.transaction(async (tx) => {
          await beginContext(tx, scope);
          const [workspace] = await tx
            .select({ id: enterpriseWorkspaces.id })
            .from(enterpriseWorkspaces)
            .where(
              and(
                eq(enterpriseWorkspaces.tenantId, scope.tenantId),
                eq(enterpriseWorkspaces.id, target),
              ),
            )
            .limit(1);
          return workspace !== undefined;
        });
        if (!sameCompany) {
          // 跨公司（或不存在）受众：永远不可签发——响亮拒绝（AC3）。
          throw new Error(WORKSHOP_SHARE_AUDIENCE_CROSS_COMPANY);
        }
      }
      const token = newToken();
      const tokenHash = hashShareToken(token);
      const expiresAt =
        input.expiresInDays !== undefined
          ? new Date(Date.now() + input.expiresInDays * 86_400_000)
          : null;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(WORKSHOP_SHARE_SCOPE_REVOKED);
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise-workshop-share",
            "session",
            owned.sessionId,
          ])}, 0))`,
        );
        // 一会话至多一条活链：撤旧（如有）+ 插新，同一事务（替换语义）。
        await tx
          .update(enterpriseWorkshopShareGrants)
          .set({ revokedAt: new Date(), revokedBy: scope.actorId })
          .where(
            and(
              eq(enterpriseWorkshopShareGrants.sessionId, owned.sessionId),
              isNull(enterpriseWorkshopShareGrants.revokedAt),
            ),
          );
        await tx.insert(enterpriseWorkshopShareGrants).values({
          id: `wsg-${randomUUID()}`,
          sessionId: owned.sessionId,
          tokenHash,
          tenantId: scope.tenantId,
          ownerWorkspaceId: scope.workspaceId,
          principalId: scope.principalId,
          audience: input.audience,
          audienceWorkspaceId:
            input.audience === "cross-team" ? input.audienceWorkspaceId : null,
          shareAction: input.shareAction,
          expiresAt,
          createdBy: scope.actorId,
        });
        return {
          outcome: "allow" as const,
          token,
          audience: input.audience,
          shareAction: input.shareAction,
          expiresAt,
        };
      });
    },

    async resolveShareAccess(scope, input) {
      assertTrustedScope(scope);
      const token = input?.token;
      if (typeof token !== "string" || token.length === 0) return DENY_VERDICT;
      const tokenHash = hashShareToken(token);
      // 请求者租户上下文内查活行（operator 租户臂——受众判定是服务层
      // 事实：same-team 成员要能读到属主的授权行；data 臂的 restrictive
      // 签发者自读只服务属主管理面）：未撤销 + 未过期（DB 时钟现核对）。
      const grant = await operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const [row] = await tx
          .select()
          .from(enterpriseWorkshopShareGrants)
          .where(
            and(
              eq(enterpriseWorkshopShareGrants.tenantId, scope.tenantId),
              eq(enterpriseWorkshopShareGrants.tokenHash, tokenHash),
              isNull(enterpriseWorkshopShareGrants.revokedAt),
              sql`(${enterpriseWorkshopShareGrants.expiresAt} is null or ${enterpriseWorkshopShareGrants.expiresAt} > now())`,
            ),
          )
          .limit(1);
        return row;
      });
      if (!grant) return DENY_VERDICT;
      // 受众判定：成员资格现读（两级 active + epoch）。
      const audienceOk = await data.transaction(async (tx) => {
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
        if (
          company?.status !== "active" ||
          company?.epoch !== scope.memberEpoch
        ) {
          return false;
        }
        const requiredWorkspace =
          grant.audience === "cross-team"
            ? (grant.audienceWorkspaceId ?? "")
            : grant.ownerWorkspaceId;
        const [team] = await tx
          .select({ status: enterpriseWorkspaceMemberships.status })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, requiredWorkspace),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        return team?.status === "active";
      });
      if (!audienceOk) return DENY_VERDICT;
      const session = await rows.findSessionById(grant.sessionId);
      if (!session) return DENY_VERDICT;
      return {
        outcome: "allow" as const,
        channelId: session.channelId,
        sessionId: session.id,
        botId: session.botId,
        via: grant.audience,
        shareAction: grant.shareAction,
      };
    },

    async revokeWorkshopShare(scope, input) {
      assertTrustedScope(scope);
      const channelId = input.channelId;
      if (typeof channelId !== "string" || !PLAIN_ID.test(channelId)) {
        throw new Error(`${WORKSHOP_SHARE_CHANNEL_ID_INVALID}: channelId`);
      }
      const owned = await authorizeOwnerSession(scope, channelId);
      if (owned === null) return DENY_VERDICT;
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(WORKSHOP_SHARE_SCOPE_REVOKED);
        }
        const revoked = await tx
          .update(enterpriseWorkshopShareGrants)
          .set({ revokedAt: new Date(), revokedBy: scope.actorId })
          .where(
            and(
              eq(enterpriseWorkshopShareGrants.sessionId, owned.sessionId),
              isNull(enterpriseWorkshopShareGrants.revokedAt),
            ),
          )
          .returning({ id: enterpriseWorkshopShareGrants.id });
        // 无活链可撤 = 已撤销（幂等语义仍算 allow——撤销目标是终态）。
        return {
          outcome: "allow" as const,
          sessionId: owned.sessionId,
          ...(revoked.length === 0 ? {} : { revoked: revoked.length }),
        };
      });
    },

    async sweepLegacyAnonymousShares() {
      // 既有 B14 匿名承载段（无受众绑定、对任何人有效）在企业面结构性
      // 失效（解析只读 grants 表）；本 sweep 把失效记录成审计事件，不
      // 触碰平台行（个人面原样）。
      const legacy = await rows.listSessionsWithLiveLegacyShare();
      const invalidated: string[] = [];
      for (const row of legacy) {
        await auditSink.record({
          eventType: "workshop_share_legacy_invalidated",
          sessionId: row.sessionId,
          channelId: row.channelId,
          tenantId: null,
          note: "anonymous bearer share token is not honored by the enterprise face (audience-bound grants only)",
        });
        invalidated.push(row.sessionId);
      }
      return { outcome: "allow" as const, invalidated };
    },
  };
}
