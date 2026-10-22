import { sql } from "drizzle-orm";
import {
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
import { enterpriseTenants } from "./enterprise-tenancy";

// Hindsight 07（Issue #384）：已确认个人记忆的幂等同步与重试的工作队列。
//
// 一行 = 一条“该权威行的已确认内容应当进入 Hindsight”的工作单元：确认/编辑/更正
// 时以当时内容摘要入队（expected_digest），由后台任务排空。三条安全性质落在表形
// 上：
//   - 重复任务在存储层折叠：部分唯一索引保证每个 (tenant, subject) 至多一条
//     pending；
//   - 旧任务不能覆盖新内容：排空时以行当前内容摘要对比 expected_digest，编辑发生
//     在中间则旧工作判 superseded，只有新内容会被 retain；
//   - 只有已确认且当前有权的内容被发送：排空时重读权威行（source_bound 行另重读
//     授权），任务重试时重新核实租户与来源归属。
//
// 状态口径：pending = 等待发送或等待重试；done = 无需再发（已同步/内容不再符
// 合发送条件）；superseded = 被更新内容的工作取代。synced_content_digest 仍在权威
// 行上——“已索引”只能由行摘要与当前内容一致证明，本表不复制该结论。
export const hindsightSyncWork = pgTable(
  "hindsight_sync_work",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** Which authority table the subject row lives in. */
    subjectType: text("subject_type")
      .$type<"preference" | "source_bound" | "derived_judgment">()
      .notNull(),
    subjectId: text("subject_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** sha256 of the content as enqueued — the version this piece of work stands for. */
    expectedDigest: text("expected_digest").notNull(),
    state: text("state")
      .$type<"pending" | "done" | "superseded">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
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
      "hindsight_sync_work_subject_type",
      sql`${table.subjectType} in ('preference', 'source_bound')`,
    ),
    check(
      "hindsight_sync_work_state",
      sql`${table.state} in ('pending', 'done', 'superseded')`,
    ),
    check("hindsight_sync_work_attempts", sql`${table.attempts} >= 0`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    // One pending row per subject: re-enqueuing pending work is a no-op, not a second task.
    uniqueIndex("hindsight_sync_work_one_pending")
      .on(table.tenantId, table.subjectType, table.subjectId)
      .where(sql`${table.state} = 'pending'`),
    index("hindsight_sync_work_due_idx").on(table.state, table.createdAt),
  ],
);
