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

/** A comparable source version: a non-negative safe integer, never a default (T03.01). */
function isComparableVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * T06.03 (#575): the versions a ba-issued scope carries. Legacy and paused
 * branches keep their original issuance (scopes without versions, T03.01), so
 * their decisions stay byte for byte as before — a version that cannot be
 * compared was never in this world, not a reason to default one.
 */
function sourceVersionsOf(
  scope: PlatformScope,
): { identity: number; company: number } | null {
  if (
    !isComparableVersion(scope.identityGeneration) ||
    !isComparableVersion(scope.companyGeneration)
  ) {
    return null;
  }
  return {
    identity: scope.identityGeneration,
    company: scope.companyGeneration,
  };
}

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
    /**
     * T06.03 (#575): the personal owner's verified source generations at
     * issuance (identity/company clock). Written together or not at all; the
     * decision compares them live, and a credential that predates them (or
     * whose pair drifted) is never restored from the current identity.
     */
    readonly ownerIdentityGeneration?: number;
    readonly ownerCompanyGeneration?: number;
  }): Promise<{ readonly credentialId: string }>;
  /**
   * 本公司凭据名册（MT095 / Issue #138 AC2 的公司半边）：operator 通道、租户 pin 下的
   * 只读投影，逐行返回与 detail 同形的**脱敏视图**（RedactedCredentialView——类型上无
   * envelope/plaintext 字段）。名册结构性不含其他公司的行（RLS），也结构性不含任何
   * 密封材料（投影不选 envelope 列，非约定脱敏）。
   */
  listForTenant(input: {
    readonly tenantId: string;
  }): Promise<readonly RedactedCredentialView[]>;
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
    /**
     * T06.03 (#575): the grantee's verified source generations at issuance
     * (identity/company pair, both or neither) and — for team-classified
     * credentials — the source team's generation. The decision refuses a
     * grant whose saved source is missing or has drifted, never stamping the
     * current one (design F01).
     */
    readonly identityGeneration?: number;
    readonly companyGeneration?: number;
    readonly sourceTeamGeneration?: number;
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
        "ownerIdentityGeneration",
        "ownerCompanyGeneration",
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
      let ownerIdentityGeneration: number | null = null;
      let ownerCompanyGeneration: number | null = null;
      if (
        input.ownerIdentityGeneration !== undefined ||
        input.ownerCompanyGeneration !== undefined
      ) {
        if (input.classification !== "personal") {
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: owner generations take personal credentials",
          );
        }
        if (
          input.ownerIdentityGeneration === undefined ||
          input.ownerCompanyGeneration === undefined
        ) {
          // 一次重新核验是一个原子事实：两个版本同时写或同时缺失。
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: owner generations are written together",
          );
        }
        if (
          !isComparableVersion(input.ownerIdentityGeneration) ||
          !isComparableVersion(input.ownerCompanyGeneration)
        ) {
          throw new Error(
            "CREDENTIAL_REGISTER_INVALID: ownerIdentityGeneration/ownerCompanyGeneration",
          );
        }
        ownerIdentityGeneration = input.ownerIdentityGeneration;
        ownerCompanyGeneration = input.ownerCompanyGeneration;
      }
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
        await tx.insert(credentialRows).values(
          ownerIdentityGeneration === null
            ? {
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
              }
            : {
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
                // T06.03: an island that predates the source-generation
                // columns keeps the original INSERT shape; a versioned
                // issuance writes the pair together.
                ownerIdentityGeneration,
                ownerCompanyGeneration,
              },
        );
      });
      return { credentialId };
    },

    async listForTenant(input) {
      assertOperatorDatabase(operator);
      const tenantId = requireString(input.tenantId, "tenantId", 1, 128);
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        // 脱敏投影：只选非机密列（不选 envelope），行形由 RLS 租户 pin 收口。
        const rows = await tx
          .select({
            credentialId: credentialRows.id,
            kind: credentialRows.kind,
            classification: credentialRows.classification,
            workspaceId: credentialRows.workspaceId,
            target: credentialRows.target,
            label: sql<string>`coalesce(${credentialRows.display} ->> 'label', '')`,
            createdAt: credentialRows.createdAt,
          })
          .from(credentialRows)
          .where(
            and(
              eq(credentialRows.tenantId, tenantId),
              eq(credentialRows.status, "active"),
            ),
          )
          .orderBy(asc(credentialRows.createdAt));
        if (rows.length === 0) return [];
        // 动作授权事实：名册里 effectiveActions = 该凭据是否至少有一条
        // use / disclose 授权行（管理面可见性，不是某个成员的可用性）。
        const actionRows = await tx
          .select({
            credentialId: enterpriseCredentialActions.credentialId,
            action: enterpriseCredentialActions.action,
          })
          .from(enterpriseCredentialActions)
          .where(eq(enterpriseCredentialActions.tenantId, tenantId));
        const granted = new Map<string, { use: boolean; disclose: boolean }>();
        for (const row of actionRows) {
          const flags = granted.get(row.credentialId) ?? {
            use: false,
            disclose: false,
          };
          if (row.action === "use") flags.use = true;
          else flags.disclose = true;
          granted.set(row.credentialId, flags);
        }
        return rows.map((row) =>
          Object.freeze({
            credentialId: row.credentialId,
            tenantId,
            kind: row.kind as CredentialKind,
            classification: classificationOf(row.classification),
            workspaceId: row.workspaceId,
            target: row.target,
            label: row.label,
            status: "active" as const,
            effectiveActions: Object.freeze(
              granted.get(row.credentialId) ?? { use: false, disclose: false },
            ),
            createdAt: row.createdAt.toISOString(),
          } satisfies RedactedCredentialView),
        );
      });
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
      let sourceVersions: { identity: number; company: number } | null = null;
      if (
        input.identityGeneration !== undefined ||
        input.companyGeneration !== undefined
      ) {
        if (
          input.identityGeneration === undefined ||
          input.companyGeneration === undefined
        ) {
          throw new Error(
            "CREDENTIAL_ACTION_INVALID: identity/company generations are written together",
          );
        }
        if (
          !isComparableVersion(input.identityGeneration) ||
          !isComparableVersion(input.companyGeneration)
        ) {
          throw new Error(
            "CREDENTIAL_ACTION_INVALID: identityGeneration/companyGeneration",
          );
        }
        sourceVersions = {
          identity: input.identityGeneration,
          company: input.companyGeneration,
        };
      }
      if (
        input.sourceTeamGeneration !== undefined &&
        !isComparableVersion(input.sourceTeamGeneration)
      ) {
        throw new Error("CREDENTIAL_ACTION_INVALID: sourceTeamGeneration");
      }
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        if (input.sourceTeamGeneration !== undefined) {
          // 团队来源版本只对团队归属凭据有意义（配对由命令层保证，这里拒绝错配）。
          const [credential] = await tx
            .select({ classification: credentialRows.classification })
            .from(credentialRows)
            .where(
              and(
                eq(credentialRows.tenantId, tenantId),
                eq(credentialRows.id, credentialId),
              ),
            )
            .limit(1);
          if (credential?.classification !== "team") {
            throw new Error(
              "CREDENTIAL_ACTION_INVALID: sourceTeamGeneration takes team credentials",
            );
          }
        }
        const baseValues = {
          tenantId,
          credentialId,
          principalId,
          action: input.action,
          grantedBy,
        };
        await tx
          .insert(enterpriseCredentialActions)
          .values(
            sourceVersions === null
              ? baseValues
              : {
                  ...baseValues,
                  // T06.03: the grant saves the source versions it was issued
                  // against; the decision compares them on every use/disclose.
                  identityGeneration: sourceVersions.identity,
                  companyGeneration: sourceVersions.company,
                  sourceTeamGeneration: input.sourceTeamGeneration ?? null,
                },
          )
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
    /**
     * T06.03 (#575): the personal owner's saved source generations. Only read
     * under a versioned (ba-issued) scope; absent means "cannot compare".
     */
    readonly ownerIdentityGeneration?: number | null;
    readonly ownerCompanyGeneration?: number | null;
  } | null;
  readonly companyMembership: {
    readonly status: string;
    readonly epoch: number;
  } | null;
  readonly workspaceMembershipStatus: string | null;
  readonly grants: { readonly use: boolean; readonly disclose: boolean };
  /**
   * True when the personal owner half is still current: the bare owner id
   * match alone is not authority — under a versioned scope the saved owner
   * pair must equal the caller's current versions, and the legacy/paused path
   * (no versions to compare) keeps the original id-only decision.
   */
  readonly ownerCurrent: boolean;
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
    const isOwner =
      credential.ownerPrincipalId === scope.principalId && facts.ownerCurrent;
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
  scope: PlatformScope,
  credential: NonNullable<CredentialFacts["credential"]>,
  grants: CredentialFacts["grants"],
): RedactedCredentialView {
  // 个人凭据的可用/披露按属主判定（与 decideCredential 同一语义，属主无需
  // 动作行）；展示若只映射动作行，属主视图会显示 false 而判定放行。
  const personalOwner =
    classificationOf(credential.classification) === "personal" &&
    credential.ownerPrincipalId === scope.principalId;
  const effectiveActions = personalOwner
    ? { use: true, disclose: true }
    : { use: grants.use, disclose: grants.disclose };
  return Object.freeze({
    credentialId: credential.id,
    tenantId: credential.tenantId,
    kind: credential.kind as CredentialKind,
    classification: classificationOf(credential.classification),
    workspaceId: credential.workspaceId,
    target: credential.target,
    label: credential.label,
    status: "active" as const,
    effectiveActions: Object.freeze(effectiveActions),
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

/** Drizzle execute results arrive as rows or wrapped rows depending on driver shape. */
function rowsOfResult(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/**
 * T06.03 (#575): the use/disclose verdicts the versioned scope earns — an
 * action row counts only while its saved source is the caller's current one,
 * and for team-classified credentials its saved team generation is still the
 * credential's own team clock generation. A missing or drifted version (or a
 * missing clock) is "cannot compare", never valid: the row was granted
 * against a source that no longer holds authority.
 */
async function readGrantSourceVerdicts(
  tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  scope: PlatformScope,
  credentialId: string,
  classification: CredentialClassification,
  workspaceId: string | null,
  versions: { identity: number; company: number },
): Promise<{ use: boolean; disclose: boolean }> {
  const rows = await tx
    .select({
      action: enterpriseCredentialActions.action,
      identityGeneration: enterpriseCredentialActions.identityGeneration,
      companyGeneration: enterpriseCredentialActions.companyGeneration,
      sourceTeamGeneration: enterpriseCredentialActions.sourceTeamGeneration,
    })
    .from(enterpriseCredentialActions)
    .where(
      and(
        eq(enterpriseCredentialActions.tenantId, scope.tenantId),
        eq(enterpriseCredentialActions.credentialId, credentialId),
        eq(enterpriseCredentialActions.principalId, scope.principalId),
      ),
    );
  // 适用 team generation：凭据所属团队的实时 clock（scope 只携带所选团队）。
  let teamGeneration: number | null = null;
  if (classification === "team") {
    const clocks = rowsOfResult(
      await tx.execute(
        sql`select scope_id, generation::text as generation, tombstone from auth_read_eligibility_clocks(${scope.tenantId}, ${scope.principalId}) where kind = 'team'`,
      ),
    );
    const clock = clocks.find(
      (entry) =>
        String(entry.scope_id) === workspaceId && entry.tombstone !== true,
    );
    const generation = clock ? Number(clock.generation) : Number.NaN;
    teamGeneration = isComparableVersion(generation) ? generation : null;
  }
  const current = (action: CredentialAction): boolean => {
    const row = rows.find((entry) => entry.action === action);
    if (!row) return false;
    if (row.identityGeneration !== versions.identity) return false;
    if (row.companyGeneration !== versions.company) return false;
    if (classification !== "team") return true;
    return (
      teamGeneration !== null &&
      row.sourceTeamGeneration !== null &&
      row.sourceTeamGeneration === teamGeneration
    );
  };
  return { use: current("use"), disclose: current("disclose") };
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
    // T06.03: only a versioned (ba-issued) scope can compare source
    // generations; the legacy/paused issuance has none and keeps its original
    // read/decision unchanged (including islands that predate the columns).
    const versions = sourceVersionsOf(scope);
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
        ...(versions
          ? {
              ownerIdentityGeneration: credentialRows.ownerIdentityGeneration,
              ownerCompanyGeneration: credentialRows.ownerCompanyGeneration,
            }
          : {}),
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
        ownerCurrent: true,
      };
    }
    const classification = classificationOf(row.classification);
    const sourceCurrent =
      versions === null
        ? null
        : await readGrantSourceVerdicts(
            tx,
            scope,
            row.id,
            classification,
            row.workspaceId,
            versions,
          );
    return {
      credential: {
        tenantId: row.tenantId,
        id: row.id,
        kind: row.kind,
        classification: row.classification,
        workspaceId: row.workspaceId,
        ownerPrincipalId: row.ownerPrincipalId,
        target: row.target,
        // display JSON 可能缺 label（或 display 为 null）：脱敏视图的
        // label 契约是 string，缺键回落空串而不是泄漏 undefined。
        label:
          ((row.display as { label?: unknown } | null)?.label as
            | string
            | undefined) ?? "",
        status: row.status,
        envelope: row.envelope,
        createdAt: row.createdAt,
        ownerIdentityGeneration: row.ownerIdentityGeneration ?? null,
        ownerCompanyGeneration: row.ownerCompanyGeneration ?? null,
      },
      companyMembership:
        row.membershipStatus == null || row.membershipEpoch == null
          ? null
          : { status: row.membershipStatus, epoch: row.membershipEpoch },
      workspaceMembershipStatus: row.workspaceMembershipStatus ?? null,
      grants: {
        use:
          row.useGrant != null && (sourceCurrent === null || sourceCurrent.use),
        disclose:
          row.discloseGrant != null &&
          (sourceCurrent === null || sourceCurrent.disclose),
      },
      ownerCurrent:
        versions === null
          ? true
          : row.ownerIdentityGeneration === versions.identity &&
            row.ownerCompanyGeneration === versions.company,
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
          credential: redactedView(scope, facts.credential, facts.grants),
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
              label:
                ((row.display as { label?: unknown } | null)?.label as
                  | string
                  | undefined) ?? "",
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
            // 读元数据不等于 use 或 disclose：列表可见性不消费来源代际。
            ownerCurrent: true,
          };
          if (!visibleCredential(scope, facts) || !facts.credential) continue;
          views.push(redactedView(scope, facts.credential, facts.grants));
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
          credential: redactedView(scope, facts.credential, facts.grants),
        };
      });
    },
  };
}
