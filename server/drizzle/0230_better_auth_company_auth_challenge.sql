-- T05.01 (#557, original task P11; coordinator ruling 2026-10-27 granting
-- this journal number): the only legal writer for the company-auth challenge
-- table. 0213 created auth_company_auth_challenges as the T02.05 storage and
-- 0214 revoked every runtime role's privileges on it (BA_NO_DIRECT_PRIVILEGE_
-- TABLES), so a challenge could never be issued: the P11 interactive half had
-- no write path at all. This migration opens exactly one — a SECURITY DEFINER
-- controlled function, the 0214 pattern:
--
--   auth_issue_company_auth_challenge(
--     challenge, user, session, tenant, provider, protocol, policy_revision,
--     return_path, state_digest, secret_envelope, expires_at)
--
-- The capability gate (ob_ent_auth_writer membership) comes first; the field
-- and expiry checks follow (design §9.1: a challenge lives at most 600
-- seconds, and the window is judged against the DATABASE clock so a skewed
-- caller cannot mint a longer-lived row — the row CHECK
-- auth_company_auth_challenge_max_age is the second, independent fence).
-- Inside the tenant advisory lock (the executor's directory-tenant key
-- convention) the function verifies every fact a table can answer before
-- inserting: the user exists, the session exists, is live and belongs to that
-- user (原 session 不可漂移), the company exists and the user is its member.
-- The provider/protocol/policy half of the binding is pinned into the row
-- itself for T05.02's verification side; there is no policy table to check it
-- against yet (the stored policy view is the P11 caller's port). RETURN_PATH
-- is re-checked here as defense in depth (site-local absolute path), though
-- the issuing adapter has already refused anything else.
--
-- The table keeps ZERO direct privileges for every runtime role — the
-- coordinator ruling reaffirms the 0214 discipline; EXECUTE on this function
-- is the whole surface.
CREATE OR REPLACE FUNCTION public.auth_issue_company_auth_challenge(
  p_challenge_id text,
  p_user_id text,
  p_session_id text,
  p_tenant_id text,
  p_provider_id text,
  p_protocol text,
  p_policy_revision bigint,
  p_return_path text,
  p_state_digest text,
  p_secret_envelope text,
  p_expires_at timestamp with time zone
) RETURNS TABLE (challenge_id text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0501_issue$
DECLARE
  v_challenge_id text;
  v_expires_at timestamp with time zone;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_challenge_id IS NULL OR p_challenge_id = ''
     OR p_user_id IS NULL OR p_user_id = ''
     OR p_session_id IS NULL OR p_session_id = ''
     OR p_tenant_id IS NULL OR p_tenant_id = ''
     OR p_provider_id IS NULL OR p_provider_id = ''
     OR p_return_path IS NULL OR p_return_path = ''
     OR p_state_digest IS NULL OR p_state_digest = ''
     OR p_secret_envelope IS NULL OR p_secret_envelope = '' THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_FIELDS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_protocol IS NULL OR p_protocol NOT IN ('oidc', 'saml') THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_PROTOCOL_UNKNOWN' USING ERRCODE = '22023';
  END IF;

  IF p_policy_revision IS NULL OR p_policy_revision < 0
     OR p_policy_revision > 9007199254740991 THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_POLICY_REVISION_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;

  IF left(p_return_path, 1) <> '/' OR left(p_return_path, 2) = '//'
     OR position('\' in p_return_path) > 0 THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_RETURN_PATH_NOT_LOCAL' USING ERRCODE = '22023';
  END IF;

  -- design §9.1: at most 600 seconds, judged against this database's clock.
  IF p_expires_at IS NULL OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '600 seconds' THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_EXPIRY_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;

  -- The tenant-exclusive lock, same key convention as every directory executor.
  PERFORM pg_advisory_xact_lock(hashtextextended('directory-tenant' || chr(31) || p_tenant_id, 0));

  -- Five-fact verification in the lock: everything a table can answer before
  -- a row exists. Uniform named errors; the caller maps them without leaking
  -- which fact failed.
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_USER_UNKNOWN' USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sessions s
     WHERE s.id = p_session_id AND s.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_SESSION_UNKNOWN' USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sessions s
     WHERE s.id = p_session_id AND s.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_SESSION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.enterprise_tenants t WHERE t.id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_COMPANY_UNKNOWN' USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.auth_members m
     WHERE m.organization_id = p_tenant_id AND m.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_NOT_A_MEMBER' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.auth_company_auth_challenges
    (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
     policy_revision, return_path, state_digest, secret_envelope, expires_at)
  VALUES
    (p_challenge_id, p_user_id, p_session_id, p_tenant_id, p_provider_id,
     p_protocol, p_policy_revision, p_return_path, p_state_digest,
     p_secret_envelope, p_expires_at)
  RETURNING
    public.auth_company_auth_challenges.challenge_id,
    public.auth_company_auth_challenges.expires_at
  INTO v_challenge_id, v_expires_at;

  -- RETURN QUERY, not a bare RETURN: the deployment's PostgreSQL 17 plpgsql
  -- answers a bare RETURN of OUT parameters with zero rows (verified on this
  -- island), which would read downstream as a vanished challenge.
  RETURN QUERY SELECT v_challenge_id, v_expires_at;
END
$t0501_issue$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_issue_company_auth_challenge(text, text, text, text, text, text, bigint, text, text, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_issue_company_auth_challenge(text, text, text, text, text, text, bigint, text, text, text, timestamp with time zone) TO ob_ent_auth_writer;
