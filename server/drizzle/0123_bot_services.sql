CREATE TABLE "bot_services" (
	"bot_id" text PRIMARY KEY,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_services_kind_check" CHECK ("bot_services"."kind" IN ('builtin', 'external')),
	CONSTRAINT "bot_services_status_check" CHECK ("bot_services"."status" IN ('active', 'disabled')),
	CONSTRAINT "bot_services_capabilities_check" CHECK ("bot_services"."capabilities" <@ ARRAY['chat','image','audio','embedding','realtime','async']::text[])
);
