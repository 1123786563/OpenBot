CREATE TABLE "approval_team_rule_saves" (
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"rule_ids" text[] NOT NULL,
	CONSTRAINT "approval_team_rule_saves_actor_id_request_id_pk" PRIMARY KEY("actor_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "approval_team_rule_saves" ADD CONSTRAINT "approval_team_rule_saves_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;