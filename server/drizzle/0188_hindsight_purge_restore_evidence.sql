-- Hindsight 14 (#391)：远端删除证据、备份恢复门禁与受控备份登记。
--
-- 三块增量，各自服务于票的一条验收：
--
--   - hindsight_revocations 增加缺席验证三列（verify_state/verified_at/verify_error）。
--     删除证明不能只依赖一次 API 成功：deletion_state=confirmed 只是删除调用的服务端应答，
--     verify_state 记录的是独立的验证 sweep（文档 404 且记忆单元为空 = absent）。默认
--     unverified，存量行不自动获得验证结论。
--   - hindsight_backup_restores：备份恢复标记 = 召回门禁。restore_key 唯一实现去重——
--     同一次恢复重复登记不产生第二个 open 标记；state open 期间所有召回入口关闭，
--     本地重放（#390 replayRevocations）落地后才置 replayed 并记录重放证据（jsonb）。
--     表不带 tenant：受控备份是整库 pg_dump，恢复是整库事件，租户外键会是假精度。
--   - hindsight_controlled_backups：受控备份登记。taken_at 是副本内容的时间下界；
--     purged_at 为空即副本仍存在。“受控副本清除完成”的备份腿要求：先于删除确认时刻
--     的每份登记副本都有 purge 证据；登记为空不是“没有备份”的证据，按无证据处理。
ALTER TABLE "hindsight_revocations" ADD COLUMN "verify_state" text NOT NULL DEFAULT 'unverified';
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD COLUMN "verify_error" text;
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_verify_state" CHECK ("hindsight_revocations"."verify_state" in ('unverified', 'absent', 'present', 'unreachable'));
--> statement-breakpoint
CREATE TABLE "hindsight_backup_restores" (
	"id" text PRIMARY KEY,
	"restore_key" text NOT NULL,
	"restored_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL DEFAULT 'open',
	"replayed_at" timestamp with time zone,
	"replay_evidence" jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "hindsight_backup_restores" ADD CONSTRAINT "hindsight_backup_restores_state" CHECK ("hindsight_backup_restores"."state" in ('open', 'replayed'));
--> statement-breakpoint
CREATE UNIQUE INDEX "hindsight_backup_restores_key_idx" ON "hindsight_backup_restores" USING btree ("restore_key");
--> statement-breakpoint
CREATE INDEX "hindsight_backup_restores_state_idx" ON "hindsight_backup_restores" USING btree ("state","restored_at");
--> statement-breakpoint
CREATE TABLE "hindsight_controlled_backups" (
	"id" text PRIMARY KEY,
	"backup_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	"purge_evidence" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hindsight_controlled_backups_id_idx" ON "hindsight_controlled_backups" USING btree ("backup_id");
--> statement-breakpoint
CREATE INDEX "hindsight_controlled_backups_taken_idx" ON "hindsight_controlled_backups" USING btree ("taken_at");
