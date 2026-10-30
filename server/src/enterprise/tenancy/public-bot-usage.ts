// server/src/enterprise/tenancy/public-bot-usage.ts
// MT018（Issue #61）：使用团队公共 Bot 时保持使用者自己的会话与凭据。
//
// 票面语义：团队成员运行团队公共 Bot 时，产生的会话、个人连接与个人凭据
// 属于使用者本人，不会绑定为 Bot 创建者身份；创建者的私人凭据也不会因此
// 暴露给使用者。Scope boundary：公共 Bot 运行入口的身份解析、会话归属、
// 凭据选择规则。
//
// 结构（纯新增，只读消费既有出口，不改任何既有文件语义）：
//
//   1. 运行门组合原样承载：MT009 的 run 判定（版本门 / 发布事实 / 成员
//      资格 / 依赖有效性 / 唯一拒绝形状）经 createTeamResourceActionService
//      组合，deny 变体逐字透传（结构同形，绝不重新解释、绝不复刻判定）。
//      MT017 先例：受众动作的判定语义只有一处定义。
//   2. 绑定事实切片本地镜像（MT017 同款）：在本人事务内重验注册行
//      RLS 可见 + kind='bot' + visibility='workspace' + status='active' +
//      workspace=scope.workspace，以及公司成员资格 active 且 epoch 匹配、
//      团队成员关系 active——关闭 MT009 门事务与本事务之间的漂移窗
//      （Spec §5.2「一个业务事务中完成成员重验、团队重验、资源授权和
//      实际读写」）。这是纵深防御的第二道独立防线：跨公司行对本事务
//      不可见（事实即为「不存在」），纯判定内的租户/团队比对不信任
//      RLS 单点。
//   3. 身份解析 = 使用者本人：运行身份与会话归属主体一律取受信 scope 的
//      principalId（运行者），绝不解析为归属行 owner_principal_id。
//      创建者主体只在事务内部读取（存在性守卫：无活跃归属行的已发布
//      Bot = 漂移 → canonical not-found），绝不进入任何输出形状。
//   4. 会话归属 = 使用者个人会话：运行入口在 enterprise_conversations
//      落一行（tenant + scope.workspace + scope.principal + 派生
//      threadId），data 角色 RLS INSERT（MT021 个人会话可见性原样成立：
//      创建者对该行不可见）。threadId = `pubbot/{resourceId}/{principalId}/
//      {threadKey}` 内嵌使用者主体——多成员并发使用同一公共 Bot（同
//      threadKey）得到互不相交的会话（唯一索引 (tenant_id, thread_id)
//      不冲突）；同一成员重入同 key 幂等复用自己的会话行。get-or-create
//      后校验行主体 = 运行者，漂移 → PUBLIC_BOT_STATE_CONFLICT（响亮，
//      绝不静默改写他人会话行）。浏览器/沙箱状态引用属 MT052，不在
//      本票（诚实边界）。
//   5. 凭据选择 = 使用者本人的个人凭据：对 Bot 声明的每一条活跃凭据依赖
//      （enterprise_resource_dependencies kind='credential'），按 target=ref
//      精确匹配选取 classification='personal' 且 owner_principal_id=运行者
//      的活跃凭据（(created_at, id) 确定性序取首个）。任一依赖无本人凭据
//      → authorization-required 指明缺失 ref（按既有授权规则发起授权），
//      事务零写入（会话不建、凭据不取）——绝不回退到创建者同名 target
//      凭据，绝不静默降级。team/company 分类凭据与显式动作授权行不在本
//      入口的选择面内（MT027 判定面保持独立；放宽属后续票据语义）。
//
// 事务纪律与 MT008/MT009/MT016/MT021 判定入口完全一致：受信 Scope
// （assertTrustedScope）→ read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → advisory 共享锁（键序 tenant →
// principal → membership → workspace-membership → bot → resource →
// credential 按确定性 ref 序追加）。事实读取全部经受限 data 角色与真实
// RLS。输出形状零创建者材料：admitted 变体只含使用者身份、会话绑定与
// 本人凭据选择结果。
//
// 拒绝面（与全族一致）：不可见语义只有 canonical RESOURCE_NOT_FOUND 一种
// （不存在/跨公司/跨团队/未发布/已撤销/版本不含团队公共路径在对外语义上
// 不可区分）；输入形状响亮拒绝（RESOURCE_ID_INVALID / THREAD_KEY_INVALID，
// 错误只含代码，绝不回显值）；模块零 console、零 process.env。
//
// T06.01 追加（文件末节）：createAgentsBotResourceActions——agents 路由面
// 的资源动作端口组合出口（read/edit/publish/unpublish/run 五问的装配，
// 判定语义全部复用 MT008 注册表、MT017 发布、MT009 运行门与上面的 MT018
// 入口，本节零新判定）。

