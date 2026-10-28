/*
 * The M0 read-only directory and authority-source inventory (T02.13 / #535,
 * the first slice of the original P25 tooling; interfaces §1/§2/§3.3, plan
 * Task 25, root Spec "M0 只读盘点").
 *
 * Entry model: this CLI follows the MT001 inventory entry contract
 * (server/scripts/multitenancy/inventory.ts) — a stable documented output
 * shape with schemaVersion/generatedAt/digest (the digest excludes
 * generatedAt, so two runs over the same database state produce the same
 * digest), JSON on stdout, a human-readable report on stderr, optional
 * --out/--report files, and refusals instead of environment fall-backs. The
 * BA-specific output is added on top of that model; the field names below
 * are the contract the later P25/P22 slices consume, 勿私自改字段名.
 *
 * What this CLI is: a strictly read-only inventory of ONE explicitly named
 * isolated enterprise PostgreSQL target, taken before any migration phase
 * runs. It reports the stable user/principal/company/team mapping, each
 * company's owner and payer, the personal model Grant/Key authorization
 * sources with their verifiable generations (or the recorded gap), the
 * known revocation high-watermark, and the BA organization.slug backfill
 * plan under the interfaces §2 rules. It reads no secret columns, sends no
 * notifications, and performs no repair: every statement runs inside one
 * `SET TRANSACTION READ ONLY` transaction, so PostgreSQL itself refuses an
 * accidental write (SQLSTATE 25006) instead of the CLI promising not to.
 *
 * Alongside the database inventory it carries the legacy directory-writer
 * static list (UI/API, CLI, SCIM, JIT, startup and the non-route writers),
 * each entry naming its disposal phase, and a source scan that finds every
 * file still writing the five legacy directory tables. A writer the scan
 * finds outside the list is an unclassified writer: the report blocks on it
 * and the CLI exits non-zero — nobody's favourite new route can quietly grow
 * a second directory write authority.
 *
 * Phases: this slice implements M0 only. `--phase M1|M2|M3` is refused here;
 * those tools are the later P25 slices (migrate-directory / verify-directory,
 * interfaces §1) and there is deliberately no `--apply`: M0 is read-only by
 * construction.
 *
 * 用法：
 *   bun server/scripts/better-auth/inventory.ts --url <postgres URL> \
 *        [--phase M0] [--repo-root <dir>] [--out inventory.json] \
 *        [--report inventory.md] [--pretty]
 *
 * Exit codes: 0 report clean · 2 usage refusal · 1 run failure ·
 * 3 data blockers (unknown owner/payer/generation, …) · 4 unclassified
 * writer found by the scan.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

export const SCHEMA_VERSION = 1;

/** The only phase this tool implements (interfaces §3.3: M0/M1 legacy). */
export type InventoryPhase = "M0";

/** The disposal family a legacy directory writer belongs to. */
export type LegacyWriterFamily =
  | "ui-api"
  | "cli"
  | "scim"
  | "jit"
  | "startup"
  | "non-route";

/**
 * One legacy directory writer: a production source file that writes one of
 * the five legacy directory tables, the family it entered through, whether
 * an HTTP route reaches it, the tables it writes, and the phase at which its
 * write path is stopped or replaced.
 */
export interface LegacyDirectoryWriter {
  /** Stable slug id for the entry. */
  id: string;
  /** Repo-relative path; null only for a declared family with no writer today. */
  file: string | null;
  family: LegacyWriterFamily;
  /** True when an HTTP route reaches this writer directly. */
  route: boolean;
  /** The legacy directory tables this file writes. */
  tables: readonly string[];
  /** When the write path is paused / replaced, and by what. */
  disposalPhase: string;
  note: string;
}

/** The scan's verdict over the repository: what it walked and what it found. */
export interface LegacyWriterScan {
  scannedRoots: readonly string[];
  /** Every file the scan found writing a legacy directory table. */
  writers: readonly { file: string; tables: readonly string[] }[];
  /** Found files absent from LEGACY_DIRECTORY_WRITERS — each one blocks. */
  missing: readonly string[];
  /** Listed files the scan no longer finds writing (informational). */
  stale: readonly string[];
  /** Paths the scan deliberately does not classify, and why. */
  exclusions: readonly { path: string; reason: string }[];
}

/** interfaces §2's slug backfill rules, recorded as data the report carries. */
export interface SlugBackfillRules {
  normalization: readonly string[];
  emptyFallback: string;
  collision: string;
  idempotency: string;
  uniqueConflict: string;
}

/** One tenant's planned BA organization slug (interfaces §2). */
export interface PlannedSlug {
  tenantId: string;
  name: string;
  plannedSlug: string;
  /** The numeric suffix appended for a collision; null when the base slug won. */
  collisionSuffix: number | null;
  /** The persisted auth_organizations.slug when one exists; the plan never re-derives it. */
  existingSlug: string | null;
}

/** The stable mapping the inventory reports; ids are never re-invented. */
export interface UserMapping {
  userId: string;
  principalId: string | null;
  identityGeneration: number | null;
}

export interface CompanyMapping {
  tenantId: string;
  name: string;
  status: string;
  /** The BA organization id when the backfill already ran; null before it. */
  organizationId: string | null;
  ownerPrincipalIds: readonly string[];
  memberPrincipalIds: readonly string[];
  payer: {
    externalCustomerId: string | null;
    payerAccountId: string | null;
  };
}

export interface TeamMapping {
  tenantId: string;
  workspaceId: string;
  name: string;
  /** The bound BA team id when the backfill already ran; null before it. */
  teamId: string | null;
}

export interface MembershipMapping {
  tenantId: string;
  principalId: string;
  userId: string | null;
  role: string;
  status: string;
  epoch: number;
}

export interface TeamMembershipMapping {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  userId: string | null;
  status: string;
  epoch: number;
}

