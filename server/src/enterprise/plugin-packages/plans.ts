import { createHash } from "node:crypto";
import type {
  PackageBlocker,
  PackageManifestV1,
  PackagePlanDTO,
  PackagePlanInput,
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

export function toPlanDTO(input: {
  planId: string;
  operation: PackagePlanDTO["operation"];
  release: PackageReleaseFacts & { manifest: PackageManifestV1 };
  expectedRevision: number | null;
  expiresAt: Date;
  resources: PackagePlanDTO["resources"];
  addedTools: PackagePlanDTO["addedTools"];
  blockers: PackagePlanDTO["blockers"];
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
    removedTools: [],
    blockers: input.blockers,
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
}): Record<string, unknown> {
  return {
    action: input.operation,
    artifactDigest: input.artifactDigest,
    config: input.config,
    packageKey: input.packageKey,
    revision: input.revision,
    version: input.version,
  };
}
