/*
 * The M3 reconciliation tool (T02.15 / #537, the third slice of the original
 * P25 tooling; interfaces §1/§2/§3.3/§5.3, design §13.2 "M3 校验").
 *
 * Entry model: the MT001/inventory entry contract — a stable documented
 * output shape with schemaVersion/generatedAt/digest (the digest excludes
 * generatedAt), JSON on stdout, a human-readable report on stderr, optional
 * --out/--report files, and refusals instead of environment fall-backs. The
 * target URL is always explicit; no DSN is ever printed.
 *
 * What this tool IS: the read-only shadow reconciliation of design §13.2's
 * M3 row. Under the paused directory authority the M2 backfill produced, it
 * re-derives every legacy→BA mapping the backfill owns and compares it
 * against the live BA directory, aspect by aspect — sets and stable keys
 * (organizations, members, teams, team bindings, team members), roles, the
 * persistent versions (every expected eligibility clock exists, carries no
 * tombstone, and equals its import command's change keys), the idempotent
 * receipts, foreign-key integrity on both sides, the payer bindings the
 * migration must never rewrite, the owner every organization carried across,
 * external attribution (SSO providers stay unbound), and the §5.3
 * authorization-source dispositions. `canSwitch` answers exactly one
 * question — "is the M3→M4 cutover unblocked on what was verified" — and is
 * closed by ANY blocker: a missing clock, a drifted row, a public.auth_*
 * table outside the mapping manifest, an unclassified writer, or an
 * authority that is not the paused M2/M3 window.
 *
 * What this tool is NOT: it never writes. Not to the directory tables, not
 * to the legacy tables, not to the AuthorityState row (the authority is read
 * twice — before and after — and the report proves the row unchanged). The
 * M4 switch is T08.01's transaction: this tool has no --apply, no writer
 * URL, and refuses every phase it does not own (工具不切 M4).
 *
 * The schema mapping manifest is the closed inventory of every public.auth_*
 * table the reconciliation knows, each with the mapping role it plays. A
 * future expand that adds BA schema MUST extend this manifest first — until
 * it does, the new table is an unknown the tool refuses to vouch for
 * (新增 schema 必须扩充映射 manifest), because a switch that skipped part
 * of the directory is exactly the silent data loss this phase exists to
 * prevent.
 *
 * 用法：
 *   bun server/scripts/better-auth/verify-directory.ts --url <postgres URL> \
 *        [--tenant <tenantId>]... [--phase M3] [--repo-root <dir>] \
 *        [--out report.json] [--report report.md] [--pretty]
 *
 * Exit codes: 0 clean · 2 usage refusal · 1 run failure · 3 blocked
 * (any blocker: schema outside the manifest, a reconciliation mismatch, a
 * missing clock, an unclassified writer, or an authority outside the paused
 * M2/M3 window).
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { resolvePlannedSlugs, runM0Inventory } from "./inventory";
import type {
  AuthoritySnapshot,
  GrantDisposition,
  KeyDisposition,
} from "./migrate-directory";

export const VERIFY_SCHEMA_VERSION = 1;

/** The only phase this tool owns: the paused, read-only M3 verify window. */
export type VerifyDirectoryPhase = "M3";

export type VerifyDirectoryMode = "verify";

/**
 * The schema mapping manifest: every public.auth_* table this reconciliation
 * knows, with the mapping role it plays. `directory` rows are reconciled
 * against their legacy source; `protocol` rows are checked for internal
 * consistency (clocks against change keys, receipts finalized); `structural`
 * rows only need to exist — nothing backfills them yet. A table present on
 * the target but absent here blocks M3 until the manifest grows.
 */
export interface SchemaMappingEntry {
  readonly table: string;
  readonly role: "directory" | "protocol" | "structural";
  readonly note: string;
}

export const SCHEMA_MAPPING_MANIFEST: readonly SchemaMappingEntry[] =
  Object.freeze([
    {
      table: "auth_organizations",
      role: "directory",
      note: "legacy enterprise_tenants → organization (id = tenant_id, interfaces §2 slug)",
    },
    {
      table: "auth_teams",
      role: "directory",
      note: "legacy enterprise_workspaces → team (id = mdt-<digest>)",
    },
    {
      table: "auth_team_bindings",
      role: "directory",
      note: "legacy (tenant, workspace) → team binding triple",
    },
    {
      table: "auth_members",
      role: "directory",
      note: "legacy enterprise_memberships → member (id = md-<digest>, role map)",
    },
    {
      table: "auth_team_members",
      role: "directory",
      note: "legacy enterprise_workspace_memberships → team member (id = mdm-<digest>)",
    },
    {
      table: "auth_eligibility_clocks",
      role: "protocol",
      note: "persistent epoch/generation/tombstone the backfill advances",
    },
    {
      table: "auth_command_receipts",
      role: "protocol",
      note: "the migration actor's idempotent company-provision receipts",
    },
    {
      table: "auth_command_change_keys",
      role: "protocol",
      note: "per-command version keys the clocks must equal",
    },
    {
      table: "auth_command_outbox",
      role: "structural",
      note: "the executor's outbox; nothing backfills it yet",
    },
    {
      table: "auth_authority_states",
      role: "structural",
      note: "the AuthorityState singleton this report reads twice",
    },
    {
      table: "auth_invitations",
      role: "structural",
      note: "runtime invitations; nothing backfills them yet",
    },
    {
      table: "auth_provisioning_rules",
      role: "structural",
      note: "runtime provisioning rules; nothing backfills them yet",
    },
    {
      table: "auth_team_management_grants",
      role: "structural",
      note: "runtime team-management grants; nothing backfills them yet",
    },
    {
      table: "auth_company_session_assurances",
      role: "structural",
      note: "assurance projections; nothing backfills them yet",
    },
    {
      table: "auth_company_auth_challenges",
      role: "structural",
      note: "assurance challenges; nothing backfills them yet",
    },
  ] satisfies SchemaMappingEntry[]);

const MANIFEST_TABLES = new Set(SCHEMA_MAPPING_MANIFEST.map((e) => e.table));

export type VerifyBlockerKind =
  | "expand-stack-incomplete"
  | "schema-outside-mapping-manifest"
  | "authority-state-missing"
  | "authority-not-paused"
  | "authority-already-switched"
  | "tenant-not-backfilled"
  | "reconciliation-mismatch"
  | "eligibility-clock-missing"
  | "payer-binding-missing"
  | "sso-provider-organization"
  | "unclassified-writer";

export interface VerifyBlocker {
  readonly kind: VerifyBlockerKind;
  readonly subject: string;
  readonly detail: string;
}

/** One reconciled aspect: the counts and the drift, subject by subject. */
export interface AspectCheck {
  readonly aspect: string;
  readonly legacy: number;
  readonly ba: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly mismatched: readonly string[];
  readonly clean: boolean;
}

export interface TenantReconciliation {
  readonly tenantId: string;
  readonly outcome: "reconciled" | "not-backfilled" | "mismatched";
}

