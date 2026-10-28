-- T02.06 (#528, P03): the restricted connections, the DML guard and the
-- deferred constraints (design §5.2.1 "约束时序与命令终结", §5.3 "强制覆盖
-- 所有路径"; interfaces §2/§3, acceptance BA08/H1, confirmed defect F-10).
--
-- Four database-level facts, all idempotent so an interrupted apply re-runs:
--
-- 1. The directory-writer capability role `ob_ent_auth_writer` — the fourth
--    verified restricted connection of tenancy/connections.ts. It owns the BA
--    directory tables end to end and reaches the protected projections,
--    clocks and the durable command model ONLY through the controlled
--    functions below. The legacy writer of 0056 (ob_ent_operator's
--    enterprise_* DML) is deliberately untouched: M1 keeps it, M4 collects
--    those rights.
-- 2. The controlled functions: SECURITY DEFINER, fixed `search_path`, explicit
--    column lists, REVOKE FROM PUBLIC, one grantee each. The protected
--    projection (`enterprise_principals` for PrincipalRegistry, T02.07), the
--    clocks and the receipt/outbox writes are function-only; the data role's
--    clocks/assurance reads (CompanyAssurance.require, T02.10) are
--    function-only too.
-- 3. The DML guard: a BEFORE trigger on the six directory tables checking the
--    controlled command context (writer executor, unfinalized receipt behind
--    the transaction marker, operation allowed for the table+action, row
--    inside the receipt's tenant) and registering the affected relationship
--    keys with their before/after versions in auth_command_change_keys. The
--    marker alone is not trusted: set_config is only a pointer, the receipt
--    row behind it is the proof.
-- 4. The deferred constraints: DEFERRABLE INITIALLY DEFERRED constraint
--    triggers that fire at the finalizer's SET CONSTRAINTS … IMMEDIATE /
--    commit and refuse an unfinalized receipt, an unfinalized or
--    clock-inconsistent change key, and an orphan final state (a teamMember
--    whose company member does not exist in the final state, or a removed
--    member whose company teamMembers were left behind). The legal
--    intermediate order — teamMember before member — stays writable at
--    statement time.

-- ---------------------------------------------------------------------------
-- 1. The directory-writer capability role (the ops/enterprise/roles.sql shape,
--    created here because the grants below are migration-owned).
-- ---------------------------------------------------------------------------
DO $t0206_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ent_auth_writer') THEN
    CREATE ROLE ob_ent_auth_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$t0206_role$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Baseline hygiene on the BA surface: nothing from PUBLIC, nothing stale on
--    the capability roles (the 0056 discipline, applied to the better-auth
--    tables). Legacy rights elsewhere are NOT revoked — M1 keeps the legacy
--    writer.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE
  "auth_organizations", "auth_teams", "auth_team_bindings", "auth_members",
  "auth_team_members", "auth_invitations", "auth_command_receipts",
  "auth_command_change_keys", "auth_command_outbox", "auth_authority_states",
  "auth_team_management_grants", "auth_provisioning_rules",
  "auth_eligibility_clocks", "auth_company_auth_challenges",
  "auth_company_session_assurances"
FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_auth_writer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM ob_ent_auth_writer;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ob_ent_auth_writer;--> statement-breakpoint

-- The directory writer: full DML on the BA directory tables …
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "auth_organizations", "auth_teams", "auth_team_bindings", "auth_members",
  "auth_team_members", "auth_invitations"
TO ob_ent_auth_writer;--> statement-breakpoint
-- … read access to the durable command model it writes through the controlled
-- functions, and to the authority sources the command executor re-verifies.
GRANT SELECT ON TABLE
  "auth_command_receipts", "auth_command_change_keys", "auth_command_outbox",
  "auth_authority_states", "auth_team_management_grants",
  "auth_provisioning_rules"
TO ob_ent_auth_writer;--> statement-breakpoint
-- The directory reader (the DirectoryReadGate's M1 read surface).
GRANT SELECT ON TABLE
  "auth_organizations", "auth_teams", "auth_team_bindings", "auth_members",
  "auth_team_members", "auth_invitations"
TO ob_ent_directory;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3a. The controlled command functions. Owner = the migration role; SECURITY
-- DEFINER with a pinned search_path and explicit column lists, so the
-- definer's rights cannot become a general business read/write bypass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_directory_begin_command(
  p_command_id text,
  p_domain text,
  p_operation text,
  p_tenant_id text,
  p_target_user_id text,
  p_actor_user_id text,
  p_actor_kind text,
  p_idempotency_key text,
  p_payload_hash text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_begin$
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_command_id), '') = '' OR coalesce(btrim(p_operation), '') = ''
     OR coalesce(btrim(p_idempotency_key), '') = '' OR coalesce(btrim(p_payload_hash), '') = '' THEN
    RAISE EXCEPTION 'AUTH_COMMAND_FIELDS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- A stale marker from a command that was finalized but whose caller did not
  -- clear it yet means overlapping commands on one connection: refuse, the
  -- caller protocol clears the marker after every finalize.
  IF coalesce(current_setting('auth.current_command', true), '') NOT IN ('', p_command_id) THEN
    RAISE EXCEPTION 'AUTH_COMMAND_ALREADY_ACTIVE' USING ERRCODE = '25001';
  END IF;
  -- The receipt's own CHECKs pin the closed domains (company/identity target
  -- shape, actor kind, finalized-with-time); the INSERT surfaces their 23514.
  INSERT INTO public.auth_command_receipts
    (command_id, domain, operation, tenant_id, target_user_id,
     idempotency_key, payload_hash, actor_user_id, actor_kind, finalized, created_at)
  VALUES
    (p_command_id, p_domain, p_operation, p_tenant_id, p_target_user_id,
     p_idempotency_key, p_payload_hash, p_actor_user_id, p_actor_kind, false, now());
  -- The transaction marker itself is the CALLER's statement, never this
  -- function's: set_config(..., true) issued inside a function is scoped to
  -- the function, not the transaction, so an in-function marker would
  -- evaporate here. The executor sets it at the transaction's top level
  -- (set_config('auth.current_command', <return value>, true)), and the guard
  -- below never trusts the string — it demands the unfinalized receipt row
  -- behind it.
  RETURN p_command_id;
END
$t0206_begin$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_directory_finalize_command(
  p_command_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_finalize$
DECLARE
  v_updated int;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('auth.current_command', true), '') <> p_command_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_ACTIVE' USING ERRCODE = '25001';
  END IF;
  UPDATE public.auth_command_receipts
     SET finalized = true, finalized_at = now()
   WHERE command_id = p_command_id AND finalized = false;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'AUTH_COMMAND_UNKNOWN_OR_ALREADY_FINALIZED' USING ERRCODE = '23514';
  END IF;
  UPDATE public.auth_command_change_keys
     SET finalized = true
   WHERE command_id = p_command_id AND finalized = false;
  -- The caller clears the marker with its own top-level
  -- set_config('auth.current_command', '', true): a function cannot undo a
  -- transaction-local setting set outside it.
END
$t0206_finalize$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_command_append_outbox(
  p_outbox_id text,
  p_command_id text,
  p_kind text,
  p_payload text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_outbox$
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('auth.current_command', true), '') <> p_command_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_ACTIVE' USING ERRCODE = '25001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.auth_command_receipts
     WHERE command_id = p_command_id AND finalized = false
  ) THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_OPEN' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.auth_command_outbox (id, command_id, kind, payload, status, delivered_at, created_at)
  VALUES (p_outbox_id, p_command_id, p_kind, p_payload, 'pending', null, now());
