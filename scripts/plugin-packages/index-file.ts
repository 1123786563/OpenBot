import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type MarketplaceV1,
  MarketplaceV1Schema,
  PackageKeySchema,
  PackageVersionSchema,
} from "../../shared/enterprise/plugin-package-contracts";

/**
 * PKG08 (#467): shared file-index operations for the DEPLOYMENT management
 * commands (`publish.ts`, `withdraw.ts`).
 *
 * The marketplace index is the release fact source (PKG01's file index, not a
 * parallel DB table). These helpers keep three invariants for every writer:
 *
 *   1. strict parse — the index only ever holds MarketplaceV1 shapes, so the
 *      server's startup parse can never see a hand-drifted field;
 *   2. atomic replace — readers observe either the whole old index or the
 *      whole new one, never a torn write (same-directory tmp + rename);
 *   3. one writer at a time — an exclusive directory lock (mkdir is atomic on
 *      POSIX) serializes read-modify-write cycles across processes; a stale
 *      lock from a crashed holder is broken by age, not by waiting forever.
 *
 * Nothing here executes package content, dials the network, reads company
 * configuration or touches the database: the deployment channel owns the
 * files, and that is all it gets.
 */

/** A structured command failure: receipts carry the code, never a bare string. */
export class IndexOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IndexOperationError";
  }
}

