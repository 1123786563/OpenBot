import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Where file bytes live, addressed by a server-derived key — the seam the
 * store writes through and the deletion manifest's `externalKey` names. The
 * local-directory implementation mirrors `craft/storage/object-store.ts`'s
 * LocalObjectStore rules (refuse absolute keys and `..`, create parents,
 * idempotent delete); it is not shared with craft because that factory
 * requires craft's full S3-shaped storage config, and a files deployment
 * that only wants a local directory should not have to fabricate one.
 */

/** put/get/delete by opaque server-derived key. */
export type FileByteStore = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

/*
 * §5's size ceilings live here — the module both the files routes and the
 * documents flows (inspect/fill/transfer) share — rather than in the routes
 * file, so a cross-module import never reaches into a route module.
 */

/** §5: general upload ceiling. */
export const OPENMUSE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** §5: PDFs keep the tighter existing ceiling. */
export const OPENMUSE_MAX_PDF_BYTES = 10 * 1024 * 1024;

/** The key a file version's bytes are stored under. Always server-derived. */
export function openMuseFileByteKey(
  ownerUserId: string,
  fileId: string,
  versionId: string,
): string {
  return `openmuse-files/${ownerUserId}/${fileId}/${versionId}`;
}

function localPath(root: string, key: string): string {
  if (isAbsolute(key)) {
    throw new Error(`File key must be relative: ${key}`);
  }
  // Backslash and NUL are refused before the split below: on Windows join
  // treats "\\" as a separator, so a `..\x`-shaped key would escape the
  // segment check entirely.
  if (key.includes("\\") || key.includes("\0")) {
    throw new Error(`File key contains illegal characters: ${key}`);
  }
  const segments = key.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`File key may not traverse upward: ${key}`);
  }
  return join(root, ...segments);
}

export function createLocalFileByteStore(root: string): FileByteStore {
  return {
    async put(key, bytes) {
      const path = localPath(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(localPath(root, key)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(localPath(root, key), { force: true });
    },
  };
}
