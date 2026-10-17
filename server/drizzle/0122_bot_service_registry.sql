CREATE TYPE "bot_service_kind" AS ENUM('builtin', 'external');--> statement-breakpoint
CREATE TYPE "bot_service_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "bot_service_capability" AS ENUM('chat', 'image', 'audio', 'embedding', 'realtime', 'async');--> statement-breakpoint
CREATE TABLE "bot_services" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" "bot_service_kind" NOT NULL,
	"capabilities" "bot_service_capability"[] NOT NULL,
	"status" "bot_service_status" DEFAULT 'active' NOT NULL,
	"registered_by" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_services_capabilities_not_empty_check" CHECK (cardinality("bot_services"."capabilities") > 0),
	CONSTRAINT "bot_services_disabled_consistency_check" CHECK (("bot_services"."status" = 'active' AND "bot_services"."disabled_at" IS NULL AND "bot_services"."disabled_by" IS NULL) OR ("bot_services"."status" = 'disabled' AND "bot_services"."disabled_at" IS NOT NULL AND "bot_services"."disabled_by" IS NOT NULL))
);
