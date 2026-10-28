-- T05.02 (#558, original task P11; coordinator ruling 2026-10-27 granting
-- this journal number): the callback half of the company-auth challenge —
-- the one-time consumption the evidence bridge verifies against and the
-- session-assurance proof a VERIFIED callback earns. 0213 created both
-- tables and 0214 revoked every runtime role's privileges on them, so a
-- callback could verify against nothing and no proof could ever be written.
-- Like 0218 for issuance, this migration opens exactly the controlled
-- surface T05.02 needs and nothing else:
--
--   auth_read_company_auth_policy(tenant)
--     — the stored challenge/proof policy (the table below) as one read.
--   auth_consume_company_auth_challenge(state_digest)
--     — the at-most-once consumption: a single conditional UPDATE judged on
--       consumed_at, never a deletion (0213 keeps the binding pinnable and
--       the audit trail intact).
--   auth_record_company_session_assurance(...)
--     — the proof write, under the tenant advisory lock (the executor's
--       directory-tenant key convention), re-verifying EVERY fact the §9.1
--       callback must re-compare: the challenge exists, was consumed by the
--       bridge, is not expired, and still matches the stored policy
--       (provider/protocol/revision); the FINAL session is live and belongs
--       to the challenge's ORIGINAL user (账户不匹配拒绝); membership
--       stands; the signed (issuer, subject) is bound to that same user in
--       accounts (subject 必须映射当前 user，不按邮箱并号); the principal
--       and both issuance generations exist (缺失即拒绝，不补默认). The
--       proof's expiry is computed HERE as
--       least(session expiry, authenticated_at + max_auth_age) from the
--       stored policy — never from the callback clock.
--
-- The policy table is the storage model behind the T05.01 frozen port
-- (CompanyAuthChallengePolicyView / CompanyProofPolicyView): one row per
-- company, at most; no row means the company runs no additional challenge
-- and the read gate answers null. Population is an administrator surface
-- that arrives with the assembly tasks; nothing here seeds or defaults one.
--
-- Every table keeps ZERO direct privileges for every runtime role (the
-- 0214 discipline the coordinator ruling reaffirms); EXECUTE on these
-- functions is the whole surface. The two write-shaped functions gate on
-- ob_ent_auth_writer membership; the pure read is granted by EXECUTE alone,
-- which 0214's reader precedent (auth_read_eligibility_clocks →
-- ob_ent_data) keeps as the read-gate's shape — T05.04's data-role gate
-- wiring extends the grant when it assembles.
CREATE TABLE "auth_company_auth_policies" (
	"tenant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"protocol" text NOT NULL,
	"policy_revision" bigint NOT NULL,
	"max_auth_age_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_company_auth_policy_pk" PRIMARY KEY("tenant_id")
);--> statement-breakpoint
ALTER TABLE "auth_company_auth_policies" ADD CONSTRAINT "auth_company_auth_policy_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_auth_policies" ADD CONSTRAINT "auth_company_auth_policy_protocol" CHECK ("protocol" in ('oidc','saml'));--> statement-breakpoint
ALTER TABLE "auth_company_auth_policies" ADD CONSTRAINT "auth_company_auth_policy_revision_safe_integer" CHECK ("policy_revision" >= 0 and "policy_revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_company_auth_policies" ADD CONSTRAINT "auth_company_auth_policy_max_age_positive" CHECK ("max_auth_age_seconds" > 0);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_read_company_auth_policy(
  p_tenant_id text
) RETURNS TABLE (provider_id text, protocol text, policy_revision bigint, max_auth_age_seconds integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
STABLE
AS $t0502_read_policy$
  SELECT p.provider_id, p.protocol, p.policy_revision, p.max_auth_age_seconds
    FROM public.auth_company_auth_policies p
   WHERE p.tenant_id = p_tenant_id;
$t0502_read_policy$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_consume_company_auth_challenge(
  p_state_digest text
) RETURNS TABLE (challenge_id text, user_id text, session_id text, tenant_id text,
                 provider_id text, protocol text, policy_revision bigint,
                 return_path text, secret_envelope text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0502_consume$
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_state_digest IS NULL OR p_state_digest = '' THEN
    RAISE EXCEPTION 'AUTH_CHALLENGE_FIELDS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- At most once, atomically: the conditional UPDATE is the whole answer.
  -- An expired-but-unconsumed row is still consumed here so the caller's
  -- bridge can answer SSO_CHALLENGE_EXPIRED from the returned expires_at
  -- instead of mistaking it for an unknown state.
  RETURN QUERY
    UPDATE public.auth_company_auth_challenges c
       SET consumed_at = clock_timestamp()
     WHERE c.state_digest = p_state_digest AND c.consumed_at IS NULL
    RETURNING c.challenge_id, c.user_id, c.session_id, c.tenant_id,
              c.provider_id, c.protocol, c.policy_revision, c.return_path,
              c.secret_envelope, c.expires_at;
END
$t0502_consume$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_record_company_session_assurance(
  p_challenge_id text,
  p_assurance_id text,
  p_final_session_id text,
  p_issuer text,
  p_subject text,
  p_authenticated_at timestamp with time zone,
  p_strength text
) RETURNS TABLE (assurance_id text, session_id text, tenant_id text, return_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $t0502_record$
DECLARE
  v_challenge public.auth_company_auth_challenges%ROWTYPE;
  v_tenant text;
  v_policy public.auth_company_auth_policies%ROWTYPE;
  v_session_expires_at timestamp with time zone;
  v_final_session_id text;
  v_principal text;
  v_identity_generation bigint;
  v_company_generation bigint;
  v_expires_at timestamp with time zone;
BEGIN
  IF NOT pg_has_role(session_user, 'ob_ent_auth_writer'::regrole, 'MEMBER') THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_WRITER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_challenge_id IS NULL OR p_challenge_id = ''
     OR p_assurance_id IS NULL OR p_assurance_id = ''
     OR p_issuer IS NULL OR p_issuer = ''
     OR p_subject IS NULL OR p_subject = ''
     OR p_strength IS NULL OR p_strength = ''
     OR p_authenticated_at IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_FIELDS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The challenge is the only source of the original binding; a NULL final
  -- session means "the challenge's own session", the no-rotation path.
  SELECT * INTO v_challenge FROM public.auth_company_auth_challenges c
   WHERE c.challenge_id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_CHALLENGE_UNKNOWN' USING ERRCODE = '22000';
  END IF;
  v_tenant := v_challenge.tenant_id;

  -- The tenant-exclusive lock, same key convention as every directory
  -- executor: policy reads, membership and proof writes for one company
  -- serialize here.
  PERFORM pg_advisory_xact_lock(hashtextextended('directory-tenant' || chr(31) || v_tenant, 0));

  -- One-time: the bridge's consume must already have spent this challenge.
  IF v_challenge.consumed_at IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_CHALLENGE_NOT_CONSUMED' USING ERRCODE = '23514';
  END IF;
  IF v_challenge.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_CHALLENGE_EXPIRED' USING ERRCODE = '23514';
  END IF;

  -- The stored policy is the live truth; the challenge's pinned triple must
  -- still be the policy of record (策略已变化拒绝).
  SELECT * INTO v_policy FROM public.auth_company_auth_policies p
   WHERE p.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_POLICY_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF v_policy.provider_id <> v_challenge.provider_id
     OR v_policy.protocol <> v_challenge.protocol
     OR v_policy.policy_revision <> v_challenge.policy_revision THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_POLICY_MISMATCH' USING ERRCODE = '23514';
  END IF;

  -- The FINAL session: live, and owned by the challenge's ORIGINAL user —
  -- a callback after switching accounts binds nobody (账户不匹配).
  v_final_session_id := coalesce(p_final_session_id, v_challenge.session_id);
  SELECT s.expires_at INTO v_session_expires_at
    FROM public.sessions s WHERE s.id = v_final_session_id;
  IF v_session_expires_at IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_SESSION_UNKNOWN' USING ERRCODE = '22000';
  END IF;
  IF v_session_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_SESSION_UNKNOWN' USING ERRCODE = '22000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions s
     WHERE s.id = v_final_session_id AND s.user_id = v_challenge.user_id
  ) THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_SESSION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.auth_members m
     WHERE m.organization_id = v_tenant AND m.user_id = v_challenge.user_id
  ) THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_NOT_A_MEMBER' USING ERRCODE = '23514';
  END IF;

  -- The signed identity must already be bound to the challenge's ORIGINAL
  -- user on this server: no email merging, no first-come claiming.
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.user_id = v_challenge.user_id AND a.issuer = p_issuer
       AND a.account_id = p_subject
  ) THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_IDENTITY_UNKNOWN' USING ERRCODE = '23514';
  END IF;

  v_principal := public.auth_directory_guard_principal(v_challenge.user_id);
  IF v_principal IS NULL OR v_principal = '' THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_NO_PRINCIPAL' USING ERRCODE = '23514';
  END IF;
  SELECT p.identity_generation INTO v_identity_generation
    FROM public.enterprise_principals p WHERE p.id = v_principal;
  IF v_identity_generation IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_IDENTITY_GENERATION_MISSING' USING ERRCODE = '23514';
  END IF;
  SELECT c.generation INTO v_company_generation
    FROM public.auth_eligibility_clocks c
   WHERE c.tenant_id = v_tenant AND c.principal_id = v_principal
     AND c.kind = 'company' AND c.scope_id = v_tenant AND c.tombstone = false;
  IF v_company_generation IS NULL THEN
    RAISE EXCEPTION 'AUTH_COMPLETE_COMPANY_GENERATION_MISSING' USING ERRCODE = '23514';
  END IF;

  -- §9.1: the proof lives no longer than the session or the policy's max
  -- authentication age, judged from the SIGNED authentication time.
  v_expires_at := least(
    v_session_expires_at,
    p_authenticated_at + make_interval(secs => v_policy.max_auth_age_seconds));

  -- The (session, tenant) current-proof key holds exactly one ACTIVE proof:
  -- a fresh completion supersedes the older one inside the same lock, so the
  -- supersession happens BEFORE the insert (the partial unique index would
  -- refuse the new row otherwise). If the insert below then fails, the whole
  -- transaction — this revocation included — rolls back.
  UPDATE public.auth_company_session_assurances a
     SET status = 'revoked', revoked_at = clock_timestamp()
   WHERE a.session_id = v_final_session_id AND a.tenant_id = v_tenant
     AND a.status = 'active';

  BEGIN
    INSERT INTO public.auth_company_session_assurances
      (assurance_id, user_id, principal_id, session_id, tenant_id,
       challenge_id, provider_id, authentication_method, issuer, subject,
       authenticated_at, strength, expires_at, policy_revision,
       identity_generation, company_generation, status, created_at)
    VALUES
      (p_assurance_id, v_challenge.user_id, v_principal, v_final_session_id,
       v_tenant, v_challenge.challenge_id, v_challenge.provider_id,
       v_challenge.protocol, p_issuer, p_subject, p_authenticated_at,
       p_strength, v_expires_at, v_policy.policy_revision,
       v_identity_generation, v_company_generation, 'active', clock_timestamp());
  EXCEPTION
    WHEN unique_violation THEN
      -- One proof per challenge: a conflict past the bridge's one-time
      -- consume is always a replay or a tamper.
      RAISE EXCEPTION 'AUTH_COMPLETE_PROOF_CONFLICT' USING ERRCODE = '23514';
  END;

  -- RETURN QUERY, not a bare RETURN: the deployment's PostgreSQL 17 plpgsql
  -- answers a bare RETURN of OUT parameters with zero rows (0218's lesson).
  RETURN QUERY SELECT p_assurance_id, v_final_session_id, v_tenant, v_challenge.return_path;
END
$t0502_record$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_read_company_auth_policy(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_consume_company_auth_challenge(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_read_company_auth_policy(text) TO ob_ent_auth_writer;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_consume_company_auth_challenge(text) TO ob_ent_auth_writer;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text) TO ob_ent_auth_writer;
