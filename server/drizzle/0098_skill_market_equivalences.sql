CREATE TABLE "skill_market_equivalences" (
	"registry_id" text NOT NULL,
	"source" text NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL,
	"registry_skill_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"target_skill_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	"target_slug" text NOT NULL,
	"version" text NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "skill_market_equivalences_source_registry_skill_id_version_id_pk" PRIMARY KEY("source","registry_skill_id","version_id"),
	CONSTRAINT "skill_market_equivalences_target_version_id_unique" UNIQUE("target_version_id")
);
--> statement-breakpoint
CREATE TABLE "skill_market_migration_receipts" (
	"registry_id" text PRIMARY KEY NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_market_installations" ADD COLUMN "registry" text;--> statement-breakpoint
ALTER TABLE "skill_market_installations" ADD COLUMN "namespace" text;--> statement-breakpoint
ALTER TABLE "skill_market_installations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "skill_market_equivalences" ADD CONSTRAINT "skill_market_equivalences_registry_id_skill_market_migration_receipts_registry_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."skill_market_migration_receipts"("registry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_market_equivalence_target_skill_idx" ON "skill_market_equivalences" USING btree ("target_skill_id");--> statement-breakpoint
CREATE INDEX "skill_market_equivalence_source_skill_idx" ON "skill_market_equivalences" USING btree ("source","namespace","slug");