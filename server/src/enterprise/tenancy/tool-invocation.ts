// server/src/enterprise/tenancy/tool-invocation.ts
// MT032（Issue #75）：工具调用时重新校验当前用户连接与 Bot 授权。
//
// 票面语义：每次工具调用都按当前用户的连接与 Bot 授权重新校验，因此
// 撤销授权、退出团队或停用连接会立即让工具不可用，即使会话仍在进行。
//
// 结构（纯新增，零 schema 对象，只读消费 MT016/MT017/MT027 既有事实，
// 不改任何既有文件）：
//
//   1. 单一判定入口 authorizeToolInvocation：每次调用一个全新 data
//      事务（AC3 的结构保证——判定从不落缓存，跨用户/跨范围交错调用
//      各自得到独立结论）。
//   2. Bot 授权门：本人归属 Bot（bot_ownership 行 + workspace 匹配）
//      ∨ 团队公共 Bot（MT017 发布注册行 kind='bot' + visibility=
//      'workspace' + 同团队）——公共 Bot 场景下工具调用仍以**使用者
//      本人**的连接与凭据为准（MT018 同源），绝不落到创建者的连接。
//   3. 连接门（AC2）：enterprise_credentials 行 + MT027 动作行的
//      'use' 授权。他人的连接对当前 scope canonical not-found
//      （RLS 租户臂 + owner/classification 判定；"他人连接"与"不存
//      在"对外同形，AC4 不泄露存在性）；本人连接但 'use' 授权已被
//      撤销（动作行删除，MT010 语义：删除即失效）→ 明确可解释码
//      CREDENTIAL_USE_NOT_GRANTED（连接是本人的，不泄他人事实）。
//   4. 撤销立即生效（AC1）：Bot 撤销（MT017 unpublish）与连接授权
//      撤销（动作行删除）都是数据事实——下一次调用的事务内重验必然
//      看到新事实；撤权（MT006 停用，epoch 递增）使 scope 本身死亡。
//
// 拒绝形状（AC4 的可解释与不泄露的边界）：
//   - 不可见（跨公司/跨团队/他人连接/不存在）→ MT011 canonical
//     RESOURCE_NOT_FOUND，逐字节同形；
//   - 可见但无权（本人连接无 use 授权；Bot 未发布且非本人）→ 明确
//     业务码（TOOL_CREDENTIAL_NOT_USABLE / TOOL_BOT_NOT_USABLE）——
//     能看到这一步已说明对象对调用者可见，码不泄露他人事实。
//
// 事务纪律与 MT019/MT020/MT023/MT024/MT025 一致；本模块是判定面
// （零写入），读路径走受限 data 角色与真实 RLS。
//
// 边界（诚实披露）：
//   - 工具的实际执行（协议适配、参数传递）不在本票：本模块是每次
//     调用的授权判定面，接线票在传输层消费；
//   - 会话级"进行中"状态不单独建模：会话仍在进行 = 同一 scope 继续
//     发起下一次调用，AC1 的语义即下一次调用的事务重验。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseCredentialActions,
  enterpriseCredentials,
} from "../../db/schema/enterprise-credentials";
import {
  enterpriseMemberships,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与判定形状
// ---------------------------------------------------------------------------

export type ToolInvocationDecision =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | { readonly outcome: "deny"; readonly code: "TOOL_BOT_NOT_USABLE" }
  | { readonly outcome: "deny"; readonly code: "TOOL_CREDENTIAL_NOT_USABLE" };

export interface ToolInvocationInput {
  /** 目标 Bot（工具的宿主）。 */
  readonly agentId: string;
  /** 工具名（判定面记录用；闭集校验属工具注册表，接线票范围）。 */
  readonly toolName: string;
  /** 本次调用使用的连接；缺省 = 无凭据工具调用（只过 Bot 门）。 */
  readonly credentialId?: string;
}

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertAgentId(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.trim().length === 0 ||
    agentId.length > 256
  ) {
    throw new Error("AGENT_ID_INVALID");
  }
  return agentId;
}

function assertToolName(toolName: string): string {
  if (
    typeof toolName !== "string" ||
    toolName.trim().length === 0 ||
    toolName.length > 200
  ) {
    throw new Error("TOOL_NAME_INVALID");
  }
  return toolName;
}

