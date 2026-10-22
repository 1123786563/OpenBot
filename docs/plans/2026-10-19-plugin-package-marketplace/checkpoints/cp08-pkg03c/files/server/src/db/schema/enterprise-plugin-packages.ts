import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enterpriseBotOwnership } from "./enterprise-bot-ownership";
import { enterprisePluginInstalls } from "./enterprise-plugins";
import { enterpriseRuns } from "./enterprise-runs";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

/**
 * PKG02 (#461): tenant/workspace plugin-package install storage.
 *
 * Five append-friendly tables, all tenant-scoped and team-scoped:
 *
 *   1. enterprise_package_installs — one row per (tenant, workspace,
 *      package_key). `revision`/`generation` are CAS counters; uninstall is a
 *      tombstone status, never a delete. Compound FKs prove the tenant, the
 *      team and the installing membership all live in the same company.
 *   2. enterprise_package_revisions — immutable per-revision facts (release
 *      version, artifact digest, closed non-secret config). Append-only: the
 *      operator role has SELECT/INSERT, no UPDATE/DELETE.
 *   3. enterprise_package_plans — a 10-minute preview bound to actor,
 *      principal, team, operation, release and canonical input digest. The
 *      apply transaction consumes it (UPDATE) and stores the result.
 *   4. enterprise_package_resource_links — the resources a revision links.
 *      A managed connector reference is a compound FK into the MT031 (#74)
 *      connector install table — there is no parallel connector table and no
 *      copy of the connector secret. Kind-specific CHECKs keep the three
 *      reference columns mutually exclusive.
 *   5. enterprise_package_changes — append-only change receipts. A non-empty
 *      idempotency key is unique per (tenant, workspace, actor).
 *   6. enterprise_package_grants (PKG03A) — per-Bot skill grants of an
 *      install, recorded per grant cycle (generation). The grant revision is
 *      the count of distinct cycles; revocation supersedes with a new cycle
 *      instead of deleting. FK (tenant, bot) pins the tenancy Bot-ownership
 *      authority; FK (tenant, workspace, install) pins the install.
 *
 * The authoritative DDL is the `PKG02` task in
 * server/scripts/multitenancy/migrate-test.ts (the MT031 out-of-band track):
 * the drizzle snapshots are stale, so this file is the typed/query-visible
 * mirror, not a `drizzle-kit generate` source. The store and service layers
 * import these tables; they never create them.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * jsonb passed to the driver verbatim (no JSON.stringify), same rationale as
 * enterprise-plugins.ts: Bun SQL JSON-encodes jsonb params itself.
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

/**
 * No secret-carrier key at ANY depth. The top-level `?|` probe this replaces
 * only saw root keys, so `{"nested": {"token": "…"}}` passed the old CHECK.
 * `$.**` covers the root object, nested objects and objects inside arrays;
 * `keyvalue()` then exposes each member name to the regex.
 */
const NO_NESTED_SECRET_CARRIERS_SQL =
  '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$")';

function noNestedSecretCarriers(column: AnyPgColumn) {
  return sql`not jsonb_path_exists(${column}, ${sql.raw(`'${NO_NESTED_SECRET_CARRIERS_SQL}'`)})`;
}

