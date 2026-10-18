/**
 * Cache-keys fixture helpers (MT015 / Issue #58).
 *
 * Test-only scaffolding for the ownership-aware key derivation suite:
 *
 *  - `createKeyedMemoryCache` — a minimal Map-backed cache addressed by
 *    caller-derived keys. It has no tenancy awareness of its own: every
 *    isolation property the MT015 tests demonstrate comes from the derived
 *    key alone, which is exactly the production contract (callers hold the
 *    real infrastructure; the keys decide what can and cannot be reached).
 *  - `syntheticOwnership` — builds plain ownership facts for pure-function
 *    tests; the DB-backed cases in the suite use the real runtime-config
 *    service output instead.
 *
 * Nothing here touches the database and nothing here is imported by
 * production code.
 */

import type { ScopedKeyOwnership } from "../../../src/enterprise/tenancy/scoped-keys";

export interface KeyedMemoryCache {
  /** Stores a value under an externally derived key. */
  put(key: string, value: string): void;
  /** Returns the value or undefined — undefined is a miss, never a leak. */
  get(key: string): string | undefined;
  has(key: string): boolean;
  /** Number of stored entries (old entries are never auto-removed). */
  readonly size: number;
}

export function createKeyedMemoryCache(): KeyedMemoryCache {
  const entries = new Map<string, string>();
  return {
    put(key, value) {
      entries.set(key, value);
    },
    get(key) {
      return entries.get(key);
    },
    has(key) {
      return entries.has(key);
    },
    get size() {
      return entries.size;
    },
  };
}

/** Plain ownership facts for pure-function key derivation tests. */
export function syntheticOwnership(
  tenantId: string,
  workspaceId: string,
  companyRevision: number,
  overrideRevision: number | null,
): ScopedKeyOwnership {
  return Object.freeze({
    tenantId,
    workspaceId,
    configVersion: Object.freeze({
      company: companyRevision,
      override: overrideRevision,
    }),
  });
}