/** One personal model Grant with its verifiable source, or the recorded gap. */
export interface PersonalGrantSource {
  grantId: string;
  userId: string;
  principalId: string | null;
  identityGeneration: number | null;
  status: string;
  source: "verified-principal" | "missing";
}

/** One gateway key with the source generation it was minted under, or the gap. */
export interface GatewayKeySource {
  keyId: string;
  grantId: string;
  sourceIdentityGeneration: number | null;
  status: string;
  source: "verified-generation" | "missing";
}

/** The known revocation boundary: facts recorded after it are unknown to this inventory. */
export interface RevocationHighWatermark {
  securityEvents: {
    count: number;
    latestAt: string | null;
    latestEventId: string | null;
  };
  suspendedMemberships: number;
  suspendedTeamMemberships: number;
  maxMembershipEpoch: number | null;
}

export type InventoryBlockerKind =
  | "unknown-owner"
  | "unknown-payer"
  | "unknown-generation"
  | "duplicate-relationship"
  | "unclassified-writer"
  | "slug-mapping-conflict";

export interface InventoryBlocker {
  kind: InventoryBlockerKind;
  /** The tenant/principal/user/file the blocker is about. */
  subject: string;
  detail: string;
}

/** The full M0 inventory report; `canMigrate` is false iff `blockers` is non-empty. */
export interface InventoryReport {
  schemaVersion: number;
  /** ISO-8601; not part of the digest. */
  generatedAt: string;
  /** SHA-256 over everything below except generatedAt (the MT001 contract shape). */
  digest: string;
  phase: InventoryPhase;
  mode: "dry-run";
  target: {
    endpoint: string;
    database: string;
    /** Whether the BA expand tables (0209–0214) exist on the target. */
    expandedSchema: boolean;
    /** Whether enterprise_principals.identity_generation exists (0210). */
    identityGenerationColumn: boolean;
    /** Whether the 0212 authority-source columns exist on grants/keys. */
    authoritySourceColumns: boolean;
  };
  mappings: {
    users: readonly UserMapping[];
    companies: readonly CompanyMapping[];
    teams: readonly TeamMapping[];
    memberships: readonly MembershipMapping[];
    teamMemberships: readonly TeamMembershipMapping[];
  };
  authorizationSources: {
    personalGrants: readonly PersonalGrantSource[];
    gatewayKeys: readonly GatewayKeySource[];
  };
  revocationHighWatermark: RevocationHighWatermark;
  slugBackfill: {
    rules: SlugBackfillRules;
    plannedSlugs: readonly PlannedSlug[];
  };
  legacyWriters: {
    list: readonly LegacyDirectoryWriter[];
    scan: LegacyWriterScan;
  };
  /** The exact non-secret columns read per table — the no-secrets contract, stated. */
  readColumns: Readonly<Record<string, readonly string[]>>;
  canMigrate: boolean;
  blockers: readonly InventoryBlocker[];
}

/** The parsed CLI intent; `mode` is always "dry-run" — M0 has no apply. */
export interface InventoryCliPlan {
  mode: "dry-run";
  phase: InventoryPhase;
  url: string;
  repositoryRoot: string;
  out?: string;
  report?: string;
  pretty?: boolean;
}

export type InventoryCliParse =
  | { ok: true; plan: InventoryCliPlan }
  | { ok: false; refusal: string };

// ---------------------------------------------------------------------------
// interfaces §2: the organization.slug backfill rules
// ---------------------------------------------------------------------------

/** interfaces §2's rules, as the pre-migration inventory records them. */
export const SLUG_BACKFILL_RULES: SlugBackfillRules = {
  normalization: [
    "trim the company business display name",
    "lowercase",
    "fold runs of whitespace and illegal characters into a single hyphen",
    "strip leading and trailing hyphens",
  ],
  emptyFallback:
    "a normalized-empty name falls back to tenant-<sha256(tenant_id) prefix>",
  collision:
    "collisions take deterministic numeric suffixes -2, -3, … in stable (created_at, tenant_id) order",
  idempotency:
    "the planned slug is a pure function of the tenant's name and id; a persisted auth_organizations.slug row (keyed by tenant_id) wins and is never re-derived, so a replay never re-assigns",
  uniqueConflict:
    "a BA unique-constraint conflict blocks and is reported; the slug is never silently re-derived, so the tenant_id-keyed mapping is never lost",
};

/**
 * The slug of one company's business display name under interfaces §2:
 * trim, lowercase, fold runs of whitespace/illegal characters into a single
 * hyphen, strip leading/trailing hyphens; an empty result falls back to
 * `tenant-<sha256(tenant_id) prefix>`.
 */
export function planOrganizationSlug(name: string, tenantId: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) return normalized;
  return `tenant-${createHash("sha256").update(tenantId).digest("hex").slice(0, 12)}`;
}

/**
 * Deterministic collision resolution: stable order is (created_at, tenantId);
 * the first tenant keeps the base slug, later collisions take -2, -3, …; a
 * persisted auth_organizations.slug always wins and is never re-derived.
 */
