// server/src/enterprise/tenancy/root-backfill.ts
// MT113（Issue #156）：历史根记录归属回填并保持既有个人授权。
//
// 票面语义：把历史业务根记录归属到原有公司与默认团队（MT112 锚点），
// 同时保持既有个人授权不变——个人权限未被放宽为团队可见；无法唯一
// 归属的记录进入受控隔离清单并阻断相关启用，不按猜测分配。
//
// 结构（MT112 同款迁移语义的工具面；生产执行不在本票）：
//
//   1. 根记录集（主库五类，全部从真实遗留表逐行推导，零手写清单）：
//        agents → kind='bot'           现行可见面 = 全部署用户（requireUser
//                                      即可列 Bot，agents 路由无第二道门）
//        channels → kind='channel'     现行可见面 = channel_memberships 成员
//        credentials → kind='credential' 现行可见面 = 全部署用户（部署级
//                                      服务凭据，无 per-user 列）
//        craft_sessions → kind='craft-session' 现行可见面 = 属主本人
//        expert_installs → kind='marketplace-install' 现行可见面 = 属主本人
//     「保持既有个人授权」的机制形状：资源行一律 visibility='private'
//     （绝不为图省事置 'workspace'——那就是 AC1 禁止的放宽），可见集合
//     由 enterprise_resource_grants('read') 逐主体复刻：部署级类授予全体
//     用户、频道类授予成员、个人类只授予属主。授予目标主体先幂等落地
//     principal + 公司成员关系（role='member'——绝不发 tenant_admin，
//     回填不制造管理员）；principal 按 user_id 既有行解析（锚点用户沿用
//     MT112 的锚点主体，不造第二主体）。
//   2. 无法唯一归属 → 受控隔离清单：记录 id 已被**另一租户**的
//      enterprise_resources 行认领时，归属不唯一——进 quarantined
//      （kind+recordId+reason），零写入、不猜（同租户已存在 = already，
//      幂等跳过不算隔离）。rootBackfillReadiness 以隔离清单非空为
//      ready=false（阻断相关启用）；持久隔离表是 MT120 的面，本门从活
//      数据确定性重算——同一事实源，不另立存储。
//   3. 幂等与 dry-run：全部写入 ON CONFLICT DO NOTHING + 单事务；dry-run
//      与 apply 走同一计划推导，dry-run 零写入；重复 apply 第二轮
//      inserted 全零、终态一致（报表计数即证）。
//   4. 计数与抽样对照：分 kind 计数（scanned/attributedNew/already/
//      quarantined/grants）+ 逐 kind 抽样（displayName + 授权主体数），
//      供一致性校验（MT117）与后续批次消费。
//
// 通道纪律：写入走 setup/属主连接（迁移语义——受限角色对 principals 无
// INSERT 授权，这是 RLS 的故意设计，不是绕过）；验证读走受限角色与真实
// 判定面（测试侧）。环境守卫沿用 MT003 工具：只认显式专用测试库，绝不
// 回退开发库。
//
// 边界（诚实披露）：
//   - 本票只回填根记录（资源注册面 + 授权复刻）；域内归属表
//     （bot ownership/conversations/credentials/plugin installs）与子记录
//     是 MT114/MT115 的批次，不在此预支。
//   - #117（MT074 历史余额迁移）无已交付契约（wave16 票号映射分歧，协调
//     器裁决 A 案披露执行）；本面不消费余额迁移产物，仅与 MT074 共享
//     MT112 锚点（锚点幂等，两侧无顺序耦合）。
//   - 附件是频道的子记录（channelId 复合关联），归 MT114。

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

/** 根记录类别（闭集；kind 值即 enterprise_resources.kind）。 */
export const ROOT_BACKFILL_KINDS = [
  "bot",
  "channel",
  "credential",
  "craft-session",
  "marketplace-install",
] as const;
export type RootBackfillKind = (typeof ROOT_BACKFILL_KINDS)[number];

/** 隔离原因闭集（当前唯一成因：跨租户认领冲突）。 */
export const ROOT_BACKFILL_QUARANTINE_REASONS = [
  "claimed-by-another-tenant",
] as const;
export type RootBackfillQuarantineReason =
  (typeof ROOT_BACKFILL_QUARANTINE_REASONS)[number];

export type RootBackfillMode = "dry-run" | "apply";

export interface RootBackfillInput {
  readonly mode: RootBackfillMode;
  /** 默认团队 workspace id（MT112 锚点产物；显式输入，不内部猜测）。 */
  readonly defaultWorkspaceId: string;
  /** 抽样上限（逐 kind）；默认 5。 */
  readonly sampleLimit?: number;
}

export interface RootBackfillKindCounters {
  readonly kind: RootBackfillKind;
  readonly scanned: number;
  readonly attributedNew: number;
  readonly alreadyPresent: number;
  readonly quarantined: number;
  readonly grants: number;
}

export interface RootBackfillSample {
  readonly kind: RootBackfillKind;
  readonly recordId: string;
  readonly displayName: string;
  readonly grantPrincipals: number;
}

