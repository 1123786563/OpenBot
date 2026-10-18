// server/src/enterprise/tenancy/shared-approvals.ts
// MT034（Issue #77）：共享账号审批——绑定对象、参数摘要与归属。
//
// 票面：共享账号的规则、申请与批准都锁定到具体对象、参数摘要与所属公司
// 团队；改了团队或改了参数就不能复用旧批准，跨范围审批无法生效。
//
// 验收四条的实现面：
//   AC1 批准只对锁定的对象与参数摘要有效：批准行在批准时固定四元组
//       (tenant, workspace, bot, install) + params_digest（服务端对提议
//       参数的规范序列化 sha256）。authorizeUse 每次在事务内现读批准行
//       并把当前声称参数的摘要与其逐字比对——参数变化 = 摘要不匹配 =
//       canonical deny（必须重新审批）；批准行不可变（零 UPDATE/DELETE
//       授权），不存在「改行复用」通道。摘要纯函数（可独立复算、可变异
//       靶向），客户端声称的摘要字段一律 INVALID（摘要只由服务端计算）。
//   AC2 切换团队后旧批准不被复用：authorizeUse 的读取谓词内嵌
//       workspace === scope.workspaceId——批准行锁定申请/批准时的团队
//       上下文，同一用户切到另一团队后四元组不匹配（AC2 专门测试钉死）。
//   AC3 跨公司申请与批准永远拒绝：申请行五条复合外键全部内嵌 tenant
//       （跨公司行结构性不可能，23503）；申请/使用判定经受限 data 通道
//       + RLS 租户 pin（他司对象不可见 = canonical RESOURCE_NOT_FOUND，
//       与「不存在」逐字节同形）；决定走受限 operator 通道 + 事务内
//       tenant_admin 重验（workspace-admin 先例），租户 pin 下他司请求
//       不可见——两个方向都无从下手。模块侧对象归属检查（bot/install
//       行的 workspace 与 scope 一致）是第二道独立防线（纵深防御）。
//   AC4 撤权后待处理申请不可被该用户继续操作，已批准动作按 MT029 重新
//       校验：每次申请/撤回/使用判定都在事务内现读公司成员资格
//       （status active + epoch === scope.memberEpoch，撤权递增 epoch，
//       已签发 scope 立即失效——MT005/MT018/MT029 同款）与团队成员
//       资格；withdraw 的 UPDATE 臂只认 (本人, pending)。已批准动作
//       携带 MT029 lease 时，authorizeUse 经注入的真实
//       createCredentialLeaseService.validate 在校验点重验（消费 MT029
//       seam，六道校验不复制第二份；lease 缺失/失效 → canonical deny，
//       fail-closed）。
//
// 事务纪律与 MT029 判定入口完全一致：受信 Scope（assertTrustedScope）→
// 受限 data 事务（read committed + lock/statement timeout + 事务本地
// set_config + advisory 共享锁，键序 tenant → principal → membership →
// workspace-membership → bot → install → request/approval）。管理决定
// 走受限 operator 通道 + 受信 CompanyAdminContext（WeakSet 信任面，
// workspace-admin 同款：事务内重验 tenant_admin + epoch + 主体状态）。
// 模块零 console、零 process.env；拒绝一律 canonical RESOURCE_NOT_FOUND
// （缺失/跨公司/跨团队/未批准/参数漂移/已决定对外不可区分）；输入形状
// 错误响亮拒绝（SHARED_APPROVAL_INVALID + 字段路径，绝不回显任何值）。

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import { enterprisePluginInstalls } from "../../db/schema/enterprise-plugins";
import {
  enterpriseSharedUseApprovals,
  enterpriseSharedUseRequests,
} from "../../db/schema/enterprise-shared-approvals";
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
import type {
  CredentialLeasePurpose,
  CredentialLeaseService,
} from "./credential-lease";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { parseRevocationCheckpoint } from "./revocation";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

