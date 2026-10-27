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
 *      Every acquisition stamps its own random owner token, and both release
 *      and stale-breaking only ever delete the lock whose token they judged —
 *      a stalled holder that wakes up cannot remove its successor's lock.
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
/** Consecutive failed heartbeats after which a holder stops claiming the lock. */
const HEARTBEAT_FAILURE_LIMIT = 3;
/** The lock directory's holder-identity file (one random token per acquire). */
const LOCK_OWNER_FILE = "owner";

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
  /**
   * Test/observation hook: one liveness refresh of the held lock. Defaults to
   * `utimes(lockPath, now, now)`; a throwing implementation drives the
   * give-up path.
   */
  readonly heartbeat?: (lockPath: string) => Promise<unknown>;
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
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await lock.release();
    throw error;
  }
  await lock.release();
  // OCR-fix-G1 (R6-H1/M): a lock whose heartbeat could not be refreshed is no
  // longer proof of exclusivity, so the cycle reports that instead of letting
  // its caller believe the write was serialized.
  if (lock.lost) {
    throw new IndexOperationError(
      "PACKAGE_INDEX_LOCK_LOST",
      `the lock on ${indexPath} could not be refreshed while the critical section ran, so its exclusivity is no longer guaranteed — re-read the index and retry`,
    );
  }
  return result;
}

/** What `release()` did: `released: false` names why nothing was deleted. */
export type IndexLockReleaseResult =
  | { readonly released: true }
  | {
      readonly released: false;
      readonly reason: "NOT_OWNER" | "GONE";
    };

/** A held index lock; `release()` is idempotent-safe to call once. */
export interface IndexLockHandle {
  /**
   * Releases the lock if this handle still owns it. Deliberately `void`: the
   * dispatch-side `ReleaseLockHandle` seam (server/src) has this shape, and
   * the outcome is recorded in `releaseOutcome` rather than silently dropped.
   */
  release(): Promise<void>;
  /** What the release did; null until `release()` has run. */
  readonly releaseOutcome: IndexLockReleaseResult | null;
  /**
   * True when this handle stopped owning the lock before releasing it: its
   * heartbeat could not refresh the lock, so the critical section ran without
   * the exclusivity the acquisition promised.
   */
  readonly lost: boolean;
}

/** The lock's owner token; null when the file (or the whole lock) is absent. */
async function readLockOwner(lockPath: string): Promise<string | null> {
  try {
    return (await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Delete the lock ONLY when it is still the one `expected` identified. The
 * token is read first, so a holder whose lock was judged stale and taken over
 * never touches its successor's lock; the directory is then detached with an
 * atomic rename and its token re-read, which catches a hand-over that landed
 * in the read→delete window.
 *
 * Residual window: if the detached lock turns out to be someone else's AND a
 * third writer has meanwhile taken the canonical name, the restore fails and
 * only the detached copy is dropped — the third writer's lock is intact, and
 * the detached holder was already mid-hand-over when it was judged.
 */
async function removeLockIfOwned(
  lockPath: string,
  expected: string | null,
): Promise<"removed" | "changed" | "gone"> {
  if ((await readLockOwner(lockPath)) !== expected) return "changed";
  const detached = `${lockPath}.release-${randomUUID()}`;
  try {
    await rename(lockPath, detached);
  } catch {
    return "gone";
  }
  if ((await readLockOwner(detached)) !== expected) {
    await rename(detached, lockPath).catch(() =>
      rm(detached, { recursive: true, force: true }).catch(() => undefined),
    );
    return "changed";
  }
  // Rename already freed the name; a failed rm only leaves the detached tree.
  await rm(detached, { recursive: true, force: true }).catch(() => undefined);
  return "removed";
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
  const refresh =
    options.heartbeat ??
    ((path: string) => utimes(path, new Date(), new Date()));
  const lockPath = `${indexPath}.lock`;
  // OCR-fix-G1 (R6-H1): this acquisition's identity. Only a lock carrying
  // this token is ever released or broken by this handle.
  const token = randomUUID();
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
      let staleToken: string | null = null;
      try {
        const info = await stat(lockPath);
        staleMtimeMs = info.mtimeMs;
        stale = Date.now() - info.mtimeMs > staleMs;
        if (stale) staleToken = await readLockOwner(lockPath);
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
        // OCR-fix-G1 (R6-H1): the owner token joins that check, so a lock
        // that changed hands under an unchanged-looking mtime is not ours to
        // break either.
        let stillStale = false;
        try {
          const recheck = await stat(lockPath);
          stillStale =
            recheck.mtimeMs === staleMtimeMs &&
            Date.now() - recheck.mtimeMs > staleMs &&
            (await readLockOwner(lockPath)) === staleToken;
        } catch {
          stillStale = false;
        }
        if (stillStale) {
          // A crashed holder's lock: break it and try again (best effort; a
          // live holder's heartbeat keeps the mtime fresh). `removeLockIfOwned`
          // re-checks the token once more before anything is deleted.
          await removeLockIfOwned(lockPath, staleToken);
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
  // mistaken for a crashed holder. The owner token is the lock's identity;
  // `holder` keeps the pid for operators.
  await writeFile(join(lockPath, LOCK_OWNER_FILE), `${token}\n`, {
    encoding: "utf8",
  });
  await writeFile(join(lockPath, "holder"), `${process.pid}\n`, {
    encoding: "utf8",
  });
  // OCR-fix-B (B1): the dispatch side holds this lock across a database
  // transaction plus artifact reads — longer than any single mtime write.
  // A heartbeat under half of staleMs keeps a live holder unbreakable no
  // matter how long it holds; it stops on release and on a vanished lock.
  // OCR-fix-G1 (R6-H1/M): one failed refresh no longer parks the holder in a
  // "still holding" pose forever — failures are retried up to a limit, after
  // which the handle gives the claim up (`lost`) so the caller reports it.
  const heartbeatMs = Math.max(25, Math.floor(staleMs / 3));
  let failures = 0;
  let lost = false;
  let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
    void Promise.resolve()
      .then(() => refresh(lockPath))
      .then(
        () => {
          failures = 0;
        },
        () => {
          failures += 1;
          if (failures < HEARTBEAT_FAILURE_LIMIT || !heartbeat) return;
          lost = true;
          clearInterval(heartbeat);
          heartbeat = null;
        },
      );
  }, heartbeatMs);
  heartbeat?.unref?.();
  let released = false;
  let releaseOutcome: IndexLockReleaseResult | null = null;
  return {
    get lost() {
      return lost;
    },
    get releaseOutcome() {
      return releaseOutcome;
    },
    release: async () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (released) return;
      released = true;
      const outcome = await removeLockIfOwned(lockPath, token);
      releaseOutcome =
        outcome === "removed"
          ? { released: true }
          : {
              released: false,
              reason: outcome === "changed" ? "NOT_OWNER" : "GONE",
            };
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
