ALTER TABLE "personal_workspace_closures" DROP CONSTRAINT "personal_workspace_closures_account_id_unique";--> statement-breakpoint
ALTER TABLE "personal_workspace_suspensions" DROP CONSTRAINT "personal_workspace_suspensions_workspace_id_personal_workspaces_id_fk";
--> statement-breakpoint
DROP INDEX "personal_workspace_suspensions_workspace_id_sequence_index";--> statement-breakpoint
ALTER TABLE "personal_workspace_closures" ADD COLUMN "retired_intelligence" jsonb;--> statement-breakpoint
ALTER TABLE "personal_workspace_suspensions" ADD COLUMN "account_id" uuid;--> statement-breakpoint
UPDATE "personal_workspace_suspensions" AS suspension
SET "account_id" = workspace."owner_id"
FROM "personal_workspaces" AS workspace
WHERE suspension."workspace_id" = workspace."id";--> statement-breakpoint
ALTER TABLE "personal_workspace_suspensions" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_workspace_suspensions" ADD CONSTRAINT "personal_workspace_suspensions_account_id_personal_saas_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_workspace_closures_account_id_index" ON "personal_workspace_closures" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "personal_workspace_suspensions_account_id_sequence_index" ON "personal_workspace_suspensions" USING btree ("account_id","sequence");