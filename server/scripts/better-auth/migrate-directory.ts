/*
 * The M1 expand verification and the M2 stop-write backfill tool (T02.14 /
 * #536, the second slice of the original P25 tooling; interfaces §1/§2/§3.3,
 * design §13.2, root Spec "M1 expand 只读展开、M2 停写回填、authority 与
 * release 分开").
 *
 * Entry model: the MT001/inventory entry contract — a stable documented output
 * shape with schemaVersion/generatedAt/digest (the digest excludes
 * generatedAt), JSON on stdout, a human-readable report on stderr, optional
 * --out/--report files, and refusals instead of environment fall-backs. The
 * target URL is always explicit; no DSN is ever printed.
 *
 * Phases:
 *
 * - `--phase M1` (read-only): verifies the expand stack the migrations
 *   deliver — the BA tables, the DML guard and the deferred fences, the
 *   controlled functions, the AuthorityState row seeded at (M1, legacy), and
 *   the legacy writer's still-intact enterprise DML (M1 keeps it; M4 collects
 *   it). M1 never writes: a before/after snapshot of every in-scope table is
 *   byte-identical.
 * - `--phase M2` (dry-run by default): runs the M0 inventory for the
 *   unclassified-writer scan and provenance, takes one consistent read-only
 *   snapshot of the legacy directory, computes the per-tenant blockers and the
 *   interfaces §2 slug plan, and reports what would be imported. `--apply`
 *   additionally drives the stop-write CAS (M1/legacy → M2/paused through
 *   authority.ts's migration seam) and then imports each unblocked tenant, in
 *   one transaction per tenant, through the real restricted writer capability
 *   and the 0214 controlled functions + DML guard — the same command protocol
 *   the directory executor uses, with actor kind `migration` and a stable
 *   tenant-keyed idempotency key. The backfill never writes a legacy table:
 *   historical FK/payer/status/epoch facts are the input, not the output.
 *
 * Idempotency: each tenant's import carries a stable command id and a stable
 * tenant-keyed idempotency key, so a re-run replays (skips) every tenant the
 * previous run committed and resumes the rest; a BA unique-constraint
 * violation (a racing writer or drifted mapping) blocks and is reported — the
 * slug is never silently re-derived, so the tenant_id-keyed mapping is never
 * lost (interfaces §2 uniqueConflict).
 *
 * Old capabilities (interfaces §5.3): the personal Grant/Key dispositions are
 * recorded per item — a verified principal/generation source is carried, a
 * missing one is recorded as requiring re-authorization — and the backfill
 * writes nothing to access_grants or gateway_virtual_keys: a version is never
 * stamped from an active status, and the revocation DML belongs to the later
 * migration slices (T08.02/T08.03).
 *
 * 用法：
 *   bun server/scripts/better-auth/migrate-directory.ts --url <postgres URL> \
 *        [--phase M1] [--repo-root <dir>] [--out report.json] [--report report.md] [--pretty]
 *   bun server/scripts/better-auth/migrate-directory.ts --url <postgres URL> \
 *        --phase M2 [--apply] --writer-url <ob_ent_auth_writer URL> [...]
 *
 * Exit codes: 0 clean · 2 usage refusal · 1 run failure · 3 blocked
 * (M1 gaps, M2 global blockers, or any blocked tenant import).
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDirectoryMigrationAuthority } from "../../src/auth/directory/authority";
import { createDatabase } from "../../src/db/client";
import {
  type PlannedSlug,
  resolvePlannedSlugs,
  runM0Inventory,
  SLUG_BACKFILL_RULES,
  type SlugBackfillRules,
} from "./inventory";

export const MIGRATE_SCHEMA_VERSION = 1;

/** The phases this tool implements (M0 is inventory.ts; M3+ are later slices). */
export type MigrateDirectoryPhase = "M1" | "M2";

/** M1 verifies read-only; M2 plans by default and applies only under --apply. */
export type MigrateDirectoryMode = "verify" | "dry-run" | "apply";

export type BackfillBlockerKind =
  | "expand-stack-incomplete"
  | "authority-state-unexpected"
  | "unknown-owner"
  | "unknown-payer"
  | "unknown-generation"
  | "duplicate-relationship"
  | "unclassified-writer"
  | "slug-mapping-conflict"
  | "sso-provider-organization"
  | "ambiguous-principal-mapping"
  | "unknown-membership-role"
  | "slug-unique-conflict"
  | "import-refused";

export interface BackfillBlocker {
  kind: BackfillBlockerKind;
  /** The tenant/principal/user/file the blocker is about. */
  subject: string;
  detail: string;
}

export interface MigrateTarget {
  endpoint: string;
  database: string;
}

/** The persisted AuthorityState as the report carries it (plain JSON shape). */
export type AuthoritySnapshot = Readonly<{
  authorityVersion: number;
  phase: string;
  directoryAuthority: string;
  multiTenantReleased: boolean;
}>;

