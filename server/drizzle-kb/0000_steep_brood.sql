CREATE TABLE "chunk_revisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"knowledge_base_id" varchar(36) NOT NULL,
	"knowledge_id" varchar(36) NOT NULL,
	"chunk_id" varchar(36) NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"editor_id" varchar(64) DEFAULT '' NOT NULL,
	"edit_source" varchar(16) DEFAULT '' NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_chunk_revisions_chunk_revision" UNIQUE("chunk_id","revision")
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"knowledge_id" varchar(36) NOT NULL,
	"knowledge_base_id" varchar(36) NOT NULL,
	"tag_id" varchar(36),
	"content" text NOT NULL,
	"source_content" text DEFAULT '' NOT NULL,
	"content_revision" integer DEFAULT 0 NOT NULL,
	"index_status" varchar(16) DEFAULT 'ready' NOT NULL,
	"last_editor_id" varchar(64) DEFAULT '' NOT NULL,
	"chunk_index" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"flags" integer DEFAULT 1 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"start_at" integer DEFAULT 0 NOT NULL,
	"end_at" integer DEFAULT 0 NOT NULL,
	"pre_chunk_id" varchar(36) DEFAULT '' NOT NULL,
	"next_chunk_id" varchar(36) DEFAULT '' NOT NULL,
	"chunk_type" varchar(20) DEFAULT 'text' NOT NULL,
	"parent_chunk_id" varchar(36),
	"relation_chunks" jsonb,
	"indirect_relation_chunks" jsonb,
	"metadata" jsonb,
	"content_hash" varchar(64) DEFAULT '' NOT NULL,
	"image_info" text,
	"context_header" text DEFAULT '' NOT NULL,
	"source_locators" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"chunking_config" jsonb NOT NULL,
	"indexing_strategy" jsonb DEFAULT '{"channels":["vector"]}'::jsonb NOT NULL,
	"embedding_model_id" varchar(128) NOT NULL,
	"vector_store_id" varchar(128),
	"rerank_model" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledges" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"knowledge_base_id" varchar(36) NOT NULL,
	"type" varchar(32) NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" varchar(2048) DEFAULT '' NOT NULL,
	"channel" varchar(50) DEFAULT 'web' NOT NULL,
	"parse_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"pending_subtasks_count" integer DEFAULT 0 NOT NULL,
	"enable_status" varchar(32) DEFAULT 'enabled' NOT NULL,
	"embedding_model_id" varchar(128) NOT NULL,
	"file_name" varchar(512) DEFAULT '' NOT NULL,
	"file_type" varchar(64) DEFAULT '' NOT NULL,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"file_hash" varchar(64),
	"file_path" varchar(1024) DEFAULT '' NOT NULL,
	"storage_size" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"custom_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_knowledge_id_knowledges_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledges" ADD CONSTRAINT "knowledges_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chunk_revisions_knowledge" ON "chunk_revisions" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "idx_chunks_tenant_kb" ON "chunks" USING btree ("tenant_id","knowledge_base_id");--> statement-breakpoint
CREATE INDEX "idx_chunks_knowledge" ON "chunks" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "idx_chunks_parent" ON "chunks" USING btree ("parent_chunk_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_bases_tenant" ON "knowledge_bases" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_knowledge_bases_name_tenant_active" ON "knowledge_bases" USING btree ("tenant_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_knowledges_tenant_kb" ON "knowledges" USING btree ("tenant_id","knowledge_base_id");--> statement-breakpoint
CREATE INDEX "idx_knowledges_status" ON "knowledges" USING btree ("parse_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_knowledges_file_hash_active" ON "knowledges" USING btree ("tenant_id","knowledge_base_id","file_hash") WHERE deleted_at IS NULL AND file_hash IS NOT NULL;