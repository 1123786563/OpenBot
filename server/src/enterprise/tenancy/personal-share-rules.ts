// server/src/enterprise/tenancy/personal-share-rules.ts
// MT010（Issue #53）：个人资源权限与显式跨团队分享。
//
// 结构（三件事，全部纯新增；不改动 store/scope-gate/resource-policy/
// resource-visibility/workspace-admin 的任何既有导出语义）：
//
//   1. 分享写路径（createPersonalShareAdminService，受限 operator 通道）：
//      只有资源属主能 share/revoke。属主判定 = 该 (tenant, resource) 在
//      enterprise_resource_grants 里恰有一行 'read' 授权且其 principal 就是
//      操作者——个人资源的授权面就是属主一人；0 行（含资源不存在）与
//      「不是你的」对外同一个 NOT_RESOURCE_OWNER（不泄露存在性），多行是
//      不变量破坏，响亮拒绝。分享目标必须显式标记 visibility='private'
//      （个人资源）；受众必须是同公司有效成员（复合外键在数据库层兜底——
//      跨公司分享行结构上不可能存在）。动作域只有 'read'：服务层显式拒绝
//      一切其它动作，CHECK 约束在数据库层拒绝一切非 read 行——被分享方
//      永远拿不到管理动作，转授在结构上不可能。
//   2. 分享感知判定（createPersonalShareDecisionService，受限 data 通道）：
//      受信 Scope（assertTrustedScope）→ 数据事务（read committed +
//      lock/statement timeout → set_config('app.*', …, true) 事务本地 →
//      advisory 共享锁，键序/键形 = resource-policy 判定入口同一键族）→
//      真实 RLS 下读判定事实 → 两扇门：
//        - 属主门：本人的 'read' 授权行存在（ grants 的 restrictive RLS
//          让 data 角色只见本人行）→ 放行（属主访问即既有 grant 语义）；
//        - 分享门：本人的分享行存在且 expires_at > now()——有效期按数据
//          库时钟现场核对，应用时钟永不参与安全判定；撤销 = 分享行已删除
//          （无可达中间态），过期与撤销都立即失效。
//      deny 只有一种对外形状 { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
//      ——不存在、跨公司、跨团队、无分享、过期、已撤销、成员停用在对外
//      语义上不可区分（不泄露存在性）。
//   3. 分享不改变归属：分享写路径只插入/删除 enterprise_resource_shares
//      行，绝不触碰 enterprise_resources（visibility/revision/aclEpoch）与
//      enterprise_resource_grants（属主授权行）——归属事实逐字节不变。
//
// 边界（诚实声明）：分享令牌与分享页入口属 MT058/MT092；本模块只提供
// 服务与判定，不接任何路由。资源 kind（session/file/connection/…）不做
// 白名单——「个人」由 visibility='private' 显式标记决定，三个 canonical
// 个人 kind 由测试逐例钉死。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import { enterpriseResourceShares } from "../../db/schema/personal-shares";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import { parseResourceVisibility } from "./resource-policy";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 分享动作域：只有 read（票面：被分享方不能转授管理动作）
// ---------------------------------------------------------------------------

export type ShareAction = "read";
export const SHARE_ACTION_READ: ShareAction = "read";

function assertShareAction(action: unknown): asserts action is ShareAction {
  if (action !== SHARE_ACTION_READ) {
    throw new Error("SHARE_ACTION_UNSUPPORTED");
  }
}

