import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  type PackageExpertCreatedDTO,
  type PackageExpertCreateInput,
  PackageExpertCreateInputSchema,
  type PackageExpertTemplate,
  PackageExpertTemplateSchema,
} from "../../../../shared/enterprise/plugin-package-contracts";
import {
  enterprisePackageChanges as changeRows,
  enterprisePackageExperts as expertRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import {
  ArtifactError,
  loadArtifact,
  MAX_TEXT_FILE_BYTES,
} from "../../plugin-packages/artifact";
import type { PackageCatalogue } from "../../plugin-packages/catalogue";
import type { PlatformScope } from "../contracts";
import type { CompanyAdminContext } from "../tenancy/workspace-admin";
import {
  assertPackageWriteTx,
  type PackageExpertMutationResult,
  type PackageMutationStore,
  type PackageReadStore,
  type PackageWriteTx,
  packageError,
} from "./contracts";
import { grantTemplateSkillsWithin, readIdempotencyReceipt } from "./grants";
import {
  assertReleaseUsable,
  canonicalJson,
  sha256Hex,
  type UsablePackageRelease,
} from "./plans";

/**
 * PKG04A expert instantiation (Spec §7/§8, acceptance #463 1–7).
 *
 * An admin instantiates a scoped Bot from an installed package's expert
 * template. One operator transaction writes profile + ownership + provenance +
 * the initial Skill grant; a replay with the same (actor, Idempotency-Key)
 * returns the SAME agentId, the same key with any other input is a 409.
 *
 * Facts and their authorities:
 *   - The template's fields live in the INSTALLED REVISION's verified artifact
 *     (`loadArtifact`, outside the transaction — the artifact is immutable and
 *     was verified at catalogue assembly; the digest is re-proven on load).
 *     The request never carries template content — only installId, resourceId,
 *     the display name and the CAS revision.
 *   - The template file accepts ONLY name/summary/systemPrompt/in-package
 *     skill refs. Any endpoint/auth/remote-runtime field (or any unknown
 *     field — the schema is strict) is `TEMPLATE_FIELD_REJECTED`; the file's
 *     skill refs must equal the manifest's `expertTemplate.skills`.
 *   - The profile write goes through the restricted SQL function
 *     `openbot_create_package_expert` (INVOKER, RLS armed; PUBLIC has zero
 *     EXECUTE, only `ob_ent_operator` may call it). The function re-proves the
 *     `app.tenant_id` / `app.workspace_id` binding and enforces the
 *     `built_in`/no-endpoint contract at the SQL layer — a deployment's
 *     managed agent configuration can never turn a package Bot remote, and the
 *     creator/ownership come from the trusted scope, never from the body.
 *   - Provenance (`enterprise_package_experts`) is append-only metadata: the
 *     table has no UPDATE/DELETE channel, so an upgrade or uninstall can never
 *     rewrite a created Bot's lineage.
 *   - The initial Skill grant reuses the grants seam (`grantTemplateSkillsWithin`)
 *     INSIDE this transaction: same table, same revision bump rules, skills
 *     limited to the template's refs of the install's current revision. No
 *     connector tool is ever auto-granted and no connection row is written.
 *
 * Lock order, documented placement: the mutation store has already taken the
 * canonical member locks (tenant → principal → membership →
 * workspace-membership). This module then appends — never reorders — exactly
 * apply's prefix release(packageKey/version) → packageKey(tenant/workspace/
 * package) → idempotency(actor/key), then the install lock, then the grant
 * lock (install → grant(bot), grants.ts order). No plan lock: this path holds
 * no plan. The clock is read only after every lock.
 *
 * The install lock is keyed on the INPUT-DERIVED install id and taken BEFORE
 * the install row is read (grants.ts `grantLockKeys` shape): the
 * enabled/expectedRevision/currentVersion CAS checks therefore run serialized
 * against any concurrent install mutation — an upgrade that commits while
 * this transaction waits on the lock is re-read, never satisfied by a stale
 * expectedRevision.
 */

/** Pre-transaction resolution: the release and its parsed template. */
export interface ResolvedExpertTemplate {
  readonly release: UsablePackageRelease;
  readonly template: PackageExpertTemplate;
}

/** SQLSTATE 23505 probe, identical to the apply/grant paths' helper. */
function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; ) {
    const code = (current as Error & { code?: unknown }).code;
    const errno = (current as Error & { errno?: unknown }).errno;
    const sqlState = typeof code === "string" ? code : errno;
    if (sqlState === "23505" && current.message.includes(constraint)) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 128 ||
    !/^[\x20-\x7e]+$/.test(idempotencyKey)
  ) {
    throw packageError("INPUT_INVALID");
  }
}