import { and, asc, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import { enterpriseCredentials } from "../../db/schema/enterprise-credentials";
import {
  enterpriseMemberships,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope, ScopeResolver } from "../contracts";
import {
  type BotPublishAudience,
  type BotPublishService,
  createBotPublishService,
} from "./bot-publish";
import {
  assertDataDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  parseResourceVisibility,
  type ResourcePolicyDecisionService,
} from "./resource-policy";
import { type WorkspaceGate, workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";
import {
  createTeamResourceActionService,
  type ResourceDependencyKind,
  type TeamResourceActionVerdict,
} from "./team-public-rules";

// ---------------------------------------------------------------------------
// 判定形状
// ---------------------------------------------------------------------------

/** 单条凭据依赖的选择结果（只含使用者本人的凭据事实）。 */
export interface PublicBotCredentialBinding {
  /** Bot 声明的依赖引用（target 精确匹配键）。 */
  readonly ref: string;
  /** 使用者本人的凭据 id。 */
  readonly credentialId: string;
  /** 选中凭据的分类（本入口只产出 'personal'）。 */
  readonly classification: "personal";
}

/**
 * 公共 Bot 运行入口判定。
 *
 *   - admitted：运行准入。会话绑定已落库（主体 = 使用者本人），全部凭据
 *     依赖解析为使用者本人凭据。
 *   - authorization-required：存在缺少本人凭据的凭据依赖（指明缺失 ref）。
 *     事务零写入——会话不建、凭据不取；按既有授权规则补齐后重入。
 *   - deny：MT009 run 判定的 deny 变体逐字透传（RESOURCE_NOT_FOUND /
 *     TEAM_PUBLIC_ACTION_FORBIDDEN / DEPENDENCY_INVALID）。
 */
export type PublicBotRunAdmission =
  | {
      readonly outcome: "admitted";
      readonly conversation: {
        readonly threadId: string;
        readonly ownedByPrincipalId: string;
      };
      readonly credentials: readonly PublicBotCredentialBinding[];
    }
  | {
      readonly outcome: "authorization-required";
      readonly missing: readonly { readonly ref: string }[];
    }
  | {
      readonly outcome: "deny";
      readonly code: "RESOURCE_NOT_FOUND";
    }
  | {
      readonly outcome: "deny";
      readonly code: "TEAM_PUBLIC_ACTION_FORBIDDEN";
      readonly action: "run";
    }
  | {
      readonly outcome: "deny";
      readonly code: "DEPENDENCY_INVALID";
      readonly dependencyKind: ResourceDependencyKind;
      readonly dependencyRef: string;
    };

const DENY_NOT_FOUND: PublicBotRunAdmission = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

// ---------------------------------------------------------------------------
// 输入形状校验：拒绝只含代码，绝不回显值
// ---------------------------------------------------------------------------

/** 与 MT016 assertBotIdentity 同源的 id 形状（长度上限对齐）。 */
const MAX_RESOURCE_ID_LENGTH = 256;
/** 调用方会话键：1..64 个可见字符。 */
const THREAD_KEY_MAX_LENGTH = 64;
/** 派生 threadId 与会话服务输入上限同源（supplied thread id ≤ 200）。 */
const MAX_THREAD_ID_LENGTH = 200;

function assertResourceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_RESOURCE_ID_LENGTH
  ) {
    throw new Error("RESOURCE_ID_INVALID");
  }
  return value;
}

