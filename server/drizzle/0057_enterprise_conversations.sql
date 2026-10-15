CREATE TABLE "enterprise_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text,
	"storage_backend" text DEFAULT 'platform' NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_conversations_backend_check" CHECK ("enterprise_conversations"."storage_backend" in ('platform', 'intelligence')),
	CONSTRAINT "enterprise_conversations_seq_check" CHECK ("enterprise_conversations"."last_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_message_parts" (
	"tenant_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"attachment_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "enterprise_message_parts_tenant_id_message_id_ordinal_pk" PRIMARY KEY("tenant_id","message_id","ordinal"),
	CONSTRAINT "enterprise_message_parts_ordinal_check" CHECK ("enterprise_message_parts"."ordinal" >= 0),
	CONSTRAINT "enterprise_message_parts_kind_check" CHECK ("enterprise_message_parts"."kind" in ('text', 'attachment'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_message_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_messages" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"client_message_key" text NOT NULL,
	"digest" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_messages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_messages_seq_check" CHECK ("enterprise_messages"."seq" > 0),
	CONSTRAINT "enterprise_messages_role_check" CHECK ("enterprise_messages"."role" in ('user', 'assistant', 'tool'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_conversations_tenant_thread" ON "enterprise_conversations" USING btree ("tenant_id","thread_id");--> statement-breakpoint
CREATE INDEX "enterprise_conversations_owner_idx" ON "enterprise_conversations" USING btree ("tenant_id","workspace_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_messages_thread_seq" ON "enterprise_messages" USING btree ("tenant_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_messages_client_key" ON "enterprise_messages" USING btree ("tenant_id","thread_id","client_message_key");--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_message_parts" ADD CONSTRAINT "enterprise_message_parts_tenant_id_message_id_enterprise_messages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."enterprise_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_messages" ADD CONSTRAINT "enterprise_messages_tenant_id_thread_id_enterprise_conversations_tenant_id_thread_id_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "enterprise_conversations_data_scope" ON "enterprise_conversations" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_conversations.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_conversations.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_message_parts_data_scope" ON "enterprise_message_parts" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_message_parts.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_message_parts.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_messages_data_scope" ON "enterprise_messages" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_messages.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_messages.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_conversations", "enterprise_messages", "enterprise_message_parts" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_conversations" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("title", "last_seq", "updated_at") ON TABLE "enterprise_conversations" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_messages", "enterprise_message_parts" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ("id", "name", "deleted_at") ON TABLE "channels" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ("channel_id", "user_id") ON TABLE "channel_memberships" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ("thread_id", "user_id", "channel_id", "created_at", "updated_at") ON TABLE "intelligence_channel_mappings" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ("id", "channel_id", "uploaded_by", "attached_at"), UPDATE ("attached_at") ON TABLE "attachments" TO ob_ent_data;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_message_parts" FORCE ROW LEVEL SECURITY;
