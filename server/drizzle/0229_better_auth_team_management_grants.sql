-- T04.07 (#551, original task P09; coordinator ruling 2026-10-27): the
-- admission of the team-management-grant model's writer surface. 0212 created
-- auth_team_management_grants as an expand-stage authority source with
-- SELECT-only access for the directory roles; 0214's writer grants INSERT/
-- UPDATE only on the six directory tables, and the DML guard's trigger was
-- attached to exactly those six. The management-grant handlers therefore had
-- no legal writer: every INSERT/UPDATE would fail 42501, and writing through
-- any other role would bypass the command-context fence entirely.
--
-- This migration opens exactly the grant commands' own surface:
--   - ob_ent_auth_writer earns INSERT, UPDATE on the grants table (never
--     DELETE — interfaces §3: 撤销是状态，不是删除，Grant 行不物理删除);
--   - ob_ent_directory earns SELECT, the GET management-grants read face;
--   - the guard gains an auth_team_management_grants branch — INSERT only
--     under 'team.management.grant' (a fresh row starts at generation 1),
--     UPDATE only under 'team.management.grant' (change/re-grant) or
--     'team.management.revoke', with the identity columns (grant/tenant/
--     workspace/team/principal) immutable and the generation advancing by
--     exactly one; DELETE is refused by name. Like auth_team_bindings, a
--     grant row carries no eligibility key: the grantee's clocks are
--     SNAPSHOTTED into the row at grant time (design §4.4), never advanced
--     by it, so the branch registers no change key and returns early.
-- Every other branch is byte-identical to 0216's function; no other table's
-- admission changes.
GRANT INSERT, UPDATE ON TABLE "auth_team_management_grants" TO ob_ent_auth_writer;--> statement-breakpoint
GRANT SELECT ON TABLE "auth_team_management_grants" TO ob_ent_directory;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.auth_directory_dml_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_guard$
DECLARE
  v_command text := coalesce(current_setting('auth.current_command', true), '');
  v_domain text;
  v_operation text;
  v_tenant text;
  v_finalized boolean;
  v_principal text;
  v_organization text;
  v_workspace text;
  v_kind text;
  v_scope text;
  v_epoch_before bigint;
  v_generation_before bigint;
  v_epoch_after bigint;
  v_generation_after bigint;
BEGIN
  -- The controlled executor: directory DML is the writer capability's job.
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_DIRECTORY_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- The command context: the marker alone is not trusted — the unfinalized
  -- receipt row behind it is the proof, and only the controlled begin
  -- function can write one.
  IF v_command = '' THEN
    RAISE EXCEPTION 'AUTH_COMMAND_CONTEXT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  SELECT domain, operation, tenant_id, finalized
    INTO v_domain, v_operation, v_tenant, v_finalized
    FROM public.auth_command_receipts WHERE command_id = v_command;
  IF v_domain IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMMAND_CONTEXT_INVALID' USING ERRCODE = '23514';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'AUTH_COMMAND_ALREADY_FINALIZED' USING ERRCODE = '23514';
  END IF;
  IF v_domain <> 'company' THEN
    RAISE EXCEPTION 'AUTH_COMMAND_DOMAIN_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'auth_members' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.organization_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('company.provision', 'invitation.accept', 'member.provision') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      v_principal := public.auth_directory_guard_principal(NEW.user_id);
      v_kind := 'company'; v_scope := v_tenant;
      SELECT epoch, generation INTO v_epoch_before, v_generation_before
        FROM public.auth_eligibility_clocks
       WHERE tenant_id = v_tenant AND principal_id = v_principal
         AND kind = 'company' AND scope_id = v_tenant;
      v_epoch_after := coalesce(v_epoch_before, 0) + 1;
      v_generation_after := coalesce(v_generation_before, 1);
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'AUTH_MEMBER_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      IF OLD.organization_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('member.role.set', 'member.suspend', 'member.restore', 'owner.transfer',
                            'company.suspend', 'company.restore') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      v_principal := public.auth_directory_guard_principal(OLD.user_id);
      v_kind := 'company'; v_scope := v_tenant;
      SELECT epoch, generation INTO v_epoch_before, v_generation_before
        FROM public.auth_eligibility_clocks
       WHERE tenant_id = v_tenant AND principal_id = v_principal
         AND kind = 'company' AND scope_id = v_tenant;
      IF v_epoch_before IS NULL THEN
        RAISE EXCEPTION 'AUTH_CLOCK_REQUIRED_FOR_UPDATE' USING ERRCODE = '23514';
      END IF;
      IF v_operation IN ('member.suspend', 'company.suspend') THEN
        -- company.suspend (T03.04 / #541, 0215): a company-level suspension
        -- advances every member's company GENERATION through this same
        -- change-key channel — spec §4.4's 暂停推进 generation — so the clock,
        -- the projected row and every scope's companyGeneration move together
        -- and the frozen three-way gate comparison stays true.
        v_epoch_after := v_epoch_before;
        v_generation_after := v_generation_before + 1;
      ELSE
        -- member.restore/role.set/owner.transfer AND company.restore (T03.04):
        -- a restore advances the epoch and keeps the already-advanced
        -- generation — spec §4.4's 恢复推进 epoch，沿用已经推进的 generation.
        v_epoch_after := v_epoch_before + 1;
        v_generation_after := v_generation_before;
      END IF;
    ELSE
      IF OLD.organization_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('member.remove', 'member.leave') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      v_principal := public.auth_directory_guard_principal(OLD.user_id);
      v_kind := 'company'; v_scope := v_tenant;
      SELECT epoch, generation INTO v_epoch_before, v_generation_before
        FROM public.auth_eligibility_clocks
       WHERE tenant_id = v_tenant AND principal_id = v_principal
         AND kind = 'company' AND scope_id = v_tenant;
      IF v_epoch_before IS NULL THEN
        RAISE EXCEPTION 'AUTH_CLOCK_REQUIRED_FOR_REMOVAL' USING ERRCODE = '23514';
      END IF;
      v_epoch_after := v_epoch_before;
      v_generation_after := v_generation_before + 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'auth_team_members' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT organization_id INTO v_organization FROM public.auth_teams WHERE id = NEW.team_id;
      IF v_organization IS NULL OR v_organization IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('team.member.add', 'invitation.accept', 'member.provision', 'company.provision') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'AUTH_TEAM_MEMBER_ROWS_ARE_NOT_UPDATABLE' USING ERRCODE = '42501';
    ELSE
      SELECT organization_id INTO v_organization FROM public.auth_teams WHERE id = OLD.team_id;
      IF v_organization IS NULL OR v_organization IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('team.member.remove', 'member.remove', 'member.leave') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
    END IF;
    v_principal := public.auth_directory_guard_principal(coalesce(NEW.user_id, OLD.user_id));
    SELECT workspace_id INTO v_workspace
      FROM public.auth_team_bindings WHERE team_id = coalesce(NEW.team_id, OLD.team_id) AND tenant_id = v_tenant;
    IF v_workspace IS NULL THEN
      RAISE EXCEPTION 'AUTH_TEAM_BINDING_REQUIRED' USING ERRCODE = '23514';
    END IF;
    v_kind := 'team'; v_scope := v_workspace;
    SELECT epoch, generation INTO v_epoch_before, v_generation_before
      FROM public.auth_eligibility_clocks
     WHERE tenant_id = v_tenant AND principal_id = v_principal
       AND kind = 'team' AND scope_id = v_workspace;
    IF TG_OP = 'INSERT' THEN
      v_epoch_after := coalesce(v_epoch_before, 0) + 1;
      v_generation_after := coalesce(v_generation_before, 1);
    ELSE
      IF v_epoch_before IS NULL THEN
        RAISE EXCEPTION 'AUTH_CLOCK_REQUIRED_FOR_REMOVAL' USING ERRCODE = '23514';
      END IF;
      v_epoch_after := v_epoch_before;
      v_generation_after := v_generation_before + 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'auth_team_bindings' THEN
    -- The immutable team→workspace mapping (R1-F1, review r1): the binding is
    -- structural necessity — team.create's generated ids and provisioning's
    -- default team both create one — so it has its OWN branch, never the
    -- fall-through. The tenant must match the receipt directly AND through the
    -- bound team's organization; re-pointing or deleting is refused by name
    -- (T02.01's composite FKs already refuse the cross-company re-point; this
    -- refuses the rest).
    IF TG_OP = 'INSERT' THEN
      IF NEW.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('team.create', 'company.provision') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.auth_teams t
         WHERE t.id = NEW.team_id AND t.organization_id = v_tenant
      ) THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'AUTH_TEAM_BINDING_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    -- A binding carries no eligibility key: context and operation only, like
    -- the organizations/teams/invitations branch below, and never the
    -- statement-level change-key registration.
    RETURN coalesce(NEW, OLD);
  ELSIF TG_TABLE_NAME = 'auth_team_management_grants' THEN
    -- T04.07: the stable management-grant row. Same context-and-operation
    -- discipline as a binding: the row snapshots the grantee's eligibility
    -- generations at grant time and carries no eligibility key of its own,
    -- so no change key is registered here.
    IF TG_OP = 'INSERT' THEN
      IF NEW.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('team.management.grant') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      IF NEW.generation IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'AUTH_GRANT_ROW_MUST_START_AT_GENERATION_ONE' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF NEW.grant_id IS DISTINCT FROM OLD.grant_id
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
         OR NEW.team_id IS DISTINCT FROM OLD.team_id
         OR NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
        RAISE EXCEPTION 'AUTH_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      IF v_operation NOT IN ('team.management.grant', 'team.management.revoke') THEN
        RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
      END IF;
      IF NEW.generation IS DISTINCT FROM OLD.generation + 1 THEN
        RAISE EXCEPTION 'AUTH_GRANT_GENERATION_MUST_ADVANCE_BY_ONE' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'AUTH_GRANT_ROWS_ARE_NOT_DELETABLE' USING ERRCODE = '42501';
    END IF;
    RETURN coalesce(NEW, OLD);
  ELSE
    -- organizations / teams / invitations: command context and operation only;
    -- these tables carry no eligibility keys.
    IF TG_TABLE_NAME = 'auth_organizations' THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.id IS DISTINCT FROM v_tenant THEN
          RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF v_operation NOT IN ('company.provision') THEN
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.id IS DISTINCT FROM v_tenant THEN
          RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF v_operation NOT IN ('company.profile.update', 'company.suspend', 'company.restore') THEN
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'AUTH_ORGANIZATION_ROWS_ARE_NOT_DELETABLE' USING ERRCODE = '42501';
      END IF;
    ELSIF TG_TABLE_NAME = 'auth_teams' THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.organization_id IS DISTINCT FROM v_tenant THEN
          RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF v_operation NOT IN ('team.create', 'company.provision') THEN
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
          RAISE EXCEPTION 'AUTH_TEAM_ORGANIZATION_IMMUTABLE' USING ERRCODE = '23514';
        END IF;
        IF v_operation = 'team.profile.update' THEN
          -- member_count is the plugin's own counter (input: false): a profile
          -- update renames, it never counts.
          IF NEW.member_count IS DISTINCT FROM OLD.member_count THEN
            RAISE EXCEPTION 'AUTH_TEAM_PROFILE_CANNOT_TOUCH_MEMBER_COUNT' USING ERRCODE = '23514';
          END IF;
        ELSIF v_operation IN ('team.member.add', 'invitation.accept',
                              'member.provision', 'company.provision') THEN
          -- The membership commands maintain the count: exactly +1, nothing
          -- else on the row may move (review r1 R1-F1's member_count ruling).
          IF NEW.name IS DISTINCT FROM OLD.name
             OR NEW.member_count IS DISTINCT FROM OLD.member_count + 1 THEN
            RAISE EXCEPTION 'AUTH_TEAM_MEMBER_COUNT_ONLY' USING ERRCODE = '23514';
          END IF;
        ELSIF v_operation IN ('team.member.remove', 'member.remove', 'member.leave') THEN
          IF NEW.name IS DISTINCT FROM OLD.name
             OR NEW.member_count IS DISTINCT FROM OLD.member_count - 1 THEN
            RAISE EXCEPTION 'AUTH_TEAM_MEMBER_COUNT_ONLY' USING ERRCODE = '23514';
          END IF;
        ELSE
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'AUTH_TEAM_ROWS_ARE_NOT_DELETABLE' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF TG_OP = 'INSERT' THEN
        IF NEW.organization_id IS DISTINCT FROM v_tenant THEN
          RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF v_operation NOT IN ('invitation.create', 'invitation.resend') THEN
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.organization_id IS DISTINCT FROM v_tenant THEN
          RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF v_operation NOT IN ('invitation.accept', 'invitation.reject', 'invitation.cancel', 'invitation.resend') THEN
          RAISE EXCEPTION 'AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'AUTH_INVITATION_ROWS_ARE_NOT_DELETABLE' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN coalesce(NEW, OLD);
  END IF;

  -- Statement-level change-key registration (§5.2.1): before/after versions of
  -- the affected relationship key, first write wins inside one command.
  INSERT INTO public.auth_command_change_keys
    (command_id, tenant_id, principal_id, kind, scope_id,
     epoch_before, generation_before, epoch_after, generation_after, finalized)
  VALUES
    (v_command, v_tenant, v_principal, v_kind, v_scope,
     v_epoch_before, v_generation_before, v_epoch_after, v_generation_after, false)
  ON CONFLICT ON CONSTRAINT auth_command_change_key_pk DO NOTHING;
  RETURN coalesce(NEW, OLD);
END
$t0206_guard$;--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_team_management_grants";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."auth_team_management_grants"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();
