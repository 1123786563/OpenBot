/*
 * authority-matrix — the legacy/paused/ba fixture of interfaces §3.3
 * (T02.10 / #532, original task P04; expanded by P25 with the M0–M3 migration
 * states).
 *
 * The point of the matrix is that the SAME behaviour is asserted under each
 * real database state of the migration, not against a stub authority: a
 * scenario writes the persisted AuthorityState row (phase, directory
 * authority, CAS version, release flag), opens a real directory transaction,
 * and hands the caller the production `DirectoryAuthority` reading that
 * transaction. A branch that silently falls back — legacy writes under a
 * paused company, BA writes before M4, release mistaken for authority — shows
 * up as a difference between scenarios rather than as one green path.
 *
 * This base version deliberately depends on nothing but the authority table
 * itself (a plain UPDATE through the fixture port), so it can run before and
 * without the P25 migration CLI. P25 extends the scenario list, not the shape:
 * `withAuthorityMatrix(fixture, scenario, scenarios?)` already takes the list.
 *
 * The fixture port is intentionally two methods wide:
 * - `setAuthorityState` establishes one scenario's row (the test owns the
 *   connection; production never calls this outside the M4 CAS);
 * - `inDirectoryTransaction` runs the scenario inside a real transaction of
 *   the caller's database, which is the only place the authority may be read.
 */

import {
  AUTHORITY_PHASES,
  type AuthorityPhase,
  type AuthorityState,
  type AuthorityWriter,
  createDirectoryAuthority,
  DIRECTORY_AUTHORITY_MODES,
  type DirectoryAuthorityMode,
  type VerifiedDirectoryAuthority,
} from "../../../src/auth/directory/authority";
import type {
  DirectoryTx,
  Version,
} from "../../../src/auth/directory/contracts";

/** The singleton row as a scenario establishes it. */
export interface AuthorityMatrixState {
  readonly authorityVersion: Version;
  readonly phase: AuthorityPhase;
  readonly directoryAuthority: DirectoryAuthorityMode;
  readonly multiTenantReleased: boolean;
}

/** What a scenario needs from its database: write the row, run in a transaction. */
export interface AuthorityMatrixFixture {
  setAuthorityState(state: AuthorityMatrixState): Promise<void>;
  inDirectoryTransaction<T>(work: (tx: DirectoryTx) => Promise<T>): Promise<T>;
}

/** One migration state under which the same authority behaviour is asserted. */
export interface AuthorityMatrixScenario extends AuthorityMatrixState {
  readonly name: "legacy" | "paused" | "ba";
  /**
   * The writer this scenario's branch must accept, or `null` when the branch
   * accepts none (M2/M3 pause every directory write, including the BA one).
   */
  readonly expectedWriter: AuthorityWriter | null;
}

/**
 * The three states T02.10 must cover. The versions are deliberately distinct
 * and non-zero, so a scenario that reuses another scenario's row fails its own
 * CAS comparison instead of passing by coincidence; the BA scenario also opens
 * the release gate, because that must not change its authority.
 */
export const AUTHORITY_MATRIX_SCENARIOS: readonly AuthorityMatrixScenario[] =
  Object.freeze([
    Object.freeze({
      name: "legacy",
      authorityVersion: 3,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
      expectedWriter: "legacy",
    }),
    Object.freeze({
      name: "paused",
      authorityVersion: 7,
      phase: "M2",
      directoryAuthority: "paused",
      multiTenantReleased: false,
      expectedWriter: null,
    }),
    Object.freeze({
      name: "ba",
      authorityVersion: 11,
      phase: "M4",
      directoryAuthority: "ba",
      multiTenantReleased: true,
      expectedWriter: "ba",
    }),
  ] satisfies AuthorityMatrixScenario[]);

/**
 * The migration-state scenarios of the original P25 tooling slices (T02.15 /
 * #537): every phase the offline tools sit between — M0 through M3 — plus the
 * M4 those tools must refuse to perform. The three authority modes of the
 * base list stay the coverage requirement (legacy/paused/ba); what this list
 * adds is one scenario per migration phase, so a tool's authority handling is
 * asserted against the exact persisted state it will meet on a real target
 * (the M3 verify window is `paused` at phase M3, not just "paused"), and a
 * legacy tool run at M0 versus M1 is two different database facts. The
 * versions are distinct from the base list's and from each other, so a
 * scenario that reuses another's row still fails its own CAS comparison.
 */
