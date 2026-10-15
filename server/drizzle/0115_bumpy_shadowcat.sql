CREATE TABLE "bot_services" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