export interface VerifyDirectoryReport {
  schemaVersion: number;
  /** ISO-8601; excluded from the digest. */
  generatedAt: string;
  digest: string;
  phase: VerifyDirectoryPhase;
  mode: VerifyDirectoryMode;
  scope: {
    mode: "all-tenants" | "selected";
    tenants: readonly string[];
  };
  target: {
    endpoint: string;
    database: string;
    expandedSchema: boolean;
  };
  authority: {
    before: AuthoritySnapshot | null;
    after: AuthoritySnapshot | null;
    unchanged: boolean;
  };
  schema: {
    manifestTables: number;
    presentTables: number;
    unmappedTables: readonly string[];
    missingTables: readonly string[];
  };
  reconciliation: {
    aspects: readonly AspectCheck[];
    tenants: readonly TenantReconciliation[];
  } | null;
  inventory: {
    digest: string;
    canMigrate: boolean;
    scanMissing: readonly string[];
  } | null;
  authorizationSources: {
    personalGrants: readonly GrantDisposition[];
    gatewayKeys: readonly KeyDisposition[];
  } | null;
  blockers: readonly VerifyBlocker[];
  /** True only when the verified scope reconciled with zero blockers. */
  canSwitch: boolean;
}

export interface VerifyDirectoryInput {
  url: string;
  repositoryRoot?: string;
  /** Explicit tenant scope; omitted or empty means every tenant. */
  tenants?: readonly string[];
}

export interface VerifyDirectoryCliPlan {
  phase: VerifyDirectoryPhase;
  mode: VerifyDirectoryMode;
  url: string;
  tenants: string[];
  repositoryRoot: string;
  out?: string;
  report?: string;
  pretty: boolean;
}

export type VerifyDirectoryCliParse =
  | { ok: true; plan: VerifyDirectoryCliPlan }
  | { ok: false; refusal: string };

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_RUN_FAILURE = 1;
const EXIT_BLOCKED = 3;

// ---------------------------------------------------------------------------
// Shared derivations — must mirror migrate-directory.ts exactly. They are
// re-implemented here rather than imported because the M2 tool owns them and
// this file must not widen its surface; divergence is fail-visible, not
// fail-silent: a different derivation reconciles against different keys and
// every aspect reports the mismatch.
// ---------------------------------------------------------------------------

/**
 * The stable digest-shaped id of one backfilled entity — migrate-directory's
 * derivation, including its unit-separator (0x1f) join: the parts are hashed
 * joined by "\x1f", then prefixed. Invisible in most terminals, the separator
 * is load-bearing: without it md(a,bc) collides with md(ab,c).
 */