export interface SnapshotTenant {
  tenantId: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface SnapshotPrincipal {
  id: string;
  userId: string;
  status: string;
  identityGeneration: number | null;
}

export interface SnapshotMembership {
  tenantId: string;
  principalId: string;
  userId: string;
  role: string;
  status: string;
  epoch: number;
}

export interface SnapshotWorkspace {
  tenantId: string;
  workspaceId: string;
  name: string;
}

export interface SnapshotTeamMembership {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  userId: string;
  status: string;
  epoch: number;
}

export interface SnapshotGrant {
  grantId: string;
  userId: string;
  principalId: string | null;
  identityGeneration: number | null;
  status: string;
}

export interface SnapshotKey {
  keyId: string;
  grantId: string;
  sourceIdentityGeneration: number | null;
  status: string;
}

/** One consistent read-only snapshot of the directory the backfill imports. */
export interface BackfillSnapshot {
  tenants: readonly SnapshotTenant[];
  principals: readonly SnapshotPrincipal[];
  memberships: readonly SnapshotMembership[];
  workspaces: readonly SnapshotWorkspace[];
  teamMemberships: readonly SnapshotTeamMembership[];
  billingMappings: readonly { tenantId: string; externalCustomerId: string }[];
  existingOrganizations: readonly { tenantId: string; slug: string }[];
  existingMembers: readonly { tenantId: string; userId: string }[];
  migrationReceipts: readonly { tenantId: string; commandId: string }[];
  ssoProviderOrganizations: readonly string[];
  grants: readonly SnapshotGrant[];
  keys: readonly SnapshotKey[];
  users: number;
}

/** The disposition the M2 report records per personal grant/key (§5.3). */
export type AuthorizationSourceDisposition =
  | "verified-principal"
  | "verified-generation"
  | "re-authorization-required";

export interface GrantDisposition extends SnapshotGrant {
  disposition: AuthorizationSourceDisposition;
}

export interface KeyDisposition extends SnapshotKey {
  disposition: AuthorizationSourceDisposition;
}

/** One tenant's planned import: everything the per-tenant transaction writes. */
export interface PlannedTenantImport {
  tenantId: string;
  name: string;
  status: string;
  plannedSlug: string;
  collisionSuffix: number | null;
  existingSlug: string | null;
  teams: readonly {
    workspaceId: string;
    name: string;
    teamId: string;
    memberCount: number;
  }[];
  members: readonly {
    principalId: string;
    userId: string;
    legacyRole: string;
    baRole: string;
    status: string;
    memberId: string;
  }[];
  teamMembers: readonly {
    workspaceId: string;
    teamId: string;
    principalId: string;
    userId: string;
    teamMemberId: string;
  }[];
  commandId: string;
  idempotencyKey: string;
  payloadHash: string;
}

/** The M2 plan: one consistent snapshot plus every decision derived from it. */
export interface M2Plan {
  phase: "M2";
  target: MigrateTarget;
  snapshot: BackfillSnapshot;
  inventory: { digest: string; canMigrate: boolean };
  scanMissing: readonly string[];
  authority: AuthoritySnapshot | null;
  plannedSlugs: readonly PlannedSlug[];
  imports: readonly PlannedTenantImport[];
  blockersByTenant: readonly {
    tenantId: string;
    blockers: readonly BackfillBlocker[];
  }[];
  globalBlockers: readonly BackfillBlocker[];
  authorizationSources: {
    personalGrants: readonly GrantDisposition[];
    gatewayKeys: readonly KeyDisposition[];
  };
}

export interface TenantImportResult {
  tenantId: string;
  outcome: "imported" | "replayed" | "blocked";
  blockers: readonly BackfillBlocker[];
  organizationId: string | null;
  slug: string | null;
  teamCount: number;
  memberCount: number;
  teamMemberCount: number;
  commandId: string;
}

export interface M2ApplyResult {
  /** True when this run performed the M1→M2 pause CAS. */
  paused: boolean;
  pauseRefusal: string | null;
  backfillBlocked: boolean;
  globalBlockers: readonly BackfillBlocker[];
  imports: readonly TenantImportResult[];
}

export interface MigrateDirectoryReport {
  schemaVersion: number;
  /** ISO-8601; not part of the digest. */
  generatedAt: string;
  digest: string;
  phase: MigrateDirectoryPhase;
  mode: MigrateDirectoryMode;
  target: {
    endpoint: string;
    database: string;
    expandedSchema: boolean;
    writerCapability: string | null;
  };
  expand: {
    baTables: number;
    guardTriggers: number;
    fenceTriggers: number;
    controlledFunctions: number;
    legacyWriterIntact: boolean;
  } | null;
  authority: {
    before: AuthoritySnapshot | null;
    after: AuthoritySnapshot | null;
    paused: boolean;
    pauseRefusal: string | null;
  };
  preconditions: {
    ssoProvidersWithOrganization: number | null;
    inventoryDigest: string | null;
    inventoryCanMigrate: boolean | null;
  };
  mapping: {
    tenants: number;
    users: number;
    principals: number;
    memberships: number;
    workspaces: number;
    teamMemberships: number;
  };
  slugBackfill: {
    rules: SlugBackfillRules;
    plannedSlugs: readonly PlannedSlug[];
  } | null;
  blockers: readonly BackfillBlocker[];
  canImport: boolean | null;
  backfill: {
    backfillBlocked: boolean;
    imports: readonly TenantImportResult[];
  } | null;
  authorizationSources: {
    personalGrants: readonly GrantDisposition[];
    gatewayKeys: readonly KeyDisposition[];
  } | null;
}

export interface MigrateDirectoryCliPlan {
  phase: MigrateDirectoryPhase;
  mode: MigrateDirectoryMode;
  url: string;
  writerUrl?: string;
  repositoryRoot: string;
  out?: string;
  report?: string;
  pretty?: boolean;
}

export type MigrateDirectoryCliParse =
  | { ok: true; plan: MigrateDirectoryCliPlan }
  | { ok: false; refusal: string };

// ---------------------------------------------------------------------------
// Target and writer URL validation (the inventory entry contract: explicit,
// loopback, openbot_enterprise_*, and no DSN in any refusal)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function targetOf(url: string, what: string): MigrateTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} must be a PostgreSQL URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error(`${what} must be a PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      parsed.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    database = "";
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !database) {
    throw new Error(
      `${what} must be a loopback PostgreSQL URL naming an isolated enterprise database.`,
    );
  }
  if (!/^openbot_enterprise_/.test(database)) {
    throw new Error(
      `the target database must be an openbot_enterprise_* isolated test/rehearsal database, not "${database}": real production runs are not authorized in this slice.`,
    );
  }
  if (parsed.hash) {
    throw new Error(`${what} must not include a URL fragment.`);
  }
  const host =
    parsed.hostname === "localhost" || parsed.hostname === "[::1]"
      ? "127.0.0.1"
      : parsed.hostname;
  return { endpoint: `${host}:${parsed.port || "5432"}`, database };
}

