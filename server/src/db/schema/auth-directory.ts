/*
 * Better Auth directory tables and the stable business-ID mapping (T02.01 / #523,
 * original task P03; design §4.2 "recommended physical model", interfaces §1/§2).
 *
 * Two identities meet here and are deliberately kept apart:
 *
 * - The BA organization *is* the OpenBot tenant. `auth_organizations.id` is the
 *   existing `enterprise_tenants.id` (a foreign key, not a second generated id),
 *   so the BA organization plugin's `organizationId` is the business tenant id
 *   everywhere downstream and no crosswalk table is needed.
 * - A BA team id is a NEW global id. `enterprise_workspaces` is keyed by the
 *   *composite* (tenant_id, id): the same workspace id can legitimately exist in
 *   two companies, and a workspace id is therefore not globally unique. Reusing
 *   it as a team id would make "the team" ambiguous the moment a second company
 *   had the same workspace name/id — exactly the case the design calls out. The
 *   team id is server-generated and globally unique; `auth_team_bindings` maps it
 *   to the historical (tenant_id, workspace_id) pair, one-to-one, leaving every
 *   historical business foreign key untouched.
 *
 * The binding is immutable across companies at the database level, not just in
 * service code: `auth_team_bindings` carries a composite foreign key on
 * (team_id, tenant_id) pointing at `auth_teams (id, organization_id)`. Changing a
 * binding's tenant, or moving a bound team to another organization, has no
 * matching referenced row and is refused by the FK. Moving resources between
 * companies therefore needs the separate export/delivery flow, never an UPDATE.
 *
 * Every constraint is explicitly named so the typed schema, the generated DDL
 * and the migration agree by name, not by convention.
 *
 * The restricted-connection roles, the controlled functions, the DML guard
 * and the deferred constraint fences are T02.06's (migration
 * 0226_better_auth_schema_roles): ob_ent_auth_writer owns these tables end to
 * end and reaches projections/clocks/command receipts only through those
 * SECURITY DEFINER functions; the legacy writer of 0056 keeps its enterprise_*
 * rights until M4. They live in SQL, not here — this file stays the typed
 * tables, and grants nothing itself.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * The BA organization directory. `id` reuses `enterprise_tenants.id`: an
 * organization is the tenant, and a tenant is an organization. Business state
 * (status, payer, policyRevision, history) stays on `enterprise_tenants`; the
 * columns here are the directory profile BA owns and writes.
 */
export const authOrganizations = pgTable(
  "auth_organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** BA requires a globally unique slug. */
    slug: text("slug").notNull(),
    logo: text("logo"),
    /** BA's declared type is a string (a JSON document already serialized). */
    metadata: text("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_organization_slug_uq").on(table.slug),
    foreignKey({
      name: "auth_organization_tenant_fk",
      columns: [table.id],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
  ],
);

/**
 * The BA team directory: one row per workspace, with a globally unique id.
 *
 * The unique index on (id, organization_id) is the referenced side of the
 * binding's composite foreign key — it is what makes "a binding cannot move to
 * another company" a database fact.
 */
export const authTeams = pgTable(
  "auth_teams",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    /** BA 1.7.1 team schema: `input: false`, maintained by the plugin itself. */
    memberCount: integer("member_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_team_id_organization_uq").on(
      table.id,
      table.organizationId,
    ),
    index("auth_team_organization_idx").on(table.organizationId),
    check(
      "auth_team_member_count_non_negative",
      sql`${table.memberCount} >= 0`,
    ),
    foreignKey({
      name: "auth_team_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete("cascade"),
  ],
);

/**
 * The stable one-to-one mapping between a BA team and the historical business
 * workspace identity. `(tenant_id, workspace_id)` is the mapping key; `team_id`
 * is unique because one team backs exactly one workspace.
 *
 * The two composite foreign keys prove both halves in the database:
 * - (tenant_id, workspace_id) → enterprise_workspaces, so a binding can never
 *   point at a workspace of another company (or a workspace that does not exist);
 * - (team_id, tenant_id) → auth_teams (id, organization_id), so a binding can
 *   never point at a team of another company, and neither side can be re-pointed
 *   later without the FK refusing it.
 */
export const authTeamBindings = pgTable(
  "auth_team_bindings",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    teamId: text("team_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "auth_team_binding_pk",
      columns: [table.tenantId, table.workspaceId],
    }),
    uniqueIndex("auth_team_binding_team_uq").on(table.teamId),
    foreignKey({
      name: "auth_team_binding_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_binding_team_fk",
      columns: [table.teamId, table.tenantId],
      foreignColumns: [authTeams.id, authTeams.organizationId],
    }).onDelete("cascade"),
  ],
);

