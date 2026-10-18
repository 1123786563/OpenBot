// server/src/enterprise/tenancy/credential-lease.ts
// MT029（Issue #72）：凭据取用 lease——固定用途、作用域且可撤销。
//
// 票面：业务执行需要凭据时通过 lease 取用：lease 固定用途、作用域与有效期，
// 可被撤销；个人凭据不会因为团队公共 Bot 而被自动共享给其他使用者。
//
// 验收四条的实现面：
//   AC1 用途/作用域固定：lease 行在签发时固定 (tenant, workspace, principal,
//       purpose, expires_at)。validate 的 claimed purpose 与持久行逐字比对，
//       claimed 作用域经读取谓词内嵌比对——任何不匹配 = canonical deny
//       （不泄露存在性）；claimed 只参与比对、永不改写持久行（MT026/MT028
//       先例：不匹配的呈现既不生效也不破坏行）。
//   AC2 撤销/过期在下一次校验点失效：validate 每次都读实时行——status
//       active（读取谓词内嵌）、expires_at > now()（谓词内嵌）、持有人
//       公司成员资格 active 且 epoch === scope.memberEpoch（撤权递增 epoch，
//       已签发 scope 立即失效——MT005/MT018 同款）、持有人在 lease 团队
//       上下文的成员资格 active、MT027 use 权威现读（凭据 active + 个人
//       属主 / 团队成员 + use 动作行 / 公司成员 + use 动作行）。无任何
//       缓存或宽限；恢复成员资格后同一 lease 重新放行（MT007 AC3 同语义：
//       每次调用读实时事实，判定之间不保存结果）。lease 自身撤销经受限
//       operator 通道原子翻转（MT027 revoke 同款）；MT027 凭据撤销同样
//       在权威重验处立即生效，凭据行删除则 lease 复合外键级联。
//   AC3 个人凭据 lease 仅属主可签发：issue 在签发事务内重验 MT027 use
//       权威——personal ⇒ 仅属主本人；team ⇒ 凭据所属团队的 active 成员
//       资格 + use 动作行；company ⇒ 本公司 active 成员 + use 动作行。
//       一切 deny（缺失/跨公司/已撤销/无权威）canonical RESOURCE_NOT_FOUND，
//       与「不存在」逐字节同形（MT011 canonical；判定核心为纯函数，
//       便于变异测试靶向）。
//   AC4 签发/取用/撤销各留审计（不含明文）：专用 append-only
//       enterprise_credential_lease_audit，与操作同一事务恰好一行
//       （issued/validated/revoked 闭集）；detail 闭形非机密事实（CHECK
//       禁止秘密载体键）；principal 审计主体 = lease 持有人；deny 零审计
//       零副作用（MT027 先例：denied 披露既不 open 信封也不写审计）。
//       本模块类型与结构上没有 envelope/plaintext 位——密封材料只能经
//       MT027 authorizeUse 的 allow 分支离开（单一事实源，不写两份）。
//
// 事务纪律与 MT027 判定入口完全一致：受信 Scope（assertTrustedScope）→
// 受限 data 事务（read committed + lock/statement timeout + 事务本地
// set_config + advisory 共享锁，键序 tenant → principal → membership →
// workspace-membership → credential → lease）。issue 用共享锁族（判定
// + 插入自己的 lease 行，不阻塞他人判定）；revoke 走受限 operator 通道
// 的原子 UPDATE 臂（WHERE status='active'，幂等）。模块零 console、零
// process.env；拒绝消息只含代码与字段路径，绝不回显任何值；checkpoint
// 词表复用 MT007 REVOCATION_CHECKPOINTS（单一事实源，不复制第二份）。

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseCredentialLeaseAudit,
  enterpriseCredentialLeases,
} from "../../db/schema/enterprise-credential-lease";
import {
  enterpriseCredentials as credentialRows,
  enterpriseCredentialActions,
} from "../../db/schema/enterprise-credentials";
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
import { parseRevocationCheckpoint } from "./revocation";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

/**
 * lease 用途闭集：签发时固定、取用时逐字比对。
 *   bot-run        —— Bot 运行中的凭据使用（公共 Bot 执行链）
 *   connector-call —— 连接器直调
 *   site-access    —— 站点登录使用
 */
export type CredentialLeasePurpose =
  | "bot-run"
  | "connector-call"
  | "site-access";

