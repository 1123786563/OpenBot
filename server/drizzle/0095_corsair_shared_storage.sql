
CREATE TABLE "corsair_account_defaults" (
	"openbot_kind" text NOT NULL,
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"person_id" text NOT NULL,
	"github_user_id" text,
	"github_subject_scope" text,
	"connection_id" text,
	CONSTRAINT "corsair_account_defaults_openbot_kind_workspace_id_person_id_registration_pk" PRIMARY KEY("openbot_kind","workspace_id","person_id","registration"),
	CONSTRAINT "corsair_defaults_shape" CHECK (("corsair_account_defaults"."openbot_kind" = 'github-personal' and "corsair_account_defaults"."github_user_id" is not null and "corsair_account_defaults"."github_subject_scope" is not null and "corsair_account_defaults"."github_subject_scope" = '' and "corsair_account_defaults"."connection_id" is null) or
    ("corsair_account_defaults"."openbot_kind" = 'slack-personal' and "corsair_account_defaults"."github_user_id" is null and "corsair_account_defaults"."github_subject_scope" is null and "corsair_account_defaults"."connection_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "corsair_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dek" text,
	"workspace_id" text,
	"registration" text,
	"openbot_kind" text,
	"person_id" text,
	"subject_scope" text,
	"external_user_id" text,
	"label" text,
	"credential" text,
	"revision" uuid DEFAULT gen_random_uuid(),
	"expires_at" timestamp with time zone,
	"verification_required_at" timestamp with time zone,
	"shared_workspace_id" text,
	"app_id" text,
	"team_id" text,
	"bot_id" text,
	"bot_user_id" text,
	"channel_ids" text[],
	CONSTRAINT "corsair_account_personal_subject" UNIQUE("openbot_kind","workspace_id","registration","person_id","subject_scope","external_user_id"),
	CONSTRAINT "corsair_account_owner" UNIQUE("openbot_kind","workspace_id","registration","person_id","id"),
	CONSTRAINT "corsair_account_shared_workspace" UNIQUE("shared_workspace_id"),
	CONSTRAINT "corsair_account_id_kind" UNIQUE("id","openbot_kind"),
	CONSTRAINT "corsair_accounts_openbot_shape" CHECK (
    case "corsair_accounts"."openbot_kind"
      when 'github-personal' then "corsair_accounts"."subject_scope" = '' and "corsair_accounts"."subject_scope" is not null
        and "corsair_accounts"."person_id" is not null and "corsair_accounts"."workspace_id" is not null and "corsair_accounts"."registration" is not null
        and "corsair_accounts"."external_user_id" is not null and "corsair_accounts"."label" is not null and "corsair_accounts"."credential" is not null
        and "corsair_accounts"."revision" is not null and "corsair_accounts"."expires_at" is not null
      when 'slack-personal' then "corsair_accounts"."subject_scope" is not null and "corsair_accounts"."subject_scope" <> ''
        and "corsair_accounts"."person_id" is not null and "corsair_accounts"."workspace_id" is not null and "corsair_accounts"."registration" is not null
        and "corsair_accounts"."external_user_id" is not null and "corsair_accounts"."label" is not null and "corsair_accounts"."credential" is not null
        and "corsair_accounts"."revision" is not null and "corsair_accounts"."expires_at" is not null
      when 'slack-shared' then "corsair_accounts"."shared_workspace_id" is not null and "corsair_accounts"."app_id" is not null
        and "corsair_accounts"."team_id" is not null and "corsair_accounts"."bot_id" is not null and "corsair_accounts"."bot_user_id" is not null
        and cardinality("corsair_accounts"."channel_ids") > 0 and "corsair_accounts"."channel_ids" is not null
      when 'registration' then "corsair_accounts"."workspace_id" is not null and "corsair_accounts"."registration" is not null
      else "corsair_accounts"."openbot_kind" is null
    end)
);
--> statement-breakpoint
CREATE TABLE "corsair_entities" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"version" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_id" text,
	"registration" text,
	"installation_id" text,
	"repository_id" text,
	"node_id" text,
	"name" text,
	"goal_id" text,
	"connection_id" uuid,
	"connection_revision" uuid,
	"repository_node_id" text,
	"event_types" text[],
	"disabled_at" timestamp with time zone,
	CONSTRAINT "corsair_entities_account_type_entity" UNIQUE("account_id","entity_type","entity_id"),
	CONSTRAINT "corsair_entities_repository_scope" UNIQUE("workspace_id","registration","entity_id","entity_type")
);
--> statement-breakpoint
CREATE TABLE "corsair_event_dispatches" (
	"receipt_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"outcome" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	CONSTRAINT "corsair_event_dispatches_receipt_id_trigger_id_pk" PRIMARY KEY("receipt_id","trigger_id"),
	CONSTRAINT "corsair_event_dispatches_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "corsair_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workspace_id" text,
	"registration" text,
	"delivery_id" text,
	"body_hash" text,
	"installation_id" text,
	"repository_id" text,
	"pilot_dispatch" boolean,
	"occurred_at" timestamp with time zone,
	"disposition" text,
	"fanout_at" timestamp with time zone,
	CONSTRAINT "corsair_events_delivery" UNIQUE("workspace_id","registration","delivery_id"),
	CONSTRAINT "corsair_events_body" UNIQUE("workspace_id","registration","body_hash"),
	CONSTRAINT "corsair_events_status" CHECK ("corsair_events"."status" in ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "corsair_events_delivery_shape" CHECK ("corsair_events"."delivery_id" is null or (
    "corsair_events"."workspace_id" is not null and "corsair_events"."registration" is not null and "corsair_events"."body_hash" is not null and "corsair_events"."pilot_dispatch" is not null
  ))
);
--> statement-breakpoint
CREATE TABLE "corsair_integrations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dek" text
);
--> statement-breakpoint
CREATE TABLE "corsair_oauth_states" (
	"state_hash" text NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"person_id" text NOT NULL,
	"verifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "corsair_oauth_states_provider_state_hash_pk" PRIMARY KEY("provider","state_hash"),
	CONSTRAINT "corsair_oauth_states_provider" CHECK (("corsair_oauth_states"."provider" = 'github' and "corsair_oauth_states"."verifier" is not null) or ("corsair_oauth_states"."provider" = 'slack' and "corsair_oauth_states"."verifier" is null))
);
--> statement-breakpoint
CREATE TABLE "corsair_permissions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token" text NOT NULL,
	"plugin" text NOT NULL,
	"endpoint" text NOT NULL,
	"args" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" text NOT NULL,
	"error" text,
	CONSTRAINT "corsair_permissions_status" CHECK ("corsair_permissions"."status" in ('pending', 'approved', 'executing', 'completed', 'denied', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "corsair_shared_access" (
	"installation_id" text NOT NULL,
	"openbot_kind" text DEFAULT 'slack-shared' NOT NULL,
	"bot_id" text NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"approval" jsonb,
	CONSTRAINT "corsair_shared_access_installation_id_bot_id_pk" PRIMARY KEY("installation_id","bot_id"),
	CONSTRAINT "corsair_shared_access_kind" CHECK ("corsair_shared_access"."openbot_kind" = 'slack-shared')
);
--> statement-breakpoint
ALTER TABLE "corsair_account_defaults" ADD CONSTRAINT "corsair_account_defaults_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_account_defaults" ADD CONSTRAINT "corsair_defaults_github_subject_fk" FOREIGN KEY ("openbot_kind","workspace_id","registration","person_id","github_subject_scope","github_user_id") REFERENCES "public"."corsair_accounts"("openbot_kind","workspace_id","registration","person_id","subject_scope","external_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_account_defaults" ADD CONSTRAINT "corsair_defaults_account_owner_fk" FOREIGN KEY ("openbot_kind","workspace_id","registration","person_id","connection_id") REFERENCES "public"."corsair_accounts"("openbot_kind","workspace_id","registration","person_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_accounts" ADD CONSTRAINT "corsair_accounts_integration_id_corsair_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."corsair_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_accounts" ADD CONSTRAINT "corsair_accounts_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_entities" ADD CONSTRAINT "corsair_entities_account_id_corsair_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."corsair_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_entities" ADD CONSTRAINT "corsair_entities_goal_id_responsibilities_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_event_dispatches" ADD CONSTRAINT "corsair_event_dispatches_receipt_id_corsair_events_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."corsair_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_event_dispatches" ADD CONSTRAINT "corsair_event_dispatches_run_id_responsibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."responsibility_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_events" ADD CONSTRAINT "corsair_events_account_id_corsair_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."corsair_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_oauth_states" ADD CONSTRAINT "corsair_oauth_states_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_shared_access" ADD CONSTRAINT "corsair_shared_access_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corsair_shared_access" ADD CONSTRAINT "corsair_shared_access_account_fk" FOREIGN KEY ("installation_id","openbot_kind") REFERENCES "public"."corsair_accounts"("id","openbot_kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corsair_accounts_tenant_integration_idx" ON "corsair_accounts" USING btree ("tenant_id","integration_id");--> statement-breakpoint
CREATE INDEX "corsair_entities_source_idx" ON "corsair_entities" USING btree ("workspace_id","registration","installation_id","repository_id");--> statement-breakpoint
CREATE INDEX "corsair_entities_goal_idx" ON "corsair_entities" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "corsair_event_dispatches_pending_idx" ON "corsair_event_dispatches" USING btree ("next_attempt_at") WHERE "corsair_event_dispatches"."outcome" in ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "corsair_events_account_type_created_idx" ON "corsair_events" USING btree ("account_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "corsair_events_pending_idx" ON "corsair_events" USING btree ("workspace_id","registration","created_at") WHERE "corsair_events"."delivery_id" is not null and "corsair_events"."fanout_at" is null;--> statement-breakpoint
CREATE INDEX "corsair_permissions_token_idx" ON "corsair_permissions" USING btree ("token");--> statement-breakpoint
-- Registration accounts hold resources and deliveries whose scope is a workspace,
-- independent of the Person who enrolled a resource or receives an approval.
CREATE FUNCTION openbot_corsair_integration(workspace text, provider text, registration_key text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  integration_key text := 'openbot:' || jsonb_build_array(workspace, provider, registration_key)::text;
BEGIN
  INSERT INTO corsair_integrations (id, name)
  VALUES (integration_key, integration_key)
  ON CONFLICT (id) DO NOTHING;
  RETURN integration_key;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION openbot_corsair_bind_storage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  integration_key text;
BEGIN
  IF TG_TABLE_NAME = 'corsair_accounts' THEN
    CASE NEW.openbot_kind
      WHEN 'github-personal' THEN
        NEW.integration_id := openbot_corsair_integration(NEW.workspace_id, 'github', NEW.registration);
      WHEN 'slack-personal' THEN
        NEW.integration_id := openbot_corsair_integration(NEW.workspace_id, 'slack', NEW.registration);
      WHEN 'slack-shared' THEN
        NEW.workspace_id := NEW.shared_workspace_id;
        NEW.registration := NEW.app_id;
        NEW.integration_id := openbot_corsair_integration(NEW.workspace_id, 'slack-shared', NEW.registration);
      ELSE
        RETURN NEW;
    END CASE;
    NEW.tenant_id := 'openbot:' || jsonb_build_array(NEW.workspace_id, NEW.person_id, NEW.id)::text;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'corsair_entities' THEN
    IF NEW.entity_type NOT IN ('openbot.github.repository', 'openbot.github.trigger') THEN
      RETURN NEW;
    END IF;
    IF NEW.entity_type = 'openbot.github.trigger' THEN
      NEW.entity_id := NEW.id;
    END IF;
    NEW.version := '1.0.0';
  ELSE
    IF NEW.delivery_id IS NULL THEN
      RETURN NEW;
    END IF;
    NEW.status := CASE WHEN NEW.fanout_at IS NULL THEN 'pending' ELSE 'completed' END;
  END IF;

  integration_key := openbot_corsair_integration(NEW.workspace_id, 'github', NEW.registration);
  NEW.account_id := integration_key;
  NEW.updated_at := now();
  INSERT INTO corsair_accounts (id, integration_id, tenant_id, openbot_kind, workspace_id, registration)
  VALUES (integration_key, integration_key, 'openbot:' || jsonb_build_array(NEW.workspace_id, NULL)::text,
    'registration', NEW.workspace_id, NEW.registration)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER corsair_bind_account BEFORE INSERT OR UPDATE ON corsair_accounts
FOR EACH ROW EXECUTE FUNCTION openbot_corsair_bind_storage();
--> statement-breakpoint
CREATE TRIGGER corsair_bind_entity BEFORE INSERT OR UPDATE ON corsair_entities
FOR EACH ROW EXECUTE FUNCTION openbot_corsair_bind_storage();
--> statement-breakpoint
CREATE TRIGGER corsair_bind_event BEFORE INSERT OR UPDATE ON corsair_events
FOR EACH ROW EXECUTE FUNCTION openbot_corsair_bind_storage();
--> statement-breakpoint
CREATE VIEW corsair_github_oauth_states AS
SELECT state_hash, workspace_id, registration, person_id, verifier, expires_at, provider
FROM corsair_oauth_states WHERE provider = 'github'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_github_oauth_states ALTER COLUMN provider SET DEFAULT 'github';
--> statement-breakpoint
CREATE VIEW corsair_slack_oauth_states AS
SELECT state_hash, workspace_id, registration, person_id, expires_at, provider
FROM corsair_oauth_states WHERE provider = 'slack'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_slack_oauth_states ALTER COLUMN provider SET DEFAULT 'slack';
--> statement-breakpoint
CREATE VIEW corsair_github_connections AS
SELECT id, workspace_id, registration, person_id, external_user_id AS github_user_id, label AS login, credential, revision, expires_at, openbot_kind, subject_scope
FROM corsair_accounts WHERE openbot_kind = 'github-personal'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_github_connections ALTER COLUMN openbot_kind SET DEFAULT 'github-personal';
--> statement-breakpoint
ALTER VIEW corsair_github_connections ALTER COLUMN subject_scope SET DEFAULT '';
--> statement-breakpoint
CREATE VIEW corsair_slack_connections AS
SELECT id, workspace_id, registration, person_id, subject_scope, external_user_id AS user_id, label, credential, revision, expires_at, verification_required_at, openbot_kind
FROM corsair_accounts WHERE openbot_kind = 'slack-personal'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_slack_connections ALTER COLUMN openbot_kind SET DEFAULT 'slack-personal';
--> statement-breakpoint
CREATE VIEW corsair_slack_installations AS
SELECT id, shared_workspace_id AS workspace_id, app_id, team_id, bot_id, bot_user_id, channel_ids, openbot_kind
FROM corsair_accounts WHERE openbot_kind = 'slack-shared'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_slack_installations ALTER COLUMN openbot_kind SET DEFAULT 'slack-shared';
--> statement-breakpoint
CREATE VIEW corsair_github_defaults AS
SELECT workspace_id, registration, person_id, github_user_id, openbot_kind, github_subject_scope
FROM corsair_account_defaults WHERE openbot_kind = 'github-personal'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_github_defaults ALTER COLUMN openbot_kind SET DEFAULT 'github-personal';
--> statement-breakpoint
ALTER VIEW corsair_github_defaults ALTER COLUMN github_subject_scope SET DEFAULT '';
--> statement-breakpoint
CREATE VIEW corsair_slack_defaults AS
SELECT workspace_id, registration, person_id, connection_id, openbot_kind
FROM corsair_account_defaults WHERE openbot_kind = 'slack-personal'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_slack_defaults ALTER COLUMN openbot_kind SET DEFAULT 'slack-personal';
--> statement-breakpoint
CREATE VIEW corsair_github_repositories AS
SELECT workspace_id, registration, entity_id AS repository_id, installation_id, node_id, name, entity_type
FROM corsair_entities WHERE entity_type = 'openbot.github.repository'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_github_repositories ALTER COLUMN entity_type SET DEFAULT 'openbot.github.repository';
--> statement-breakpoint
CREATE VIEW corsair_github_event_triggers AS
SELECT id, workspace_id, registration, goal_id, connection_id, connection_revision, installation_id, repository_id, repository_node_id, event_types, created_at, disabled_at, entity_type
FROM corsair_entities WHERE entity_type = 'openbot.github.trigger'
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
ALTER VIEW corsair_github_event_triggers ALTER COLUMN entity_type SET DEFAULT 'openbot.github.trigger';
--> statement-breakpoint
CREATE VIEW corsair_github_event_receipts AS
SELECT id, workspace_id, registration, delivery_id, body_hash, event_type, installation_id, repository_id, pilot_dispatch, occurred_at, payload, created_at AS received_at, disposition, fanout_at
FROM corsair_events WHERE delivery_id IS NOT NULL
WITH CASCADED CHECK OPTION;