/**
 * Company membership (BA `member`). Unique per (organization, user) as the
 * design requires; business eligibility projections keep living in
 * `enterprise_memberships` and are derived in the same command transaction.
 */
export const authMembers = pgTable(
  "auth_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    /** BA default role; team management grants are a separate T02.04 model. */
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_member_organization_user_uq").on(
      table.organizationId,
      table.userId,
    ),
    index("auth_member_user_idx").on(table.userId),
    foreignKey({
      name: "auth_member_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_member_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Workspace membership (BA `teamMember`). Unique per (team, user). BA 1.7.1
 * additionally writes a digest `membershipKey` (unique when present), used by its
 * own add/remove helpers; it stays nullable to match the plugin declaration.
 *
 * The design's "a team member must be a member of the team's organization" is a
 * *final-state* invariant checked by the command finalizer in the same
 * transaction, not a CHECK here: BA legitimately creates the teamMember before
 * the member inside an invitation, and the executor defers the cross-row proof
 * to commit. The structural team/user uniqueness is enforced now.
 */
export const authTeamMembers = pgTable(
  "auth_team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    membershipKey: text("membership_key"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_team_member_team_user_uq").on(table.teamId, table.userId),
    uniqueIndex("auth_team_member_membership_key_uq").on(table.membershipKey),
    index("auth_team_member_user_idx").on(table.userId),
    foreignKey({
      name: "auth_team_member_team_fk",
      columns: [table.teamId],
      foreignColumns: [authTeams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_member_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Company/team invitations (BA `invitation`). A pending invitation grants no
 * eligibility; accepting one goes through the directory command executor.
 */
export const authInvitations = pgTable(
  "auth_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    teamId: text("team_id"),
    inviterId: text("inviter_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "auth_invitation_status",
      sql`${table.status} in ('pending','accepted','rejected','canceled')`,
    ),
    index("auth_invitation_organization_idx").on(table.organizationId),
    index("auth_invitation_email_idx").on(table.email),
    foreignKey({
      name: "auth_invitation_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_invitation_team_fk",
      columns: [table.teamId],
      foreignColumns: [authTeams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_invitation_inviter_fk",
      columns: [table.inviterId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

/*
 * The command model below (T02.03 / #525, original task P03; design §4.2
 * "事件与幂等", §5.2.1, §13.2; interfaces §2, §3.3) is the durable half of the
 * single-writer protocol: every directory/identity command leaves a receipt
 * with its idempotency (变更) key and payload hash, registers the relationship
 * keys it touched with their before/after versions, writes its notification
 * intents to the outbox, and advances the AuthorityState — all inside the
 * command's own transaction, so a rollback leaves none of it behind. The
 * finalizer (T02.08) and the commit fence (T02.06) are the writers; audit
 * joins the existing enterprise audit system rather than a new table here.
 */

/**
 * One row per committed directory or identity command: the event and
 * idempotency fact of design §4.2.
 *
 * The receipt domain decides the target: a company command targets its tenant,
 * an identity command its user (§5.6), never both and never neither — CHECKs
 * refuse the malformed shapes. The idempotency key is unique per domain target
 * (partial unique indexes): the same key under the same target with a
 * different payload hash is the 409 conflict of interfaces §4, while deciding
 * replay-vs-conflict from the stored hash is the executor's read, never a
 * second row.
 *
 * `finalized` is the command-finalization flag of §5.2.1: the finalizer sets
 * it with its timestamp before `SET CONSTRAINTS ... IMMEDIATE` lets the
 * transaction commit, and the flag exists exactly when the timestamp does.
 * Receipts deliberately keep NO ACTION foreign keys (no cascade): they are the
 * durable command history, so deleting a referenced user or tenant is refused
 * until the asset-handover/archive flows of §4.3 have dealt with the history,
 * rather than the history silently vanishing with its target.
 */
export const authCommandReceipts = pgTable(
  "auth_command_receipts",
  {
    commandId: text("command_id").notNull(),
    /** company: a Directory command on one tenant; identity: a global identity command. */
    domain: text("domain").notNull(),
    /** The operation name (DirectoryOperation / identity §2.1); the payload union is executor-side Zod. */
    operation: text("operation").notNull(),
    /** The company-domain target. NULL iff the domain is identity. */
    tenantId: text("tenant_id"),
    /** The identity-domain target user. NULL iff the domain is company. */
    targetUserId: text("target_user_id"),
    /**
     * The command's idempotency (变更) key, from the server-issued envelope —
     * unique per domain target, and bound on the receipt to the actor and the
     * payload hash for the replay/conflict comparison.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The envelope payload's digest; a different hash under the same key is a conflict. */
    payloadHash: text("payload_hash").notNull(),
    actorUserId: text("actor_user_id"),
    actorPrincipalId: text("actor_principal_id"),
    /** The session that authenticated the actor — historical text, no FK: sessions are ephemeral, receipts are not. */
    actorSessionId: text("actor_session_id"),
    actorKind: text("actor_kind").notNull(),
    /** The verified provisioning binding a scim/jit actor came through. */
    actorBindingId: text("actor_binding_id"),
    /** The provisioning rule provenance of a scim/jit actor, when one applies. */
    actorProvisioning: jsonb("actor_provisioning"),
    /** The DirectoryResult identity fields (interfaces §2). */
    workspaceId: text("workspace_id"),
    resourceId: text("resource_id"),
    grantId: text("grant_id"),
    grantGeneration: bigint("grant_generation", { mode: "number" }),
    /** Set by the command finalizer inside the command transaction (§5.2.1). */
    finalized: boolean("finalized").notNull().default(false),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "auth_command_receipt_pk",
      columns: [table.commandId],
    }),
    uniqueIndex("auth_command_receipt_company_idempotency_uq")
      .on(table.tenantId, table.idempotencyKey)
      .where(sql`${table.domain} = 'company'`),
    uniqueIndex("auth_command_receipt_identity_idempotency_uq")
      .on(table.targetUserId, table.idempotencyKey)
      .where(sql`${table.domain} = 'identity'`),
    check(
      "auth_command_receipt_domain",
      sql`${table.domain} in ('company','identity')`,
    ),
    check(
      "auth_command_receipt_company_target",
      sql`(${table.domain} = 'company') = (${table.tenantId} is not null)`,
    ),
    check(
      "auth_command_receipt_identity_target",
      sql`(${table.domain} = 'identity') = (${table.targetUserId} is not null)`,
    ),
    // The closed actor kinds of interfaces §2/§2.1 — plus identity's recovery
    // actor. There is no impersonation kind to accept (design §6.3).
    check(
      "auth_command_receipt_actor_kind",
      sql`${table.actorKind} in ('session','platform','scim','jit','migration','recovery')`,
    ),
    check(
      "auth_command_receipt_finalized_with_time",
      sql`${table.finalized} = (${table.finalizedAt} is not null)`,
    ),
    check(
      "auth_command_receipt_grant_generation_safe_integer",
      sql`${table.grantGeneration} is null or (${table.grantGeneration} >= 0 and ${table.grantGeneration} <= 9007199254740991)`,
    ),
    foreignKey({
      name: "auth_command_receipt_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      name: "auth_command_receipt_user_fk",
      columns: [table.targetUserId],
      foreignColumns: [users.id],
    }),
  ],
);

/**
 * The relationship keys a command registered touching, with the versions
 * before and after it (design §5.2.1: "语句级登记变更、命令最终状态校验").
 *
 * The key is the stable eligibility key of the clocks — never a BA member id —
 * and it is deliberately NOT a foreign key into `auth_eligibility_clocks`: the
 * registry row is written at DML time, before the clock exists or advances,
 * and the commit fence (T02.06) reads it to prove every registered key was
 * finalized inside the command. Before-versions are nullable: a newly
 * established relationship had no prior clock. After-versions are the safe
 * integers of interfaces §2, bounded like every new version column.
 */
export const authCommandChangeKeys = pgTable(
  "auth_command_change_keys",
  {
    commandId: text("command_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** The eligibility domain the command touched: company membership or one team. */
    kind: text("kind").notNull(),
    /** The scope the kind names; a company key's scope IS its tenant. */
    scopeId: text("scope_id").notNull(),
    epochBefore: bigint("epoch_before", { mode: "number" }),
    generationBefore: bigint("generation_before", { mode: "number" }),
    epochAfter: bigint("epoch_after", { mode: "number" }).notNull(),
    generationAfter: bigint("generation_after", { mode: "number" }).notNull(),
    /** The per-key half of the finalization proof the commit fence checks. */
    finalized: boolean("finalized").notNull().default(false),
  },
  (table) => [
    primaryKey({
      name: "auth_command_change_key_pk",
      columns: [
        table.commandId,
        table.tenantId,
        table.principalId,
        table.kind,
        table.scopeId,
      ],
    }),
    check(
      "auth_command_change_key_kind",
      sql`${table.kind} in ('company','team')`,
    ),
    check(
      "auth_command_change_key_scope_matches_kind",
      sql`(${table.kind} <> 'company' or ${table.scopeId} = ${table.tenantId})`,
    ),
    check(
      "auth_command_change_key_epoch_before_safe_integer",
      sql`${table.epochBefore} is null or (${table.epochBefore} >= 0 and ${table.epochBefore} <= 9007199254740991)`,
    ),
    check(
      "auth_command_change_key_generation_before_safe_integer",
      sql`${table.generationBefore} is null or (${table.generationBefore} >= 0 and ${table.generationBefore} <= 9007199254740991)`,
    ),
    check(
      "auth_command_change_key_epoch_after_safe_integer",
      sql`${table.epochAfter} >= 0 and ${table.epochAfter} <= 9007199254740991`,
    ),
    check(
      "auth_command_change_key_generation_after_safe_integer",
      sql`${table.generationAfter} >= 0 and ${table.generationAfter} <= 9007199254740991`,
    ),
    foreignKey({
      name: "auth_command_change_key_command_fk",
      columns: [table.commandId],
      foreignColumns: [authCommandReceipts.commandId],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_command_change_key_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_command_change_key_principal_fk",
      columns: [table.principalId],
      foreignColumns: [enterprisePrincipals.id],
    }).onDelete("cascade"),
  ],
);

/**
 * The transactional outbox: notification intents (invitation emails, webhook
 * fan-out, §5.2 step 5) are written beside their command and only delivered
 * after the commit — the plugin never sends inside the outer transaction.
 *
 * `kind` names the intent's converter (the taxonomy and the encrypted payload
 * format are T02.12's); `status` is the closed delivery state, with delivered
 * existing exactly when its timestamp does. Delivery completion may clean up
 * delivery state but never deletes the clock or tombstone facts beside it.
 */
export const authCommandOutbox = pgTable(
  "auth_command_outbox",
  {
    id: text("id").notNull(),
    commandId: text("command_id").notNull(),
    kind: text("kind").notNull(),
    /** Opaque intent payload; sensitive intents are encrypted by their converter (T02.12). */
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "auth_command_outbox_pk",
      columns: [table.id],
    }),
    index("auth_command_outbox_status_idx").on(table.status),
    check(
      "auth_command_outbox_status",
      sql`${table.status} in ('pending','delivered','failed')`,
    ),
    check(
      "auth_command_outbox_delivered_with_time",
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} is not null)`,
    ),
    foreignKey({
      name: "auth_command_outbox_command_fk",
      columns: [table.commandId],
      foreignColumns: [authCommandReceipts.commandId],
    }).onDelete("cascade"),
  ],
);

/**
 * The persistent AuthorityState of interfaces §3.3 — exactly one row, seeded
 * by the expand migration at the M1 milestone with legacy directory authority
 * and the multi-tenant release still closed (design §13.2).
 *
 * Phase and directoryAuthority are closed domains kept consistent with the
 * migration state machine (M0/M1 legacy, M2/M3 paused, M4..M7 ba), so an
 * impossible pair cannot be stored. The two gates stay independent columns on
 * purpose: the release gate (M5/M6) never selects the authority, and the
 * authority CAS (M4) never releases. `authority_version` is the CAS counter
 * the M4 switch compares in-transaction; a missing row is never guessed as
 * legacy by the gates (T02.10) — which is why the migration seeds it.
 */
export const authAuthorityStates = pgTable(
  "auth_authority_states",
  {
    /** Fixed at 1: the primary key plus the singleton CHECK make exactly one row storable. */
    id: integer("id").notNull().default(1),
    authorityVersion: bigint("authority_version", { mode: "number" }).notNull(),
    phase: text("phase").notNull(),
    directoryAuthority: text("directory_authority").notNull(),
    multiTenantReleased: boolean("multi_tenant_released")
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "auth_authority_state_pk",
      columns: [table.id],
    }),
    check("auth_authority_state_singleton", sql`${table.id} = 1`),
    check(
      "auth_authority_state_phase",
      sql`${table.phase} in ('M0','M1','M2','M3','M4','M5','M6','M7')`,
    ),
    check(
      "auth_authority_state_directory_authority",
      sql`${table.directoryAuthority} in ('legacy','paused','ba')`,
    ),
    check(
      "auth_authority_state_phase_matches_authority",
      sql`((${table.phase} in ('M0','M1') and ${table.directoryAuthority} = 'legacy') or (${table.phase} in ('M2','M3') and ${table.directoryAuthority} = 'paused') or (${table.phase} in ('M4','M5','M6','M7') and ${table.directoryAuthority} = 'ba'))`,
    ),
    check(
      "auth_authority_state_version_safe_integer",
      sql`${table.authorityVersion} >= 0 and ${table.authorityVersion} <= 9007199254740991`,
    ),
  ],
);

/*
 * The authority-source models below (T02.04 / #526, original task P03; design
 * §4.2 "指定团队管理授权"/"Provisioning 规则", §4.4, §6.4; interfaces §3) are
 * the durable halves of the two delegated team-member-management authorities.
 * The company-role authority needs no row — it is re-verified live against the
 * actor's current owner/admin role — but a team management Grant and a
 * provisioning rule are long-lived facts that must carry the versions they
 * were issued against, so revoking a membership or advancing a rule revision
 * makes the stored authority stale by comparison, not by a sweep.
 *
 * Both tables store the *stable business* identities (tenant/workspace/
 * principal, the BA team id the binding pins) and the eligibility generations
 * of design §4.4, never a BA member id. Actions and fixed teams are closed
 * domains: nobody can store a delegation for an action that does not exist or
 * an empty target set. Roles, RLS policies and the controlled write commands
 * belong to T02.06/T02.09 and P09; this file adds only the expand-stage
 * tables, grants nothing and revokes nothing.
 */

/**
 * One explicit team-member-management delegation (design §6.4): a company
 * owner/admin grants an existing company member the fixed member-management
 * actions on ONE team. The grant carries the grantee's identity/company/team
 * generations at grant time (design §4.4: 适用授权保存签发时的代际并在使用时
 * 比较) plus its own `generation` — the TeamCommandAuthority "team-grant"
 * branch compares that generation, and a revoke, a资格失效 or a re-grant with
 * a new generation makes an old capability un-consumable.
 *
 * The grantee and the grantor are principals of THIS company by composite
 * foreign keys into `enterprise_memberships` — a cross-company grant is
 * structurally impossible, not merely refused by a service. The team is pinned
 * the same way `auth_team_bindings` is: (team_id, tenant_id) → auth_teams
 * (id, organization_id), so a grant cannot name another company's team, and
 * (tenant_id, workspace_id) → enterprise_workspaces keeps the business id
 * stable even where the same workspace id exists in two companies.
 *
 * Revocation is a status, never a deletion — the same discipline
 * `access_grants` follows. The revoking actor and reason live in the command
 * receipt of `team.management.revoke` (T02.03's model records actor fields),
 * which is why this row stores no revoker column of its own.
 */
export const authTeamManagementGrants = pgTable(
  "auth_team_management_grants",
  {
    grantId: text("grant_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** The business workspace the delegation is scoped to; the P09 route's path id. */
    workspaceId: text("workspace_id").notNull(),
    /** The bound BA team of that workspace — pinned by the composite FK below. */
    teamId: text("team_id").notNull(),
    /** The delegated-to principal: a stable business id, never a BA member id. */
    principalId: text("principal_id").notNull(),
    /**
     * The nonempty deduplicated subset of the closed action domain. Dedup is
     * provable in a CHECK because the domain has two members: the cardinality
     * equals the count of distinct closed-set flags the array contains, so a
     * duplicate cannot satisfy both.
     */
    actions: text("actions").array().notNull(),
    /** The grant's own version: re-grant produces a new generation (§6.4). */
    generation: bigint("generation", { mode: "number" }).notNull(),
    /** The grantee's identity generation at grant time (design §4.4). */
    identityGeneration: bigint("identity_generation", {
      mode: "number",
    }).notNull(),
    /** The grantee's company-eligibility generation at grant time. */
    companyGeneration: bigint("company_generation", {
      mode: "number",
    }).notNull(),
    /** The grantee's team-eligibility generation at grant time. */
    teamGeneration: bigint("team_generation", { mode: "number" }).notNull(),
    /** The principal that issued the grant — provably a member of this company. */
    grantedBy: text("granted_by").notNull(),
    /** `active` until `team.management.revoke` revokes it; a status, never a deletion. */
    status: text("status").notNull().default("active"),
    /** Null while active; the moment of revocation, forever after. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "auth_team_management_grant_actions",
      sql`${table.actions} <@ array['team.member.add','team.member.remove']::text[] and cardinality(${table.actions}) between 1 and 2 and cardinality(${table.actions}) = ((case when 'team.member.add' = any(${table.actions}) then 1 else 0 end) + (case when 'team.member.remove' = any(${table.actions}) then 1 else 0 end))`,
    ),
    check(
      "auth_team_management_grant_status",
      sql`${table.status} in ('active','revoked')`,
    ),
    check(
      "auth_team_management_grant_status_with_time",
      sql`(${table.status} = 'active') = (${table.revokedAt} is null)`,
    ),
    check(
      "auth_team_management_grant_generation_safe_integer",
      sql`${table.generation} >= 0 and ${table.generation} <= 9007199254740991`,
    ),
    check(
      "auth_team_management_grant_identity_generation_safe_integer",
      sql`${table.identityGeneration} >= 0 and ${table.identityGeneration} <= 9007199254740991`,
    ),
    check(
      "auth_team_management_grant_company_generation_safe_integer",
      sql`${table.companyGeneration} >= 0 and ${table.companyGeneration} <= 9007199254740991`,
    ),
    check(
      "auth_team_management_grant_team_generation_safe_integer",
      sql`${table.teamGeneration} >= 0 and ${table.teamGeneration} <= 9007199254740991`,
    ),
    index("auth_team_management_grant_workspace_idx").on(
      table.tenantId,
      table.workspaceId,
    ),
    index("auth_team_management_grant_principal_idx").on(
      table.tenantId,
      table.principalId,
    ),
    foreignKey({
      name: "auth_team_management_grant_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_management_grant_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_management_grant_team_fk",
      columns: [table.teamId, table.tenantId],
      foreignColumns: [authTeams.id, authTeams.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_management_grant_principal_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_team_management_grant_grantor_fk",
      columns: [table.tenantId, table.grantedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
  ],
);

/**
 * One approved provisioning rule (design §6.4, interfaces §3): the standing
 * authority a verified SCIM/JIT binding's events consume to add or remove team
 * members. A rule names its binding, its company, the external group it
 * matches (NULL = the binding's company admission condition) and the FIXED
 * workspace targets; `minimum_role` records the floor the interface pins at
 * member.
 *
 * The rule identity is stable per (binding, external group) — the two partial
 * unique indexes, one for a named group and one for the binding-wide NULL
 * case — so re-approving the same pair must UPDATE this row's revision under
 * the tenant lock (design §3: 变更固定目标或批准状态推进 revision，旧能力不可
 * 复用), never grow a second authority beside it. An event may consume only
 * the current approved revision; `revision` is the safe-integer counter the
 * TeamCommandAuthority "provisioning-rule" branch compares.
 *
 * The binding table itself does not exist yet (T02.04 owns only the rule row,
 * the approved binding registry is a later task's), so `binding_id` is plain
 * text here — the binding/company coupling is enforced where bindings are
 * registered, exactly as `auth_command_receipts.actor_binding_id` is.
 */
export const authProvisioningRules = pgTable(
  "auth_provisioning_rules",
  {
    ruleId: text("rule_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** The verified provisioning binding this rule hangs on (registry is a later task). */
    bindingId: text("binding_id").notNull(),
    /** The external group the rule matches; NULL means the binding's company admission condition. */
    externalGroup: text("external_group"),
    /** The fixed, nonempty workspace targets an event may touch. */
    workspaceIds: text("workspace_ids").array().notNull(),
    /** The minimum company role a provisioned member receives; the interface pins member. */
    minimumRole: text("minimum_role").notNull().default("member"),
    /** Advanced by approve/re-target/revoke inside the tenant lock; old capabilities cannot be reused. */
    revision: bigint("revision", { mode: "number" }).notNull(),
    /** An event may consume only an approved current rule; revocation is a status. */
    status: text("status").notNull().default("approved"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_provisioning_rule_binding_group_uq")
      .on(table.bindingId, table.externalGroup)
      .where(sql`${table.externalGroup} is not null`),
    uniqueIndex("auth_provisioning_rule_binding_wide_uq")
      .on(table.bindingId)
      .where(sql`${table.externalGroup} is null`),
    check(
      "auth_provisioning_rule_workspace_ids_nonempty",
      sql`cardinality(${table.workspaceIds}) >= 1`,
    ),
    check(
      "auth_provisioning_rule_minimum_role",
      sql`${table.minimumRole} in ('owner','admin','member')`,
    ),
    check(
      "auth_provisioning_rule_status",
      sql`${table.status} in ('approved','revoked')`,
    ),
    check(
      "auth_provisioning_rule_status_with_time",
      sql`(${table.status} = 'approved') = (${table.revokedAt} is null)`,
    ),
    check(
      "auth_provisioning_rule_revision_safe_integer",
      sql`${table.revision} >= 0 and ${table.revision} <= 9007199254740991`,
    ),
    index("auth_provisioning_rule_tenant_idx").on(table.tenantId),
    foreignKey({
      name: "auth_provisioning_rule_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
  ],
);