function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash("sha256")
    .update(parts.join("\x1f"))
    .digest("hex")
    .slice(0, 24)}`;
}

/** The legacy→BA role map of the import (migrate-directory's table). */
const LEGACY_ROLE_TO_BA: Readonly<Record<string, string>> = Object.freeze({
  tenant_admin: "owner",
  member: "member",
  auditor: "auditor",
});

function targetOf(
  url: string,
  what: string,
): { endpoint: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} must be a PostgreSQL URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error(`${what} must be a PostgreSQL URL.`);
  }
  if (!parsed.pathname.slice(1)) {
    throw new Error(`${what} must name a database.`);
  }
  return {
    endpoint: `${parsed.hostname}:${parsed.port || "5432"}`,
    database: parsed.pathname.slice(1),
  };
}

function toVersionOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

/** Deterministic JSON (sorted keys) so the digest is a pure content hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// The read model: one repeatable-read snapshot of everything both sides of
// the mapping own, taken in a single transaction so the reconciliation
// compares one database state, never a mixture.
// ---------------------------------------------------------------------------

interface DirectorySnapshot {
  tenants: ReadonlyArray<{
    tenantId: string;
    name: string;
    status: string;
    createdAt: string;
  }>;
  memberships: ReadonlyArray<{
    tenantId: string;
    principalId: string;
    userId: string;
    role: string;
    status: string;
  }>;
  workspaces: ReadonlyArray<{
    tenantId: string;
    workspaceId: string;
    name: string;
  }>;
  teamMemberships: ReadonlyArray<{
    tenantId: string;
    workspaceId: string;
    principalId: string;
    userId: string;
  }>;
  billingMappings: ReadonlyMap<
    string,
    { externalCustomerId: string; resolves: boolean }
  >;
  ssoOrganizations: readonly string[];
  grants: ReadonlyArray<{
    grantId: string;
    userId: string;
    principalId: string | null;
    identityGeneration: number | null;
    status: string;
  }>;
  keys: ReadonlyArray<{
    keyId: string;
    grantId: string;
    sourceIdentityGeneration: number | null;
    status: string;
  }>;
  organizations: ReadonlyArray<{ id: string; name: string; slug: string }>;
  members: ReadonlyArray<{
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  }>;
  teams: ReadonlyArray<{
    id: string;
    organizationId: string;
    name: string;
    memberCount: number;
  }>;
  teamBindings: ReadonlyArray<{
    tenantId: string;
    workspaceId: string;
    teamId: string;
  }>;
  teamMembers: ReadonlyArray<{ id: string; teamId: string; userId: string }>;
  clocks: ReadonlyArray<{
    tenantId: string;
    principalId: string;
    kind: string;
    scopeId: string;
    epoch: number;
    generation: number;
    tombstone: boolean;
    lastCommandId: string;
  }>;
  receipts: ReadonlyArray<{
    tenantId: string;
    commandId: string;
    idempotencyKey: string;
    finalized: boolean;
  }>;
  changeKeys: ReadonlyArray<{
    commandId: string;
    tenantId: string;
    principalId: string;
    kind: string;
    scopeId: string;
    epochAfter: number;
    generationAfter: number;
  }>;
  authTables: readonly string[];
  authority: AuthoritySnapshot | null;
}

async function readAuthorityRow(
  sql: postgres.Sql,
): Promise<AuthoritySnapshot | null> {
  const rows = (await sql`
    SELECT authority_version::text AS authority_version, phase,
           directory_authority, multi_tenant_released
      FROM auth_authority_states WHERE id = 1`) as unknown as Array<{
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

async function readDirectorySnapshot(
  sql: postgres.Sql,
): Promise<DirectorySnapshot> {
  return sql.begin(
    "isolation level repeatable read",
    async (tx): Promise<DirectorySnapshot> => {
      const tenants = (await tx`
        SELECT id AS "tenantId", name, status, created_at::text AS "createdAt"
          FROM enterprise_tenants ORDER BY id`) as unknown as DirectorySnapshot["tenants"];
      const memberships = (await tx`
        SELECT m.tenant_id AS "tenantId", m.principal_id AS "principalId",
               p.user_id AS "userId", m.role, m.status
          FROM enterprise_memberships m
          JOIN enterprise_principals p ON p.id = m.principal_id
         ORDER BY m.tenant_id, m.principal_id`) as unknown as DirectorySnapshot["memberships"];
      const workspaces = (await tx`
        SELECT tenant_id AS "tenantId", id AS "workspaceId", name
          FROM enterprise_workspaces ORDER BY tenant_id, id`) as unknown as DirectorySnapshot["workspaces"];
      const teamMemberships = (await tx`
        SELECT w.tenant_id AS "tenantId", w.workspace_id AS "workspaceId",
               w.principal_id AS "principalId", p.user_id AS "userId"
          FROM enterprise_workspace_memberships w
          JOIN enterprise_principals p ON p.id = w.principal_id
         ORDER BY w.tenant_id, w.workspace_id, w.principal_id`) as unknown as DirectorySnapshot["teamMemberships"];
      const billingRows = (await tx`
        SELECT m.tenant_id AS "tenantId", m.external_customer_id AS "externalCustomerId",
               (c.external_id IS NOT NULL) AS resolves
          FROM billing_customer_mappings m
          LEFT JOIN billing_customers c
            ON c.external_id = m.external_customer_id
         ORDER BY m.tenant_id`) as unknown as Array<{
        tenantId: string;
        externalCustomerId: string;
        resolves: boolean;
      }>;
      const sso = (await tx`
        SELECT organization_id FROM sso_providers
         WHERE organization_id IS NOT NULL ORDER BY id`) as unknown as Array<{
        organization_id: string;
      }>;
      const grants = (await tx`
        SELECT grant_id AS "grantId", user_id AS "userId", principal_id AS "principalId",
               identity_generation::text AS "identityGeneration", status
          FROM access_grants ORDER BY grant_id`) as unknown as Array<{
        grantId: string;
        userId: string;
        principalId: string | null;
        identityGeneration: string | null;
        status: string;
      }>;
      const keys = (await tx`
        SELECT id AS "keyId", grant_id AS "grantId",
               source_identity_generation::text AS "sourceIdentityGeneration", status
          FROM gateway_virtual_keys ORDER BY id`) as unknown as Array<{
        keyId: string;
        grantId: string;
        sourceIdentityGeneration: string | null;
        status: string;
      }>;
      const organizations = (await tx`
        SELECT id, name, slug FROM auth_organizations ORDER BY id`) as unknown as DirectorySnapshot["organizations"];
      const members = (await tx`
        SELECT id, organization_id AS "organizationId", user_id AS "userId", role
          FROM auth_members ORDER BY id`) as unknown as DirectorySnapshot["members"];
      const teams = (await tx`
        SELECT id, organization_id AS "organizationId", name, member_count AS "memberCount"
          FROM auth_teams ORDER BY id`) as unknown as DirectorySnapshot["teams"];
      const teamBindings = (await tx`
        SELECT tenant_id AS "tenantId", workspace_id AS "workspaceId", team_id AS "teamId"
          FROM auth_team_bindings ORDER BY tenant_id, workspace_id`) as unknown as DirectorySnapshot["teamBindings"];
      const teamMembers = (await tx`
        SELECT id, team_id AS "teamId", user_id AS "userId"
          FROM auth_team_members ORDER BY id`) as unknown as DirectorySnapshot["teamMembers"];
      const clockRows = (await tx`
        SELECT tenant_id AS "tenantId", principal_id AS "principalId", kind, scope_id AS "scopeId",
               epoch::text AS "epoch", generation::text AS "generation",
               tombstone, last_command_id AS "lastCommandId"
          FROM auth_eligibility_clocks
         ORDER BY tenant_id, principal_id, kind, scope_id`) as unknown as Array<{
        tenantId: string;
        principalId: string;
        kind: string;
        scopeId: string;
        epoch: string;
        generation: string;
        tombstone: boolean;
        lastCommandId: string;
      }>;
      const receiptRows = (await tx`
        SELECT tenant_id AS "tenantId", command_id AS "commandId",
               idempotency_key AS "idempotencyKey", finalized
          FROM auth_command_receipts
         WHERE domain = 'company' AND idempotency_key LIKE 'migrate-directory:%'
         ORDER BY tenant_id`) as unknown as Array<{
        tenantId: string;
        commandId: string;
        idempotencyKey: string;
        finalized: boolean;
      }>;
      const changeKeyRows = (await tx`
        SELECT command_id AS "commandId", tenant_id AS "tenantId",
               principal_id AS "principalId", kind, scope_id AS "scopeId",
               epoch_after::text AS "epochAfter", generation_after::text AS "generationAfter"
          FROM auth_command_change_keys
         WHERE command_id LIKE 'migrate-directory:%'
         ORDER BY command_id, principal_id, kind, scope_id`) as unknown as Array<{
        commandId: string;
        tenantId: string;
        principalId: string;
        kind: string;
        scopeId: string;
        epochAfter: string;
        generationAfter: string;
      }>;
      const authTableRows = (await tx`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'auth\\_%'
         ORDER BY table_name`) as unknown as Array<{ table_name: string }>;
      return {
        tenants,
        memberships,
        workspaces,
        teamMemberships,
        billingMappings: new Map(
          billingRows.map((row) => [
            row.tenantId,
            {
              externalCustomerId: row.externalCustomerId,
              resolves: Boolean(row.resolves),
            },
          ]),
        ),
        ssoOrganizations: sso.map((row) => String(row.organization_id)),
        grants: grants.map((grant) => ({
          grantId: grant.grantId,
          userId: grant.userId,
          principalId: grant.principalId,
          identityGeneration: toVersionOrNull(grant.identityGeneration),
          status: grant.status,
        })),
        keys: keys.map((key) => ({
          keyId: key.keyId,
          grantId: key.grantId,
          sourceIdentityGeneration: toVersionOrNull(
            key.sourceIdentityGeneration,
          ),
          status: key.status,
        })),
        organizations,
        members,
        teams,
        teamBindings,
        teamMembers,
        clocks: clockRows.map((clock) => ({
          tenantId: clock.tenantId,
          principalId: clock.principalId,
          kind: clock.kind,
          scopeId: clock.scopeId,
          epoch: toVersionOrNull(clock.epoch) ?? -1,
          generation: toVersionOrNull(clock.generation) ?? -1,
          tombstone: clock.tombstone,
          lastCommandId: clock.lastCommandId,
        })),
        receipts: receiptRows,
        changeKeys: changeKeyRows.map((key) => ({
          commandId: key.commandId,
          tenantId: key.tenantId,
          principalId: key.principalId,
          kind: key.kind,
          scopeId: key.scopeId,
          epochAfter: toVersionOrNull(key.epochAfter) ?? -1,
          generationAfter: toVersionOrNull(key.generationAfter) ?? -1,
        })),
        authTables: authTableRows.map((row) => String(row.table_name)),
        authority: await readAuthorityRow(tx),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// The reconciliation: expected side re-derived from the legacy directory,
// actual side read from BA, drift reported aspect by aspect.
// ---------------------------------------------------------------------------

function aspect(
  name: string,
  legacy: number,
  ba: number,
  missing: string[],
  extra: string[],
  mismatched: string[],
): AspectCheck {
  return {
    aspect: name,
    legacy,
    ba,
    missing,
    extra,
    mismatched,
    clean:
      missing.length === 0 && extra.length === 0 && mismatched.length === 0,
  };
}

interface Reconciliation {
  aspects: AspectCheck[];
  tenants: TenantReconciliation[];
  blockers: VerifyBlocker[];
}

function reconcile(
  snapshot: DirectorySnapshot,
  scope: readonly string[],
): Reconciliation {
  const blockers: VerifyBlocker[] = [];
  const inScope = new Set(scope);
  const scopedTenants = snapshot.tenants.filter((tenant) =>
    inScope.has(tenant.tenantId),
  );

  // The stable id universe of EVERY legacy entity — the extras test is
  // global, not scoped: a ghost row is drift no matter whose scope asked.
  const expectedMemberId = new Map<string, string>();
  const expectedTeamId = new Map<string, string>();
  const expectedTeamMemberId = new Map<string, string>();
  for (const membership of snapshot.memberships) {
    expectedMemberId.set(
      `${membership.tenantId}/${membership.userId}`,
      stableId("md", membership.tenantId, membership.userId),
    );
  }
  for (const workspace of snapshot.workspaces) {
    expectedTeamId.set(
      `${workspace.tenantId}/${workspace.workspaceId}`,
      stableId("mdt", workspace.tenantId, workspace.workspaceId),
    );
  }

  /** The team id one workspace must map to; the map is built from workspaces. */
  const teamIdOf = (tenantId: string, workspaceId: string): string => {
    const teamId = expectedTeamId.get(`${tenantId}/${workspaceId}`);
    if (teamId === undefined) {
      throw new Error(
        `no stable team id derived for ${tenantId}/${workspaceId}: the expected-id map is built from every legacy workspace, so a miss is a reconciliation bug, not a data state.`,
      );
    }
    return teamId;
  };
  for (const teamMembership of snapshot.teamMemberships) {
    expectedTeamMemberId.set(
      `${teamMembership.tenantId}/${teamMembership.workspaceId}/${teamMembership.userId}`,
      stableId(
        "mdm",
        teamMembership.tenantId,
        teamMembership.workspaceId,
        teamMembership.userId,
      ),
    );
  }

  // organizations: sets, keys (id = tenant_id), name, and the interfaces §2
  // slug the persisted-or-planned mapping resolves to.
  const orgByTenant = new Map(
    snapshot.organizations.map((org) => [org.id, org]),
  );
  const legacyTenantIds = new Set(snapshot.tenants.map((t) => t.tenantId));
  // The migration's proof of provenance: an organization row a backfill
  // receipt does not stand behind was written by someone else. Global, not
  // scoped — a racing writer's row is drift no matter whose scope asked.
  const receiptTenants = new Set(snapshot.receipts.map((r) => r.tenantId));
  const plannedSlugs = resolvePlannedSlugs(
    snapshot.tenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      name: tenant.name,
      createdAt: tenant.createdAt,
      existingSlug: orgByTenant.get(tenant.tenantId)?.slug ?? null,
    })),
  );
  const plannedSlugByTenant = new Map(
    plannedSlugs.map((slug) => [slug.tenantId, slug.plannedSlug]),
  );
  const orgMissing: string[] = [];
  const orgExtra: string[] = [];
  const orgMismatched: string[] = [];
  for (const tenant of scopedTenants) {
    const org = orgByTenant.get(tenant.tenantId);
    if (!org) {
      orgMissing.push(tenant.tenantId);
      continue;
    }
    if (org.name !== tenant.name) {
      orgMismatched.push(`${tenant.tenantId}:name`);
    }
    const planned = plannedSlugByTenant.get(tenant.tenantId);
    if (planned !== undefined && org.slug !== planned) {
      orgMismatched.push(`${tenant.tenantId}:slug`);
    }
  }
  for (const org of snapshot.organizations) {
    if (!legacyTenantIds.has(org.id)) {
      orgExtra.push(org.id);
    } else if (!receiptTenants.has(org.id)) {
      orgMismatched.push(`${org.id}:no-receipt`);
    }
  }
  const organizations = aspect(
    "organizations",
    scopedTenants.length,
    scopedTenants.filter((tenant) => orgByTenant.has(tenant.tenantId)).length,
    orgMissing,
    orgExtra,
    orgMismatched,
  );

  // members: the set and stable key of every scoped membership.
  const baMemberByOrgUser = new Map(
    snapshot.members.map((member) => [
      `${member.organizationId}/${member.userId}`,
      member,
    ]),
  );
  const legacyMembershipKeys = new Set(expectedMemberId.keys());
  const memberMissing: string[] = [];
  const memberExtra: string[] = [];
  const memberMismatched: string[] = [];
  const roleMismatched: string[] = [];
  for (const membership of snapshot.memberships) {
    const key = `${membership.tenantId}/${membership.userId}`;
    if (!inScope.has(membership.tenantId)) continue;
    const member = baMemberByOrgUser.get(key);
    if (!member) {
      memberMissing.push(key);
      continue;
    }
    if (member.id !== expectedMemberId.get(key)) {
      memberMismatched.push(`${key}:id`);
    }
    const expectedRole = LEGACY_ROLE_TO_BA[membership.role] ?? membership.role;
    if (member.role !== expectedRole) {
      roleMismatched.push(`${key}:${expectedRole}->${member.role}`);
    }
  }
  for (const [key] of baMemberByOrgUser) {
    if (!legacyMembershipKeys.has(key)) {
      memberExtra.push(key);
    }
  }
  const scopedMembershipCount = snapshot.memberships.filter((membership) =>
    inScope.has(membership.tenantId),
  ).length;
  const members = aspect(
    "members",
    scopedMembershipCount,
    snapshot.members.filter((member) => inScope.has(member.organizationId))
      .length,
    memberMissing,
    memberExtra,
    memberMismatched,
  );
  const roles = aspect(
    "roles",
    scopedMembershipCount,
    snapshot.members.filter((member) => inScope.has(member.organizationId))
      .length,
    [],
    [],
    roleMismatched,
  );

  // teams + bindings: the workspace set, its stable team id, name, and the
  // (tenant, workspace, team) binding triple.
  const teamById = new Map(snapshot.teams.map((team) => [team.id, team]));
  const teamMemberCountByTeam = new Map<string, number>();
  for (const teamMembership of snapshot.teamMemberships) {
    const teamId = expectedTeamId.get(
      `${teamMembership.tenantId}/${teamMembership.workspaceId}`,
    );
    if (teamId !== undefined) {
      teamMemberCountByTeam.set(
        teamId,
        (teamMemberCountByTeam.get(teamId) ?? 0) + 1,
      );
    }
  }
  const scopedWorkspaces = snapshot.workspaces.filter((workspace) =>
    inScope.has(workspace.tenantId),
  );
  const teamMissing: string[] = [];
  const teamExtra: string[] = [];
  const teamMismatched: string[] = [];
  for (const workspace of scopedWorkspaces) {
    const expectedId = teamIdOf(workspace.tenantId, workspace.workspaceId);
    const team = teamById.get(expectedId);
    if (!team) {
      teamMissing.push(`${workspace.tenantId}/${workspace.workspaceId}`);
      continue;
    }
    if (
      team.organizationId !== workspace.tenantId ||
      team.name !== workspace.name
    ) {
      teamMismatched.push(`${expectedId}:org-or-name`);
    }
    const expectedCount = teamMemberCountByTeam.get(expectedId) ?? 0;
    if (team.memberCount !== expectedCount) {
      teamMismatched.push(`${expectedId}:member-count`);
    }
  }
  for (const team of snapshot.teams) {
    if (![...expectedTeamId.values()].includes(team.id)) {
      teamExtra.push(team.id);
    }
  }
  const teams = aspect(
    "teams",
    scopedWorkspaces.length,
    scopedWorkspaces.filter((workspace) =>
      teamById.has(teamIdOf(workspace.tenantId, workspace.workspaceId)),
    ).length,
    teamMissing,
    teamExtra,
    teamMismatched,
  );

  const bindingByTenantWs = new Map(
    snapshot.teamBindings.map((binding) => [
      `${binding.tenantId}/${binding.workspaceId}`,
      binding,
    ]),
  );
  const legacyWorkspaceKeys = new Set(expectedTeamId.keys());
  const bindingMissing: string[] = [];
  const bindingExtra: string[] = [];
  const bindingMismatched: string[] = [];
  for (const workspace of scopedWorkspaces) {
    const key = `${workspace.tenantId}/${workspace.workspaceId}`;
    const binding = bindingByTenantWs.get(key);
    const expectedTeam = teamIdOf(workspace.tenantId, workspace.workspaceId);
    if (!binding) {
      bindingMissing.push(key);
    } else if (binding.teamId !== expectedTeam) {
      bindingMismatched.push(`${key}:${binding.teamId}`);
    }
  }
  for (const [key] of bindingByTenantWs) {
    if (!legacyWorkspaceKeys.has(key)) {
      bindingExtra.push(key);
    }
  }
  const teamBindings = aspect(
    "team-bindings",
    scopedWorkspaces.length,
    scopedWorkspaces.filter((workspace) =>
      bindingByTenantWs.has(`${workspace.tenantId}/${workspace.workspaceId}`),
    ).length,
    bindingMissing,
    bindingExtra,
    bindingMismatched,
  );

  // team members: the workspace-membership set and its stable team-member id.
  const baTeamMemberByTeamUser = new Map(
    snapshot.teamMembers.map((teamMember) => [
      `${teamMember.teamId}/${teamMember.userId}`,
      teamMember,
    ]),
  );
  const legacyTeamMemberUniverse = new Set<string>();
  for (const teamMembership of snapshot.teamMemberships) {
    const teamId = expectedTeamId.get(
      `${teamMembership.tenantId}/${teamMembership.workspaceId}`,
    );
    legacyTeamMemberUniverse.add(`${teamId}/${teamMembership.userId}`);
  }
  const teamMemberMissing: string[] = [];
  const teamMemberExtra: string[] = [];
  const teamMemberMismatched: string[] = [];
  for (const teamMembership of snapshot.teamMemberships) {
    if (!inScope.has(teamMembership.tenantId)) continue;
    const teamId = expectedTeamId.get(
      `${teamMembership.tenantId}/${teamMembership.workspaceId}`,
    );
    const key = `${teamId}/${teamMembership.userId}`;
    const row = baTeamMemberByTeamUser.get(key);
    const expectedId = expectedTeamMemberId.get(
      `${teamMembership.tenantId}/${teamMembership.workspaceId}/${teamMembership.userId}`,
    );
    if (!row) {
      teamMemberMissing.push(
        `${teamMembership.tenantId}/${teamMembership.workspaceId}/${teamMembership.userId}`,
      );
    } else if (row.id !== expectedId) {
      teamMemberMismatched.push(`${key}:id`);
    }
  }
  for (const [key] of baTeamMemberByTeamUser) {
    if (!legacyTeamMemberUniverse.has(key)) {
      teamMemberExtra.push(key);
    }
  }
  const scopedTeamMembershipCount = snapshot.teamMemberships.filter(
    (teamMembership) => inScope.has(teamMembership.tenantId),
  ).length;
  const scopedTeams = new Set(
    scopedWorkspaces.map((workspace) =>
      teamIdOf(workspace.tenantId, workspace.workspaceId),
    ),
  );
  const teamMembers = aspect(
    "team-members",
    scopedTeamMembershipCount,
    snapshot.teamMembers.filter((teamMember) =>
      scopedTeams.has(teamMember.teamId),
    ).length,
    teamMemberMissing,
    teamMemberExtra,
    teamMemberMismatched,
  );

  // versions: every expected clock exists, carries no tombstone, and equals
  // its import command's change keys (company per membership, team per
  // workspace membership). A missing clock is its own blocker kind — the
  // M3→M4 switch must never be vouched for over a lost version.
  const clockByKey = new Map(
    snapshot.clocks.map((clock) => [
      `${clock.tenantId}/${clock.principalId}/${clock.kind}/${clock.scopeId}`,
      clock,
    ]),
  );
  const changeKeyByKey = new Map(
    snapshot.changeKeys.map((key) => [
      `${key.tenantId}/${key.principalId}/${key.kind}/${key.scopeId}`,
      key,
    ]),
  );
  const versionMissing: string[] = [];
  const versionExtra: string[] = [];
  const versionMismatched: string[] = [];
  const expectedClockKeys = new Set<string>();
  const expectedClocks: Array<{
    key: string;
    subject: string;
    tenantId: string;
    principalId: string;
    kind: string;
    scopeId: string;
  }> = [];
  for (const membership of snapshot.memberships) {
    expectedClocks.push({
      key: `${membership.tenantId}/${membership.principalId}/company/${membership.tenantId}`,
      subject: `company ${membership.tenantId}/${membership.principalId}`,
      tenantId: membership.tenantId,
      principalId: membership.principalId,
      kind: "company",
      scopeId: membership.tenantId,
    });
  }
  for (const teamMembership of snapshot.teamMemberships) {
    expectedClocks.push({
      key: `${teamMembership.tenantId}/${teamMembership.principalId}/team/${teamMembership.workspaceId}`,
      subject: `team ${teamMembership.tenantId}/${teamMembership.principalId}/${teamMembership.workspaceId}`,
      tenantId: teamMembership.tenantId,
      principalId: teamMembership.principalId,
      kind: "team",
      scopeId: teamMembership.workspaceId,
    });
  }
  for (const expected of expectedClocks) {
    expectedClockKeys.add(expected.key);
    if (!inScope.has(expected.tenantId)) continue;
    const clock = clockByKey.get(expected.key);
    if (!clock) {
      versionMissing.push(expected.subject);
      blockers.push({
        kind: "eligibility-clock-missing",
        subject: expected.subject,
        detail: `the persistent version of a backfilled member is missing: no auth_eligibility_clocks row for ${expected.subject}; the M3→M4 switch is blocked rather than vouched for over a lost epoch/generation.`,
      });
      continue;
    }
    const commandId = `migrate-directory:${expected.tenantId}`;
    const changeKey = changeKeyByKey.get(expected.key);
    if (
      !changeKey ||
      changeKey.commandId !== commandId ||
      clock.epoch !== changeKey.epochAfter ||
      clock.generation !== changeKey.generationAfter ||
      clock.tombstone ||
      clock.lastCommandId !== commandId
    ) {
      versionMismatched.push(expected.subject);
    }
  }
  for (const clock of snapshot.clocks) {
    if (!inScope.has(clock.tenantId)) continue;
    const key = `${clock.tenantId}/${clock.principalId}/${clock.kind}/${clock.scopeId}`;
    if (!expectedClockKeys.has(key)) {
      versionExtra.push(
        `${clock.kind} ${clock.tenantId}/${clock.principalId}/${clock.scopeId}`,
      );
    }
  }
  const scopedExpectedClocks = expectedClocks.filter((clock) =>
    inScope.has(clock.tenantId),
  );
  const versions = aspect(
    "versions",
    scopedExpectedClocks.length,
    snapshot.clocks.filter((clock) => inScope.has(clock.tenantId)).length,
    versionMissing,
    versionExtra,
    versionMismatched,
  );

  // receipts: every scoped backfilled tenant's import command finalized
  // exactly once under its stable idempotency key.
  const receiptByTenant = new Map(
    snapshot.receipts.map((receipt) => [receipt.tenantId, receipt]),
  );
  const receiptMissing: string[] = [];
  const receiptMismatched: string[] = [];
  for (const tenant of scopedTenants) {
    const receipt = receiptByTenant.get(tenant.tenantId);
    if (!receipt) {
      receiptMissing.push(tenant.tenantId);
      continue;
    }
    if (
      !receipt.finalized ||
      receipt.commandId !== `migrate-directory:${tenant.tenantId}` ||
      receipt.idempotencyKey !== `migrate-directory:company:${tenant.tenantId}`
    ) {
      receiptMismatched.push(tenant.tenantId);
    }
  }
  const receipts = aspect(
    "receipts",
    scopedTenants.length,
    scopedTenants.filter((tenant) => receiptByTenant.has(tenant.tenantId))
      .length,
    receiptMissing,
    [],
    receiptMismatched,
  );

  // foreign keys: both sides of every mapping reference an existing parent —
  // the deferred fences refuse orphans at write time; M3 re-checks the fact.
  const fkChecks: Array<{
    child: string;
    rows: readonly { subject: string; orphan: boolean }[];
  }> = [];
  {
    const users = new Set<string>(); // legacy user ids via memberships' users
    for (const membership of snapshot.memberships) {
      users.add(membership.userId);
    }
    for (const teamMembership of snapshot.teamMemberships) {
      users.add(teamMembership.userId);
    }
    const principals = new Set<string>(); // legacy principal ids
    for (const membership of snapshot.memberships) {
      principals.add(membership.principalId);
    }
    const fk = (
      child: string,
      rows: readonly { subject: string; orphan: boolean }[],
    ): void => {
      fkChecks.push({ child, rows });
    };
    fk(
      "auth_members",
      snapshot.members.map((member) => ({
        subject: `auth_members:${member.id}`,
        orphan:
          !legacyTenantIds.has(member.organizationId) ||
          !users.has(member.userId),
      })),
    );
    fk(
      "auth_teams",
      snapshot.teams.map((team) => ({
        subject: `auth_teams:${team.id}`,
        orphan: !legacyTenantIds.has(team.organizationId),
      })),
    );
    const teamIds = new Set(snapshot.teams.map((team) => team.id));
    fk(
      "auth_team_bindings",
      snapshot.teamBindings.map((binding) => ({
        subject: `auth_team_bindings:${binding.tenantId}/${binding.workspaceId}`,
        orphan:
          !legacyTenantIds.has(binding.tenantId) ||
          !teamIds.has(binding.teamId),
      })),
    );
    fk(
      "auth_team_members",
      snapshot.teamMembers.map((teamMember) => ({
        subject: `auth_team_members:${teamMember.id}`,
        orphan:
          !teamIds.has(teamMember.teamId) || !users.has(teamMember.userId),
      })),
    );
    fk(
      "auth_eligibility_clocks",
      snapshot.clocks.map((clock) => ({
        subject: `auth_eligibility_clocks:${clock.tenantId}/${clock.principalId}/${clock.kind}/${clock.scopeId}`,
        orphan:
          !legacyTenantIds.has(clock.tenantId) ||
          !principals.has(clock.principalId),
      })),
    );
  }
  const fkOrphans = fkChecks.flatMap((check) =>
    check.rows.filter((row) => row.orphan).map((row) => row.subject),
  );
  const fkRows = fkChecks.reduce(
    (total, check) => total + check.rows.length,
    0,
  );
  const foreignKeys = aspect(
    "foreign-keys",
    fkRows,
    fkRows - fkOrphans.length,
    [],
    [],
    fkOrphans,
  );

  // payer: the historical billing binding of every backfilled company is
  // still present and still resolves — the migration never rewrites its own
  // input.
  const payerCandidates = scopedTenants.filter(
    (tenant) =>
      orgByTenant.has(tenant.tenantId) || receiptByTenant.has(tenant.tenantId),
  );
  const payerMissing: string[] = [];
  for (const tenant of payerCandidates) {
    const mapping = snapshot.billingMappings.get(tenant.tenantId);
    if (!mapping?.resolves) {
      payerMissing.push(tenant.tenantId);
      blockers.push({
        kind: "payer-binding-missing",
        subject: tenant.tenantId,
        detail: `the payer binding of ${tenant.tenantId} did not survive reconciliation: ${
          mapping
            ? `billing_customers has no row for external id ${mapping.externalCustomerId}`
            : "no billing_customer_mappings row exists"
        }; the M3 verify refuses to vouch for a company whose historical payer is gone.`,
      });
    }
  }
  const payer = aspect(
    "payer",
    payerCandidates.length,
    payerCandidates.length - payerMissing.length,
    payerMissing,
    [],
    [],
  );

  // owner: every company that had a tenant_admin carried it across as an
  // owner — the org is never left without its administrator.
  const ownerMissing: string[] = [];
  const ownerMismatched: string[] = [];
  let legacyOwners = 0;
  let baOwners = 0;
  for (const tenant of payerCandidates) {
    const legacyAdmins = snapshot.memberships.filter(
      (membership) =>
        membership.tenantId === tenant.tenantId &&
        membership.role === "tenant_admin",
    ).length;
    const baOwnerMembers = snapshot.members.filter(
      (member) =>
        member.organizationId === tenant.tenantId && member.role === "owner",
    ).length;
    legacyOwners += legacyAdmins;
    baOwners += baOwnerMembers;
    if (legacyAdmins > 0 && baOwnerMembers === 0) {
      ownerMissing.push(tenant.tenantId);
    } else if (legacyAdmins !== baOwnerMembers) {
      ownerMismatched.push(
        `${tenant.tenantId}:${legacyAdmins}->${baOwnerMembers}`,
      );
    }
  }
  const owner = aspect(
    "owner",
    legacyOwners,
    baOwners,
    ownerMissing,
    [],
    ownerMismatched,
  );

  // 外部归属: the M2 gate's precondition still holds — no SSO provider is
  // bound to an organization.
  const ssoMismatched = [...new Set(snapshot.ssoOrganizations)];
  for (const organization of ssoMismatched) {
    blockers.push({
      kind: "sso-provider-organization",
      subject: organization,
      detail: `an SSO provider is bound to organization ${organization}: the external-attribution precondition of the M2 gate no longer holds on this directory, and the M3 verify blocks rather than reconciles a state the migration did not produce.`,
    });
  }
  const externalAttribution = aspect(
    "external-attribution",
    0,
    ssoMismatched.length,
    [],
    [],
    ssoMismatched,
  );

  const aspects = [
    organizations,
    members,
    teams,
    teamBindings,
    teamMembers,
    roles,
    versions,
    receipts,
    foreignKeys,
    payer,
    owner,
    externalAttribution,
  ];
  for (const check of aspects) {
    if (!check.clean) {
      blockers.push({
        kind: "reconciliation-mismatch",
        subject: check.aspect,
        detail: `aspect "${check.aspect}" drifted: legacy=${check.legacy} ba=${check.ba} missing=${check.missing.length} extra=${check.extra.length} mismatched=${check.mismatched.length} (${[
          ...check.missing,
          ...check.extra,
          ...check.mismatched,
        ]
          .slice(0, 5)
          .join("; ")}${missing_total(check) > 5 ? " …" : ""}).`,
      });
    }
  }

  // Tenant outcomes: a tenant with neither organization nor receipt was
  // never backfilled (one honest blocker, nothing to reconcile); a tenant
  // any scoped aspect flagged is mismatched; the rest reconciled.
  const dirtyTenants = new Set<string>();
  for (const subject of [
    ...memberMissing,
    ...roleMismatched,
    ...teamMemberMissing,
    ...versionMissing,
    ...versionMismatched,
  ]) {
    const tenant = subject
      .split(/[/ ]/)
      .find((part) => part && legacyTenantIds.has(part));
    if (tenant) dirtyTenants.add(tenant);
  }
  for (const tenant of orgMissing) dirtyTenants.add(tenant);
  for (const tenant of receiptMissing) dirtyTenants.add(tenant);
  for (const tenant of payerMissing) dirtyTenants.add(tenant);
  for (const tenant of ownerMissing) dirtyTenants.add(tenant);
  const tenants: TenantReconciliation[] = scopedTenants.map((tenant) => {
    const backfilled =
      orgByTenant.has(tenant.tenantId) || receiptByTenant.has(tenant.tenantId);
    if (!backfilled) {
      blockers.push({
        kind: "tenant-not-backfilled",
        subject: tenant.tenantId,
        detail: `tenant ${tenant.tenantId} has neither an auth_organizations row nor a migration receipt: the M2 backfill did not import it (its blockers are the M0 inventory's verdict), so nothing on this tenant may be vouched for.`,
      });
      return { tenantId: tenant.tenantId, outcome: "not-backfilled" };
    }
    return {
      tenantId: tenant.tenantId,
      outcome: dirtyTenants.has(tenant.tenantId) ? "mismatched" : "reconciled",
    };
  });

  return { aspects, tenants, blockers };
}

