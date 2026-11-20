CREATE TABLE "github_pilot_defaults" (
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"registration" text NOT NULL,
	"github_user_id" text NOT NULL,
	CONSTRAINT "github_pilot_defaults_workspace_id_person_id_registration_pk" PRIMARY KEY("workspace_id","person_id","registration")
);
--> statement-breakpoint
ALTER TABLE "github_pilot_defaults" ADD CONSTRAINT "github_pilot_defaults_connection_fk" FOREIGN KEY ("workspace_id","person_id","registration","github_user_id") REFERENCES "public"."github_pilot_connections"("workspace_id","person_id","registration","github_user_id") ON DELETE cascade ON UPDATE no action;