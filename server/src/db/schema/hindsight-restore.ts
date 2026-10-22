import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

// Hindsight 14（Issue #391）：远端删除证据、备份恢复门禁与受控备份登记。
//
// 两张表都不带 tenant 归属，这是本表与 hindsight 其余表的唯一差别，理由写在数据本身：
// 受控备份（deploy/hindsight/backup.sh）是整库 pg_dump，恢复也是整库事件——一份副本天然
// 含所有公司所有 bank，给它一个 tenant 外键等于声明“这份副本只含一家公司”，是假精度。
// 证据计算（cleanup-evidence.ts）按租户过滤台账后在全局副本登记上求交集，才是真实的
// 含义：任何先于该租户删除确认时刻、且尚无清除证据的副本都使“受控副本清除完成”不成立。
//
// hindsight_backup_restores：一行 = 一次已发生的备份恢复。restore_key 唯一是去重身份——
// 同一次恢复重复登记（重试、双写）不产生第二个 open 标记，也不会在重放完成后再把召回
// 关上；不同的恢复（不同 key）各自开门。state 只有两态：open（重放未落地，召回关闭）与
// replayed（本地重放完成，召回重新开放）。标记先于恢复写入口落库是安全方向：写晚了，
// 恢复与重放之间的窗口里召回了旧数据；写早了只是多关一会儿。
//
// hindsight_controlled_backups：一行 = 一份受控备份副本。taken_at 是副本内容的时间下界
// （晚于它确认的删除不会出现在更早的副本里，反之早于删除确认的副本可能含被遗忘内容）；
// purged_at 为空即“副本仍存在”——只有实际清除证据（备份清扫/运维登记的删除事实）才能
// 填。登记表为空不是“没有备份”的证据：备份脚本在 OpenBot 之外运行，登记为空只能说明
// 没有证据，证据腿按无证据处理，不按已清除处理。

/** 一次备份恢复重放的证据：本地重放与远程重发各自的结果，原样留存。 */
export type HindsightReplayEvidence = {
  localBlocks: {
    memoryRows: number;
    reappliedMemoryBlocks: number;
    authorizationTargets: number;
    reappliedAuthorizationBlocks: number;
  };
  remoteDeletions: {
    considered: number;
    confirmed: number;
    stillOutstanding: number;
  };
  finishedAt: string;
};

export const hindsightBackupRestores = pgTable(
  "hindsight_backup_restores",
  {
    id: text("id").primaryKey(),
    /** 去重身份：恢复事件自身的不变标识（如备份文件名+恢复时间戳）。 */
    restoreKey: text("restore_key").notNull(),
    restoredAt: timestamp("restored_at", { withTimezone: true }).notNull(),
    /** open：重放未落地，召回保持关闭；replayed：本地重放完成，召回开放。 */
    state: text("state").$type<"open" | "replayed">().notNull().default("open"),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    replayEvidence: jsonb("replay_evidence").$type<HindsightReplayEvidence>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "hindsight_backup_restores_state",
      sql`${table.state} in ('open', 'replayed')`,
    ),
    // 同一次恢复只开一个门：重放完成后的重复登记不重新关门。
    uniqueIndex("hindsight_backup_restores_key_idx").on(table.restoreKey),
    // 召回门禁与重放都按 open 状态最旧优先扫描。
    index("hindsight_backup_restores_state_idx").on(
      table.state,
      table.restoredAt,
    ),
  ],
);

export const hindsightControlledBackups = pgTable(
  "hindsight_controlled_backups",
  {
    id: text("id").primaryKey(),
    /** 副本自身的不变标识（备份文件名等）；清扫与对账按它进行。 */
    backupId: text("backup_id").notNull(),
    /** 副本内容的时间下界：先于某文档删除确认的副本可能含该文档。 */
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    /** 实际清除证据；为空即副本仍存在。 */
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    /** 清除是怎么被证实的（哪次清扫/谁登记），只记事实不记凭据。 */
    purgeEvidence: text("purge_evidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 一份副本只登记一行：重复登记不堆叠，清除证据落在同一行上。
    uniqueIndex("hindsight_controlled_backups_id_idx").on(table.backupId),
    // 证据腿按 taken_at 与删除确认时刻比大小。
    index("hindsight_controlled_backups_taken_idx").on(table.takenAt),
  ],
);
