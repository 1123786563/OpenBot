import { createHash } from "node:crypto";
import type {
  PackageBlocker,
  PackageInstallDTO,
  PackageManifestV1,
  PackagePlanDTO,
  PackagePlanInput,
  PackagePlanVersionDiff,
  PackageResourceKind,
  PackageToolGrant,
} from "../../../../shared/enterprise/plugin-package-contracts";
import type { PackageReleaseFacts } from "../../plugin-packages/catalogue";
import { packageError } from "./contracts";

/**
 * PKG02 plan projection: preview, canonical input, digests.
 *
 * Plan construction is pure: it reads the already-verified in-memory release
 * facts and computes what the admin is about to install. Nothing here touches
 * the network, a connector vendor, a token or the filesystem; the artifact was
 * verified when the catalogue was assembled.
 */

/** Deterministic JSON: object keys sorted by UTF-8 bytes, recursively. */
export function canonicalJson(value: unknown): string {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }
    return node;
  };
  return JSON.stringify(normalize(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Refuse an exact release that cannot be installed: unknown artifacts,
 * withdrawn (unlisted) packages and manifests that disagree with the index all
 * answer the same closed `PACKAGE_UNSUPPORTED`; an unknown package/version is
 * the caller's `RESOURCE_NOT_FOUND`.
 */
export type UsablePackageRelease = PackageReleaseFacts & {
  readonly manifest: PackageManifestV1;
};

export function assertReleaseUsable(
  release: PackageReleaseFacts | null,
): UsablePackageRelease {
  if (!release) throw packageError("RESOURCE_NOT_FOUND");
  if (!release.listed) throw packageError("PACKAGE_UNSUPPORTED");
  if (!release.verified || !release.manifest) {
    throw packageError("PACKAGE_UNSUPPORTED");
  }
  if (
    release.blockers.some(
      (blocker) =>
        blocker.code === "ARTIFACT_MISSING" ||
        blocker.code === "ARTIFACT_INVALID" ||
        blocker.code === "PACKAGE_UNSUPPORTED",
    )
  ) {
    throw packageError("PACKAGE_UNSUPPORTED");
  }
  return release as UsablePackageRelease;
}

export interface ValidatedConnectorMapping {
  readonly resourceId: string;
  readonly connectorInstallId: string;
}

/**
 * Connector mappings must name a managed-connector resource of this exact
 * release. A mapping for a skill/expert resource is a caller error, not a
 * silently ignored field.
 */
export function validateConnectorMappings(
  manifest: PackageManifestV1,
  input: PackagePlanInput,
): ValidatedConnectorMapping[] {
  const connectors = new Map(
    manifest.resources
      .filter((resource) => resource.kind === "managedConnector")
      .map((resource) => [resource.id, resource]),
  );
  const mappings: ValidatedConnectorMapping[] = [];
  for (const [resourceId, connectorInstallId] of Object.entries(
    input.connectorInstalls,
  )) {
    if (!connectors.has(resourceId)) throw packageError("INPUT_INVALID");
    mappings.push({ resourceId, connectorInstallId });
  }
  return mappings.sort((left, right) =>
    left.resourceId < right.resourceId ? -1 : 1,
  );
}

function toolRef(resourceId: string, toolName: string): string {
  return `${resourceId}:${toolName}`;
}

/** Declared connector tools, in stable order, with a stable schema digest. */
export function addedToolsOf(manifest: PackageManifestV1): PackageToolGrant[] {
  const tools: PackageToolGrant[] = [];
  for (const resource of manifest.resources) {
    if (resource.kind !== "managedConnector") continue;
    for (const tool of resource.tools) {
      const ref = toolRef(resource.id, tool.name);
      tools.push({
        ref,
        effect: tool.effect,
        schemaDigest: sha256Hex(
          canonicalJson({
            catalogKey: resource.catalogKey,
            effect: tool.effect,
            name: tool.name,
            resourceId: resource.id,
          }),
        ),
      });
    }
  }
  return tools.sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
  );
}

export function requiredConnectorIds(manifest: PackageManifestV1): string[] {
  return manifest.resources
    .filter(
      (resource) =>
        resource.kind === "managedConnector" && resource.required === true,
    )
    .map((resource) => resource.id)
    .sort();
}

/**
 * Preview blockers: a required connector with no mapping blocks readiness but
 * not the plan (the admin may install first and connect later). A grant is
 * informational only — never a plan blocker.
 */
export function previewBlockers(
  manifest: PackageManifestV1,
  mappings: readonly ValidatedConnectorMapping[],
): PackageBlocker[] {
  const mapped = new Set(mappings.map((mapping) => mapping.resourceId));
  return requiredConnectorIds(manifest)
    .filter((resourceId) => !mapped.has(resourceId))
    .map((resourceId) => ({ code: "NEEDS_CONNECTION" as const, resourceId }));
}

export function previewResources(
  manifest: PackageManifestV1,
): Array<{ id: string; kind: PackageResourceKind }> {
  return manifest.resources.map((resource) => ({
    id: resource.id,
    kind: resource.kind,
  }));
}

/** Canonical plan input: one spelling per request, independent of key order. */
export function canonicalPlanInput(
  input: PackagePlanInput,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(input.config).sort()) {
    config[key] = input.config[key];
  }
  const connectorInstalls: Record<string, string> = {};
  for (const key of Object.keys(input.connectorInstalls).sort()) {
    connectorInstalls[key] = input.connectorInstalls[key];
  }
  return {
    connectorInstalls,
    config,
    expectedRevision: input.expectedRevision,
    operation: input.operation,
    packageKey: input.packageKey,
    version: input.version,
  };
}