const PURPOSES: readonly CredentialLeasePurpose[] = [
  "bot-run",
  "connector-call",
  "site-access",
];

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86_400;
const CREDENTIAL_ID_MAX = 256;

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

function requireString(
  value: unknown,
  code: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
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
      throw new Error(`CREDENTIAL_LEASE_INVALID: unexpected field ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 判定事实（MT027 权威事实的本事务内镜像；语义与其判定面逐字对齐）
// ---------------------------------------------------------------------------

interface LeaseFacts {
  readonly lease: {
    readonly id: string;
    readonly credentialId: string;
    readonly principalId: string;
    readonly workspaceId: string;
    readonly purpose: string;
    readonly status: string;
    readonly expiresAt: Date;
  } | null;
  readonly credential: {
    readonly id: string;
    readonly classification: string;
    readonly workspaceId: string | null;
    readonly ownerPrincipalId: string | null;
    readonly status: string;
  } | null;
  readonly companyMembership: {
    readonly status: string;
    readonly epoch: number;
  } | null;
  readonly leaseWorkspaceMembershipStatus: string | null;
  readonly credentialWorkspaceMembershipStatus: string | null;
  readonly useGrant: boolean;
}

/**
 * 判定核心（纯函数，便于变异测试靶向）。
 *   - lease 必须存在且 active（撤销在行上可见）；
 *   - purpose 逐字比对（AC1：改用途拒绝）；
 *   - scope 比对：lease 持有人与团队上下文必须等于当前受信 scope
 *     （AC1：改范围拒绝；claimed 只比对、永不改写）；
 *   - 持有人存活：公司成员 active 且 epoch 匹配 + lease 团队上下文
 *     成员 active（AC2 的 A5 停用面）；
 *   - 凭据权威现读（MT027 use 语义）：凭据 active + 分类规则
 *     （personal 属主 / team 凭据团队 active 成员 + use 行 / company
 *     use 行）（AC2：凭据撤销在下一次校验点失效；AC3：个人凭据
 *     仅属主可签发）。
 */
function decideLease(
  scope: PlatformScope,
  facts: LeaseFacts,
  claimedPurpose: string,
): { allowed: boolean; facts: LeaseFacts } {
  const lease = facts.lease;
  if (!lease) return { allowed: false, facts };
  if (lease.status !== "active") return { allowed: false, facts };
  if (lease.purpose !== claimedPurpose) return { allowed: false, facts };
  if (lease.principalId !== scope.principalId) {
    return { allowed: false, facts };
  }
  if (lease.workspaceId !== scope.workspaceId) {
    return { allowed: false, facts };
  }
  if (!facts.companyMembership) return { allowed: false, facts };
  if (facts.companyMembership.status !== "active") {
    return { allowed: false, facts };
  }
  if (facts.companyMembership.epoch !== scope.memberEpoch) {
    return { allowed: false, facts };
  }
  if (facts.leaseWorkspaceMembershipStatus !== "active") {
    return { allowed: false, facts };
  }
  return { allowed: useAuthorityHolds(scope, facts), facts };
}

/**
 * MT027 use 权威（凭据侧半边）：凭据 active + 分类规则。签发与校验共用
 * 同一判定——「签发权威 = 取用权威」由结构保证，不存在两套规则。
 */
function useAuthorityHolds(scope: PlatformScope, facts: LeaseFacts): boolean {
  const credential = facts.credential;
  if (!credential) return false;
  if (credential.status !== "active") return false;
  const classification = credential.classification;
  if (classification === "personal") {
    return credential.ownerPrincipalId === scope.principalId;
  }
  if (classification === "team") {
    if (facts.credentialWorkspaceMembershipStatus !== "active") {
      return false;
    }
    return facts.useGrant;
  }
  if (classification === "company") {
    return facts.useGrant;
  }
  // 数据库 CHECK 兜底过的值域；越界属于不变量破坏，响亮拒绝。
  throw new Error("CREDENTIAL_LEASE_CLASSIFICATION_INVALID");
}

// ---------------------------------------------------------------------------
// 判定事务：形状与 MT027 判定入口一致（纵深防御的同一键族）
// ---------------------------------------------------------------------------

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

async function leaseReadTransaction<T>(
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
    // （与 resource-policy/credential-ownership 判定入口同一键序与键形）。
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

function credentialLockKey(tenantId: string, credentialId: string): string {
  return JSON.stringify(["enterprise", "credential", tenantId, credentialId]);
}

function leaseLockKey(tenantId: string, leaseId: string): string {
  return JSON.stringify(["enterprise", "credential-lease", tenantId, leaseId]);
}

/**
 * 读取判定事实（调用方已在 leaseReadTransaction 内）。credential 锁在
 * 凭据寻址确定后追加（issue 按入参 id；validate 按 lease 行内嵌 id）。
 * 全部事实经受限 data 角色与真实 RLS：跨公司行对本事务不可见（事实即为
 * 「不存在」），判定内的租户/成员比对是第二道独立防线（纵深防御）。
 */
async function readLeaseFacts(
  tx: DataTx,
  scope: PlatformScope,
  leaseId: string | null,
  credentialId: string | null,
): Promise<LeaseFacts> {
  let lease: LeaseFacts["lease"] = null;
  if (leaseId !== null) {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${leaseLockKey(scope.tenantId, leaseId)}, 0))`,
    );
    const [row] = await tx
      .select({
        id: enterpriseCredentialLeases.id,
        credentialId: enterpriseCredentialLeases.credentialId,
        principalId: enterpriseCredentialLeases.principalId,
        workspaceId: enterpriseCredentialLeases.workspaceId,
        purpose: enterpriseCredentialLeases.purpose,
        status: enterpriseCredentialLeases.status,
        expiresAt: enterpriseCredentialLeases.expiresAt,
      })
      .from(enterpriseCredentialLeases)
      .where(
        and(
          eq(enterpriseCredentialLeases.tenantId, scope.tenantId),
          eq(enterpriseCredentialLeases.id, leaseId),
          eq(enterpriseCredentialLeases.principalId, scope.principalId),
          eq(enterpriseCredentialLeases.workspaceId, scope.workspaceId),
          eq(enterpriseCredentialLeases.status, "active"),
          sql`${enterpriseCredentialLeases.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (row) {
      lease = {
        id: row.id,
        credentialId: row.credentialId,
        principalId: row.principalId,
        workspaceId: row.workspaceId,
        purpose: row.purpose,
        status: row.status,
        expiresAt: row.expiresAt,
      };
    }
  }
  const resolvedCredentialId = lease?.credentialId ?? credentialId;
  let credential: LeaseFacts["credential"] = null;
  let companyMembership: LeaseFacts["companyMembership"] = null;
  let leaseWorkspaceMembershipStatus: string | null = null;
  let credentialWorkspaceMembershipStatus: string | null = null;
  let useGrant = false;
  if (resolvedCredentialId !== null) {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${credentialLockKey(scope.tenantId, resolvedCredentialId)}, 0))`,
    );
    const [row] = await tx
      .select({
        id: credentialRows.id,
        classification: credentialRows.classification,
        workspaceId: credentialRows.workspaceId,
        ownerPrincipalId: credentialRows.ownerPrincipalId,
        status: credentialRows.status,
        membershipStatus: enterpriseMemberships.status,
        membershipEpoch: enterpriseMemberships.epoch,
        leaseTeamStatus: enterpriseWorkspaceMemberships.status,
        useGrant: sql<
          string | null
        >`(select 1 from ${enterpriseCredentialActions} ga
          where ga.tenant_id = ${credentialRows.tenantId}
            and ga.credential_id = ${credentialRows.id}
            and ga.principal_id = ${scope.principalId}
            and ga.action = 'use' limit 1)`,
      })
      .from(credentialRows)
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, credentialRows.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, credentialRows.tenantId),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            credentialRows.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(credentialRows.tenantId, scope.tenantId),
          eq(credentialRows.id, resolvedCredentialId),
        ),
      )
      .limit(1);
    if (row) {
      credential = {
        id: row.id,
        classification: row.classification,
        workspaceId: row.workspaceId,
        ownerPrincipalId: row.ownerPrincipalId,
        status: row.status,
      };
      companyMembership =
        row.membershipStatus == null || row.membershipEpoch == null
          ? null
          : { status: row.membershipStatus, epoch: row.membershipEpoch };
      useGrant = row.useGrant != null;
    }
  }
  if (lease !== null) {
    const [leaseTeam] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, lease.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    leaseWorkspaceMembershipStatus = leaseTeam?.status ?? null;
  }
  if (credential?.workspaceId != null) {
    const [credentialTeam] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            credential.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    credentialWorkspaceMembershipStatus = credentialTeam?.status ?? null;
  }
  return {
    lease,
    credential,
    companyMembership,
    leaseWorkspaceMembershipStatus,
    credentialWorkspaceMembershipStatus,
    useGrant,
  };
}

