-- T02.01 (#523, P03): the Better Auth directory tables and the stable
-- business-ID mapping (design §4.2, interfaces §1/§2).
--
-- Expand only (M1): new tables, no existing column/constraint/index/privilege
-- is touched. The BA organization reuses enterprise_tenants.id; a BA team gets a
-- new global id and auth_team_bindings maps it one-to-one onto the historical
-- composite workspace identity. The composite FK
-- auth_team_binding_team_fk (team_id, tenant_id) -> auth_teams (id,
-- organization_id) is what makes a binding immovable between companies at the
-- database level. Historical business foreign keys stay exactly as they are.
--
-- Roles, RLS policies and controlled-function grants are T02.06's migration;
-- this one grants nothing and revokes nothing, so legacy authority keeps working.
CREATE TABLE "auth_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_organization_slug_uq" ON "auth_organizations" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "auth_organizations" ADD CONSTRAINT "auth_organization_tenant_fk" FOREIGN KEY ("id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_team_id_organization_uq" ON "auth_teams" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "auth_team_organization_idx" ON "auth_teams" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "auth_teams" ADD CONSTRAINT "auth_team_member_count_non_negative" CHECK ("member_count" >= 0);--> statement-breakpoint
ALTER TABLE "auth_teams" ADD CONSTRAINT "auth_team_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_team_bindings" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_team_binding_pk" PRIMARY KEY("tenant_id","workspace_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_team_binding_team_uq" ON "auth_team_bindings" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "auth_team_bindings" ADD CONSTRAINT "auth_team_binding_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_bindings" ADD CONSTRAINT "auth_team_binding_team_fk" FOREIGN KEY ("team_id","tenant_id") REFERENCES "public"."auth_teams"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_member_organization_user_uq" ON "auth_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "auth_member_user_idx" ON "auth_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_members" ADD CONSTRAINT "auth_member_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_members" ADD CONSTRAINT "auth_member_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"membership_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_team_member_team_user_uq" ON "auth_team_members" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_team_member_membership_key_uq" ON "auth_team_members" USING btree ("membership_key");--> statement-breakpoint
CREATE INDEX "auth_team_member_user_idx" ON "auth_team_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_team_members" ADD CONSTRAINT "auth_team_member_team_fk" FOREIGN KEY ("team_id") REFERENCES "public"."auth_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_members" ADD CONSTRAINT "auth_team_member_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"team_id" text,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_invitation_organization_idx" ON "auth_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "auth_invitation_email_idx" ON "auth_invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitation_status" CHECK ("status" in ('pending','accepted','rejected','canceled'));--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitation_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."auth_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitation_team_fk" FOREIGN KEY ("team_id") REFERENCES "public"."auth_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitation_inviter_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
