// server/src/enterprise/tenancy/sso-scim-config.ts
// MT026（Issue #69）：每公司 SSO 配置与 SCIM 目录绑定的公司管理面。
//
// 票面验收 2 的实现面：SSO 配置读取与修改仅限该公司授权管理员；跨公司
// 读取返回不可见语义。
//
// 隔离的三层结构（缺一不可）：
//   1. 结构层：每个方法只收受信 CompanyAdminContext（MT006 签发半边的
//      WeakSet 信任 + 租户绑定，复用 workspace-admin 导出的类型与断言）。
//      API 形状上不存在租户参数——跨公司读取不可表达；伪造上下文在任何
//      数据库访问之前拒绝（UNVERIFIED_ADMIN_CONTEXT）。
//   2. 判定层：每个写事务重验 tenant_admin 身份 + 公司 epoch + principal
//      状态（与 MT006 管理服务同一纪律）；签发后的漂移 → SCOPE_REVOKED。
//      读取/写入都 pin app.tenant_id = 上下文公司——"没有配置"与"别家
//      公司有配置"同码（SSO_CONFIG_NOT_FOUND / SCIM_BINDING_NOT_FOUND），
//      没有存在泄漏。
//   3. 存储层：enterprise_sso_configs / enterprise_scim_directory_bindings
//      的 RLS 策略按租户 pin（MT026 迁移），服务层纪律只是第一道防线。
//
// 文档纪律（MT014 先例）：SSO 配置文档只存引用（协议/issuer/domain/凭据
// 引用），秘密在凭据库；拒绝消息只含代码与字段路径，绝不回显值。SCIM
// 绑定的 connection_key 全局唯一：本司重复登记与别家已持有的 key 冲突
// 返回同一代码（SCIM_BINDING_EXISTS）——不泄漏持有者。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseScimDirectoryBindings,
  enterpriseSsoConfigs,
} from "../../db/schema/enterprise-sso-scim";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../../db/schema/enterprise-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// SSO 配置文档：严格形状；只存引用
// ---------------------------------------------------------------------------

export type SsoProtocol = "oidc" | "saml";

export interface CompanySsoConfigDocument {
  protocol: SsoProtocol;
  issuer: string;
  /** 路由域：email @ 后缀决定谁被送到这家公司的 IdP。 */
  domain: string;
  /** 凭据引用（寻址），绝不是秘密本身。 */
  credentialRef: string;
}

const ISSUER_MAX = 200;
const DOMAIN_MAX = 253;
const REF_MAX = 200;

function isPostgresErrorCode(error: unknown, sqlstate: string): boolean {
  // Drizzle wraps driver errors (and the Bun-native driver carries the
  // SQLSTATE in `errno`, postgres.js in `code`), so the state is matched
  // along the cause chain, bounded depth.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      const shaped = current as { code?: string; errno?: string };
      if (shaped.code === sqlstate || shaped.errno === sqlstate) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function failInvalid(path: string, rule: string): never {
  throw new Error(`SSO_CONFIG_INVALID: ${path} ${rule}`);
}

function parseSsoConfigDocument(value: unknown): CompanySsoConfigDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failInvalid("document", "must be an object");
  }
  const source = value as Record<string, unknown>;
  const protocol = source.protocol;
  if (protocol !== "oidc" && protocol !== "saml") {
    failInvalid("protocol", "must be 'oidc' or 'saml'");
  }
  const issuer = source.issuer;
  if (
    typeof issuer !== "string" ||
    !issuer.trim() ||
    issuer.length > ISSUER_MAX ||
    !/^https:\/\//.test(issuer)
  ) {
    failInvalid(
      "issuer",
      `must be an https URL of at most ${ISSUER_MAX} characters`,
    );
  }
  const domain = source.domain;
  if (
    typeof domain !== "string" ||
    !domain.trim() ||
    domain.length > DOMAIN_MAX ||
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)
  ) {
    failInvalid("domain", "must be a lowercase hostname");
  }
  const credentialRef = source.credentialRef;
  if (
    typeof credentialRef !== "string" ||
    !credentialRef.trim() ||
    credentialRef.length > REF_MAX
  ) {
    failInvalid(
      "credentialRef",
      `must be a non-empty reference of at most ${REF_MAX} characters`,
    );
  }
  return { protocol, issuer, domain, credentialRef };
}