// ---------------------------------------------------------------------------
// 判定服务（受限 data 通道）
// ---------------------------------------------------------------------------

export type CredentialLeaseIssuance =
  | {
      readonly outcome: "allow";
      readonly leaseId: string;
      readonly credentialId: string;
      readonly purpose: CredentialLeasePurpose;
      readonly workspaceId: string;
      readonly principalId: string;
      readonly expiresAt: Date;
    }
  | ResourceNotFoundVerdict;

export type CredentialLeaseValidation =
  | {
      readonly outcome: "allow";
      readonly leaseId: string;
      readonly credentialId: string;
      readonly purpose: CredentialLeasePurpose;
      readonly expiresAt: Date;
    }
  | ResourceNotFoundVerdict;

export interface CredentialLeaseService {
  /**
   * 签发一条 lease：权威在签发事务内现读（MT027 use 权威；个人凭据仅
   * 属主——AC3），用途/作用域/有效期在签发时固定（AC1），签发本身留审计
   * （AC4）。deny 一律 canonical（不泄露存在性）；allow 零秘密材料。
   */
  issue(
    scope: PlatformScope,
    input: {
      readonly credentialId: string;
      readonly purpose: CredentialLeasePurpose;
      readonly ttlSeconds?: number;
    },
  ): Promise<CredentialLeaseIssuance>;

