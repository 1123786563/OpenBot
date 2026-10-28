/**
 * PKG11 (#470, Spec §12): the legacy-marketplace migration library — content
 * hashing, manifest types, pure classification, the read-only inventory, the
 * same-scope shadow read and the scope-write helpers that
 * `scripts/plugin-packages/migrate-legacy*.ts` drive. The scripts are thin
 * CLIs; every database statement lives here so the drizzle dependency
 * resolves from the server workspace.
 *
 * OWNERSHIP. The marketplace module owns the legacy tables this reads
 * (`expert_installs`, the catalogue projection of `skills`, and the skill
 * `plugin_grants` rows the marketplace's own install route writes); the
 * enterprise evidence (bot ownership, connector installs, package installs)
 * is read-only cross-module evidence. The WRITE side of the migration goes
 * exclusively through the plugin-package module's own services; this module
 * never writes a legacy row and never re-parents a shared connector.
 *
 * WHAT MAPS, AND WHAT NEVER DOES (A09): content-hash equality with the
 * built-in package's reference hash, plus scope ownership proven by
 * `enterprise_bot_ownership`. A privately edited row stays legacy,
 * untouched; a Bot owner's user id NEVER becomes a company/team guess; a
 * connector install stays legacy until a package declares it.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { enterpriseBotOwnership } from "../db/schema/enterprise-bot-ownership";
import { enterprisePackageInstalls } from "../db/schema/enterprise-plugin-packages";
import { enterprisePluginInstalls } from "../db/schema/enterprise-plugins";
import { expertInstalls } from "../db/schema/marketplace";
import { pluginGrants, skills } from "../db/schema/plugins";
import type { PlatformScope } from "../enterprise/contracts";
import type { PackageMutationStore } from "../enterprise/plugin-packages/contracts";
import type { CompanyAdminContext } from "../enterprise/tenancy/workspace-admin";
import { CATALOGUE_EXPERTS, CATALOGUE_SKILLS } from "./catalogue";
import { builtinExpertInstallInput } from "./expert-content-hash";

/** The built-in package's stable identity; slugs become resource ids 1:1. */
export const BUILTIN_PACKAGE_KEY = "openbot/legacy-catalogue";

// ---------------------------------------------------------------------------
// Content hashing — the single source both the exporter and this module use
// ---------------------------------------------------------------------------