END
$t0206_outbox$;--> statement-breakpoint

-- The PrincipalRegistry write surface (T02.07's consumer): identity-domain
-- commands register a principal through this function alone.
CREATE OR REPLACE FUNCTION public.auth_principals_register(
  p_principal_id text,
  p_user_id text,
  p_command_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_principals$
DECLARE
  v_domain text;
  v_target text;
  v_finalized boolean;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('auth.current_command', true), '') <> p_command_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_ACTIVE' USING ERRCODE = '25001';
  END IF;
  SELECT domain, target_user_id, finalized INTO v_domain, v_target, v_finalized
    FROM public.auth_command_receipts WHERE command_id = p_command_id;
  IF v_domain IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMMAND_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF v_domain <> 'identity' OR v_target IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'AUTH_COMMAND_ALREADY_FINALIZED' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.enterprise_principals (id, user_id, created_at)
  VALUES (p_principal_id, p_user_id, now());
END
$t0206_principals$;--> statement-breakpoint

-- The protected membership projection: written by the finalizer through this
-- function alone, and only beside the company change key the guard registered
-- for the same principal.
CREATE OR REPLACE FUNCTION public.auth_project_company_membership(
  p_tenant_id text,
  p_principal_id text,
  p_role text,
  p_status text,
  p_epoch integer,
  p_command_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_project$
DECLARE
  v_domain text;
  v_tenant text;
  v_finalized boolean;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('auth.current_command', true), '') <> p_command_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_ACTIVE' USING ERRCODE = '25001';
  END IF;
  SELECT domain, tenant_id, finalized INTO v_domain, v_tenant, v_finalized
    FROM public.auth_command_receipts WHERE command_id = p_command_id;
  IF v_domain IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMMAND_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF v_domain <> 'company' OR v_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_TARGET_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'AUTH_COMMAND_ALREADY_FINALIZED' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.auth_command_change_keys
     WHERE command_id = p_command_id AND tenant_id = p_tenant_id
       AND principal_id = p_principal_id AND kind = 'company' AND scope_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'AUTH_PROJECTION_WITHOUT_REGISTERED_KEY' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.enterprise_memberships (tenant_id, principal_id, role, status, epoch, created_at)
  VALUES (p_tenant_id, p_principal_id, p_role, p_status, p_epoch, now())
  ON CONFLICT ON CONSTRAINT enterprise_memberships_tenant_id_principal_id_pk
  DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, epoch = EXCLUDED.epoch;
END
$t0206_project$;--> statement-breakpoint

-- The clock advance: the only write path onto auth_eligibility_clocks. The
-- requested versions must match the change key the guard registered exactly,
-- and must be a legal advance of the live clock (establish at 1/1, monotonic
-- afterwards, generation+1 for a tombstone).
CREATE OR REPLACE FUNCTION public.auth_advance_eligibility_clock(
  p_tenant_id text,
  p_principal_id text,
  p_kind text,
  p_scope_id text,
  p_epoch_after bigint,
  p_generation_after bigint,
  p_tombstone boolean,
  p_command_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_clock$
DECLARE
  v_receipt_finalized boolean;
  v_key_finalized boolean;
  v_key_epoch bigint;
  v_key_generation bigint;
  v_live record;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMMAND_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('auth.current_command', true), '') <> p_command_id THEN
    RAISE EXCEPTION 'AUTH_COMMAND_NOT_ACTIVE' USING ERRCODE = '25001';
  END IF;
  SELECT r.finalized, k.finalized, k.epoch_after, k.generation_after
    INTO v_receipt_finalized, v_key_finalized, v_key_epoch, v_key_generation
    FROM public.auth_command_receipts r
    JOIN public.auth_command_change_keys k ON k.command_id = r.command_id
   WHERE r.command_id = p_command_id
     AND k.tenant_id = p_tenant_id AND k.principal_id = p_principal_id
     AND k.kind = p_kind AND k.scope_id = p_scope_id;
  IF v_key_epoch IS NULL THEN
    RAISE EXCEPTION 'AUTH_CLOCK_WITHOUT_REGISTERED_KEY' USING ERRCODE = '23514';
  END IF;
  IF v_receipt_finalized OR v_key_finalized THEN
    RAISE EXCEPTION 'AUTH_COMMAND_ALREADY_FINALIZED' USING ERRCODE = '23514';
  END IF;
  IF v_key_epoch <> p_epoch_after OR v_key_generation <> p_generation_after THEN
    RAISE EXCEPTION 'AUTH_CLOCK_MISMATCHES_REGISTERED_KEY' USING ERRCODE = '23514';
  END IF;
  SELECT epoch, generation INTO v_live
    FROM public.auth_eligibility_clocks
   WHERE tenant_id = p_tenant_id AND principal_id = p_principal_id
     AND kind = p_kind AND scope_id = p_scope_id
     FOR UPDATE;
  IF v_live IS NULL THEN
    IF p_epoch_after <> 1 OR p_generation_after <> 1 OR p_tombstone THEN
      RAISE EXCEPTION 'AUTH_CLOCK_ESTABLISHMENT_IS_ONE_ONE' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id, created_at)
    VALUES (p_tenant_id, p_principal_id, p_kind, p_scope_id, p_epoch_after,
            p_generation_after, p_tombstone, p_command_id, now());
  ELSE
    IF p_epoch_after < v_live.epoch OR p_generation_after < v_live.generation THEN
      RAISE EXCEPTION 'AUTH_CLOCK_REGRESSION_REFUSED' USING ERRCODE = '23514';
    END IF;
    IF p_tombstone AND (p_epoch_after <> v_live.epoch OR p_generation_after <> v_live.generation + 1) THEN
      RAISE EXCEPTION 'AUTH_CLOCK_TOMBSTONE_ADVANCES_GENERATION_ONLY' USING ERRCODE = '23514';
    END IF;
    UPDATE public.auth_eligibility_clocks
       SET epoch = p_epoch_after, generation = p_generation_after,
           tombstone = p_tombstone, last_command_id = p_command_id
     WHERE tenant_id = p_tenant_id AND principal_id = p_principal_id
       AND kind = p_kind AND scope_id = p_scope_id;
  END IF;
