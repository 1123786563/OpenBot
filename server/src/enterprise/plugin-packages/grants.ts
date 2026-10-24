import { and, eq, isNull, sql } from "drizzle-orm";
import type { PackageManifestV1 } from "../../../../shared/enterprise/plugin-package-contracts";
import {
  type PackageGrantDTO,
  type PackageGrantInput,
  PackageGrantInputSchema,
  type PackageGrantResource,
  type PackageGrantRevokeInput,
} from "../../../../shared/enterprise/plugin-package-contracts";
import { enterpriseBotOwnership as botOwnershipRows } from "../../db/schema/enterprise-bot-ownership";
import {
  enterprisePackageChanges as changeRows,
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageResourceLinks as linkRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import { loadArtifact } from "../../plugin-packages/artifact";
import type { PlatformScope } from "../contracts";
import { PERSONAL_BOT_ID_PREFIX } from "../tenancy/personal-bot";
import type { CompanyAdminContext } from "../tenancy/workspace-admin";
import {
  assertPackageWriteTx,
  type PackageGrantMutationResult,
  type PackageMutationStore,
  type PackageWriteTx,
  packageError,
} from "./contracts";
import { addedToolsOf, canonicalJson, sha256Hex } from "./plans";

/**
 * PKG03A package Bot grants (slice A: skill resources) + PKG05 (#464)
 * connector-tool grants: `kind: "managedConnector"` with explicit `toolRefs`.
 * The tool contract (schema digest and effect) is re-derived from the install's
 * CURRENT revision manifest — never accepted from the request — and stored on
 * the row so dispatch can prove what was granted (A06 capability changes).
 *
 * The grant model, per Spec §6/§9 and the task brief:
 *
 *   - A grant is scope-scoped and Bot-scoped: it proves the install's skill
 *     resources may be exercised by ONE Bot of the same tenant AND team.
 *     Installing never grants anything ("安装≠授权").
 *   - Grant rows are recorded per grant cycle (`generation`). Every set or
 *     revoke supersedes: the previous active rows are marked `revoked_at` and
 *     the new state is written at `max(generation) + 1`. The grant revision —
 *     the CAS counter surfaced in DTOs — is the count of distinct generations
 *     for (install, bot), so revocation bumps it and a revoked approval can
 *     never come back (nothing ever clears `revoked_at`).
 *   - Every write revalidates, inside the same operator transaction: trusted
 *     admin context (the mutation store already re-validated membership and
 *     epoch), install present in scope and enabled (set only), Bot ownership
 *     active and registered to the same workspace, every skill resource id a
 *     skill of the install's CURRENT revision, and every connector tool a
 *     declared tool of that revision's managed-connector link. An
 *     expertTemplate or an unknown kind is refused with
 *     `RESOURCE_KIND_UNSUPPORTED`; a connector tool the manifest does not
 *     declare is `RESOURCE_NOT_FOUND`.
 *   - Idempotency mirrors apply exactly: the `Idempotency-Key` addresses a
 *     receipt row in `enterprise_package_changes` (unique per tenant,
 *     workspace, actor); same key + same request digest replays the stored
 *     result, same key + any other digest is `IDEMPOTENCY_CONFLICT`.
 *   - Change receipts carry a redacted diff (ids and revision counters only —
 *     no config, no secrets by construction).
 *
 * Nothing here talks to a vendor, a transport or the filesystem.
 */

/** Locked order (Spec §8): install → grant(bot). Member locks precede. */
function grantLockKeys(
  scope: PlatformScope,
  installId: string,
  botId: string,
): string[] {
  return [
    JSON.stringify([
      "enterprise",
      "package-install",
      scope.tenantId,
      installId,
    ]),
    JSON.stringify([
      "enterprise",
      "package-grant",
      scope.tenantId,
      installId,
      botId,
    ]),
  ];
}

function grantRequestDigest(input: {
  action: "grant" | "revoke";
  installId: string;
  botId: string;
  expectedGrantRevision: number | null;
  resources: readonly PackageGrantResource[];
}): string {
  return sha256Hex(
    `openbot:plugin-package-grant:v1\0${canonicalJson({
      action: input.action,
      botId: input.botId,
      expectedGrantRevision: input.expectedGrantRevision,
      installId: input.installId,
      resources: input.resources,
    })}`,
  );
}

/** SQLSTATE 23505 probe, identical to the apply path's helper. */
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

interface InstallInScope {
  readonly id: string;
  readonly workspaceId: string;
  readonly packageKey: string;
  readonly status: string;
  readonly revision: number;
}

async function readInstallInScope(
  tx: PackageWriteTx,
  scope: PlatformScope,
  installId: string,
): Promise<InstallInScope> {
  const [install] = await tx.db
    .select({
      id: installRows.id,
      workspaceId: installRows.workspaceId,
      packageKey: installRows.packageKey,
      status: installRows.status,
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
  // Operator RLS pins the tenant; the workspace predicate is the second,
  // independent line — another team's install is "not found", same shape.
  if (!install || install.workspaceId !== scope.workspaceId) {
    throw packageError("RESOURCE_NOT_FOUND");
  }
  return install;
}

/**
 * Bot binding authority read (mirrors tenancy bots-ownership visibility
 * predicates): an expert Bot with trusted business ownership — an active
 * `enterprise_bot_ownership` row registered to the scope's workspace — is
 * bindable. A logically-private Bot (`pbot-` namespace, ADR 0006) is refused
 * with `PACKAGE_BOT_SCOPE_UNAVAILABLE`: its actual execution-scope resolution
 * is not wired in this version, so binding must never copy the identity or
 * fall back to a default environment — even if a drifted ownership row exists.
 * Unknown and cross-company/cross-team bots answer the same 404.
 */
async function readBotInScope(
  tx: PackageWriteTx,
  scope: PlatformScope,
  botId: string,
): Promise<void> {
  if (botId.startsWith(PERSONAL_BOT_ID_PREFIX)) {
    throw packageError("PACKAGE_BOT_SCOPE_UNAVAILABLE");
  }
  const [bot] = await tx.db
    .select({
      workspaceId: botOwnershipRows.workspaceId,
      status: botOwnershipRows.status,
    })
    .from(botOwnershipRows)
    .where(
      and(
        eq(botOwnershipRows.tenantId, scope.tenantId),
        eq(botOwnershipRows.agentId, botId),
      ),
    )
    .limit(1);
  if (bot?.status !== "active" || bot.workspaceId !== scope.workspaceId) {
    throw packageError("RESOURCE_NOT_FOUND");
  }
}

async function readGrantGenerations(
  tx: PackageWriteTx,
  scope: PlatformScope,
  installId: string,
  botId: string,
): Promise<Set<number>> {
  const rows = await tx.db
    .select({ generation: grantRows.generation })
    .from(grantRows)
    .where(
      and(
        eq(grantRows.tenantId, scope.tenantId),
        eq(grantRows.installId, installId),
        eq(grantRows.botId, botId),
      ),
    );
  return new Set(rows.map((row) => row.generation));
}

/** The active grant rows of one (install, bot), with their contract columns. */
interface ActiveGrantRow {
  readonly resourceId: string;
  readonly resourceKind: string;
  readonly toolRef: string;
  readonly schemaDigest: string | null;
  readonly effect: string | null;
  readonly connectorInstallId: string | null;
}

async function readActiveGrantRows(
  tx: PackageWriteTx,
  scope: PlatformScope,
  installId: string,
  botId: string,
): Promise<ActiveGrantRow[]> {
  return tx.db
    .select({
      resourceId: grantRows.resourceId,
      resourceKind: grantRows.resourceKind,
      toolRef: grantRows.toolRef,
      schemaDigest: grantRows.schemaDigest,
      effect: grantRows.effect,
      connectorInstallId: grantRows.connectorInstallId,
    })
    .from(grantRows)
    .where(
      and(
        eq(grantRows.tenantId, scope.tenantId),
        eq(grantRows.installId, installId),
        eq(grantRows.botId, botId),
        isNull(grantRows.revokedAt),
      ),
    );
}

/**
 * The revocation generation: one born-revoked row per revoked row, with its
 * kind and tool contract preserved (a connector-tool row must carry its
 * digest/effect/connector install — the table's CHECK says so, and the
 * evidence must say WHAT was revoked, not merely that a resource name was).
 */
async function insertRevokedGrantRows(input: {
  tx: PackageWriteTx;
  scope: PlatformScope;
  install: InstallRevisionRef;
  botId: string;
  generation: number;
  rows: readonly ActiveGrantRow[];
  grantedBy: string;
  revivedAt: Date;
  revokedAt: Date;
}): Promise<void> {
  if (input.rows.length === 0) return;
  await input.tx.db.insert(grantRows).values(
    input.rows.map((row) => ({
      tenantId: input.scope.tenantId,
      installId: input.install.id,
      generation: input.generation,
      botId: input.botId,
      resourceId: row.resourceId,
      workspaceId: input.scope.workspaceId,
      resourceKind: row.resourceKind,
      toolRef: row.toolRef,
      schemaDigest: row.schemaDigest,
      effect: row.effect,
      connectorInstallId: row.connectorInstallId,
      grantedBy: input.grantedBy,
      grantedAt: input.revivedAt,
      revokedAt: input.revokedAt,
    })),
  );
}

/**
 * Shared idempotency receipt read for the package changes ledger: the row a
 * previous mutation of THIS actor stored for the key, or null. Also consumed
 * by the PKG04A expert instantiation (same ledger, same semantics).
 */
export async function readIdempotencyReceipt(
  tx: PackageWriteTx,
  scope: PlatformScope,
  idempotencyKey: string,
): Promise<{ requestDigest: string; response: unknown } | null> {
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
  return receipt ?? null;
}

/** Install facts the grant writes actually read; `InstallInScope` satisfies it. */
interface InstallRevisionRef {
  readonly id: string;
  readonly revision: number;
}

/**
 * Skill resources of the install's CURRENT revision (the resource links are
 * the per-revision authority; the global slug table is never consulted).
 */
async function readCurrentSkillIds(
  tx: PackageWriteTx,
  scope: PlatformScope,
  install: InstallRevisionRef,
): Promise<Set<string>> {
  const rows = await tx.db
    .select({ resourceId: linkRows.resourceId })
    .from(linkRows)
    .where(
      and(
        eq(linkRows.tenantId, scope.tenantId),
        eq(linkRows.installId, install.id),
        eq(linkRows.revision, install.revision),
        eq(linkRows.kind, "skill"),
      ),
    );
  return new Set(rows.map((row) => row.resourceId));
}

/** Roll grant rows up into the DTO's per-resource shape (tools per resource). */
function groupGrantResources(
  rows: readonly ActiveGrantRow[],
): PackageGrantResource[] {
  const skills: string[] = [];
  const tools = new Map<string, string[]>();
  for (const row of rows) {
    if (row.resourceKind === "connectorTool") {
      const list = tools.get(row.resourceId) ?? [];
      list.push(row.toolRef);
      tools.set(row.resourceId, list);
      continue;
    }
    skills.push(row.resourceId);
  }
  return [
    ...[...new Set(skills)]
      .sort()
      .map(
        (resourceId): PackageGrantResource => ({ resourceId, kind: "skill" }),
      ),
    ...[...tools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(
        ([resourceId, toolRefs]): PackageGrantResource => ({
          resourceId,
          kind: "managedConnector",
          toolRefs: toolRefs.sort(),
        }),
      ),
  ];
}

/**
 * The template seam (PKG04A) grants skills only; connector tools are never
 * granted implicitly. Kept as a named helper so the seam reads the way it
 * did before PKG05.
 */
function assertSkillResources(
  resources: readonly PackageGrantResource[],
  skillIds: Set<string>,
): void {
  const seen = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== "skill") {
      throw packageError("RESOURCE_KIND_UNSUPPORTED");
    }
    if (seen.has(resource.resourceId)) throw packageError("INPUT_INVALID");
    seen.add(resource.resourceId);
    if (!skillIds.has(resource.resourceId)) {
      throw packageError("RESOURCE_NOT_FOUND");
    }
  }
}

/** One connector tool row to write: the manifest decides digest and effect. */
interface ConnectorToolGrant {
  readonly resourceId: string;
  readonly toolRef: string;
  readonly schemaDigest: string;
  readonly effect: "read" | "write";
  readonly connectorInstallId: string;
}

/** The install's CURRENT-revision managed-connector links. */
async function readCurrentConnectorLinks(
  tx: PackageWriteTx,
  scope: PlatformScope,
  install: InstallRevisionRef,
): Promise<Map<string, string>> {
  const rows = await tx.db
    .select({
      resourceId: linkRows.resourceId,
      connectorInstallId: linkRows.connectorInstallId,
    })
    .from(linkRows)
    .where(
      and(
        eq(linkRows.tenantId, scope.tenantId),
        eq(linkRows.installId, install.id),
        eq(linkRows.revision, install.revision),
        eq(linkRows.kind, "managedConnector"),
      ),
    );
  const links = new Map<string, string>();
  for (const row of rows) {
    if (row.connectorInstallId) {
      links.set(row.resourceId, row.connectorInstallId);
    }
  }
  return links;
}

/** The install's CURRENT-revision artifact digest (manifest source). */
async function readRevisionDigest(
  tx: PackageWriteTx,
  scope: PlatformScope,
  install: InstallRevisionRef,
): Promise<string | null> {
  const [row] = await tx.db
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
  return row?.artifactDigest ?? null;
}

/**
 * Validates the requested resources and returns the connector tool rows.
 *
 * A skill resource names a skill of the current revision and declares no
 * tools. A managed-connector resource MUST declare at least one tool, each
 * `<resourceId>:<toolName>` declared by the current revision's manifest for
 * that resource; the digest and effect are the manifest's, never the
 * request's. Anything else is refused rather than silently narrowed.
 */
function validateGrantResources(input: {
  resources: readonly PackageGrantResource[];
  skillIds: Set<string>;
  connectorLinks: Map<string, string>;
  declaredTools: readonly {
    ref: string;
    effect: "read" | "write";
    schemaDigest: string;
  }[];
}): ConnectorToolGrant[] {
  const declaredByRef = new Map(
    input.declaredTools.map((tool) => [tool.ref, tool]),
  );
  const seen = new Set<string>();
  const tools: ConnectorToolGrant[] = [];
  for (const resource of input.resources) {
    if (resource.kind === "skill") {
      if (resource.toolRefs !== undefined) throw packageError("INPUT_INVALID");
      const key = `skill\u0000${resource.resourceId}`;
      if (seen.has(key)) throw packageError("INPUT_INVALID");
      seen.add(key);
      if (!input.skillIds.has(resource.resourceId)) {
        throw packageError("RESOURCE_NOT_FOUND");
      }
      continue;
    }
    if (resource.kind !== "managedConnector") {
      throw packageError("RESOURCE_KIND_UNSUPPORTED");
    }
    const toolRefs = resource.toolRefs;
    if (!toolRefs || toolRefs.length === 0) throw packageError("INPUT_INVALID");
    const connectorInstallId = input.connectorLinks.get(resource.resourceId);
    if (!connectorInstallId) throw packageError("RESOURCE_NOT_FOUND");
    for (const ref of toolRefs) {
      const declared = declaredByRef.get(ref);
      if (!declared || !ref.startsWith(`${resource.resourceId}:`)) {
        throw packageError("RESOURCE_NOT_FOUND");
      }
      const key = `tool\u0000${ref}`;
      if (seen.has(key)) throw packageError("INPUT_INVALID");
      seen.add(key);
      tools.push({
        resourceId: resource.resourceId,
        toolRef: ref,
        schemaDigest: declared.schemaDigest,
        effect: declared.effect,
        connectorInstallId,
      });
    }
  }
  return tools;
}

async function insertGrantRows(input: {
  tx: PackageWriteTx;
  scope: PlatformScope;
  install: InstallRevisionRef;
  botId: string;
  generation: number;
  resources: readonly PackageGrantResource[];
  connectorTools: readonly ConnectorToolGrant[];
  grantedBy: string;
  grantedAt: Date;
  revokedAt: Date | null;
}): Promise<void> {
  const { tx, scope, install, botId, generation } = input;
  const skillRows = input.resources
    .filter((resource) => resource.kind === "skill")
    .map((resource) => ({
      tenantId: scope.tenantId,
      installId: install.id,
      generation,
      botId,
      resourceId: resource.resourceId,
      workspaceId: scope.workspaceId,
      resourceKind: "skill",
      toolRef: "",
      schemaDigest: null,
      effect: null,
      connectorInstallId: null,
      grantedBy: input.grantedBy,
      grantedAt: input.grantedAt,
      revokedAt: input.revokedAt,
    }));
  const toolRows = input.connectorTools.map((tool) => ({
    tenantId: scope.tenantId,
    installId: install.id,
    generation,
    botId,
    resourceId: tool.resourceId,
    workspaceId: scope.workspaceId,
    resourceKind: "connectorTool",
    toolRef: tool.toolRef,
    schemaDigest: tool.schemaDigest,
    effect: tool.effect,
    connectorInstallId: tool.connectorInstallId,
    grantedBy: input.grantedBy,
    grantedAt: input.grantedAt,
    revokedAt: input.revokedAt,
  }));
  const rows = [...skillRows, ...toolRows];
  if (rows.length > 0) await tx.db.insert(grantRows).values(rows);
}

async function recordGrantChange(input: {
  tx: PackageWriteTx;
  scope: PlatformScope;
  install: InstallInScope;
  action: "grant" | "revoke";
  botId: string;
  resources: readonly PackageGrantResource[];
  grantRevision: number;
  idempotencyKey: string;
  requestDigest: string;
  result: PackageGrantDTO;
}): Promise<void> {
  const { tx, scope, install } = input;
  await tx.db.insert(changeRows).values({
    tenantId: scope.tenantId,
    changeId: crypto.randomUUID(),
    workspaceId: scope.workspaceId,
    installId: install.id,
    revision: install.revision,
    actorId: scope.actorId,
    action: input.action,
    diff: {
      action: input.action,
      botId: input.botId,
      // Redacted by construction: ids and counters only, never config.
      grantRevision: input.grantRevision,
      packageKey: install.packageKey,
      resources: input.resources.map((resource) => resource.resourceId),
    },
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
    resultJson: input.result,
  });
}

export interface CreatePackageGrantServiceInput {
  /** Null when the restricted operator channel could not be verified. */
  readonly mutation: PackageMutationStore | null;
  /**
   * PKG05: the content-addressed artifact root. Connector-tool grants take
   * their schema digest and effect from the install's CURRENT revision
   * manifest, so a deployment without the root refuses them (fail closed)
   * instead of writing an unverifiable contract. Skill grants never need it.
   */
  readonly artifactRoot?: string | null;
  readonly now?: () => Date;
}

export interface PackageGrantService {
  setBotGrant(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackageGrantInput,
    idempotencyKey: string,
  ): Promise<PackageGrantMutationResult>;
  revokeBotGrant(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackageGrantRevokeInput,
    idempotencyKey: string,
  ): Promise<PackageGrantMutationResult>;
}

export function createPackageGrantService(
  input: CreatePackageGrantServiceInput,
): PackageGrantService {
  const { mutation } = input;
  const artifactRoot = input.artifactRoot ?? null;
  const now = input.now ?? (() => new Date());

  const requireMutation = (): PackageMutationStore => {
    if (!mutation) throw packageError("ADMIN_CHANNEL_UNAVAILABLE");
    return mutation;
  };

  const assertIdempotencyKey = (idempotencyKey: string): void => {
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 128 ||
      !/^[\x20-\x7e]+$/.test(idempotencyKey)
    ) {
      throw packageError("INPUT_INVALID");
    }
  };

  return {
    async setBotGrant(scope, admin, rawInput, idempotencyKey) {
      assertIdempotencyKey(idempotencyKey);
      const parsed = PackageGrantInputSchema.safeParse(rawInput);
      if (!parsed.success) throw packageError("INPUT_INVALID");
      const grantInput = parsed.data;
      const store = requireMutation();
      const requestDigest = grantRequestDigest({
        action: "grant",
        installId: grantInput.installId,
        botId: grantInput.botId,
        expectedGrantRevision: grantInput.expectedGrantRevision,
        resources: grantInput.resources,
      });

      try {
        return await store.transaction(scope, admin, async (tx) => {
          assertPackageWriteTx(tx);
          for (const key of grantLockKeys(
            scope,
            grantInput.installId,
            grantInput.botId,
          )) {
            await tx.db.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
            );
          }
          // The clock is read after every canonical lock, as in apply.
          const grantedAt = now();

          const receipt = await readIdempotencyReceipt(
            tx,
            scope,
            idempotencyKey,
          );
          if (receipt) {
            if (receipt.requestDigest !== requestDigest) {
              throw packageError("IDEMPOTENCY_CONFLICT");
            }
            return {
              grant: receipt.response as PackageGrantDTO,
              created: false,
            };
          }

          const install = await readInstallInScope(
            tx,
            scope,
            grantInput.installId,
          );
          // Only an enabled install grants: uninstalled/disabled installs
          // refuse new grants (their lifecycle revokes instead — see the
          // seam below).
          if (install.status !== "enabled") {
            throw packageError("PACKAGE_UNSUPPORTED");
          }
          await readBotInScope(tx, scope, grantInput.botId);
          /*
           * Validation order: request SHAPE first (a connector grant must
           * name its tools; a skill grant must not), then the install's own
           * links (a resource with no managed-connector link is a not-found
           * regardless of deployment config), and only then the manifest that
           * decides the tool contract. A missing artifact root therefore
           * fails a would-be-valid connector grant closed as
           * PACKAGE_UNSUPPORTED rather than letting it through unverified.
           */
          for (const resource of grantInput.resources) {
            if (
              resource.kind === "managedConnector" &&
              (!resource.toolRefs || resource.toolRefs.length === 0)
            ) {
              throw packageError("INPUT_INVALID");
            }
            if (resource.kind === "skill" && resource.toolRefs !== undefined) {
              throw packageError("INPUT_INVALID");
            }
          }
          const connectorLinks = await readCurrentConnectorLinks(
            tx,
            scope,
            install,
          );
          // A connector resource this install has no link for is not found,
          // independent of the artifact root (no manifest could describe it).
          for (const resource of grantInput.resources) {
            if (
              resource.kind === "managedConnector" &&
              !connectorLinks.has(resource.resourceId)
            ) {
              throw packageError("RESOURCE_NOT_FOUND");
            }
          }
          let declaredTools: ReturnType<typeof addedToolsOf> = [];
          if (
            grantInput.resources.some(
              (resource) => resource.kind === "managedConnector",
            )
          ) {
            if (!artifactRoot) throw packageError("PACKAGE_UNSUPPORTED");
            const digest = await readRevisionDigest(tx, scope, install);
            if (!digest) throw packageError("PACKAGE_UNSUPPORTED");
            let manifest: PackageManifestV1;
            try {
              ({ manifest } = await loadArtifact(artifactRoot, digest));
            } catch {
              throw packageError("PACKAGE_UNSUPPORTED");
            }
            declaredTools = addedToolsOf(manifest);
          }
          const connectorTools = validateGrantResources({
            resources: grantInput.resources,
            skillIds: await readCurrentSkillIds(tx, scope, install),
            connectorLinks,
            declaredTools,
          });

          const generations = await readGrantGenerations(
            tx,
            scope,
            install.id,
            grantInput.botId,
          );
          if (
            grantInput.expectedGrantRevision !== null &&
            grantInput.expectedGrantRevision !== generations.size
          ) {
            throw packageError("REVISION_CONFLICT");
          }

          const nextGeneration = Math.max(0, ...generations) + 1;
          // Supersede: revoke the still-active rows, then write the new set
          // at the next generation. The lock makes the pair atomic.
          await tx.db
            .update(grantRows)
            .set({ revokedAt: grantedAt })
            .where(
              and(
                eq(grantRows.tenantId, scope.tenantId),
                eq(grantRows.installId, install.id),
                eq(grantRows.botId, grantInput.botId),
                isNull(grantRows.revokedAt),
              ),
            );
          await insertGrantRows({
            tx,
            scope,
            install,
            botId: grantInput.botId,
            generation: nextGeneration,
            resources: grantInput.resources,
            connectorTools,
            grantedBy: scope.principalId,
            grantedAt,
            revokedAt: null,
          });

          const grant: PackageGrantDTO = {
            installId: install.id,
            botId: grantInput.botId,
            revision: nextGeneration,
            resources: grantInput.resources,
          };
          await recordGrantChange({
            tx,
            scope,
            install,
            action: "grant",
            botId: grantInput.botId,
            resources: grantInput.resources,
            grantRevision: nextGeneration,
            idempotencyKey,
            requestDigest,
            result: grant,
          });
          return { grant, created: true };
        });
      } catch (error) {
        if (uniqueViolation(error, "enterprise_package_grant_active_uq")) {
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

    async revokeBotGrant(scope, admin, rawInput, idempotencyKey) {
      assertIdempotencyKey(idempotencyKey);
      if (
        !rawInput ||
        typeof rawInput !== "object" ||
        typeof (rawInput as PackageGrantRevokeInput).installId !== "string" ||
        typeof (rawInput as PackageGrantRevokeInput).botId !== "string" ||
        !(
          (rawInput as PackageGrantRevokeInput).expectedGrantRevision ===
            null ||
          typeof (rawInput as PackageGrantRevokeInput).expectedGrantRevision ===
            "number"
        )
      ) {
        throw packageError("INPUT_INVALID");
      }
      const revokeInput = rawInput;
      const store = requireMutation();
      const requestDigest = grantRequestDigest({
        action: "revoke",
        installId: revokeInput.installId,
        botId: revokeInput.botId,
        expectedGrantRevision: revokeInput.expectedGrantRevision,
        resources: [],
      });

      try {
        return await store.transaction(scope, admin, async (tx) => {
          assertPackageWriteTx(tx);
          for (const key of grantLockKeys(
            scope,
            revokeInput.installId,
            revokeInput.botId,
          )) {
            await tx.db.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
            );
          }
          const revokedAt = now();

          const receipt = await readIdempotencyReceipt(
            tx,
            scope,
            idempotencyKey,
          );
          if (receipt) {
            if (receipt.requestDigest !== requestDigest) {
              throw packageError("IDEMPOTENCY_CONFLICT");
            }
            return {
              grant: receipt.response as PackageGrantDTO,
              created: false,
            };
          }

          const install = await readInstallInScope(
            tx,
            scope,
            revokeInput.installId,
          );
          await readBotInScope(tx, scope, revokeInput.botId);

          const generations = await readGrantGenerations(
            tx,
            scope,
            install.id,
            revokeInput.botId,
          );
          if (
            revokeInput.expectedGrantRevision !== null &&
            revokeInput.expectedGrantRevision !== generations.size
          ) {
            throw packageError("REVISION_CONFLICT");
          }

          const activeRows = await readActiveGrantRows(
            tx,
            scope,
            install.id,
            revokeInput.botId,
          );
          const activeResources = groupGrantResources(activeRows);
          if (activeRows.length === 0) {
            // Nothing to revoke. A pair that never held any grant generation
            // has no current grant at all: answering a fabricated revision 1
            // would hand back a CAS counter that is not the real count (0) and
            // poison the caller's next expectedGrantRevision — so it is the
            // same not-found face as any other absent grant. A pair WITH
            // generations is an already-revoked no-op: the current revision
            // stands, no new generation is written (created: false, HTTP 200).
            if (generations.size === 0) {
              throw packageError("RESOURCE_NOT_FOUND");
            }
            const grant: PackageGrantDTO = {
              installId: install.id,
              botId: revokeInput.botId,
              revision: generations.size,
              resources: [],
            };
            await recordGrantChange({
              tx,
              scope,
              install,
              action: "revoke",
              botId: revokeInput.botId,
              resources: [],
              grantRevision: grant.revision,
              idempotencyKey,
              requestDigest,
              result: grant,
            });
            return { grant, created: false };
          }

          const nextGeneration = Math.max(0, ...generations) + 1;
          await tx.db
            .update(grantRows)
            .set({ revokedAt })
            .where(
              and(
                eq(grantRows.tenantId, scope.tenantId),
                eq(grantRows.installId, install.id),
                eq(grantRows.botId, revokeInput.botId),
                isNull(grantRows.revokedAt),
              ),
            );
          // The revocation generation records WHAT was revoked, born revoked:
          // append-only evidence per row (kind and tool contract included),
          // and the distinct-generation count — the grant revision — advances
          // with the revocation.
          await insertRevokedGrantRows({
            tx,
            scope,
            install,
            botId: revokeInput.botId,
            generation: nextGeneration,
            rows: activeRows,
            grantedBy: scope.principalId,
            revivedAt: revokedAt,
            revokedAt,
          });

          const grant: PackageGrantDTO = {
            installId: install.id,
            botId: revokeInput.botId,
            revision: nextGeneration,
            resources: activeResources.map((resource) => resource),
          };
          await recordGrantChange({
            tx,
            scope,
            install,
            action: "revoke",
            botId: revokeInput.botId,
            resources: grant.resources,
            grantRevision: nextGeneration,
            idempotencyKey,
            requestDigest,
            result: grant,
          });
          return { grant, created: true };
        });
      } catch (error) {
        if (uniqueViolation(error, "enterprise_package_grant_active_uq")) {
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

/**
 * PKG04A seam: write the INITIAL Skill grant for a freshly instantiated expert
 * Bot INSIDE the caller's operator transaction, with exactly the set/grant
 * semantics above — same table (`enterprise_package_grants`), same revision
 * bump rules (supersede any active rows, write the new set at
 * `max(generation) + 1`). The skill ids MUST already be validated against the
 * install's current revision (`assertSkillResources` runs here); duplicates are
 * a caller error. A template that references no skills writes no rows and
 * answers the still-positive `grantRevision: 1` (the fresh Bot's first cycle
 * is simply empty).
 *
 * Returns the written generation and the resources actually recorded.
 */
export async function grantTemplateSkillsWithin(
  tx: PackageWriteTx,
  scope: PlatformScope,
  install: { readonly id: string; readonly revision: number },
  botId: string,
  skillIds: readonly string[],
  grantedBy: string,
  grantedAt: Date,
): Promise<{ generation: number; resources: PackageGrantResource[] }> {
  assertPackageWriteTx(tx);
  const seen = new Set<string>();
  const resources: PackageGrantResource[] = [];
  for (const resourceId of skillIds) {
    if (seen.has(resourceId)) throw packageError("INPUT_INVALID");
    seen.add(resourceId);
    resources.push({ resourceId, kind: "skill" });
  }
  if (resources.length === 0) return { generation: 1, resources: [] };
  assertSkillResources(
    resources,
    await readCurrentSkillIds(tx, scope, install),
  );
  const generations = await readGrantGenerations(tx, scope, install.id, botId);
  const nextGeneration = Math.max(0, ...generations) + 1;
  // Supersede first, identical to setBotGrant: for a fresh Bot this is a
  // no-op, but the revision bump rules stay literally the same code path.
  await tx.db
    .update(grantRows)
    .set({ revokedAt: grantedAt })
    .where(
      and(
        eq(grantRows.tenantId, scope.tenantId),
        eq(grantRows.installId, install.id),
        eq(grantRows.botId, botId),
        isNull(grantRows.revokedAt),
      ),
    );
  await insertGrantRows({
    tx,
    scope,
    install,
    botId,
    generation: nextGeneration,
    resources,
    connectorTools: [],
    grantedBy,
    grantedAt,
    revokedAt: null,
  });
  return { generation: nextGeneration, resources };
}

/**
 * PKG03A lifecycle seam: revoke every active grant of one install. PKG06's
 * disable/uninstall transaction calls this right after the install row moves
 * to its new status/generation (Spec §10: disabling/uninstalling bumps the
 * generation and revokes the current grants; re-enabling requires explicit
 * re-granting). It is deliberately NOT wired anywhere yet — slice A has no
 * status-change path. The write handle must come from a
 * `PackageMutationStore.transaction` (the same admin-revalidated operator
 * transaction that performs the status change).
 */
export async function revokeGrantsForInstallLifecycle(
  tx: PackageWriteTx,
  install: { readonly tenantId: string; readonly installId: string },
  revokedAt: Date,
): Promise<void> {
  assertPackageWriteTx(tx);
  await tx.db
    .update(grantRows)
    .set({ revokedAt })
    .where(
      and(
        eq(grantRows.tenantId, install.tenantId),
        eq(grantRows.installId, install.installId),
        isNull(grantRows.revokedAt),
      ),
    );
}
