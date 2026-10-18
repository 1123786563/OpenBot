CREATE TABLE "knowledge_base_ownership_states" (
	"knowledge_base_id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"sync_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_ownership_state_shape" CHECK ("knowledge_base_ownership_states"."tenant_id" <> '' and "knowledge_base_ownership_states"."workspace_id" <> '' and "knowledge_base_ownership_states"."sync_version" <> '')
);
--> statement-breakpoint
ALTER TABLE "knowledge_base_ownership_states" ADD CONSTRAINT "knowledge_base_ownership_states_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kb_ownership_states_tenant_ws" ON "knowledge_base_ownership_states" USING btree ("tenant_id","workspace_id");