/** 审批受众闭集（与部署级 shared-use 词表同源，不复制第二套语义）。 */
export type SharedAudience = "owner" | "people" | "team";

export type ApprovalMember = {
  readonly kind: "user" | "group";
  readonly value: string;
};

/** 批准锁定的参数事实：摘要只由这三维决定（服务端计算）。 */
export interface SharedApprovalParams {
  readonly audience: SharedAudience;
  readonly outsideInput: boolean;
  readonly members: readonly ApprovalMember[];
}

export type SharedApprovalReason =
  | "publish"
  | "trigger"
  | "grant"
  | "refused_call";

const AUDIENCES: readonly SharedAudience[] = ["owner", "people", "team"];
const REASONS: readonly SharedApprovalReason[] = [
  "publish",
  "trigger",
  "grant",
  "refused_call",
];
const MEMBER_KINDS: readonly ApprovalMember["kind"][] = ["user", "group"];
const MAX_MEMBERS = 64;
const ID_MAX = 256;

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

// ---------------------------------------------------------------------------
// 参数摘要（纯函数，变异测试靶向）
// ---------------------------------------------------------------------------

/** 规范序列化：成员按 (kind, value) 稳定排序，键名固定，无空白歧义。 */
export function sharedApprovalParamsDigest(
  params: SharedApprovalParams,
): string {
  const members = [...params.members].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    if (left.value !== right.value) return left.value < right.value ? -1 : 1;
    return 0;
  });
  const canonical = JSON.stringify({
    audience: params.audience,
    outsideInput: params.outsideInput === true,
    members: members.map((member) => ({
      kind: member.kind,
      value: member.value,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

function requireString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(code);
  }
  return value;
}

function rejectExtraKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`SHARED_APPROVAL_INVALID: unexpected field ${key}`);
    }
  }
}

function parseParams(value: unknown): SharedApprovalParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SHARED_APPROVAL_INVALID: params");
  }
  const params = value as Record<string, unknown>;
  rejectExtraKeys(params, ["audience", "outsideInput", "members"]);
  if (!AUDIENCES.includes(params.audience as SharedAudience)) {
    throw new Error("SHARED_APPROVAL_INVALID: params.audience");
  }
  if (typeof params.outsideInput !== "boolean") {
    throw new Error("SHARED_APPROVAL_INVALID: params.outsideInput");
  }
  if (!Array.isArray(params.members) || params.members.length > MAX_MEMBERS) {
    throw new Error("SHARED_APPROVAL_INVALID: params.members");
  }
  const members: ApprovalMember[] = params.members.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("SHARED_APPROVAL_INVALID: params.members");
    }
    const member = entry as Record<string, unknown>;
    rejectExtraKeys(member, ["kind", "value"]);
    if (!MEMBER_KINDS.includes(member.kind as ApprovalMember["kind"])) {
      throw new Error("SHARED_APPROVAL_INVALID: params.members");
    }
    return {
      kind: member.kind as ApprovalMember["kind"],
      value: requireString(
        member.value,
        "SHARED_APPROVAL_INVALID: params.members",
        ID_MAX,
      ),
    };
  });
  return {
    audience: params.audience as SharedAudience,
    outsideInput: params.outsideInput,
    members,
  };
}

// ---------------------------------------------------------------------------
// 判定事实（本事务内现读；全部经受限 data 角色与真实 RLS）
// ---------------------------------------------------------------------------

interface ApprovalFacts {
  readonly companyMembership: {
    readonly status: string;
    readonly epoch: number;
  } | null;
  readonly workspaceMembershipStatus: string | null;
  readonly bot: {
    readonly workspaceId: string;
    readonly status: string;
  } | null;
  readonly install: {
    readonly workspaceId: string;
    readonly status: string;
  } | null;
  readonly approval: {
    readonly id: string;
    readonly paramsDigest: string;
  } | null;
}