export function expertRequestDigest(input: {
  installId: string;
  resourceId: string;
  expectedRevision: number;
  name: string;
}): string {
  return sha256Hex(
    `openbot:plugin-package-expert:v1\0${canonicalJson({
      expectedRevision: input.expectedRevision,
      installId: input.installId,
      name: input.name,
      resourceId: input.resourceId,
    })}`,
  );
}

/**
 * Bounded read of the template file from the VERIFIED artifact root. The
 * artifact walk already refused symlinks/escapes and proved every
 * manifest-declared path exists; the containment re-check here is defense in
 * depth. An unreadable artifact is storage (503), never a 400.
 */
async function readTemplateFile(
  artifactRoot: string,
  relative: string,
): Promise<string> {
  const root = artifactRoot.endsWith(sep) ? artifactRoot : artifactRoot + sep;
  const absolute = join(artifactRoot, ...relative.split("/"));
  let resolved: string | null = null;
  try {
    resolved = await realpath(absolute);
  } catch {
    resolved = null;
  }
  if (!resolved?.startsWith(root)) {
    throw packageError("PACKAGE_STORAGE_UNAVAILABLE");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw packageError("PACKAGE_STORAGE_UNAVAILABLE");
  }
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    throw packageError("TEMPLATE_FIELD_REJECTED");
  }
  return bytes.toString("utf8");
}

function parseTemplate(text: string, manifestSkills: readonly string[]) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw packageError("TEMPLATE_FIELD_REJECTED");
  }
  const parsed = PackageExpertTemplateSchema.safeParse(parsedJson);
  if (!parsed.success) throw packageError("TEMPLATE_FIELD_REJECTED");
  const template = parsed.data;
  // Trimmed, non-empty content only — a whitespace-only field is a rejected
  // template, not a Bot that answers nobody.
  if (
    !template.name.trim() ||
    !template.summary.trim() ||
    !template.systemPrompt.trim()
  ) {
    throw packageError("TEMPLATE_FIELD_REJECTED");
  }
  const manifestSet = [...manifestSkills].sort();
  const fileSet = [...template.skills].sort();
  if (
    manifestSet.length !== fileSet.length ||
    manifestSet.some((skill, index) => skill !== fileSet[index])
  ) {
    throw packageError("TEMPLATE_FIELD_REJECTED");
  }
  return template;
}

/**
 * Everything that must be known BEFORE the operator transaction opens:
 * the install's own release facts and the parsed template of the exact
 * expertTemplate resource. Unknown install/resource → 404; unusable release
 * or vanished artifact → 422; template field problems → TEMPLATE_FIELD_REJECTED.
 */
export async function resolveExpertTemplate(
  catalogue: PackageCatalogue,
  readStore: PackageReadStore,
  scope: PlatformScope,
  artifactRoot: string | null,
  input: PackageExpertCreateInput,
): Promise<ResolvedExpertTemplate> {
  const facts = await readStore.getInstall(scope, input.installId);
  if (!facts) throw packageError("RESOURCE_NOT_FOUND");
  const release = assertReleaseUsable(
    await catalogue.resolveRelease(facts.packageKey, facts.version),
  );
  if (!artifactRoot) throw packageError("PACKAGE_STORAGE_UNAVAILABLE");
  let artifact: Awaited<ReturnType<typeof loadArtifact>>;
  try {
    artifact = await loadArtifact(artifactRoot, release.artifactDigest);
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw packageError("PACKAGE_UNSUPPORTED");
    }
    throw error;
  }
  const resource = artifact.manifest.resources.find(
    (candidate) =>
      candidate.kind === "expertTemplate" && candidate.id === input.resourceId,
  );
  if (resource?.kind !== "expertTemplate") {
    throw packageError("RESOURCE_NOT_FOUND");
  }
  const template = parseTemplate(
    await readTemplateFile(artifact.root, resource.path),
    resource.skills,
  );
  return { release, template };
}

/**
 * The in-transaction half (also the driven-test seam for mid-transaction
 * failure injection, exactly like the PKG03A lifecycle seam): expects the
 * caller's `PackageMutationStore.transaction` — trusted scope + admin already
 * revalidated. Writes ownership (through the restricted SQL function),
 * provenance and the initial Skill grant, then the change receipt. Any throw
 * rolls the whole thing back: no ghost Bot.
 */
