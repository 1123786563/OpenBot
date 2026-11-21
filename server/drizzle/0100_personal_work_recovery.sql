ALTER TABLE "work_items" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "interruption" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "recovery" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "output" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_account_id_personal_saas_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_personal_account_idx" ON "work_items" USING btree ("account_id") WHERE "work_items"."account_id" IS NOT NULL;