/**
 * 判定核心（纯函数，便于变异测试靶向）。
 *   - 成员资格存活：公司成员 active + epoch 匹配（撤权面，AC4）；
 *   - 团队成员 active（scope 团队上下文）；
 *   - bot/install 归属行 active 且 workspace 与 scope 一致（对象锁定 +
 *     团队锁定，AC2/AC3）；
 *   - 批准行存在且摘要与当前声称参数逐字一致（AC1：参数漂移拒绝）。
 */
function decideApproval(
  scope: PlatformScope,
  facts: ApprovalFacts,
  claimedDigest: string,
): boolean {
  if (!facts.companyMembership) return false;
  if (facts.companyMembership.status !== "active") return false;
  if (facts.companyMembership.epoch !== scope.memberEpoch) return false;
  if (facts.workspaceMembershipStatus !== "active") return false;
  if (facts.bot?.status !== "active") return false;
  if (facts.bot.workspaceId !== scope.workspaceId) return false;
  if (facts.install?.status !== "active") return false;
  if (facts.install.workspaceId !== scope.workspaceId) return false;
  if (!facts.approval) return false;
  return facts.approval.paramsDigest === claimedDigest;
}

// ---------------------------------------------------------------------------
// 判定事务：形状与 MT029 判定入口一致（纵深防御的同一键族）
// ---------------------------------------------------------------------------

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

async function approvalReadTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
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
    // 锁序：tenant → principal → membership → workspace-membership
    // （与 resource-policy/credential-ownership/credential-lease 判定入口
    // 同一键序与键形）。
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
    return operation(tx);
  });
}

function botLockKey(tenantId: string, agentId: string): string {
  return JSON.stringify(["enterprise", "bot", tenantId, agentId]);
}

function installLockKey(tenantId: string, installId: string): string {
  return JSON.stringify(["enterprise", "plugin-install", tenantId, installId]);
}

/**
 * 读取判定事实（调用方已在 approvalReadTransaction 内）。对象锁在寻址
 * 确定后追加（bot → install → 批准行）。全部事实经真实 RLS：跨公司行
 * 对本事务不可见（事实即为「不存在」），判定内的租户/团队比对是第二道
 * 独立防线（纵深防御）。
 */
async function readApprovalFacts(
  tx: DataTx,
  scope: PlatformScope,
  input: {
    readonly agentId: string;
    readonly installId: string;
    readonly paramsDigest: string | null;
  },
): Promise<ApprovalFacts> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${botLockKey(scope.tenantId, input.agentId)}, 0))`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${installLockKey(scope.tenantId, input.installId)}, 0))`,
  );
  const [membership] = await tx
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
  const [teamMembership] = await tx
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
  const [bot] = await tx
    .select({
      workspaceId: enterpriseBotOwnership.workspaceId,
      status: enterpriseBotOwnership.status,
    })
    .from(enterpriseBotOwnership)
    .where(
      and(
        eq(enterpriseBotOwnership.tenantId, scope.tenantId),
        eq(enterpriseBotOwnership.agentId, input.agentId),
      ),
    )
    .limit(1);
  const [install] = await tx
    .select({
      workspaceId: enterprisePluginInstalls.workspaceId,
      status: enterprisePluginInstalls.status,
    })
    .from(enterprisePluginInstalls)
    .where(
      and(
        eq(enterprisePluginInstalls.tenantId, scope.tenantId),
        eq(enterprisePluginInstalls.id, input.installId),
      ),
    )
    .limit(1);
  let approval: ApprovalFacts["approval"] = null;
  if (input.paramsDigest !== null) {
    const [row] = await tx
      .select({ id: enterpriseSharedUseApprovals.id })
      .from(enterpriseSharedUseApprovals)
      .where(
        and(
          eq(enterpriseSharedUseApprovals.tenantId, scope.tenantId),
          eq(enterpriseSharedUseApprovals.agentId, input.agentId),
          eq(enterpriseSharedUseApprovals.installId, input.installId),
          eq(enterpriseSharedUseApprovals.workspaceId, scope.workspaceId),
          eq(enterpriseSharedUseApprovals.paramsDigest, input.paramsDigest),
        ),
      )
      // 批准行不可变（零 UPDATE/DELETE 授权），同摘要多行时任一行同义。
      .limit(1);
    approval = row ? { id: row.id, paramsDigest: input.paramsDigest } : null;
  }
  return {
    companyMembership: membership ?? null,
    workspaceMembershipStatus: teamMembership?.status ?? null,
    bot: bot ?? null,
    install: install ?? null,
    approval,
  };
}

