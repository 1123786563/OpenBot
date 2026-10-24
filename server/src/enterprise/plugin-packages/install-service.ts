import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type PackageBlocker,
  type PackageGrantDTO,
  type PackageInstallAction,
  type PackageInstallDetailDTO,
  PackageInstallDetailDTOSchema,
  type PackageInstallDTO,
  PackageInstallDTOSchema,
  type PackageInstallStatusUpdate,
  PackageInstallStatusUpdateSchema,
  type PackageListQuery,
  type PackageManifestV1,
  type PackagePage,
  PackagePageSchema,
  type PackagePlanDTO,
  PackagePlanDTOSchema,
  type PackagePlanInput,
  PackagePlanInputSchema,
  type PackagePlanVersionDiff,
  type PackageResourceKind,
} from "../../../../shared/enterprise/plugin-package-contracts";
import {
  enterprisePackageChanges as changeRows,
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageResourceLinks as linkRows,
  enterprisePackagePlans as planRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import { enterprisePluginInstalls as connectorInstallRows } from "../../db/schema/enterprise-plugins";
import type {
  PackageCatalogue,
  PackageReleaseFacts,
} from "../../plugin-packages/catalogue";
import type { PlatformScope } from "../contracts";
import type { CompanyAdminContext } from "../tenancy/workspace-admin";
import {
  assertPackageWriteTx,
  type PackageApplyResult,
  type PackageClock,
  type PackageInstallFacts,
  type PackageInstallStatusResult,
  type PackageMutationStore,
  type PackageReadStore,
  type PackageService,
  type PackageWriteTx,
  packageError,
} from "./contracts";
import { createPackageExpertService } from "./experts";
import {
  createPackageGrantService,
  revokeGrantsForInstallLifecycle,
} from "./grants";
import {
  addedToolsOf,
  applyRequestDigest,
  assertReleaseUsable,
  canonicalJson,
  canonicalPlanInput,
  changeDiff,
  lifecycleActionOf,
  lifecycleChangeDiff,
  lifecycleRequestDigest,
  PLAN_TTL_MS,
  planInputDigest,
  previewBlockers,
  previewResources,
  requiredConnectorIds,
  toPlanDTO,
  validateConnectorMappings,
  versionDiff,
} from "./plans";

/** Active-grant facts → wire DTOs (installId comes from the install). */
function grantDTOs(facts: PackageInstallFacts): PackageGrantDTO[] {
  return facts.grants.map((grant) => ({
    installId: facts.installId,
    botId: grant.botId,
    revision: grant.revision,
    resources: [...grant.resources],
  }));
}

/**
 * PKG02 package service: list/get (restricted data role), plan/apply (restricted
 * operator role through `PackageMutationStore`).
 *
 * Apply order, straight from Spec §8:
 *   artifact verified outside the transaction → one operator transaction →
 *   canonical locks (release → package key → idempotency → install → plan) →
 *   idempotency receipt → expiry → plan/scope/binding revalidation → install +
 *   revision + resource links + change receipt + consumed plan, atomically.
 *
 * Nothing in this module calls a vendor, opens a transport or logs a secret.
 */

export interface CreatePackageServiceInput {
  /** Catalogue assembled and verified at startup. */
  readonly catalogue: PackageCatalogue;
  readonly readStore: PackageReadStore;
  /** Null when the restricted operator channel could not be verified. */
  readonly mutation: PackageMutationStore | null;
  /**
   * PKG04A: content-addressed artifact root for expert-template reads. Null
   * degrades expert instantiation to 503 (fail closed); every other path is
   * unaffected.
   */
  readonly artifactRoot?: string | null;
  readonly now?: PackageClock;
}

function releaseOrArtifactBlockers(
  release: PackageReleaseFacts | null,
): PackageBlocker[] {
  if (!release) return [{ code: "ARTIFACT_MISSING" }];
  const artifactBlockers = release.blockers.filter(
    (blocker) =>
      blocker.code === "ARTIFACT_MISSING" ||
      blocker.code === "ARTIFACT_INVALID" ||
      blocker.code === "PACKAGE_WITHDRAWN" ||
      blocker.code === "PACKAGE_UNSUPPORTED",
  );
  if (!release.verified && artifactBlockers.length === 0) {
    return [{ code: "ARTIFACT_INVALID" }];
  }
  return [...artifactBlockers];
}

function requiredConnectorBlockers(
  release: PackageReleaseFacts | null,
  facts: PackageInstallFacts,
): PackageBlocker[] {
  const manifest = release?.manifest;
  if (!manifest) return [];
  const linked = new Set(
    facts.links
      .filter((link) => link.kind === "managedConnector")
      .map((link) => link.resourceId),
  );
  return requiredConnectorIds(manifest)
    .filter((resourceId) => !linked.has(resourceId))
    .map((resourceId) => ({ code: "NEEDS_CONNECTION" as const, resourceId }));
}

/**
 * Derived readiness: unavailable → needs_connection → needs_grant → ready.
 * Grants exist since PKG03A and the read store loads ACTIVE (never-revoked)
 * grant facts on both list and detail paths, so the final hop is live: an
 * enabled, verified, fully-connected install is `ready` only while at least
 * one active grant fact remains — revoking the last grant returns it to
 * `needs_grant`.
 */
function readinessOf(
  facts: PackageInstallFacts,
  release: PackageReleaseFacts | null,
  hasActiveGrant: boolean,
): PackageInstallDTO["readiness"] {
  if (facts.status !== "enabled") return "unavailable";
  if (!release?.verified) return "unavailable";
  // PKG08 (#467): a withdrawn release is unavailable with its real reason.
  // Unlisting deliberately does NOT land here — `listed=false` changes only
  // discovery and never the installed release's runtime eligibility.
  if (release.state !== "published") return "unavailable";
  if (requiredConnectorBlockers(release, facts).length > 0) {
    return "needs_connection";
  }
  return hasActiveGrant ? "ready" : "needs_grant";
}

/**
 * PKG07 (#466): the actions THIS build actually supports on an existing
 * install, computed from the caller's company role and the install's state.
 *
 *   - `enabled`   → version moves (`plan`/`apply`), `grant`, `createExpert`,
 *                   and the two ways out of enabled: `disable`, `uninstall`;
 *   - `disabled`  → `enable` (back on, grants still revoked) and `uninstall`;
 *   - `uninstalled` (tombstone) → `enable` only: the reinstall path. Version
 *                   moves and grants start from an enabled install again.
 *
 * A caller who cannot manage the install (a member or an auditor browses) gets
 * an honest empty array; the server re-authorizes every write regardless.
 */
function allowedActionsOf(
  status: PackageInstallFacts["status"],
  isAdmin: boolean,
): PackageInstallAction[] {
  if (!isAdmin) return [];
  switch (status) {
    case "enabled":
      return ["plan", "apply", "grant", "createExpert", "disable", "uninstall"];
    case "disabled":
      return ["enable", "uninstall"];
    default:
      return ["enable"];
  }
}

function installDTO(
  facts: PackageInstallFacts,
  release: PackageReleaseFacts | null,
  caller: { readonly isAdmin: boolean },
  /** PKG07: the write path knows the live grant state without rebuilding it. */
  hasActiveGrant: boolean = facts.grants.length > 0,
): PackageInstallDTO {
  const readiness = readinessOf(facts, release, hasActiveGrant);
  const blockers: PackageBlocker[] = [];
  if (readiness === "unavailable") {
    blockers.push(...releaseOrArtifactBlockers(release));
  } else {
    blockers.push(...requiredConnectorBlockers(release, facts));
    if (readiness === "needs_grant") blockers.push({ code: "NEEDS_GRANT" });
  }
  return {
    installId: facts.installId,
    packageKey: facts.packageKey,
    version: facts.version,
    artifactDigest: facts.artifactDigest,
    revision: facts.revision,
    generation: facts.generation,
    status: facts.status,
    readiness,
    blockers,
    allowedActions: allowedActionsOf(facts.status, caller.isAdmin),
  };
}

function detailResources(
  facts: PackageInstallFacts,
  release: PackageReleaseFacts | null,
): Array<{
  id: string;
  kind: PackageResourceKind;
  available: boolean;
  tools?: Array<{ ref: string; effect: "read" | "write" }>;
}> {
  const linked = new Set(facts.links.map((link) => link.resourceId));
  const manifest = release?.manifest;
  if (manifest) {
    // PKG05: a connector resource tells the grant form which tools it may
    // grant — the same manifest list the server validates the write against.
    const declared = addedToolsOf(manifest);
    return manifest.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      available:
        resource.kind === "managedConnector"
          ? linked.has(resource.id)
          : release?.verified === true,
      ...(resource.kind === "managedConnector"
        ? {
            tools: declared
              .filter((tool) => tool.ref.startsWith(`${resource.id}:`))
              .map((tool) => ({ ref: tool.ref, effect: tool.effect })),
          }
        : {}),
    }));
  }
  return facts.links.map((link) => ({
    id: link.resourceId,
    kind: link.kind,
    available: false,
  }));
}

