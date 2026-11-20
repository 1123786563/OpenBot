ALTER TABLE "personal_workspace_closures" ADD COLUMN "cleanup" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_workspace_closures" ADD COLUMN "backup_schedule" jsonb;