function missing_total(check: AspectCheck): number {
  return check.missing.length + check.extra.length + check.mismatched.length;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export async function runVerifyDirectory(
  input: VerifyDirectoryInput,
): Promise<VerifyDirectoryReport> {
  const target = targetOf(input.url, "the target URL");
  const sql = postgres(input.url, {
    max: 2,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    const snapshot = await readDirectorySnapshot(sql);
    const authorityBefore = snapshot.authority;
    const presentAuthTables = snapshot.authTables.filter((table) =>
      MANIFEST_TABLES.has(table),
    );
    const unmappedTables = snapshot.authTables.filter(
      (table) => !MANIFEST_TABLES.has(table),
    );
    const missingTables = SCHEMA_MAPPING_MANIFEST.filter(
      (entry) => !snapshot.authTables.includes(entry.table),
    ).map((entry) => entry.table);

    const blockers: VerifyBlocker[] = [];
    for (const table of missingTables) {
      blockers.push({
        kind: "expand-stack-incomplete",
        subject: table,
        detail: `manifest table ${table} does not exist on the target: the M3 reconciliation runs only on the full expand stack (run migrate-directory --phase M1 for the read-only diagnosis).`,
      });
    }
    for (const table of unmappedTables) {
      blockers.push({
        kind: "schema-outside-mapping-manifest",
        subject: table,
        detail: `public.${table} exists but is not in verify-directory's schema mapping manifest: a schema the reconciliation does not know blocks M3 until the manifest is extended — never a silent pass over part of the directory.`,
      });
    }

    let reconciliation: Reconciliation | null = null;
    if (missingTables.length === 0) {
      const scope =
        input.tenants && input.tenants.length > 0
          ? [...new Set(input.tenants)].sort()
          : snapshot.tenants.map((tenant) => tenant.tenantId).sort();
      reconciliation = reconcile(snapshot, scope);
      blockers.push(...reconciliation.blockers);
    }

    // The M0 inventory provenance: the unclassified-writer scan must still
    // be empty — a writer that appeared since M2 is drift the M4 switch
    // would inherit silently.
    let inventory: VerifyDirectoryReport["inventory"] = null;
    if (input.repositoryRoot) {
      const report = await runM0Inventory({
        url: input.url,
        phase: "M0",
        repositoryRoot: input.repositoryRoot,
      });
      inventory = {
        digest: report.digest,
        canMigrate: report.canMigrate,
        scanMissing: [...report.legacyWriters.scan.missing],
      };
      for (const file of report.legacyWriters.scan.missing) {
        blockers.push({
          kind: "unclassified-writer",
          subject: file,
          detail: `the writer scan found a directory-table writer outside the static list (${file}); classify it with a disposal phase or remove the write before the switch.`,
        });
      }
    }

    // The authority gate: reconciliation is only vouched for under the
    // paused M2/M3 window. Legacy means the backfill never paused writes;
    // ba means the cutover already happened — both close canSwitch, and
    // neither is re-planned around.
    if (!authorityBefore) {
      blockers.push({
        kind: "authority-state-missing",
        subject: "auth_authority_states",
        detail:
          "the AuthorityState row is missing: no state is ever guessed as legacy or paused, and nothing may be vouched for without it.",
      });
    } else if (authorityBefore.directoryAuthority === "legacy") {
      blockers.push({
        kind: "authority-not-paused",
        subject: `${authorityBefore.phase}/legacy`,
        detail: `the directory authority is (${authorityBefore.phase}, legacy) at version ${authorityBefore.authorityVersion}: the M2 stop-write backfill has not paused directory writes, so the M3 reconciliation refuses to vouch for a switch over an unpaused directory.`,
      });
    } else if (authorityBefore.directoryAuthority === "ba") {
      blockers.push({
        kind: "authority-already-switched",
        subject: `${authorityBefore.phase}/ba`,
        detail: `the directory authority is (${authorityBefore.phase}, ba) at version ${authorityBefore.authorityVersion}: the M4 cutover already happened, and this tool never performs or undoes it — the M3 reconciliation of a pre-switch state is refused.`,
      });
    }

    // Read-only proof: the row after the run is the row before it.
    const authorityAfter = await readAuthorityRow(sql);

    const authorizationSources = {
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
    };

    const generatedAt = new Date().toISOString();
    const report: Omit<VerifyDirectoryReport, "digest"> = {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      generatedAt,
      phase: "M3",
      mode: "verify",
      scope:
        input.tenants && input.tenants.length > 0
          ? {
              mode: "selected",
              tenants: [...new Set(input.tenants)].sort(),
            }
          : { mode: "all-tenants", tenants: [] },
      target: {
        ...target,
        expandedSchema:
          presentAuthTables.length === SCHEMA_MAPPING_MANIFEST.length,
      },
      authority: {
        before: authorityBefore,
        after: authorityAfter,
        unchanged:
          stableStringify(authorityBefore) === stableStringify(authorityAfter),
      },
      schema: {
        manifestTables: SCHEMA_MAPPING_MANIFEST.length,
        presentTables: presentAuthTables.length,
        unmappedTables,
        missingTables,
      },
      reconciliation: reconciliation
        ? {
            aspects: reconciliation.aspects,
            tenants: reconciliation.tenants,
          }
        : null,
      inventory,
      authorizationSources,
      blockers,
      canSwitch: blockers.length === 0,
    };
    return {
      ...report,
      digest: createHash("sha256")
        .update(stableStringify({ ...report, generatedAt: undefined }))
        .digest("hex"),
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export function renderVerifyDirectoryReport(
  report: VerifyDirectoryReport,
): string {
  const lines: string[] = [];
  lines.push(`# T02.15 verify-directory (${report.phase}, ${report.mode})`);
  lines.push("");
  lines.push(
    `- target: ${report.target.endpoint}/${report.target.database} (expanded schema: ${report.target.expandedSchema ? "yes" : "no"})`,
  );
  lines.push(
    `- scope: ${report.scope.mode}${report.scope.mode === "selected" ? ` (${report.scope.tenants.join(", ")})` : ""}`,
  );
  lines.push(`- digest: \`${report.digest}\``);
  if (report.authority.before) {
    lines.push(
      `- authority: (${report.authority.before.phase}, ${report.authority.before.directoryAuthority}, v${report.authority.before.authorityVersion})${report.authority.unchanged ? " — unchanged by this run" : " — CHANGED by this run (read-only violation)"}`,
    );
  } else {
    lines.push("- authority: MISSING (no AuthorityState row)");
  }
  lines.push(
    `- schema manifest: ${report.schema.presentTables}/${report.schema.manifestTables} present` +
      (report.schema.unmappedTables.length
        ? ` · unmapped: ${report.schema.unmappedTables.join(", ")}`
        : "") +
      (report.schema.missingTables.length
        ? ` · missing: ${report.schema.missingTables.join(", ")}`
        : ""),
  );
  if (report.reconciliation) {
    lines.push("- reconciliation:");
    for (const aspect of report.reconciliation.aspects) {
      lines.push(
        `  - ${aspect.aspect}: legacy=${aspect.legacy} ba=${aspect.ba} ${aspect.clean ? "✓" : `✗ missing=${aspect.missing.length} extra=${aspect.extra.length} mismatched=${aspect.mismatched.length}`}`,
      );
    }
    const outcomes = report.reconciliation.tenants.reduce(
      (counts, tenant) => {
        counts[tenant.outcome] = (counts[tenant.outcome] ?? 0) + 1;
        return counts;
      },
      {} as Record<string, number>,
    );
    lines.push(
      `  - tenants: ${Object.entries(outcomes)
        .map(([outcome, count]) => `${count} ${outcome}`)
        .join(" · ")}`,
    );
  } else {
    lines.push("- reconciliation: skipped (expand stack incomplete)");
  }
  if (report.inventory) {
    lines.push(
      `- inventory: digest \`${report.inventory.digest.slice(0, 12)}…\` · canMigrate=${report.inventory.canMigrate} · unclassified writers=${report.inventory.scanMissing.length}`,
    );
  }
  if (report.authorizationSources) {
    lines.push(
      `- authorization sources: ${report.authorizationSources.personalGrants.filter((grant) => grant.disposition === "verified-principal").length}/${report.authorizationSources.personalGrants.length} grants verified · ${report.authorizationSources.gatewayKeys.filter((key) => key.disposition === "verified-generation").length}/${report.authorizationSources.gatewayKeys.length} keys verified (the rest require re-authorization; revocation is T08.02/T08.03)`,
    );
  }
  lines.push(
    `- canSwitch: ${report.canSwitch ? "READY (M4 unblocked on this scope)" : "CLOSED"}`,
  );
  if (report.blockers.length) {
    lines.push(`- blockers (${report.blockers.length}):`);
    for (const blocker of report.blockers.slice(0, 30)) {
      lines.push(`  - [${blocker.kind}] ${blocker.subject}`);
    }
    if (report.blockers.length > 30) {
      lines.push(`  - … ${report.blockers.length - 30} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

export function parseVerifyDirectoryArgs(
  argv: readonly string[],
): VerifyDirectoryCliParse {
  const plan: VerifyDirectoryCliPlan = {
    phase: "M3",
    mode: "verify",
    url: "",
    tenants: [],
    repositoryRoot: DEFAULT_REPOSITORY_ROOT,
    pretty: false,
  };
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
    } else if (arg === "--tenant") {
      const value = rest.shift();
      if (value === undefined || !value.trim()) {
        return { ok: false, refusal: "--tenant requires a tenant id value." };
      }
      plan.tenants.push(value.trim());
    } else if (arg === "--phase") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--phase requires a value." };
      }
      if (value === "M3") {
        plan.phase = value;
      } else if (value === "M0") {
        return {
          ok: false,
          refusal: `phase M0 is the read-only inventory (server/scripts/better-auth/inventory.ts, T02.13); verify-directory implements the M3 reconciliation only.`,
        };
      } else if (value === "M1" || value === "M2") {
        return {
          ok: false,
          refusal: `phase ${value} belongs to migrate-directory (server/scripts/better-auth/migrate-directory.ts, T02.14: the M1 expand verification and the M2 stop-write backfill); verify-directory implements the M3 reconciliation only.`,
        };
      } else {
        return {
          ok: false,
          refusal: `phase ${value} is the cutover's territory (T08.01: the M3→M4 atomic authority switch); verify-directory never switches M4 and implements the M3 reconciliation only.`,
        };
      }
    } else if (arg === "--apply") {
      return {
        ok: false,
        refusal:
          "the M3 verification is read-only: there is nothing to apply — the shadow reconciliation writes nothing, and the M4 switch is T08.01's transaction, not an argument away.",
      };
    } else if (arg === "--writer-url") {
      return {
        ok: false,
        refusal:
          "--writer-url is the M2 backfill's apply connection (migrate-directory); the read-only M3 verification never uses a writer URL.",
      };
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
        refusal: `unknown argument "${arg}": verify-directory takes --url, --tenant, --phase, --repo-root, --out, --report and --pretty.`,
      };
    }
  }
  if (!plan.url) {
    return {
      ok: false,
      refusal:
        "an explicit target URL is required (--url <postgres URL>): verify-directory never inherits TEST_DATABASE_URL/DATABASE_URL and never guesses a target.",
    };
  }
  return { ok: true, plan };
}

async function main(): Promise<number> {
  const parsed = parseVerifyDirectoryArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.refusal}\n`);
    return EXIT_USAGE;
  }
  let report: VerifyDirectoryReport;
  try {
    report = await runVerifyDirectory({
      url: parsed.plan.url,
      repositoryRoot: parsed.plan.repositoryRoot,
      ...(parsed.plan.tenants.length ? { tenants: parsed.plan.tenants } : {}),
    });
  } catch (error) {
    process.stderr.write(
      `verify-directory failed: ${error instanceof Error ? error.message : String(error)}\n`,
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
  const rendered = renderVerifyDirectoryReport(report);
  if (parsed.plan.report) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(parsed.plan.report, rendered);
    process.stderr.write(`Report written to ${parsed.plan.report}\n`);
  } else {
    process.stderr.write(`${rendered}\n`);
  }
  if (report.blockers.length > 0) return EXIT_BLOCKED;
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main());
}