/** The writer URL must name the same instance and database as the reader. */
function writerTargetOf(writerUrl: string, reader: MigrateTarget): void {
  const writer = targetOf(writerUrl, "--writer-url");
  if (
    writer.endpoint !== reader.endpoint ||
    writer.database !== reader.database
  ) {
    throw new Error(
      `--writer-url must name the same PostgreSQL instance and database as --url (${reader.endpoint}/${reader.database}); it names ${writer.endpoint}/${writer.database}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Version / digest helpers (interfaces §2's safe-integer discipline)
// ---------------------------------------------------------------------------

function toVersionOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      "a version column returned a value outside the safe-integer range; the tool refuses to plan with a generation it cannot represent (interfaces §2).",
    );
  }
  return parsed;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestOf(
  report: Omit<MigrateDirectoryReport, "digest" | "generatedAt"> &
    Partial<Pick<MigrateDirectoryReport, "generatedAt">>,
): string {
  const { generatedAt: _generatedAt, ...rest } = report;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

/** A stable digest-shaped id for one backfilled entity (deterministic ids). */
function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash("sha256")
    .update(parts.join(""))
    .digest("hex")
    .slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// The M1 expand verification (design §13.2 "M1 Expand"; read-only)
// ---------------------------------------------------------------------------

/** The BA tables the M2 backfill writes or reads through controlled paths. */
const M2_BA_TABLES = [
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_eligibility_clocks",
  "auth_command_receipts",
  "auth_command_change_keys",
  "auth_authority_states",
] as const;
const M2_CONTROLLED_FUNCTIONS = [
  "auth_directory_begin_command(text,text,text,text,text,text,text,text,text)",
  "auth_directory_finalize_command(text)",
  "auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)",
] as const;
const M2_FENCE_TRIGGERS = [
  "auth_command_receipt_fence",
  "auth_change_key_fence",
  "auth_team_member_orphan_fence",
  "auth_member_orphan_fence",
] as const;

interface ExpandCatalog {
  ba_tables: number;
  guard_triggers: number;
  fence_triggers: number;
  controlled_functions: number;
  operator_tenant_insert: boolean;
  operator_membership_insert: boolean;
  operator_workspace_insert: boolean;
  operator_membership_status_update: boolean;
}

async function readAuthorityRow(
  db: Pick<ReturnType<typeof createDatabase>, "execute">,
): Promise<AuthoritySnapshot | null> {
  const rows = (await db.execute(sql`
    SELECT authority_version::text AS authority_version, phase,
           directory_authority, multi_tenant_released
      FROM auth_authority_states WHERE id = 1`)) as unknown as Array<{
    authority_version: string;
    phase: string;
    directory_authority: string;
    multi_tenant_released: boolean;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    authorityVersion: toVersionOrNull(row.authority_version) ?? 0,
    phase: row.phase,
    directoryAuthority: row.directory_authority,
    multiTenantReleased: row.multi_tenant_released,
  };
}

export async function verifyM1Expand(input: {
  url: string;
  repositoryRoot: string;
}): Promise<MigrateDirectoryReport> {
  const target = targetOf(input.url, "the target URL");
  const db = createDatabase(input.url, { max: 2 });
  try {
    const catalog = (
      (await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM unnest(${sql.raw(
            `ARRAY[${M2_BA_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
          )}) AS tables(name)
            WHERE to_regclass('public.' || tables.name) IS NOT NULL) AS ba_tables,
          (SELECT count(*)::int FROM pg_trigger
            WHERE tgname = 'auth_directory_dml_guard' AND NOT tgisinternal) AS guard_triggers,
          (SELECT count(*)::int FROM pg_trigger
            WHERE tgname = ANY(${sql.raw(
              `ARRAY[${M2_FENCE_TRIGGERS.map((name) => `'${name}'`).join(", ")}]::text[]`,
            )}) AND NOT tgisinternal AND tgdeferrable AND tginitdeferred) AS fence_triggers,
          (SELECT count(*)::int FROM unnest(${sql.raw(
            `ARRAY[${M2_CONTROLLED_FUNCTIONS.map((name) => `'${name}'`).join(", ")}]::text[]`,
          )}) AS functions(signature)
            WHERE to_regprocedure('public.' || functions.signature) IS NOT NULL) AS controlled_functions,
          has_table_privilege('ob_ent_operator', 'public.enterprise_tenants', 'INSERT') AS operator_tenant_insert,
          has_table_privilege('ob_ent_operator', 'public.enterprise_memberships', 'INSERT') AS operator_membership_insert,
          has_table_privilege('ob_ent_operator', 'public.enterprise_workspaces', 'INSERT') AS operator_workspace_insert,
          has_column_privilege('ob_ent_operator', 'public.enterprise_memberships', 'status', 'UPDATE') AS operator_membership_status_update`)) as unknown as ExpandCatalog[]
    )[0];
    if (!catalog) {
      throw new Error("the M1 expand catalog read returned no row.");
    }
    const blockers: BackfillBlocker[] = [];
    if (catalog.ba_tables !== M2_BA_TABLES.length) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: "ba-tables",
        detail: `${catalog.ba_tables} of ${M2_BA_TABLES.length} M2-dependency BA tables exist: the expand migrations (0209–0214) have not fully applied, and the M2 backfill cannot run against a partial expand stack.`,
      });
    }
    if (catalog.guard_triggers !== 6) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: "auth_directory_dml_guard",
        detail: `${catalog.guard_triggers} of 6 DML-guard triggers exist: migration 0214's writer discipline is not fully installed.`,
      });
    }
    if (catalog.fence_triggers !== M2_FENCE_TRIGGERS.length) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: "commit-fences",
        detail: `${catalog.fence_triggers} of ${M2_FENCE_TRIGGERS.length} deferred constraint fences exist: an unfinalized command could commit.`,
      });
    }
    if (catalog.controlled_functions !== M2_CONTROLLED_FUNCTIONS.length) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: "controlled-functions",
        detail: `${catalog.controlled_functions} of ${M2_CONTROLLED_FUNCTIONS.length} controlled functions the backfill calls exist: migration 0214's controlled write path is incomplete.`,
      });
    }
    // The legacy writer's 0056 contract: table-level INSERT on the directory
    // tables plus the column-level status/epoch UPDATE on memberships — the
    // privileges M1 must keep and only M4 collects (0214's header).
    const legacyWriterIntact = Boolean(
      catalog.operator_tenant_insert &&
        catalog.operator_membership_insert &&
        catalog.operator_workspace_insert &&
        catalog.operator_membership_status_update,
    );
    if (!legacyWriterIntact) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: "legacy-writer",
        detail:
          "ob_ent_operator has lost part of its 0056 enterprise DML (INSERT on tenants/memberships/workspaces or the column-level status UPDATE on memberships): M1 must keep the legacy writer's rights until M4 collects them (interfaces §3.3).",
      });
    }
    const authorityTable = (
      (await db.execute(
        sql`SELECT to_regclass('public.auth_authority_states') IS NOT NULL AS present`,
      )) as unknown as Array<{ present: boolean }>
    )[0]?.present;
    const authority: AuthoritySnapshot | null = authorityTable
      ? await readAuthorityRow(db)
      : null;
    if (
      authority?.phase !== "M1" ||
      authority?.directoryAuthority !== "legacy"
    ) {
      blockers.push({
        kind: "authority-state-unexpected",
        subject: "auth_authority_states",
        detail: authority
          ? `the persisted AuthorityState is (phase ${authority.phase}, authority ${authority.directoryAuthority}) at version ${authority.authorityVersion}, not the (M1, legacy) expand state migration 0211 seeds.`
          : "auth_authority_states has no row 1: the expand migrations have not seeded the M1 state.",
      });
    }
    const report: Omit<MigrateDirectoryReport, "digest"> = {
      schemaVersion: MIGRATE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      phase: "M1",
      mode: "verify",
      target: {
        endpoint: target.endpoint,
        database: target.database,
        expandedSchema: catalog.ba_tables === M2_BA_TABLES.length,
        writerCapability: null,
      },
      expand: {
        baTables: catalog.ba_tables,
        guardTriggers: catalog.guard_triggers,
        fenceTriggers: catalog.fence_triggers,
        controlledFunctions: catalog.controlled_functions,
        legacyWriterIntact,
      },
      authority: {
        before: authority,
        after: authority,
        paused: false,
        pauseRefusal: null,
      },
      preconditions: {
        ssoProvidersWithOrganization: null,
        inventoryDigest: null,
        inventoryCanMigrate: null,
      },
      mapping: {
        tenants: 0,
        users: 0,
        principals: 0,
        memberships: 0,
        workspaces: 0,
        teamMemberships: 0,
      },
      slugBackfill: null,
      blockers,
      canImport: null,
      backfill: null,
      authorizationSources: null,
    };
    return { ...report, digest: digestOf(report) };
  } finally {
    await db.$client.close?.();
  }
}

// ---------------------------------------------------------------------------
// The M2 plan: inventory scan + one consistent snapshot + every decision
// ---------------------------------------------------------------------------

/** The legacy membership role → BA DirectoryRole mapping (interfaces §2). */
const LEGACY_ROLE_TO_BA: Readonly<Record<string, string>> = Object.freeze({
  tenant_admin: "owner",
  member: "member",
  auditor: "auditor",
});

