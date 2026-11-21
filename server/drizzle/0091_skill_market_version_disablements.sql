CREATE TABLE "skill_market_version_disablements" (
	"registry" text NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL,
	"registry_skill_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"version" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "skill_market_version_disablements_registry_registry_skill_id_version_id_pk" PRIMARY KEY("registry","registry_skill_id","version_id")
);