function assertShareId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`SHARE_INPUT_INVALID:${field}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 判定结果：deny 只有一种对外形状（与 resource-policy 完全同形）
// ---------------------------------------------------------------------------

export type PersonalShareVerdict =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" };

const ALLOW_VERDICT: PersonalShareVerdict = Object.freeze({ outcome: "allow" });
const DENY_VERDICT: PersonalShareVerdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

// ---------------------------------------------------------------------------
// 写路径输入/回执
// ---------------------------------------------------------------------------

export interface ShareResourceInput {
  readonly tenantId: string;
  readonly resourceId: string;
  /** 必须是资源属主（唯一 'read' 授权行的 principal）。 */
  readonly actorPrincipalId: string;
  /** 受众：同公司一名有效成员。 */
  readonly audiencePrincipalId: string;
  readonly action: ShareAction;
  /** 有效期终点；必须晚于创建时刻（数据库时钟在判定侧现场核对）。 */
  readonly expiresAt: Date;
}

export interface ShareReceipt {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly audiencePrincipalId: string;
  readonly action: ShareAction;
  readonly expiresAt: Date;
}

export interface RevokeShareInput {
  readonly tenantId: string;
  readonly resourceId: string;
  /** 必须是资源属主。 */
  readonly actorPrincipalId: string;
  readonly audiencePrincipalId: string;
  readonly action: ShareAction;
}

export interface RevokeReceipt {
  /** false = 当前不存在该分享（幂等 no-op，语义与「已撤销」一致）。 */
  readonly revoked: boolean;
}

export interface PersonalShareAdminService {
  share(input: ShareResourceInput): Promise<ShareReceipt>;
  revoke(input: RevokeShareInput): Promise<RevokeReceipt>;
}

// ---------------------------------------------------------------------------
// 事务纪律（与 resource-policy/resource-visibility 同一通道与锁族）
// ---------------------------------------------------------------------------

type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

async function beginOperatorWriteTransaction(
  operator: OperatorDatabase,
  tenantId: string,
  actorPrincipalId: string,
  resourceId: string,
  work: (tx: OperatorTx) => Promise<void>,
): Promise<void> {
  await operator.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings back the restricted-role RLS policies and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${actorPrincipalId}, true), set_config('app.resource_id', ${resourceId}, true)`,
    );
    // 锁序与 store.readLockKeys 一致（tenant → principal → membership →
    // resource）；resource 键取排他锁，与判定入口的共享锁、可见性迁移的
    // 排他锁同键族——分享写与判定读/迁移写串行化。
    for (const key of [
      JSON.stringify(["enterprise", "tenant", tenantId]),
      JSON.stringify(["enterprise", "principal", actorPrincipalId]),
      JSON.stringify(["enterprise", "membership", tenantId, actorPrincipalId]),
      JSON.stringify(["enterprise", "resource", tenantId, resourceId]),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
    await work(tx);
  });
}

interface OwnedPersonalResource {
  readonly resourceId: string;
  readonly visibility: string | null;
}

/**
 * 属主与个人资源判定的唯一入口。0 行授权（含资源不存在/跨公司 id）与
 * 「不是你的」对外同为 NOT_RESOURCE_OWNER；多行授权是不变量破坏。
 */
async function requireOwnedPersonalResource(
  tx: OperatorTx,
  tenantId: string,
  resourceId: string,
  actorPrincipalId: string,
): Promise<OwnedPersonalResource> {
  const [resource] = await tx
    .select({
      id: enterpriseResources.id,
      status: enterpriseResources.status,
      visibility: enterpriseResources.visibility,
    })
    .from(enterpriseResources)
    .where(
      and(
        eq(enterpriseResources.tenantId, tenantId),
        eq(enterpriseResources.id, resourceId),
      ),
    )
    .limit(1);
  if (!resource) {
    // 不存在（或跨公司 id 对本事务不可见）与「不是你的」不可区分。
    throw new Error("NOT_RESOURCE_OWNER");
  }
  const grants = await tx
    .select({ principalId: enterpriseResourceGrants.principalId })
    .from(enterpriseResourceGrants)
    .where(
      and(
        eq(enterpriseResourceGrants.tenantId, tenantId),
        eq(enterpriseResourceGrants.resourceId, resourceId),
        eq(enterpriseResourceGrants.action, SHARE_ACTION_READ),
      ),
    );
  if (grants.length === 0) {
    throw new Error("NOT_RESOURCE_OWNER");
  }
  if (grants.length > 1) {
    // 个人资源的授权面必须是属主一人；多行属于上游写入路径的不变量破坏，
    // 绝不猜测哪一行是属主。
    throw new Error("PERSONAL_RESOURCE_OWNERSHIP_AMBIGUOUS");
  }
  if (grants[0].principalId !== actorPrincipalId) {
    throw new Error("NOT_RESOURCE_OWNER");
  }
  if (resource.status !== "active") {
    throw new Error("SHARE_TARGET_INACTIVE");
  }
  if (parseResourceVisibility(resource.visibility) !== "private") {
    // 分享只对显式标记为个人的资源开放；团队公共/未标记资源各有自己的路径。
    throw new Error("SHARE_TARGET_NOT_PERSONAL");
  }
  return { resourceId: resource.id, visibility: resource.visibility };
}

