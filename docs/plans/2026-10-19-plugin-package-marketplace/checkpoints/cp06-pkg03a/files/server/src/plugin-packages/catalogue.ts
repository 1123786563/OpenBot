import {
  type MarketplaceV1,
  MarketplaceV1Schema,
  type PackageBlocker,
  type PackageCatalogueDetail,
  PackageCatalogueDetailSchema,
  type PackageListQuery,
  type PackageManifestV1,
  type PackagePage,
  type PackagePageItem,
  PackagePageSchema,
  type PackageResourceSummary,
} from "../../../shared/enterprise/plugin-package-contracts";
import type { PlatformScope } from "../enterprise/contracts";
import { packageError } from "../enterprise/plugin-packages/contracts";
import { ArtifactError, loadArtifact, type VerifiedArtifact } from "./artifact";

/**
 * Deployment-wide package catalogue. Entries are trusted index facts plus
 * verified local artifacts; there are no account, secret, filesystem or
 * other-team install facts in this projection. An artifact that is missing or
 * invalid stays in the catalogue as unavailable — it is never silently
 * dropped and never reported installable.
 */

const PACKAGE_KEY_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURSOR_PREFIX = "pkg1:";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 200;

export interface CatalogueListOptions {
  /** Explicit opt-in: unlisted packages return with the PACKAGE_UNLISTED blocker. */
  includeUnlisted?: boolean;
}

export interface PackageCatalogue {
  list(
    scope: PlatformScope,
    query: PackageListQuery,
    options?: CatalogueListOptions,
  ): Promise<PackagePage>;
  get(
    scope: PlatformScope,
    publisher: string,
    name: string,
  ): Promise<PackageCatalogueDetail>;
  /**
   * Exact-release facts for plan/apply, including the verified manifest when the
   * artifact loaded. Unlisted releases are returned (so the caller can refuse
   * with PACKAGE_UNSUPPORTED, not a false 404); an unknown version is null.
   */
  resolveRelease(
    packageKey: string,
    version: string,
  ): Promise<PackageReleaseFacts | null>;
}

/** Server-internal release facts; the manifest never leaves the server. */
export interface PackageReleaseFacts {
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly category: string;
  readonly listed: boolean;
  /** False when the artifact is missing/invalid or the manifest disagrees. */
  readonly verified: boolean;
  readonly displayName: string;
  readonly summary: string;
  readonly blockers: readonly PackageBlocker[];
  readonly manifest: PackageManifestV1 | null;
}

export interface LoadPackageCatalogueInput {
  /** Raw marketplace index; validated strictly against MarketplaceV1. */
  index: unknown;
  /** Content-addressed artifact root holding `sha256/<digest>/`. */
  artifactRoot: string;
}

interface CatalogueRecord {
  readonly packageKey: string;
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly category: string;
  readonly listed: boolean;
  readonly verified: boolean;
  readonly displayName: string;
  readonly summary: string;
  readonly resources: PackageResourceSummary[];
  readonly blockers: PackageBlocker[];
  /** Present only when the artifact verified; plan/apply read this. */
  readonly manifest: PackageManifestV1 | null;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function versionParts(version: string): bigint[] {
  return version.split(".").map((part) => BigInt(part));
}

/**
 * Compare `x.y.z` releases component-wise. Parts are compared as big integers,
 * so a component past 2^53 keeps its exact value instead of round-tripping
 * through `Number` and comparing equal by accident.
 */
export function comparePackageVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] ?? 0n;
    const rightPart = b[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

/** Newer minor/patch only; major versions are ordered too, but never merged. */
function isNewer(
  candidate: CatalogueRecord,
  current: CatalogueRecord,
): boolean {
  const byVersion = comparePackageVersions(candidate.version, current.version);
  if (byVersion !== 0) return byVersion > 0;
  return candidate.artifactDigest > current.artifactDigest;
}

function inputInvalid(): Error {
  return packageError("INPUT_INVALID");
}

function assertQuery(query: PackageListQuery): number {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw inputInvalid();
  }
  if (query.search !== undefined) {
    if (
      typeof query.search !== "string" ||
      query.search.length > MAX_SEARCH_LENGTH
    ) {
      throw inputInvalid();
    }
  }
  if (query.category !== undefined) {
    if (typeof query.category !== "string" || query.category.length > 64) {
      throw inputInvalid();
    }
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 2048) {
      throw inputInvalid();
    }
  }
  return limit;
}