export function planInputDigest(canonicalInput: unknown): string {
  return sha256Hex(
    `openbot:plugin-package-plan:v1\0${canonicalJson(canonicalInput)}`,
  );
}

/**
 * Apply request digest: the plan identity plus its canonical input digest.
 * The same key with the same digest is a replay; the same key with any other
 * digest is `IDEMPOTENCY_CONFLICT`.
 */
export function applyRequestDigest(plan: {
  readonly planId: string;
  readonly inputDigest: string;
}): string {
  return sha256Hex(
    `openbot:plugin-package-apply:v1\0${plan.planId}\0${plan.inputDigest}`,
  );
}

export const PLAN_TTL_MS = 10 * 60 * 1000;

/**
 * PKG07 (#466): the closed lifecycle verb vocabulary. These are NOT plan
 * operations — a lifecycle change needs no preview plan, no release resolve and
 * no revision row; it moves the install ROW's status/generation and appends one
 * receipt. `disable`/`uninstall` revoke the install's active grants;
 * `enable` (from `disabled` or an `uninstalled` tombstone) never revives them.
 */
export type PackageLifecycleAction = "disable" | "enable" | "uninstall";

/** The lifecycle verb a target status means for the mutation and its receipt. */
export function lifecycleActionOf(
  status: PackageInstallDTO["status"],
): PackageLifecycleAction {
  switch (status) {
    case "enabled":
      return "enable";
    case "disabled":
      return "disable";
    default:
      return "uninstall";
  }
}

/**
 * Status-request digest for the changes-ledger idempotency receipt: the exact
 * install identity, the target status and the CAS revision the caller read.
 */
export function lifecycleRequestDigest(input: {
  readonly installId: string;
  readonly status: PackageInstallDTO["status"];
  readonly expectedRevision: number;
}): string {
  return sha256Hex(
    `openbot:plugin-package-lifecycle:v1\0${canonicalJson({
      expectedRevision: input.expectedRevision,
      installId: input.installId,
      status: input.status,
    })}`,
  );
}

