CREATE TABLE "openmuse_deletion_resources" (
	"manifest_id" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"external_key" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openmuse_deletion_resources_manifest_id_kind_id_external_key_pk" PRIMARY KEY("manifest_id","kind","id","external_key")
);
