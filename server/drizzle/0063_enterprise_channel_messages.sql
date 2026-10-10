-- C07 企业消息提交：Channel 级用户消息/提交记录表。
--
-- Layout: (1) the submission table keyed by the plan §5 idempotency tuple
-- (tenant, channel, client_message_id) with a one-run-per-message unique index;
-- (2) RLS owner policy mirroring 0060 §5a run_owner_write; (3) the run-writer
-- directory reads the message transaction needs — `withTenant`'s in-transaction
-- membership recheck joins enterprise_principals/enterprise_tenants and the
-- submission authorization reads the channel row and its grant facts in the
-- SAME transaction (conversations store discipline), none of which 0059/0060
-- granted to ob_ent_run_writer. 0059/0060 stay untouched: this is a differential
-- grant, never a rewrite of the runs migration.
--
-- 消息行引用其业务 Run 与 Channel（同租户复合外键），content_digest 是提交内容的
-- 规范化 sha256（同键不同内容 → 409 的比较键，C07 messages.ts 定义）。

CREATE TABLE "enterprise_channel_messages" (
	"tenant_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"run_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_channel_messages_pk" PRIMARY KEY("tenant_id","channel_id","id"),
	CONSTRAINT "enterprise_channel_messages_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."enterprise_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "enterprise_channel_messages_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "enterprise_channel_messages_dedup" UNIQUE("tenant_id","channel_id","client_message_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_channel_message_run" ON "enterprise_channel_messages" USING btree ("tenant_id","run_id");
--> statement-breakpoint
ALTER TABLE "enterprise_channel_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enterprise_channel_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_message_owner_write ON "enterprise_channel_messages" FOR ALL TO ob_ent_run_writer
USING (
	"enterprise_channel_messages"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
	AND "enterprise_channel_messages"."owner_principal_id" = nullif(current_setting('app.principal_id', true), '')
)
WITH CHECK (
	"enterprise_channel_messages"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
	AND "enterprise_channel_messages"."owner_principal_id" = nullif(current_setting('app.principal_id', true), '')
);
--> statement-breakpoint
GRANT SELECT, INSERT ON "enterprise_channel_messages" TO ob_ent_run_writer;
GRANT SELECT ON "enterprise_channels", "enterprise_resource_grants", "enterprise_principals", "enterprise_tenants" TO ob_ent_run_writer;
--> statement-breakpoint
-- The message transaction reads its authorization facts INSIDE one transaction
-- on the run-writer role: the withTenant membership recheck joins
-- enterprise_principals/enterprise_tenants and the submission decision reads
-- the channel row and its grant rows. 0056/0058's policies are scoped to the
-- older roles, so the run-writer gets its own narrower SELECT policies here —
-- pinned to the transaction's GUCs, never broader than the data role's.
CREATE POLICY run_writer_self ON enterprise_principals FOR SELECT TO ob_ent_run_writer
USING (
	enterprise_principals.id = nullif(current_setting('app.principal_id', true), '')
	AND enterprise_principals.user_id = nullif(current_setting('app.user_id', true), '')
);
CREATE POLICY run_writer_tenant ON enterprise_tenants FOR SELECT TO ob_ent_run_writer
USING (enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY run_writer_grants ON enterprise_resource_grants FOR SELECT TO ob_ent_run_writer
USING (
	enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')
	AND enterprise_resource_grants.principal_id = nullif(current_setting('app.principal_id', true), '')
);
CREATE POLICY run_writer_channels ON enterprise_channels FOR SELECT TO ob_ent_run_writer
USING (
	enterprise_channels.tenant_id = nullif(current_setting('app.tenant_id', true), '')
	AND enterprise_channels.owner_principal_id = nullif(current_setting('app.principal_id', true), '')
);
