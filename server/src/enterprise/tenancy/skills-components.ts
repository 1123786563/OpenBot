// server/src/enterprise/tenancy/skills-components.ts
// MT033（Issue #76）：技能与组件发布、版本与组件数据函数的作用域。
//
// 票面语义：技能与组件的发布范围、版本与数据函数调用都按公司/团队
// 归属；团队公共技能对成员可用、不可改；组件数据函数以**调用者**身份
// 校验数据权限，不以组件作者身份放大权限；版本升级只影响本范围安装
// （另一公司的同名组件不受影响）；撤销发布后成员立即失去使用权。
//
// 结构（纯新增，零 schema 对象，只消费 enterprise_resources /
// enterprise_resource_grants / enterprise_memberships /
// workspace_memberships / enterprise_conversations 既有事实，不改任何
// 既有文件）：
//
//   1. 发布行 = enterprise_resources（kind='skill' / 'component'，
//      visibility='workspace' 即团队公共活跃行，revision=版本）；
//      发布者归属 = grants 行（principalId=发布者，action='read'，
//      MT024 附件上传者同款事实面）。
//   2. 版本升级是 append-only（MT017 先例：operator 对 resources 只有
//      INSERT 与 visibility/acl_epoch 列 UPDATE，无 revision UPDATE、
//      无 DELETE）——升级 = 旧行 visibility→'private'（软删，行策略
//      要求 set_config app.resource_id）+ 新行 INSERT（同名、
//      revision=目标版本）。"当前版本" = 活跃行（visibility=
//      'workspace'）的 revision；回放（to ≤ 当前）幂等收敛。
//   3. 撤销发布 = 活跃行 visibility→'private'——读取面只认活跃行，
//      成员下一次使用即 not-found（立即失效，MT010 软删语义）。
//   4. 组件数据函数（AC2）：invokeComponentFunction 对 threadId 的
//      会话门按**调用者本人** principalId 重验（MT025 订阅门同款），
//      作者身份不参与——组件作者建的数据函数读不到调用者无权的
//      他人会话（权限不被作者放大）。
//
// 拒绝形状：
//   - 不可见（未发布/跨团队/跨公司/不存在/已撤销）→ MT011 canonical
//     RESOURCE_NOT_FOUND，逐字节同形；
//   - 可见但被规则拒（成员改公共技能；非作者非 admin 升级/撤销；
//     版本回退）→ 明确业务码（SKILL_READ_ONLY / SKILL_PUBLISH_
//     FORBIDDEN / COMPONENT_VERSION_NOT_MONOTONIC）。
//
// 事务纪律与 MT019/MT020/MT023/MT024/MT025 一致：assertScopeContext →
// assertTrustedScope → read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → advisory 锁。锁序：tenant →
// principal → membership → workspace-membership → skill/component 名
// （判定读共享、发布/升级/撤销写排他）。读路径受限 data 角色，写路径
// 受限 operator 角色；升级/撤销采用 data 预读事实 + operator 只写的
// 两段式（operator 对 conversations 等表无读授权的既有坑不适用于
// resources，但写前事实重验统一走 data 通道）。
//
// 边界（诚实披露）：
//   - 技能/组件内容本体（manifest 存储、运行时执行）不在本票：本模块
//     是发布/受众/版本/调用授权面，运行时接线票在传输层消费；
//   - "可用不可改"指事实面不可原地修改（resources 列对 operator 只开
//      INSERT 与 visibility）——作者的演进路径是升级新版本或撤销发布。
//
// T06.05（Issue #577）：invokeComponentFunction 增加门 3——执行声明的
// 依赖项（包安装/连接/组件）逐项以调用者本人身份授权，任一项跨公司/
// 跨团队/停用/不存在 = canonical not-found；onExecute 探针恰在全部
// 通过的 allow 处触发一次（onVendorCall 同款观测纪律）。

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterprisePluginConnections,
  enterprisePluginInstalls,
} from "../../db/schema/enterprise-plugins";
import {
  enterpriseMemberships,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与判定形状
// ---------------------------------------------------------------------------

export const SKILL_RESOURCE_KIND = "skill";
export const COMPONENT_RESOURCE_KIND = "component";

/** 团队公共资源"可用不可改"（AC1：成员读 allow、改 deny）。 */
export interface SkillReadOnlyVerdict {
  readonly outcome: "deny";
  readonly code: "SKILL_READ_ONLY";
}

/** 可见前提下的管理拒绝（升级/撤销：非作者非 tenant_admin）。 */
export interface SkillPublishForbidden {
  readonly outcome: "deny";
  readonly code: "SKILL_PUBLISH_FORBIDDEN";
}

/** 版本回退（AC3 单调：目标版本低于当前活跃版本）。 */
export interface ComponentVersionNotMonotonic {
  readonly outcome: "deny";
  readonly code: "COMPONENT_VERSION_NOT_MONOTONIC";
}

export type SkillPublishDecision =
  | {
      readonly outcome: "allow";
      readonly name: string;
      readonly revision: number;
    }
  | ResourceNotFoundVerdict
  | SkillPublishForbidden
  | ComponentVersionNotMonotonic;

export type SkillReadDecision =
  | {
      readonly outcome: "allow";
      readonly name: string;
      readonly revision: number;
    }
  | ResourceNotFoundVerdict
  | SkillReadOnlyVerdict;

export type SkillComponentUseDecision =
  | {
      readonly outcome: "allow";
      readonly name: string;
      readonly revision: number;
      readonly functionName: string;
    }
  | ResourceNotFoundVerdict;

/**
 * 组件执行声明的依赖项（T06.05/#577）。依赖集是调用方（运行时装载器）
 * 的意图：每一项都在服务端以调用者本人身份逐项重验——不因同 team、
 * 目录 admin 或组件作者身份放大。shortcut: 依赖为声明制，本判定面
 * 无法察觉漏声明；真实装载各自还走其独立判定面（authorizeInvoke 等），
 * 本面是纵深防御的一层，不替代装载点门禁。
 */
export type ComponentDependencyRef =
  | { readonly kind: "plugin-install"; readonly installId: string }
  | { readonly kind: "plugin-connection"; readonly connectionId: string }
  | { readonly kind: "component"; readonly name: string };

function assertDependencyRef(value: unknown): ComponentDependencyRef {
  if (!value || typeof value !== "object") {
    throw new Error("COMPONENT_DEPENDENCY_INVALID");
  }
  const dep = value as Record<string, unknown>;
  if (dep.kind === "plugin-install") {
    rejectExtraKeys(dep, ["kind", "installId"], "COMPONENT_DEPENDENCY_INVALID");
    return {
      kind: "plugin-install",
      installId: requireDependencyRef(dep.installId),
    };
  }
  if (dep.kind === "plugin-connection") {
    rejectExtraKeys(
      dep,
      ["kind", "connectionId"],
      "COMPONENT_DEPENDENCY_INVALID",
    );
    return {
      kind: "plugin-connection",
      connectionId: requireDependencyRef(dep.connectionId),
    };
  }
  if (dep.kind === "component") {
    rejectExtraKeys(dep, ["kind", "name"], "COMPONENT_DEPENDENCY_INVALID");
    if (typeof dep.name !== "string") {
      throw new Error("COMPONENT_DEPENDENCY_INVALID: name");
    }
    return { kind: "component", name: assertName(dep.name) };
  }
  throw new Error("COMPONENT_DEPENDENCY_INVALID: kind");
}

function requireDependencyRef(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error("COMPONENT_DEPENDENCY_INVALID: ref");
  }
  return value;
}

function rejectExtraKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`${code}: unexpected field ${key}`);
    }
  }
}

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertName(name: string): string {
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > 200
  ) {
    throw new Error("SKILL_NAME_INVALID");
  }
  return name;
}

function assertRevision(revision: number): number {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("SKILL_REVISION_INVALID");
  }
  return revision;
}

function assertFunctionName(functionName: string): string {
  if (
    typeof functionName !== "string" ||
    functionName.trim().length === 0 ||
    functionName.length > 200
  ) {
    throw new Error("COMPONENT_FUNCTION_NAME_INVALID");
  }
  return functionName;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface SkillComponentService {
  /** 发布技能为团队公共（v1 或指定初始版本；作者是发布者本人）。 */
  publishSkill(
    scope: PlatformScope,
    input: { readonly name: string; readonly initialRevision?: number },
  ): Promise<SkillPublishDecision>;
  /** 成员读团队公共技能（AC1 可用面：活跃行 = 当前版本）。 */
  readSkill(scope: PlatformScope, name: string): Promise<SkillReadDecision>;
  /** 成员改团队公共技能（AC1 不可改面：可见但只读）。 */
  modifySkill(
    scope: PlatformScope,
    name: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<SkillReadDecision>;
  /** 发布组件为团队公共。 */
  publishComponent(
    scope: PlatformScope,
    input: { readonly name: string; readonly initialRevision?: number },
  ): Promise<SkillPublishDecision>;
  /** 版本升级（append-only 软删旧活跃行 + 新版本行；作者 ∨ admin）。 */
  upgradeComponent(
    scope: PlatformScope,
    input: { readonly name: string; readonly toRevision: number },
  ): Promise<SkillPublishDecision>;
  /** 组件数据函数调用门（AC2：以调用者身份校验，不以作者放大）。 */
  invokeComponentFunction(
    scope: PlatformScope,
    input: {
      readonly name: string;
      readonly functionName: string;
      readonly threadId?: string;
      /** 执行要装载的依赖项（声明制意图；逐项以调用者身份重验）。 */
      readonly dependencies?: readonly ComponentDependencyRef[];
    },
  ): Promise<SkillComponentUseDecision>;
  /** 撤销发布（作者 ∨ admin；活跃行软删 → 成员立即失去）。 */
  unpublish(
    scope: PlatformScope,
    input: { readonly kind: "skill" | "component"; readonly name: string },
  ): Promise<SkillPublishDecision>;
}

interface ActiveRowFacts {
  readonly id: string;
  readonly revision: number;
}

export function createSkillComponentService(
  channels: {
    readonly data: DataDatabase;
    readonly operator: OperatorDatabase;
  },
  /*
   * T06.05 观测面（MT031 onVendorCall 同款纪律）：onExecute 恰在全部门
   * （含逐项依赖授权）通过后的 allow 语句处触发一次——deny/错误路径绝不
   * 触发；观测者故障绝不影响判定。
   */
  probes?: { readonly onExecute?: () => void },
): SkillComponentService {
  const { data, operator } = channels;
  const notifyExecute = (): void => {
    try {
      probes?.onExecute?.();
    } catch {
      // 探针是观测面不是判定面。
    }
  };

  const kindOf = (kind: "skill" | "component"): string =>
    kind === "skill" ? SKILL_RESOURCE_KIND : COMPONENT_RESOURCE_KIND;

  const lockKeys = (
    tenantId: string,
    principalId: string,
    workspaceId: string,
    domainKey: string,
  ): readonly string[] => [
    JSON.stringify(["enterprise", "tenant", tenantId]),
    JSON.stringify(["enterprise", "principal", tenantId, principalId]),
    JSON.stringify(["enterprise", "membership", tenantId, principalId]),
    JSON.stringify([
      "enterprise",
      "workspace-membership",
      tenantId,
      workspaceId,
      principalId,
    ]),
    domainKey,
  ];

  /** 读路径事实（data 通道）：门 0 调用者 + 活跃行 + 作者 grants。 */
  const readFacts = async (
    scope: PlatformScope,
    kind: string,
    name: string,
    exclusive: boolean,
  ): Promise<
    | {
        readonly ok: true;
        readonly callerActive: true;
        readonly callerAdmin: boolean;
        readonly row: ActiveRowFacts | null;
        readonly authorPrincipalId: string | null;
      }
    | { readonly ok: false }
  > => {
    return data.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      /* Transaction-local settings are defense in depth for RLS. */
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
      );
      for (const key of lockKeys(
        scope.tenantId,
        scope.principalId,
        scope.workspaceId,
        JSON.stringify([
          "enterprise",
          kind,
          scope.tenantId,
          scope.workspaceId,
          name,
        ]),
      )) {
        await tx.execute(
          exclusive
            ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
        );
      }

      // ---- 门 0：调用者自身事实（每事务重验；撤权即死）。 ----
      const [member] = await tx
        .select({
          companyStatus: enterpriseMemberships.status,
          companyEpoch: enterpriseMemberships.epoch,
          role: enterpriseMemberships.role,
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
        member?.companyStatus !== "active" ||
        member.companyEpoch !== scope.memberEpoch ||
        member.teamStatus !== "active"
      ) {
        return { ok: false } as const;
      }

      // ---- 活跃发布行（当前版本的唯一事实）。 ----
      const [row] = await tx
        .select({
          id: enterpriseResources.id,
          revision: enterpriseResources.revision,
        })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, scope.tenantId),
            eq(enterpriseResources.kind, kind),
            eq(enterpriseResources.workspaceId, scope.workspaceId),
            eq(enterpriseResources.displayName, name),
            sql`${enterpriseResources.visibility} = 'workspace'`,
            sql`${enterpriseResources.status} = 'active'`,
          ),
        )
        .limit(1);

      // ---- 作者归属（发布者的 grants 行；无行 = 未发布过）。 ----
      let authorPrincipalId: string | null = null;
      if (row) {
        const [grant] = await tx
          .select({
            principalId: enterpriseResourceGrants.principalId,
          })
          .from(enterpriseResourceGrants)
          .where(
            and(
              eq(enterpriseResourceGrants.tenantId, scope.tenantId),
              eq(enterpriseResourceGrants.resourceId, row.id),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .limit(1);
        authorPrincipalId = grant?.principalId ?? null;
      }

      return {
        ok: true as const,
        callerActive: true as const,
        callerAdmin: member.role === "tenant_admin",
        row: row ?? null,
        authorPrincipalId,
      };
    });
  };

  /** 写路径（operator 通道）：软删旧行 + 插新行与作者 grants。 */
  const writePublication = async (
    scope: PlatformScope,
    input: {
      readonly kind: "skill" | "component";
      readonly name: string;
      readonly revision: number;
      readonly retireRowId?: string;
    },
  ): Promise<void> => {
    await operator.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.operator_principal_id', ${scope.principalId}, true)`,
      );
      if (input.retireRowId) {
        // UPDATE 行策略要求 app.resource_id 匹配目标行（MT020 同款）。
        await tx.execute(
          sql`select set_config('app.resource_id', ${input.retireRowId}, true)`,
        );
        await tx.execute(
          sql`update enterprise_resources set visibility = 'private' where tenant_id = ${scope.tenantId} and id = ${input.retireRowId}`,
        );
      }
      const newId = `${input.kind === "skill" ? "skill" : "cmp"}-${randomUUID()}`;
      await tx.execute(
        sql`insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, status, revision, visibility) values (${scope.tenantId}, ${newId}, ${scope.workspaceId}, ${kindOf(input.kind)}, ${input.name}, 'active', ${input.revision}, 'workspace')`,
      );
      await tx.execute(
        sql`insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values (${scope.tenantId}, ${newId}, ${scope.principalId}, 'read') on conflict do nothing`,
      );
    });
  };

  const retireActiveRow = async (
    scope: PlatformScope,
    rowId: string,
  ): Promise<void> => {
    await operator.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.operator_principal_id', ${scope.principalId}, true), set_config('app.resource_id', ${rowId}, true)`,
      );
      await tx.execute(
        sql`update enterprise_resources set visibility = 'private' where tenant_id = ${scope.tenantId} and id = ${rowId}`,
      );
    });
  };

  /** 发布/升级门：作者 ∨ tenant_admin（写前在 data 事实里重验）。 */
  const publishOrUpgrade = async (
    scope: PlatformScope,
    kind: "skill" | "component",
    name: string,
    revision: number,
  ): Promise<SkillPublishDecision> => {
    assertScopeContext(scope);
    assertTrustedScope(scope);
    assertName(name);
    assertRevision(revision);
    const facts = await readFacts(scope, kindOf(kind), name, true);
    if (!facts.ok) return notFoundVerdict();
    if (facts.row) {
      const isAuthor = facts.authorPrincipalId === scope.principalId;
      if (!isAuthor && !facts.callerAdmin) {
        return { outcome: "deny", code: "SKILL_PUBLISH_FORBIDDEN" } as const;
      }
      if (revision === facts.row.revision) {
        // 回放收敛：目标版本已是当前活跃版本（幂等，MT014 先例）。
        return { outcome: "allow", name, revision } as const;
      }
      if (revision < facts.row.revision) {
        return {
          outcome: "deny",
          code: "COMPONENT_VERSION_NOT_MONOTONIC",
        } as const;
      }
      await writePublication(scope, {
        kind,
        name,
        revision,
        retireRowId: facts.row.id,
      });
      return { outcome: "allow", name, revision } as const;
    }
    await writePublication(scope, { kind, name, revision });
    return { outcome: "allow", name, revision } as const;
  };

  return {
    async publishSkill(scope, input) {
      return publishOrUpgrade(
        scope,
        "skill",
        input.name,
        input.initialRevision ?? 1,
      );
    },

    async readSkill(scope, name) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertName(name);
      const facts = await readFacts(scope, SKILL_RESOURCE_KIND, name, false);
      if (!facts.ok) return notFoundVerdict();
      if (!facts.row) return notFoundVerdict();
      return {
        outcome: "allow",
        name,
        revision: facts.row.revision,
      } as const;
    },

    async modifySkill(scope, name, _patch) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertName(name);
      const facts = await readFacts(scope, SKILL_RESOURCE_KIND, name, false);
      if (!facts.ok) return notFoundVerdict();
      if (!facts.row) return notFoundVerdict();
      // AC1"可用不可改"：可见（成员、已发布）前提下的只读拒绝——
      // 对作者同样成立（演进路径 = 升级新版本或撤销发布）。
      return { outcome: "deny", code: "SKILL_READ_ONLY" } as const;
    },

    async publishComponent(scope, input) {
      return publishOrUpgrade(
        scope,
        "component",
        input.name,
        input.initialRevision ?? 1,
      );
    },

    async upgradeComponent(scope, input) {
      return publishOrUpgrade(scope, "component", input.name, input.toRevision);
    },

    async invokeComponentFunction(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertName(input.name);
      assertFunctionName(input.functionName);
      if (input.threadId !== undefined && !input.threadId.trim()) {
        throw new Error("THREAD_ID_INVALID");
      }
      const dependencies =
        input.dependencies === undefined
          ? []
          : input.dependencies.map(assertDependencyRef);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );
        for (const key of lockKeys(
          scope.tenantId,
          scope.principalId,
          scope.workspaceId,
          JSON.stringify([
            "enterprise",
            COMPONENT_RESOURCE_KIND,
            scope.tenantId,
            scope.workspaceId,
            input.name,
          ]),
        )) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        // ---- 依赖项锁（共享；install 键族与 plugin-catalog 一致，键序在基础键之后）。 ----
        for (const key of [
          ...new Set(
            dependencies.flatMap((dependency) =>
              dependency.kind === "plugin-install"
                ? [
                    JSON.stringify([
                      "enterprise",
                      "plugin-install",
                      scope.tenantId,
                      dependency.installId,
                    ]),
                  ]
                : dependency.kind === "component"
                  ? [
                      JSON.stringify([
                        "enterprise",
                        COMPONENT_RESOURCE_KIND,
                        scope.tenantId,
                        scope.workspaceId,
                        dependency.name,
                      ]),
                    ]
                  : [],
            ),
          ),
        ].sort()) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }

        // ---- 门 0：调用者自身事实。 ----
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
          member?.companyStatus !== "active" ||
          member.companyEpoch !== scope.memberEpoch ||
          member.teamStatus !== "active"
        ) {
          return notFoundVerdict();
        }

        // ---- 门 1：组件活跃行（本范围当前版本）。 ----
        const [row] = await tx
          .select({ revision: enterpriseResources.revision })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.kind, COMPONENT_RESOURCE_KIND),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.displayName, input.name),
              sql`${enterpriseResources.visibility} = 'workspace'`,
              sql`${enterpriseResources.status} = 'active'`,
            ),
          )
          .limit(1);
        if (!row) return notFoundVerdict();

        // ---- 门 2（AC2）：数据权限按调用者本人重验，作者身份不参与。 ----
        if (input.threadId !== undefined) {
          const [conversation] = await tx
            .select({ id: enterpriseConversations.id })
            .from(enterpriseConversations)
            .where(
              and(
                eq(enterpriseConversations.tenantId, scope.tenantId),
                eq(enterpriseConversations.workspaceId, scope.workspaceId),
                eq(enterpriseConversations.threadId, input.threadId),
                eq(enterpriseConversations.principalId, scope.principalId),
              ),
            )
            .limit(1);
          if (!conversation) return notFoundVerdict();
        }

        // ---- 门 3（T06.05/#577）：声明的依赖项逐项授权。每一项都以调用者
        // 本人身份重验（公司成员资格已在门 0 过；安装项再验其所在团队
        // active——与 plugin-catalog 的 invoke 判定同形）；任一项失败 =
        // canonical not-found，不泄露失败在哪一项，也不因同 team、目录
        // admin 或作者身份放大。 ----
        const installLoadable = async (installId: string): Promise<boolean> => {
          const [row] = await tx
            .select({
              status: enterprisePluginInstalls.status,
              workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
            })
            .from(enterprisePluginInstalls)
            .leftJoin(
              enterpriseWorkspaceMemberships,
              and(
                eq(
                  enterpriseWorkspaceMemberships.tenantId,
                  enterprisePluginInstalls.tenantId,
                ),
                eq(
                  enterpriseWorkspaceMemberships.workspaceId,
                  enterprisePluginInstalls.workspaceId,
                ),
                eq(
                  enterpriseWorkspaceMemberships.principalId,
                  scope.principalId,
                ),
              ),
            )
            .where(
              and(
                eq(enterprisePluginInstalls.tenantId, scope.tenantId),
                eq(enterprisePluginInstalls.id, installId),
              ),
            )
            .limit(1);
          // 跨公司安装行经 RLS 对本事务不可见（复合 FK 是结构兜底）。
          return (
            row?.status === "active" &&
            row.workspaceMembershipStatus === "active"
          );
        };
        for (const dependency of dependencies) {
          if (dependency.kind === "plugin-install") {
            if (!(await installLoadable(dependency.installId))) {
              return notFoundVerdict();
            }
            continue;
          }
          if (dependency.kind === "plugin-connection") {
            const [connection] = await tx
              .select({
                installId: enterprisePluginConnections.installId,
              })
              .from(enterprisePluginConnections)
              .where(
                and(
                  eq(enterprisePluginConnections.tenantId, scope.tenantId),
                  eq(enterprisePluginConnections.id, dependency.connectionId),
                ),
              )
              .limit(1);
            if (!connection) return notFoundVerdict();
            // 连接的复合外键保证与安装同公司；装载闸门按其安装重验
            // （plugin-catalog 的连接判定同款：以安装行为键）。
            await tx.execute(
              sql`select pg_advisory_xact_lock_shared(hashtextextended(${JSON.stringify(["enterprise", "plugin-install", scope.tenantId, connection.installId])}, 0))`,
            );
            if (!(await installLoadable(connection.installId))) {
              return notFoundVerdict();
            }
            continue;
          }
          const [dependencyRow] = await tx
            .select({ id: enterpriseResources.id })
            .from(enterpriseResources)
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                eq(enterpriseResources.kind, COMPONENT_RESOURCE_KIND),
                eq(enterpriseResources.workspaceId, scope.workspaceId),
                eq(enterpriseResources.displayName, dependency.name),
                sql`${enterpriseResources.visibility} = 'workspace'`,
                sql`${enterpriseResources.status} = 'active'`,
              ),
            )
            .limit(1);
          if (!dependencyRow) return notFoundVerdict();
        }
        notifyExecute();
        return {
          outcome: "allow",
          name: input.name,
          revision: row.revision,
          functionName: input.functionName,
        } as const;
      });
    },

    async unpublish(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertName(input.name);
      const facts = await readFacts(
        scope,
        kindOf(input.kind),
        input.name,
        true,
      );
      if (!facts.ok) return notFoundVerdict();
      if (!facts.row) return notFoundVerdict();
      const isAuthor = facts.authorPrincipalId === scope.principalId;
      if (!isAuthor && !facts.callerAdmin) {
        return { outcome: "deny", code: "SKILL_PUBLISH_FORBIDDEN" } as const;
      }
      await retireActiveRow(scope, facts.row.id);
      return {
        outcome: "allow",
        name: input.name,
        revision: facts.row.revision,
      } as const;
    },
  };
}

// 编译期通道形状自检（与 MT023/MT024/MT025 同款纪律）。
export type SkillComponentChannels = Parameters<
  typeof createSkillComponentService
>[0];
export function assertSkillComponentChannels(
  channels: SkillComponentChannels,
): void {
  assertOperatorDatabase(channels.operator);
}
