CREATE TABLE "openmuse_file_owner_disables" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_file_versions" (
	"version_id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"byte_path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_files" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "openmuse_file_owner_disables" ADD CONSTRAINT "openmuse_file_owner_disables_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_file_versions" ADD CONSTRAINT "openmuse_file_versions_file_id_openmuse_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."openmuse_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_files" ADD CONSTRAINT "openmuse_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openmuse_file_versions_file_idx" ON "openmuse_file_versions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "openmuse_files_owner_list_idx" ON "openmuse_files" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_files_owner_idem_uq" ON "openmuse_files" USING btree ("owner_user_id","idempotency_key") WHERE "openmuse_files"."deleted_at" is null;