// server/src/enterprise/tenancy/external-files-migration.ts
// MT118（Issue #161）：对象存储文件与产物的归属迁移（第 1/3 段——映射臂）。
//
// 票面语义：对象存储中的业务文件、附件与产物按归属迁移或建立映射，路径
// 规则与授权一致，迁移幂等可续跑。
//
// 事实裁定（前置披露）：blocked-by #98（MT055「产物与对象存储路径按归属
// 隔离」）未交付——本工作区不存在任何已交付的对象存储物理分段方案
// （MT061 交付注释原话：「字节物理隔离（对象存储路径分段）是 MT055 的
// 交付；本模块管归属判定」；sandbox_instances.tenant_id 同为 MT057 预留
// 面）。票面允许「迁移**或**建立映射」——本段交付映射臂：为每类对象建立
// 确定性的归属映射（或进隔离清单），物理迁移（按 MT055 的分段方案重排
// 键）留待其交付后接线；不为未交付的路径方案发明事实。
//
// 结构（映射臂，纯重算、零业务写入）：
//   1. 类别闭集（四类，全部从权威 DB 行枚举，不扫裸存储——孤儿对象没有
//      行就没有业务身份，裸扫会制造隐式归属）：
//        openmuse-file-version  openmuse_file_versions × openmuse_files
//                               （键 = byte_path，服务端派生键原样；摘要
//                               可对照行内 sha256）
//        craft-snapshot         craft_snapshots × craft_sessions
//                               （键 = storage_path；行内无摘要，按
//                               size_bytes 对照）
//        workshop-artifact      workshop_artifacts × workshop_sessions
//                               （path 在沙箱工作区内，非对象存储键——
//                               映射面按 DB 事实，物理读取属沙箱面）
//        attachment             attachments（bytes 在主库行内；归属 =
//                               MT114 第一批落的父频道 attachment 关联）
//   2. 归属推导与第二批回填同一复合关联规则：属主主体恰一条 workspace
//      成员资格 → (tenant, workspace, principal) 三元组；零条/多条 =
//      ambiguous-membership 隔离；成员资格在他租户 = parent-tenant-mismatch
//      报告；attachment 按 batch1 父频道关联缺失 = parent-association-
//      missing 隔离。没有隐式默认归属（AC1）。
//   3. 幂等与续跑（AC2）：映射是确定性纯函数——重跑/中断后重算结果一致
//      （MT113「同一事实源，不另立存储」先例）；本工具零业务写入，业务
//      读取面不可能读到半迁移状态（无迁移写入即无半状态）。
//   4. 授权与下载一致性（AC3）：映射不改变任何键派生——下载仍走服务端
//      派生键（byte_path / storage_path 原样），注入的对象存储端口按同键
//      取回的字节与行内摘要/大小一致；映射的三元组与 DB 归属事实逐字
//      相等（与 MT061/MT047 消费的同一事实源）。
//   5. 报告（AC4）：逐类计数（scanned/mapped/quarantined）+ 逐类抽样 +
//      隔离清单 + 复现命令；物理迁移的接线缺口显式列在报告里（不借
//      「映射已建」宣称迁移已完成）。
//
// 边界（诚实披露）：
//   - 物理重排键（分段布局迁移）= MT055 交付后的事，本段不发明路径方案。
//   - 运行时状态与向量命名空间不在票面（不含）。
//   - 外部 S3/MinIO 不可用环境按票注用确定性 fake（注入端口）完成本地
//     验证，显式标记供应商半边未验证。

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

/** 对象存储端口：与 craft/storage/object-store.ts 的 get 同形（只读半边）。 */
export interface ObjectStorePort {
  get(key: string): Promise<Uint8Array | null>;
}

/** 类别闭集。 */
export const EXTERNAL_FILE_CATEGORIES = [
  "openmuse-file-version",
  "craft-snapshot",
  "workshop-artifact",
  "attachment",
] as const;
export type ExternalFileCategory = (typeof EXTERNAL_FILE_CATEGORIES)[number];

/** 隔离/未决原因闭集（与第二批回填共用前三个词汇）。 */
export const EXTERNAL_FILE_REASONS = [
  "owner-principal-missing",
  "ambiguous-membership",
  "parent-tenant-mismatch",
  "parent-association-missing",
] as const;
export type ExternalFileReason = (typeof EXTERNAL_FILE_REASONS)[number];

/** 摘要对照结果：match（行内摘要与端口字节一致）/ size-match（无摘要列，
 * 按大小一致）/ mismatch（不一致 = 未决项）/ missing（端口取不到）/
 * unavailable（无端口或非端口类别）。 */
export type DigestOutcome =
  | "match"
  | "size-match"
  | "mismatch"
  | "missing"
  | "unavailable";

export interface ExternalFileMappingEntry {
  readonly category: ExternalFileCategory;
  readonly recordId: string;
  /** 服务端派生键（原样，不重排——映射不改键派生）。 */
  readonly storageKey: string | null;
  readonly tenantId: string | null;
  readonly workspaceId: string | null;
  readonly ownerUserId: string | null;
  readonly digestOutcome: DigestOutcome;
}

