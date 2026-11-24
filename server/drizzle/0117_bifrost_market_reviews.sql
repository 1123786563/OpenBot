CREATE TABLE "bifrost_market_reviews" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bifrost_market_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"skill_id" integer NOT NULL,
	"version_uuid" uuid NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	CONSTRAINT "bifrost_market_reviews_version_uuid_unique" UNIQUE("version_uuid")
);
--> statement-breakpoint
CREATE TABLE "bifrost_market_skills" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bifrost_market_skills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"skill_uuid" uuid NOT NULL,
	CONSTRAINT "bifrost_market_skills_skill_uuid_unique" UNIQUE("skill_uuid")
);
--> statement-breakpoint
ALTER TABLE "bifrost_market_reviews" ADD CONSTRAINT "bifrost_market_reviews_skill_id_bifrost_market_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."bifrost_market_skills"("id") ON DELETE no action ON UPDATE no action;