/** 输入形状先于信任判定（MT017 先例）：缺公司/团队上下文得到各自明确的拒绝码。 */
function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertThreadKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > THREAD_KEY_MAX_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new Error("THREAD_KEY_INVALID");
  }
  return value;
}

/** 会话键派生：内嵌使用者主体——多成员并发不串用、同成员重入幂等。 */
function deriveThreadId(
  resourceId: string,
  principalId: string,
  threadKey: string,
): string {
  const threadId = `pubbot/${resourceId}/${principalId}/${threadKey}`;
  if (threadId.length > MAX_THREAD_ID_LENGTH) {
    throw new Error("THREAD_KEY_INVALID");
  }
  return threadId;
}

// ---------------------------------------------------------------------------
// 判定服务
// ---------------------------------------------------------------------------

export interface PublicBotUsageService {
  /**
   * 公共 Bot 运行入口：身份解析（使用者本人）、会话归属（个人会话落库）、
   * 凭据选择（本人个人凭据 / authorization-required）。
   */
  resolveRunEntry(
    scope: PlatformScope,
    input: { readonly resourceId: string; readonly threadKey: string },
  ): Promise<PublicBotRunAdmission>;
}

/** 事务句柄类型（与 resource-policy 判定入口同一形状的本地别名）。 */
type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

interface CredentialDependencyRow {
  readonly dependency_ref: string;
}