// ---------------------------------------------------------------------------
// 写路径：属主 share / revoke
// ---------------------------------------------------------------------------

export function createPersonalShareAdminService(
  operator: OperatorDatabase,
): PersonalShareAdminService {
  assertOperatorDatabase(operator);
  return {
    async share(input) {
      const tenantId = assertShareId(input?.tenantId, "tenantId");
      const resourceId = assertShareId(input?.resourceId, "resourceId");
      const actorPrincipalId = assertShareId(
        input?.actorPrincipalId,
        "actorPrincipalId",
      );
      const audiencePrincipalId = assertShareId(
        input?.audiencePrincipalId,
        "audiencePrincipalId",
      );
      assertShareAction(input?.action);
      const expiresAt = input?.expiresAt;
      if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
        throw new Error("SHARE_INPUT_INVALID:expiresAt");
      }
      if (expiresAt.getTime() <= Date.now()) {
        throw new Error("SHARE_EXPIRY_INVALID");
      }
      if (audiencePrincipalId === actorPrincipalId) {
        // 属主无需分享给自己；这行只会制造死数据。
        throw new Error("SHARE_AUDIENCE_SELF");
      }

      let receipt: ShareReceipt | undefined;
      await beginOperatorWriteTransaction(
        operator,
        tenantId,
        actorPrincipalId,
        resourceId,
        async (tx) => {
          await requireOwnedPersonalResource(
            tx,
            tenantId,
            resourceId,
            actorPrincipalId,
          );
          const [membership] = await tx
            .select({ status: enterpriseMemberships.status })
            .from(enterpriseMemberships)
            .where(
              and(
                eq(enterpriseMemberships.tenantId, tenantId),
                eq(enterpriseMemberships.principalId, audiencePrincipalId),
              ),
            )
            .limit(1);
          if (membership?.status !== "active") {
            // 跨公司受众在这里被显式拒绝；即便绕过服务层，复合外键也在
            // 数据库层拒绝该行（结构性不可能）。
            throw new Error("AUDIENCE_NOT_COMPANY_MEMBER");
          }
          const [existing] = await tx
            .select({ principalId: enterpriseResourceShares.principalId })
            .from(enterpriseResourceShares)
            .where(
              and(
                eq(enterpriseResourceShares.tenantId, tenantId),
                eq(enterpriseResourceShares.resourceId, resourceId),
                eq(enterpriseResourceShares.principalId, audiencePrincipalId),
                eq(enterpriseResourceShares.action, SHARE_ACTION_READ),
              ),
            )
            .limit(1);
          if (existing) {
            throw new Error("SHARE_ALREADY_ACTIVE");
          }
          const [row] = await tx
            .insert(enterpriseResourceShares)
            .values({
              tenantId,
              resourceId,
              principalId: audiencePrincipalId,
              action: SHARE_ACTION_READ,
              expiresAt,
              grantedBy: actorPrincipalId,
            })
            .returning({ expiresAt: enterpriseResourceShares.expiresAt });
          if (!row) {
            throw new Error("SHARE_WRITE_FAILED");
          }
          receipt = {
            tenantId,
            resourceId,
            audiencePrincipalId,
            action: SHARE_ACTION_READ,
            expiresAt: row.expiresAt,
          };
        },
      );
      if (!receipt) {
        throw new Error("SHARE_WRITE_FAILED");
      }
      return receipt;
    },

    async revoke(input) {
      const tenantId = assertShareId(input?.tenantId, "tenantId");
      const resourceId = assertShareId(input?.resourceId, "resourceId");
      const actorPrincipalId = assertShareId(
        input?.actorPrincipalId,
        "actorPrincipalId",
      );
      const audiencePrincipalId = assertShareId(
        input?.audiencePrincipalId,
        "audiencePrincipalId",
      );
      assertShareAction(input?.action);

      let revoked = false;
      await beginOperatorWriteTransaction(
        operator,
        tenantId,
        actorPrincipalId,
        resourceId,
        async (tx) => {
          await requireOwnedPersonalResource(
            tx,
            tenantId,
            resourceId,
            actorPrincipalId,
          );
          const rows = await tx
            .delete(enterpriseResourceShares)
            .where(
              and(
                eq(enterpriseResourceShares.tenantId, tenantId),
                eq(enterpriseResourceShares.resourceId, resourceId),
                eq(enterpriseResourceShares.principalId, audiencePrincipalId),
                eq(enterpriseResourceShares.action, SHARE_ACTION_READ),
              ),
            )
            .returning({ principalId: enterpriseResourceShares.principalId });
          revoked = rows.length === 1;
        },
      );
      return { revoked };
    },
  };
}

