import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { PackageManifestV1 } from "../../../shared/enterprise/plugin-package-contracts";
import { parsePackageManifest } from "./manifest";

/**
 * Trusted plugin-package artifact verification.
 *
 * A package is a directory of regular files with `openbot.plugin.json` at its
 * root. Every path is checked before it is opened, every file is read once
 * into a bounded buffer, and the digest is computed from those same buffers —
 * a file swapped after verification cannot change what the digest describes.
 * Symlinks, devices and case-folding collisions are refused, not followed.
 */

export const PACKAGE_MANIFEST_FILE = "openbot.plugin.json";
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_FILES = 512;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const DIGEST_PREFIX = "openbot:plugin-package:v1\0";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const WEBP_RIFF = Buffer.from("RIFF", "ascii");
const WEBP_TAG = Buffer.from("WEBP", "ascii");

export type ArtifactFailureCode = "ARTIFACT_MISSING" | "ARTIFACT_INVALID";

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface VerifiedArtifactFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface VerifiedArtifact {
  readonly manifest: PackageManifestV1;
  readonly files: VerifiedArtifactFile[];
  readonly digest: string;
  readonly root: string;
}

function invalid(message: string): ArtifactError {
  return new ArtifactError("ARTIFACT_INVALID", message);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Two paths that differ only by case would overwrite each other on a
 * case-insensitive filesystem and can never address two files reliably, so the
 * package is refused wherever it is built.
 */
export function assertNoCaseFoldCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined && existing !== path) {
      throw invalid(`path case-folding collision: ${existing} and ${path}`);
    }
    seen.set(folded, path);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The POSIX path predicate the manifest schema applies, repeated against the
 * walked filesystem: a package must not smuggle a file name that a manifest
 * would never be allowed to declare. Every walked file and directory path goes
 * through this, not only manifest-declared ones.
 */
function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !value
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function isImageAsset(path: string, textPaths: ReadonlySet<string>): boolean {
  if (textPaths.has(path)) return false;
  return /\.(png|webp)$/i.test(path);
}

function assertImageMagic(path: string, bytes: Buffer): void {
  const png =
    bytes.byteLength >= PNG_SIGNATURE.byteLength &&
    bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
  const webp =
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).equals(WEBP_RIFF) &&
    bytes.subarray(8, 12).equals(WEBP_TAG);
  if (!png && !webp) {
    throw invalid(`asset ${path} is not a valid PNG or WebP image`);
  }
}

interface WalkedFile {
  readonly path: string;
  readonly size: number;
}

async function walkPackage(
  root: string,
): Promise<{ rootReal: string; files: WalkedFile[] }> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new ArtifactError(
      "ARTIFACT_MISSING",
      `artifact root ${root} is missing`,
    );
  }
  const marker = await lstat(rootReal).catch(() => null);
  if (!marker?.isDirectory()) {
    throw new ArtifactError(
      "ARTIFACT_MISSING",
      `artifact root ${root} is not a directory`,
    );
  }
  const files: WalkedFile[] = [];
  const directories: Array<{ absolute: string; prefix: string }> = [
    { absolute: rootReal, prefix: "" },
  ];
  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      throw new ArtifactError(
        "ARTIFACT_MISSING",
        "artifact directory is missing",
      );
    }
    for (const entry of entries) {
      const relative = current.prefix
        ? `${current.prefix}/${entry.name}`
        : entry.name;
      if (!isSafeRelativePath(relative)) {
        throw invalid(
          `path is not a safe POSIX relative path: ${JSON.stringify(relative)}`,
        );
      }
      const absolute = join(current.absolute, entry.name);
      const info = await lstat(absolute).catch(() => null);
      if (!info)
        throw invalid(`entry ${relative} disappeared during verification`);
      if (info.isSymbolicLink()) {
        throw invalid(`symlink is not allowed: ${relative}`);
      }
      if (info.isDirectory()) {
        directories.push({ absolute, prefix: relative });
        continue;
      }
      if (!info.isFile()) {
        throw invalid(`not a regular file: ${relative}`);
      }
      files.push({ path: relative, size: info.size });
    }
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return { rootReal, files };
}