export interface RootBackfillReport {
  readonly mode: RootBackfillMode;
  readonly anchorTenantId: string;
  readonly defaultWorkspaceId: string;
  readonly kinds: readonly RootBackfillKindCounters[];
  readonly quarantined: readonly {
    readonly kind: RootBackfillKind;
    readonly recordId: string;
    readonly reason: RootBackfillQuarantineReason;
  }[];
  readonly samples: readonly RootBackfillSample[];
  /** 本次实际写入的行数（dry-run 恒为 0；重复 apply 第二轮为 0）。 */
  readonly wroteRows: number;
}

/** 拒绝哨兵：锚点缺失/不唯一、默认团队不属于锚点租户。 */
export const ROOT_BACKFILL_REFUSED = "ROOT_BACKFILL_REFUSED";

class RootBackfillRefusal extends Error {
  constructor(reason: string) {
    super(`${ROOT_BACKFILL_REFUSED}: ${reason}`);
  }
}

/** 每类根记录的源推导（一条 SQL：行 id、展示名、授权用户集、冲突租户）。 */
const SOURCE_QUERY: Record<
  RootBackfillKind,
  (tenant: string) => ReturnType<typeof sql>
> = {
  bot: (tenant) => sql`
    select a.id, a.name as display_name,
      (select coalesce(json_agg(u.id), '[]'::json) from users u) as grant_users,
      (select r.tenant_id from enterprise_resources r where r.id = a.id and r.tenant_id <> ${tenant} limit 1) as conflict_tenant
    from agents a`,
  channel: (tenant) => sql`
    select c.id, c.name as display_name,
      (select coalesce(json_agg(m.user_id), '[]'::json) from channel_memberships m where m.channel_id = c.id) as grant_users,
      (select r.tenant_id from enterprise_resources r where r.id = c.id and r.tenant_id <> ${tenant} limit 1) as conflict_tenant
    from channels c`,
  credential: (tenant) => sql`
    select c.id::text, c.provider as display_name,
      (select coalesce(json_agg(u.id), '[]'::json) from users u) as grant_users,
      (select r.tenant_id from enterprise_resources r where r.id = c.id::text and r.tenant_id <> ${tenant} limit 1) as conflict_tenant
    from credentials c`,
  "craft-session": (tenant) => sql`
    select s.id, coalesce(s.name, s.id) as display_name,
      json_build_array(s.user_id) as grant_users,
      (select r.tenant_id from enterprise_resources r where r.id = s.id and r.tenant_id <> ${tenant} limit 1) as conflict_tenant
    from craft_sessions s`,
  "marketplace-install": (tenant) => sql`
    select e.id, e.expert_slug as display_name,
      json_build_array(e.owner_user_id) as grant_users,
      (select r.tenant_id from enterprise_resources r where r.id = e.id and r.tenant_id <> ${tenant} limit 1) as conflict_tenant
    from expert_installs e`,
};

interface SourceRow {
  readonly id: string;
  readonly display_name: string;
  readonly grant_users: string[];
  readonly conflict_tenant: string | null;
}

