import {
  acquireIndexLock,
  readMarketplaceIndex,
  serializeMarketplaceIndex,
  sha256Hex,
} from "../../../scripts/plugin-packages/index-file";
import type { PackageReleaseState } from "../../../shared/enterprise/plugin-package-contracts";

/**
 * T13-fix-1 (Codex FC-01): the deployment-side withdrawal fact source shared
 * with dispatch. The boot-time catalogue snapshot (`loadPackageCatalogue`,
 * loaded once at server assembly) is no longer the only fact a dispatch
 * consults: before its CAS, every dispatch re-reads the CURRENT deployment
 * index under the SAME cross-process directory lock the deploy commands
 * (`withdraw.ts` / `publish.ts`) hold while they replace that file.
 *
 * Linearization, per release:
 *   - withdraw commits (index renamed) before the dispatch reads → the
 *     dispatch sees `state: "withdrawn"` and refuses with transport 0;
 *   - the dispatch reads and CAS-commits first → the withdrawal is blocked
 *     until the dispatch transaction has committed, and the already-dispatched
 *     call keeps its preserved/unknown outcome (PKG10 semantics untouched).
 *
 * The lock is `withIndexLock`'s exact directory-lock protocol on
 * `${indexPath}.lock` — one lock, one protocol, both sides. The facts are
 * content-addressed: every read carries the sha256 of the serialized index it
 * was read from, so tests (and operators) can prove which index generation a
 * decision linearized against. Nothing here executes package code, dials the
 * network, or touches company configuration: reads only.
 */

/** Current on-disk facts for one exact release, read under the release lock. */
export interface DeployedReleaseFacts {
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  /** Orthogonal to `state`: unlisting is discovery-only (never blocks dispatch). */
  readonly listed: boolean;
  readonly state: PackageReleaseState;
  /** sha256 of the serialized index this read came from (content-addressed). */
  readonly indexDigest: string;
}

/** Held release lock; release after the dispatch transaction has committed. */
export interface ReleaseLockHandle {
  release(): Promise<void>;
}

/**
 * The withdrawal-facts seam dispatch consumes. Production wires the file-backed
 * gate (`createDeployedReleaseFactsGate`); tests may inject a controlled one.
 */
export interface PackageReleaseFactsGate {
  /**
   * Acquire the shared release lock. Dispatch acquires it BEFORE any database
   * lock (never the reverse) and releases it only after its transaction has
   * committed, so a withdrawal can never land between the facts read and the
   * dispatched CAS.
   */
  acquireReleaseLock(): Promise<ReleaseLockHandle>;
  /**
   * Read the CURRENT on-disk facts for one exact release. Callers enforcing a
   * decision must hold the release lock; advisory readers (prepare/verdict
   * surfaces) may call it lock-free. Throws on an unreadable/invalid index —
   * the dispatch maps that to fail-closed, never to "treat as published".
   * Returns null when the release is not registered in the current index.
   */
  readFreshFacts(
    packageKey: string,
    version: string,
  ): Promise<DeployedReleaseFacts | null>;
}

export interface CreateDeployedReleaseFactsGateInput {
  /** The deployment marketplace index the boot catalogue was loaded from. */
  readonly indexPath: string;
  /** Lock tuning; defaults match the deploy commands' shared constants. */
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /**
   * Test/observation hook: invoked with each read's facts before they are
   * returned. Contention tests use it as a barrier inside the lock window.
   */
  readonly onFactsRead?: (
    facts: DeployedReleaseFacts | null,
  ) => Promise<void> | void;
}

/** The file-backed gate: the same file, the same lock, as the deploy commands. */
export function createDeployedReleaseFactsGate(
  input: CreateDeployedReleaseFactsGateInput,
): PackageReleaseFactsGate {
  const { indexPath } = input;
  const lockOptions = {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.staleMs === undefined ? {} : { staleMs: input.staleMs }),
  };
  const readIndex = async () => {
    // Strict MarketplaceV1 parse — a hand-drifted index fails closed here,
    // exactly like the deployment commands' own writes refuse to produce one.
    const index = await readMarketplaceIndex(indexPath);
    return {
      index,
      indexDigest: sha256Hex(serializeMarketplaceIndex(index)),
    };
  };
  return {
    async acquireReleaseLock(): Promise<ReleaseLockHandle> {
      // The deploy commands' lock protocol, verbatim (same path, same
      // atomic mkdir, same stale breaking): one cross-process mutex.
      return acquireIndexLock(indexPath, lockOptions);
    },
    async readFreshFacts(
      packageKey: string,
      version: string,
    ): Promise<DeployedReleaseFacts | null> {
      const { index, indexDigest } = await readIndex();
      const entry = index.packages.find(
        (candidate) =>
          candidate.packageKey === packageKey && candidate.version === version,
      );
      const facts: DeployedReleaseFacts | null = entry
        ? {
            packageKey: entry.packageKey,
            version: entry.version,
            artifactDigest: entry.artifactDigest,
            listed: entry.listed,
            state: entry.state,
            indexDigest,
          }
        : null;
      if (input.onFactsRead) await input.onFactsRead(facts);
      return facts;
    },
  };
}