END
$t0206_clock$;--> statement-breakpoint

-- The data role's controlled reads (CompanyAssurance.require, T02.10): the
-- clocks and the active assurance proofs are readable through these two
-- functions and nothing else.
CREATE OR REPLACE FUNCTION public.auth_read_eligibility_clocks(
  p_tenant_id text,
  p_principal_id text
) RETURNS TABLE(
  tenant_id text, principal_id text, kind text, scope_id text,
  epoch bigint, generation bigint, tombstone boolean,
  last_command_id text, created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
STABLE
AS $t0206_read_clocks$
  SELECT c.tenant_id, c.principal_id, c.kind, c.scope_id, c.epoch, c.generation,
         c.tombstone, c.last_command_id, c.created_at
    FROM public.auth_eligibility_clocks c
   WHERE c.tenant_id = p_tenant_id AND c.principal_id = p_principal_id;
$t0206_read_clocks$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_read_session_assurances(
  p_tenant_id text,
  p_user_id text
) RETURNS TABLE(
  assurance_id text, user_id text, principal_id text, session_id text,
  tenant_id text, challenge_id text, provider_id text,
  authentication_method text, issuer text, subject text,
  authenticated_at timestamptz, strength text, expires_at timestamptz,
  policy_revision bigint, identity_generation bigint, company_generation bigint,
  status text, revoked_at timestamptz, created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
STABLE
AS $t0206_read_assurances$
  SELECT a.assurance_id, a.user_id, a.principal_id, a.session_id, a.tenant_id,
         a.challenge_id, a.provider_id, a.authentication_method, a.issuer,
         a.subject, a.authenticated_at, a.strength, a.expires_at,
         a.policy_revision, a.identity_generation, a.company_generation,
         a.status, a.revoked_at, a.created_at
    FROM public.auth_company_session_assurances a
   WHERE a.tenant_id = p_tenant_id AND a.user_id = p_user_id
     AND a.status = 'active' AND a.revoked_at IS NULL;
$t0206_read_assurances$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3b. The DML guard. BEFORE, row-level, on the six directory tables. Checks
-- the controlled command context and registers the affected relationship
-- keys. No EXECUTE grants: triggers run it, nobody calls it.
-- ---------------------------------------------------------------------------
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
      IF v_operation NOT IN ('member.role.set', 'member.suspend', 'member.restore', 'owner.transfer') THEN
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
      IF v_operation = 'member.suspend' THEN
        v_epoch_after := v_epoch_before;
        v_generation_after := v_generation_before + 1;
      ELSE
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
        IF v_operation NOT IN ('invitation.create') THEN
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

-- The stable principal behind a directory row: no principal, no key.
CREATE OR REPLACE FUNCTION public.auth_directory_guard_principal(
  p_user_id text
) RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
STABLE
AS $t0206_guard_principal$
  SELECT p.id FROM public.enterprise_principals p WHERE p.user_id = p_user_id;
$t0206_guard_principal$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The deferred constraints (the commit fence of §5.2.1). DEFERRABLE
-- INITIALLY DEFERRED: they fire at the finalizer's SET CONSTRAINTS … IMMEDIATE
-- or at COMMIT, read the transaction's FINAL state, and refuse an unfinished
-- command or an orphan final state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_directory_commit_fence() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0206_fence$
DECLARE
  v_finalized boolean;
  v_epoch_after bigint;
  v_generation_after bigint;
  v_team_id text;
  v_user_id text;
  v_member_exists boolean;
  v_orphan_exists boolean;
  v_key record;
BEGIN
  IF TG_TABLE_NAME = 'auth_command_receipts' THEN
    -- Deferred row triggers carry the insert-time snapshot in NEW (§5.2.1:
    -- "延迟触发器读取事务最终状态"), so the fence re-reads the row by key and
    -- judges the FINAL state, never the triggering event's.
    SELECT finalized INTO v_finalized
      FROM public.auth_command_receipts WHERE command_id = NEW.command_id;
    IF v_finalized IS NULL OR NOT v_finalized THEN
      RAISE EXCEPTION 'AUTH_COMMAND_NOT_FINALIZED_AT_COMMIT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'auth_command_change_keys' THEN
    SELECT k.finalized, k.epoch_after, k.generation_after
      INTO v_finalized, v_epoch_after, v_generation_after
      FROM public.auth_command_change_keys k
     WHERE k.command_id = NEW.command_id AND k.tenant_id = NEW.tenant_id
       AND k.principal_id = NEW.principal_id AND k.kind = NEW.kind
       AND k.scope_id = NEW.scope_id;
    IF v_epoch_after IS NULL OR NOT v_finalized THEN
      RAISE EXCEPTION 'AUTH_CHANGE_KEY_NOT_FINALIZED_AT_COMMIT' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.auth_command_receipts r
       WHERE r.command_id = NEW.command_id AND r.finalized
    ) THEN
      RAISE EXCEPTION 'AUTH_CHANGE_KEY_WITHOUT_FINALIZED_RECEIPT' USING ERRCODE = '23514';
    END IF;
    SELECT epoch, generation INTO v_key
      FROM public.auth_eligibility_clocks
     WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
       AND kind = NEW.kind AND scope_id = NEW.scope_id;
    IF v_key IS NULL OR v_key.epoch <> v_epoch_after OR v_key.generation <> v_generation_after THEN
      RAISE EXCEPTION 'AUTH_CLOCK_INCONSISTENT_WITH_CHANGE_KEY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'auth_team_members' THEN
    -- A teamMember written and removed again inside the same transaction is
    -- not part of the final state: the fence judges what commits, not the
    -- intermediate writes.
    SELECT team_id, user_id INTO v_team_id, v_user_id
      FROM public.auth_team_members tm WHERE tm.id = NEW.id;
    -- Re-read by id (R1-F3): a row written and removed again inside the same
    -- transaction is not part of the final state, and the association is
    -- judged on the row's FINAL team/user, never the trigger snapshot's.
    IF v_team_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM public.auth_members m
        JOIN public.auth_teams t ON t.id = v_team_id
       WHERE t.organization_id = m.organization_id AND m.user_id = v_user_id
    ) INTO v_member_exists;
    IF NOT v_member_exists THEN
      RAISE EXCEPTION 'AUTH_ORPHAN_TEAM_MEMBER_AT_COMMIT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- auth_members: a physically removed company member leaves no team member
  -- rows behind in that company. A member removed and re-added in the same
  -- transaction is still a member in the final state.
  IF EXISTS (
    SELECT 1 FROM public.auth_members m
     WHERE m.organization_id = OLD.organization_id AND m.user_id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.auth_team_members tm
      JOIN public.auth_teams t ON t.id = tm.team_id
     WHERE t.organization_id = OLD.organization_id AND tm.user_id = OLD.user_id
  ) INTO v_orphan_exists;
  IF v_orphan_exists THEN
    RAISE EXCEPTION 'AUTH_ORPHAN_TEAM_MEMBER_AT_COMMIT' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$t0206_fence$;--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_members";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."auth_members"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_team_members";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."auth_team_members"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_organizations";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE ON public."auth_organizations"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_teams";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE ON public."auth_teams"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_team_bindings";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."auth_team_bindings"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_directory_dml_guard ON public."auth_invitations";--> statement-breakpoint