/** SQLSTATE + constraint probe for concurrent unique violations. */
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

/**
 * PKG07 (#466): allowed lifecycle transitions. Same-status targets never reach
 * here — they are the idempotent no-op arm (no second generation bump, no
 * second revocation). `uninstalled → disabled` has no meaning: a tombstone
 * either comes back `enabled` (the reinstall path) or stays uninstalled.
 */
function lifecycleTransitionAllowed(
  previous: PackageInstallDTO["status"],
  next: PackageInstallDTO["status"],
): boolean {
  switch (previous) {
    case "enabled":
      return next === "disabled" || next === "uninstalled";
    case "disabled":
      return next === "enabled" || next === "uninstalled";
    default:
      return next === "enabled";
  }
}

/**
 * The install facts a lifecycle DTO is built from, read INSIDE the writer's
 * operator transaction: the current revision's resource links (readiness needs
 * the required connectors). Grants themselves are not rebuilt here — an install
 * DTO carries no grant list; the caller feeds readiness the live grant fact
 * through `installDTO`'s explicit argument.
 */
async function lifecycleFactsWithin(
  tx: PackageWriteTx,
  scope: PlatformScope,
  install: {
    readonly id: string;
    readonly packageKey: string;
    readonly version: string;
    readonly artifactDigest: string;
    readonly revision: number;
    readonly generation: number;
    readonly status: PackageInstallDTO["status"];
  },
): Promise<PackageInstallFacts> {
  const links = await tx.db
    .select({
      resourceId: linkRows.resourceId,
      kind: linkRows.kind,
      connectorInstallId: linkRows.connectorInstallId,
      existingSkillId: linkRows.existingSkillId,
      expertTemplateRef: linkRows.expertTemplateRef,
    })
    .from(linkRows)
    .where(
      and(
        eq(linkRows.tenantId, scope.tenantId),
        eq(linkRows.installId, install.id),
        eq(linkRows.revision, install.revision),
      ),
    );
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    installId: install.id,
    packageKey: install.packageKey,
    version: install.version,
    artifactDigest: install.artifactDigest,
    revision: install.revision,
    generation: install.generation,
    status: install.status,
    links: links.map((link) => ({
      resourceId: link.resourceId,
      kind: link.kind as PackageResourceKind,
      connectorInstallId: link.connectorInstallId,
      existingSkillId: link.existingSkillId,
      expertTemplateRef: link.expertTemplateRef,
    })),
    // Placeholder shape only: PackageInstallDTO carries no grant list, and the
    // one reader of `grants` on this path is readiness, fed by the explicit
    // `hasActiveGrant` argument below. Never surfaced as grant facts.
    grants: [],
    callerCompanyRole: "tenant_admin",
  };
}

