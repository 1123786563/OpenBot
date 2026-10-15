-- Workshop row-level security, per plan 03 §4.1/§4.2 and the W2 plan's §RLS.
--
-- This custom migration is the ONLY executable source of policies and table privileges for the
-- five W2 tables (0060 discipline: no second policies.sql exists on purpose). Context variables
-- are set by the trusted application inside one transaction via set_config(..., true) and vanish
-- with it; a missing context yields NULL, and NULL policies deny.
--
-- The workshop's tenancy key is the OWNER USER, not an enterprise tenant: a workshop session
-- belongs to the person who opened it, and every child row resolves ownership through its
-- parent. `app.user_id` is the context the application pins per request.
--
-- Layout: (1) ENABLE/FORCE RLS on every table; (2) owner-pinned policies on the two root tables
-- (workshop_sessions by owner column, sandbox_instances by its agent's owner through the agents
-- table — the instance has no owner column of its own); (3) child tables resolve the owner
-- through their parent row exactly the way 0060's run-children do; (4) minimal GRANTs.
--> statement-breakpoint
-- 1. Row level security on every W2 table.
ALTER TABLE workshop_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE workshop_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE workshop_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE workshop_turn_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_turn_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_instances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 2a. The workshop owner role: full CRUD on sessions it owns, children resolved through it.
-- Idempotent on purpose: a re-run (a reconciled dev database, a restored backup) must not
-- fail on the role already existing, or the whole migration rolls back.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workshop_writer') THEN
    CREATE ROLE ob_workshop_writer NOLOGIN;
  END IF;
END
$role$;
--> statement-breakpoint
CREATE POLICY session_owner_write ON workshop_sessions FOR ALL TO ob_workshop_writer
USING (workshop_sessions.owner_user_id = nullif(current_setting('app.user_id', true), ''))
WITH CHECK (workshop_sessions.owner_user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- 2b. Artifacts and turns are session children: the owner is the session's owner, resolved
-- through the parent row — these tables have no owner column of their own, on purpose, because
-- a row copied between sessions must not carry a stale owner with it.
CREATE POLICY artifact_session_owner ON workshop_artifacts FOR ALL TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_artifacts.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')))
WITH CHECK (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_artifacts.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
CREATE POLICY turn_session_owner ON workshop_turns FOR ALL TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_turns.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')))
WITH CHECK (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_turns.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 2c. Events resolve through TWO parents (turn, then session): the deepest child, and the one
-- the stream writes hottest, so the double hop is stated once and clearly.
CREATE POLICY event_turn_owner ON workshop_turn_events FOR ALL TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM workshop_turns t
  JOIN workshop_sessions s ON s.id = t.session_id
  WHERE t.id = workshop_turn_events.turn_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')))
WITH CHECK (EXISTS (
  SELECT 1 FROM workshop_turns t
  JOIN workshop_sessions s ON s.id = t.session_id
  WHERE t.id = workshop_turn_events.turn_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 2d. Sandbox instances have no owner column: the instance belongs to a Bot (bot_id FK), and
-- the Bot's profile carries its owner. Read-mostly policy: the writer may see its own Bots'
-- instances; lifecycle changes stay with the deployment's own maintenance role.
CREATE POLICY instance_bot_owner_read ON sandbox_instances FOR SELECT TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM agent_profiles p
  WHERE p.agent_id = sandbox_instances.bot_id
    AND p.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 4. Minimal grants: the workshop writer touches exactly these tables, nothing wider.
GRANT SELECT, INSERT, UPDATE ON workshop_sessions TO ob_workshop_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON workshop_artifacts TO ob_workshop_writer;
GRANT SELECT, INSERT, UPDATE ON workshop_turns TO ob_workshop_writer;
GRANT SELECT, INSERT ON workshop_turn_events TO ob_workshop_writer;
GRANT SELECT ON sandbox_instances TO ob_workshop_writer;