async function readSnapshot(
  db: ReturnType<typeof createDatabase>,
): Promise<BackfillSnapshot> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const tenants = (
      (await tx.execute(sql`
        SELECT id, name, status, created_at FROM enterprise_tenants
         ORDER BY created_at, id`)) as unknown as Array<{
        id: string;
        name: string;
        status: string;
        created_at: Date;
      }>
    ).map((row) => ({
      tenantId: row.id,
      name: row.name,
      status: row.status,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
    const principals = (
      (await tx.execute(sql`
        SELECT id, user_id, status, identity_generation::text AS identity_generation
          FROM enterprise_principals ORDER BY id`)) as unknown as Array<{
        id: string;
        user_id: string;
        status: string;
        identity_generation: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      userId: row.user_id,
      status: row.status,
      identityGeneration: toVersionOrNull(row.identity_generation),
    }));
    const principalById = new Map(principals.map((row) => [row.id, row]));
    const memberships = (
      (await tx.execute(sql`
        SELECT tenant_id, principal_id, role, status, epoch
          FROM enterprise_memberships ORDER BY tenant_id, principal_id`)) as unknown as Array<{
        tenant_id: string;
        principal_id: string;
        role: string;
        status: string;
        epoch: number;
      }>
    ).map((row) => ({
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      userId: principalById.get(row.principal_id)?.userId ?? "",
      role: row.role,
      status: row.status,
      epoch: toVersionOrNull(row.epoch) ?? 0,
    }));
    const workspaces = (
      (await tx.execute(sql`
        SELECT tenant_id, id, name FROM enterprise_workspaces
         ORDER BY tenant_id, id`)) as unknown as Array<{
        tenant_id: string;
        id: string;
        name: string;
      }>
    ).map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.id,
      name: row.name,
    }));
    const teamMemberships = (
      (await tx.execute(sql`
        SELECT tenant_id, workspace_id, principal_id, status, epoch
          FROM enterprise_workspace_memberships
         ORDER BY tenant_id, workspace_id, principal_id`)) as unknown as Array<{
        tenant_id: string;
        workspace_id: string;
        principal_id: string;
        status: string;
        epoch: number;
      }>
    ).map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      userId: principalById.get(row.principal_id)?.userId ?? "",
      status: row.status,
      epoch: toVersionOrNull(row.epoch) ?? 0,
    }));
    const billingMappings = (
      (await tx.execute(sql`
        SELECT tenant_id, external_customer_id FROM billing_customer_mappings
         ORDER BY tenant_id`)) as unknown as Array<{
        tenant_id: string;
        external_customer_id: string;
      }>
    ).map((row) => ({
      tenantId: row.tenant_id,
      externalCustomerId: row.external_customer_id,
    }));
    const existingOrganizations = (
      (await tx.execute(sql`
        SELECT id, slug FROM auth_organizations ORDER BY id`)) as unknown as Array<{
        id: string;
        slug: string;
      }>
    ).map((row) => ({ tenantId: row.id, slug: row.slug }));
    const existingMembers = (
      (await tx.execute(sql`
        SELECT organization_id, user_id FROM auth_members ORDER BY id`)) as unknown as Array<{
        organization_id: string;
        user_id: string;
      }>
    ).map((row) => ({ tenantId: row.organization_id, userId: row.user_id }));
    const migrationReceipts = (
      (await tx.execute(sql`
        SELECT tenant_id, command_id FROM auth_command_receipts
         WHERE domain = 'company'
           AND idempotency_key LIKE 'migrate-directory:company:%'
         ORDER BY tenant_id`)) as unknown as Array<{
        tenant_id: string;
        command_id: string;
      }>
    ).map((row) => ({ tenantId: row.tenant_id, commandId: row.command_id }));
    const ssoProviderOrganizations = (
      (await tx.execute(sql`
        SELECT organization_id FROM sso_providers
         WHERE organization_id IS NOT NULL ORDER BY id`)) as unknown as Array<{
        organization_id: string;
      }>
    ).map((row) => row.organization_id);
    const grants = (
      (await tx.execute(sql`
        SELECT grant_id, user_id, principal_id,
               identity_generation::text AS identity_generation, status
          FROM access_grants ORDER BY grant_id`)) as unknown as Array<{
        grant_id: string;
        user_id: string;
        principal_id: string | null;
        identity_generation: string | null;
        status: string;
      }>
    ).map((row) => ({
      grantId: row.grant_id,
      userId: row.user_id,
      principalId: row.principal_id,
      identityGeneration: toVersionOrNull(row.identity_generation),
      status: row.status,
    }));
    const keys = (
      (await tx.execute(sql`
        SELECT id, grant_id, source_identity_generation::text AS source_identity_generation, status
          FROM gateway_virtual_keys ORDER BY id`)) as unknown as Array<{
        id: string;
        grant_id: string;
        source_identity_generation: string | null;
        status: string;
      }>
    ).map((row) => ({
      keyId: row.id,
      grantId: row.grant_id,
      sourceIdentityGeneration: toVersionOrNull(row.source_identity_generation),
      status: row.status,
    }));
    const [users] = (await tx.execute(
      sql`SELECT count(*)::int AS users FROM users`,
    )) as unknown as Array<{ users: number }>;
    return {
      tenants,
      principals,
      memberships,
      workspaces,
      teamMemberships,
      billingMappings,
      existingOrganizations,
      existingMembers,
      migrationReceipts,
      ssoProviderOrganizations,
      grants,
      keys,
      users: users?.users ?? 0,
    };
  });
}

/**
 * The per-tenant and global blockers derived from one snapshot. The M0
 * inventory reports the same facts subject-keyed; this derivation attributes
 * them per tenant because the backfill gates per tenant — the mapping of a
 * blocker-free company is unambiguous even when another company's is not.
 */
function blockersOfSnapshot(snapshot: BackfillSnapshot): {
  blockersByTenant: Map<string, BackfillBlocker[]>;
  globalBlockers: BackfillBlocker[];
} {
  const blockersByTenant = new Map<string, BackfillBlocker[]>();
  const globalBlockers: BackfillBlocker[] = [];
  const add = (tenantId: string, blocker: BackfillBlocker): void => {
    const list = blockersByTenant.get(tenantId) ?? [];
    list.push(blocker);
    blockersByTenant.set(tenantId, list);
  };
  for (const organization of snapshot.ssoProviderOrganizations) {
    globalBlockers.push({
      kind: "sso-provider-organization",
      subject: organization,
      detail:
        "sso_providers.organization_id is not empty: an SSO provider is already bound to an organization, and the M2 backfill refuses to run against a directory state the migration did not produce (design §9/F-02).",
    });
  }
  // 一User一Principal: a user with several principals makes every membership
  // of that user's principals ambiguous — the DML guard's user→principal
  // lookup would establish clocks on an arbitrary principal.
  const principalsByUser = new Map<string, SnapshotPrincipal[]>();
  for (const principal of snapshot.principals) {
    const list = principalsByUser.get(principal.userId) ?? [];
    list.push(principal);
    principalsByUser.set(principal.userId, list);
  }
  const ambiguousUsers = new Map(
    [...principalsByUser]
      .filter(([, principals]) => principals.length > 1)
      .map(([userId, principals]) => [
        userId,
        principals.map((principal) => principal.id),
      ]),
  );
  for (const membership of snapshot.memberships) {
    const ambiguous = ambiguousUsers.get(membership.userId);
    if (ambiguous) {
      add(membership.tenantId, {
        kind: "ambiguous-principal-mapping",
        subject: membership.userId,
        detail: `the user has ${ambiguous.length} principals (${ambiguous.join(", ")}); the directory mapping is ambiguous and the backfill refuses to guess which principal a membership belongs to (一User一Principal).`,
      });
    }
    if (!(membership.role in LEGACY_ROLE_TO_BA)) {
      add(membership.tenantId, {
        kind: "unknown-membership-role",
        subject: membership.tenantId,
        detail: `membership role "${membership.role}" of principal ${membership.principalId} is outside the legacy closed domain, so it has no BA DirectoryRole mapping.`,
      });
    }
  }
  const payerTenants = new Set(
    snapshot.billingMappings.map((row) => row.tenantId),
  );
  const ownersByTenant = new Map<string, number>();
  for (const membership of snapshot.memberships) {
    if (membership.role === "tenant_admin") {
      ownersByTenant.set(
        membership.tenantId,
        (ownersByTenant.get(membership.tenantId) ?? 0) + 1,
      );
    }
  }
  // A principal holding relationships with a missing identity_generation:
  // unverified history is never backfilled (interfaces §2), so every tenant
  // the principal holds a relationship in is blocked.
  const generationMissing = new Set(
    snapshot.principals
      .filter(
        (principal) =>
          principal.identityGeneration === null &&
          (snapshot.memberships.some(
            (membership) => membership.principalId === principal.id,
          ) ||
            snapshot.teamMemberships.some(
              (teamMembership) => teamMembership.principalId === principal.id,
            )),
      )
      .map((principal) => principal.id),
  );
  for (const principalId of generationMissing) {
    for (const membership of snapshot.memberships) {
      if (membership.principalId === principalId) {
        add(membership.tenantId, {
          kind: "unknown-generation",
          subject: principalId,
          detail:
            "identity_generation is missing on a principal holding directory relationships; unverified history cannot be backfilled (interfaces §2) — verify it or let the migration revoke and require re-authorization.",
        });
      }
    }
  }
  for (const tenant of snapshot.tenants) {
    if (!(ownersByTenant.get(tenant.tenantId) ?? 0)) {
      add(tenant.tenantId, {
        kind: "unknown-owner",
        subject: tenant.tenantId,
        detail:
          "no tenant_admin membership names this company's owner; the inventory reports the unknown and never designates the first member.",
      });
    }
    if (!payerTenants.has(tenant.tenantId)) {
      add(tenant.tenantId, {
        kind: "unknown-payer",
        subject: tenant.tenantId,
        detail:
          "no billing_customer_mappings row names this company's billing customer; the payer the migration carries over cannot be determined.",
      });
    }
  }
  // A BA member row with no legacy membership backing: the dual-write state
  // is inconsistent and the backfill refuses to import on top of it.
  for (const member of snapshot.existingMembers) {
    const backed = snapshot.memberships.some(
      (membership) =>
        membership.tenantId === member.tenantId &&
        principalsByUser
          .get(member.userId)
          ?.some((principal) => principal.id === membership.principalId),
    );
    if (!backed) {
      add(member.tenantId, {
        kind: "duplicate-relationship",
        subject: `${member.tenantId}/${member.userId}`,
        detail:
          "a BA member row has no legacy enterprise_memberships backing; the dual-write state is inconsistent.",
      });
    }
  }
  return { blockersByTenant, globalBlockers };
}

