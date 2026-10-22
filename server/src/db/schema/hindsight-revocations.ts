import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
} from "./enterprise-tenancy";

// Hindsight 13（Issue #390）：遗忘与来源撤销的持久阻断台账。
//
// 一行 = 一个已被持久阻断、等待/已完成远端删除的 Hindsight 文档。写入顺序是本表存在的
// 理由：阻断（权威行墓碑 + 本台账行）先在同一持久化步骤落地，远端删除在其后发起并可
// 失败重试——Hindsight 故障不延迟"停止使用"。kind=memory 的行来自个人遗忘（target 是
// 权威行 id）；kind=source/bot 的行来自来源撤销（target 是来源/Bot id），撤销会把该授权
// 下全部来源受限行及依赖判断的文档各记一行。
//
// deletion_state 只区分“远端删除未完成”（pending/failed）与“服务已确认删除”（confirmed，
// 2xx 或 404）。#391 起 confirmed 之外还有缺席验证（verify_state）：一次 API 成功不是删除
// 证明，验证要求服务现在回答该文档 404 且其记忆单元列表为空——“受控副本清除完成”的
// 三条证据腿（活跃数据、已结束任务载荷、受控备份）在 cleanup-evidence.ts 组合，本表只
// 存每文档的验证事实。
//
// 恢复备份后的重放以本表为事实源：replayRevocations 按行幂等重放阻断（含授权禁用），
// 重放完成前不重新开放召回。
export const hindsightRevocations = pgTable(
  "hindsight_revocations",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    principalId: text("principal_id").notNull(),
    /** What was revoked: one memory row, or an authorization target (source/bot). */
    kind: text("kind").$type<"memory" | "source" | "bot">().notNull(),
    /** For kind=memory: which authority table the blocked row lives in. */
    subjectType: text("subject_type")
      .$type<"preference" | "source_bound" | "derived_judgment">(),
    /** The authority row id (kind=memory) or the revoked target id (source/bot). */
    targetId: text("target_id").notNull(),
    /** The Hindsight document this row blocks and deletes; one ledger row per document. */
    documentId: text("document_id").notNull(),
    /** The bank that document lives in — where the delete call must go. */
    bankId: text("bank_id").notNull(),
    /** The bank's kind, so the retry drain mints the same grant shape that wrote it. */
    bankKind: text("bank_kind")
      .$type<"user" | "team" | "source" | "bot">()
      .notNull(),
    blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull(),
    deletionState: text("deletion_state")
      .$type<"pending" | "confirmed" | "failed">()
      .notNull()
      .default("pending"),
    deletionAttemptedAt: timestamp("deletion_attempted_at", {
      withTimezone: true,
    }),
    deletionError: text("deletion_error"),
    /**
     * 缺席验证（#391）：不是删除 API 的回执，而是验证 sweep 的独立探测结果。
     * absent = 服务现在答 404 且该文档的记忆单元为空；present = 验证时文档又出现了
     * （如备份恢复复活）；unreachable = 验证无法完成；unverified = 尚未验证。
     */
    verifyState: text("verify_state")
      .$type<"unverified" | "absent" | "present" | "unreachable">()
      .notNull()
      .default("unverified"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyError: text("verify_error"),
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
      "hindsight_revocations_kind",
      sql`${table.kind} in ('memory', 'source', 'bot')`,
    ),
    check(
      "hindsight_revocations_deletion_state",
      sql`${table.deletionState} in ('pending', 'confirmed', 'failed')`,
    ),
    check(
      "hindsight_revocations_verify_state",
      sql`${table.verifyState} in ('unverified', 'absent', 'present', 'unreachable')`,
    ),
    // A memory revocation names its subject table; an authorization revocation does not.
    check(
      "hindsight_revocations_subject_shape",
      sql`((${table.kind} = 'memory') = (${table.subjectType} is not null))`,
    ),
    check(
      "hindsight_revocations_bank_kind",
      sql`${table.bankKind} in ('user', 'team', 'source', 'bot')`,
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
    // One ledger row per blocked document: re-forgetting or replay updates, never stacks.
    uniqueIndex("hindsight_revocations_document_idx").on(
      table.tenantId,
      table.documentId,
    ),
    // The retry drain walks unfinished deletions oldest-first.
    index("hindsight_revocations_deletion_idx").on(
      table.tenantId,
      table.deletionState,
      table.blockedAt,
    ),
  ],
);