export function createPublicBotUsageService(
  data: DataDatabase,
): PublicBotUsageService {
  assertDataDatabase(data);
  // 运行门只有 MT009 一处定义：组合原样承载，deny 变体逐字透传。
  const teamActions = createTeamResourceActionService(
    data,
    createShippedResourcePolicyRegistry(),
  );

  const resolveRunEntry = async (
    scope: PlatformScope,
    input: { readonly resourceId: string; readonly threadKey: string },
  ): Promise<PublicBotRunAdmission> => {
    // 信任边界：只有签发入口产出的 Scope 能进入判定；上下文形状先于信任判定。
    assertScopeContext(scope);
    assertTrustedScope(scope);
    const resourceId = assertResourceId(input?.resourceId);
    const threadKey = assertThreadKey(input?.threadKey);

    // 运行门（版本门 / 发布事实 / 依赖有效性 / 唯一拒绝形状）原样组合；
    // deny 变体逐字透传（本入口只请求 run，动作事实不变）。
    const gate: TeamResourceActionVerdict = await teamActions.decideAction(
      scope,
      resourceId,
      "run",
    );
    if (gate.outcome === "deny") {
      if (gate.code === "RESOURCE_NOT_FOUND") {
        return { outcome: "deny", code: "RESOURCE_NOT_FOUND" };
      }
      if (gate.code === "TEAM_PUBLIC_ACTION_FORBIDDEN") {
        return {
          outcome: "deny",
          code: "TEAM_PUBLIC_ACTION_FORBIDDEN",
          action: "run",
        };
      }
      return {
        outcome: "deny",
        code: "DEPENDENCY_INVALID",
        dependencyKind: gate.dependencyKind,
        dependencyRef: gate.dependencyRef,
      };
    }

    return runEntryTransaction(data, scope, resourceId, async (tx) => {
      // 绑定事实切片本地镜像（纵深防御第二道防线）：RLS 使跨公司行对本
      // 事务不可见（事实即为「不存在」），随后的租户/团队/发布/活跃比对
      // 是独立于 MT009 门事务的重验——关闭两事务间的漂移窗。
      const [resourceRow] = await tx
        .select({
          workspaceId: enterpriseResources.workspaceId,
          kind: enterpriseResources.kind,
          visibility: enterpriseResources.visibility,
          status: enterpriseResources.status,
        })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, scope.tenantId),
            eq(enterpriseResources.id, resourceId),
          ),
        )
        .limit(1);
      if (
        resourceRow?.workspaceId !== scope.workspaceId ||
        resourceRow.kind !== "bot" ||
        parseResourceVisibility(resourceRow.visibility) !== "workspace" ||
        resourceRow.status !== "active"
      ) {
        return DENY_NOT_FOUND;
      }

      // 成员事实重验（MT016/MT021 判定入口同款切片）：公司成员 active 且
      // epoch === scope.memberEpoch（撤权递增 epoch，已签发 scope 立即
      // 失效）+ 团队成员关系 active。
      const [membershipRow] = await tx
        .select({
          memberStatus: enterpriseMemberships.status,
          memberEpoch: enterpriseMemberships.epoch,
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
            eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
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
        membershipRow?.memberStatus !== "active" ||
        membershipRow.memberEpoch !== scope.memberEpoch ||
        membershipRow.teamStatus !== "active"
      ) {
        return DENY_NOT_FOUND;
      }

      // 创建者主体只在事务内部读取：无活跃归属行的已发布 Bot = 漂移，
      // canonical not-found（绝不绑定、绝不输出）。
      const [ownershipRow] = await tx
        .select({ status: enterpriseBotOwnership.status })
        .from(enterpriseBotOwnership)
        .where(
          and(
            eq(enterpriseBotOwnership.tenantId, scope.tenantId),
            eq(enterpriseBotOwnership.agentId, resourceId),
          ),
        )
        .limit(1);
      if (ownershipRow?.status !== "active") {
        return DENY_NOT_FOUND;
      }

      // Bot 声明的活跃凭据依赖（确定性 ref 序；MT009 先例：依赖表无
      // drizzle schema 文件，raw SQL 读取）。
      const dependencyRows = (await tx.execute(sql`
        select dependency_ref
        from enterprise_resource_dependencies
        where tenant_id = ${scope.tenantId}
          and resource_id = ${resourceId}
          and dependency_kind = 'credential'
          and status = 'active'
        order by dependency_ref asc
      `)) as unknown;
      // 驱动返回形状回归时响亮拒绝，绝不静默折叠为空依赖列表
      //（空列表会让 Bot 在零凭据绑定下 admitted）。
      const dependencySource: unknown = Array.isArray(dependencyRows)
        ? dependencyRows
        : (dependencyRows as { rows?: unknown })?.rows;
      if (!Array.isArray(dependencySource)) {
        throw new TypeError("PUBLIC_BOT_DEPENDENCY_ROWS_INVALID");
      }
      const dependencyList =
        dependencySource as readonly CredentialDependencyRow[];

      // 凭据选择 = 使用者本人的个人凭据：target=ref 精确匹配、
      // (created_at, id) 确定性序取首个。创建者（或任何他人）的同名
      // target 凭据在谓词内被排除——结构性不借用。
      const bindings: PublicBotCredentialBinding[] = [];
      const missing: { readonly ref: string }[] = [];
      for (const row of dependencyList) {
        const ref = row.dependency_ref;
        const [selected] = await tx
          .select({
            id: enterpriseCredentials.id,
            classification: enterpriseCredentials.classification,
          })
          .from(enterpriseCredentials)
          .where(
            and(
              eq(enterpriseCredentials.tenantId, scope.tenantId),
              eq(enterpriseCredentials.status, "active"),
              eq(enterpriseCredentials.classification, "personal"),
              eq(enterpriseCredentials.ownerPrincipalId, scope.principalId),
              eq(enterpriseCredentials.target, ref),
            ),
          )
          .orderBy(
            asc(enterpriseCredentials.createdAt),
            asc(enterpriseCredentials.id),
          )
          .limit(1);
        if (!selected) {
          missing.push(Object.freeze({ ref }));
          continue;
        }
        // 选中凭据的确定性共享锁（ref 序追加，键形与 MT027 判定入口同族）。
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtextextended(${JSON.stringify(["enterprise", "credential", scope.tenantId, selected.id])}, 0))`,
        );
        bindings.push(
          Object.freeze({
            ref,
            credentialId: selected.id,
            classification: "personal" as const,
          }),
        );
      }

      // 缺失 → authorization-required：按既有规则请求授权，事务零写入
      // （会话不建、凭据不取），绝不借用创建者凭据、绝不静默降级。
      if (missing.length > 0) {
        return Object.freeze({
          outcome: "authorization-required" as const,
          missing: Object.freeze(missing),
        });
      }

      // 会话归属 = 使用者个人会话：get-or-create（唯一索引
      // (tenant_id, thread_id)；threadId 内嵌使用者主体），行主体漂移
      // 响亮拒绝。
      const threadId = deriveThreadId(resourceId, scope.principalId, threadKey);
      await tx
        .insert(enterpriseConversations)
        .values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          threadId,
        })
        .onConflictDoNothing();
      const [conversationRow] = await tx
        .select({ principalId: enterpriseConversations.principalId })
        .from(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, scope.tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        )
        .limit(1);
      if (conversationRow?.principalId !== scope.principalId) {
        throw new Error("PUBLIC_BOT_STATE_CONFLICT");
      }

      return Object.freeze({
        outcome: "admitted" as const,
        conversation: Object.freeze({
          threadId,
          ownedByPrincipalId: scope.principalId,
        }),
        credentials: Object.freeze(bindings),
      });
    });
  };

  return Object.freeze({ resolveRunEntry });
}

// ---------------------------------------------------------------------------
// 判定事务：形状与 MT008/MT009 判定入口一致（纵深防御的同一键族）
// ---------------------------------------------------------------------------

async function runEntryTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  resourceId: string,
  operation: (tx: DataTx) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership →
    // bot → resource（与 resource-policy/team-public-rules 判定入口同一
    // 键序与键形，共享锁；credential 锁在选定后按确定性 ref 序追加）。
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
      JSON.stringify(["enterprise", "bot", scope.tenantId, resourceId]),
      JSON.stringify(["enterprise", "resource", scope.tenantId, resourceId]),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
    return operation(tx);
  });
}

// ---------------------------------------------------------------------------
// T06.01：agents 路由面的资源动作端口（组合出口，零新判定）
// ---------------------------------------------------------------------------

/*
 * The agents HTTP surface's enterprise gate, composed from the family's real
 * decision services — nothing new is decided here:
 *
 *   - the trusted scope comes from the wired resolver (issuance is the
 *     resolver's own transaction, exactly as every other consumer);
 *   - the T03.01 workspace gate revalidates the scope live: under ba
 *     authority it compares `enterprise_principals.identity_generation`
 *     against the scope's `identityGeneration` and the company/team clocks
 *     against the scope's stamped epochs/generations — the comparison lives
 *     in the gate, one definition, never re-implemented here;
 *   - read is the MT008 policy registry (grant or team-public, the tenant's
 *     own policy revision), publish/unpublish are the MT017 owner actions,
 *     run is the MT018 entry above (MT009 gate + own session + own
 *     credentials).
 *
 * Refusals fold to the surface's canonical shapes: a scope that cannot be
 * minted or revalidated means the caller has no enterprise view, which is
 * `RESOURCE_NOT_FOUND` — never a fallback, never a default identity. The
 * port returns null only when the enterprise registry holds no fact about
 * the Bot (no ownership row and no registration row): such a Bot keeps the
 * legacy surface's behavior, which is what a not-yet-migrated deployment
 * expects.
 *
 * The shape is the structural twin of `BotResourceActions` in
 * agents/routes.ts — this module deliberately does not import the M03 file,
 * and that one does not import this: the assembly wires them together.
 */

/** Resolver refusals that mean "no enterprise view for this caller". */
const RESOLVER_REFUSALS = new Set([
  "AUTH_REQUIRED",
  "TENANT_REQUIRED",
  "WORKSPACE_REQUIRED",
  "TENANT_FORBIDDEN",
  "WORKSPACE_FORBIDDEN",
  "SCOPE_REVOKED",
  "RESOURCE_NOT_FOUND",
]);

/** The agents-surface decision vocabulary (routes.ts BotResourceActionDecision). */
export type AgentsBotActionDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" }
  | { readonly outcome: "deny"; readonly code: "ACTION_FORBIDDEN" }
  | {
      readonly outcome: "deny";
      readonly code:
        | "PUBLISH_AUDIENCE_UNSUPPORTED"
        | "PUBLISH_AUDIENCE_CROSS_COMPANY"
        | "PUBLISH_AUDIENCE_NOT_OWNING_TEAM";
    };

/** The agents-surface run-entry vocabulary (routes.ts BotRunEntryDecision). */
export type AgentsBotRunDecision =
  | {
      readonly outcome: "admitted";
      readonly threadId: string;
      readonly ownedByPrincipalId: string;
      readonly credentials: readonly PublicBotCredentialBinding[];
    }
  | {
      readonly outcome: "authorization-required";
      readonly missing: readonly { readonly ref: string }[];
    }
  | {
      readonly outcome: "deny";
      readonly code:
        | "RESOURCE_NOT_FOUND"
        | "ACTION_FORBIDDEN"
        | "DEPENDENCY_INVALID";
      readonly dependencyKind?: ResourceDependencyKind;
      readonly dependencyRef?: string;
    };

/** The port the agents routes consume (structural twin; see the note above). */
export interface AgentsBotResourceActions {
  authorize(
    request: Request,
    agentId: string,
    action: "read" | "edit",
  ): Promise<AgentsBotActionDecision | null>;
  publish(
    request: Request,
    agentId: string,
  ): Promise<AgentsBotActionDecision | null>;
  unpublish(
    request: Request,
    agentId: string,
  ): Promise<AgentsBotActionDecision | null>;
  admitRun(
    request: Request,
    agentId: string,
    input: { readonly threadKey: string },
  ): Promise<AgentsBotRunDecision>;
}

/** What the assembly wires: the real channels plus the two T03.01 ports. */
export interface AgentsBotResourceActionsDeps {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  /** The trusted-scope issuance (createBaScopeResolver / createScopeResolver). */
  readonly resolveScope: Pick<ScopeResolver, "resolve">;
  /** The live revalidation (createBaWorkspaceGate / createWorkspaceGate). */
  readonly gate: Pick<WorkspaceGate, "transaction">;
}

const ACTION_ALLOW = Object.freeze({ outcome: "allow" } as const);
const ACTION_NOT_FOUND = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
} as const);
const ACTION_FORBIDDEN = Object.freeze({
  outcome: "deny",
  code: "ACTION_FORBIDDEN",
} as const);

/** The MT016 ownership slice the routing question needs (owner or not). */
interface BotRegistrationFacts {
  readonly owned: boolean;
  readonly registered: boolean;
}

export function createAgentsBotResourceActions(
  deps: AgentsBotResourceActionsDeps,
): AgentsBotResourceActions {
  assertDataDatabase(deps.data);
  const publish: BotPublishService = createBotPublishService({
    operator: deps.operator,
  });
  const usage = createPublicBotUsageService(deps.data);
  const policy: ResourcePolicyDecisionService = createResourcePolicyService(
    deps.data,
    createShippedResourcePolicyRegistry(),
  );

  /**
   * Mint + live-revalidate, or null: a scope the resolver refuses or the gate
   * revokes leaves the caller with no enterprise view — canonical not-found,
   * never a fallback to some other identity.
   */
  const revalidatedScope = async (
    request: Request,
  ): Promise<PlatformScope | null> => {
    let scope: PlatformScope;
    try {
      scope = await deps.resolveScope.resolve(request);
    } catch (error) {
      if (error instanceof Error && RESOLVER_REFUSALS.has(error.message)) {
        return null;
      }
      throw error;
    }
    try {
      await deps.gate.transaction(scope, async () => undefined);
      return scope;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "SCOPE_REVOKED" ||
          error.message === "WORKSPACE_REVOKED")
      ) {
        return null;
      }
      throw error;
    }
  };

  /** Ownership/registration facts under the caller's own RLS context. */
  const registrationOf = async (
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotRegistrationFacts> => {
    return deps.data.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
      );
      const [ownership] = await tx
        .select({
          workspaceId: enterpriseBotOwnership.workspaceId,
          ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
          status: enterpriseBotOwnership.status,
        })
        .from(enterpriseBotOwnership)
        .where(
          and(
            eq(enterpriseBotOwnership.tenantId, scope.tenantId),
            eq(enterpriseBotOwnership.agentId, agentId),
          ),
        )
        .limit(1);
      const [resource] = await tx
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, scope.tenantId),
            eq(enterpriseResources.id, agentId),
          ),
        )
        .limit(1);
      return {
        owned:
          ownership?.status === "active" &&
          ownership.workspaceId === scope.workspaceId &&
          ownership.ownerPrincipalId === scope.principalId,
        registered: resource != null,
      };
    });
  };

  /** The publish verdicts folded to the surface vocabulary. */
  const publishDecision = (
    verdict:
      | { readonly outcome: "allow" }
      | { readonly outcome: "deny"; readonly code: string },
  ): AgentsBotActionDecision => {
    if (verdict.outcome === "allow") return ACTION_ALLOW;
    if (verdict.code === "RESOURCE_NOT_FOUND") return ACTION_NOT_FOUND;
    if (verdict.code === "PUBLISH_FORBIDDEN") return ACTION_FORBIDDEN;
    // Audience refusals carry their own codes; a drifted registration row
    // (BOT_PUBLISH_STATE_CONFLICT) is fail-closed to the same refusal.
    if (verdict.code.startsWith("PUBLISH_AUDIENCE_")) {
      return { outcome: "deny", code: verdict.code } as AgentsBotActionDecision;
    }
    return ACTION_FORBIDDEN;
  };

  return {
    async authorize(request, agentId, action) {
      const scope = await revalidatedScope(request);
      if (!scope) return ACTION_NOT_FOUND;
      const facts = await registrationOf(scope, agentId);
      if (!facts.owned && !facts.registered) return null;
      if (action === "read") {
        if (facts.owned) return ACTION_ALLOW;
        return policy.decide(scope, agentId);
      }
      if (facts.owned) return ACTION_ALLOW;
      // Visible but not the owner's: the team surface offers use, not edits —
      // and a company admin's role is not content management (Spec §4.1).
      const visible = await policy.decide(scope, agentId);
      return visible.outcome === "allow" ? ACTION_FORBIDDEN : ACTION_NOT_FOUND;
    },

    async publish(request, agentId) {
      const scope = await revalidatedScope(request);
      if (!scope) return ACTION_NOT_FOUND;
      const facts = await registrationOf(scope, agentId);
      if (!facts.owned && !facts.registered) return null;
      const audience: BotPublishAudience = {
        type: "team",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      };
      return publishDecision(
        await publish.publishBot(scope, agentId, audience),
      );
    },

    async unpublish(request, agentId) {
      const scope = await revalidatedScope(request);
      if (!scope) return ACTION_NOT_FOUND;
      const facts = await registrationOf(scope, agentId);
      if (!facts.owned && !facts.registered) return null;
      return publishDecision(await publish.unpublishBot(scope, agentId));
    },

    async admitRun(request, agentId, input) {
      const scope = await revalidatedScope(request);
      if (!scope) return ACTION_NOT_FOUND;
      const admission = await usage.resolveRunEntry(scope, {
        resourceId: agentId,
        threadKey: input.threadKey,
      });
      if (admission.outcome === "admitted") {
        return Object.freeze({
          outcome: "admitted" as const,
          threadId: admission.conversation.threadId,
          ownedByPrincipalId: admission.conversation.ownedByPrincipalId,
          credentials: admission.credentials,
        });
      }
      if (admission.outcome === "authorization-required") {
        return Object.freeze({
          outcome: "authorization-required" as const,
          missing: admission.missing,
        });
      }
      if (admission.code === "RESOURCE_NOT_FOUND") return ACTION_NOT_FOUND;
      if (admission.code === "TEAM_PUBLIC_ACTION_FORBIDDEN") {
        return ACTION_FORBIDDEN;
      }
      return Object.freeze({
        outcome: "deny" as const,
        code: "DEPENDENCY_INVALID" as const,
        dependencyKind: admission.dependencyKind,
        dependencyRef: admission.dependencyRef,
      });
    },
  };
}