export async function planM2Backfill(input: {
  url: string;
  repositoryRoot: string;
}): Promise<M2Plan> {
  const target = targetOf(input.url, "the target URL");
  const db = createDatabase(input.url, { max: 2 });
  try {
    // The M2 gate consults the M0 inventory: the unclassified-writer scan and
    // the digest are the migration's provenance (design §13.1/F-04).
    const expandPresent = (
      (await db.execute(sql`
        SELECT count(*)::int AS present FROM unnest(${sql.raw(
          `ARRAY[${M2_BA_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
        )}) AS tables(name)
         WHERE to_regclass('public.' || tables.name) IS NOT NULL`)) as unknown as Array<{
        present: number;
      }>
    )[0]?.present;
    if (expandPresent !== M2_BA_TABLES.length) {
      throw new Error(
        `EXPAND_STACK_INCOMPLETE: ${expandPresent ?? 0} of ${M2_BA_TABLES.length} M2-dependency BA tables exist on the target — the M2 backfill runs only on the expanded stack; run --phase M1 for the read-only diagnosis.`,
      );
    }
    const inventory = await runM0Inventory({
      url: input.url,
      phase: "M0",
      repositoryRoot: input.repositoryRoot,
    });
    const snapshot = await readSnapshot(db);
    const authority = await readAuthorityRow(db);
    const { blockersByTenant, globalBlockers } = blockersOfSnapshot(snapshot);
    for (const file of inventory.legacyWriters.scan.missing) {
      globalBlockers.push({
        kind: "unclassified-writer",
        subject: file,
        detail:
          "the writer scan found a directory-table writer outside the static list; classify it with a disposal phase or remove the write before the backfill runs.",
      });
    }
    // interfaces §2 slugs: persisted rows win, collisions take deterministic
    // suffixes in (created_at, tenant_id) order, empty names fall back to the
    // tenant digest — the same pure function the M0 inventory records.
    const existingSlugByTenant = new Map(
      snapshot.existingOrganizations.map((row) => [row.tenantId, row.slug]),
    );
    const plannedSlugs = resolvePlannedSlugs(
      snapshot.tenants.map((tenant) => ({
        tenantId: tenant.tenantId,
        name: tenant.name,
        createdAt: tenant.createdAt,
        existingSlug: existingSlugByTenant.get(tenant.tenantId) ?? null,
      })),
    );
    const plannedSlugByTenant = new Map(
      plannedSlugs.map((slug) => [slug.tenantId, slug]),
    );
    const slugOwners = new Map<string, string>();
    for (const slug of plannedSlugs) {
      const owner = slugOwners.get(slug.plannedSlug);
      if (owner !== undefined) {
        globalBlockers.push({
          kind: "slug-mapping-conflict",
          subject: `${owner}/${slug.tenantId}`,
          detail:
            "deterministic resolution assigned the same planned slug to two tenants; the backfill blocks and reports rather than silently re-deriving (interfaces §2).",
        });
      } else {
        slugOwners.set(slug.plannedSlug, slug.tenantId);
      }
    }
    const imports: PlannedTenantImport[] = snapshot.tenants.map((tenant) => {
      const planned = plannedSlugByTenant.get(tenant.tenantId);
      const teams = snapshot.workspaces
        .filter((workspace) => workspace.tenantId === tenant.tenantId)
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          teamId: stableId("mdt", tenant.tenantId, workspace.workspaceId),
          memberCount: snapshot.teamMemberships.filter(
            (teamMembership) =>
              teamMembership.tenantId === tenant.tenantId &&
              teamMembership.workspaceId === workspace.workspaceId,
          ).length,
        }));
      const teamByWorkspace = new Map(
        teams.map((team) => [team.workspaceId, team]),
      );
      const members = snapshot.memberships
        .filter((membership) => membership.tenantId === tenant.tenantId)
        .map((membership) => ({
          principalId: membership.principalId,
          userId: membership.userId,
          legacyRole: membership.role,
          baRole: LEGACY_ROLE_TO_BA[membership.role] ?? membership.role,
          status: membership.status,
          memberId: stableId("md", tenant.tenantId, membership.userId),
        }));
      const teamMembers = snapshot.teamMemberships
        .filter((teamMembership) => teamMembership.tenantId === tenant.tenantId)
        .map((teamMembership) => ({
          workspaceId: teamMembership.workspaceId,
          teamId: teamByWorkspace.get(teamMembership.workspaceId)?.teamId ?? "",
          principalId: teamMembership.principalId,
          userId: teamMembership.userId,
          teamMemberId: stableId(
            "mdm",
            tenant.tenantId,
            teamMembership.workspaceId,
            teamMembership.userId,
          ),
        }));
      const idempotencyKey = `migrate-directory:company:${tenant.tenantId}`;
      const payload = {
        tenantId: tenant.tenantId,
        name: tenant.name,
        slug: planned?.plannedSlug ?? "",
        teams,
        members,
        teamMembers,
      };
      return {
        tenantId: tenant.tenantId,
        name: tenant.name,
        status: tenant.status,
        plannedSlug: planned?.plannedSlug ?? "",
        collisionSuffix: planned?.collisionSuffix ?? null,
        existingSlug: planned?.existingSlug ?? null,
        teams,
        members,
        teamMembers,
        commandId: `migrate-directory:${tenant.tenantId}`,
        idempotencyKey,
        payloadHash: createHash("sha256")
          .update(stableStringify(payload))
          .digest("hex"),
      };
    });
    return {
      phase: "M2",
      target,
      snapshot,
      inventory: {
        digest: inventory.digest,
        canMigrate: inventory.canMigrate,
      },
      scanMissing: [...inventory.legacyWriters.scan.missing],
      authority,
      plannedSlugs,
      imports,
      blockersByTenant: [...blockersByTenant].map(([tenantId, blockers]) => ({
        tenantId,
        blockers,
      })),
      globalBlockers,
      authorizationSources: {
        personalGrants: snapshot.grants.map((grant) => ({
          ...grant,
          disposition:
            grant.principalId !== null && grant.identityGeneration !== null
              ? "verified-principal"
              : "re-authorization-required",
        })),
        gatewayKeys: snapshot.keys.map((key) => ({
          ...key,
          disposition:
            key.sourceIdentityGeneration !== null
              ? "verified-generation"
              : "re-authorization-required",
        })),
      },
    };
  } finally {
    await db.$client.close?.();
  }
}

// ---------------------------------------------------------------------------
// The M2 apply: stop-write CAS + one guarded transaction per unblocked tenant
// ---------------------------------------------------------------------------

interface ChangeKeyRow {
  principal_id: string;
  scope_id: string;
  epoch_after: string | number;
  generation_after: string | number;
}

/** The deferred fences the executor forces before its commit (T02.08). */
const COMMIT_CONSTRAINTS =
  "SET CONSTRAINTS auth_command_receipt_fence, auth_change_key_fence, auth_team_member_orphan_fence, auth_member_orphan_fence IMMEDIATE";

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (code === "23505") return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function constraintOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { constraint?: unknown; message?: unknown };
    if (typeof record.constraint === "string") return record.constraint;
    const match = /constraint "([^"]+)"/.exec(String(record.message ?? ""));
    if (match) return match[1];
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

/**
 * One tenant's import: begin the migration-actor command, write the
 * organization/teams/bindings/members, establish the clocks to exactly the
 * versions the DML guard registered, finalize, and force the deferred fences
 * — all in one transaction, so a failure leaves nothing behind.
 */
async function importTenant(
  writer: postgres.Sql,
  tenant: PlannedTenantImport,
): Promise<TenantImportResult> {
  const summary = (
    outcome: TenantImportResult["outcome"],
  ): TenantImportResult => ({
    tenantId: tenant.tenantId,
    outcome,
    blockers: [],
    organizationId: tenant.tenantId,
    slug: tenant.plannedSlug,
    teamCount: tenant.teams.length,
    memberCount: tenant.members.length,
    teamMemberCount: tenant.teamMembers.length,
    commandId: tenant.commandId,
  });
  // The replay check: a committed receipt with this tenant's idempotency key
  // means a previous run imported the tenant whole (one transaction) — skip.
  const receipts = await writer`SELECT command_id FROM auth_command_receipts
     WHERE domain = 'company' AND tenant_id = ${tenant.tenantId}
       AND idempotency_key = ${tenant.idempotencyKey}`;
  if (receipts.length > 0) {
    return summary("replayed");
  }
  // A drifted or racing writer already created the organization row without
  // this migration's receipt: refuse rather than overwrite the mapping.
  const organizations = await writer`SELECT slug FROM auth_organizations
     WHERE id = ${tenant.tenantId}`;
  if (organizations.length > 0) {
    return {
      ...summary("blocked"),
      blockers: [
        {
          kind: "import-refused",
          subject: tenant.tenantId,
          detail: `an auth_organizations row already exists without this migration's receipt (slug ${String((organizations[0] as { slug: string }).slug)}); a drifted or racing writer state is refused rather than overwritten.`,
        },
      ],
    };
  }
  try {
    await writer.begin(async (tx) => {
      await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
        ${tenant.commandId}, 'company', 'company.provision', ${tenant.tenantId}, null,
        null, 'migration', ${tenant.idempotencyKey}, ${tenant.payloadHash}), true)`;
      try {
        await tx`INSERT INTO auth_organizations (id, name, slug)
          VALUES (${tenant.tenantId}, ${tenant.name}, ${tenant.plannedSlug})`;
        for (const team of tenant.teams) {
          await tx`INSERT INTO auth_teams (id, organization_id, name, member_count)
            VALUES (${team.teamId}, ${tenant.tenantId}, ${team.name}, ${team.memberCount})`;
          await tx`INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
            VALUES (${tenant.tenantId}, ${team.workspaceId}, ${team.teamId})`;
        }
        for (const member of tenant.members) {
          await tx`INSERT INTO auth_members (id, organization_id, user_id, role)
            VALUES (${member.memberId}, ${tenant.tenantId}, ${member.userId}, ${member.baRole})`;
        }
        // The clocks advance to exactly the versions the guard registered
        // for these rows — the establishment baseline is 1/1 (interfaces §2).
        const companyKeys =
          (await tx<ChangeKeyRow[]>`
          SELECT principal_id, epoch_after, generation_after
            FROM auth_command_change_keys
           WHERE command_id = ${tenant.commandId} AND kind = 'company'`) ?? [];
        for (const key of companyKeys) {
          await tx`SELECT public.auth_advance_eligibility_clock(
            ${tenant.tenantId}, ${key.principal_id}, 'company', ${tenant.tenantId},
            ${toVersionOrNull(key.epoch_after)}, ${toVersionOrNull(key.generation_after)},
            false, ${tenant.commandId})`;
        }
        for (const teamMember of tenant.teamMembers) {
          await tx`INSERT INTO auth_team_members (id, team_id, user_id)
            VALUES (${teamMember.teamMemberId}, ${teamMember.teamId}, ${teamMember.userId})`;
        }
        const teamKeys =
          (await tx<ChangeKeyRow[]>`
          SELECT principal_id, scope_id, epoch_after, generation_after
            FROM auth_command_change_keys
           WHERE command_id = ${tenant.commandId} AND kind = 'team'`) ?? [];
        for (const key of teamKeys) {
          await tx`SELECT public.auth_advance_eligibility_clock(
            ${tenant.tenantId}, ${key.principal_id}, 'team', ${key.scope_id},
            ${toVersionOrNull(key.epoch_after)}, ${toVersionOrNull(key.generation_after)},
            false, ${tenant.commandId})`;
        }
        await tx`SELECT public.auth_directory_finalize_command(${tenant.commandId})`;
        await tx`SELECT set_config('auth.current_command', '', true)`;
        await tx.unsafe(COMMIT_CONSTRAINTS);
      } catch (error) {
        await tx`SELECT set_config('auth.current_command', '', true)`.catch(
          () => {},
        );
        throw error;
      }
    });
    return summary("imported");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isUniqueViolation(error)) {
      const constraint = constraintOf(error);
      return {
        ...summary("blocked"),
        blockers: [
          constraint === "auth_organization_slug_uq"
            ? {
                kind: "slug-unique-conflict",
                subject: tenant.tenantId,
                detail: `the planned slug "${tenant.plannedSlug}" violates auth_organization_slug_uq (a racing writer or drifted mapping holds it); the backfill blocks and reports rather than silently re-deriving the slug (interfaces §2 uniqueConflict).`,
              }
            : {
                kind: "import-refused",
                subject: tenant.tenantId,
                detail: `a unique constraint (${constraint || "unknown"}) refused the import: ${detail.slice(0, 200)}`,
              },
        ],
      };
    }
    return {
      ...summary("blocked"),
      blockers: [
        {
          kind: "import-refused",
          subject: tenant.tenantId,
          detail: detail.slice(0, 300),
        },
      ],
    };
  }
}

export async function applyM2Backfill(input: {
  plan: M2Plan;
  url: string;
  writerUrl: string;
}): Promise<M2ApplyResult> {
  const plan = input.plan;
  writerTargetOf(input.writerUrl, plan.target);
  const readerDb = createDatabase(input.url, { max: 2 });
  const writer = postgres(input.writerUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    // The writer must land on the restricted capability: the backfill writes
    // through the same discipline the runtime executor does (T02.06).
    const identity = await writer`SELECT current_user AS role`;
    const capability = String(
      (identity[0] as { role: string } | undefined)?.role ?? "",
    );
    if (capability !== "ob_ent_auth_writer") {
      throw new Error(
        `AUTH_WRITER_CAPABILITY_REQUIRED: --writer-url dialed current_user "${capability}", not the restricted ob_ent_auth_writer capability the M2 backfill writes through.`,
      );
    }
    // The apply-time gate reads the CURRENT state, not the plan's snapshot:
    // the pause decision and the SSO precondition are judged as they are now.
    const authorityBefore = await readAuthorityRow(readerDb);
    const ssoRows = await readerDb.execute(
      sql`SELECT organization_id FROM sso_providers WHERE organization_id IS NOT NULL ORDER BY id`,
    );
    const ssoOrganizations = (
      ssoRows as unknown as Array<{ organization_id: string }>
    ).map((row) => row.organization_id);
    const globalBlockers: BackfillBlocker[] = [...plan.globalBlockers];
    for (const organization of ssoOrganizations) {
      globalBlockers.push({
        kind: "sso-provider-organization",
        subject: organization,
        detail:
          "sso_providers.organization_id is not empty: an SSO provider is already bound to an organization, and the M2 backfill refuses to run against a directory state the migration did not produce (design §9/F-02).",
      });
    }
    let paused = false;
    let pauseRefusal: string | null = null;
    if (
      authorityBefore &&
      authorityBefore.phase === "M1" &&
      authorityBefore.directoryAuthority === "legacy"
    ) {
      // The stop-write CAS: only on a fully clean gate — a global blocker
      // must not consume the pause.
      if (globalBlockers.length === 0) {
        try {
          await readerDb.transaction(async (tx) =>
            createDirectoryMigrationAuthority().pauseForBackfill(
              tx,
              authorityBefore.authorityVersion,
            ),
          );
          paused = true;
        } catch (error) {
          pauseRefusal = error instanceof Error ? error.message : String(error);
          globalBlockers.push({
            kind: "authority-state-unexpected",
            subject: "auth_authority_states",
            detail: `the stop-write CAS refused: ${pauseRefusal}`,
          });
        }
      }
    } else if (
      authorityBefore?.phase !== "M2" ||
      authorityBefore?.directoryAuthority !== "paused"
    ) {
      // Everything except the M1 origin and a paused resume — an unexpected
      // state the M2 backfill never re-plans against.
      globalBlockers.push({
        kind: "authority-state-unexpected",
        subject: "auth_authority_states",
        detail: authorityBefore
          ? `the persisted AuthorityState is (phase ${authorityBefore.phase}, authority ${authorityBefore.directoryAuthority}) at version ${authorityBefore.authorityVersion}; the M2 backfill runs only from (M1, legacy) or resumes from (M2, paused).`
          : "auth_authority_states has no row 1: the expand migrations have not seeded the M1 state.",
      });
    }
    // A (M2, paused) row is a resume: a previous run paused and did not finish;
    // the import loop below replays what committed and resumes the rest.
    if (globalBlockers.length > 0 || pauseRefusal !== null) {
      return {
        paused,
        pauseRefusal,
        backfillBlocked: true,
        globalBlockers,
        imports: [],
      };
    }
    const blockersByTenant = new Map(
      plan.blockersByTenant.map((entry) => [entry.tenantId, entry.blockers]),
    );
    const imports: TenantImportResult[] = [];
    let failedFast = false;
    for (const tenant of plan.imports) {
      if (failedFast) break;
      const blockers = blockersByTenant.get(tenant.tenantId) ?? [];
      if (blockers.length > 0) {
        imports.push({
          tenantId: tenant.tenantId,
          outcome: "blocked",
          blockers,
          organizationId: tenant.existingSlug !== null ? tenant.tenantId : null,
          slug: tenant.existingSlug,
          teamCount: tenant.teams.length,
          memberCount: tenant.members.length,
          teamMemberCount: tenant.teamMembers.length,
          commandId: tenant.commandId,
        });
        continue;
      }
      const result = await importTenant(writer, tenant);
      imports.push(result);
      // A constraint refusal (a racing writer, a drifted mapping) invalidates
      // the plan the run was built from: stop instead of importing on top of
      // a state nobody planned.
      if (result.outcome === "blocked") {
        failedFast = true;
      }
    }
    return {
      paused,
      pauseRefusal,
      backfillBlocked:
        failedFast || imports.some((result) => result.outcome === "blocked"),
      globalBlockers,
      imports,
    };
  } finally {
    await writer.end({ timeout: 5 }).catch(() => {});
    await readerDb.$client.close?.();
  }
}

// ---------------------------------------------------------------------------
// The composed run + report
// ---------------------------------------------------------------------------

export async function runMigrateDirectory(input: {
  phase: MigrateDirectoryPhase;
  apply?: boolean;
  url: string;
  writerUrl?: string;
  repositoryRoot: string;
}): Promise<MigrateDirectoryReport> {
  if (input.phase === "M1") {
    return verifyM1Expand({
      url: input.url,
      repositoryRoot: input.repositoryRoot,
    });
  }
  const plan = await planM2Backfill({
    url: input.url,
    repositoryRoot: input.repositoryRoot,
  });
  const snapshot = plan.snapshot;
  const mapping = {
    tenants: snapshot.tenants.length,
    users: snapshot.users,
    principals: snapshot.principals.length,
    memberships: snapshot.memberships.length,
    workspaces: snapshot.workspaces.length,
    teamMemberships: snapshot.teamMemberships.length,
  };
  const allTenantBlockers = plan.blockersByTenant.flatMap(
    (entry) => entry.blockers,
  );
  if (!input.apply) {
    const blockers = [...plan.globalBlockers, ...allTenantBlockers];
    const report: Omit<MigrateDirectoryReport, "digest"> = {
      schemaVersion: MIGRATE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      phase: "M2",
      mode: "dry-run",
      target: {
        endpoint: plan.target.endpoint,
        database: plan.target.database,
        expandedSchema: true,
        writerCapability: null,
      },
      expand: null,
      authority: {
        before: plan.authority,
        after: plan.authority,
        paused: false,
        pauseRefusal: null,
      },
      preconditions: {
        ssoProvidersWithOrganization: snapshot.ssoProviderOrganizations.length,
        inventoryDigest: plan.inventory.digest,
        inventoryCanMigrate: plan.inventory.canMigrate,
      },
      mapping,
      slugBackfill: {
        rules: SLUG_BACKFILL_RULES,
        plannedSlugs: plan.plannedSlugs,
      },
      blockers,
      canImport: blockers.length === 0,
      backfill: {
        backfillBlocked: blockers.length > 0,
        imports: [],
      },
      authorizationSources: plan.authorizationSources,
    };
    return { ...report, digest: digestOf(report) };
  }
  if (!input.writerUrl) {
    throw new Error(
      "--apply requires --writer-url: the M2 backfill writes through the restricted ob_ent_auth_writer capability.",
    );
  }
  const applied = await applyM2Backfill({
    plan,
    url: input.url,
    writerUrl: input.writerUrl,
  });
  const authorityAfter = await (async () => {
    const db = createDatabase(input.url, { max: 2 });
    try {
      return await readAuthorityRow(db);
    } finally {
      await db.$client.close?.();
    }
  })();
  const blockers = [...applied.globalBlockers, ...allTenantBlockers];
  const report: Omit<MigrateDirectoryReport, "digest"> = {
    schemaVersion: MIGRATE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    phase: "M2",
    mode: "apply",
    target: {
      endpoint: plan.target.endpoint,
      database: plan.target.database,
      expandedSchema: true,
      writerCapability: "ob_ent_auth_writer",
    },
    expand: null,
    authority: {
      before: plan.authority,
      after: authorityAfter,
      paused: applied.paused,
      pauseRefusal: applied.pauseRefusal,
    },
    preconditions: {
      ssoProvidersWithOrganization: snapshot.ssoProviderOrganizations.length,
      inventoryDigest: plan.inventory.digest,
      inventoryCanMigrate: plan.inventory.canMigrate,
    },
    mapping,
    slugBackfill: {
      rules: SLUG_BACKFILL_RULES,
      plannedSlugs: plan.plannedSlugs,
    },
    blockers,
    canImport: blockers.length === 0,
    backfill: {
      backfillBlocked: applied.backfillBlocked,
      imports: applied.imports,
    },
    authorizationSources: plan.authorizationSources,
  };
  return { ...report, digest: digestOf(report) };
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export function renderMigrateDirectoryReport(
  report: MigrateDirectoryReport,
): string {
  const lines: string[] = [];
  lines.push(`# T02.14 migrate-directory (${report.phase}, ${report.mode})`);
  lines.push("");
  lines.push(
    `- target: ${report.target.endpoint}/${report.target.database} (expanded schema: ${report.target.expandedSchema ? "yes" : "no"})`,
  );
  lines.push(`- digest: \`${report.digest}\``);
  if (report.expand) {
    lines.push(
      `- expand: ${report.expand.baTables}/9 tables · ${report.expand.guardTriggers}/6 guard triggers · ${report.expand.fenceTriggers}/4 fences · ${report.expand.controlledFunctions}/3 controlled functions · legacy writer ${report.expand.legacyWriterIntact ? "intact" : "BROKEN"}`,
    );
  }
  if (report.authority.before) {
    lines.push(
      `- authority: (${report.authority.before.phase}, ${report.authority.before.directoryAuthority}, v${report.authority.before.authorityVersion})` +
        (report.authority.after &&
        report.authority.after !== report.authority.before
          ? ` → (${report.authority.after.phase}, ${report.authority.after.directoryAuthority}, v${report.authority.after.authorityVersion})`
          : "") +
        (report.authority.paused ? " — this run paused directory writes" : ""),
    );
    if (report.authority.pauseRefusal) {
      lines.push(`- pause refusal: ${report.authority.pauseRefusal}`);
    }
  }
  lines.push(
    `- mapping: ${report.mapping.tenants} tenants · ${report.mapping.users} users · ${report.mapping.principals} principals · ${report.mapping.memberships} memberships · ${report.mapping.workspaces} workspaces · ${report.mapping.teamMemberships} team memberships`,
  );
  if (report.authorizationSources) {
    lines.push(
      `- authorization sources: ${report.authorizationSources.personalGrants.filter((grant) => grant.disposition === "verified-principal").length} verified / ${report.authorizationSources.personalGrants.filter((grant) => grant.disposition === "re-authorization-required").length} re-authorization-required grants · ${report.authorizationSources.gatewayKeys.filter((key) => key.disposition === "verified-generation").length} verified / ${report.authorizationSources.gatewayKeys.filter((key) => key.disposition === "re-authorization-required").length} re-authorization-required keys`,
    );
  }
  if (report.backfill) {
    const imported = report.backfill.imports.filter(
      (result) => result.outcome === "imported",
    ).length;
    const replayed = report.backfill.imports.filter(
      (result) => result.outcome === "replayed",
    ).length;
    const blocked = report.backfill.imports.filter(
      (result) => result.outcome === "blocked",
    ).length;
    lines.push(
      `- backfill: ${imported} imported · ${replayed} replayed · ${blocked} blocked${report.backfill.backfillBlocked ? " — BLOCKED" : ""}`,
    );
  }
  if (report.blockers.length) {
    lines.push("");
    lines.push(`## blockers (${report.blockers.length})`);
    const byKind = new Map<string, BackfillBlocker[]>();
    for (const blocker of report.blockers) {
      const bucket = byKind.get(blocker.kind) ?? [];
      bucket.push(blocker);
      byKind.set(blocker.kind, bucket);
    }
    for (const [kind, blockers] of [...byKind.entries()].sort()) {
      lines.push(`- ${kind} (${blockers.length}):`);
      for (const blocker of blockers.slice(0, 10)) {
        lines.push(`  - \`${blocker.subject}\``);
      }
      if (blockers.length > 10) {
        lines.push(`  - … and ${blockers.length - 10} more`);
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI (the MT001 entry model: refusals, JSON on stdout, report on stderr)
// ---------------------------------------------------------------------------

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export function parseMigrateDirectoryArgs(
  argv: readonly string[],
): MigrateDirectoryCliParse {
  const plan: MigrateDirectoryCliPlan = {
    phase: "M1",
    mode: "verify",
    url: "",
    repositoryRoot: DEFAULT_REPOSITORY_ROOT,
  };
  let apply = false;
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === "--url") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--url requires a value." };
      }
      plan.url = value;
    } else if (arg === "--phase") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--phase requires a value." };
      }
      if (value === "M1" || value === "M2") {
        plan.phase = value;
      } else if (value === "M0") {
        return {
          ok: false,
          refusal:
            "phase M0 is the read-only inventory (server/scripts/better-auth/inventory.ts, T02.13); this tool implements the M1 expand verification and the M2 stop-write backfill only.",
        };
      } else {
        return {
          ok: false,
          refusal: `phase ${value} is a later migration slice (verify-directory/cutover, T02.15/T08.01); this tool implements the M1 expand verification and the M2 stop-write backfill only.`,
        };
      }
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--writer-url") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--writer-url requires a value." };
      }
      plan.writerUrl = value;
    } else if (arg === "--repo-root") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--repo-root requires a value." };
      }
      plan.repositoryRoot = value;
    } else if (arg === "--out") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--out requires a value." };
      }
      plan.out = value;
    } else if (arg === "--report") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--report requires a value." };
      }
      plan.report = value;
    } else if (arg === "--pretty") {
      plan.pretty = true;
    } else {
      return {
        ok: false,
        refusal: `unknown argument "${arg}": migrate-directory takes --url, --phase, --apply, --writer-url, --repo-root, --out, --report and --pretty.`,
      };
    }
  }
  if (!plan.url) {
    return {
      ok: false,
      refusal:
        "an explicit target URL is required (--url <postgres URL>): migrate-directory never inherits TEST_DATABASE_URL/DATABASE_URL and never guesses a target.",
    };
  }
  if (plan.phase === "M1") {
    if (apply) {
      return {
        ok: false,
        refusal:
          "M1 is read-only: the expand verification never writes; --apply belongs to --phase M2 (the stop-write backfill).",
      };
    }
    if (plan.writerUrl !== undefined) {
      return {
        ok: false,
        refusal:
          "--writer-url is the M2 apply connection: the read-only M1 verification never uses it.",
      };
    }
    plan.mode = "verify";
  } else {
    if (apply) {
      if (!plan.writerUrl) {
        return {
          ok: false,
          refusal:
            "--apply requires --writer-url: the M2 backfill writes through the restricted ob_ent_auth_writer capability.",
        };
      }
      plan.mode = "apply";
    } else {
      if (plan.writerUrl !== undefined) {
        return {
          ok: false,
          refusal:
            "--writer-url is only read for --apply: a dry-run plans without writing (pass --apply to pause and backfill).",
        };
      }
      plan.mode = "dry-run";
    }
  }
  return { ok: true, plan };
}

