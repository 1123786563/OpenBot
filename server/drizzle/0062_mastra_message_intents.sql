CREATE TABLE "mastra_message_intent_attachments" (
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	CONSTRAINT "mastra_msg_intent_attachments_pk" PRIMARY KEY("tenant_id","thread_id","client_message_key","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mastra_message_intents" (
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"message_id" text NOT NULL,
	"digest" text NOT NULL,
	"reserved_seq" integer NOT NULL,
	"actor_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"backend_version" integer NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastra_message_intents_pk" PRIMARY KEY("tenant_id","thread_id","client_message_key"),
	CONSTRAINT "mastra_message_intents_seq_check" CHECK ("mastra_message_intents"."reserved_seq" > 0),
	CONSTRAINT "mastra_message_intents_backend_version_check" CHECK ("mastra_message_intents"."backend_version" > 0),
	CONSTRAINT "mastra_message_intents_state_check" CHECK ("mastra_message_intents"."state" in ('pending', 'finalized'))
);
--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" DROP CONSTRAINT "enterprise_conversations_backend_check";--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD COLUMN "backend_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ADD CONSTRAINT "mastra_msg_intent_attachments_intent_fk" FOREIGN KEY ("tenant_id","thread_id","client_message_key") REFERENCES "public"."mastra_message_intents"("tenant_id","thread_id","client_message_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ADD CONSTRAINT "mastra_msg_intent_attachments_file_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_conversation_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_message_intents_message_id" ON "mastra_message_intents" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_message_intents_thread_seq" ON "mastra_message_intents" USING btree ("tenant_id","thread_id","reserved_seq");--> statement-breakpoint
CREATE INDEX "mastra_message_intents_pending_idx" ON "mastra_message_intents" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_backend_version_check" CHECK ("enterprise_conversations"."backend_version" > 0);--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_backend_check" CHECK ("enterprise_conversations"."storage_backend" in ('platform', 'intelligence', 'mastra'));--> statement-breakpoint
CREATE POLICY "mastra_message_intent_attachments_data_scope" ON "mastra_message_intent_attachments" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (mastra_message_intent_attachments.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (mastra_message_intent_attachments.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "mastra_message_intents_data_scope" ON "mastra_message_intents" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (mastra_message_intents.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (mastra_message_intents.tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "mastra_message_intents" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("state", "updated_at") ON TABLE "mastra_message_intents" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "mastra_message_intent_attachments" TO ob_ent_data;