export interface ExternalFileCategoryReport {
  readonly category: ExternalFileCategory;
  readonly scanned: number;
  readonly mapped: number;
  readonly quarantined: number;
  readonly digestMismatched: number;
  readonly samples: readonly ExternalFileMappingEntry[];
  readonly quarantinedEntries: readonly {
    readonly recordId: string;
    readonly reason: ExternalFileReason;
  }[];
}

export interface ExternalFilesMigrationReport {
  readonly anchorTenantId: string;
  /** 本段策略：映射臂（物理迁移接线缺口显式披露）。 */
  readonly strategy: {
    readonly arm: "ownership-mapping";
    readonly physicalRelocation: "deferred to MT055 (Issue #98, undelivered) — no delivered path segmentation scheme exists to migrate into";
  };
  readonly categories: readonly ExternalFileCategoryReport[];
  /** 未决项非空 ⇒ 本段映射不可当作完成（隔离/摘要不一致都是未决）。 */
  readonly openItems: readonly {
    readonly recordId: string;
    readonly reason: ExternalFileReason | "digest-mismatch";
  }[];
  readonly reproduce: {
    readonly command: string;
    readonly entrypoint: string;
  };
}

export const EXTERNAL_FILES_MIGRATION_REPRODUCE = {
  command:
    "bun test server/tests/multitenancy/external-files-migration.test.ts",
  entrypoint: "buildExternalFilesOwnershipMap",
} as const;

interface SourceRow {
  readonly id: string;
  readonly key: string | null;
  readonly owner_user_id: string | null;
  readonly sha256: string | null;
  readonly size_bytes: number | null;
  readonly bytes: Uint8Array | null;
  readonly owner_principal: string | null;
  readonly membership_count: number;
  readonly only_tenant: string | null;
  readonly only_workspace: string | null;
  readonly parent_association_ok: number;
  /** attachment 专用：第一批落的资源行 workspace（归属来自关联非成员资格）。 */
  readonly association_workspace?: string | null;
}

/** 每类源行查询（权威 DB 行枚举 + 归属事实 SQL 推导，与第二批同构）。 */
const SOURCES: Record<
  ExternalFileCategory,
  (anchor: string) => ReturnType<typeof sql>