const EXIT_OK = 0;
const EXIT_RUN_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_BLOCKED = 3;

async function main(): Promise<number> {
  const parsed = parseMigrateDirectoryArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.refusal}\n`);
    return EXIT_USAGE;
  }
  let report: MigrateDirectoryReport;
  try {
    report = await runMigrateDirectory({
      phase: parsed.plan.phase,
      ...(parsed.plan.mode === "apply" ? { apply: true } : {}),
      url: parsed.plan.url,
      ...(parsed.plan.writerUrl ? { writerUrl: parsed.plan.writerUrl } : {}),
      repositoryRoot: parsed.plan.repositoryRoot,
    });
  } catch (error) {
    process.stderr.write(
      `migrate-directory failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_RUN_FAILURE;
  }
  const json = JSON.stringify(report, null, parsed.plan.pretty ? 2 : undefined);
  if (parsed.plan.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(parsed.plan.out, `${json}\n`);
    process.stderr.write(`JSON written to ${parsed.plan.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  const rendered = renderMigrateDirectoryReport(report);
  if (parsed.plan.report) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(parsed.plan.report, rendered);
    process.stderr.write(`Report written to ${parsed.plan.report}\n`);
  } else {
    process.stderr.write(`${rendered}\n`);
  }
  if (report.blockers.length > 0) return EXIT_BLOCKED;
  if (report.backfill?.backfillBlocked) return EXIT_BLOCKED;
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main());
}