/** A package install: one row per (tenant, workspace, package_key). */
export const enterprisePackageInstalls = pgTable(
  "enterprise_package_installs",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** Canonical `publisher/name`. */
    packageKey: text("package_key").notNull(),
    /** The release the install currently points at. */
    currentVersion: text("current_version").notNull(),
    /** 'enabled' | 'disabled' | 'uninstalled' (tombstone, never a delete). */
    status: text("status").notNull().default("enabled"),
    /** Reinstall/uninstall generation; strictly positive. */
    generation: integer("generation").notNull().default(1),
    /** Current revision; strictly positive, CAS compare target. */
    revision: integer("revision").notNull().default(1),
    installedBy: text("installed_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    uniqueIndex("enterprise_package_install_scope_key_uq").on(
      table.tenantId,
      table.workspaceId,
      table.packageKey,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_package_install_status",
      sql`${table.status} in ('enabled', 'disabled', 'uninstalled')`,
    ),
    check(
      "enterprise_package_install_counters",
      sql`${table.generation} > 0 and ${table.revision} > 0`,
    ),
    check(
      "enterprise_package_install_package_key",
      sql`char_length(${table.packageKey}) between 3 and 129 and ${table.packageKey} like '%/%'`,
    ),
    pgPolicy("enterprise_package_install_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_package_install_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_install_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_install_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** Immutable revision facts: version/digest/config pin per install revision. */
export const enterprisePackageRevisions = pgTable(
  "enterprise_package_revisions",
  {
    tenantId: text("tenant_id").notNull(),
    installId: text("install_id").notNull(),
    revision: integer("revision").notNull(),
    releaseVersion: text("release_version").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    /** Closed, non-secret config (module + storage both refuse secrets). */
    config: jsonbDocument("config").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.installId, table.revision],
    }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installId],
      foreignColumns: [
        enterprisePackageInstalls.tenantId,
        enterprisePackageInstalls.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check("enterprise_package_revision_positive", sql`${table.revision} > 0`),
    check(
      "enterprise_package_revision_digest",
      sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_package_revision_config_shape",
      sql`jsonb_typeof(${table.config}) = 'object' and ${noNestedSecretCarriers(table.config)}`,
    ),
    pgPolicy("enterprise_package_revision_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and exists (select 1 from enterprise_package_installs i where i.tenant_id = ${table.tenantId} and i.id = ${table.installId} and i.workspace_id = nullif(current_setting('app.workspace_id', true), ''))`,
    }),
    pgPolicy("enterprise_package_revision_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_revision_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** A 10-minute install preview, bound to its actor and canonical input. */
export const enterprisePackagePlans = pgTable(
  "enterprise_package_plans",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** Signed-in user that created the plan. */
    actorId: text("actor_id").notNull(),
    /** Company principal that created the plan. */
    principalId: text("principal_id").notNull(),
    /** Closed operation vocabulary; PKG02 only writes 'install'. */
    operation: text("operation").notNull(),
    packageKey: text("package_key").notNull(),
    version: text("version").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    /** null = first install; non-null is a CAS target (PKG06+). */
    expectedRevision: integer("expected_revision"),
    canonicalInput: jsonbDocument("canonical_input").notNull(),
    inputDigest: text("input_digest").notNull(),
    preview: jsonbDocument("preview").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    result: jsonbDocument("result"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_package_plan_operation",
      sql`${table.operation} in ('install', 'upgrade', 'rollback')`,
    ),
    check(
      "enterprise_package_plan_expected_revision",
      sql`${table.expectedRevision} is null or ${table.expectedRevision} > 0`,
    ),
    check(
      "enterprise_package_plan_actor_shape",
      sql`char_length(${table.actorId}) between 1 and 128 and char_length(${table.principalId}) between 1 and 128`,
    ),
    check(
      "enterprise_package_plan_digests",
      sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$' and ${table.inputDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_package_plan_input_shape",
      sql`jsonb_typeof(${table.canonicalInput}) = 'object' and ${noNestedSecretCarriers(table.canonicalInput)}`,
    ),
    // Retention: plan rows are write-once previews; V1 keeps every row for
    // audit (the expiry index below supports a future owner-level cleanup,
    // e.g. `DELETE … WHERE expires_at < now() - interval '1 day'`). No
    // automatic GC in V1 — the cleanup task is deployment/ops scope (PKG11/12).
    index("enterprise_package_plan_expiry_idx").on(
      table.tenantId,
      table.expiresAt,
    ),
    pgPolicy("enterprise_package_plan_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_package_plan_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_plan_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_plan_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * Resources linked to one immutable revision. A managed-connector row proves
 * the referenced connection belongs to the same tenant AND team (compound FK
 * into the MT031 install table); it never copies a connector secret.
 */
export const enterprisePackageResourceLinks = pgTable(
  "enterprise_package_resource_links",
  {
    tenantId: text("tenant_id").notNull(),
    installId: text("install_id").notNull(),
    revision: integer("revision").notNull(),
    resourceId: text("resource_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    /** Legacy migration only; PKG02 writes NULL for every kind. */
    existingSkillId: text("existing_skill_id"),
    /** MT031 (#74) connector install reference (connector kind only). */
    connectorInstallId: text("connector_install_id"),
    /** `publisher/name/resourceId` reference (expert-template kind only). */
    expertTemplateRef: text("expert_template_ref"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "enterprise_package_link_pk",
      columns: [
        table.tenantId,
        table.installId,
        table.revision,
        table.resourceId,
      ],
    }),
    foreignKey({
      name: "enterprise_package_link_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_package_link_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_package_link_revision_fk",
      columns: [table.tenantId, table.installId, table.revision],
      foreignColumns: [
        enterprisePackageRevisions.tenantId,
        enterprisePackageRevisions.installId,
        enterprisePackageRevisions.revision,
      ],
    }).onDelete("cascade"),
    // The MT031 connector authority. PKG02 adds the (tenant, workspace, id)
    // unique index this reference needs; there is no second connector table.
    foreignKey({
      name: "enterprise_package_link_connector_fk",
      columns: [table.tenantId, table.workspaceId, table.connectorInstallId],
      foreignColumns: [
        enterprisePluginInstalls.tenantId,
        enterprisePluginInstalls.workspaceId,
        enterprisePluginInstalls.id,
      ],
    }).onDelete("restrict"),
    check(
      "enterprise_package_link_kind",
      sql`${table.kind} in ('skill', 'expertTemplate', 'managedConnector')`,
    ),
    check(
      "enterprise_package_link_reference_shape",
      sql`(${table.kind} = 'skill' and ${table.existingSkillId} is null and ${table.connectorInstallId} is null and ${table.expertTemplateRef} is null) or (${table.kind} = 'managedConnector' and ${table.existingSkillId} is null and ${table.connectorInstallId} is not null and ${table.expertTemplateRef} is null) or (${table.kind} = 'expertTemplate' and ${table.existingSkillId} is null and ${table.connectorInstallId} is null and ${table.expertTemplateRef} is not null)`,
    ),
    pgPolicy("enterprise_package_link_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_package_link_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_link_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * PKG03A (#462): one row = one resource of one Bot grant cycle. A grant cycle
 * is identified by (tenant, install, generation, bot): every `set` or `revoke`
 * supersede writes the next generation, so `grant revision` (the DTO CAS
 * counter) is the count of distinct generations for the pair and revocation
 * bumps it. Skill rows carry an empty `tool_ref`; connector tool rows (slice B)
 * must carry a non-empty one — the two-sided CHECK keeps the two kinds
 * distinguishable without SQL NULL tricks. Active state is `revoked_at IS
 * NULL`; only the latest generation can be active (set/revoke supersede first).
 *
 * The authoritative DDL is the `PKG03` task in
 * server/scripts/multitenancy/migrate-test.ts, applied after PKG02.
 */
export const enterprisePackageGrants = pgTable(
  "enterprise_package_grants",
  {
    tenantId: text("tenant_id").notNull(),
    installId: text("install_id").notNull(),
    /** Grant cycle number; strictly positive; revision = distinct count. */
    generation: integer("generation").notNull(),
    /** `enterprise_bot_ownership.agent_id` of the granted Bot. */
    botId: text("bot_id").notNull(),
    resourceId: text("resource_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** 'skill' | 'connectorTool'; slice A only writes 'skill'. */
    resourceKind: text("resource_kind").notNull().default("skill"),
    /** Empty for skill rows; non-empty `resource:tool` for connector tools. */
    toolRef: text("tool_ref").notNull().default(""),
    /** Company principal that granted (or executed the revocation). */
    grantedBy: text("granted_by").notNull(),
    /** `granted_at` in the PKG03 DDL — NOT the shared `created_at` helper. */
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "enterprise_package_grant_pk",
      columns: [
        table.tenantId,
        table.installId,
        table.generation,
        table.botId,
        table.resourceId,
      ],
    }),
    foreignKey({
      name: "enterprise_package_grant_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_package_grant_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_package_grant_install_fk",
      columns: [table.tenantId, table.workspaceId, table.installId],
      foreignColumns: [
        enterprisePackageInstalls.tenantId,
        enterprisePackageInstalls.workspaceId,
        enterprisePackageInstalls.id,
      ],
    }).onDelete("cascade"),
    // Bot ownership is the tenancy authority: the compound FK pins the Bot to
    // this tenant; same-workspace is enforced by the grants service against
    // the live ownership row (no (tenant, workspace, agent) unique index
    // exists to carry a three-column FK).
    foreignKey({
      name: "enterprise_package_grant_bot_fk",
      columns: [table.tenantId, table.botId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_package_grant_granted_by_fk",
      columns: [table.tenantId, table.grantedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check("enterprise_package_grant_generation", sql`${table.generation} > 0`),
    check(
      "enterprise_package_grant_tool_ref",
      sql`(${table.resourceKind} = 'skill' and ${table.toolRef} = '') or (${table.resourceKind} = 'connectorTool' and ${table.toolRef} <> '')`,
    ),
    check(
      "enterprise_package_grant_ids",
      sql`char_length(${table.resourceId}) between 1 and 64 and char_length(${table.botId}) between 1 and 256`,
    ),
    // At most one ACTIVE grant per (install, bot, resource, tool): a
    // re-grant supersedes (revokes) the previous generation first. tool_ref
    // is part of the key because one connector resource grants per tool.
    uniqueIndex("enterprise_package_grant_active_uq")
      .on(
        table.tenantId,
        table.installId,
        table.botId,
        table.resourceId,
        table.toolRef,
      )
      .where(sql`${table.revokedAt} is null`),
    pgPolicy("enterprise_package_grant_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_package_grant_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_grant_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    // UPDATE exists for revocation only (set `revoked_at`); the service never
    // clears it and never writes any other column back.
    pgPolicy("enterprise_package_grant_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * PKG03B (#462 slice B): one row = one install pinned into one Run attempt,
 * written by the package runtime's `prepareWithin` inside the run-writer's own
 * data transaction (Spec §6/§9: run row and pins commit atomically; a retry of
 * the same attempt reads the existing rows back instead of writing again).
 * `allowed_resource_ids` is the grant-time allowed skill set; the runtime read
 * re-validates install status and the live grant at every read, so revocation
 * narrows a live run without touching these immutable rows.
 *
 * The authoritative DDL is the `PKG03` task's slice-B steps in
 * server/scripts/multitenancy/migrate-test.ts; this is the typed/query-visible
 * mirror, never a `drizzle-kit generate` source.
 */
export const enterpriseRunPackagePins = pgTable(
  "enterprise_run_package_pins",
  {
    tenantId: text("tenant_id").notNull(),
    /** `enterprise_runs.id` (uuid); the compound FK pins the run. */
    runId: uuid("run_id").notNull(),
    attemptGeneration: integer("attempt_generation").notNull(),
    installId: text("install_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** The install revision pinned (an old run keeps its old revision). */
    revision: integer("revision").notNull(),
    /** The pinned revision's artifact digest (content address to read from). */
    releaseDigest: text("release_digest").notNull(),
    /** Distinct grant generations for (install, bot) at pin time. */
    grantRevision: integer("grant_revision").notNull(),
    /** Grant-time allowed skill resource ids (jsonb array of strings). */
    allowedResourceIds: jsonbDocument("allowed_resource_ids").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "enterprise_run_package_pin_pk",
      columns: [
        table.tenantId,
        table.runId,
        table.attemptGeneration,
        table.installId,
      ],
    }),
    foreignKey({
      name: "enterprise_run_package_pin_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_run_package_pin_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_run_package_pin_run_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_run_package_pin_install_fk",
      columns: [table.tenantId, table.workspaceId, table.installId],
      foreignColumns: [
        enterprisePackageInstalls.tenantId,
        enterprisePackageInstalls.workspaceId,
        enterprisePackageInstalls.id,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_run_package_pin_generation",
      sql`${table.attemptGeneration} > 0`,
    ),
    check(
      "enterprise_run_package_pin_revision",
      sql`${table.revision} > 0 and ${table.grantRevision} > 0`,
    ),
    check(
      "enterprise_run_package_pin_digest",
      sql`${table.releaseDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_run_package_pin_allowed_shape",
      sql`jsonb_typeof(${table.allowedResourceIds}) = 'array' and jsonb_array_length(${table.allowedResourceIds}) <= 256`,
    ),
    pgPolicy("enterprise_run_package_pin_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    // The run writer (ob_ent_data) inserts pins in the run's own transaction;
    // there is no UPDATE/DELETE anywhere — pins are immutable.
    pgPolicy("enterprise_run_package_pin_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_run_package_pin_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_run_package_pin_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** Append-only change receipt; the idempotency key is unique per actor/team. */
export const enterprisePackageChanges = pgTable(
  "enterprise_package_changes",
  {
    tenantId: text("tenant_id").notNull(),
    changeId: text("change_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    installId: text("install_id").notNull(),
    revision: integer("revision").notNull(),
    actorId: text("actor_id").notNull(),
    /** Closed action vocabulary (PKG02 writes 'install'). */
    action: text("action").notNull(),
    /** Redacted change diff (no secret-carrier keys). */
    diff: jsonbDocument("diff").notNull(),
    idempotencyKey: text("idempotency_key").notNull().default(""),
    requestDigest: text("request_digest").notNull(),
    resultJson: jsonbDocument("result_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.changeId] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installId, table.revision],
      foreignColumns: [
        enterprisePackageRevisions.tenantId,
        enterprisePackageRevisions.installId,
        enterprisePackageRevisions.revision,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_package_change_action",
      sql`${table.action} in ('install', 'upgrade', 'rollback')`,
    ),
    check(
      "enterprise_package_change_key",
      sql`char_length(${table.idempotencyKey}) <= 128 and ${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_package_change_diff_shape",
      sql`jsonb_typeof(${table.diff}) = 'object' and ${noNestedSecretCarriers(table.diff)}`,
    ),
    uniqueIndex("enterprise_package_change_idempotency_uq")
      .on(
        table.tenantId,
        table.workspaceId,
        table.actorId,
        table.idempotencyKey,
      )
      .where(sql`${table.idempotencyKey} <> ''`),
    index("enterprise_package_change_install_idx").on(
      table.tenantId,
      table.installId,
      table.revision,
    ),
    pgPolicy("enterprise_package_change_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.workspaceId} = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_package_change_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_package_change_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