// ---------------------------------------------------------------------------
// 服务：公司管理面上的 SSO 配置与 SCIM 绑定
// ---------------------------------------------------------------------------

export interface RegisteredScimBindingView {
  readonly bindingId: string;
  readonly connectionKey: string;
  readonly status: "active" | "deactivated";
}

export interface CompanySsoScimConfigService {
  readSsoConfig(context: CompanyAdminContext): Promise<{
    readonly config: CompanySsoConfigDocument;
    readonly revision: number;
  }>;
  writeSsoConfig(
    context: CompanyAdminContext,
    input: CompanySsoConfigDocument,
  ): Promise<{ readonly revision: number }>;
  registerScimBinding(
    context: CompanyAdminContext,
    input: { readonly connectionKey: string; readonly credentialRef: string },
  ): Promise<{ readonly bindingId: string }>;
  listScimBindings(
    context: CompanyAdminContext,
  ): Promise<readonly RegisteredScimBindingView[]>;
  deactivateScimBinding(
    context: CompanyAdminContext,
    connectionKey: string,
  ): Promise<{
    readonly bindingId: string;
    readonly alreadyDeactivated: boolean;
  }>;
}

const CONNECTION_KEY_MAX = 200;
const CREDENTIAL_REF_MAX = 200;

function requireField(value: unknown, max: number, fail: () => never): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail();
  return value;
}

function tenantLockKey(tenantId: string): string {
  return JSON.stringify(["enterprise", "tenant", tenantId]);
}

type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

