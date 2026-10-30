import {
  bunSuiteEnv,
  bunSuiteSkipReason,
} from "../../scripts/lib/e2e-manifest.mjs";

/*
 * The environment one bun-driven group's subprocess runs with (T01.02).
 *
 * The routing rules themselves live in scripts/lib/e2e-manifest.mjs, next to the
 * grouping they mirror, and are exercised in-process by
 * tests/e2e-manifest-contract.test.ts. This module is the seam the driver
 * (tests/bun-suites.test.ts) and the subprocess contract probes
 * (tests/bun-suite-env.test.ts) share, so what a group actually runs with is
 * exactly what was asserted:
 *
 * - a `server/tests/better-auth:Txx.nn` group runs only on its five required
 *   BA_TEST_* role URLs (mapped into the names the fixture reads), never
 *   inheriting the shared, MT, or job-level URLs — the branch is decided by the
 *   group name and wins over the multitenancy override;
 * - a directory-island group keeps its MT_TEST_DATABASE_URL override.
 */
export interface BunEnvOptions {
  env?: Record<string, string | undefined>;
  directoryIslands?: string[];
}

export function bunEnv(
  groupName: string,
  options: BunEnvOptions = {},
): Record<string, string | undefined> {
  return bunSuiteEnv(groupName, options);
}

export function bunSkipReason(
  groupName: string,
  options: Pick<BunEnvOptions, "env"> = {},
): string | null {
  return bunSuiteSkipReason(groupName, options);
}
