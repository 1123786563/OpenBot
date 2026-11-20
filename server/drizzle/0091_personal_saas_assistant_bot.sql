CREATE TABLE "personal_workspace_default_bots" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  CONSTRAINT "personal_workspace_default_bots_agent_id_unique" UNIQUE ("agent_id"),
  CONSTRAINT "personal_workspace_default_bots_workspace_id_personal_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "personal_workspace_default_bots_agent_id_agent_profiles_agent_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agent_profiles"("agent_id")
);
--> statement-breakpoint
INSERT INTO "agents" ("id", "name", "type", "configuration")
SELECT "id"::text, "name", 'built_in', jsonb_build_object('systemPrompt', 'You are the user''s Personal Assistant.')
FROM "personal_saas_assistants";
--> statement-breakpoint
INSERT INTO "agent_profiles" ("agent_id", "title", "role_description", "avatar_seed", "visibility")
SELECT "id"::text, "name", 'Help with personal tasks and questions.', "id"::text, 'private'
FROM "personal_saas_assistants";
--> statement-breakpoint
INSERT INTO "personal_workspace_default_bots" ("workspace_id", "agent_id")
SELECT "workspace_id", "id"::text FROM "personal_saas_assistants";
--> statement-breakpoint
DROP TABLE "personal_saas_assistants";