export function createPackageService(
  input: CreatePackageServiceInput,
): PackageService {
  const { catalogue, readStore, mutation } = input;
  const now: PackageClock = input.now ?? (() => new Date());

  const requireMutation = (): PackageMutationStore => {
    if (!mutation) throw packageError("ADMIN_CHANNEL_UNAVAILABLE");
    return mutation;
  };

  /** Does any active (never revoked) grant row still stand for this install? */
  const hasActiveGrantWithin = async (
    tx: PackageWriteTx,
    scope: PlatformScope,
    installId: string,
  ): Promise<boolean> => {
    const [row] = await tx.db
      .select({ botId: grantRows.botId })
      .from(grantRows)
      .where(
        and(
          eq(grantRows.tenantId, scope.tenantId),
          eq(grantRows.installId, installId),
          isNull(grantRows.revokedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  };

  return {
    // PKG03A grant service: setBotGrant/revokeBotGrant on the same trusted
    // operator channel (mutations revalidate admin/membership per transaction).
    // PKG06: the artifact root travels with it — connector-tool grants take
    // their contract from the install's CURRENT revision manifest, and after
    // an upgrade that manifest is the new revision's.
    ...createPackageGrantService({
      mutation,
      artifactRoot: input.artifactRoot ?? null,
      now,
    }),

    // PKG04A expert instantiation on the same trusted operator channel.
    ...createPackageExpertService({
      catalogue,
      readStore,
      mutation,
      artifactRoot: input.artifactRoot ?? null,
      now,
    }),

    async list(scope, query: PackageListQuery): Promise<PackagePage> {
      const page = await catalogue.list(scope, query);
      const installs = await readStore.listInstalls(scope);
      const byPackageKey = new Map(
        installs.map((facts) => [facts.packageKey, facts]),
      );
      const items = await Promise.all(
        page.items.map(async (item) => {
          const facts = byPackageKey.get(item.packageKey);
          if (!facts) return { ...item, install: null };
          const release = await catalogue.resolveRelease(
            facts.packageKey,
            facts.version,
          );
          return {
            ...item,
            install: installDTO(facts, release, {
              isAdmin: facts.callerCompanyRole === "tenant_admin",
            }),
          };
        }),
      );
      return PackagePageSchema.parse({ items, nextCursor: page.nextCursor });
    },

    async get(scope, installId): Promise<PackageInstallDetailDTO> {
      const facts = await readStore.getInstall(scope, installId);
      if (!facts) throw packageError("RESOURCE_NOT_FOUND");
      const release = await catalogue.resolveRelease(
        facts.packageKey,
        facts.version,
      );
      // PKG06: the published-version facts the detail screen draws beside the
      // install — the newest listed release and the exact targets an
      // upgrade/rollback plan may name. PKG08: listVersions returns listed
      // PUBLISHED releases only, so a withdrawn release is neither the newest
      // published face nor a picker target. The guard keeps older catalogue
      // implementations (and the untyped test seams) from breaking the read.
      const versions =
        typeof catalogue.listVersions === "function"
          ? await catalogue.listVersions(facts.packageKey)
          : [];
      const usable = versions.filter((entry) => entry.verified && entry.listed);
      // PKG10 (#469): the unknown-effect badge rides the same detail read —
      // redacted (a count only), preserved whatever the install's lifecycle
      // state. Same guard discipline as listVersions: an older read store (or
      // an untyped test seam) keeps the detail it always answered, and the
      // badge is simply absent rather than breaking the read.
      const unknownDispatches =
        typeof readStore.countUnknownDispatches === "function"
          ? await readStore.countUnknownDispatches(scope, installId)
          : undefined;
      return PackageInstallDetailDTOSchema.parse({
        ...installDTO(facts, release, {
          isAdmin: facts.callerCompanyRole === "tenant_admin",
        }),
        resources: detailResources(facts, release),
        // PKG03A: the install's active Bot grants (revoked grants are never
        // surfaced; "安装≠授权" — the grant list IS the authorization state).
        grants: grantDTOs(facts),
        latestPublishedVersion: usable[0]?.version ?? null,
        availableVersions: usable.map((entry) => ({
          version: entry.version,
          artifactDigest: entry.artifactDigest,
        })),
        unknownDispatches,
      });
    },

    async plan(
      scope,
      admin: CompanyAdminContext,
      planInput: PackagePlanInput,
    ): Promise<PackagePlanDTO> {
      const parsed = PackagePlanInputSchema.safeParse(planInput);
      if (!parsed.success) throw packageError("INPUT_INVALID");
      const wellFormed = parsed.data;
      // The install contract keeps its PKG02 shape: a first install carries
      // no revision; the revision CAS belongs to upgrade/rollback below.
      if (
        wellFormed.operation === "install" &&
        wellFormed.expectedRevision !== null
      ) {
        throw packageError("REVISION_CONFLICT");
      }
      // Exact published target only: an unknown version answers 404, an
      // unlisted or unverifiable release answers PACKAGE_UNSUPPORTED, and
      // there is no "latest" spelling to resolve — the wire version pattern
      // already refuses one.
      const release = assertReleaseUsable(
        await catalogue.resolveRelease(
          wellFormed.packageKey,
          wellFormed.version,
        ),
      );
      const manifest = release.manifest as PackageManifestV1;
      const mappings = validateConnectorMappings(manifest, wellFormed);

      const canonicalInput = canonicalPlanInput(wellFormed);
      const inputDigest = planInputDigest(canonicalInput);
      const planId = randomUUID();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + PLAN_TTL_MS);
      /*
       * The preview is computed INSIDE the plan transaction (the install row
       * it diffs against is read there) and carried out for the DTO; the
       * transaction throwing means no plan row and no DTO either. A holder
       * object keeps TypeScript's control flow from narrowing the callback
       * assignment away.
       */
      interface PlannedPreview {
        resources: Array<{ id: string; kind: PackageResourceKind }>;
        addedTools: PackagePlanDTO["addedTools"];
        removedTools: string[];
        blockers: PackageBlocker[];
        diff?: PackagePlanVersionDiff;
      }
      const planned: {
        preview: PlannedPreview | null;
        expectedRevision: number | null;
        operation: PackagePlanDTO["operation"];
      } = { preview: null, expectedRevision: null, operation: "install" };

      await requireMutation().transaction(scope, admin, async (tx) => {
        assertPackageWriteTx(tx);
        for (const mapping of mappings) {
          const [connectorInstall] = await tx.db
            .select({ id: connectorInstallRows.id })
            .from(connectorInstallRows)
            .where(
              and(
                eq(connectorInstallRows.tenantId, scope.tenantId),
                eq(connectorInstallRows.workspaceId, scope.workspaceId),
                eq(connectorInstallRows.id, mapping.connectorInstallId),
              ),
            )
            .limit(1);
          // Unknown and cross-scope references answer the same 404.
          if (!connectorInstall) throw packageError("RESOURCE_NOT_FOUND");
        }

        // PKG06: a plan always looks at the live install row — an install
        // request against an installed package is PRESENTED as the upgrade it
        // actually is (PKG02 L-1: never a misleading first-install preview),
        // and an explicit upgrade/rollback must find one to move.
        const [install] = await tx.db
          .select({
            id: installRows.id,
            status: installRows.status,
            revision: installRows.revision,
            currentVersion: installRows.currentVersion,
          })
          .from(installRows)
          .where(
            and(
              eq(installRows.tenantId, scope.tenantId),
              eq(installRows.workspaceId, scope.workspaceId),
              eq(installRows.packageKey, wellFormed.packageKey),
            ),
          )
          .limit(1);

        const isVersionChange = install !== undefined;
        if (wellFormed.operation !== "install" && !isVersionChange) {
          // Nothing to upgrade or roll back: the same 404 as an unknown
          // install id, never a hint about other scopes' installs.
          throw packageError("RESOURCE_NOT_FOUND");
        }
        if (isVersionChange && install.status !== "enabled") {
          // PKG07 owns disable/uninstall; a non-enabled install is not a
          // version-change target in this build.
          throw packageError("PACKAGE_UNSUPPORTED");
        }
        if (wellFormed.operation !== "install") {
          // Explicit upgrade/rollback: the caller must name the exact live
          // revision. Null, stale or moved answers the same 409 — the caller
          // re-reads and replans.
          if (
            wellFormed.expectedRevision === null ||
            wellFormed.expectedRevision !== install.revision
          ) {
            throw packageError("REVISION_CONFLICT");
          }
        }

        const effectiveOperation: PackagePlanDTO["operation"] = isVersionChange
          ? wellFormed.operation === "install"
            ? "upgrade"
            : wellFormed.operation
          : "install";
        const expectedRevision = isVersionChange ? install.revision : null;

        let preview: PlannedPreview & { expiresAt: string };
        if (!isVersionChange) {
          preview = {
            resources: previewResources(manifest),
            addedTools: addedToolsOf(manifest),
            removedTools: [],
            blockers: previewBlockers(manifest, mappings),
            expiresAt: expiresAt.toISOString(),
          };
        } else {
          // The current revision's stored facts (immutable rows) and, when
          // the current release still resolves, its manifest. A current
          // release that left the catalogue degrades the diff to the stored
          // facts — every target tool then counts as the increment instead
          // of guessing what the old manifest declared.
          const [currentRevisionRow] = await tx.db
            .select({
              config: revisionRows.config,
            })
            .from(revisionRows)
            .where(
              and(
                eq(revisionRows.tenantId, scope.tenantId),
                eq(revisionRows.installId, install.id),
                eq(revisionRows.revision, install.revision),
              ),
            )
            .limit(1);
          const currentLinks = await tx.db
            .select({
              resourceId: linkRows.resourceId,
              kind: linkRows.kind,
            })
            .from(linkRows)
            .where(
              and(
                eq(linkRows.tenantId, scope.tenantId),
                eq(linkRows.installId, install.id),
                eq(linkRows.revision, install.revision),
              ),
            );
          const currentRelease = await catalogue.resolveRelease(
            wellFormed.packageKey,
            install.currentVersion,
          );
          const diff = versionDiff({
            target: manifest,
            targetConfig: (canonicalInput.config ?? {}) as Record<
              string,
              unknown
            >,
            currentVersion: install.currentVersion,
            currentRevision: install.revision,
            currentConfig:
              ((currentRevisionRow?.config ?? {}) as Record<string, unknown>) ??
              {},
            currentResources: currentLinks.map((link) => ({
              resourceId: link.resourceId,
              kind: link.kind as PackageResourceKind,
            })),
            currentManifest:
              currentRelease?.manifest instanceof Object
                ? (currentRelease.manifest as PackageManifestV1)
                : null,
          });
          preview = {
            resources: previewResources(manifest),
            addedTools: diff.addedTools,
            removedTools: diff.removedTools,
            blockers: previewBlockers(manifest, mappings),
            expiresAt: expiresAt.toISOString(),
            diff: {
              currentVersion: diff.currentVersion,
              currentRevision: diff.currentRevision,
              addedResources: diff.addedResources,
              removedResources: diff.removedResources,
              changedTools: diff.changedTools,
              configChanges: diff.configChanges,
              connectionChanges: diff.connectionChanges,
            },
          };
        }

        await tx.db.insert(planRows).values({
          tenantId: scope.tenantId,
          id: planId,
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          principalId: scope.principalId,
          // The operation the plan WILL perform: an install request against
          // an installed package is recorded (and applied) as the upgrade it
          // is, while the canonical input keeps the caller's request.
          operation: effectiveOperation,
          packageKey: release.packageKey,
          version: release.version,
          artifactDigest: release.artifactDigest,
          expectedRevision,
          canonicalInput,
          inputDigest,
          preview,
          expiresAt,
        });

        const { expiresAt: _storedExpiry, ...previewForDto } = preview;
        planned.preview = previewForDto;
        planned.expectedRevision = expectedRevision;
        planned.operation = effectiveOperation;
      });

      return PackagePlanDTOSchema.parse(
        toPlanDTO({
          planId,
          operation: planned.operation,
          release,
          expectedRevision: planned.expectedRevision,
          expiresAt,
          resources: planned.preview?.resources ?? [],
          addedTools: planned.preview?.addedTools ?? [],
          removedTools: planned.preview?.removedTools ?? [],
          blockers: planned.preview?.blockers ?? [],
          ...(planned.preview?.diff === undefined
            ? {}
            : { diff: planned.preview.diff }),
        }),
      );
    },

    async apply(
      scope,
      admin,
      planId,
      idempotencyKey,
    ): Promise<PackageApplyResult> {
      const store = requireMutation();
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 128 ||
        !/^[\x20-\x7e]+$/.test(idempotencyKey)
      ) {
        throw packageError("INPUT_INVALID");
      }
      const plan = await store.readPlan(scope, planId);
      if (!plan) throw packageError("RESOURCE_NOT_FOUND");
      if (
        plan.operation !== "install" &&
        plan.operation !== "upgrade" &&
        plan.operation !== "rollback"
      ) {
        // Closed vocabulary; a future operation this build does not know.
        throw packageError("PACKAGE_UNSUPPORTED");
      }
      // Immutable artifact verification happens OUTSIDE the write transaction.
      const release = assertReleaseUsable(
        await catalogue.resolveRelease(plan.packageKey, plan.version),
      );
      if (release.artifactDigest !== plan.artifactDigest) {
        throw packageError("PLAN_CHANGED");
      }
      const requestDigest = applyRequestDigest(plan);

      try {
        return await store.transaction(scope, admin, async (tx) => {
          assertPackageWriteTx(tx);

          // Lock order after the member locks the mutation store took:
          // release → package key → idempotency → install → plan.
          const locks = [
            JSON.stringify([
              "enterprise",
              "package-release",
              plan.packageKey,
              plan.version,
            ]),
            JSON.stringify([
              "enterprise",
              "package-key",
              scope.tenantId,
              scope.workspaceId,
              plan.packageKey,
            ]),
            JSON.stringify([
              "enterprise",
              "package-idempotency",
              scope.tenantId,
              scope.workspaceId,
              scope.actorId,
              idempotencyKey,
            ]),
          ];
          for (const key of locks) {
            await tx.db.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
            );
          }

          const [existing] = await tx.db
            .select({
              id: installRows.id,
              status: installRows.status,
              revision: installRows.revision,
              generation: installRows.generation,
              currentVersion: installRows.currentVersion,
            })
            .from(installRows)
            .where(
              and(
                eq(installRows.tenantId, scope.tenantId),
                eq(installRows.workspaceId, scope.workspaceId),
                eq(installRows.packageKey, plan.packageKey),
              ),
            )
            .limit(1);
          if (existing) {
            const installKey = JSON.stringify([
              "enterprise",
              "package-install",
              scope.tenantId,
              existing.id,
            ]);
            await tx.db.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${installKey}, 0))`,
            );
          }
          const planLockKey = JSON.stringify([
            "enterprise",
            "package-plan",
            scope.tenantId,
            plan.planId,
          ]);
          await tx.db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${planLockKey}, 0))`,
          );
          // The clock is read after every canonical lock: a plan that expires
          // while apply waits for a lock is expired, not grandfathered by a
          // timestamp taken before the wait.
          const appliedAt = now();

          // Idempotency receipt BEFORE expiry: a replayed key returns the
          // stored result even after the plan expired.
          const [receipt] = await tx.db
            .select({
              requestDigest: changeRows.requestDigest,
              response: changeRows.resultJson,
            })
            .from(changeRows)
            .where(
              and(
                eq(changeRows.tenantId, scope.tenantId),
                eq(changeRows.workspaceId, scope.workspaceId),
                eq(changeRows.actorId, scope.actorId),
                eq(changeRows.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (receipt) {
            if (receipt.requestDigest !== requestDigest) {
              throw packageError("IDEMPOTENCY_CONFLICT");
            }
            return {
              install: PackageInstallDTOSchema.parse(receipt.response),
              created: false,
            };
          }

          const [lockedPlan] = await tx.db
            .select({
              id: planRows.id,
              workspaceId: planRows.workspaceId,
              actorId: planRows.actorId,
              principalId: planRows.principalId,
              operation: planRows.operation,
              packageKey: planRows.packageKey,
              version: planRows.version,
              expectedRevision: planRows.expectedRevision,
              consumedAt: planRows.consumedAt,
              expiresAt: planRows.expiresAt,
              inputDigest: planRows.inputDigest,
              artifactDigest: planRows.artifactDigest,
              canonicalInput: planRows.canonicalInput,
              result: planRows.result,
            })
            .from(planRows)
            .where(
              and(
                eq(planRows.tenantId, scope.tenantId),
                eq(planRows.id, plan.planId),
              ),
            )
            .limit(1);
          if (
            !lockedPlan ||
            lockedPlan.workspaceId !== scope.workspaceId ||
            lockedPlan.actorId !== scope.actorId ||
            lockedPlan.principalId !== scope.principalId
          ) {
            throw packageError("RESOURCE_NOT_FOUND");
          }
          // Every decision below reads the LOCKED row, never the pre-lock
          // `plan`. Recomputing the input digest from the locked canonical
          // input is what detects a row rewritten between `readPlan` and this
          // transaction: comparing `lockedPlan.inputDigest` with
          // `plan.inputDigest` was the same row read twice and could not fail.
          const recomputedInputDigest = planInputDigest(
            lockedPlan.canonicalInput,
          );
          // PKG06: install plans carry no revision; upgrade/rollback plans
          // carry the exact revision they were CAS-bound to at plan time.
          const lockedExpectedRevision =
            lockedPlan.operation === "install"
              ? null
              : lockedPlan.expectedRevision;
          if (
            lockedPlan.id !== plan.planId ||
            lockedPlan.operation !== plan.operation ||
            lockedPlan.packageKey !== plan.packageKey ||
            lockedPlan.version !== plan.version ||
            lockedExpectedRevision !== plan.expectedRevision ||
            lockedPlan.inputDigest !== plan.inputDigest ||
            recomputedInputDigest !== lockedPlan.inputDigest ||
            lockedPlan.artifactDigest !== plan.artifactDigest ||
            lockedPlan.artifactDigest !== release.artifactDigest
          ) {
            throw packageError("PLAN_CHANGED");
          }
          const canonical = (lockedPlan.canonicalInput ?? {}) as Record<
            string,
            unknown
          >;
          const config = (canonical.config ?? {}) as Record<string, unknown>;
          const packageKey = lockedPlan.packageKey;
          const version = lockedPlan.version;
          const artifactDigest = lockedPlan.artifactDigest;

          if (lockedPlan.consumedAt) {
            // A consumed plan replayed under a new key returns the original
            // result and records the new key as its own receipt.
            const result = PackageInstallDTOSchema.parse(lockedPlan.result);
            await tx.db.insert(changeRows).values({
              tenantId: scope.tenantId,
              changeId: randomUUID(),
              workspaceId: scope.workspaceId,
              installId: result.installId,
              revision: result.revision,
              actorId: scope.actorId,
              action: lockedPlan.operation,
              diff: changeDiff({
                operation: lockedPlan.operation,
                packageKey,
                version,
                artifactDigest,
                revision: result.revision,
                config,
              }),
              idempotencyKey,
              requestDigest,
              resultJson: result,
            });
            return { install: result, created: false };
          }

          if (appliedAt.getTime() > lockedPlan.expiresAt.getTime()) {
            throw packageError("PLAN_EXPIRED");
          }

          if (lockedPlan.operation !== "install") {
            // ---------------------------------------------------------------
            // PKG06 (#465): upgrade / rollback. The install row is CAS-moved
            // to a NEW revision (append-only rows, never a rewrite); grants
            // are neither revoked nor revived — a changed tool contract needs
            // a fresh grant and dispatch refuses the old pins meanwhile.
            // ---------------------------------------------------------------
            if (!existing) {
              // The install vanished: installs are never deleted in V1, so
              // this is an unknown id answering the same 404.
              throw packageError("RESOURCE_NOT_FOUND");
            }
            if (existing.status !== "enabled") {
              // PKG07 owns disable/uninstall; not a version-change target.
              throw packageError("PACKAGE_UNSUPPORTED");
            }
            if (
              lockedPlan.expectedRevision === null ||
              lockedPlan.expectedRevision !== existing.revision
            ) {
              // A concurrent upgrade moved the install, or this plan was
              // bound to a revision that no longer stands: one deterministic
              // 409, the caller re-reads and replans.
              throw packageError("REVISION_CONFLICT");
            }

            // The current revision's immutable facts (digest + config) decide
            // the same-version idempotence below; its links decide connector
            // carry-over.
            const [currentRevisionRow] = await tx.db
              .select({
                artifactDigest: revisionRows.artifactDigest,
                config: revisionRows.config,
              })
              .from(revisionRows)
              .where(
                and(
                  eq(revisionRows.tenantId, scope.tenantId),
                  eq(revisionRows.installId, existing.id),
                  eq(revisionRows.revision, existing.revision),
                ),
              )
              .limit(1);
            if (!currentRevisionRow) {
              // The install row names a revision no immutable row proves:
              // replan, never move the install on unverifiable content.
              throw packageError("PLAN_CHANGED");
            }
            const currentConfig = (currentRevisionRow.config ?? {}) as Record<
              string,
              unknown
            >;

            if (
              existing.currentVersion === version &&
              currentRevisionRow.artifactDigest === artifactDigest &&
              canonicalJson(currentConfig) === canonicalJson(config)
            ) {
              // Same version, same digest, same full config: applying is an
              // idempotent no-op that returns the standing install and
              // records the receipt.
              const standingFacts: PackageInstallFacts = {
                tenantId: scope.tenantId,
                workspaceId: scope.workspaceId,
                installId: existing.id,
                packageKey,
                version,
                artifactDigest,
                revision: existing.revision,
                generation: existing.generation,
                status: existing.status,
                links: [],
                grants: [],
                callerCompanyRole: "tenant_admin",
              };
              const standing = installDTO(standingFacts, release, {
                isAdmin: true,
              });
              await tx.db.insert(changeRows).values({
                tenantId: scope.tenantId,
                changeId: randomUUID(),
                workspaceId: scope.workspaceId,
                installId: existing.id,
                revision: existing.revision,
                actorId: scope.actorId,
                action: lockedPlan.operation,
                diff: changeDiff({
                  operation: lockedPlan.operation,
                  packageKey,
                  version,
                  artifactDigest,
                  revision: existing.revision,
                  config,
                  previousVersion: existing.currentVersion,
                  previousRevision: existing.revision,
                }),
                idempotencyKey,
                requestDigest,
                resultJson: standing,
              });
              await tx.db
                .update(planRows)
                .set({ consumedAt: appliedAt, result: standing })
                .where(
                  and(
                    eq(planRows.tenantId, scope.tenantId),
                    eq(planRows.id, lockedPlan.id),
                  ),
                );
              return { install: standing, created: false };
            }

            // New revision: strictly greater, never reused; generation only
            // ratchets on lifecycle changes (PKG07), not on version changes.
            const newRevision = existing.revision + 1;
            await tx.db
              .update(installRows)
              .set({
                currentVersion: version,
                revision: newRevision,
                updatedAt: appliedAt,
              })
              .where(
                and(
                  eq(installRows.tenantId, scope.tenantId),
                  eq(installRows.id, existing.id),
                ),
              );
            await tx.db.insert(revisionRows).values({
              tenantId: scope.tenantId,
              installId: existing.id,
              revision: newRevision,
              releaseVersion: version,
              artifactDigest,
              config,
              createdBy: scope.principalId,
            });

            // Rebuild the new revision's links from the target manifest. A
            // connector resource the caller remapped uses the new mapping;
            // one they left unmapped KEEPS the current revision's link for
            // the same resource id (an explicit standing choice, kept — not
            // a guessed default); one with neither mapping nor standing link
            // stays unlinked (NEEDS_CONNECTION), never a fake reference.
            const manifest = release.manifest as PackageManifestV1;
            const mapped = new Map(
              Object.entries(
                (canonical.connectorInstalls ?? {}) as Record<string, string>,
              ),
            );
            const currentLinks = await tx.db
              .select({
                resourceId: linkRows.resourceId,
                kind: linkRows.kind,
                connectorInstallId: linkRows.connectorInstallId,
                expertTemplateRef: linkRows.expertTemplateRef,
              })
              .from(linkRows)
              .where(
                and(
                  eq(linkRows.tenantId, scope.tenantId),
                  eq(linkRows.installId, existing.id),
                  eq(linkRows.revision, existing.revision),
                ),
              );
            const standingConnectorByResource = new Map(
              currentLinks
                .filter(
                  (link) =>
                    link.kind === "managedConnector" &&
                    link.connectorInstallId !== null,
                )
                .map((link) => [link.resourceId, link.connectorInstallId]),
            );
            const linked: Array<{
              resourceId: string;
              kind: PackageResourceKind;
              connectorInstallId: string | null;
              expertTemplateRef: string | null;
            }> = [];
            for (const resource of manifest.resources) {
              if (resource.kind === "skill") {
                linked.push({
                  resourceId: resource.id,
                  kind: "skill",
                  connectorInstallId: null,
                  expertTemplateRef: null,
                });
              } else if (resource.kind === "expertTemplate") {
                linked.push({
                  resourceId: resource.id,
                  kind: "expertTemplate",
                  connectorInstallId: null,
                  expertTemplateRef: `${release.packageKey}/${resource.id}`,
                });
              } else {
                const connectorInstallId =
                  mapped.get(resource.id) ??
                  standingConnectorByResource.get(resource.id);
                if (connectorInstallId === undefined) continue;
                linked.push({
                  resourceId: resource.id,
                  kind: "managedConnector",
                  connectorInstallId,
                  expertTemplateRef: null,
                });
              }
            }
            if (linked.length > 0) {
              // R4-3 discipline, same as the install path: re-prove inside
              // THIS transaction that every connector install about to be
              // referenced still exists — a delete in the plan→apply window
              // answers CONNECTOR_INSTALL_MISSING, never a bare FK 500.
              for (const connectorInstallId of [
                ...new Set(
                  linked
                    .map((link) => link.connectorInstallId)
                    .filter((id): id is string => id !== null),
                ),
              ]) {
                const [stillThere] = await tx.db
                  .select({ id: connectorInstallRows.id })
                  .from(connectorInstallRows)
                  .where(
                    and(
                      eq(connectorInstallRows.tenantId, scope.tenantId),
                      eq(connectorInstallRows.workspaceId, scope.workspaceId),
                      eq(connectorInstallRows.id, connectorInstallId),
                    ),
                  )
                  .limit(1);
                if (!stillThere) {
                  throw packageError("CONNECTOR_INSTALL_MISSING");
                }
              }
              await tx.db.insert(linkRows).values(
                linked.map((link) => ({
                  tenantId: scope.tenantId,
                  installId: existing.id,
                  revision: newRevision,
                  resourceId: link.resourceId,
                  workspaceId: scope.workspaceId,
                  kind: link.kind,
                  existingSkillId: null,
                  connectorInstallId: link.connectorInstallId,
                  expertTemplateRef: link.expertTemplateRef,
                })),
              );
            }

            const upgradedFacts: PackageInstallFacts = {
              tenantId: scope.tenantId,
              workspaceId: scope.workspaceId,
              installId: existing.id,
              packageKey,
              version,
              artifactDigest,
              revision: newRevision,
              generation: existing.generation,
              status: "enabled",
              links: linked.map((link) => ({
                resourceId: link.resourceId,
                kind: link.kind,
                connectorInstallId: link.connectorInstallId,
                existingSkillId: null,
                expertTemplateRef: link.expertTemplateRef,
              })),
              grants: [],
              callerCompanyRole: "tenant_admin",
            };
            const upgraded = installDTO(upgradedFacts, release, {
              isAdmin: true,
            });
            await tx.db.insert(changeRows).values({
              tenantId: scope.tenantId,
              changeId: randomUUID(),
              workspaceId: scope.workspaceId,
              installId: existing.id,
              revision: newRevision,
              actorId: scope.actorId,
              action: lockedPlan.operation,
              diff: changeDiff({
                operation: lockedPlan.operation,
                packageKey,
                version,
                artifactDigest,
                revision: newRevision,
                config,
                previousVersion: existing.currentVersion,
                previousRevision: existing.revision,
              }),
              idempotencyKey,
              requestDigest,
              resultJson: upgraded,
            });
            await tx.db
              .update(planRows)
              .set({ consumedAt: appliedAt, result: upgraded })
              .where(
                and(
                  eq(planRows.tenantId, scope.tenantId),
                  eq(planRows.id, lockedPlan.id),
                ),
              );
            return { install: upgraded, created: false };
          }

          // One install per (tenant, workspace, package_key): a different plan
          // for an already-installed package is a conflict, never an overwrite.
          if (existing) throw packageError("REVISION_CONFLICT");

          const installId = randomUUID();
          const revision = 1;
          await tx.db.insert(installRows).values({
            tenantId: scope.tenantId,
            id: installId,
            workspaceId: scope.workspaceId,
            packageKey,
            currentVersion: version,
            status: "enabled",
            generation: 1,
            revision,
            installedBy: scope.principalId,
          });
          await tx.db.insert(revisionRows).values({
            tenantId: scope.tenantId,
            installId,
            revision,
            releaseVersion: version,
            artifactDigest,
            config,
            createdBy: scope.principalId,
          });

          const manifest = release.manifest as PackageManifestV1;
          const mapped = new Map(
            Object.entries(
              (canonical.connectorInstalls ?? {}) as Record<string, string>,
            ),
          );
          const linked: Array<{
            resourceId: string;
            kind: PackageResourceKind;
            connectorInstallId: string | null;
            expertTemplateRef: string | null;
          }> = [];
          for (const resource of manifest.resources) {
            if (resource.kind === "skill") {
              linked.push({
                resourceId: resource.id,
                kind: "skill",
                connectorInstallId: null,
                expertTemplateRef: null,
              });
            } else if (resource.kind === "expertTemplate") {
              linked.push({
                resourceId: resource.id,
                kind: "expertTemplate",
                connectorInstallId: null,
                expertTemplateRef: `${release.packageKey}/${resource.id}`,
              });
            } else {
              const connectorInstallId = mapped.get(resource.id);
              // A connector without a mapping stays unlinked (NEEDS_CONNECTION),
              // never a fake reference and never a copied secret.
              if (connectorInstallId === undefined) continue;
              linked.push({
                resourceId: resource.id,
                kind: "managedConnector",
                connectorInstallId,
                expertTemplateRef: null,
              });
            }
          }
          if (linked.length > 0) {
            // R4-3: plan verified these connector installs, but up to ten
            // minutes passed since. Re-prove, inside THIS transaction, that
            // every connector install about to be referenced still exists —
            // otherwise a delete in the plan→apply window would surface as a
            // bare FK violation (500-shaped), never a product verdict.
            for (const connectorInstallId of [
              ...new Set(
                linked
                  .map((link) => link.connectorInstallId)
                  .filter((id): id is string => id !== null),
              ),
            ]) {
              const [stillThere] = await tx.db
                .select({ id: connectorInstallRows.id })
                .from(connectorInstallRows)
                .where(
                  and(
                    eq(connectorInstallRows.tenantId, scope.tenantId),
                    eq(connectorInstallRows.workspaceId, scope.workspaceId),
                    eq(connectorInstallRows.id, connectorInstallId),
                  ),
                )
                .limit(1);
              if (!stillThere) {
                throw packageError("CONNECTOR_INSTALL_MISSING");
              }
            }
            await tx.db.insert(linkRows).values(
              linked.map((link) => ({
                tenantId: scope.tenantId,
                installId,
                revision,
                resourceId: link.resourceId,
                workspaceId: scope.workspaceId,
                kind: link.kind,
                existingSkillId: null,
                connectorInstallId: link.connectorInstallId,
                expertTemplateRef: link.expertTemplateRef,
              })),
            );
          }

          const facts: PackageInstallFacts = {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            installId,
            packageKey,
            version,
            artifactDigest,
            revision,
            generation: 1,
            status: "enabled",
            links: linked.map((link) => ({
              resourceId: link.resourceId,
              kind: link.kind,
              connectorInstallId: link.connectorInstallId,
              existingSkillId: null,
              expertTemplateRef: link.expertTemplateRef,
            })),
            grants: [],
            // The write path revalidated this actor as tenant_admin inside
            // the mutation transaction; the result DTO names what they may do.
            callerCompanyRole: "tenant_admin",
          };
          const result = installDTO(facts, release, { isAdmin: true });
          await tx.db.insert(changeRows).values({
            tenantId: scope.tenantId,
            changeId: randomUUID(),
            workspaceId: scope.workspaceId,
            installId,
            revision,
            actorId: scope.actorId,
            action: "install",
            diff: changeDiff({
              operation: "install",
              packageKey,
              version,
              artifactDigest,
              revision,
              config,
            }),
            idempotencyKey,
            requestDigest,
            resultJson: result,
          });
          await tx.db
            .update(planRows)
            .set({ consumedAt: appliedAt, result })
            .where(
              and(
                eq(planRows.tenantId, scope.tenantId),
                eq(planRows.id, lockedPlan.id),
              ),
            );
          return { install: result, created: true };
        });
      } catch (error) {
        if (uniqueViolation(error, "enterprise_package_install_scope_key_uq")) {
          throw packageError("REVISION_CONFLICT");
        }
        if (
          uniqueViolation(error, "enterprise_package_change_idempotency_uq")
        ) {
          throw packageError("IDEMPOTENCY_CONFLICT");
        }
        throw error;
      }
    },

    /**
     * PKG07 (#466): move one install's lifecycle status under the revision CAS.
     *
     * Lock order (Spec §8): the mutation store already holds the member class
     * exclusively; this method takes the INSTALL class EXCLUSIVELY — the same
     * advisory key dispatch takes SHARED for its `prepared → dispatched` CAS.
     * Commit order therefore decides the disable/dispatch race, never
     * timestamps:
     *   - a disable/uninstall that commits FIRST moves the generation and the
     *     status, so a waiting CAS re-reads `status != 'enabled'` /
     *     `generation != pin.installGeneration` and refuses before any
     *     transport call (network: 0);
     *   - a CAS that commits FIRST is already dispatched; the disable revokes
     *     the grants but the completion write is deliberately NOT gated on
     *     authorization, so a real external effect keeps its receipt or its
     *     `unknown` state instead of being relabelled as withdrawn.
     *
     * Nothing is deleted: the install row is a tombstone, revisions, Run pins,
     * change receipts and dispatch evidence all stay.
     */
    async updateInstallStatus(
      scope: PlatformScope,
      admin: CompanyAdminContext,
      installId: string,
      rawInput: PackageInstallStatusUpdate,
      idempotencyKey: string,
    ): Promise<PackageInstallStatusResult> {
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 128 ||
        !/^[\x20-\x7e]+$/.test(idempotencyKey)
      ) {
        throw packageError("INPUT_INVALID");
      }
      const parsed = PackageInstallStatusUpdateSchema.safeParse(rawInput);
      if (!parsed.success) throw packageError("INPUT_INVALID");
      if (
        typeof installId !== "string" ||
        installId.trim() === "" ||
        installId.length > 128
      ) {
        throw packageError("RESOURCE_NOT_FOUND");
      }
      const input = parsed.data;
      const store = requireMutation();
      const requestDigest = lifecycleRequestDigest({
        installId,
        status: input.status,
        expectedRevision: input.expectedRevision,
      });

      try {
        return await store.transaction(scope, admin, async (tx) => {
          assertPackageWriteTx(tx);
          const installLockKey = JSON.stringify([
            "enterprise",
            "package-install",
            scope.tenantId,
            installId,
          ]);
          await tx.db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${installLockKey}, 0))`,
          );
          const changedAt = now();

          const [receipt] = await tx.db
            .select({
              requestDigest: changeRows.requestDigest,
              response: changeRows.resultJson,
            })
            .from(changeRows)
            .where(
              and(
                eq(changeRows.tenantId, scope.tenantId),
                eq(changeRows.workspaceId, scope.workspaceId),
                eq(changeRows.actorId, scope.actorId),
                eq(changeRows.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (receipt) {
            // Replay under the same key: the stored answer stands, whatever
            // the install has done since (a receipt is an audit fact).
            if (receipt.requestDigest !== requestDigest) {
              throw packageError("IDEMPOTENCY_CONFLICT");
            }
            return {
              install: PackageInstallDTOSchema.parse(receipt.response),
              changed: false,
            };
          }

          const [install] = await tx.db
            .select({
              id: installRows.id,
              workspaceId: installRows.workspaceId,
              packageKey: installRows.packageKey,
              currentVersion: installRows.currentVersion,
              status: installRows.status,
              generation: installRows.generation,
              revision: installRows.revision,
            })
            .from(installRows)
            .where(
              and(
                eq(installRows.tenantId, scope.tenantId),
                eq(installRows.id, installId),
              ),
            )
            .limit(1);
          // Cross-scope and unknown ids answer the same 404 (the operator RLS
          // pins the tenant; the workspace predicate is the second line).
          if (!install || install.workspaceId !== scope.workspaceId) {
            throw packageError("RESOURCE_NOT_FOUND");
          }
          // The CAS names the revision the caller read: an upgrade/rollback
          // that moved it makes this request stale (409, re-read and retry).
          // Lifecycle changes move the GENERATION only — revision stays the
          // version fact PKG06 defined, so a lifecycle retry is idempotent
          // instead of ratcheting counters.
          if (input.expectedRevision !== install.revision) {
            throw packageError("REVISION_CONFLICT");
          }
          const [currentRevision] = await tx.db
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
          if (!currentRevision) {
            // The install row names a revision no immutable row proves.
            throw packageError("RESOURCE_NOT_FOUND");
          }
          const release = await catalogue.resolveRelease(
            install.packageKey,
            install.currentVersion,
          );
          const previousStatus = install.status as PackageInstallDTO["status"];

          const dtoFor = async (
            status: PackageInstallDTO["status"],
            generation: number,
            hasActiveGrant: boolean,
          ): Promise<PackageInstallDTO> => {
            const facts = await lifecycleFactsWithin(tx, scope, {
              id: install.id,
              packageKey: install.packageKey,
              version: install.currentVersion,
              artifactDigest: currentRevision.artifactDigest,
              revision: install.revision,
              generation,
              status,
            });
            return installDTO(
              facts,
              release,
              { isAdmin: true },
              hasActiveGrant,
            );
          };

          if (input.status === previousStatus) {
            // Idempotent no-op: the install already stands where the caller
            // asked. No generation bump (a retry must not ratchet it) and no
            // second revocation; the request still earns a receipt so the key
            // replays deterministically.
            const hasActiveGrant = await hasActiveGrantWithin(
              tx,
              scope,
              install.id,
            );
            const standing = await dtoFor(
              previousStatus,
              install.generation,
              hasActiveGrant,
            );
            await tx.db.insert(changeRows).values({
              tenantId: scope.tenantId,
              changeId: randomUUID(),
              workspaceId: scope.workspaceId,
              installId: install.id,
              revision: install.revision,
              actorId: scope.actorId,
              action: lifecycleActionOf(input.status),
              diff: lifecycleChangeDiff({
                action: lifecycleActionOf(input.status),
                packageKey: install.packageKey,
                version: install.currentVersion,
                revision: install.revision,
                previousStatus,
                status: previousStatus,
                previousGeneration: install.generation,
                generation: install.generation,
                revokedGrants: 0,
              }),
              idempotencyKey,
              requestDigest,
              resultJson: standing,
            });
            return { install: standing, changed: false };
          }

          if (!lifecycleTransitionAllowed(previousStatus, input.status)) {
            throw packageError("PACKAGE_UNSUPPORTED");
          }

          // Every effective lifecycle move bumps the generation — enabled,
          // disabled and uninstalled alike. That is what makes an OLD Run pin
          // (which recorded the generation at admission) unable to dispatch
          // after a disable AND unable to revive after a re-enable: the
          // generation never returns to a value a pin holds.
          const nextGeneration = install.generation + 1;
          // Disable and uninstall revoke the install's ACTIVE grants in the
          // same transaction that moves the status (Spec §10). Enable touches
          // no grant row: a revoked approval never comes back.
          const revokedGrants =
            input.status === "enabled"
              ? 0
              : await revokeGrantsForInstallLifecycle(
                  tx,
                  { tenantId: scope.tenantId, installId: install.id },
                  changedAt,
                );
          await tx.db
            .update(installRows)
            .set({
              status: input.status,
              generation: nextGeneration,
              updatedAt: changedAt,
            })
            .where(
              and(
                eq(installRows.tenantId, scope.tenantId),
                eq(installRows.id, install.id),
                // Defence in depth: the row must still be the one this
                // transaction read under the exclusive install lock.
                eq(installRows.status, previousStatus),
                eq(installRows.revision, install.revision),
              ),
            );
          // Re-enable never invents a grant: whatever active rows survive (in
          // practice none — disable revoked them) is read as a live FACT here,
          // so readiness says `needs_grant` instead of claiming ready.
          const hasActiveGrant =
            input.status === "enabled"
              ? await hasActiveGrantWithin(tx, scope, install.id)
              : false;
          const next = await dtoFor(
            input.status,
            nextGeneration,
            hasActiveGrant,
          );
          const action = lifecycleActionOf(input.status);
          await tx.db.insert(changeRows).values({
            tenantId: scope.tenantId,
            changeId: randomUUID(),
            workspaceId: scope.workspaceId,
            installId: install.id,
            revision: install.revision,
            actorId: scope.actorId,
            action,
            diff: lifecycleChangeDiff({
              action,
              packageKey: install.packageKey,
              version: install.currentVersion,
              revision: install.revision,
              previousStatus,
              status: input.status,
              previousGeneration: install.generation,
              generation: nextGeneration,
              revokedGrants,
            }),
            idempotencyKey,
            requestDigest,
            resultJson: next,
          });
          return { install: next, changed: true };
        });
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