function encodeCursor(packageKey: string): string {
  return `${CURSOR_PREFIX}${Buffer.from(packageKey, "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string): string {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw inputInvalid();
  const packageKey = Buffer.from(
    cursor.slice(CURSOR_PREFIX.length),
    "base64url",
  ).toString("utf8");
  if (!PACKAGE_KEY_PATTERN.test(packageKey)) throw inputInvalid();
  return packageKey;
}

function matchesSearch(record: CatalogueRecord, search: string): boolean {
  const needle = search.toLowerCase();
  return (
    record.packageKey.toLowerCase().includes(needle) ||
    record.displayName.toLowerCase().includes(needle) ||
    record.summary.toLowerCase().includes(needle)
  );
}

async function buildRecord(
  entry: MarketplaceV1["packages"][number],
  artifactRoot: string,
): Promise<CatalogueRecord> {
  const [publisher = "", name = ""] = entry.packageKey.split("/");
  const blockers: PackageBlocker[] = [];
  let artifact: VerifiedArtifact | null = null;
  let usable = false;
  try {
    artifact = await loadArtifact(artifactRoot, entry.artifactDigest);
    const manifest = artifact.manifest;
    if (
      manifest.publisher !== publisher ||
      manifest.name !== name ||
      manifest.version !== entry.version
    ) {
      blockers.push({ code: "PACKAGE_UNSUPPORTED" });
    } else {
      usable = true;
    }
  } catch (error) {
    const missing =
      error instanceof ArtifactError && error.code === "ARTIFACT_MISSING";
    blockers.push({ code: missing ? "ARTIFACT_MISSING" : "ARTIFACT_INVALID" });
    artifact = null;
  }
  if (!entry.listed) blockers.push({ code: "PACKAGE_UNLISTED" });

  const resources: PackageResourceSummary[] = [];
  if (usable && artifact) {
    for (const resource of artifact.manifest.resources) {
      // PKG01 resolves nothing a connector needs (catalog entry, account,
      // secret), so a managed connector is reported as unavailable rather than
      // pretending it would work. A required one also blocks installation.
      const available = resource.kind !== "managedConnector";
      resources.push({ id: resource.id, kind: resource.kind, available });
      if (resource.kind === "managedConnector" && resource.required) {
        blockers.push({
          code: "RESOURCE_UNAVAILABLE",
          resourceId: resource.id,
        });
      }
    }
  }

  return {
    packageKey: entry.packageKey,
    publisher,
    name,
    version: entry.version,
    artifactDigest: entry.artifactDigest,
    category: entry.category,
    listed: entry.listed,
    verified: usable,
    displayName: usable && artifact ? artifact.manifest.display.name : name,
    summary: usable && artifact ? artifact.manifest.display.summary : "",
    resources,
    blockers,
    manifest: usable && artifact ? artifact.manifest : null,
  };
}

function toPageItem(record: CatalogueRecord): PackagePageItem {
  return {
    packageKey: record.packageKey,
    version: record.version,
    displayName: record.displayName,
    summary: record.summary,
    category: record.category,
    install: null,
    installable: record.blockers.length === 0,
    blockers: record.blockers,
  };
}

function newestRecord(
  records: readonly CatalogueRecord[],
): CatalogueRecord | undefined {
  return records.reduce<CatalogueRecord | undefined>(
    (newest, record) => (!newest || isNewer(record, newest) ? record : newest),
    undefined,
  );
}

/**
 * Public reads choose among listed releases only: the newest listed verified
 * release wins, and only when nothing listed verifies does the newest listed
 * release explain why it is unavailable. A newer unlisted or broken release
 * never hides one that is listed and works.
 */
function selectPublicRecord(
  records: readonly CatalogueRecord[],
): CatalogueRecord | undefined {
  const listed = records.filter((record) => record.listed);
  if (listed.length === 0) return undefined;
  return (
    newestRecord(listed.filter((record) => record.verified)) ??
    newestRecord(listed)
  );
}

export async function loadPackageCatalogue({
  index,
  artifactRoot,
}: LoadPackageCatalogueInput): Promise<PackageCatalogue> {
  const marketplace = MarketplaceV1Schema.parse(index);

  const seen = new Map<string, string>();
  for (const entry of marketplace.packages) {
    const identity = `${entry.packageKey}@${entry.version}`;
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new Error(
        previous === entry.artifactDigest
          ? `PACKAGE_INDEX_INVALID: duplicate entry ${identity}`
          : `PACKAGE_INDEX_INVALID: ${identity} is declared with two different digests`,
      );
    }
    seen.set(identity, entry.artifactDigest);
  }

  const records = new Map<string, CatalogueRecord[]>();
  for (const entry of marketplace.packages) {
    const record = await buildRecord(entry, artifactRoot);
    const group = records.get(record.packageKey);
    if (group) group.push(record);
    else records.set(record.packageKey, [record]);
  }

  return {
    async list(_scope, query, options) {
      const limit = assertQuery(query);
      const cursorKey = query.cursor ? decodeCursor(query.cursor) : null;
      const search = query.search;
      const selected: CatalogueRecord[] = [];
      for (const group of records.values()) {
        const record = options?.includeUnlisted
          ? newestRecord(group)
          : selectPublicRecord(group);
        if (record) selected.push(record);
      }
      const filtered = selected
        .filter((record) => !search || matchesSearch(record, search))
        .filter(
          (record) =>
            query.category === undefined || record.category === query.category,
        )
        .filter(
          (record) =>
            cursorKey === null || compareUtf8(record.packageKey, cursorKey) > 0,
        )
        .sort((left, right) => compareUtf8(left.packageKey, right.packageKey));

      const page = filtered.slice(0, limit);
      const last = page.at(-1);
      const hasMore = filtered.length > page.length;
      return PackagePageSchema.parse({
        items: page.map(toPageItem),
        nextCursor: hasMore && last ? encodeCursor(last.packageKey) : null,
      });
    },

    async get(_scope, publisher, name) {
      if (
        !PACKAGE_ID_PATTERN.test(publisher) ||
        !PACKAGE_ID_PATTERN.test(name)
      ) {
        throw packageError("RESOURCE_NOT_FOUND");
      }
      const record = selectPublicRecord(
        records.get(`${publisher}/${name}`) ?? [],
      );
      if (!record) throw new Error("RESOURCE_NOT_FOUND");
      return PackageCatalogueDetailSchema.parse({
        packageKey: record.packageKey,
        version: record.version,
        artifactDigest: record.artifactDigest,
        displayName: record.displayName,
        summary: record.summary,
        category: record.category,
        publisher: record.publisher,
        name: record.name,
        resources: record.resources,
        installable: record.blockers.length === 0,
        blockers: record.blockers,
      });
    },

    async resolveRelease(packageKey, version) {
      if (
        !PACKAGE_KEY_PATTERN.test(packageKey) ||
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
      ) {
        return null;
      }
      const record = (records.get(packageKey) ?? []).find(
        (candidate) => candidate.version === version,
      );
      if (!record) return null;
      return {
        packageKey: record.packageKey,
        version: record.version,
        artifactDigest: record.artifactDigest,
        category: record.category,
        listed: record.listed,
        verified: record.verified,
        displayName: record.displayName,
        summary: record.summary,
        blockers: record.blockers,
        manifest: record.manifest,
      };
    },
  };
}