  /**
   * 校验点取用：每次都读实时行（AC2 的「下一次校验点」），用途与作用域
   * 逐字比对（AC1），allow 同事务写 validated 审计（checkpoint 进 detail；
   * AC4）。deny 一律 canonical；deny 零副作用（不消费、不改写、不审计）。
   */
  validate(
    scope: PlatformScope,
    input: {
      readonly leaseId: string;
      readonly purpose: CredentialLeasePurpose;
      readonly checkpoint?: string;
    },
  ): Promise<CredentialLeaseValidation>;
}

export function createCredentialLeaseService(
  data: DataDatabase,
): CredentialLeaseService {
  assertDataDatabase(data);

  return {
    async issue(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "credentialId",
        "purpose",
        "ttlSeconds",
      ]);
      const credentialId = requireString(
        input.credentialId,
        "CREDENTIAL_LEASE_INVALID: credentialId",
        1,
        CREDENTIAL_ID_MAX,
      );
      if (!PURPOSES.includes(input.purpose)) {
        throw new Error("CREDENTIAL_LEASE_INVALID: purpose");
      }
      const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < MIN_TTL_SECONDS ||
        ttlSeconds > MAX_TTL_SECONDS
      ) {
        throw new Error(
          `CREDENTIAL_LEASE_INVALID: ttlSeconds must be an integer of ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`,
        );
      }
      return leaseReadTransaction(data, scope, async (tx) => {
        const facts = await readLeaseFacts(tx, scope, null, credentialId);
        // 签发权威 = MT027 use 权威的现行事实：公司成员资格 active 且
        // epoch 匹配（撤权递增 epoch，已签发 scope 立即失效）+ 分类规则
        // （与 validate 的 decideLease 共用 useAuthorityHolds——「签发
        // 权威 = 取用权威」由结构保证，不存在两套规则）。
        const membershipOk =
          facts.companyMembership !== null &&
          facts.companyMembership.status === "active" &&
          facts.companyMembership.epoch === scope.memberEpoch;
        if (
          !membershipOk ||
          !useAuthorityHolds(scope, facts) ||
          !facts.credential
        ) {
          return DENY_VERDICT;
        }
        // 签发时点的作用域团队存活核验（MT018 run-entry 同款 liveness：
        // 受信 scope 的团队上下文必须仍然 active）。
        const [leaseTeam] = await tx
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
        if (leaseTeam?.status !== "active") {
          return DENY_VERDICT;
        }
        const leaseId = randomUUID();
        const inserted = await tx
          .insert(enterpriseCredentialLeases)
          .values({
            tenantId: scope.tenantId,
            id: leaseId,
            credentialId,
            principalId: scope.principalId,
            workspaceId: scope.workspaceId,
            purpose: input.purpose,
            status: "active",
            expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
          })
          .returning({ expiresAt: enterpriseCredentialLeases.expiresAt });
        const expiresAt = inserted[0]?.expiresAt;
        if (!expiresAt) {
          throw new Error("CREDENTIAL_LEASE_ISSUE_FAILED");
        }
        await tx.insert(enterpriseCredentialLeaseAudit).values({
          tenantId: scope.tenantId,
          id: randomUUID(),
          leaseId,
          credentialId,
          principalId: scope.principalId,
          action: "issued",
          detail: {
            credential_id: credentialId,
            purpose: input.purpose,
            workspace_id: scope.workspaceId,
            ttl_seconds: ttlSeconds,
          },
        });
        return {
          outcome: "allow" as const,
          leaseId,
          credentialId,
          purpose: input.purpose,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          expiresAt,
        };
      });
    },

    async validate(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "leaseId",
        "purpose",
        "checkpoint",
      ]);
      const leaseId = requireString(
        input.leaseId,
        "CREDENTIAL_LEASE_INVALID: leaseId",
        1,
        CREDENTIAL_ID_MAX,
      );
      if (!PURPOSES.includes(input.purpose)) {
        throw new Error("CREDENTIAL_LEASE_INVALID: purpose");
      }
      const checkpoint = parseRevocationCheckpoint(
        input.checkpoint ?? "credentials.access",
      );
      return leaseReadTransaction(data, scope, async (tx) => {
        const facts = await readLeaseFacts(tx, scope, leaseId, null);
        const verdict = decideLease(scope, facts, input.purpose);
        if (!verdict.allowed || !facts.lease || !facts.credential) {
          return DENY_VERDICT;
        }
        await tx.insert(enterpriseCredentialLeaseAudit).values({
          tenantId: scope.tenantId,
          id: randomUUID(),
          leaseId: facts.lease.id,
          credentialId: facts.lease.credentialId,
          principalId: scope.principalId,
          action: "validated",
          detail: {
            credential_id: facts.lease.credentialId,
            purpose: facts.lease.purpose,
            checkpoint,
          },
        });
        return {
          outcome: "allow" as const,
          leaseId: facts.lease.id,
          credentialId: facts.lease.credentialId,
          purpose: facts.lease.purpose as CredentialLeasePurpose,
          expiresAt: facts.lease.expiresAt,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 管理服务（受限 operator 通道）：撤销
// ---------------------------------------------------------------------------

export interface CredentialLeaseAdminService {
  /**
   * 撤销一条 lease：原子臂只认 active（并发撤销恰一成功）；重复撤销
   * 幂等返回 false；未知 lease 同样 false（不泄露存在性）。成功撤销在
   * 同一事务写 revoked 审计（AC4）。
   */
  revoke(input: {
    readonly tenantId: string;
    readonly leaseId: string;
  }): Promise<{ readonly revoked: boolean }>;
}

export function createCredentialLeaseAdminService(
  operator: OperatorDatabase,
): CredentialLeaseAdminService {
  assertOperatorDatabase(operator);
  return {
    async revoke(input) {
      assertOperatorDatabase(operator);
      const tenantId = requireString(
        input.tenantId,
        "CREDENTIAL_LEASE_INVALID: tenantId",
        1,
        128,
      );
      const leaseId = requireString(
        input.leaseId,
        "CREDENTIAL_LEASE_INVALID: leaseId",
        1,
        CREDENTIAL_ID_MAX,
      );
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        // 原子臂：只认 active（MT027 revoke 同款；无可达中间态）。
        const revoked = await tx
          .update(enterpriseCredentialLeases)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(enterpriseCredentialLeases.tenantId, tenantId),
              eq(enterpriseCredentialLeases.id, leaseId),
              eq(enterpriseCredentialLeases.status, "active"),
            ),
          )
          .returning({
            credentialId: enterpriseCredentialLeases.credentialId,
            principalId: enterpriseCredentialLeases.principalId,
            purpose: enterpriseCredentialLeases.purpose,
          });
        if (revoked.length !== 1) {
          return { revoked: false };
        }
        const row = revoked[0];
        await tx.insert(enterpriseCredentialLeaseAudit).values({
          tenantId,
          id: randomUUID(),
          leaseId,
          credentialId: row.credentialId,
          principalId: row.principalId,
          action: "revoked",
          detail: {
            credential_id: row.credentialId,
            purpose: row.purpose,
          },
        });
        return { revoked: true };
      });
    },
  };
}