/** Deterministic JSON: one key order, one separator, no whitespace variance. */
export function canonicalJson(value: unknown): string {
  const serialize = (input: unknown): string => {
    if (input === null || typeof input !== "object")
      return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(serialize).join(",")}]`;
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
    return `{${entries.join(",")}}`;
  };
  return serialize(value);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

/**
 * Reference hash of one catalogue skill: exactly the fields the legacy
 * marketplace install writes into a skills row. A legacy row whose hash
 * differs was privately edited and never migrates.
 */
export function builtinSkillContentHash(skill: {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  icon: string;
  category: string;
}): string {
  return canonicalSha256({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
    icon: skill.icon,
    category: skill.category,
  });
}

/**
 * Reference hash of one catalogue expert: exactly the profile fields the
 * legacy install persists (agents.name + agent_profiles.title /
 * roleDescription), built from the shared install-input constructor so the
 * two can never drift. `configuration.systemPrompt` is deliberately NOT in
 * the domain — it is derived from the role description at install time and
 * absent entirely on deployments with a managed Bot; its consistency with
 * the stored profile is asserted separately in classifyExpertInstall
 * (OCR R5-H-C).
 */
export function builtinExpertContentHash(expert: {
  slug: string;
  name: string;
  roleDescription: string;
}): string {
  const profile = builtinExpertInstallInput(expert);
  return canonicalSha256({
    slug: expert.slug,
    name: profile.name,
    title: profile.title,
    roleDescription: profile.roleDescription,
  });
}

/** Hash of one legacy skills row (same field projection as the reference). */
export function legacySkillRowHash(row: {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  icon: string | null;
  category: string | null;
}): string {
  return canonicalSha256({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    instructions: row.instructions,
    icon: row.icon,
    category: row.category,
  });
}

/** Hash of one legacy expert-installed Bot's persisted profile fields. */
export function legacyAgentProfileHash(row: {
  expertSlug: string;
  name: string | null;
  title: string | null;
  roleDescription: string | null;
}): string {
  return canonicalSha256({
    slug: row.expertSlug,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
  });
}

// ---------------------------------------------------------------------------
// Manifest types (the dry-run document apply binds itself to)
// ---------------------------------------------------------------------------

export const MIGRATION_UNRESOLVED_REASONS = [
  "BUILTIN_MISSING",
  "BUILTIN_DRIFT",
  "EXPERT_UNKNOWN",
  "AGENT_MISSING",
  "PRIVATE_EDIT",
  "SCOPE_UNPROVEN",
  "SKILL_ROW_MISSING",
  "NO_DECLARING_PACKAGE",
] as const;

export type MigrationUnresolvedReason =
  (typeof MIGRATION_UNRESOLVED_REASONS)[number];

export interface OwnershipEvidence {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
}

export interface ExpertInstallRecord {
  readonly kind: "expertInstall";
  readonly id: string;
  readonly expertSlug: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly contentHash: string;
  readonly referenceHash: string | null;
  readonly ownership: OwnershipEvidence | null;
  readonly mapping: {
    readonly packageKey: string;
    readonly resourceId: string;
  } | null;
  readonly unresolved: MigrationUnresolvedReason | null;
}

export interface SkillRowRecord {
  readonly kind: "skillRow";
  readonly id: string;
  readonly slug: string;
  readonly ownerUserId: string | null;
  readonly contentHash: string;
  readonly referenceHash: string | null;
  /** Evidence record: a skill row alone never migrates (it has no scope). */
  readonly matchesBuiltin: boolean;
  readonly unresolved: MigrationUnresolvedReason | null;
}

export interface GrantRecord {
  readonly kind: "skillGrant";
  readonly ref: string;
  readonly agentId: string;
  readonly grantedBy: string | null;
  readonly ownership: OwnershipEvidence | null;
  readonly mapping: {
    readonly packageKey: string;
    readonly resourceId: string;
  } | null;
  readonly unresolved: MigrationUnresolvedReason | null;
}

export interface ConnectorInstallRecord {
  readonly kind: "connectorInstall";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly catalogId: string;
  readonly status: string;
  readonly contentHash: string;
  readonly mapping: null;
  readonly unresolved: MigrationUnresolvedReason;
}

export interface LegacyMigrationManifest {
  readonly kind: "legacy-migration-manifest";
  readonly version: 1;
  readonly generatedAt: string;
  readonly manifestDigest: string;
  readonly builtin: {
    readonly packageKey: typeof BUILTIN_PACKAGE_KEY;
    readonly version: string;
    readonly artifactDigest: string | null;
    readonly present: boolean;
    readonly skills: ReadonlyArray<{ slug: string; contentHash: string }>;
    readonly experts: ReadonlyArray<{ slug: string; contentHash: string }>;
  };
  readonly sources: {
    readonly expertInstalls: readonly ExpertInstallRecord[];
    readonly skillRows: readonly SkillRowRecord[];
    readonly grants: readonly GrantRecord[];
    readonly connectorInstalls: readonly ConnectorInstallRecord[];
  };
  readonly counts: {
    expertInstalls: number;
    mappedExpertInstalls: number;
    grants: number;
    mappedGrants: number;
    skillRows: number;
    matchingSkillRows: number;
    connectorInstalls: number;
    unresolved: number;
  };
}

// ---------------------------------------------------------------------------
// Pure classification (unit-tested without a database)
// ---------------------------------------------------------------------------

export interface BuiltinFacts {
  readonly present: boolean;
  readonly version: string;
  readonly artifactDigest: string | null;
  readonly skills: ReadonlyMap<string, string>;
  readonly experts: ReadonlyMap<string, string>;
}

/** Reference facts from the constants + the index entry the CLI resolved. */
export function builtinFacts(
  entry: {
    packageKey: string;
    version: string;
    artifactDigest: string;
  } | null,
): BuiltinFacts {
  return {
    present: entry !== null,
    version: entry?.version ?? "0.0.0",
    artifactDigest: entry?.artifactDigest ?? null,
    skills: new Map(
      CATALOGUE_SKILLS.map((skill) => [
        skill.slug,
        builtinSkillContentHash(skill),
      ]),
    ),
    experts: new Map(
      CATALOGUE_EXPERTS.map((expert) => [
        expert.slug,
        builtinExpertContentHash(expert),
      ]),
    ),
  };
}

export function classifyExpertInstall(
  row: {
    id: string;
    expertSlug: string;
    agentId: string;
    ownerUserId: string;
    agentName: string | null;
    profileTitle: string | null;
    profileRoleDescription: string | null;
    systemPrompt: string | null;
    agentMissing?: boolean;
  },
  ownership: OwnershipEvidence | null,
  builtin: BuiltinFacts,
): ExpertInstallRecord {
  const contentHash = legacyAgentProfileHash({
    expertSlug: row.expertSlug,
    name: row.agentName,
    title: row.profileTitle,
    roleDescription: row.profileRoleDescription,
  });
  const referenceHash = builtin.experts.get(row.expertSlug) ?? null;
  let unresolved: MigrationUnresolvedReason | null = null;
  if (!builtin.present) unresolved = "BUILTIN_MISSING";
  else if (referenceHash === null) unresolved = "EXPERT_UNKNOWN";
  else if (row.agentMissing) unresolved = "AGENT_MISSING";
  else if (
    contentHash !== referenceHash ||
    // configuration.systemPrompt ships as the role description and the
    // profile edit keeps the pair in sync; a persisted prompt that matches
    // neither the stored nor the trimmed role description was hand-altered
    // and never migrates. Absent (managed-Bot shape) is the shipped state.
    (row.systemPrompt !== null &&
      row.systemPrompt !== row.profileRoleDescription &&
      row.systemPrompt !== row.profileRoleDescription?.trim())
  ) {
    unresolved = "PRIVATE_EDIT";
  } else if (ownership === null) unresolved = "SCOPE_UNPROVEN";
  return {
    kind: "expertInstall",
    id: row.id,
    expertSlug: row.expertSlug,
    agentId: row.agentId,
    ownerUserId: row.ownerUserId,
    contentHash,
    referenceHash,
    ownership,
    mapping:
      unresolved === null
        ? { packageKey: BUILTIN_PACKAGE_KEY, resourceId: row.expertSlug }
        : null,
    unresolved,
  };
}

export function classifySkillRow(
  row: {
    id: string;
    slug: string;
    ownerUserId: string | null;
    title: string;
    summary: string;
    instructions: string;
    icon: string | null;
    category: string | null;
  },
  builtin: BuiltinFacts,
): SkillRowRecord {
  const contentHash = legacySkillRowHash(row);
  const referenceHash = builtin.skills.get(row.slug) ?? null;
  const matches = builtin.present && contentHash === referenceHash;
  return {
    kind: "skillRow",
    id: row.id,
    slug: row.slug,
    ownerUserId: row.ownerUserId,
    contentHash,
    referenceHash,
    matchesBuiltin: matches,
    unresolved: builtin.present
      ? referenceHash === null
        ? "EXPERT_UNKNOWN"
        : matches
          ? null
          : "PRIVATE_EDIT"
      : "BUILTIN_MISSING",
  };
}

export function classifyGrant(
  row: {
    kind: string;
    ref: string;
    agentId: string;
    grantedBy: string | null;
    agentMissing?: boolean;
  },
  ownership: OwnershipEvidence | null,
  skillEvidence: ReadonlyMap<string, SkillRowRecord>,
  builtin: BuiltinFacts,
): GrantRecord {
  let unresolved: MigrationUnresolvedReason | null = null;
  const evidence = skillEvidence.get(row.ref);
  if (!builtin.present) unresolved = "BUILTIN_MISSING";
  else if (!builtin.skills.has(row.ref)) unresolved = "EXPERT_UNKNOWN";
  else if (evidence === undefined) unresolved = "SKILL_ROW_MISSING";
  else if (!evidence.matchesBuiltin) unresolved = "PRIVATE_EDIT";
  // OCR-fix-H (R7-H2): a soft-deleted Bot's grant migrates nowhere — the
  // apply channel's readBotInScope refuses a non-active Bot, so mapping it
  // only produced a half-finished apply (provenance landed, grant threw).
  else if (row.agentMissing) unresolved = "AGENT_MISSING";
  else if (ownership === null) unresolved = "SCOPE_UNPROVEN";
  return {
    kind: "skillGrant",
    ref: row.ref,
    agentId: row.agentId,
    grantedBy: row.grantedBy,
    ownership,
    mapping:
      unresolved === null
        ? { packageKey: BUILTIN_PACKAGE_KEY, resourceId: row.ref }
        : null,
    unresolved,
  };
}

export function classifyConnectorInstall(row: {
  tenantId: string;
  workspaceId: string;
  id: string;
  catalogId: string;
  status: string;
  installedBy: string;
  config: unknown;
}): ConnectorInstallRecord {
  return {
    kind: "connectorInstall",
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    id: row.id,
    catalogId: row.catalogId,
    status: row.status,
    contentHash: canonicalSha256(row),
    mapping: null,
    // The V1 built-in package declares no managed connector; nothing claims
    // these installs, so they stay legacy (never reparented, never shared off).
    unresolved: "NO_DECLARING_PACKAGE",
  };
}

/** Digest over everything that decides the migration — never the timestamp. */
export function manifestDigestOf(manifest: LegacyMigrationManifest): string {
  const {
    generatedAt: _generatedAt,
    manifestDigest: _digest,
    ...binding
  } = manifest;
  return canonicalSha256(binding);
}

// ---------------------------------------------------------------------------
// Inventory reads (read-only; superuser/setup connection, see script header)
// ---------------------------------------------------------------------------

export interface LegacyInventory {
  expertInstalls: readonly ExpertInstallRecord[];
  skillRows: readonly SkillRowRecord[];
  grants: readonly GrantRecord[];
  connectorInstalls: readonly ConnectorInstallRecord[];
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readLegacyInventory(
  legacy: Database,
  setup: Database,
  builtin: BuiltinFacts,
): Promise<LegacyInventory> {
  const catalogueSlugs = CATALOGUE_SKILLS.map((skill) => skill.slug);

  const installRows = await legacy
    .select({
      id: expertInstalls.id,
      expertSlug: expertInstalls.expertSlug,
      agentId: expertInstalls.agentId,
      ownerUserId: expertInstalls.ownerUserId,
      agentName: agents.name,
      profileTitle: agentProfiles.title,
      profileRoleDescription: agentProfiles.roleDescription,
      profileDeletedAt: agentProfiles.deletedAt,
      configuration: agents.configuration,
    })
    .from(expertInstalls)
    .leftJoin(agents, eq(agents.id, expertInstalls.agentId))
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, expertInstalls.agentId));

  const skillRowsRaw = await legacy
    .select({
      id: skills.id,
      slug: skills.slug,
      ownerUserId: skills.ownerUserId,
      title: skills.title,
      summary: skills.summary,
      instructions: skills.instructions,
      icon: skills.icon,
      category: skills.category,
    })
    .from(skills)
    .where(inArray(skills.slug, catalogueSlugs));

  const grantRows = await legacy
    .select({
      kind: pluginGrants.kind,
      ref: pluginGrants.ref,
      agentId: pluginGrants.agentId,
      grantedBy: pluginGrants.grantedBy,
    })
    .from(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "skill"),
        inArray(pluginGrants.ref, catalogueSlugs),
      ),
    );

  const ownershipRows = await setup
    .select({
      tenantId: enterpriseBotOwnership.tenantId,
      workspaceId: enterpriseBotOwnership.workspaceId,
      agentId: enterpriseBotOwnership.agentId,
      ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
      status: enterpriseBotOwnership.status,
    })
    .from(enterpriseBotOwnership);

  const connectorRows = await setup
    .select({
      tenantId: enterprisePluginInstalls.tenantId,
      id: enterprisePluginInstalls.id,
      catalogId: enterprisePluginInstalls.catalogId,
      workspaceId: enterprisePluginInstalls.workspaceId,
      installedBy: enterprisePluginInstalls.installedBy,
      config: enterprisePluginInstalls.config,
      status: enterprisePluginInstalls.status,
    })
    .from(enterprisePluginInstalls);

  // OCR-fix-H (R7-H2): a soft-deleted roster row is NOT ownership
  // evidence — roster delete ≠ marketplace uninstall. Only active rows
  // prove scope; a deleted row marks the Bot gone, so its experts/grants
  // classify AGENT_MISSING (never mapped, never written) instead of
  // resolving and dying mid-apply at the grant step.
  const deletedBotIds = new Set(
    ownershipRows
      .filter((row) => row.status !== "active")
      .map((row) => row.agentId),
  );
  const ownershipByAgent = new Map(
    ownershipRows
      .filter((row) => row.status === "active")
      .map((row) => [
        row.agentId,
        {
          tenantId: row.tenantId,
          workspaceId: row.workspaceId,
          ownerPrincipalId: row.ownerPrincipalId,
        },
      ]),
  );
  const skillEvidence = new Map(
    skillRowsRaw.map((row) => [row.slug, classifySkillRow(row, builtin)]),
  );

  // The jsonb column can arrive as a raw string (observed on joined selects
  // under the Bun SQL driver); parse defensively so the hash reads values,
  // never driver serialization.
  const systemPromptOf = (raw: unknown): string | null => {
    const configuration = typeof raw === "string" ? tryParseJson(raw) : raw;
    if (
      configuration !== null &&
      typeof configuration === "object" &&
      "systemPrompt" in configuration &&
      typeof (configuration as { systemPrompt: unknown }).systemPrompt ===
        "string"
    ) {
      return (configuration as { systemPrompt: string }).systemPrompt;
    }
    return null;
  };
  return {
    expertInstalls: installRows.map((row) =>
      classifyExpertInstall(
        {
          id: row.id,
          expertSlug: row.expertSlug,
          agentId: row.agentId,
          ownerUserId: row.ownerUserId,
          agentName: row.agentName,
          profileTitle: row.profileTitle,
          profileRoleDescription: row.profileRoleDescription,
          systemPrompt: systemPromptOf(row.configuration),
          // OCR-fix-H (R7-H2): two soft-delete filters, one semantics — the
          // enterprise roster row (deletedBotIds) and the legacy profile
          // tombstone (deleted_at) both mean "this Bot no longer exists";
          // the agents-row absence was already the third face of that fact.
          agentMissing:
            row.agentName === null ||
            row.profileDeletedAt !== null ||
            deletedBotIds.has(row.agentId),
        },
        ownershipByAgent.get(row.agentId) ?? null,
        builtin,
      ),
    ),
    skillRows: [...skillEvidence.values()],
    grants: grantRows.map((row) =>
      classifyGrant(
        {
          ...row,
          // Grants never consult the legacy profile; the roster row's
          // status is their landing check (setBotGrant reads it via
          // readBotInScope), so the roster filter is the one that applies.
          agentMissing: deletedBotIds.has(row.agentId),
        },
        ownershipByAgent.get(row.agentId) ?? null,
        skillEvidence,
        builtin,
      ),
    ),
    connectorInstalls: connectorRows.map((row) =>
      classifyConnectorInstall(row),
    ),
  };
}

export function buildManifest(
  builtin: BuiltinFacts,
  inventory: LegacyInventory,
  generatedAt = new Date().toISOString(),
): LegacyMigrationManifest {
  const manifest: LegacyMigrationManifest = {
    kind: "legacy-migration-manifest",
    version: 1,
    generatedAt,
    manifestDigest: "",
    builtin: {
      packageKey: BUILTIN_PACKAGE_KEY,
      version: builtin.version,
      artifactDigest: builtin.artifactDigest,
      present: builtin.present,
      skills: CATALOGUE_SKILLS.map((skill) => ({
        slug: skill.slug,
        contentHash: builtinSkillContentHash(skill),
      })),
      experts: CATALOGUE_EXPERTS.map((expert) => ({
        slug: expert.slug,
        contentHash: builtinExpertContentHash(expert),
      })),
    },
    sources: {
      expertInstalls: inventory.expertInstalls,
      skillRows: inventory.skillRows,
      grants: inventory.grants,
      connectorInstalls: inventory.connectorInstalls,
    },
    counts: {
      expertInstalls: inventory.expertInstalls.length,
      mappedExpertInstalls: inventory.expertInstalls.filter(
        (record) => record.mapping !== null,
      ).length,
      grants: inventory.grants.length,
      mappedGrants: inventory.grants.filter((r) => r.mapping !== null).length,
      skillRows: inventory.skillRows.length,
      matchingSkillRows: inventory.skillRows.filter((r) => r.matchesBuiltin)
        .length,
      connectorInstalls: inventory.connectorInstalls.length,
      unresolved:
        inventory.expertInstalls.filter((r) => r.unresolved !== null).length +
        inventory.grants.filter((r) => r.unresolved !== null).length +
        inventory.skillRows.filter((r) => r.unresolved !== null).length +
        inventory.connectorInstalls.filter((r) => r.unresolved !== null).length,
    },
  };
  return { ...manifest, manifestDigest: manifestDigestOf(manifest) };
}

// ---------------------------------------------------------------------------
// Shadow read (Spec §12.3): same-scope visibility comparison, zero writes
// ---------------------------------------------------------------------------

export interface ShadowReadReport {
  readonly kind: "legacy-migration-shadow-read";
  readonly version: 1;
  readonly generatedAt: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly legacyVisible: readonly string[];
  readonly packageVisible: readonly string[];
  readonly matched: readonly string[];
  readonly legacyOnly: readonly string[];
  readonly packageOnly: readonly string[];
}

/**
 * Identity vocabulary: `expert:<slug>` on the legacy side matches the
 * package's `expertTemplate:<slug>` resource; skills share `skill:<slug>`.
 * Only the SAME scope's visible sets are compared — never a union across
 * teams, never a write.
 */
export function diffShadowRead(
  legacyVisible: readonly string[],
  packageVisible: readonly string[],
): { matched: string[]; legacyOnly: string[]; packageOnly: string[] } {
  const normalize = (id: string) =>
    id.startsWith("expertTemplate:")
      ? `expert:${id.slice("expertTemplate:".length)}`
      : id;
  const legacy = new Set(legacyVisible.map(normalize));
  const pkg = new Set(packageVisible.map(normalize));
  const matched = [...legacy].filter((id) => pkg.has(id)).sort();
  return {
    matched,
    legacyOnly: [...legacy].filter((id) => !pkg.has(id)).sort(),
    packageOnly: [...pkg].filter((id) => !legacy.has(id)).sort(),
  };
}

export async function shadowReadForScope(
  legacy: Database,
  setup: Database,
  scope: { tenantId: string; workspaceId: string },
  builtin: BuiltinFacts,
): Promise<ShadowReadReport> {
  const inventory = await readLegacyInventory(legacy, setup, builtin);
  const inScope = (ownership: OwnershipEvidence | null) =>
    ownership !== null &&
    ownership.tenantId === scope.tenantId &&
    ownership.workspaceId === scope.workspaceId;
  const legacyVisible = [
    ...inventory.expertInstalls
      .filter((r) => inScope(r.ownership))
      .map((r) => `expert:${r.expertSlug}`),
    ...inventory.grants
      .filter((r) => inScope(r.ownership))
      .map((r) => `skill:${r.ref}`),
  ].sort();

  const installRows = await setup
    .select({ id: enterprisePackageInstalls.id })
    .from(enterprisePackageInstalls)
    .where(
      and(
        eq(enterprisePackageInstalls.tenantId, scope.tenantId),
        eq(enterprisePackageInstalls.workspaceId, scope.workspaceId),
        eq(enterprisePackageInstalls.packageKey, BUILTIN_PACKAGE_KEY),
      ),
    );
  // The package side's OPERATIONAL visible set: the skills Bots in this scope
  // may actually run (active grants) and the experts that exist for it
  // (provenance rows) — the same question the legacy read answers, asked of
  // the new module. Bare resource links are deliberately NOT counted: an
  // install links every catalogue resource, which would make the comparison
  // vacuous.
  const installIds = installRows.map((row) => row.id);
  const packageVisible: string[] = [];
  if (installIds.length > 0) {
    const grants = (await setup.$client.unsafe(
      `select distinct resource_id from enterprise_package_grants
       where tenant_id = $1 and workspace_id = $2 and revoked_at is null`,
      [scope.tenantId, scope.workspaceId],
    )) as Array<{ resource_id: string }>;
    packageVisible.push(...grants.map((row) => `skill:${row.resource_id}`));
    const experts = (await setup.$client.unsafe(
      `select resource_id from enterprise_package_experts
       where tenant_id = $1 and workspace_id = $2`,
      [scope.tenantId, scope.workspaceId],
    )) as Array<{ resource_id: string }>;
    packageVisible.push(
      ...experts.map((row) => `expertTemplate:${row.resource_id}`),
    );
  }
  packageVisible.sort();
  const diff = diffShadowRead(legacyVisible, packageVisible);
  return {
    kind: "legacy-migration-shadow-read",
    version: 1,
    generatedAt: new Date().toISOString(),
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    legacyVisible,
    packageVisible,
    ...diff,
  };
}

// ---------------------------------------------------------------------------
// Scope-write helpers (used by the apply CLI through the restricted channels)
// ---------------------------------------------------------------------------

export interface MigrationChannels {
  /** Read-only superuser/setup connection for inventory evidence. */
  readonly setup: Database;
  /** Read-only app-database connection for legacy tables. */
  readonly legacy: Database;
}

function connectionUrl(
  flag: string | undefined,
  ...envNames: string[]
): string {
  if (flag) return flag;
  for (const name of envNames) {
    const value = process.env[name];
    if (value?.trim()) return value;
  }
  throw new Error(
    `a database URL is required: pass ${envNames[0].toLowerCase().replaceAll("_", "-")} or set ${envNames.join(" / ")}`,
  );
}

export async function openMigrationChannels(options: {
  legacyUrl?: string;
  setupUrl?: string;
}): Promise<{ channels: MigrationChannels; close(): Promise<void> }> {
  const legacy = createDatabase(
    connectionUrl(options.legacyUrl, "DATABASE_URL", "TEST_DATABASE_URL"),
    { max: 2 },
  );
  const setup = createDatabase(
    connectionUrl(
      options.setupUrl,
      "ENTERPRISE_TEST_SETUP_DATABASE_URL",
      "TEST_DATABASE_URL",
      "DATABASE_URL",
    ),
    { max: 2 },
  );
  const close = async () => {
    await Promise.allSettled([legacy.$client.close(), setup.$client.close()]);
  };
  return { channels: { setup, legacy }, close };
}

/** The scope's install of the built-in package, tombstones included. */
export async function findScopeInstall(
  setup: Database,
  scope: { tenantId: string; workspaceId: string },
): Promise<{ id: string; status: string; revision: number } | null> {
  const [row] = await setup
    .select({
      id: enterprisePackageInstalls.id,
      status: enterprisePackageInstalls.status,
      revision: enterprisePackageInstalls.revision,
    })
    .from(enterprisePackageInstalls)
    .where(
      and(
        eq(enterprisePackageInstalls.tenantId, scope.tenantId),
        eq(enterprisePackageInstalls.workspaceId, scope.workspaceId),
        eq(enterprisePackageInstalls.packageKey, BUILTIN_PACKAGE_KEY),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Records the package-template provenance of one migrated legacy Bot inside
 * the SAME operator transaction discipline the service mutations use. The
 * Bot itself is never created, moved or edited here. Returns whether the row
 * was written (an existing row is a no-op — replays converge).
 */
export async function upsertExpertProvenance(
  mutation: PackageMutationStore,
  scope: PlatformScope,
  admin: CompanyAdminContext,
  record: {
    workspaceId: string;
    agentId: string;
    installId: string;
    revision: number;
    resourceId: string;
  },
): Promise<boolean> {
  const { enterprisePackageExperts } = await import(
    "../db/schema/enterprise-plugin-packages"
  );
  let written = false;
  await mutation.transaction(scope, admin, async (tx) => {
    const existing = await tx.db
      .select({ agentId: enterprisePackageExperts.agentId })
      .from(enterprisePackageExperts)
      .where(
        and(
          eq(enterprisePackageExperts.tenantId, scope.tenantId),
          eq(enterprisePackageExperts.agentId, record.agentId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;
    await tx.db.insert(enterprisePackageExperts).values({
      tenantId: scope.tenantId,
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      installId: record.installId,
      revision: record.revision,
      resourceId: record.resourceId,
      expertTemplateRef: `${BUILTIN_PACKAGE_KEY}/${record.resourceId}`,
      createdBy: admin.principalId,
    });
    written = true;
  });
  return written;
}
