-- T02.05 (#527, P03): the company authentication challenge and proof storage
-- (design §9.1 "公司认证证据与追加认证", Global Constraints "公司 challenge
-- 最长 600 秒、proof 使用签名声明真实认证时间"; interfaces §5).
--
-- Expand only (M1): two new tables — the one-time challenge record the §9.1
-- gate issues (original user/session, target tenant, allowed provider,
-- protocol, policy revision, site-local return path, and the correlation
-- material only as digest plus one sealed envelope) and the session assurance
-- proof a VERIFIED callback earns (real IdP-authenticated time, normalized
-- strength, issuance generations, policy revision). No existing column,
-- constraint, index or privilege is touched.
--
-- The binding is immutable at the database level: the proof's composite
-- foreign key (challenge_id, user_id, tenant_id, provider_id,
-- authentication_method) targets the challenge's own binding unique index,
-- so a consumed challenge cannot be re-pointed at another user, company,
-- provider or protocol, and a proof cannot ride a challenge issued to
-- someone else. Session is deliberately excluded from that key — §9.1 step 4
-- lets the proof bind the FINAL session after a BA rotation. Consumption is
-- a status (`consumed_at`), the atomic conditional UPDATE of the store's
-- at-most-once port, never a deletion — which is what keeps the binding
-- pinnable and audit trail intact.
--
-- The challenge's session_id is HISTORICAL TEXT with no foreign key (T02.01
-- precedent: sessions are ephemeral, challenges are the record), so deleting
-- the rotated-away old session always succeeds and the challenge's lifecycle
-- rides only its user/tenant cascades; deleting the FINAL session cascades
-- its proofs, and the proof's revocation status is logical expiry, not a
-- guard against deleting an ephemeral session row (review r1, R1-F1). The
-- challenge's protocol and the proof's authentication_method are one fact
-- under two §9.1 spellings, enforced equal by the composite foreign key; P11
-- confirms the mapping before consuming the tables (review r1, R1-F3).
--
-- Version columns are bigint bounded to the safe-integer range
-- 0..9007199254740991 by CHECK and carry no default: a writer states the
-- generations it is issuing against. `(session_id, tenant_id)` is the §9.1
-- current-proof key — one ACTIVE proof per session per company, partial
-- unique index; history is revocation status, never a deletion. The
-- 600-second challenge ceiling and the proof's expiry-after-authentication
-- floor are CHECKs, not writer discipline.
--
-- Roles, RLS policies and the controlled write functions belong to
-- T02.06/P11; this migration grants nothing and revokes nothing, so the
-- legacy authority path keeps working unchanged.
CREATE TABLE "auth_company_auth_challenges" (
	"challenge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"protocol" text NOT NULL,
	"policy_revision" bigint NOT NULL,
	"return_path" text NOT NULL,
	"state_digest" text NOT NULL,
	"secret_envelope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_company_auth_challenge_pk" PRIMARY KEY("challenge_id")
);
--> statement-breakpoint
CREATE TABLE "auth_company_session_assurances" (
	"assurance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"challenge_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"authentication_method" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"strength" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"policy_revision" bigint NOT NULL,
	"identity_generation" bigint NOT NULL,
	"company_generation" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_company_session_assurance_pk" PRIMARY KEY("assurance_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_company_auth_challenge_state_uq" ON "auth_company_auth_challenges" USING btree ("state_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_company_auth_challenge_binding_uq" ON "auth_company_auth_challenges" USING btree ("challenge_id","user_id","tenant_id","provider_id","protocol");--> statement-breakpoint
CREATE INDEX "auth_company_auth_challenge_user_idx" ON "auth_company_auth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_company_auth_challenge_session_idx" ON "auth_company_auth_challenges" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_company_session_assurance_challenge_uq" ON "auth_company_session_assurances" USING btree ("challenge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_company_session_assurance_current_uq" ON "auth_company_session_assurances" USING btree ("session_id","tenant_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "auth_company_session_assurance_user_idx" ON "auth_company_session_assurances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_company_session_assurance_principal_idx" ON "auth_company_session_assurances" USING btree ("tenant_id","principal_id");--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_protocol" CHECK ("protocol" in ('oidc','saml'));--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_policy_revision_safe_integer" CHECK ("policy_revision" >= 0 and "policy_revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_max_age" CHECK ("expires_at" <= "created_at" + interval '600 seconds');--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_expires_after_creation" CHECK ("expires_at" > "created_at");--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_consumed_after_creation" CHECK ("consumed_at" is null or "consumed_at" >= "created_at");--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_authentication_method" CHECK ("authentication_method" in ('oidc','saml'));--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_status" CHECK ("status" in ('active','revoked'));--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_status_with_time" CHECK (("status" = 'active') = ("revoked_at" is null));--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_policy_revision_safe_integer" CHECK ("policy_revision" >= 0 and "policy_revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_identity_generation_safe_integer" CHECK ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_company_generation_safe_integer" CHECK ("company_generation" >= 0 and "company_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_expires_after_authentication" CHECK ("expires_at" > "authenticated_at");--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_auth_challenges" ADD CONSTRAINT "auth_company_auth_challenge_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_company_session_assurances" ADD CONSTRAINT "auth_company_session_assurance_challenge_fk" FOREIGN KEY ("challenge_id","user_id","tenant_id","provider_id","authentication_method") REFERENCES "public"."auth_company_auth_challenges"("challenge_id","user_id","tenant_id","provider_id","protocol") ON DELETE no action ON UPDATE no action;
