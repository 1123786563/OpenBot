// server/src/enterprise/tenancy/credential-ownership.ts
// MT027（Issue #70）：连接凭据与站点登录的真实归属、可用≠可读明文。
//
// 票面：个人凭据只对本人可用可读；团队/公司凭据只对该范围成员按动作授权
// 可用，明文读取需要独立授权且留审计；跨公司凭据 ID 不可见语义且不触发
// 供应商调用；列表与详情默认脱敏，任何响应、日志与错误都不含明文秘密。
//
// 结构（三件事，全部纯新增；resource-policy / personal-share-rules /
// not-found-semantics 按票面只读消费——本文件复用其事务形状与 canonical
// deny 形状，绝不改动它们）：
//
//   1. 存储归属（enterprise_credentials，MT027 迁移）：显式 classification
//      （personal/team/company）+ 行形 CHECK + 复合外键内嵌 tenant_id——
//      跨公司归属行在结构上不可能存在。envelope 只存密封密文，明文永不
//      入库；target/display 是非机密寻址与展示元数据。
//   2. 动作授权（enterprise_credential_actions）：闭集动作行，'use'（业务
//      使用）与 'disclose'（明文读取）是彼此独立的授权行——被授权使用绝不
//      蕴含可读明文。撤销 = 删除行，立即失效。
//   3. 判定入口（createCredentialOwnershipDecisionService）：受信 Scope
//      （assertTrustedScope）→ 受限 data 事务（read committed + 超时 +
//      事务本地 set_config + advisory 共享锁，键序 tenant → principal →
//      membership → workspace-membership → credential，与 resource-policy
//      判定入口完全一致）→ 真实 RLS 下读事实 → 判定。deny 只有一种形状
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }（MT011 canonical）：
//      不存在、跨公司、跨范围、无授权、已撤销在对外语义上不可区分。
//
// 「不触发供应商调用」的实现面：allow 变体独占携带密封材料（envelope），
// deny 变体在类型上没有任何可执行物——调用方只能在 allow 分支触达供应商。
// 本模块自己从不发起任何外部调用。
//
// 明文面：`disclosePlaintext` 是唯一返回明文的入口，需要独立的 'disclose'
// 授权行（个人凭据则为属主本人），成功披露在同一个数据事务里写一行
// append-only 审计；denied 披露既不 open 信封也不写审计。
//
// 脱敏面：RedactedCredentialView 类型上没有 envelope/plaintext 字段；列表
// 只含本人个人凭据 ∪ 持有 active 成员资格团队的 team 凭据 ∪ 本公司 company
// 凭据——计数与条目都不泄露跨范围存在性。模块零 console、零 process.env；
// 拒绝消息只含代码与字段路径，绝不回显任何值（与 MT014/MT015 同一纪律）。

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  enterpriseCredentials as credentialRows,
  enterpriseCredentialActions,
  enterpriseCredentialAudit,
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
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

export type CredentialKind = "connection" | "site-login";
export type CredentialClassification = "personal" | "team" | "company";
export type CredentialAction = "use" | "disclose";

/** 密封材料 seam：生产装配接 credentials.ts 的 AES-GCM envelope；模块自身不持钥匙。 */
export interface SecretVault {
  seal(plaintext: string): Promise<string>;
  open(envelope: string): Promise<string>;
}

/** 脱敏视图：类型上没有 envelope/plaintext 字段（结构脱敏，非约定脱敏）。 */
export interface RedactedCredentialView {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly kind: CredentialKind;
  readonly classification: CredentialClassification;
  readonly workspaceId: string | null;
  readonly target: string;
  readonly label: string;
  readonly status: "active";
  readonly effectiveActions: {
    readonly use: boolean;
    readonly disclose: boolean;
  };
  readonly createdAt: string;
}

/**
 * 使用判定。allow 独占携带密封材料（envelope）——调用方只能在 allow 分支
 * 触达供应商；deny 是 canonical not-found，与「不存在」逐字节同形。
 */