export function resolvePlannedSlugs(
  companies: readonly {
    tenantId: string;
    name: string;
    createdAt: string;
    existingSlug: string | null;
  }[],
): PlannedSlug[] {
  const ordered = [...companies].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.tenantId < right.tenantId ? -1 : 1;
  });
  // Persisted slugs claim their value first: they are the recorded
  // tenant_id-keyed mapping, and a later derivation must move around them.
  const taken = new Map<string, string>();
  for (const company of ordered) {
    if (company.existingSlug !== null)
      taken.set(company.existingSlug, company.tenantId);
  }
  const planned = new Map<string, PlannedSlug>();
  for (const company of ordered) {
    if (company.existingSlug !== null) {
      planned.set(company.tenantId, {
        tenantId: company.tenantId,
        name: company.name,
        plannedSlug: company.existingSlug,
        collisionSuffix: null,
        existingSlug: company.existingSlug,
      });
      continue;
    }
    const base = planOrganizationSlug(company.name, company.tenantId);
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.set(slug, company.tenantId);
    planned.set(company.tenantId, {
      tenantId: company.tenantId,
      name: company.name,
      plannedSlug: slug,
      collisionSuffix: slug === base ? null : suffix - 1,
      existingSlug: null,
    });
  }
  return [...planned.values()].sort((left, right) =>
    left.tenantId < right.tenantId ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// The legacy directory-writer static list and its source scan
// ---------------------------------------------------------------------------

const DIRECTORY_TABLES = {
  enterpriseTenants: "enterprise_tenants",
  enterprisePrincipals: "enterprise_principals",
  enterpriseMemberships: "enterprise_memberships",
  enterpriseWorkspaces: "enterprise_workspaces",
  enterpriseWorkspaceMemberships: "enterprise_workspace_memberships",
} as const;

const RAW_DIRECTORY_DML =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(enterprise_tenants|enterprise_principals|enterprise_memberships|enterprise_workspaces|enterprise_workspace_memberships)\b/i;
const DRIZZLE_DIRECTORY_DML =
  /\.(?:insert|update|delete)\s*\(\s*(enterpriseTenants|enterprisePrincipals|enterpriseMemberships|enterpriseWorkspaces|enterpriseWorkspaceMemberships)\b/;

const WRITER_SCAN_ROOTS = [
  "server/src",
  "server/scripts",
  "app/src",
  "scripts",
  "shared",
] as const;

const WRITER_SCAN_EXCLUSIONS = [
  {
    path: "server/src/db/schema/",
    reason:
      "drizzle table declarations name the symbols and the tables; they declare, they do not write",
  },
  {
    path: "server/src/auth/directory/",
    reason:
      "the BA single-writer authority that replaces this list (T02.x): the controlled executor/finalizer path, not a legacy writer",
  },
  {
    path: "tests",
    reason:
      "test scaffolding never runs against production; the island suites own their fixtures",
  },
] as const;

/**
 * The legacy directory-writer static list (plan Task 25: "覆盖
 * UI/API/CLI/SCIM/JIT/startup及非路由写入者，逐项写明处置阶段"; P08/P12/P22
 * consume it). Every file the scan below finds must be named here, or the
 * inventory blocks with an unclassified-writer — the list is closed on
 * purpose, and a new directory writer has to be classified to ship.
 */
export const LEGACY_DIRECTORY_WRITERS: readonly LegacyDirectoryWriter[] = [
  {
    id: "workspace-admin",
    file: "server/src/enterprise/tenancy/workspace-admin.ts",
    family: "ui-api",
    route: true,
    tables: [
      DIRECTORY_TABLES.enterpriseMemberships,
      DIRECTORY_TABLES.enterpriseWorkspaces,
      DIRECTORY_TABLES.enterpriseWorkspaceMemberships,
    ],
    disposalPhase:
      "M2 pauses the directory writes (503 DIRECTORY_MIGRATION_PAUSED); M4 replaces them with the Directory commands team.create / team.profile.update / team.member.add / team.member.remove through the ingress-translated auth.api (interfaces §3.2; P08/P09)",
    note: "the workspace-scope admin service mounted by server/src/index.ts",
  },
  {
    id: "people-lifecycle",
    file: "server/src/enterprise/tenancy/people-lifecycle.ts",
    family: "ui-api",
    route: true,
    tables: [DIRECTORY_TABLES.enterpriseMemberships],
    disposalPhase:
      "M2 pauses; M4 becomes the Directory commands member.role.set / member.suspend / member.restore / member.remove (interfaces §2; P08)",
    note: "the company people management service mounted by server/src/index.ts",
  },
  {
    id: "provision-deployment",
    file: "server/src/enterprise/tenancy/provision.ts",
    family: "cli",
    route: false,
    tables: [
      DIRECTORY_TABLES.enterpriseTenants,
      DIRECTORY_TABLES.enterpriseMemberships,
      DIRECTORY_TABLES.enterpriseWorkspaces,
    ],
    disposalPhase:
      "M2 pauses; M4 becomes the private company.provision command on the server-pre-allocated tenant id (interfaces §2; P06) — the offline operator path is never request-wired",
    note: "offline-only initial deployment provisioning over the operator connection",
  },
  {
    id: "scim-directory",
    file: "server/src/enterprise/tenancy/scim-directory.ts",
    family: "scim",
    route: true,
    tables: [DIRECTORY_TABLES.enterpriseMemberships],
    disposalPhase:
      "M2 pauses; M4 SCIM writes are translated by the ingress into member.provision / member.suspend / member.restore / member.remove through auth.api (interfaces §3.2 SCIM table; P12)",
    note: "the company-scoped SCIM directory reconciler",
  },
  {
    id: "jit-provisioning",
    file: null,
    family: "jit",
    route: false,
    tables: [],
    disposalPhase:
      "no legacy JIT writer exists in the corpus today; JIT provisioning arrives only as member.provision through a verified provisioning binding (interfaces §3; P12) — a legacy JIT writer must be added to this list before it can ship, or the scan fails",
    note: "declared family: currently no writer to dispose of",
  },
  {
    id: "enterprise-runtime-seed",
    file: "server/scripts/enterprise-runtime-seed.ts",
    family: "startup",
    route: false,
    tables: [
      DIRECTORY_TABLES.enterpriseTenants,
      DIRECTORY_TABLES.enterprisePrincipals,
      DIRECTORY_TABLES.enterpriseMemberships,
      DIRECTORY_TABLES.enterpriseWorkspaces,
    ],
    disposalPhase:
      "M4: the ba branch does not seed the directory independently (plan P17 note on this file); the startup seed is translated into commands or retired",
    note: "raw-SQL, idempotent-by-fixed-ids offline runbook seed for the runtime candidate",
  },
  {
    id: "deletion-semantics",
    file: "server/src/enterprise/tenancy/deletion-semantics.ts",
    family: "non-route",
    route: false,
    tables: [
      DIRECTORY_TABLES.enterpriseMemberships,
      DIRECTORY_TABLES.enterpriseWorkspaceMemberships,
    ],
    disposalPhase:
      "M2 pauses; M4 the operator's direct team-row DELETE and member suspension become the Directory commands member.remove / member.suspend inside the executor transaction (interfaces §2; P08)",
    note: "Track A company cleanup and Track B global deletion services: the operator direct team-row deletion and member deactivation the plan calls out",
  },
  {
    id: "root-backfill",
    file: "server/src/enterprise/tenancy/root-backfill.ts",
    family: "non-route",
    route: false,
    tables: [
      DIRECTORY_TABLES.enterprisePrincipals,
      DIRECTORY_TABLES.enterpriseMemberships,
    ],
    disposalPhase:
      "migration-semantics tool: from M2 its raw-SQL inserts run only under the offline migration actor (P25/P22); the direct owner-connection write path stops at M4",
    note: "MT113 raw-SQL inserts of principals/memberships on the setup/owner connection",
  },
];

function isExcludedFromScan(relative: string): boolean {
  if (relative.includes("/db/schema/") || relative.startsWith("db/schema/")) {
    return true;
  }
  if (
    relative.startsWith("server/src/auth/directory/") ||
    relative.includes("/auth/directory/")
  ) {
    return true;
  }
  if (/(^|\/)(tests?|__tests__)\//.test(relative)) return true;
  return /\.test\.[cm]?[jt]sx?$/.test(relative);
}

function directoryTablesWritten(content: string): string[] {
  const lines = content.split("\n");
  let inBlockComment = false;
  const hits = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) inBlockComment = true;
    const commented =
      inBlockComment ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/");
    if (trimmed.includes("*/")) inBlockComment = false;
    if (commented) continue;
    const raw = line.match(RAW_DIRECTORY_DML);
    if (raw) hits.add(raw[1].toLowerCase());
    const symbol = line.match(DRIZZLE_DIRECTORY_DML);
    if (symbol)
      hits.add(
        DIRECTORY_TABLES[symbol[1] as keyof typeof DIRECTORY_TABLES] as string,
      );
  }
  return [...hits].sort();
}

function walkSourceFiles(root: string, into: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkSourceFiles(path, into);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) into.push(path);
  }
}

