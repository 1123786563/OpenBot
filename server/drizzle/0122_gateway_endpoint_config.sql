CREATE TABLE "gateway_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"request_timeout_ms" integer DEFAULT 10000 NOT NULL,
	"config_version" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
