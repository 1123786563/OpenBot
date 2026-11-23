ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_scope" text;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_create_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_sandbox_id" text;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_connection" text;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_work_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_worker_exit" jsonb;--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_destroyed_at" bigint;