/**
 * Scan the repository for files still writing the five legacy directory
 * tables. Comment lines are skipped; the drizzle-symbol calls and the raw
 * SQL forms are both recognised, line-locally (a statement split across
 * lines is not matched — the scan errs toward missing a writer only for
 * shapes the corpus does not use, and every find is then checked against
 * the static list, so a false negative still has to survive review).
 */
export function scanLegacyDirectoryWriters(
  repositoryRoot: string,
): LegacyWriterScan {
  const root = resolve(repositoryRoot);
  if (!existsSync(root) || !existsSync(join(root, "server/src"))) {
    throw new Error(
      `${repositoryRoot} does not look like the repository root (server/src is missing): pass --repo-root pointing at the checkout the inventory is taken from.`,
    );
  }
  const scannedRoots: string[] = [];
  const writers: { file: string; tables: readonly string[] }[] = [];
  for (const relativeRoot of WRITER_SCAN_ROOTS) {
    const absolute = join(root, relativeRoot);
    if (!existsSync(absolute)) continue;
    scannedRoots.push(relativeRoot);
    const files: string[] = [];
    walkSourceFiles(absolute, files);
    for (const file of files) {
      const relative = file.slice(root.length + 1);
      if (isExcludedFromScan(relative)) continue;
      const tables = directoryTablesWritten(readFileSync(file, "utf8"));
      if (tables.length) writers.push({ file: relative, tables });
    }
  }
  writers.sort((left, right) => (left.file < right.file ? -1 : 1));
  const listed = new Set(
    LEGACY_DIRECTORY_WRITERS.map((writer) => writer.file).filter(
      (file): file is string => file !== null,
    ),
  );
  const scanned = new Set(writers.map((writer) => writer.file));
  return {
    scannedRoots,
    writers,
    missing: writers
      .map((writer) => writer.file)
      .filter((file) => !listed.has(file)),
    stale: [...listed].filter((file) => !scanned.has(file)),
    exclusions: WRITER_SCAN_EXCLUSIONS,
  };
}

// ---------------------------------------------------------------------------
// The read-only M0 inventory
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function targetOf(url: string): { endpoint: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the target URL must be a PostgreSQL URL.");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error("the target URL must be a PostgreSQL URL.");
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
      "the target URL must be a loopback PostgreSQL URL naming an isolated enterprise database.",
    );
  }
  if (!/^openbot_enterprise_/.test(database)) {
    throw new Error(
      `the target database must be an openbot_enterprise_* isolated test/rehearsal database, not "${database}": real production runs are not authorized in this slice.`,
    );
  }
  if (parsed.hash) {
    throw new Error("the target URL must not include a URL fragment.");
  }
  const host =
    parsed.hostname === "localhost" || parsed.hostname === "[::1]"
      ? "127.0.0.1"
      : parsed.hostname;
  return { endpoint: `${host}:${parsed.port || "5432"}`, database };
}

function toVersionOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      "a version column returned a value outside the safe-integer range; the M0 inventory refuses to report a generation it cannot represent (interfaces §2).",
    );
  }
  return parsed;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}