async function readVerifiedFile(
  root: string,
  rootReal: string,
  relative: string,
  maxBytes: number,
  label = relative,
): Promise<Buffer> {
  const absolute = join(root, ...relative.split("/"));
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    throw invalid(`file is missing: ${relative}`);
  }
  if (!isPathInside(rootReal, resolved)) {
    throw invalid(`path escapes the package root: ${relative}`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw invalid(`symlink is not allowed: ${relative}`);
    }
    throw invalid(`file is unreadable: ${relative}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalid(`not a regular file: ${label}`);
    if (info.size > maxBytes) {
      throw invalid(
        `${label} exceeds the ${maxBytes}-byte limit (${info.size} bytes)`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw invalid(
        `${label} exceeds the ${maxBytes}-byte limit (${bytes.byteLength} bytes)`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function computeDigest(entries: Array<[string, number, string]>): string {
  const canonical = JSON.stringify(entries);
  return createHash("sha256")
    .update(Buffer.from(DIGEST_PREFIX, "utf8"))
    .update(Buffer.from(canonical, "utf8"))
    .digest("hex");
}

/**
 * Verify a package directory and return its manifest, per-file hashes and
 * content digest. The digest covers every regular file, the manifest included,
 * sorted by UTF-8 bytes of the canonical relative POSIX path.
 */
export async function buildArtifact(root: string): Promise<VerifiedArtifact> {
  const { rootReal, files } = await walkPackage(root);
  if (files.length > MAX_FILES) {
    throw invalid(`package has ${files.length} files; the limit is 512`);
  }
  const totalFromStat = files.reduce((total, file) => total + file.size, 0);
  if (totalFromStat > MAX_TOTAL_BYTES) {
    throw invalid(
      `package is ${totalFromStat} bytes; the limit is 16 MiB (16777216 bytes)`,
    );
  }
  assertNoCaseFoldCollisions(files.map((file) => file.path));

  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestEntry = byPath.get(PACKAGE_MANIFEST_FILE);
  if (!manifestEntry) {
    throw invalid(`manifest ${PACKAGE_MANIFEST_FILE} is missing`);
  }
  const manifestBytes = await readVerifiedFile(
    root,
    rootReal,
    PACKAGE_MANIFEST_FILE,
    MAX_MANIFEST_BYTES,
    `manifest ${PACKAGE_MANIFEST_FILE}`,
  );
  let manifestInput: unknown;
  try {
    manifestInput = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw invalid(`manifest ${PACKAGE_MANIFEST_FILE} is not valid JSON`);
  }
  let manifest: PackageManifestV1;
  try {
    manifest = parsePackageManifest(manifestInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(`manifest is invalid: ${message}`);
  }

  const textPaths = new Set<string>([PACKAGE_MANIFEST_FILE]);
  for (const resource of manifest.resources) {
    if (resource.kind === "managedConnector") continue;
    textPaths.add(resource.path);
    if (!byPath.has(resource.path)) {
      throw invalid(
        `resource ${resource.id} path is missing or not a regular file: ${resource.path}`,
      );
    }
  }
  if (manifest.display.icon !== undefined) {
    if (!byPath.has(manifest.display.icon)) {
      throw invalid(
        `display.icon is missing or not a regular file: ${manifest.display.icon}`,
      );
    }
  }
  const assetPaths = new Set<string>();
  for (const file of files) {
    if (file.path === PACKAGE_MANIFEST_FILE) continue;
    if (isImageAsset(file.path, textPaths)) assetPaths.add(file.path);
  }
  if (manifest.display.icon !== undefined)
    assetPaths.add(manifest.display.icon);

  const buffers = new Map<string, Buffer>();
  buffers.set(PACKAGE_MANIFEST_FILE, manifestBytes);
  let totalBytes = manifestBytes.byteLength;
  for (const file of files) {
    if (file.path === PACKAGE_MANIFEST_FILE) continue;
    const isAsset = assetPaths.has(file.path);
    const bytes = await readVerifiedFile(
      root,
      rootReal,
      file.path,
      isAsset ? MAX_TOTAL_BYTES : MAX_TEXT_FILE_BYTES,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw invalid(
        `package exceeds the 16 MiB total limit (16777216 bytes) at ${file.path}`,
      );
    }
    if (isAsset) assertImageMagic(file.path, bytes);
    buffers.set(file.path, bytes);
  }

  const verifiedFiles: VerifiedArtifactFile[] = files.map((file) => {
    const bytes = buffers.get(file.path);
    if (!bytes) throw invalid(`file was not verified: ${file.path}`);
    return {
      path: file.path,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  });
  const digest = computeDigest(
    verifiedFiles.map((file) => [file.path, file.bytes, file.sha256]),
  );
  return { manifest, files: verifiedFiles, digest, root: rootReal };
}

/**
 * Load a stored artifact from `<root>/sha256/<digest>/` and prove that the
 * bytes still hash to the requested digest before returning them.
 */
export async function loadArtifact(
  root: string,
  digest: string,
): Promise<VerifiedArtifact> {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new ArtifactError("ARTIFACT_INVALID", "artifact digest is malformed");
  }
  const artifact = await buildArtifact(join(root, "sha256", digest));
  if (artifact.digest !== digest) {
    throw invalid(
      `artifact digest mismatch: expected ${digest}, computed ${artifact.digest}`,
    );
  }
  return artifact;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

/**
 * Store verified bytes under `<destinationRoot>/sha256/<digest>/`. The copy is
 * written and verified in a temporary directory first, then renamed into
 * place, so a concurrent reader never sees a partial artifact.
 */
export async function storeArtifact(
  artifact: VerifiedArtifact,
  destinationRoot: string,
): Promise<string> {
  const target = join(destinationRoot, "sha256", artifact.digest);
  if (await isDirectory(target)) {
    // Re-loading proves the stored copy still hashes to this digest; there is
    // no separate digest to compare against here.
    await loadArtifact(destinationRoot, artifact.digest);
    return target;
  }
  await mkdir(join(destinationRoot, "sha256"), { recursive: true });
  const temporary = await mkdtemp(join(destinationRoot, ".tmp-"));
  try {
    for (const file of artifact.files) {
      const source = join(artifact.root, ...file.path.split("/"));
      const bytes = await readFile(source).catch(() => {
        throw invalid(`artifact changed while storing: ${file.path}`);
      });
      if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
        throw invalid(`artifact changed while storing: ${file.path}`);
      }
      const destination = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const written = await buildArtifact(temporary);
    if (written.digest !== artifact.digest) {
      throw invalid("stored copy does not reproduce the verified digest");
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (await isDirectory(target)) {
        await loadArtifact(destinationRoot, artifact.digest);
        return target;
      }
      throw error;
    }
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