export function toPlanDTO(input: {
  planId: string;
  operation: PackagePlanDTO["operation"];
  release: PackageReleaseFacts & { manifest: PackageManifestV1 };
  expectedRevision: number | null;
  expiresAt: Date;
  resources: PackagePlanDTO["resources"];
  addedTools: PackagePlanDTO["addedTools"];
  removedTools: PackagePlanDTO["removedTools"];
  blockers: PackagePlanDTO["blockers"];
  /** PKG06: present on upgrade/rollback plans; omitted on install plans. */
  diff?: PackagePlanVersionDiff;
}): PackagePlanDTO {
  return {
    planId: input.planId,
    operation: input.operation,
    packageKey: input.release.packageKey,
    version: input.release.version,
    artifactDigest: input.release.artifactDigest,
    expectedRevision: input.expectedRevision,
    expiresAt: input.expiresAt.toISOString(),
    resources: input.resources,
    addedTools: input.addedTools,
    removedTools: input.removedTools,
    blockers: input.blockers,
    ...(input.diff === undefined ? {} : { diff: input.diff }),
  };
}

/**
 * PKG06 (#465): the current→target version diff an upgrade/rollback plan
 * previews. `current` is the install's live revision facts as the plan read
 * them inside the plan transaction (version, revision, config, linked
 * resources); `currentManifest` is null when the current release no longer
 * resolves in the catalogue — then the resource/tool diff degrades to the
 * facts that still exist (links; all target tools count as the increment)
 * rather than guessing, and the config diff stays exact (the revision row
 * keeps the config).
 *
 * The comparison is per resource id and per tool ref, never per position:
 * a renamed resource is an add+remove, a same-ref tool with a new schema
 * digest or effect is a change, and a config key that merely moved in the
 * canonical spelling is no change at all.
 */
export function versionDiff(input: {
  readonly target: PackageManifestV1;
  /** The plan's full non-secret target config (one spelling, sorted keys). */
  readonly targetConfig: Record<string, unknown>;
  readonly currentVersion: string;
  readonly currentRevision: number;
  readonly currentConfig: Record<string, unknown>;
  readonly currentResources: readonly {
    resourceId: string;
    kind: PackageResourceKind;
  }[];
  readonly currentManifest: PackageManifestV1 | null;
}): PackagePlanVersionDiff & {
  /** The permission increment: new tools plus contract-changed tools. */
  readonly addedTools: PackageToolGrant[];
  /** Current-revision tool refs the target no longer declares. */
  readonly removedTools: string[];
} {
  const targetTools = addedToolsOf(input.target);
  const currentTools = input.currentManifest
    ? addedToolsOf(input.currentManifest)
    : [];
  const currentToolByRef = new Map(
    currentTools.map((tool) => [tool.ref, tool]),
  );

  const addedTools: PackageToolGrant[] = [];
  const changedTools: PackagePlanVersionDiff["changedTools"] = [];
  const removedToolRefs: string[] = [];
  for (const tool of targetTools) {
    const previous = currentToolByRef.get(tool.ref);
    if (!previous) {
      addedTools.push(tool);
      continue;
    }
    if (
      previous.schemaDigest !== tool.schemaDigest ||
      previous.effect !== tool.effect
    ) {
      // A same-ref tool whose contract moved is part of the increment (it
      // needs a fresh grant) AND carries the before/after for the preview.
      addedTools.push(tool);
      changedTools.push({
        ref: tool.ref,
        previousEffect: previous.effect,
        effect: tool.effect,
        previousSchemaDigest: previous.schemaDigest,
        schemaDigest: tool.schemaDigest,
      });
    }
  }
  const targetRefs = new Set(targetTools.map((tool) => tool.ref));
  for (const tool of currentTools) {
    if (!targetRefs.has(tool.ref)) removedToolRefs.push(tool.ref);
  }
  removedToolRefs.sort();

  const targetResourceIds = new Set(input.target.resources.map((r) => r.id));
  const currentResourceById = new Map(
    input.currentResources.map((resource) => [resource.resourceId, resource]),
  );
  const addedResources: PackagePlanVersionDiff["addedResources"] = [];
  for (const resource of input.target.resources) {
    if (!currentResourceById.has(resource.id)) {
      addedResources.push({ id: resource.id, kind: resource.kind });
    }
  }
  const removedResources: PackagePlanVersionDiff["removedResources"] = [];
  for (const [resourceId, resource] of currentResourceById) {
    if (!targetResourceIds.has(resourceId)) {
      removedResources.push({ id: resourceId, kind: resource.kind });
    }
  }

  // Config: the plan always carries the FULL target config (no migration
  // scripts in V1); the diff only narrates what changed against the current
  // revision's stored config, key by key.
  const configChanges: PackagePlanVersionDiff["configChanges"] = [];
  const targetConfigKeys = new Set(Object.keys(input.targetConfig));
  for (const key of Object.keys(input.currentConfig)) {
    if (!targetConfigKeys.has(key)) {
      configChanges.push({ key, change: "removed" });
    } else if (
      canonicalJson(input.currentConfig[key]) !==
      canonicalJson(input.targetConfig[key])
    ) {
      configChanges.push({ key, change: "changed" });
    }
  }
  for (const key of targetConfigKeys) {
    if (!Object.hasOwn(input.currentConfig, key)) {
      configChanges.push({ key, change: "added" });
    }
  }
  configChanges.sort((left, right) => (left.key < right.key ? -1 : 1));

  // Connection requirements: a resource required by the target that the
  // current revision did not require (new connector resource or a flip to
  // required), and the reverse.
  const targetRequired = new Set(requiredConnectorIds(input.target));
  const currentRequired = new Set(
    input.currentManifest ? requiredConnectorIds(input.currentManifest) : [],
  );
  const connectionChanges: PackagePlanVersionDiff["connectionChanges"] = [];
  for (const resourceId of targetRequired) {
    if (!currentRequired.has(resourceId)) {
      connectionChanges.push({ resourceId, change: "added" });
    }
  }
  for (const resourceId of currentRequired) {
    if (!targetRequired.has(resourceId)) {
      connectionChanges.push({ resourceId, change: "removed" });
    }
  }
  connectionChanges.sort((left, right) =>
    left.resourceId < right.resourceId ? -1 : 1,
  );

  return {
    currentVersion: input.currentVersion,
    currentRevision: input.currentRevision,
    addedResources,
    removedResources,
    changedTools,
    configChanges,
    connectionChanges,
    addedTools,
    removedTools: removedToolRefs,
  };
}