interface PrincipalRow {
  id: string;
  user_id: string;
  status: string;
  identity_generation?: string | number | null;
}
interface MembershipRow {
  tenant_id: string;
  principal_id: string;
  role: string;
  status: string;
  epoch: number;
}
interface WorkspaceRow {
  tenant_id: string;
  id: string;
  name: string;
}
interface WorkspaceMembershipRow extends MembershipRow {
  workspace_id: string;
}
interface SecurityEventAggregate {
  count: number;
  latest_at: Date | null;
  latest_event_id: string | null;
}
interface BillingMappingRow {
  tenant_id: string;
  external_customer_id: string;
}
interface PayerAccountRow {
  id: string;
  kind: string;
  payer_id: string;
  external_customer_id: string;
}
interface AccessGrantRow {
  grant_id: string;
  user_id: string;
  principal_id?: string | null;
  identity_generation?: string | number | null;
  status: string;
}
interface GatewayKeyRow {
  id: string;
  grant_id: string;
  source_identity_generation?: string | number | null;
  status: string;
}

/**
 * Run the M0 inventory against one explicit target URL. Strictly read-only:
 * every statement runs inside one `SET TRANSACTION READ ONLY` transaction,
 * so PostgreSQL refuses an accidental write (25006) rather than the CLI
 * promising not to make one.
 */
