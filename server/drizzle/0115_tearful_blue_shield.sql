CREATE TABLE "openmuse_account_deletions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" text DEFAULT 'fenced' NOT NULL,
	"restore_until" timestamp with time zone,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL
);