export type CredentialUseResolution =
  | {
      readonly outcome: "allow";
      readonly credential: RedactedCredentialView;
      readonly envelope: string;
    }
  | ResourceNotFoundVerdict;

/** 明文披露。唯一携带明文的入口；allow 必写审计（同一数据事务）。 */
export type CredentialDisclosure =
  | {
      readonly outcome: "allow";
      readonly plaintext: string;
      readonly auditId: string;
    }
  | ResourceNotFoundVerdict;

export type CredentialDetailResolution =
  | { readonly outcome: "allow"; readonly credential: RedactedCredentialView }
  | ResourceNotFoundVerdict;

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

const KINDS: readonly CredentialKind[] = ["connection", "site-login"];
const CLASSIFICATIONS: readonly CredentialClassification[] = [
  "personal",
  "team",
  "company",
];
const ACTIONS: readonly CredentialAction[] = ["use", "disclose"];
const TARGET_MAX = 512;
const LABEL_MAX = 200;
const PLAINTEXT_MAX = 4096;

function requireString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`CREDENTIAL_REGISTER_INVALID: ${field}`);
  }
  return value;
}

function rejectExtraKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`CREDENTIAL_REGISTER_INVALID: unexpected field ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 归属写面（受限 operator 通道；缺通道 fail-closed——装配侧保持 null）
// ---------------------------------------------------------------------------

export interface CredentialOwnershipAdminService {
  /** 登记一个凭据的真实归属；明文经 vault 密封后入库，明文本身不落库。 */
  register(input: {
    readonly tenantId: string;
    readonly kind: CredentialKind;
    readonly classification: CredentialClassification;
    readonly workspaceId?: string;
    readonly ownerPrincipalId?: string;
    readonly target: string;
    readonly label: string;
    readonly plaintext: string;
  }): Promise<{ readonly credentialId: string }>;
  /** 撤销凭据（对所有人生效，含属主）；重复撤销幂等。 */
  revoke(input: {
    readonly tenantId: string;
    readonly credentialId: string;
  }): Promise<{ readonly revoked: boolean }>;
  /** 授予一条独立动作行（use / disclose 互不蕴含）。 */
  grantAction(input: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly principalId: string;
    readonly action: CredentialAction;
    readonly grantedBy: string;
  }): Promise<void>;
  /** 撤销一条动作行（删除行，立即失效）；行不存在时幂等返回 false。 */
  revokeAction(input: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly principalId: string;
    readonly action: CredentialAction;
  }): Promise<{ readonly revoked: boolean }>;
}

export function createCredentialOwnershipAdminService(
  operator: OperatorDatabase,
  vault: SecretVault,
): CredentialOwnershipAdminService {
  assertOperatorDatabase(operator);
  return {
    async register(input) {
      assertOperatorDatabase(operator);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "tenantId",
        "kind",
        "classification",
        "workspaceId",
        "ownerPrincipalId",
        "target",
        "label",
        "plaintext",
      ]);
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      if (!KINDS.includes(input.kind)) {
        throw new Error("CREDENTIAL_REGISTER_INVALID: kind");
      }
      if (!CLASSIFICATIONS.includes(input.classification)) {
        throw new Error("CREDENTIAL_REGISTER_INVALID: classification");
      }
      const target = requireString(input.target, "target", 1, TARGET_MAX);
      const label = requireString(input.label, "label", 1, LABEL_MAX);
      const plaintext = requireString(
        input.plaintext,
        "plaintext",
        1,
        PLAINTEXT_MAX,
      );
      let workspaceId: string | null = null;
      let ownerPrincipalId: string | null = null;
      if (input.classification === "personal") {
        ownerPrincipalId = requireString(
          input.ownerPrincipalId,
          "ownerPrincipalId",
          1,
          128,
        );
        if (input.workspaceId !== undefined) {
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: personal credentials take no workspace",
          );
        }
      } else if (input.classification === "team") {
        workspaceId = requireString(input.workspaceId, "workspaceId", 1, 128);
        if (input.ownerPrincipalId !== undefined) {
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: team credentials take no owner",
          );
        }
      } else {
        if (
          input.workspaceId !== undefined ||
          input.ownerPrincipalId !== undefined
        ) {
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: company credentials take neither workspace nor owner",
          );
        }
      }
      const credentialId = randomUUID();
      const envelope = await vault.seal(plaintext);
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.insert(credentialRows).values({
          tenantId,
          id: credentialId,
          kind: input.kind,
          classification: input.classification,
          workspaceId,
          ownerPrincipalId,
          target,
          display: { label },
          envelope,
          status: "active",
        });
      });
      return { credentialId };
    },

    async revoke(input) {
      assertOperatorDatabase(operator);
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const credentialId = requireString(
        input.credentialId,
        "credentialId",
        1,
        128,
      );
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const rows = await tx
          .update(credentialRows)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(
            and(
              eq(credentialRows.tenantId, tenantId),
              eq(credentialRows.id, credentialId),
              eq(credentialRows.status, "active"),
            ),
          )
          .returning({ id: credentialRows.id });
        return { revoked: rows.length === 1 };
      });
    },

    async grantAction(input) {
      assertOperatorDatabase(operator);
      if (!ACTIONS.includes(input.action)) {
        throw new Error("CREDENTIAL_ACTION_UNSUPPORTED");
      }
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const credentialId = requireString(
        input.credentialId,
        "credentialId",
        1,
        128,
      );
      const principalId = requireString(
        input.principalId,
        "principalId",
        1,
        128,
      );
      const grantedBy = requireString(input.grantedBy, "grantedBy", 1, 128);
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx
          .insert(enterpriseCredentialActions)
          .values({
            tenantId,
            credentialId,
            principalId,
            action: input.action,
            grantedBy,
          })
          .onConflictDoNothing();
      });
    },

    async revokeAction(input) {
      assertOperatorDatabase(operator);
      if (!ACTIONS.includes(input.action)) {
        throw new Error("CREDENTIAL_ACTION_UNSUPPORTED");
      }
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      const credentialId = requireString(
        input.credentialId,
        "credentialId",
        1,
        128,
      );
      const principalId = requireString(
        input.principalId,
        "principalId",
        1,
        128,
      );
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const rows = await tx
          .delete(enterpriseCredentialActions)
          .where(
            and(
              eq(enterpriseCredentialActions.tenantId, tenantId),
              eq(enterpriseCredentialActions.credentialId, credentialId),
              eq(enterpriseCredentialActions.principalId, principalId),
              eq(enterpriseCredentialActions.action, input.action),
            ),
          )
          .returning({ principalId: enterpriseCredentialActions.principalId });
        return { revoked: rows.length === 1 };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 判定事实
// ---------------------------------------------------------------------------

interface CredentialFacts {
  readonly credential: {
    readonly tenantId: string;
    readonly id: string;
    readonly kind: string;
    readonly classification: string;
    readonly workspaceId: string | null;
    readonly ownerPrincipalId: string | null;
    readonly target: string;
    readonly label: string;
    readonly status: string;
    readonly envelope: string;
    readonly createdAt: Date;
  } | null;
  readonly companyMembership: {
    readonly status: string;
    readonly epoch: number;
  } | null;
  readonly workspaceMembershipStatus: string | null;
  readonly grants: { readonly use: boolean; readonly disclose: boolean };
}

function classificationOf(value: string): CredentialClassification {
  if (!CLASSIFICATIONS.includes(value as CredentialClassification)) {
    // 数据库 CHECK 兜底过的值域；越界属于不变量破坏，响亮拒绝。
    throw new Error("CREDENTIAL_CLASSIFICATION_INVALID");
  }
  return value as CredentialClassification;
}

/**
 * 判定核心（纯函数，便于变异测试靶向）：
 *   - 公司成员资格必须 active 且 epoch 与 scope 一致（scope 是签发时快照）；
 *   - personal：仅属主本人（可用可读同门）；
 *   - team：对象归属团队的 active 成员资格 + 对应动作行；
 *   - company：对应动作行（成员资格已在第 1 条核过）；
 *   - revoked/跨范围/不存在一律 DENY（canonical）。
 */
function decideCredential(
  scope: PlatformScope,
  facts: CredentialFacts,
  action: CredentialAction,
): { allowed: boolean; facts: CredentialFacts } {
  const credential = facts.credential;
  if (!credential) return { allowed: false, facts };
  if (credential.status !== "active") return { allowed: false, facts };
  if (!facts.companyMembership) return { allowed: false, facts };
  if (facts.companyMembership.status !== "active")
    return { allowed: false, facts };
  if (facts.companyMembership.epoch !== scope.memberEpoch) {
    return { allowed: false, facts };
  }
  const classification = classificationOf(credential.classification);
  if (classification === "personal") {
    const isOwner = credential.ownerPrincipalId === scope.principalId;
    return { allowed: isOwner, facts };
  }
  if (classification === "team") {
    if (facts.workspaceMembershipStatus !== "active") {
      return { allowed: false, facts };
    }
    return { allowed: facts.grants[action], facts };
  }
  return { allowed: facts.grants[action], facts };
}

/** 可见性（列表/详情）：比可用性宽——动作行不是可见性的前提。 */
function visibleCredential(
  scope: PlatformScope,
  facts: CredentialFacts,
): boolean {
  const credential = facts.credential;
  if (!credential) return false;
  if (credential.status !== "active") return false;
  if (!facts.companyMembership) return false;
  if (facts.companyMembership.status !== "active") return false;
  if (facts.companyMembership.epoch !== scope.memberEpoch) return false;
  const classification = classificationOf(credential.classification);
  if (classification === "personal") {
    return credential.ownerPrincipalId === scope.principalId;
  }
  if (classification === "team") {
    return facts.workspaceMembershipStatus === "active";
  }
  return true;
}

function redactedView(
  credential: NonNullable<CredentialFacts["credential"]>,
  grants: CredentialFacts["grants"],
): RedactedCredentialView {
  return Object.freeze({
    credentialId: credential.id,
    tenantId: credential.tenantId,
    kind: credential.kind as CredentialKind,
    classification: classificationOf(credential.classification),
    workspaceId: credential.workspaceId,
    target: credential.target,
    label: credential.label,
    status: "active" as const,
    effectiveActions: Object.freeze({
      use: grants.use,
      disclose: grants.disclose,
    }),
    createdAt: credential.createdAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 判定入口：受信 Scope → 受限角色事务 → 事实读取 → 判定
// ---------------------------------------------------------------------------

export interface CredentialOwnershipDecisionService {
  /** 业务使用判定：allow 独占携带密封材料；deny = canonical not-found。 */
  authorizeUse(
    scope: PlatformScope,
    credentialId: string,
  ): Promise<CredentialUseResolution>;
  /** 明文披露：唯一返回明文的入口；需独立 'disclose' 授权；allow 必写审计。 */
  disclosePlaintext(
    scope: PlatformScope,
    credentialId: string,
  ): Promise<CredentialDisclosure>;
  /** 脱敏列表：只含本人个人 ∪ 本人 active 团队的 team ∪ 本公司 company。 */
  listVisible(scope: PlatformScope): Promise<readonly RedactedCredentialView[]>;
  /** 脱敏详情；跨范围/不存在 = canonical not-found。 */
  describeCredential(
    scope: PlatformScope,
    credentialId: string,
  ): Promise<CredentialDetailResolution>;
}

/** 事务本地上下文 + advisory 共享锁（键序/键形与 resource-policy 判定入口一致）。 */
async function credentialReadTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  operation: (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership → credential
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

/**
 * 判定服务。事实读取全部经受限 data 角色与真实 RLS：跨公司凭据行对本事务
 * 不可见（事实即为「不存在」），判定内的租户/成员比对是第二道独立防线
 * （纵深防御）。
 */
export function createCredentialOwnershipDecisionService(
  data: DataDatabase,
  vault: SecretVault,
): CredentialOwnershipDecisionService {
  assertDataDatabase(data);
  /** 读取单凭据判定事实（调用方已在 credentialReadTransaction 内）。 */
  const readFacts = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: PlatformScope,
    credentialId: string,
    credentialKey: string,
  ): Promise<CredentialFacts> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${credentialKey}, 0))`,
    );
    const [row] = await tx
      .select({
        tenantId: credentialRows.tenantId,
        id: credentialRows.id,
        kind: credentialRows.kind,
        classification: credentialRows.classification,
        workspaceId: credentialRows.workspaceId,
        ownerPrincipalId: credentialRows.ownerPrincipalId,
        target: credentialRows.target,
        display: credentialRows.display,
        status: credentialRows.status,
        envelope: credentialRows.envelope,
        createdAt: credentialRows.createdAt,
        membershipStatus: enterpriseMemberships.status,
        membershipEpoch: enterpriseMemberships.epoch,
        workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
        useGrant: sql<
          string | null
        >`(select 1 from ${enterpriseCredentialActions} ga
          where ga.tenant_id = ${credentialRows.tenantId}
            and ga.credential_id = ${credentialRows.id}
            and ga.principal_id = ${scope.principalId}
            and ga.action = 'use' limit 1)`,
        discloseGrant: sql<
          string | null
        >`(select 1 from ${enterpriseCredentialActions} gd
          where gd.tenant_id = ${credentialRows.tenantId}
            and gd.credential_id = ${credentialRows.id}
            and gd.principal_id = ${scope.principalId}
            and gd.action = 'disclose' limit 1)`,
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
          eq(credentialRows.id, credentialId),
        ),
      )
      .limit(1);
    if (!row) {
      return {
        credential: null,
        companyMembership: null,
        workspaceMembershipStatus: null,
        grants: { use: false, disclose: false },
      };
    }
    return {
      credential: {
        tenantId: row.tenantId,
        id: row.id,
        kind: row.kind,
        classification: row.classification,
        workspaceId: row.workspaceId,
        ownerPrincipalId: row.ownerPrincipalId,
        target: row.target,
        label: (row.display as { label?: unknown }).label as string,
        status: row.status,
        envelope: row.envelope,
        createdAt: row.createdAt,
      },
      companyMembership:
        row.membershipStatus == null || row.membershipEpoch == null
          ? null
          : { status: row.membershipStatus, epoch: row.membershipEpoch },
      workspaceMembershipStatus: row.workspaceMembershipStatus ?? null,
      grants: {
        use: row.useGrant != null,
        disclose: row.discloseGrant != null,
      },
    };
  };

  return {
    async authorizeUse(scope, credentialId) {
      assertTrustedScope(scope);
      if (typeof credentialId !== "string" || !credentialId.trim()) {
        return DENY_VERDICT;
      }
      return credentialReadTransaction(data, scope, async (tx) => {
        const credentialKey = credentialLockKey(scope.tenantId, credentialId);
        const facts = await readFacts(tx, scope, credentialId, credentialKey);
        const verdict = decideCredential(scope, facts, "use");
        if (!verdict.allowed || !facts.credential) return DENY_VERDICT;
        return {
          outcome: "allow" as const,
          credential: redactedView(facts.credential, facts.grants),
          envelope: facts.credential.envelope,
        };
      });
    },

    async disclosePlaintext(scope, credentialId) {
      assertTrustedScope(scope);
      if (typeof credentialId !== "string" || !credentialId.trim()) {
        return DENY_VERDICT;
      }
      return credentialReadTransaction(data, scope, async (tx) => {
        const credentialKey = credentialLockKey(scope.tenantId, credentialId);
        const facts = await readFacts(tx, scope, credentialId, credentialKey);
        const verdict = decideCredential(scope, facts, "disclose");
        if (!verdict.allowed || !facts.credential) return DENY_VERDICT;
        // 明文只在授权披露路径离开信封；vault 失败响亮拒绝且绝不回显信封。
        let plaintext: string;
        try {
          plaintext = await vault.open(facts.credential.envelope);
        } catch {
          throw new Error("CREDENTIAL_SECRET_UNAVAILABLE");
        }
        const auditId = randomUUID();
        await tx.insert(enterpriseCredentialAudit).values({
          tenantId: facts.credential.tenantId,
          id: auditId,
          credentialId: facts.credential.id,
          principalId: scope.principalId,
          action: "plaintext.disclosed",
          detail: {
            kind: facts.credential.kind,
            classification: facts.credential.classification,
            target: facts.credential.target,
          },
        });
        return { outcome: "allow" as const, plaintext, auditId };
      });
    },

    async listVisible(scope) {
      assertTrustedScope(scope);
      return credentialReadTransaction(data, scope, async (tx) => {
        const rows = await tx
          .select({
            tenantId: credentialRows.tenantId,
            id: credentialRows.id,
            kind: credentialRows.kind,
            classification: credentialRows.classification,
            workspaceId: credentialRows.workspaceId,
            ownerPrincipalId: credentialRows.ownerPrincipalId,
            target: credentialRows.target,
            display: credentialRows.display,
            status: credentialRows.status,
            createdAt: credentialRows.createdAt,
            membershipStatus: enterpriseMemberships.status,
            membershipEpoch: enterpriseMemberships.epoch,
            workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
            useGrant: sql<
              string | null
            >`(select 1 from ${enterpriseCredentialActions} ga
              where ga.tenant_id = ${credentialRows.tenantId}
                and ga.credential_id = ${credentialRows.id}
                and ga.principal_id = ${scope.principalId}
                and ga.action = 'use' limit 1)`,
            discloseGrant: sql<
              string | null
            >`(select 1 from ${enterpriseCredentialActions} gd
              where gd.tenant_id = ${credentialRows.tenantId}
                and gd.credential_id = ${credentialRows.id}
                and gd.principal_id = ${scope.principalId}
                and gd.action = 'disclose' limit 1)`,
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
              eq(
                enterpriseWorkspaceMemberships.tenantId,
                credentialRows.tenantId,
              ),
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
              eq(credentialRows.status, "active"),
            ),
          )
          .orderBy(asc(credentialRows.createdAt), asc(credentialRows.id));
        const views: RedactedCredentialView[] = [];
        for (const row of rows) {
          const facts: CredentialFacts = {
            credential: {
              tenantId: row.tenantId,
              id: row.id,
              kind: row.kind,
              classification: row.classification,
              workspaceId: row.workspaceId,
              ownerPrincipalId: row.ownerPrincipalId,
              target: row.target,
              label: (row.display as { label?: unknown }).label as string,
              status: row.status,
              envelope: "",
              createdAt: row.createdAt,
            },
            companyMembership:
              row.membershipStatus == null || row.membershipEpoch == null
                ? null
                : { status: row.membershipStatus, epoch: row.membershipEpoch },
            workspaceMembershipStatus: row.workspaceMembershipStatus ?? null,
            grants: {
              use: row.useGrant != null,
              disclose: row.discloseGrant != null,
            },
          };
          if (!visibleCredential(scope, facts) || !facts.credential) continue;
          views.push(redactedView(facts.credential, facts.grants));
        }
        return Object.freeze(views);
      });
    },

    async describeCredential(scope, credentialId) {
      assertTrustedScope(scope);
      if (typeof credentialId !== "string" || !credentialId.trim()) {
        return DENY_VERDICT;
      }
      return credentialReadTransaction(data, scope, async (tx) => {
        const credentialKey = credentialLockKey(scope.tenantId, credentialId);
        const facts = await readFacts(tx, scope, credentialId, credentialKey);
        if (!visibleCredential(scope, facts) || !facts.credential) {
          return DENY_VERDICT;
        }
        return {
          outcome: "allow" as const,
          credential: redactedView(facts.credential, facts.grants),
        };
      });
    },
  };
}