export async function runM0Inventory(input: {
  url: string;
  phase: InventoryPhase;
  repositoryRoot: string;
}): Promise<InventoryReport> {
  if (input.phase !== "M0") {
    throw new Error(
      `phase ${input.phase} is not available in this slice: the M0 read-only inventory is all T02.13 delivers; the M1–M3 tools are the later P25 slices (interfaces §1).`,
    );
  }
  const target = targetOf(input.url);
  const sql = postgres(input.url, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");

      const [expandState] = (await tx`
        SELECT
          to_regclass('public.auth_organizations') IS NOT NULL AS orgs,
          to_regclass('public.auth_teams') IS NOT NULL AS teams,
          to_regclass('public.auth_team_bindings') IS NOT NULL AS bindings,
          to_regclass('public.auth_members') IS NOT NULL AS members`) as Array<{
        orgs: boolean;
        teams: boolean;
        bindings: boolean;
        members: boolean;
      }>;
      const expandedSchema = Boolean(
        expandState?.orgs &&
          expandState.teams &&
          expandState.bindings &&
          expandState.members,
      );
      const [columns] = (await tx`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'enterprise_principals'
              AND column_name = 'identity_generation'
          ) AS identity_generation,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'access_grants'
              AND column_name = 'principal_id'
          ) AS grant_principal,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'access_grants'
              AND column_name = 'identity_generation'
          ) AS grant_generation,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'gateway_virtual_keys'
              AND column_name = 'source_identity_generation'
          ) AS key_generation`) as Array<{
        identity_generation: boolean;
        grant_principal: boolean;
        grant_generation: boolean;
        key_generation: boolean;
      }>;
      const hasIdentityGeneration = Boolean(columns?.identity_generation);
      const hasGrantPrincipal = Boolean(columns?.grant_principal);
      const hasGrantGeneration = Boolean(columns?.grant_generation);
      const hasKeyGeneration = Boolean(columns?.key_generation);
      // The 0212 authority-source columns arrive with the expand stack; a
      // pre-expand target simply reports every grant/key source as missing
      // rather than crashing on a column it does not have.
      const hasAuthoritySourceColumns =
        hasGrantPrincipal && hasGrantGeneration && hasKeyGeneration;

      const readColumns: Record<string, readonly string[]> = {
        users: ["id"],
        enterprise_tenants: ["id", "name", "status", "created_at"],
        enterprise_principals: hasIdentityGeneration
          ? ["id", "user_id", "status", "identity_generation"]
          : ["id", "user_id", "status"],
        enterprise_memberships: [
          "tenant_id",
          "principal_id",
          "role",
          "status",
          "epoch",
        ],
        enterprise_workspaces: ["tenant_id", "id", "name"],
        enterprise_workspace_memberships: [
          "tenant_id",
          "workspace_id",
          "principal_id",
          "status",
          "epoch",
        ],
        enterprise_security_events: ["id", "created_at"],
        billing_customer_mappings: ["tenant_id", "external_customer_id"],
        payer_accounts: ["id", "kind", "payer_id", "external_customer_id"],
        access_grants: hasAuthoritySourceColumns
          ? [
              "grant_id",
              "user_id",
              "principal_id",
              "identity_generation",
              "status",
            ]
          : ["grant_id", "user_id", "status"],
        gateway_virtual_keys: hasKeyGeneration
          ? ["id", "grant_id", "source_identity_generation", "status"]
          : ["id", "grant_id", "status"],
      };
      if (expandedSchema) {
        readColumns.auth_organizations = ["id", "slug"];
        readColumns.auth_teams = ["id", "organization_id"];
        readColumns.auth_team_bindings = [
          "tenant_id",
          "workspace_id",
          "team_id",
        ];
        readColumns.auth_members = ["id", "organization_id", "user_id"];
      }

      const userIds = (await tx`SELECT id FROM users ORDER BY id`) as Array<{
        id: string;
      }>;
      const tenants = (await tx`
        SELECT id, name, status, created_at
        FROM enterprise_tenants ORDER BY id`) as unknown as TenantRow[];
      const principals = hasIdentityGeneration
        ? ((await tx`
            SELECT id, user_id, status, identity_generation
            FROM enterprise_principals ORDER BY id`) as unknown as PrincipalRow[])
        : ((await tx`
            SELECT id, user_id, status
            FROM enterprise_principals ORDER BY id`) as unknown as PrincipalRow[]);
      const memberships = (await tx`
        SELECT tenant_id, principal_id, role, status, epoch
        FROM enterprise_memberships ORDER BY tenant_id, principal_id`) as unknown as MembershipRow[];
      const workspaces = (await tx`
        SELECT tenant_id, id, name
        FROM enterprise_workspaces ORDER BY tenant_id, id`) as unknown as WorkspaceRow[];
      const teamMemberships = (await tx`
        SELECT tenant_id, workspace_id, principal_id, status, epoch
        FROM enterprise_workspace_memberships
        ORDER BY tenant_id, workspace_id, principal_id`) as unknown as WorkspaceMembershipRow[];
      const [events] = (await tx`
        SELECT
          count(*)::int AS count,
          max(created_at) AS latest_at,
          (SELECT id FROM enterprise_security_events
            ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_event_id
        FROM enterprise_security_events`) as unknown as SecurityEventAggregate[];
      const billingMappings = (await tx`
        SELECT tenant_id, external_customer_id
        FROM billing_customer_mappings ORDER BY tenant_id`) as unknown as BillingMappingRow[];
      const payerAccounts = (await tx`
        SELECT id, kind, payer_id, external_customer_id
        FROM payer_accounts ORDER BY id`) as unknown as PayerAccountRow[];
      const grants = hasAuthoritySourceColumns
        ? ((await tx`
            SELECT grant_id, user_id, principal_id, identity_generation, status
            FROM access_grants ORDER BY grant_id`) as unknown as AccessGrantRow[])
        : ((await tx`
            SELECT grant_id, user_id, status
            FROM access_grants ORDER BY grant_id`) as unknown as AccessGrantRow[]);
      const keys = hasKeyGeneration
        ? ((await tx`
            SELECT id, grant_id, source_identity_generation, status
            FROM gateway_virtual_keys ORDER BY id`) as unknown as GatewayKeyRow[])
        : ((await tx`
            SELECT id, grant_id, status
            FROM gateway_virtual_keys ORDER BY id`) as unknown as GatewayKeyRow[]);
      const organizations = expandedSchema
        ? ((await tx`SELECT id, slug FROM auth_organizations ORDER BY id`) as Array<{
            id: string;
            slug: string;
          }>)
        : [];
      const teamBindings = expandedSchema
        ? ((await tx`
            SELECT tenant_id, workspace_id, team_id
            FROM auth_team_bindings ORDER BY tenant_id, workspace_id`) as Array<{
            tenant_id: string;
            workspace_id: string;
            team_id: string;
          }>)
        : [];
      const authMembers = expandedSchema
        ? ((await tx`
            SELECT id, organization_id, user_id
            FROM auth_members ORDER BY id`) as Array<{
            id: string;
            organization_id: string;
            user_id: string;
          }>)
        : [];

      // The stable mapping: ids are reported verbatim, never re-invented.
      const principalByUser = new Map<string, PrincipalRow>();
      for (const principal of principals) {
        if (!principalByUser.has(principal.user_id)) {
          principalByUser.set(principal.user_id, principal);
        }
      }
      const principalById = new Map(
        principals.map((principal) => [principal.id, principal]),
      );
      const users: UserMapping[] = userIds.map((row) => {
        const principal = principalByUser.get(row.id);
        return {
          userId: row.id,
          principalId: principal?.id ?? null,
          identityGeneration: principal
            ? toVersionOrNull(principal.identity_generation ?? null)
            : null,
        };
      });

      const membershipRows: MembershipMapping[] = memberships.map((row) => ({
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        userId: principalById.get(row.principal_id)?.user_id ?? null,
        role: row.role,
        status: row.status,
        epoch: toVersionOrNull(row.epoch) ?? 0,
      }));
      const teamMembershipRows: TeamMembershipMapping[] = teamMemberships.map(
        (row) => ({
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          principalId: row.principal_id,
          userId: principalById.get(row.principal_id)?.user_id ?? null,
          status: row.status,
          epoch: toVersionOrNull(row.epoch) ?? 0,
        }),
      );

      const payerByTenant = new Map(
        billingMappings.map((row) => [row.tenant_id, row.external_customer_id]),
      );
      const companyPayerAccounts = new Map(
        payerAccounts
          .filter((row) => row.kind === "company")
          .map((row) => [row.payer_id, row.id]),
      );
      const organizationByTenant = new Map(
        organizations.map((row) => [row.id, row.slug]),
      );
      const teamByWorkspace = new Map(
        teamBindings.map((row) => [
          `${row.tenant_id}/${row.workspace_id}`,
          row.team_id,
        ]),
      );

      const companies: CompanyMapping[] = tenants.map((tenant) => {
        const tenantMemberships = memberships.filter(
          (membership) => membership.tenant_id === tenant.id,
        );
        const ownerPrincipalIds = tenantMemberships
          .filter((membership) => membership.role === "tenant_admin")
          .map((membership) => membership.principal_id)
          .sort();
        return {
          tenantId: tenant.id,
          name: tenant.name,
          status: tenant.status,
          organizationId: organizationByTenant.has(tenant.id)
            ? tenant.id
            : null,
          ownerPrincipalIds,
          memberPrincipalIds: tenantMemberships
            .map((membership) => membership.principal_id)
            .sort(),
          payer: {
            externalCustomerId: payerByTenant.get(tenant.id) ?? null,
            payerAccountId: companyPayerAccounts.get(tenant.id) ?? null,
          },
        };
      });

      const teams: TeamMapping[] = workspaces.map((workspace) => ({
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        name: workspace.name,
        teamId:
          teamByWorkspace.get(`${workspace.tenant_id}/${workspace.id}`) ?? null,
      }));

      const authorizationSources = {
        personalGrants: grants.map((grant): PersonalGrantSource => {
          const principalId = grant.principal_id ?? null;
          const verified =
            principalId !== null &&
            toVersionOrNull(grant.identity_generation) !== null;
          return {
            grantId: grant.grant_id,
            userId: grant.user_id,
            principalId,
            identityGeneration: toVersionOrNull(grant.identity_generation),
            status: grant.status,
            source: verified ? "verified-principal" : "missing",
          };
        }),
        gatewayKeys: keys.map(
          (key): GatewayKeySource => ({
            keyId: key.id,
            grantId: key.grant_id,
            sourceIdentityGeneration: toVersionOrNull(
              key.source_identity_generation,
            ),
            status: key.status,
            source:
              toVersionOrNull(key.source_identity_generation) !== null
                ? "verified-generation"
                : "missing",
          }),
        ),
      };

      const revocationHighWatermark: RevocationHighWatermark = {
        securityEvents: {
          count: toVersionOrNull(events?.count ?? 0) ?? 0,
          latestAt: toIsoOrNull(events?.latest_at ?? null),
          latestEventId: events?.latest_event_id
            ? toText(events.latest_event_id)
            : null,
        },
        suspendedMemberships: memberships.filter(
          (membership) => membership.status === "suspended",
        ).length,
        suspendedTeamMemberships: teamMemberships.filter(
          (membership) => membership.status === "suspended",
        ).length,
        maxMembershipEpoch: memberships.length
          ? Math.max(...memberships.map((row) => row.epoch))
          : null,
      };

      const plannedSlugs = resolvePlannedSlugs(
        tenants.map((tenant) => ({
          tenantId: tenant.id,
          name: tenant.name,
          createdAt: tenant.created_at.toISOString(),
          existingSlug: organizationByTenant.get(tenant.id) ?? null,
        })),
      );

      const blockers: InventoryBlocker[] = [];
      for (const company of companies) {
        if (!company.ownerPrincipalIds.length) {
          blockers.push({
            kind: "unknown-owner",
            subject: company.tenantId,
            detail:
              "no tenant_admin membership names this company's owner; the inventory reports the unknown and never designates the first member (plan Task 25: 不自动指定首人).",
          });
        }
        if (company.payer.externalCustomerId === null) {
          blockers.push({
            kind: "unknown-payer",
            subject: company.tenantId,
            detail:
              "no billing_customer_mappings row names this company's billing customer; the payer the migration carries over cannot be determined.",
          });
        }
      }
      // Unknown generation: a principal holding directory relationships with
      // a missing identity_generation. Interfaces §2 pins the rule — history
      // is never backfilled with a guess — and a pre-expand target reports
      // every such principal rather than silently treating NULL as valid.
      const principalIdsInRelationships = new Set<string>([
        ...memberships.map((row) => row.principal_id),
        ...teamMemberships.map((row) => row.principal_id),
      ]);
      for (const principal of principals) {
        if (
          principalIdsInRelationships.has(principal.id) &&
          toVersionOrNull(principal.identity_generation ?? null) === null
        ) {
          blockers.push({
            kind: "unknown-generation",
            subject: principal.id,
            detail:
              "identity_generation is missing on a principal holding directory relationships; unverified history cannot be backfilled (interfaces §2) — verify it or let the migration revoke and require re-authorization.",
          });
        }
      }
      // Duplicate relationships: a BA member row with no legacy membership
      // backing. At M0 the BA side is empty; the check keeps the inventory
      // honest once the backfill starts writing both halves.
      if (expandedSchema) {
        for (const member of authMembers) {
          const principal = principalByUser.get(member.user_id);
          const backed =
            principal !== undefined &&
            memberships.some(
              (membership) =>
                membership.tenant_id === member.organization_id &&
                membership.principal_id === principal.id,
            );
          if (!backed) {
            blockers.push({
              kind: "duplicate-relationship",
              subject: `${member.organization_id}/${member.user_id}`,
              detail:
                "a BA member row has no legacy enterprise_memberships backing; the dual-write state is inconsistent.",
            });
          }
        }
      }
      const scan = scanLegacyDirectoryWriters(input.repositoryRoot);
      for (const file of scan.missing) {
        blockers.push({
          kind: "unclassified-writer",
          subject: file,
          detail:
            "the writer scan found a directory-table writer outside the static list; classify it with a disposal phase or remove the write (清单外写入者被扫描发现即失败).",
        });
      }
      const slugOwners = new Map<string, string>();
      for (const slug of plannedSlugs) {
        const owner = slugOwners.get(slug.plannedSlug);
        if (owner !== undefined) {
          blockers.push({
            kind: "slug-mapping-conflict",
            subject: `${owner}/${slug.tenantId}`,
            detail:
              "deterministic resolution assigned the same planned slug to two tenants; the backfill must block and report rather than silently re-derive (interfaces §2).",
          });
        } else {
          slugOwners.set(slug.plannedSlug, slug.tenantId);
        }
      }

      const report: Omit<InventoryReport, "digest"> = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        phase: "M0",
        mode: "dry-run",
        target: {
          endpoint: target.endpoint,
          database: target.database,
          expandedSchema,
          identityGenerationColumn: hasIdentityGeneration,
          authoritySourceColumns: hasAuthoritySourceColumns,
        },
        mappings: {
          users,
          companies,
          teams,
          memberships: membershipRows,
          teamMemberships: teamMembershipRows,
        },
        authorizationSources,
        revocationHighWatermark,
        slugBackfill: { rules: SLUG_BACKFILL_RULES, plannedSlugs },
        legacyWriters: { list: LEGACY_DIRECTORY_WRITERS, scan },
        readColumns,
        canMigrate: blockers.length === 0,
        blockers,
      };
      return { ...report, digest: computeDigest(report) };
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Digest (the MT001 contract shape: stable stringify, generatedAt excluded)
// ---------------------------------------------------------------------------

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

/** SHA-256 over the report's stable content (everything but generatedAt). */
export function computeDigest(
  report: Omit<InventoryReport, "digest" | "generatedAt"> &
    Partial<Pick<InventoryReport, "generatedAt">>,
): string {
  const { generatedAt: _generatedAt, ...rest } = report;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export function renderInventoryReport(report: InventoryReport): string {
  const lines: string[] = [];
  lines.push("# T02.13 M0 directory inventory");
  lines.push("");
  lines.push(
    `- target: ${report.target.endpoint}/${report.target.database} (expanded schema: ${report.target.expandedSchema ? "yes" : "no"}; identity_generation column: ${report.target.identityGenerationColumn ? "yes" : "no"})`,
  );
  lines.push(`- digest: \`${report.digest}\``);
  lines.push(
    `- mapping: ${report.mappings.users.length} users · ${report.mappings.companies.length} companies · ${report.mappings.teams.length} teams · ${report.mappings.memberships.length} memberships · ${report.mappings.teamMemberships.length} team memberships`,
  );
  lines.push(
    `- authorization sources: ${report.authorizationSources.personalGrants.length} grants (${report.authorizationSources.personalGrants.filter((grant) => grant.source === "missing").length} missing) · ${report.authorizationSources.gatewayKeys.length} keys (${report.authorizationSources.gatewayKeys.filter((key) => key.source === "missing").length} missing)`,
  );
  lines.push(
    `- revocation high-watermark: ${report.revocationHighWatermark.securityEvents.count} security events (latest ${report.revocationHighWatermark.securityEvents.latestAt ?? "none"}) · ${report.revocationHighWatermark.suspendedMemberships} suspended memberships · max epoch ${report.revocationHighWatermark.maxMembershipEpoch ?? "none"}`,
  );
  lines.push(
    `- legacy writers: ${report.legacyWriters.scan.writers.length} scanned · ${report.legacyWriters.scan.missing.length} unclassified · ${report.legacyWriters.list.length} listed`,
  );
  lines.push("");
  lines.push(
    `## canMigrate: ${report.canMigrate ? "yes" : `no — ${report.blockers.length} blocker(s)`}`,
  );
  const byKind = new Map<string, InventoryBlocker[]>();
  for (const blocker of report.blockers) {
    const bucket = byKind.get(blocker.kind) ?? [];
    bucket.push(blocker);
    byKind.set(blocker.kind, bucket);
  }
  for (const [kind, blockers] of [...byKind.entries()].sort()) {
    lines.push("");
    lines.push(`### ${kind} (${blockers.length})`);
    for (const blocker of blockers.slice(0, 20)) {
      lines.push(`- \`${blocker.subject}\` — ${blocker.detail}`);
    }
    if (blockers.length > 20) {
      lines.push(`- … and ${blockers.length - 20} more`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI (the MT001 entry model: refusals, JSON on stdout, report on stderr)
// ---------------------------------------------------------------------------

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * Parse the CLI argv. The URL is always explicit (never inherited from
 * TEST_DATABASE_URL/DATABASE_URL), the phase defaults to M0 and only M0 is
 * accepted in this slice, and there is no apply mode to parse.
 */
export function parseInventoryArgs(argv: readonly string[]): InventoryCliParse {
  const plan: InventoryCliPlan = {
    mode: "dry-run",
    phase: "M0",
    url: "",
    repositoryRoot: DEFAULT_REPOSITORY_ROOT,
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
    } else if (arg === "--phase") {
      const value = rest.shift();
      if (value === undefined) {
        return { ok: false, refusal: "--phase requires a value." };
      }
      if (value !== "M0") {
        return {
          ok: false,
          refusal: `phase ${value} is not available in this slice: the M0 read-only inventory is all T02.13 delivers; the M1–M3 tools are the later P25 slices (interfaces §1), and this CLI refuses to run a phase it does not implement.`,
        };
      }
      plan.phase = "M0";
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
    } else if (arg === "--apply") {
      return {
        ok: false,
        refusal:
          "there is no apply mode: the M0 inventory is read-only by construction, and the phases that write belong to the later migrate-directory/verify-directory tools (interfaces §1).",
      };
    } else {
      return {
        ok: false,
        refusal: `unknown argument "${arg}": the M0 inventory takes --url, --phase, --repo-root, --out, --report and --pretty.`,
      };
    }
  }
  if (!plan.url) {
    return {
      ok: false,
      refusal:
        "an explicit target URL is required (--url <postgres URL>): the M0 inventory never inherits TEST_DATABASE_URL/DATABASE_URL and never guesses a target.",
    };
  }
  return { ok: true, plan };
}

const EXIT_OK = 0;
const EXIT_RUN_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_BLOCKED = 3;
const EXIT_UNCLASSIFIED_WRITER = 4;

async function main(): Promise<number> {
  const parsed = parseInventoryArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.refusal}\n`);
    return EXIT_USAGE;
  }
  let report: InventoryReport;
  try {
    report = await runM0Inventory({
      url: parsed.plan.url,
      phase: parsed.plan.phase,
      repositoryRoot: parsed.plan.repositoryRoot,
    });
  } catch (error) {
    process.stderr.write(
      `M0 inventory failed: ${error instanceof Error ? error.message : String(error)}\n`,
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
  const rendered = renderInventoryReport(report);
  if (parsed.plan.report) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(parsed.plan.report, rendered);
    process.stderr.write(`Report written to ${parsed.plan.report}\n`);
  } else {
    process.stderr.write(`${rendered}\n`);
  }
  const unclassified = report.blockers.filter(
    (blocker) => blocker.kind === "unclassified-writer",
  );
  if (unclassified.length) {
    for (const blocker of unclassified) {
      process.stderr.write(
        `unclassified directory writer: ${blocker.subject} — the scan found a writer outside the static list; the inventory fails.\n`,
      );
    }
    return EXIT_UNCLASSIFIED_WRITER;
  }
  if (report.blockers.length) {
    return EXIT_BLOCKED;
  }
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main());
}
