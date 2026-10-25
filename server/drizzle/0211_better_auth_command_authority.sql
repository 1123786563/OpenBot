-- T02.03 (#525, P03): the command finalization, authority and outbox model
-- (design §4.2 "事件与幂等", §5.2.1, §13.2; interfaces §2, §3.3).
--
-- Expand only (M1): four new tables plus the seeded AuthorityState row, no
-- existing column/constraint/index/privilege is touched. The receipt's
-- idempotency (变更) key is unique per company/identity domain target through
-- two partial unique indexes, so the same key with a different payload hash is
-- refused (SQLSTATE 23505, the 409 conflict of interfaces §4). Change keys
-- carry the before/after versions of every affected relationship and their own
-- finalization flag for the T02.06 commit fence; outbox rows live and die with
-- their command. The authority row is seeded at the M1 milestone with legacy
-- directory authority and the multi-tenant release closed — the two gates stay
-- independent columns (§13.2: M5/M6 only change the release).
--
-- Roles, RLS policies and controlled-function grants are T02.06's migration;
-- this one grants nothing and revokes nothing, so legacy authority keeps
-- working. The seed makes the state a fact the gates read (T02.10: a missing
-- state is never guessed as legacy).
CREATE TABLE "auth_command_receipts" (
	"command_id" text NOT NULL,
	"domain" text NOT NULL,
	"operation" text NOT NULL,
	"tenant_id" text,
	"target_user_id" text,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"actor_user_id" text,
	"actor_principal_id" text,
	"actor_session_id" text,
	"actor_kind" text NOT NULL,
	"actor_binding_id" text,
	"actor_provisioning" jsonb,
	"workspace_id" text,
	"resource_id" text,
	"grant_id" text,
	"grant_generation" bigint,
	"finalized" boolean DEFAULT false NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_command_receipt_pk" PRIMARY KEY("command_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_command_receipt_company_idempotency_uq" ON "auth_command_receipts" USING btree ("tenant_id","idempotency_key") WHERE "auth_command_receipts"."domain" = 'company';--> statement-breakpoint
CREATE UNIQUE INDEX "auth_command_receipt_identity_idempotency_uq" ON "auth_command_receipts" USING btree ("target_user_id","idempotency_key") WHERE "auth_command_receipts"."domain" = 'identity';--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_domain" CHECK ("domain" in ('company','identity'));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_company_target" CHECK (("domain" = 'company') = ("tenant_id" is not null));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_identity_target" CHECK (("domain" = 'identity') = ("target_user_id" is not null));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_actor_kind" CHECK ("actor_kind" in ('session','platform','scim','jit','migration','recovery'));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_finalized_with_time" CHECK ("finalized" = ("finalized_at" is not null));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_grant_generation_safe_integer" CHECK ("grant_generation" is null or ("grant_generation" >= 0 and "grant_generation" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_command_receipts" ADD CONSTRAINT "auth_command_receipt_user_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_command_change_keys" (
	"command_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"epoch_before" bigint,
	"generation_before" bigint,
	"epoch_after" bigint NOT NULL,
	"generation_after" bigint NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	CONSTRAINT "auth_command_change_key_pk" PRIMARY KEY("command_id","tenant_id","principal_id","kind","scope_id")
);
--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_kind" CHECK ("kind" in ('company','team'));--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_scope_matches_kind" CHECK (("kind" <> 'company' or "scope_id" = "tenant_id"));--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_epoch_before_safe_integer" CHECK ("epoch_before" is null or ("epoch_before" >= 0 and "epoch_before" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_generation_before_safe_integer" CHECK ("generation_before" is null or ("generation_before" >= 0 and "generation_before" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_epoch_after_safe_integer" CHECK ("epoch_after" >= 0 and "epoch_after" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_generation_after_safe_integer" CHECK ("generation_after" >= 0 and "generation_after" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_command_fk" FOREIGN KEY ("command_id") REFERENCES "public"."auth_command_receipts"("command_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_command_change_keys" ADD CONSTRAINT "auth_command_change_key_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_command_outbox" (
	"id" text NOT NULL,
	"command_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_command_outbox_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE INDEX "auth_command_outbox_status_idx" ON "auth_command_outbox" USING btree ("status");--> statement-breakpoint
ALTER TABLE "auth_command_outbox" ADD CONSTRAINT "auth_command_outbox_status" CHECK ("status" in ('pending','delivered','failed'));--> statement-breakpoint
ALTER TABLE "auth_command_outbox" ADD CONSTRAINT "auth_command_outbox_delivered_with_time" CHECK (("status" = 'delivered') = ("delivered_at" is not null));--> statement-breakpoint
ALTER TABLE "auth_command_outbox" ADD CONSTRAINT "auth_command_outbox_command_fk" FOREIGN KEY ("command_id") REFERENCES "public"."auth_command_receipts"("command_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_authority_states" (
	"id" integer DEFAULT 1 NOT NULL,
	"authority_version" bigint NOT NULL,
	"phase" text NOT NULL,
	"directory_authority" text NOT NULL,
	"multi_tenant_released" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_authority_state_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "auth_authority_states" ADD CONSTRAINT "auth_authority_state_singleton" CHECK ("id" = 1);--> statement-breakpoint
ALTER TABLE "auth_authority_states" ADD CONSTRAINT "auth_authority_state_phase" CHECK ("phase" in ('M0','M1','M2','M3','M4','M5','M6','M7'));--> statement-breakpoint
ALTER TABLE "auth_authority_states" ADD CONSTRAINT "auth_authority_state_directory_authority" CHECK ("directory_authority" in ('legacy','paused','ba'));--> statement-breakpoint
ALTER TABLE "auth_authority_states" ADD CONSTRAINT "auth_authority_state_phase_matches_authority" CHECK ((("phase" in ('M0','M1') and "directory_authority" = 'legacy') or ("phase" in ('M2','M3') and "directory_authority" = 'paused') or ("phase" in ('M4','M5','M6','M7') and "directory_authority" = 'ba')));--> statement-breakpoint
ALTER TABLE "auth_authority_states" ADD CONSTRAINT "auth_authority_state_version_safe_integer" CHECK ("authority_version" >= 0 and "authority_version" <= 9007199254740991);--> statement-breakpoint
INSERT INTO "auth_authority_states" ("id","authority_version","phase","directory_authority","multi_tenant_released") VALUES (1,0,'M1','legacy',false) ON CONFLICT ("id") DO NOTHING;
