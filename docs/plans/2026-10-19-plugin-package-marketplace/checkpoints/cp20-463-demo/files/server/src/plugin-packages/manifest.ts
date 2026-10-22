import {
  type PackageManifestV1,
  PackageManifestV1Schema,
} from "../../../shared/enterprise/plugin-package-contracts";

/**
 * Parse a plugin manifest with the V1 shape. Every object is strict; unknown
 * schema versions, duplicate resource ids, dangling expert-template skill
 * references and non-empty package dependencies are refusals, not warnings.
 */
export function parsePackageManifest(input: unknown): PackageManifestV1 {
  return PackageManifestV1Schema.parse(input);
}