// ---------------------------------------------------------------------------
// 判定路径：受信 Scope → 受限 data 事务 → 真实 RLS → 属主门 ∪ 分享门
// ---------------------------------------------------------------------------

export interface PersonalShareDecisionService {
  /**
   * Decides one personal-resource read for a trusted scope. The owner's own
   * grant and a currently-valid share are the only two doors; every denial
   * surfaces as { outcome: "deny", code: "RESOURCE_NOT_FOUND" }.
   */
  decide(
    scope: PlatformScope,
    resourceId: string,
  ): Promise<PersonalShareVerdict>;
}

/** 修订完整性：与 resource-policy 的 revisionsAreSane 同一不变量。 */
function revisionsAreSane(
  revision: number | null,
  aclEpoch: number | null,
): boolean {
  return (
    Number.isSafeInteger(revision) &&
    revision !== null &&
    revision >= 1 &&
    Number.isSafeInteger(aclEpoch) &&
    aclEpoch !== null &&
    aclEpoch >= 1
  );
}

export function createPersonalShareDecisionService(
  data: DataDatabase,
): PersonalShareDecisionService {
  assertDataDatabase(data);
  return {
    async decide(scope, resourceId) {
      // 信任边界：只有签发入口产出的 Scope 能进入判定。
      assertTrustedScope(scope);
      if (typeof resourceId !== "string" || !resourceId.trim()) {
        return DENY_VERDICT;
      }
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // 锁序/键形与 resource-policy 判定入口完全一致。
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
          JSON.stringify([
            "enterprise",
            "resource",
            scope.tenantId,
            resourceId,
          ]),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        // 公司成员资格 + epoch：scope 是签发时快照，判定按当前事实。
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
        if (
          membership?.status !== "active" ||
          membership.epoch !== scope.memberEpoch
        ) {
          return DENY_VERDICT;
        }
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
        if (teamMembership?.status !== "active") {
          return DENY_VERDICT;
        }
        // 资源行 + 属主门 + 分享门，一次受限读取。grants 与 shares 的
        // restrictive/data RLS 保证只见本人行；跨公司资源行对本事务不可见。
        // 注意：不要求 resource.workspace === scope.workspace——个人权限
        // 跟随人（R4），跨团队分享的合法路径正是「同公司、不同团队」。
        const [row] = await tx
          .select({
            resourceStatus: enterpriseResources.status,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            ownerGrantPrincipalId: enterpriseResourceGrants.principalId,
            shareActive: sql<
              boolean | null
            >`${enterpriseResourceShares.expiresAt} > now()`.as("share_active"),
          })
          .from(enterpriseResources)
          .leftJoin(
            enterpriseResourceGrants,
            and(
              eq(enterpriseResourceGrants.tenantId, scope.tenantId),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, SHARE_ACTION_READ),
            ),
          )
          .leftJoin(
            enterpriseResourceShares,
            and(
              eq(enterpriseResourceShares.tenantId, scope.tenantId),
              eq(enterpriseResourceShares.resourceId, enterpriseResources.id),
              eq(enterpriseResourceShares.principalId, scope.principalId),
              eq(enterpriseResourceShares.action, SHARE_ACTION_READ),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
        if (!row) return DENY_VERDICT;
        if (row.resourceStatus !== "active") return DENY_VERDICT;
        if (!revisionsAreSane(row.revision, row.aclEpoch)) return DENY_VERDICT;
        // 门一：属主（本人的 'read' 授权行）——归属路径不受分享影响。
        if (row.ownerGrantPrincipalId != null) return ALLOW_VERDICT;
        // 门二：有效分享——有效期按数据库时钟 now() 现场核对；撤销 = 行
        // 已删除（join 不中 → shareActive 为 NULL）。
        if (row.shareActive === true) return ALLOW_VERDICT;
        return DENY_VERDICT;
      });
    },
  };
}