/** 运行回填：单事务推导 + （apply 时）幂等写入；dry-run 零写入。 */
export async function runRootBackfill(
  database: Database,
  input: RootBackfillInput,
): Promise<RootBackfillReport> {
  if (input.mode !== "dry-run" && input.mode !== "apply") {
    throw new RootBackfillRefusal("mode must be dry-run|apply");
  }
  if (
    typeof input.defaultWorkspaceId !== "string" ||
    !input.defaultWorkspaceId.trim()
  ) {
    throw new RootBackfillRefusal("defaultWorkspaceId is required");
  }
  const sampleLimit = Math.min(Math.max(input.sampleLimit ?? 5, 0), 50);

  return database.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);

    // 锚点：恰好一行（MT112 幂等产物）；缺失/多行都是拒绝，不猜。
    const anchors = (await tx.execute(
      sql`select tenant_id, deployment_tenant_id from enterprise_deployment_anchors`,
    )) as unknown as { tenant_id: string }[];
    if (anchors.length !== 1) {
      throw new RootBackfillRefusal(
        `expected exactly one MT112 anchor row, found ${anchors.length}`,
      );
    }
    const anchorTenantId = anchors[0].tenant_id;

    const workspaces = (await tx.execute(
      sql`select id from enterprise_workspaces where tenant_id = ${anchorTenantId} and id = ${input.defaultWorkspaceId}`,
    )) as unknown as { id: string }[];
    if (workspaces.length !== 1) {
      throw new RootBackfillRefusal(
        `default workspace ${input.defaultWorkspaceId} does not belong to anchor tenant ${anchorTenantId}`,
      );
    }

    // 全部授权主体先幂等落地（principal 按既有 user 行解析；成员一律
    // 'member'，绝不发管理员）。
    await tx.execute(sql`
      insert into enterprise_principals (id, user_id)
      select 'entp-legacy-' || u.id, u.id
      from users u
      on conflict (user_id) do nothing
    `);
    await tx.execute(sql`
      insert into enterprise_memberships (tenant_id, principal_id, role)
      select ${anchorTenantId}, p.id, 'member'
      from enterprise_principals p
      where p.user_id in (select id from users)
      on conflict (tenant_id, principal_id) do nothing
    `);

    const kinds: RootBackfillKindCounters[] = [];
    const quarantined: {
      kind: RootBackfillKind;
      recordId: string;
      reason: RootBackfillQuarantineReason;
    }[] = [];
    const samples: RootBackfillSample[] = [];
    let wroteRows = 0;

    for (const kind of ROOT_BACKFILL_KINDS) {
      const rows = (await tx.execute(
        SOURCE_QUERY[kind](anchorTenantId),
      )) as unknown as SourceRow[];
      let attributedNew = 0;
      let alreadyPresent = 0;
      let kindQuarantined = 0;
      let grants = 0;

      for (const row of rows) {
        if (row.conflict_tenant !== null) {
          kindQuarantined += 1;
          quarantined.push({
            kind,
            recordId: row.id,
            reason: "claimed-by-another-tenant",
          });
          continue;
        }
        const existing = (await tx.execute(
          sql`select 1 from enterprise_resources where tenant_id = ${anchorTenantId} and id = ${row.id}`,
        )) as unknown as unknown[];
        const isPresent = existing.length > 0;
        if (isPresent) {
          alreadyPresent += 1;
        } else if (input.mode === "apply") {
          const inserted = (await tx.execute(sql`
            insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, visibility, status)
            values (${anchorTenantId}, ${row.id}, ${input.defaultWorkspaceId}, ${kind}, ${row.display_name}, 'private', 'active')
            on conflict (tenant_id, id) do nothing
            returning 1
          `)) as unknown as unknown[];
          wroteRows += inserted.length;
          attributedNew += inserted.length > 0 ? 1 : 0;
        } else {
          attributedNew += 1;
        }

        // 授权复刻：grant 主体按 user 解析的 principal（不构造 id）。
        // json 列经驱动可能以字符串形态返回——先归一到数组，绝不猜形状。
        const grantUsers = Array.isArray(row.grant_users)
          ? row.grant_users
          : typeof row.grant_users === "string"
            ? (JSON.parse(row.grant_users) as string[])
            : [];
        // 授权复刻只在 apply 写入：dry-run 绝不落任何行（资源行未写时
        // grant 的 FK 也无从谈起）。每用户单独占位符（sql.join）——数组
        // 整参会被驱动按单值绑定，逐元素占位既安全又不受驱动数组语义影响。
        if (grantUsers.length > 0 && input.mode === "apply") {
          const userList = sql.join(
            grantUsers.map((user) => sql`${user}`),
            sql`, `,
          );
          const insertedGrants = (await tx.execute(sql`
            insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action)
            select ${anchorTenantId}, ${row.id}, p.id, 'read'
            from enterprise_principals p
            where p.user_id = any(array[${userList}]::text[])
            on conflict (tenant_id, resource_id, principal_id, action) do nothing
            returning 1
          `)) as unknown as unknown[];
          wroteRows += insertedGrants.length;
          grants += insertedGrants.length;
        }
        // 无成员频道等：零授权是既有事实的如实复刻（不是缺漏）。

        if (samples.filter((s) => s.kind === kind).length < sampleLimit) {
          const counted = (await tx.execute(sql`
            select count(*)::int as n
            from enterprise_resource_grants
            where tenant_id = ${anchorTenantId} and resource_id = ${row.id}
          `)) as unknown as { n: number }[];
          samples.push({
            kind,
            recordId: row.id,
            displayName: row.display_name,
            grantPrincipals: Number(counted[0]?.n ?? 0),
          });
        }
      }

      kinds.push({
        kind,
        scanned: rows.length,
        attributedNew,
        alreadyPresent,
        quarantined: kindQuarantined,
        grants,
      });
    }

    return {
      mode: input.mode,
      anchorTenantId,
      defaultWorkspaceId: input.defaultWorkspaceId,
      kinds,
      quarantined,
      samples,
      wroteRows: input.mode === "apply" ? wroteRows : 0,
    };
  });
}

export interface RootBackfillReadiness {
  readonly ready: boolean;
  readonly quarantined: readonly {
    readonly kind: RootBackfillKind;
    readonly recordId: string;
    readonly reason: RootBackfillQuarantineReason;
  }[];
}

/**
 * AC2 的阻断半边：隔离清单非空 ⇒ ready=false。确定性重算（与 runRootBackfill
 * 同一推导），不落第二份存储——持久隔离表是 MT120 的面。
 */
export async function rootBackfillReadiness(
  database: Database,
  defaultWorkspaceId: string,
): Promise<RootBackfillReadiness> {
  const report = await runRootBackfill(database, {
    mode: "dry-run",
    defaultWorkspaceId,
  });
  return {
    ready: report.quarantined.length === 0,
    quarantined: report.quarantined,
  };
}
