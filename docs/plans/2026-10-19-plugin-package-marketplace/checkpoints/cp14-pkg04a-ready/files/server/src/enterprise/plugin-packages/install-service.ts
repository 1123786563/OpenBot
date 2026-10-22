import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  type PackageBlocker,
  type PackageGrantDTO,
  type PackageInstallDetailDTO,
  PackageInstallDetailDTOSchema,
  type PackageInstallDTO,
  PackageInstallDTOSchema,
  type PackageListQuery,
  type PackageManifestV1,
  type PackagePage,
  PackagePageSchema,
  type PackagePlanDTO,
  PackagePlanDTOSchema,
  type PackagePlanInput,
  PackagePlanInputSchema,
  type PackageResourceKind,
} from "../../../../shared/enterprise/plugin-package-contracts";
import {
  enterprisePackageChanges as changeRows,
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
import type { CompanyAdminContext } from "../tenancy/workspace-admin";
import {
  assertPackageWriteTx,
  type PackageApplyResult,
  type PackageClock,
  type PackageInstallFacts,
  type PackageMutationStore,
  type PackageReadStore,
  type PackageService,
  packageError,
} from "./contracts";
import { createPackageGrantService } from "./grants";
import {
  addedToolsOf,
  applyRequestDigest,
  assertReleaseUsable,
  canonicalPlanInput,
  changeDiff,
  PLAN_TTL_MS,
  planInputDigest,
  previewBlockers,
  previewResources,
  requiredConnectorIds,
  toPlanDTO,
  validateConnectorMappings,
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
): PackageInstallDTO["readiness"] {
  if (facts.status !== "enabled") return "unavailable";
  if (!release?.verified) return "unavailable";
  if (requiredConnectorBlockers(release, facts).length > 0) {
    return "needs_connection";
  }
  return facts.grants.length > 0 ? "ready" : "needs_grant";
}

function installDTO(
  facts: PackageInstallFacts,
  release: PackageReleaseFacts | null,
): PackageInstallDTO {
  const readiness = readinessOf(facts, release);
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
    // PKG02 installs; grant/disable/uninstall arrive with their own tickets.
    allowedActions: [],
  };
}

function detailResources(
  facts: PackageInstallFacts,
  release: PackageReleaseFacts | null,
): Array<{ id: string; kind: PackageResourceKind; available: boolean }> {
  const linked = new Set(facts.links.map((link) => link.resourceId));
  const manifest = release?.manifest;
  if (manifest) {
    return manifest.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      available:
        resource.kind === "managedConnector"
          ? linked.has(resource.id)
          : release?.verified === true,
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

export function createPackageService(
  input: CreatePackageServiceInput,
): PackageService {
  const { catalogue, readStore, mutation } = input;
  const now: PackageClock = input.now ?? (() => new Date());

  const requireMutation = (): PackageMutationStore => {
    if (!mutation) throw packageError("ADMIN_CHANNEL_UNAVAILABLE");
    return mutation;
  };

  return {
    // PKG03A grant service: setBotGrant/revokeBotGrant on the same trusted
    // operator channel (mutations revalidate admin/membership per transaction).
    ...createPackageGrantService({ mutation, now }),

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
          return { ...item, install: installDTO(facts, release) };
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
      return PackageInstallDetailDTOSchema.parse({
        ...installDTO(facts, release),
        resources: detailResources(facts, release),
        // PKG03A: the install's active Bot grants (revoked grants are never
        // surfaced; "安装≠授权" — the grant list IS the authorization state).
        grants: grantDTOs(facts),
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
      // PKG02 owns install only; other operations parse but are unsupported.
      if (wellFormed.operation !== "install") {
        throw packageError("PACKAGE_UNSUPPORTED");
      }
      // expectedRevision CAS for an existing install belongs to PKG06.
      if (wellFormed.expectedRevision !== null) {
        throw packageError("REVISION_CONFLICT");
      }
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
      const preview = {
        resources: previewResources(manifest),
        addedTools: addedToolsOf(manifest),
        removedTools: [] as string[],
        blockers: previewBlockers(manifest, mappings),
        expiresAt: expiresAt.toISOString(),
      };

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
        await tx.db.insert(planRows).values({
          tenantId: scope.tenantId,
          id: planId,
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          principalId: scope.principalId,
          operation: wellFormed.operation,
          packageKey: release.packageKey,
          version: release.version,
          artifactDigest: release.artifactDigest,
          expectedRevision: null,
          canonicalInput,
          inputDigest,
          preview,
          expiresAt,
        });
      });

      return PackagePlanDTOSchema.parse(
        toPlanDTO({
          planId,
          operation: wellFormed.operation,
          release,
          expectedRevision: null,
          expiresAt,
          resources: preview.resources,
          addedTools: preview.addedTools,
          blockers: preview.blockers,
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
      if (plan.operation !== "install") {
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
            .select({ id: installRows.id })
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
          if (lockedPlan.operation !== "install") {
            throw packageError("PACKAGE_UNSUPPORTED");
          }
          // Every decision below reads the LOCKED row, never the pre-lock
          // `plan`. Recomputing the input digest from the locked canonical
          // input is what detects a row rewritten between `readPlan` and this
          // transaction: comparing `lockedPlan.inputDigest` with
          // `plan.inputDigest` was the same row read twice and could not fail.
          const recomputedInputDigest = planInputDigest(
            lockedPlan.canonicalInput,
          );
          if (
            lockedPlan.id !== plan.planId ||
            lockedPlan.operation !== plan.operation ||
            lockedPlan.packageKey !== plan.packageKey ||
            lockedPlan.version !== plan.version ||
            lockedPlan.expectedRevision !== null ||
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
              action: "install",
              diff: changeDiff({
                operation: "install",
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
          };
          const result = installDTO(facts, release);
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
  };
}
