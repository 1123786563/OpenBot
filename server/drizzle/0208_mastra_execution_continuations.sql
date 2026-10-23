-- ME05 (#477): 危险操作与用户问答的持久挂起 continuation 台账。
--
-- 一行 = 一个等待恢复的操作的完整恢复证据：scope 与 run 绑定（tenant/workspace/
-- principal/actor + bot/run/attempt/generation/executionKey）、引擎提出的精确
-- tool call 与参数摘要、写入快照时的引擎版本指纹、指向受限存储的不透明
-- snapshot 引用、CAS revision、带过期的认领状态与终态。绝不保存 provider key、
-- capability 明文、函数或实时 AbortSignal；快照本体只在受限租户引擎存储中，
-- 仅能经 snapshot_ref 定位。
--
-- (run_id, tool_call_id) 唯一（partial：排除 finished 行）：一次重复保存收敛
-- 到同一行，不会铸造第二个恢复身份（保存与发布 waiting 之间的崩溃可安全重放
-- 保存）。finished 行是历史不是挂起，绝不永久阻断同一 (run, call) 的新挂起
-- ——store 的 loadPendingRow 用同一谓词。
CREATE TABLE "mastra_execution_continuations" (
	"continuation_id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"generation" integer NOT NULL,
	"execution_key" text NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"operation_id" text NOT NULL,
	"args_digest" text NOT NULL,
	"package_fingerprint" text NOT NULL,
	"snapshot_ref" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"claim_token_hash" text,
	"claim_expires_at" timestamp with time zone,
	"decision_id" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastra_continuations_kind_check" CHECK ("mastra_execution_continuations"."kind" IN ('approval', 'question', 'frontend_tool')),
	CONSTRAINT "mastra_continuations_status_check" CHECK ("mastra_execution_continuations"."status" IN ('waiting', 'claimed', 'finished')),
	CONSTRAINT "mastra_continuations_outcome_check" CHECK ("mastra_execution_continuations"."outcome" IN ('resumed', 'declined', 'failed_unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_continuations_run_call_idx" ON "mastra_execution_continuations" USING btree ("run_id","tool_call_id") WHERE "mastra_execution_continuations"."status" <> 'finished';--> statement-breakpoint
-- 预留索引：当前读路径（PK、(run_id, tool_call_id)、CAS）不经过它们。ME06 将
-- 消费——workspace 级挂起列表走 scope+status，operation_id 走证据关联查询；
-- 保留以免消费方落地时再动迁移。
CREATE INDEX "mastra_continuations_scope_status_idx" ON "mastra_execution_continuations" USING btree ("tenant_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "mastra_continuations_operation_idx" ON "mastra_execution_continuations" USING btree ("operation_id");--> statement-breakpoint
-- ME05 (#477): 外部效果 receipt 证据台账。恢复规则只认这里的状态：operation
-- 一经启动即记 unknown（效果可能已发生，绝不自动重放）；结果确认后升级为
-- executed（合法恢复复用，不再执行）。
CREATE TABLE "mastra_execution_receipts" (
	"receipt_id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_digest" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "mastra_receipts_status_check" CHECK ("mastra_execution_receipts"."status" IN ('unknown', 'executed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_receipts_operation_idx" ON "mastra_execution_receipts" USING btree ("run_id","tool_call_id","operation_id");--> statement-breakpoint
-- receipt 读取路径（findReceiptRow / recordOperationExecuted）以
-- (tenant_id, operation_id) 为谓词；上面 run_id 打头的唯一索引服务不了它。
CREATE INDEX "mastra_receipts_tenant_operation_idx" ON "mastra_execution_receipts" USING btree ("tenant_id","operation_id");