/** Strict-parse the index; any drift is refused before a writer mutates it. */
export async function readMarketplaceIndex(
  path: string,
): Promise<MarketplaceV1> {
  const parsed = MarketplaceV1Schema.safeParse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (!parsed.success) {
    throw new IndexOperationError(
      "PACKAGE_INDEX_INVALID",
      `the index at ${path} is not a valid MarketplaceV1 document: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Deterministic serialization: schema field order, stable formatting. */
export function serializeMarketplaceIndex(index: MarketplaceV1): string {
  return `${JSON.stringify(
    {
      schemaVersion: index.schemaVersion,
      packages: index.packages.map((entry) => ({
        packageKey: entry.packageKey,
        version: entry.version,
        artifactDigest: entry.artifactDigest,
        category: entry.category,
        listed: entry.listed,
        state: entry.state,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Parse-validate the mutated index, then atomically replace the file. */
export async function writeMarketplaceIndexAtomic(
  path: string,
  index: MarketplaceV1,
): Promise<void> {
  // The write is refused unless the document is exactly MarketplaceV1: a
  // mutation that broke the contract never reaches the filesystem.
  const parsed = MarketplaceV1Schema.safeParse(
    JSON.parse(serializeMarketplaceIndex(index)),
  );
  if (!parsed.success) {
    throw new IndexOperationError(
      "PACKAGE_INDEX_INVALID",
      "the mutated index is not a valid MarketplaceV1 document",
    );
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, serializeMarketplaceIndex(parsed.data), {
    encoding: "utf8",
    mode: 0o644,
  });
  // Same-directory rename: atomic on POSIX, so a concurrent reader either
  // sees the whole previous index or the whole new one.
  await rename(temporary, path);
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

/** Lock tuning (tests shorten the waits instead of sleeping seconds). */
export interface IndexLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /**
   * Test/observation hook: invoked after a lock is judged stale, BEFORE the
   * second check that decides whether to break it. Contention tests use it
   * as a barrier inside the break decision window.
   */
  readonly onStaleLockDetected?: () => Promise<void> | void;
}

/**
 * Exclusive cross-process lock around one read-modify-write cycle. The lock
 * is a directory (mkdir is atomic); a holder older than `staleMs` is assumed
 * crashed and the lock is broken.
 */
export async function withIndexLock<T>(
  indexPath: string,
  work: () => Promise<T>,
  options: IndexLockOptions = {},
): Promise<T> {
  const lock = await acquireIndexLock(indexPath, options);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** A held index lock; `release()` is idempotent-safe to call once. */
export interface IndexLockHandle {
  release(): Promise<void>;
}

/**
 * T13-fix-1 (FC-01): the acquire/release split of `withIndexLock`. The
 * dispatch side holds the SAME directory lock across its decide-and-CAS span
 * (acquired before any database lock, released after the dispatch transaction
 * has committed), which is what makes a withdrawal and a dispatch strictly
 * ordered against each other across processes. The protocol is byte-for-byte
 * the deployment writers' protocol — same path, same mkdir/EEXIST atomicity,
 * same stale-lock breaking — so there is exactly one lock, not two flavors.
 */
export async function acquireIndexLock(
  indexPath: string,
  options: IndexLockOptions = {},
): Promise<IndexLockHandle> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const lockPath = `${indexPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lockPath);
      acquired = true;
    } catch (error) {
      const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!exists) throw error;
      let stale = false;
      let staleMtimeMs = 0;
      try {
        const info = await stat(lockPath);
        staleMtimeMs = info.mtimeMs;
        stale = Date.now() - info.mtimeMs > staleMs;
      } catch {
        // The holder released between mkdir and stat: retry immediately.
        stale = false;
      }
      if (stale) {
        if (options.onStaleLockDetected) {
          await options.onStaleLockDetected();
        }
        // OCR-fix-B (B1): re-verify before breaking. The judged-stale holder
        // may have released and another writer recreated the lock between
        // the stale stat and this point — a recreated lock has a fresh
        // mtime, so only an UNCHANGED, still-stale lock is broken.
        let stillStale = false;
        try {
          const recheck = await stat(lockPath);
          stillStale =
            recheck.mtimeMs === staleMtimeMs &&
            Date.now() - recheck.mtimeMs > staleMs;
        } catch {
          stillStale = false;
        }
        if (stillStale) {
          // A crashed holder's lock: break it and try again (best effort; a
          // live holder's heartbeat keeps the mtime fresh).
          await rm(lockPath, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new IndexOperationError(
          "PACKAGE_INDEX_LOCKED",
          `another index writer holds ${lockPath}; waited ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  // Refresh the lock's mtime while held so a long mutation is never
  // mistaken for a crashed holder.
  await writeFile(join(lockPath, "holder"), `${process.pid}\n`, {
    encoding: "utf8",
  });
  // OCR-fix-B (B1): the dispatch side holds this lock across a database
  // transaction plus artifact reads — longer than any single mtime write.
  // A heartbeat under half of staleMs keeps a live holder unbreakable no
  // matter how long it holds; it stops on release and on a vanished lock.
  const heartbeatMs = Math.max(25, Math.floor(staleMs / 3));
  let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
    utimes(lockPath, new Date(), new Date()).catch(() => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    });
  }, heartbeatMs);
  heartbeat?.unref?.();
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      await rm(lockPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}

export interface ReleaseIdentity {
  readonly packageKey: string;
  readonly version: string;
}

/** Validate the identity shapes with the contract's own schemas. */
export function assertReleaseIdentity(identity: ReleaseIdentity): void {
  if (!PackageKeySchema.safeParse(identity.packageKey).success) {
    throw new IndexOperationError(
      "INPUT_INVALID",
      `package key must match publisher/name kebab-case: ${identity.packageKey}`,
    );
  }
  if (!PackageVersionSchema.safeParse(identity.version).success) {
    throw new IndexOperationError(
      "INPUT_INVALID",
      `version must be three non-negative integers x.y.z: ${identity.version}`,
    );
  }
}

/** The existing entry for one exact release, or undefined. */
export function findReleaseEntry(
  index: MarketplaceV1,
  identity: ReleaseIdentity,
): MarketplaceV1["packages"][number] | undefined {
  return index.packages.find(
    (entry) =>
      entry.packageKey === identity.packageKey &&
      entry.version === identity.version,
  );
}

/**
 * The same-version rule (Spec §6/§10): a release identity is immutable. An
 * existing entry with a DIFFERENT digest is refused — a changed release is a
 * changed version, never a silent overwrite of the same one.
 */
export function assertNoDigestConflict(
  index: MarketplaceV1,
  identity: ReleaseIdentity & { readonly artifactDigest: string },
): void {
  const existing = findReleaseEntry(index, identity);
  if (existing && existing.artifactDigest !== identity.artifactDigest) {
    throw new IndexOperationError(
      "PACKAGE_DIGEST_CONFLICT",
      `${identity.packageKey}@${identity.version} is already registered with digest ${existing.artifactDigest}; refusing to overwrite it with ${identity.artifactDigest} (a changed release needs a new version)`,
    );
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