export const MIGRATION_STATE_SCENARIOS: readonly AuthorityMatrixScenario[] =
  Object.freeze([
    Object.freeze({
      name: "legacy",
      authorityVersion: 17,
      phase: "M0",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
      expectedWriter: "legacy",
    }),
    Object.freeze({
      name: "legacy",
      authorityVersion: 19,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
      expectedWriter: "legacy",
    }),
    Object.freeze({
      name: "paused",
      authorityVersion: 23,
      phase: "M2",
      directoryAuthority: "paused",
      multiTenantReleased: false,
      expectedWriter: null,
    }),
    Object.freeze({
      name: "paused",
      authorityVersion: 29,
      phase: "M3",
      directoryAuthority: "paused",
      multiTenantReleased: false,
      expectedWriter: null,
    }),
    Object.freeze({
      name: "ba",
      authorityVersion: 31,
      phase: "M4",
      directoryAuthority: "ba",
      multiTenantReleased: true,
      expectedWriter: "ba",
    }),
  ] satisfies AuthorityMatrixScenario[]);

/** What one scenario callback receives. */
export interface AuthorityMatrixContext {
  readonly authority: VerifiedDirectoryAuthority;
  /** The state read back inside this scenario's transaction. */
  readonly state: AuthorityState;
  readonly tx: DirectoryTx;
  readonly scenario: AuthorityMatrixScenario;
}

function stateOf(scenario: AuthorityMatrixScenario): AuthorityMatrixState {
  return {
    authorityVersion: scenario.authorityVersion,
    phase: scenario.phase,
    directoryAuthority: scenario.directoryAuthority,
    multiTenantReleased: scenario.multiTenantReleased,
  };
}

/** The database CHECKs' closed domains, asserted here before any write. */
function assertScenarioShape(scenario: AuthorityMatrixScenario): void {
  if (!AUTHORITY_PHASES.includes(scenario.phase)) {
    throw new Error(
      `authority matrix scenario "${scenario.name}" names phase "${scenario.phase}", which is not one of ${AUTHORITY_PHASES.join("/")}`,
    );
  }
  if (!DIRECTORY_AUTHORITY_MODES.includes(scenario.directoryAuthority)) {
    throw new Error(
      `authority matrix scenario "${scenario.name}" names directory authority "${scenario.directoryAuthority}", which is not one of ${DIRECTORY_AUTHORITY_MODES.join("/")}`,
    );
  }
  if (
    typeof scenario.authorityVersion !== "number" ||
    !Number.isSafeInteger(scenario.authorityVersion) ||
    scenario.authorityVersion < 0
  ) {
    throw new Error(
      `authority matrix scenario "${scenario.name}" names a version outside the Version domain`,
    );
  }
}

/**
 * Run one callback under every scenario, resetting the persisted row each
 * time. A scenario that does not actually end up reading the state it asked
 * for fails immediately — a silently wrong fixture would otherwise assert the
 * right branch against the wrong database fact.
 */
export async function withAuthorityMatrix(
  fixture: AuthorityMatrixFixture,
  scenario: (context: AuthorityMatrixContext) => Promise<void>,
  scenarios: readonly AuthorityMatrixScenario[] = AUTHORITY_MATRIX_SCENARIOS,
): Promise<void> {
  for (const current of scenarios) {
    assertScenarioShape(current);
    await fixture.setAuthorityState(stateOf(current));
    await fixture.inDirectoryTransaction(async (tx) => {
      const authority = createDirectoryAuthority();
      const state = await authority.read(tx);
      const expected = stateOf(current);
      for (const key of [
        "authorityVersion",
        "phase",
        "directoryAuthority",
        "multiTenantReleased",
      ] as const) {
        if (state[key] !== expected[key]) {
          throw new Error(
            `authority matrix scenario "${current.name}" established ${key}=${String(expected[key])} but the transaction read ${String(state[key])}; refusing to assert a branch against a row nobody wrote`,
          );
        }
      }
      await scenario({ authority, state, tx, scenario: current });
    });
  }
}