async function beginTransaction(tx: OperatorTransaction): Promise<void> {
  await tx.execute(sql`set transaction isolation level read committed`);
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

export function createCompanySsoScimConfigService(
  operator: OperatorDatabase,
): CompanySsoScimConfigService {
  assertOperatorDatabase(operator);

  /**
   * In-transaction revalidation of the acting admin (MT006 discipline):
   * active tenant_admin at the issued epoch, principal still active. Any
   * drift after issuance → SCOPE_REVOKED.
   */
  const revalidateAdmin = async (
    tx: OperatorTransaction,
    context: CompanyAdminContext,
  ): Promise<void> => {
    const [membership] = await tx
      .select({
        memberStatus: enterpriseMemberships.status,
        memberEpoch: enterpriseMemberships.epoch,
        role: enterpriseMemberships.role,
        principalStatus: enterprisePrincipals.status,
      })
      .from(enterpriseMemberships)
      .innerJoin(
        enterprisePrincipals,
        and(
          eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          sql`${enterprisePrincipals.id} = nullif(current_setting('app.operator_principal_id', true), '')`,
        ),
      )
      .where(
        and(
          eq(enterpriseMemberships.tenantId, context.tenantId),
          eq(enterpriseMemberships.principalId, context.principalId),
        ),
      )
      .limit(1);
    if (
      membership?.memberStatus !== "active" ||
      membership.principalStatus !== "active" ||
      membership.role !== "tenant_admin" ||
      membership.memberEpoch !== context.memberEpoch
    ) {
      throw new Error("SCOPE_REVOKED");
    }
  };

  /** Opens a management transaction pinned to the context's company. */
  const managementTransaction = async <T>(
    context: CompanyAdminContext,
    run: (tx: OperatorTransaction) => Promise<T>,
  ): Promise<T> =>
    operator.transaction(async (tx) => {
      await beginTransaction(tx);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${tenantLockKey(context.tenantId)}, 0))`,
      );
      await revalidateAdmin(tx, context);
      return run(tx);
    });

  return {
    async readSsoConfig(context) {
      assertTrustedAdminContext(context);
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true)`,
        );
        const [row] = await tx
          .select({
            document: enterpriseSsoConfigs.document,
            revision: enterpriseSsoConfigs.revision,
          })
          .from(enterpriseSsoConfigs)
          .where(eq(enterpriseSsoConfigs.tenantId, context.tenantId))
          .limit(1);
        // Same code as "no such company config" — reading another company's
        // config is not a distinguishable outcome (no existence leak).
        if (!row) throw new Error("SSO_CONFIG_NOT_FOUND");
        return {
          config: parseSsoConfigDocument(row.document),
          revision: row.revision,
        };
      });
    },

    async writeSsoConfig(context, input) {
      assertTrustedAdminContext(context);
      const document = parseSsoConfigDocument(input);
      return managementTransaction(context, async (tx) => {
        const [row] = await tx
          .insert(enterpriseSsoConfigs)
          .values({
            tenantId: context.tenantId,
            document,
            revision: 1,
          })
          .onConflictDoUpdate({
            target: enterpriseSsoConfigs.tenantId,
            set: {
              document,
              revision: sql`${enterpriseSsoConfigs.revision} + 1`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ revision: enterpriseSsoConfigs.revision });
        return { revision: row?.revision };
      });
    },

    async registerScimBinding(context, input) {
      assertTrustedAdminContext(context);
      const failKey = () =>
        failInvalid(
          "connectionKey",
          "must be a non-empty string of at most 200 characters",
        );
      const failRef = () =>
        failInvalid(
          "credentialRef",
          "must be a non-empty reference of at most 200 characters",
        );
      const connectionKey = requireField(
        input?.connectionKey,
        CONNECTION_KEY_MAX,
        failKey,
      );
      const credentialRef = requireField(
        input?.credentialRef,
        CREDENTIAL_REF_MAX,
        failRef,
      );
      return managementTransaction(context, async (tx) => {
        const bindingId = `binding-${crypto.randomUUID()}`;
        try {
          await tx.insert(enterpriseScimDirectoryBindings).values({
            id: bindingId,
            tenantId: context.tenantId,
            connectionKey,
            credentialRef,
          });
        } catch (error) {
          // Unique violation on connection_key: the key is already held —
          // by this company (duplicate) or another one (collision). The same
          // code for both: the holder's identity never leaks.
          if (isPostgresErrorCode(error, "23505")) {
            throw new Error("SCIM_BINDING_EXISTS");
          }
          throw error;
        }
        return { bindingId };
      });
    },

    async listScimBindings(context) {
      assertTrustedAdminContext(context);
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true)`,
        );
        const rows = await tx
          .select({
            bindingId: enterpriseScimDirectoryBindings.id,
            connectionKey: enterpriseScimDirectoryBindings.connectionKey,
            status: enterpriseScimDirectoryBindings.status,
          })
          .from(enterpriseScimDirectoryBindings)
          .where(eq(enterpriseScimDirectoryBindings.tenantId, context.tenantId))
          .orderBy(enterpriseScimDirectoryBindings.createdAt);
        return rows.map((row) => ({
          bindingId: row.bindingId,
          connectionKey: row.connectionKey,
          status: row.status as "active" | "deactivated",
        }));
      });
    },

    async deactivateScimBinding(context, connectionKey) {
      assertTrustedAdminContext(context);
      if (typeof connectionKey !== "string" || !connectionKey.trim()) {
        failInvalid("connectionKey", "must be a non-empty string");
      }
      return managementTransaction(context, async (tx) => {
        const updated = await tx
          .update(enterpriseScimDirectoryBindings)
          .set({ status: "deactivated", deactivatedAt: sql`now()` })
          .where(
            and(
              eq(enterpriseScimDirectoryBindings.tenantId, context.tenantId),
              eq(enterpriseScimDirectoryBindings.connectionKey, connectionKey),
              eq(enterpriseScimDirectoryBindings.status, "active"),
            ),
          )
          .returning({ id: enterpriseScimDirectoryBindings.id });
        if (updated.length === 1) {
          return { bindingId: updated[0]?.id, alreadyDeactivated: false };
        }
        // Either the key does not exist, or it belongs to another company
        // (RLS hid it), or it is already deactivated here. Read once to
        // distinguish the own-idempotent case; everything else is the same
        // NOT_FOUND (invisible).
        const [own] = await tx
          .select({ id: enterpriseScimDirectoryBindings.id })
          .from(enterpriseScimDirectoryBindings)
          .where(
            and(
              eq(enterpriseScimDirectoryBindings.tenantId, context.tenantId),
              eq(enterpriseScimDirectoryBindings.connectionKey, connectionKey),
            ),
          )
          .limit(1);
        if (own) {
          return { bindingId: own.id, alreadyDeactivated: true };
        }
        throw new Error("SCIM_BINDING_NOT_FOUND");
      });
    },
  };
}