// ---------------------------------------------------------------------------
// 判定服务（受限 data 通道）
// ---------------------------------------------------------------------------

export type SharedApprovalRequestOutcome =
  | {
      readonly outcome: "requested";
      readonly requestId: string;
      readonly paramsDigest: string;
    }
  | ResourceNotFoundVerdict;

export type SharedApprovalWithdrawOutcome =
  | { readonly outcome: "withdrawn" }
  | ResourceNotFoundVerdict;

export type SharedApprovalUseOutcome =
  | {
      readonly outcome: "allow";
      readonly approvalId: string;
      readonly paramsDigest: string;
    }
  | ResourceNotFoundVerdict;

/** MT029 lease 校验 seam（消费其六道校验，不复制第二份）。 */
export type SharedApprovalLeaseValidator = Pick<
  CredentialLeaseService,
  "validate"
>;

export interface SharedApprovalService {
  /**
   * 发起一条审批申请：锁定当前受信 scope 的 (tenant, workspace) 与调用者
   * 指定且归属可见的 (bot, install) 对象对；提议参数摘要由服务端计算。
   * 对象不可见（缺失/跨公司/跨团队/未安装）= canonical deny，零副作用。
   */
  request(
    scope: PlatformScope,
    input: {
      readonly agentId: string;
      readonly installId: string;
      readonly proposed: SharedApprovalParams;
      readonly reason: SharedApprovalReason;
    },
  ): Promise<SharedApprovalRequestOutcome>;

  /**
   * 撤回本人待处理申请：UPDATE 臂只认 (本人, pending)；成员资格失效后
   * 同一请求立即不可操作（AC4）——canonical deny，行保持 pending。
   */
  withdraw(
    scope: PlatformScope,
    input: { readonly requestId: string },
  ): Promise<SharedApprovalWithdrawOutcome>;

  /**
   * 使用判定（已批准动作的检查点）：现读实时事实（AC4 撤权面）+ 四元组
   * 与参数摘要逐字匹配（AC1/AC2/AC3）。携带 lease 时先经 MT029
   * validate seam 重验（fail-closed：lease 层拒绝即 canonical deny）。
   */
  authorizeUse(
    scope: PlatformScope,
    input: {
      readonly agentId: string;
      readonly installId: string;
      readonly params: SharedApprovalParams;
      readonly checkpoint?: string;
      readonly lease?: {
        readonly leaseId: string;
        readonly purpose: CredentialLeasePurpose;
      };
    },
  ): Promise<SharedApprovalUseOutcome>;
}