> = {
  "openmuse-file-version": () => sql`
    select v.version_id as id, v.byte_path as key, f.owner_user_id,
      v.sha256, null::bigint as size_bytes, null::bytea as bytes,
      (select p.id from enterprise_principals p where p.user_id = f.owner_user_id) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = f.owner_user_id)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = f.owner_user_id) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = f.owner_user_id) limit 1) as only_workspace,
      1 as parent_association_ok
    from openmuse_file_versions v
    join openmuse_files f on f.id = v.file_id
    order by v.version_id`,
  "craft-snapshot": () => sql`
    select cs.id, cs.storage_path as key, s.user_id as owner_user_id,
      null::text as sha256, cs.size_bytes, null::bytea as bytes,
      (select p.id from enterprise_principals p where p.user_id = s.user_id) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.user_id)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.user_id) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.user_id) limit 1) as only_workspace,
      1 as parent_association_ok
    from craft_snapshots cs
    join craft_sessions s on s.id = cs.session_id
    order by cs.id`,
  "workshop-artifact": () => sql`
    select a.id, a.path as key, s.owner_user_id,
      null::text as sha256, a.size_bytes, null::bytea as bytes,
      (select p.id from enterprise_principals p where p.user_id = s.owner_user_id) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.owner_user_id)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.owner_user_id) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = s.owner_user_id) limit 1) as only_workspace,
      1 as parent_association_ok
    from workshop_artifacts a
    join workshop_sessions s on s.id = a.session_id
    order by a.id`,
  attachment: (anchor) => sql`
    select at.id::text as id, null as key, at.uploaded_by as owner_user_id,
      null::text as sha256, at.size_bytes, at.bytes,
      (select p.id from enterprise_principals p where p.user_id = at.uploaded_by) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = at.uploaded_by)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = at.uploaded_by) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = at.uploaded_by) limit 1) as only_workspace,
      (select count(*)::int from enterprise_resources r
        where r.tenant_id = ${anchor}
          and r.id = at.id::text and r.kind = 'attachment') as parent_association_ok,
      (select r.workspace_id from enterprise_resources r
        where r.tenant_id = ${anchor}
          and r.id = at.id::text and r.kind = 'attachment' limit 1) as association_workspace
    from attachments at
    order by at.id`,
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 构建对象存储归属映射（AC1–AC4 的映射臂）。
 *
 * 纯重算、零业务写入：同一数据两次调用结果一致（幂等）；中断后重算即
 * 续跑（无进度状态可半途而废）。store 端口缺省时摘要对照记
 * unavailable（供应商半边未验证的显式标记，票注允许确定性 fake 补齐）。
 */
export async function buildExternalFilesOwnershipMap(
  database: Database,
  input: {
    readonly defaultWorkspaceId: string;
    readonly store?: ObjectStorePort;
    readonly sampleLimit?: number;
  },
): Promise<ExternalFilesMigrationReport> {
  const anchors = (await database.execute(
    sql`select tenant_id from enterprise_deployment_anchors`,
  )) as unknown as { tenant_id: string }[];
  if (anchors.length !== 1) {
    throw new Error(
      `EXTERNAL_FILES_MIGRATION_REFUSED: expected exactly one MT112 anchor row, found ${anchors.length}`,
    );
  }
  const anchor = anchors[0].tenant_id;
  // 上限抬高到 5000：抽样默认 3 行（生产口径），验证者可开全窗逐行钉
  // （共享库的复跑残留会持续累积，小窗口会让「全窗断言」随轮次漂移）。
  const sampleLimit = Math.min(Math.max(input.sampleLimit ?? 3, 0), 5000);

  const categories: ExternalFileCategoryReport[] = [];
  const openItems: ExternalFilesMigrationReport["openItems"][number][] = [];

  for (const category of EXTERNAL_FILE_CATEGORIES) {
    // attachment 的父关联按锚点租户推导（SQL 里的占位符在此绑定真值）。
    const raw = SOURCES[category](anchor);
    const rows = (await database.execute(raw)) as unknown as SourceRow[];
    let mapped = 0;
    const samples: ExternalFileMappingEntry[] = [];
    const quarantinedEntries: {
      recordId: string;
      reason: ExternalFileReason;
    }[] = [];
    let digestMismatched = 0;

    for (const row of rows) {
      const verdict = classifyExternalFileRow(category, row, anchor);
      if (verdict !== "ok") {
        quarantinedEntries.push({ recordId: row.id, reason: verdict });
        openItems.push({ recordId: row.id, reason: verdict });
        continue;
      }
      mapped += 1;
      const digest = await verifyDigest(category, row, input.store);
      if (digest === "mismatch") {
        digestMismatched += 1;
        openItems.push({ recordId: row.id, reason: "digest-mismatch" });
      }
      if (samples.length < sampleLimit) {
        // attachment 的归属三元组来自第一批关联（非属主成员资格）。
        const tenant = category === "attachment" ? anchor : row.only_tenant;
        const workspace =
          category === "attachment"
            ? (row.association_workspace ?? null)
            : row.only_workspace;
        samples.push({
          category,
          recordId: row.id,
          storageKey: row.key,
          tenantId: tenant,
          workspaceId: workspace,
          ownerUserId: row.owner_user_id,
          digestOutcome: digest,
        });
      }
    }

    categories.push({
      category,
      scanned: rows.length,
      mapped,
      quarantined: quarantinedEntries.length,
      digestMismatched,
      samples,
      quarantinedEntries,
    });
  }

  return {
    anchorTenantId: anchor,
    strategy: {
      arm: "ownership-mapping",
      physicalRelocation:
        "deferred to MT055 (Issue #98, undelivered) — no delivered path segmentation scheme exists to migrate into",
    },
    categories,
    openItems,
    reproduce: EXTERNAL_FILES_MIGRATION_REPRODUCE,
  };
}

/** 归属判定（与第二批回填同一复合关联规则的类别半边）。 */
function classifyExternalFileRow(
  category: ExternalFileCategory,
  row: SourceRow,
  anchor: string,
): "ok" | ExternalFileReason {
  if (category === "attachment") {
    // 附件的归属 = 第一批落的父频道关联（attachment 资源行 + 上传者
    // grant）；关联缺失 = 无法归属（不猜频道默认）。
    if (Number(row.parent_association_ok) < 1) {
      return "parent-association-missing";
    }
    return "ok";
  }
  if (!row.owner_principal) return "owner-principal-missing";
  if (Number(row.membership_count ?? 0) !== 1) return "ambiguous-membership";
  if (row.only_tenant !== anchor) return "parent-tenant-mismatch";
  return "ok";
}

/** 摘要对照（AC3 下载一致性：同键取回的字节 vs 行内事实）。 */
async function verifyDigest(
  category: ExternalFileCategory,
  row: SourceRow,
  store: ObjectStorePort | undefined,
): Promise<DigestOutcome> {
  if (category === "attachment") {
    // DB 行内字节：无独立摘要列，按行内 size_bytes 对照（真实校验，非占位）。
    if (!row.bytes) return "unavailable";
    return row.size_bytes != null && row.bytes.length === Number(row.size_bytes)
      ? "size-match"
      : "mismatch";
  }
  if (category === "workshop-artifact") {
    // path 在沙箱工作区内（非对象存储键）——物理读取属沙箱面，映射不猜。
    return "unavailable";
  }
  if (!store || !row.key) return "unavailable";
  const bytes = await store.get(row.key);
  if (bytes === null) return "missing";
  if (row.sha256) {
    return sha256Hex(bytes) === row.sha256 ? "match" : "mismatch";
  }
  if (row.size_bytes != null) {
    return bytes.length === Number(row.size_bytes) ? "size-match" : "mismatch";
  }
  return "unavailable";
}