function assertCredentialId(credentialId: string): string {
  if (
    typeof credentialId !== "string" ||
    credentialId.trim().length === 0 ||
    credentialId.length > 256
  ) {
    throw new Error("CREDENTIAL_ID_INVALID");
  }
  return credentialId;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface ToolInvocationService {
  /**
   * 每次工具调用的授权判定（唯一判定源；零写入、零缓存——每次调用
   * 一个全新事务重验全部事实）。
   */
  authorizeToolInvocation(
    scope: PlatformScope,
    input: ToolInvocationInput,
  ): Promise<ToolInvocationDecision>;
}

export function createToolInvocationService(channels: {
  readonly data: DataDatabase;
}): ToolInvocationService {
  assertDataDatabase(channels.data);
  const { data } = channels;

  return {
    async authorizeToolInvocation(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input || typeof input !== "object") {
        throw new Error("TOOL_INPUT_INVALID");
      }
      assertAgentId(input.agentId);
      assertToolName(input.toolName);
      if (input.credentialId !== undefined) {
        assertCredentialId(input.credentialId);
      }
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );

        // ---- 门 0：调用者自身事实（每事务重验；撤权即死）。 ----
        const [member] = await tx
          .select({
            companyStatus: enterpriseMemberships.status,
            companyEpoch: enterpriseMemberships.epoch,
            teamStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(enterpriseMemberships)
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(
                enterpriseWorkspaceMemberships.tenantId,
                enterpriseMemberships.tenantId,
              ),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(
                enterpriseWorkspaceMemberships.principalId,
                enterpriseMemberships.principalId,
              ),
            ),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (
          !member ||
          member.companyStatus !== "active" ||
          member.companyEpoch !== scope.memberEpoch ||
          member.teamStatus !== "active"
        ) {
          return notFoundVerdict();
        }

        // ---- 门 1：Bot 使用授权（本人归属 ∨ 团队发布）。 ----
        const [bot] = await tx
          .select({
            status: enterpriseBotOwnership.status,
            workspaceId: enterpriseBotOwnership.workspaceId,
            ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
          })
          .from(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.agentId, input.agentId),
            ),
          )
          .limit(1);
        if (!bot) return notFoundVerdict();
        const ownBot =
          bot.status === "active" &&
          bot.workspaceId === scope.workspaceId &&
          bot.ownerPrincipalId === scope.principalId;
        let botUsable = ownBot;
        if (!botUsable && bot.status === "active") {
          // 团队公共 Bot（MT017 发布注册行）：使用者自己的身份过门，
          // 连接与凭据永远按使用者本人判定（MT018）。
          const [publication] = await tx
            .select({ id: enterpriseResources.id })
            .from(enterpriseResources)
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                eq(enterpriseResources.id, input.agentId),
                eq(enterpriseResources.kind, "bot"),
                eq(enterpriseResources.workspaceId, scope.workspaceId),
                sql`${enterpriseResources.visibility} = 'workspace'`,
              ),
            )
            .limit(1);
          botUsable = publication !== undefined;
        }
        if (!botUsable) {
          return { outcome: "deny", code: "TOOL_BOT_NOT_USABLE" } as const;
        }

        // ---- 门 2：连接授权（AC2：只能是使用者本人的连接）。 ----
        if (input.credentialId === undefined) {
          return { outcome: "allow" } as const;
        }
        const [credential] = await tx
          .select({
            status: enterpriseCredentials.status,
            classification: enterpriseCredentials.classification,
            ownerPrincipalId: enterpriseCredentials.ownerPrincipalId,
            workspaceId: enterpriseCredentials.workspaceId,
          })
          .from(enterpriseCredentials)
          .where(
            and(
              eq(enterpriseCredentials.tenantId, scope.tenantId),
              eq(enterpriseCredentials.id, input.credentialId),
            ),
          )
          .limit(1);
        if (!credential || credential.status !== "active") {
          // 不存在与不可见同形（AC4）。
          return notFoundVerdict();
        }
        // 他人连接：canonical not-found——"连接属于别人"与"连接不
        // 存在"对外不可区分（不泄露他人连接是否存在）。
        const ownConnection =
          credential.classification === "personal" &&
          credential.ownerPrincipalId === scope.principalId;
        const ownTeamConnection =
          credential.classification === "team" &&
          credential.workspaceId === scope.workspaceId;
        if (!ownConnection && !ownTeamConnection) {
          return notFoundVerdict();
        }
        // 'use' 动作行（MT027）：删除即撤销、立即失效（MT010 语义）。
        const [useGrant] = await tx
          .select({ principalId: enterpriseCredentialActions.principalId })
          .from(enterpriseCredentialActions)
          .where(
            and(
              eq(enterpriseCredentialActions.tenantId, scope.tenantId),
              eq(enterpriseCredentialActions.credentialId, input.credentialId),
              eq(enterpriseCredentialActions.action, "use"),
              eq(enterpriseCredentialActions.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (!useGrant) {
          // 本人（或本团队）的连接但使用授权已撤销：可解释的明确码
          // （对象对调用者可见，码不泄露他人事实）。
          return {
            outcome: "deny",
            code: "TOOL_CREDENTIAL_NOT_USABLE",
          } as const;
        }
        return { outcome: "allow" } as const;
      });
    },
  };
}