export function createSharedApprovalService(
  data: DataDatabase,
  deps: { readonly leaseValidator?: SharedApprovalLeaseValidator } = {},
): SharedApprovalService {
  assertDataDatabase(data);

  return {
    async request(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "agentId",
        "installId",
        "proposed",
        "reason",
      ]);
      const agentId = requireString(
        input.agentId,
        "SHARED_APPROVAL_INVALID: agentId",
        ID_MAX,
      );
      const installId = requireString(
        input.installId,
        "SHARED_APPROVAL_INVALID: installId",
        ID_MAX,
      );
      const params = parseParams(input.proposed);
      if (!REASONS.includes(input.reason)) {
        throw new Error("SHARED_APPROVAL_INVALID: reason");
      }
      const digest = sharedApprovalParamsDigest(params);
      return approvalReadTransaction(data, scope, async (tx) => {
        const facts = await readApprovalFacts(tx, scope, {
          agentId,
          installId,
          paramsDigest: null,
        });
        // 申请权威 = 实时成员资格 + 对象归属可见（bot/install 行 active
        // 且属本团队）。任何不成立 = canonical deny（跨公司/跨团队/缺失
        // 对外同形；跨公司行另被复合外键结构性拒绝——23503 不可达）。
        const membershipOk =
          facts.companyMembership !== null &&
          facts.companyMembership.status === "active" &&
          facts.companyMembership.epoch === scope.memberEpoch;
        const objectsOk =
          facts.bot !== null &&
          facts.bot.status === "active" &&
          facts.bot.workspaceId === scope.workspaceId &&
          facts.install !== null &&
          facts.install.status === "active" &&
          facts.install.workspaceId === scope.workspaceId;
        if (
          !membershipOk ||
          facts.workspaceMembershipStatus !== "active" ||
          !objectsOk
        ) {
          return DENY_VERDICT;
        }
        const requestId = randomUUID();
        await tx.insert(enterpriseSharedUseRequests).values({
          tenantId: scope.tenantId,
          id: requestId,
          workspaceId: scope.workspaceId,
          agentId,
          installId,
          requestedBy: scope.principalId,
          proposedAudience: params.audience,
          proposedOutsideInput: params.outsideInput,
          proposedMembers: params.members.map((member) => ({
            kind: member.kind,
            value: member.value,
          })),
          proposedParamsDigest: digest,
          reason: input.reason,
          status: "pending",
        });
        return {
          outcome: "requested" as const,
          requestId,
          paramsDigest: digest,
        };
      });
    },

    async withdraw(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "requestId",
      ]);
      const requestId = requireString(
        input.requestId,
        "SHARED_APPROVAL_INVALID: requestId",
        ID_MAX,
      );
      return approvalReadTransaction(data, scope, async (tx) => {
        const [membership] = await tx
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
        // 撤权后待处理申请不可被该用户继续操作（AC4）：成员资格失效
        // 即拒，且不泄露行是否存在。
        if (
          membership?.status !== "active" ||
          membership.epoch !== scope.memberEpoch
        ) {
          return DENY_VERDICT;
        }
        // UPDATE 臂只认 (本人, pending)（RLS data_withdraw 策略同一谓词，
        // 双保险）；他行不可见（canonical deny 不泄露存在性）。
        const withdrawn = await tx
          .update(enterpriseSharedUseRequests)
          .set({ status: "withdrawn" })
          .where(
            and(
              eq(enterpriseSharedUseRequests.tenantId, scope.tenantId),
              eq(enterpriseSharedUseRequests.id, requestId),
              eq(enterpriseSharedUseRequests.requestedBy, scope.principalId),
              eq(enterpriseSharedUseRequests.status, "pending"),
            ),
          )
          .returning({ id: enterpriseSharedUseRequests.id });
        if (withdrawn.length !== 1) {
          return DENY_VERDICT;
        }
        return { outcome: "withdrawn" as const };
      });
    },

    async authorizeUse(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "agentId",
        "installId",
        "params",
        "checkpoint",
        "lease",
      ]);
      const agentId = requireString(
        input.agentId,
        "SHARED_APPROVAL_INVALID: agentId",
        ID_MAX,
      );
      const installId = requireString(
        input.installId,
        "SHARED_APPROVAL_INVALID: installId",
        ID_MAX,
      );
      const params = parseParams(input.params);
      const digest = sharedApprovalParamsDigest(params);
      const checkpoint = parseRevocationCheckpoint(
        input.checkpoint ?? "credentials.access",
      );
      if (input.lease !== undefined) {
        if (!input.lease || typeof input.lease !== "object") {
          throw new Error("SHARED_APPROVAL_INVALID: lease");
        }
        rejectExtraKeys(input.lease as unknown as Record<string, unknown>, [
          "leaseId",
          "purpose",
        ]);
        const leaseId = requireString(
          (input.lease as Record<string, unknown>).leaseId,
          "SHARED_APPROVAL_INVALID: lease.leaseId",
          ID_MAX,
        );
        // 已批准动作按 MT029 重新校验（AC4）：真实 MT029 seam 在本检查点
        // 现读其六道事实（用途/作用域/持有人存活/凭据权威）。validator
        // 未接线 = fail-closed 拒绝（绝不放行未经校验的凭据使用）。
        if (!deps.leaseValidator) {
          return DENY_VERDICT;
        }
        const leaseVerdict = await deps.leaseValidator.validate(scope, {
          leaseId,
          purpose: (input.lease as Record<string, unknown>)
            .purpose as CredentialLeasePurpose,
          checkpoint,
        });
        if (leaseVerdict.outcome !== "allow") {
          return DENY_VERDICT;
        }
      }
      return approvalReadTransaction(data, scope, async (tx) => {
        const facts = await readApprovalFacts(tx, scope, {
          agentId,
          installId,
          paramsDigest: digest,
        });
        if (!decideApproval(scope, facts, digest) || !facts.approval) {
          return DENY_VERDICT;
        }
        return {
          outcome: "allow" as const,
          approvalId: facts.approval.id,
          paramsDigest: digest,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 管理服务（受限 operator 通道）：批准 / 驳回
// ---------------------------------------------------------------------------

export type SharedApprovalDecisionOutcome =
  | {
      readonly outcome: "approved";
      readonly approvalId: string;
      readonly paramsDigest: string;
    }
  | { readonly outcome: "declined" }
  | ResourceNotFoundVerdict;

export interface SharedApprovalAdminService {
  /**
   * 决定一条本公司待处理申请（approve / decline）。事务内重验
   * tenant_admin + epoch + 主体状态（workspace-admin 先例）；租户 pin 下
   * 他司请求不可见 → canonical deny（AC3）。approve 原子地把申请行推到
   * approved 并插入不可变批准行（同事务，四元组 + 摘要 + 溯源申请）；
   * 只认 pending——并发/重复/已决定一律 canonical deny。
   */
  decide(
    context: CompanyAdminContext,
    input: {
      readonly requestId: string;
      readonly decision: "approve" | "decline";
    },
  ): Promise<SharedApprovalDecisionOutcome>;
}

export function createSharedApprovalAdminService(
  operator: OperatorDatabase,
): SharedApprovalAdminService {
  assertOperatorDatabase(operator);
  type Tx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  /** Exclusive locks in canonical order: tenant → membership → request. */
  const takeLocks = async (tx: Tx, keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
  };

  /**
   * Revalidates the acting admin inside the transaction: active company
   * membership with the tenant_admin role, epoch equal to the issued
   * context, principal still active (workspace-admin 同款重验).
   */
  const revalidateAdmin = async (
    tx: Tx,
    context: CompanyAdminContext,
  ): Promise<boolean> => {
    const [membership] = await tx
      .select({
        memberStatus: enterpriseMemberships.status,
        memberEpoch: enterpriseMemberships.epoch,
        role: enterpriseMemberships.role,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, context.tenantId),
          eq(enterpriseMemberships.principalId, context.principalId),
        ),
      )
      .limit(1);
    return (
      membership?.memberStatus === "active" &&
      membership.role === "tenant_admin" &&
      membership.memberEpoch === context.memberEpoch
    );
  };

  return {
    async decide(context, input) {
      assertTrustedAdminContext(context);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "requestId",
        "decision",
      ]);
      const requestId = requireString(
        input.requestId,
        "SHARED_APPROVAL_INVALID: requestId",
        ID_MAX,
      );
      if (input.decision !== "approve" && input.decision !== "decline") {
        throw new Error("SHARED_APPROVAL_INVALID: decision");
      }
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          JSON.stringify(["enterprise", "tenant", context.tenantId]),
          JSON.stringify([
            "enterprise",
            "membership",
            context.tenantId,
            context.principalId,
          ]),
          JSON.stringify([
            "enterprise",
            "shared-request",
            context.tenantId,
            requestId,
          ]),
        ]);
        if (!(await revalidateAdmin(tx, context))) {
          throw new Error("SCOPE_REVOKED");
        }
        // 租户 pin 下读申请行：他司行不可见 → canonical deny（AC3 的
        // 「跨公司批准永远拒绝」与未知/已决定同形，不泄露存在性）。
        const [request] = await tx
          .select({
            id: enterpriseSharedUseRequests.id,
            workspaceId: enterpriseSharedUseRequests.workspaceId,
            agentId: enterpriseSharedUseRequests.agentId,
            installId: enterpriseSharedUseRequests.installId,
            proposedAudience: enterpriseSharedUseRequests.proposedAudience,
            proposedOutsideInput:
              enterpriseSharedUseRequests.proposedOutsideInput,
            proposedMembers: enterpriseSharedUseRequests.proposedMembers,
            proposedParamsDigest:
              enterpriseSharedUseRequests.proposedParamsDigest,
            status: enterpriseSharedUseRequests.status,
          })
          .from(enterpriseSharedUseRequests)
          .where(
            and(
              eq(enterpriseSharedUseRequests.tenantId, context.tenantId),
              eq(enterpriseSharedUseRequests.id, requestId),
              eq(enterpriseSharedUseRequests.status, "pending"),
            ),
          )
          .limit(1);
        if (!request) {
          return DENY_VERDICT;
        }
        if (input.decision === "decline") {
          const declined = await tx
            .update(enterpriseSharedUseRequests)
            .set({
              status: "declined",
              decidedBy: context.principalId,
              decidedAt: new Date(),
            })
            .where(
              and(
                eq(enterpriseSharedUseRequests.tenantId, context.tenantId),
                eq(enterpriseSharedUseRequests.id, requestId),
                eq(enterpriseSharedUseRequests.status, "pending"),
              ),
            )
            .returning({ id: enterpriseSharedUseRequests.id });
          if (declined.length !== 1) {
            return DENY_VERDICT;
          }
          return { outcome: "declined" as const };
        }
        // approve：原子臂把申请推到 approved；批准行同事务插入——批准
        // 只能从一条本公司 pending 申请产生（溯源复合外键），四元组与
        // 摘要从申请行原样锁定（决定不得改写提议参数—— claimed 只参与
        // 判定、永不改写持久行，MT026/MT028 先例）。
        const approved = await tx
          .update(enterpriseSharedUseRequests)
          .set({
            status: "approved",
            decidedBy: context.principalId,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseSharedUseRequests.tenantId, context.tenantId),
              eq(enterpriseSharedUseRequests.id, requestId),
              eq(enterpriseSharedUseRequests.status, "pending"),
            ),
          )
          .returning({ id: enterpriseSharedUseRequests.id });
        if (approved.length !== 1) {
          return DENY_VERDICT;
        }
        const approvalId = randomUUID();
        await tx.insert(enterpriseSharedUseApprovals).values({
          tenantId: context.tenantId,
          id: approvalId,
          workspaceId: request.workspaceId,
          agentId: request.agentId,
          installId: request.installId,
          requestId: request.id,
          paramsDigest: request.proposedParamsDigest,
          audience: request.proposedAudience,
          outsideInput: request.proposedOutsideInput,
          members: request.proposedMembers,
          approvedBy: context.principalId,
        });
        return {
          outcome: "approved" as const,
          approvalId,
          paramsDigest: request.proposedParamsDigest,
        };
      });
    },
  };
}