CREATE TRIGGER auth_directory_dml_guard
  BEFORE INSERT OR UPDATE ON public."auth_invitations"
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_dml_guard();--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_command_receipt_fence ON public."auth_command_receipts";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auth_command_receipt_fence
  AFTER INSERT ON public."auth_command_receipts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_commit_fence();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_change_key_fence ON public."auth_command_change_keys";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auth_change_key_fence
  AFTER INSERT ON public."auth_command_change_keys"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_commit_fence();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_team_member_orphan_fence ON public."auth_team_members";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auth_team_member_orphan_fence
  AFTER INSERT OR UPDATE ON public."auth_team_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_commit_fence();--> statement-breakpoint
DROP TRIGGER IF EXISTS auth_member_orphan_fence ON public."auth_members";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auth_member_orphan_fence
  AFTER DELETE ON public."auth_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.auth_directory_commit_fence();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Function grants: PUBLIC revoked on every controlled function, then
-- exactly one grantee each.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.auth_directory_begin_command(text,text,text,text,text,text,text,text,text),
  public.auth_directory_finalize_command(text),
  public.auth_command_append_outbox(text,text,text,text),
  public.auth_principals_register(text,text,text),
  public.auth_project_company_membership(text,text,text,text,integer,text),
  public.auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text),
  public.auth_read_eligibility_clocks(text,text),
  public.auth_read_session_assurances(text,text),
  public.auth_directory_dml_guard(),
  public.auth_directory_commit_fence(),
  public.auth_directory_guard_principal(text)
FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.auth_directory_begin_command(text,text,text,text,text,text,text,text,text),
  public.auth_directory_finalize_command(text),
  public.auth_command_append_outbox(text,text,text,text),
  public.auth_principals_register(text,text,text),
  public.auth_project_company_membership(text,text,text,text,integer,text),
  public.auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)
TO ob_ent_auth_writer;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.auth_read_eligibility_clocks(text,text),
  public.auth_read_session_assurances(text,text)
TO ob_ent_data;--> statement-breakpoint