/** Redacted change diff: metadata and non-secret config only. */
export function changeDiff(input: {
  operation: PackagePlanDTO["operation"];
  packageKey: string;
  version: string;
  artifactDigest: string;
  revision: number;
  config: Record<string, unknown>;
  /**
   * PKG06: the install's version/revision BEFORE an upgrade/rollback moved
   * it (absent on install receipts — there was nothing before).
   */
  previousVersion?: string;
  previousRevision?: number;
}): Record<string, unknown> {
  return {
    action: input.operation,
    artifactDigest: input.artifactDigest,
    config: input.config,
    packageKey: input.packageKey,
    revision: input.revision,
    version: input.version,
    ...(input.previousVersion === undefined
      ? {}
      : { previousVersion: input.previousVersion }),
    ...(input.previousRevision === undefined
      ? {}
      : { previousRevision: input.previousRevision }),
  };
}

/**
 * PKG07 (#466): redacted lifecycle receipt. Counters and states only — the
 * revoked grant ids stay in their own append-friendly rows, and no config,
 * envelope or secret has a path here (the DB's secret-carrier CHECK agrees).
 */
export function lifecycleChangeDiff(input: {
  action: PackageLifecycleAction;
  packageKey: string;
  version: string;
  revision: number;
  previousStatus: PackageInstallDTO["status"];
  status: PackageInstallDTO["status"];
  previousGeneration: number;
  generation: number;
  /** Active grant rows this transition revoked (disable/uninstall only). */
  revokedGrants: number;
}): Record<string, unknown> {
  return {
    action: input.action,
    generation: input.generation,
    packageKey: input.packageKey,
    previousGeneration: input.previousGeneration,
    previousStatus: input.previousStatus,
    revokedGrants: input.revokedGrants,
    revision: input.revision,
    status: input.status,
    version: input.version,
  };
}
