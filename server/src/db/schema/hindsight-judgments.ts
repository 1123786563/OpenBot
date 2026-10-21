import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

// Hindsight 11（Issue #388）：同一授权来源内的派生判断候选。
//
// derived_judgment_candidates 一行 = 系统从多条已确认依据综合出、等待本人决定的判断
// 候选（CONTEXT.md「Derived Memory」：依据已确认不等于判断已确认）。候选在本票只到
// unreviewed 为止——确认/编辑/拒绝是 #389；因此行上预留 hindsight_document_id（hdj_
// 前缀，稳定文档身份）与同步摘要列，但候选路径从不 retain，unreviewed 判断对一切跨
// 会话召回结构性不可见（两条召回 seam 与降级路径只读 preferences/source_bound 表）。
//
// scope 是候选继承的全部依据的限制（ADR 0005）：general（通用个人记忆）或恰好一个
// 授权来源（形成团队/连接来源/Bot）。依据跨 scope 混合在提出门就被拒绝，行上 shape
// CHECK 与 source_bound_memories 同构。
//
// proposal_digest 折叠重复线索：同一 (scope, 判断文本, 依据集) 的未审候选至多一条，
// 部分唯一索引在存储层保证，重放线索幂等返回既有候选。
//
// derived_judgment_evidence 保存完整依据关系：候选到权威行的有序引用（evidence_id =
// OpenBot record id），不复制依据内容——展示时实时回读权威行，依据缺失/失权由读取
// 侧四道门决定候选是否仍然成立（#389 的审核界面与停用逻辑复用同一关系）。
export const derivedJudgmentCandidates = pgTable(
  "derived_judgment_candidates",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    principalId: text("principal_id").notNull(),
    /** The single scope all evidence shares: general personal memory, or one source. */
    scopeKind: text("scope_kind")
      .$type<"general" | "team" | "source" | "bot">()
      .notNull(),
    workspaceId: text("workspace_id"),
    sourceId: text("source_id"),
    agentId: text("agent_id"),
    /** The proposed judgment text — a claim over its evidence, never the evidence itself. */
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    reviewState: text("review_state")
      .$type<"unreviewed" | "confirmed" | "edited" | "rejected">()
      .notNull()
      .default("unreviewed"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** sha256 over (scope, judgment text, sorted evidence document ids); dedupes leads. */
    proposalDigest: text("proposal_digest").notNull(),
    /**
     * The stable document identity a CONFIRMED judgment will index under (#389's retain);
     * assigned at creation so the identity never depends on the review outcome, but never
     * used while the candidate is unreviewed.
     */
    hindsightDocumentId: text("hindsight_document_id").notNull(),
    /** sha256 of the content last successfully retained; null until a confirm syncs (#389). */
    syncedContentDigest: text("synced_content_digest"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** When the system proposed this judgment to the person. */
    proposedAt: timestamp("proposed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "derived_judgment_scope_kind",
      sql`${table.scopeKind} in ('general', 'team', 'source', 'bot')`,
    ),
    check(
      "derived_judgment_review_state",
      sql`${table.reviewState} in ('unreviewed', 'confirmed', 'edited', 'rejected')`,
    ),
    check(
      "derived_judgment_scope_shape",
      sql`((${table.scopeKind} = 'team') = (${table.workspaceId} is not null)) and ((${table.scopeKind} = 'source') = (${table.sourceId} is not null)) and ((${table.scopeKind} = 'bot') = (${table.agentId} is not null))`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    uniqueIndex("derived_judgment_candidates_document_idx").on(
      table.tenantId,
      table.hindsightDocumentId,
    ),
    // One open candidate per identical lead: a replayed observation returns the existing
    // candidate instead of stacking a second copy for the person to dismiss.
    uniqueIndex("derived_judgment_candidates_lead_idx")
      .on(table.tenantId, table.principalId, table.proposalDigest)
      .where(sql`${table.reviewState} = 'unreviewed'`),
    index("derived_judgment_candidates_review_idx").on(
      table.tenantId,
      table.principalId,
      table.reviewState,
    ),
  ],
);

/** One candidate's complete evidence relation: ordered references to authority rows. */
export const derivedJudgmentEvidence = pgTable(
  "derived_judgment_evidence",
  {
    tenantId: text("tenant_id").notNull(),
    judgmentId: text("judgment_id").notNull(),
    /** 1-based, the lead's evidence order; the review surface shows this order. */
    position: integer("position").notNull(),
    /** Which authority table the referenced row lives in. */
    evidenceType: text("evidence_type")
      .$type<"preference" | "source_bound" | "derived_judgment">()
      .notNull(),
    /** The authority row's OpenBot record id — the only id the relation carries. */
    evidenceId: text("evidence_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.judgmentId, table.position],
    }),
    check(
      "derived_judgment_evidence_type",
      sql`${table.evidenceType} in ('preference', 'source_bound', 'derived_judgment')`,
    ),
    check("derived_judgment_evidence_position", sql`${table.position} >= 1`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.judgmentId],
      foreignColumns: [
        derivedJudgmentCandidates.tenantId,
        derivedJudgmentCandidates.id,
      ],
    }),
  ],
);