export async function instantiateExpertWithin(
  tx: PackageWriteTx,
  scope: PlatformScope,
  input: PackageExpertCreateInput,
  idempotencyKey: string,
  resolved: ResolvedExpertTemplate,
  now: () => Date,
): Promise<PackageExpertMutationResult> {
  assertPackageWriteTx(tx);
  const { release, template } = resolved;

  // Locks appended after the member locks (see module comment): release →
  // package-key → idempotency, then the install lock — keyed on the
  // INPUT-DERIVED install id, BEFORE the install row is read, mirroring
  // grants.ts `grantLockKeys` — and finally the grant lock (install →
  // grant(bot)). Every CAS check below therefore runs under the install
  // lock: an upgrade committing while this transaction waits is re-read,
  // never satisfied by a stale expectedRevision.
  const releaseLock = JSON.stringify([
    "enterprise",
    "package-release",
    release.packageKey,
    release.version,
  ]);
  const packageKeyLock = JSON.stringify([
    "enterprise",
    "package-key",
    scope.tenantId,
    scope.workspaceId,
    release.packageKey,
  ]);
  const idempotencyLock = JSON.stringify([
    "enterprise",
    "package-idempotency",
    scope.tenantId,
    scope.workspaceId,
    scope.actorId,
    idempotencyKey,
  ]);
  const installLock = JSON.stringify([
    "enterprise",
    "package-install",
    scope.tenantId,
    input.installId,
  ]);
  // The Bot id is server-generated before the lock so the grant lock can name
  // it; nothing reads it from the caller and the global unique index is the
  // only authority on collisions.
  const agentId = `pkg-expert-${randomUUID()}`;
  const grantLock = JSON.stringify([
    "enterprise",
    "package-grant",
    scope.tenantId,
    input.installId,
    agentId,
  ]);
  for (const key of [
    releaseLock,
    packageKeyLock,
    idempotencyLock,
    installLock,
    grantLock,
  ]) {
    await tx.db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
  // The clock is read after every canonical lock.
  const createdAt = now();

  // Under the install lock: the install row and its CAS checks. Unknown or
  // cross-workspace install → 404 (same shape); disabled →
  // PACKAGE_UNSUPPORTED; a revision moved by a concurrent upgrade →
  // REVISION_CONFLICT; a current version that no longer matches the resolved
  // release → PLAN_CHANGED.
  const [install] = await tx.db
    .select({
      id: installRows.id,
      workspaceId: installRows.workspaceId,
      packageKey: installRows.packageKey,
      currentVersion: installRows.currentVersion,
      status: installRows.status,
      revision: installRows.revision,
    })
    .from(installRows)
    .where(
      and(
        eq(installRows.tenantId, scope.tenantId),
        eq(installRows.id, input.installId),
      ),
    )
    .limit(1);
  if (!install || install.workspaceId !== scope.workspaceId) {
    throw packageError("RESOURCE_NOT_FOUND");
  }
  if (install.status !== "enabled") {
    throw packageError("PACKAGE_UNSUPPORTED");
  }
  if (install.revision !== input.expectedRevision) {
    throw packageError("REVISION_CONFLICT");
  }
  if (install.currentVersion !== release.version) {
    throw packageError("PLAN_CHANGED");
  }

  // Idempotency receipt BEFORE any write: same key + same canonical request
  // replays the stored agentId; same key + any other input is a 409.
  const requestDigest = expertRequestDigest({
    installId: input.installId,
    resourceId: input.resourceId,
    expectedRevision: input.expectedRevision,
    name: input.name,
  });
  const receipt = await readIdempotencyReceipt(tx, scope, idempotencyKey);
  if (receipt) {
    if (receipt.requestDigest !== requestDigest) {
      throw packageError("IDEMPOTENCY_CONFLICT");
    }
    return {
      expert: receipt.response as PackageExpertCreatedDTO,
      created: false,
    };
  }

  // The pinned revision must still be the artifact we validated the template
  // against: revision rows are immutable, so a digest mismatch means the
  // install moved between the pre-read and this transaction.
  const [revision] = await tx.db
    .select({ artifactDigest: revisionRows.artifactDigest })
    .from(revisionRows)
    .where(
      and(
        eq(revisionRows.tenantId, scope.tenantId),
        eq(revisionRows.installId, install.id),
        eq(revisionRows.revision, install.revision),
      ),
    )
    .limit(1);
  if (!revision || revision.artifactDigest !== release.artifactDigest) {
    throw packageError("PLAN_CHANGED");
  }

  // Profile + ownership, through the restricted operator-EXECUTE-only
  // function. Ownership fields come from the trusted scope only. The config
  // parameter travels as the object (Bun SQL JSON-encodes it onto the wire);
  // a JSON.stringify'd string would arrive as a jsonb SCALAR string and be
  // rightly refused by the function's shape check.
  const defaultConfig = {
    agentType: "built_in" as const,
    summary: template.summary.trim(),
    systemPrompt: template.systemPrompt.trim(),
  };
  await tx.db.execute(
    sql`select public.openbot_create_package_expert(${scope.tenantId}, ${agentId}, ${scope.workspaceId}, ${scope.principalId}, ${input.name.trim()}, ${defaultConfig})`,
  );

  // Provenance: append-only metadata (no UPDATE/DELETE channel exists).
  const expertTemplateRef = `${release.packageKey}/${input.resourceId}`;
  await tx.db.insert(expertRows).values({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    agentId,
    installId: install.id,
    revision: install.revision,
    resourceId: input.resourceId,
    expertTemplateRef,
    createdBy: scope.principalId,
  });

  // Initial Skill grant — the grants seam, inside THIS transaction.
  const grant = await grantTemplateSkillsWithin(
    tx,
    scope,
    { id: install.id, revision: install.revision },
    agentId,
    template.skills,
    scope.principalId,
    createdAt,
  );

  const expert: PackageExpertCreatedDTO = {
    agentId,
    installId: install.id,
    packageKey: release.packageKey,
    version: release.version,
    resourceId: input.resourceId,
    expertTemplateRef,
    displayName: input.name.trim(),
    grantRevision: grant.generation,
    resources: grant.resources,
  };
  // Change receipt: ids and counters only (no template content), same ledger
  // and idempotency semantics as install/grant.
  await tx.db.insert(changeRows).values({
    tenantId: scope.tenantId,
    changeId: randomUUID(),
    workspaceId: scope.workspaceId,
    installId: install.id,
    revision: install.revision,
    actorId: scope.actorId,
    action: "createExpert",
    diff: {
      action: "createExpert",
      agentId,
      expertTemplateRef,
      grantRevision: grant.generation,
      packageKey: release.packageKey,
      resources: grant.resources.map((resource) => resource.resourceId),
    },
    idempotencyKey,
    requestDigest,
    resultJson: expert,
  });
  return { expert, created: true };
}

export interface CreatePackageExpertServiceInput {
  readonly catalogue: PackageCatalogue;
  readonly readStore: PackageReadStore;
  /** Null when the restricted operator channel could not be verified. */
  readonly mutation: PackageMutationStore | null;
  /**
   * Content-addressed artifact root (the catalogue's root). Null degrades
   * instantiation to 503 — the template can not be proven against an artifact,
   * so nothing is created (fail closed).
   */
  readonly artifactRoot: string | null;
  readonly now?: () => Date;
}

export function createPackageExpertService(
  input: CreatePackageExpertServiceInput,
): {
  instantiateExpert(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    rawInput: PackageExpertCreateInput,
    idempotencyKey: string,
  ): Promise<PackageExpertMutationResult>;
} {
  const { catalogue, readStore, mutation, artifactRoot } = input;
  const now = input.now ?? (() => new Date());

  const requireMutation = (): PackageMutationStore => {
    if (!mutation) throw packageError("ADMIN_CHANNEL_UNAVAILABLE");
    return mutation;
  };

  return {
    async instantiateExpert(scope, admin, rawInput, idempotencyKey) {
      assertIdempotencyKey(idempotencyKey);
      const parsed = PackageExpertCreateInputSchema.safeParse(rawInput);
      if (!parsed.success) throw packageError("INPUT_INVALID");
      const expertInput = parsed.data;
      if (!expertInput.name.trim()) throw packageError("INPUT_INVALID");
      // Immutable artifact verification happens OUTSIDE the write transaction
      // (same discipline as apply).
      const resolved = await resolveExpertTemplate(
        catalogue,
        readStore,
        scope,
        artifactRoot,
        expertInput,
      );
      const store = requireMutation();
      try {
        return await store.transaction(scope, admin, (tx) =>
          instantiateExpertWithin(
            tx,
            scope,
            expertInput,
            idempotencyKey,
            resolved,
            now,
          ),
        );
      } catch (error) {
        if (
          uniqueViolation(error, "enterprise_package_change_idempotency_uq")
        ) {
          throw packageError("IDEMPOTENCY_CONFLICT");
        }
        throw error;
      }
    },
  };
}
