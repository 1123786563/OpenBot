CREATE OR REPLACE VIEW corsair_github_connections AS
SELECT id, workspace_id, registration, person_id, external_user_id AS github_user_id, label AS login, credential, revision, expires_at, openbot_kind, subject_scope
FROM corsair_accounts WHERE openbot_kind = 'github-personal'
  AND NOT (config ? 'openbotRevocation')
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
CREATE OR REPLACE VIEW corsair_slack_connections AS
SELECT id, workspace_id, registration, person_id, subject_scope, external_user_id AS user_id, label, credential, revision, expires_at, verification_required_at, openbot_kind
FROM corsair_accounts WHERE openbot_kind = 'slack-personal'
  AND NOT (config ? 'openbotRevocation')
WITH CASCADED CHECK OPTION;
--> statement-breakpoint
CREATE OR REPLACE VIEW corsair_slack_installations AS
SELECT id, shared_workspace_id AS workspace_id, app_id, team_id, bot_id, bot_user_id, channel_ids, openbot_kind
FROM corsair_accounts WHERE openbot_kind = 'slack-shared'
  AND NOT (config ? 'openbotRevocation')
WITH CASCADED CHECK OPTION;
