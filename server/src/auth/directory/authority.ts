/*
 * The interim directory authority (T02.10 / #532, original task P04; design
 * §13.2, interfaces §3.3).
 *
 * One persisted AuthorityState row — seeded by the T02.03 expand migration at
 * the M1 milestone — decides who may write the directory, and it is read
 * inside the caller's own transaction so a command compares the state it will
 * commit against, never a snapshot from another connection. Three branches,
 * fixed by the migration state machine:
 *
 * - M0/M1 (`legacy`): the original legacy gate and writers keep working. This
 *   branch deliberately reads nothing else — no BA clock, no relationship row,
 *   no proof — so an existing tenant with empty BA tables is not refused by a
 *   migration it has not reached.
 * - M2/M3 (`paused`): every directory write is refused with 503
 *   DIRECTORY_MIGRATION_PAUSED and the migration actor backfills offline.
 * - M4..M7 (`ba`): only the Better Auth writer may write; the legacy writer's
 *   rights are collected at the M4 CAS.
 *
 * A missing state is never guessed as legacy, an unreadable/inconsistent one
 * is never mapped onto a branch, and a version mismatch is never retried with
 * a fresh read: all three refuse as infrastructure-shaped 503, the "no
 * fallback" rule of interfaces §3.3.
 *
 * The write gate and the multi-tenant release gate are INDEPENDENT, which is
 * why they are separate methods over the same row: the release gate (M5/M6)
 * never selects the authority, and the authority CAS (M4) never releases.
 * `requireRelease` therefore ignores phase and directoryAuthority entirely,
 * and `requireWrite` ignores `multiTenantReleased` entirely.
 *
 * What this module does NOT own: the DirectoryReadGate (T02.11 / read-gate.ts,
 * interfaces §3.3), the executor's finalizer (T02.08) and any route or
 * configuration wiring. It also performs no DML — advancing the row is the M4
 * switch's transaction (T08/P22), not a side effect of a read.
 */

import { eq } from "drizzle-orm";
import { authAuthorityStates } from "../../db/schema";
import type { DirectoryTx, Version } from "./contracts";

/** The migration state machine's closed phase domain (interfaces §3.3). */
export const AUTHORITY_PHASES = [
  "M0",
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
] as const;

export type AuthorityPhase = (typeof AUTHORITY_PHASES)[number];

/** Who currently owns directory writes (interfaces §3.3). */
export const DIRECTORY_AUTHORITY_MODES = ["legacy", "paused", "ba"] as const;

export type DirectoryAuthorityMode = (typeof DIRECTORY_AUTHORITY_MODES)[number];

/** The two writers a directory command can run as. */
export const DIRECTORY_WRITERS = ["legacy", "ba"] as const;

export type AuthorityWriter = (typeof DIRECTORY_WRITERS)[number];

/**
 * The persistent AuthorityState of interfaces §3.3. `authorityVersion` is the
 * CAS counter every directory/identity final write compares; `phase` and
 * `directoryAuthority` are the closed, mutually consistent pair the database
 * CHECKs pin; `multiTenantReleased` is the independent release gate's fact.
 */
export type AuthorityState = Readonly<{
  authorityVersion: Version;
  phase: AuthorityPhase;
  directoryAuthority: DirectoryAuthorityMode;
  multiTenantReleased: boolean;
}>;

/**
 * The write-authority half of interfaces §3.3. `read` is the only state read;
 * `requireWrite` is the pre-DML gate: it compares the caller's expected
 * version, then decides by the persisted branch. Both run on the caller's
 * transaction, so the state a command verifies is the state its commit races
 * with.
 */
export interface DirectoryAuthority {
  read(tx: DirectoryTx): Promise<AuthorityState>;
  requireWrite(
    tx: DirectoryTx,
    expectedVersion: Version,
    writer: AuthorityWriter,
  ): Promise<void>;
}

/**
 * The release gate of design §13.2, deliberately a separate contract: it
 * answers "is multi-tenant release open at this version", and never selects
 * or implies a directory authority.
 */
export interface MultiTenantReleaseGate {
  requireRelease(tx: DirectoryTx, expectedVersion: Version): Promise<void>;
}

export type VerifiedDirectoryAuthority = DirectoryAuthority &
  MultiTenantReleaseGate;

/*
 * Stable refusal codes. Every one of them is a 503 in the HTTP projection of
 * interfaces §3.3/§4: an authority the server cannot prove is an
 * infrastructure answer, never a 4xx that a client could retry into a
 * different branch, and never a silent legacy fallback.
 */

/** No singleton row: the migration has not seeded M1, or the row was removed. */
export const AUTHORITY_STATE_MISSING = "AUTHORITY_STATE_MISSING";
/** A row whose phase/authority pair or release flag is not a known value. */
export const AUTHORITY_STATE_UNKNOWN = "AUTHORITY_STATE_UNKNOWN";
/** A version outside the non-negative safe-integer `Version` domain. */
export const AUTHORITY_VERSION_UNSAFE = "AUTHORITY_VERSION_UNSAFE";
/** The state was read outside a transaction (a pool snapshot, not a command). */
export const AUTHORITY_STATE_WITHOUT_TRANSACTION =
  "AUTHORITY_STATE_WITHOUT_TRANSACTION";
/** The caller's expected version is not the persisted one (CAS conflict). */
export const AUTHORITY_VERSION_CONFLICT = "AUTHORITY_VERSION_CONFLICT";
/** M2/M3: directory writes are paused for the offline backfill. */
export const DIRECTORY_MIGRATION_PAUSED = "DIRECTORY_MIGRATION_PAUSED";
/** The writer named by the caller does not own writes in this branch. */
export const DIRECTORY_WRITE_AUTHORITY_CLOSED =
  "DIRECTORY_WRITE_AUTHORITY_CLOSED";
/** The release gate is closed at the caller's version. */
export const MULTI_TENANT_NOT_RELEASED = "MULTI_TENANT_NOT_RELEASED";

/**
 * An authority refusal. The status is fixed at 503 for every code above: the
 * caller cannot tell "paused" from "missing" by retrying, and no code path
 * here turns a refusal into an allow.
 */
export class AuthorityRefusal extends Error {
  readonly status = 503;

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AuthorityRefusal";
  }
}

export function isAuthorityRefusal(error: unknown): error is AuthorityRefusal {
  return error instanceof AuthorityRefusal;
}

/**
 * The factory. There is nothing to inject yet — the state is a database fact
 * read through the caller's transaction — but the seam exists so the M0–M3
 * migration tools (P25) can hand in their own reader without a second
 * authority implementation.
 */
export function createDirectoryAuthority(): VerifiedDirectoryAuthority {
  return Object.freeze({
    read,
    requireWrite,
    requireRelease,
  });
}

/** The singleton row's fixed primary key (the schema's singleton CHECK). */
const AUTHORITY_ROW_ID = 1;

/** The one row the gates read, in the caller's transaction. */
interface AuthorityRow {
  authorityVersion: Version;
  phase: string;
  directoryAuthority: string;
  multiTenantReleased: boolean;
}

function refuse(code: string, detail: string): AuthorityRefusal {
  return new AuthorityRefusal(code, detail);
}

/** A `Version` is a non-negative safe integer; overflow is refused, not wrapped. */
function requireVersion(
  value: unknown,
  field: string,
): asserts value is Version {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw refuse(
      AUTHORITY_VERSION_UNSAFE,
      `${field} must be a non-negative safe integer (Version); refusing rather than wrapping or coercing`,
    );
  }
}

/**
 * The row is only authoritative when the phase and the authority are a pair
 * the migration state machine can produce (M0/M1 legacy, M2/M3 paused,
 * M4..M7 ba). A row outside that relation is a state the server cannot
 * explain, which is a refusal — never the nearest branch.
 */
function phaseOwnsAuthority(
  phase: AuthorityPhase,
  authority: DirectoryAuthorityMode,
): boolean {
  switch (phase) {
    case "M0":
    case "M1":
      return authority === "legacy";
    case "M2":
    case "M3":
      return authority === "paused";
    case "M4":
    case "M5":
    case "M6":
    case "M7":
      return authority === "ba";
  }
}

function parseState(row: AuthorityRow): AuthorityState {
  requireVersion(
    row.authorityVersion,
    "auth_authority_states.authority_version",
  );
  const phase = row.phase as AuthorityPhase;
  if (!AUTHORITY_PHASES.includes(phase)) {
    throw refuse(
      AUTHORITY_STATE_UNKNOWN,
      `auth_authority_states.phase "${row.phase}" is not one of ${AUTHORITY_PHASES.join("/")}`,
    );
  }
  const authority = row.directoryAuthority as DirectoryAuthorityMode;
  if (!DIRECTORY_AUTHORITY_MODES.includes(authority)) {
    throw refuse(
      AUTHORITY_STATE_UNKNOWN,
      `auth_authority_states.directory_authority "${row.directoryAuthority}" is not one of ${DIRECTORY_AUTHORITY_MODES.join("/")}`,
    );
  }
  if (typeof row.multiTenantReleased !== "boolean") {
    throw refuse(
      AUTHORITY_STATE_UNKNOWN,
      "auth_authority_states.multi_tenant_released is not a boolean; the release gate cannot be evaluated",
    );
  }
  if (!phaseOwnsAuthority(phase, authority)) {
    throw refuse(
      AUTHORITY_STATE_UNKNOWN,
      `phase ${phase} paired with directory authority ${authority} is outside the migration state machine; refusing to pick a branch for a state the server cannot explain`,
    );
  }
  return Object.freeze({
    authorityVersion: row.authorityVersion,
    phase,
    directoryAuthority: authority,
    multiTenantReleased: row.multiTenantReleased,
  });
}

/**
 * The read must happen inside the caller's transaction: reading on the pool
 * would compare a committed snapshot with a command that may commit later,
 * which is exactly the race the M4 CAS exists to lose safely. Drizzle's Bun
 * SQL transaction carries `rollback`; a pool handle does not.
 */
function assertDirectoryTransaction(tx: DirectoryTx): void {
  const candidate = tx as unknown as {
    select?: unknown;
    rollback?: unknown;
  };
  if (
    typeof candidate?.select !== "function" ||
    typeof candidate?.rollback !== "function"
  ) {
    throw refuse(
      AUTHORITY_STATE_WITHOUT_TRANSACTION,
      "the AuthorityState must be read with the command's own DirectoryTx; a pool/connection handle outside a transaction is refused",
    );
  }
}

/** Read the singleton AuthorityState in `tx` (interfaces §3.3). */
async function read(tx: DirectoryTx): Promise<AuthorityState> {
  assertDirectoryTransaction(tx);
  const rows = await tx
    .select({
      authorityVersion: authAuthorityStates.authorityVersion,
      phase: authAuthorityStates.phase,
      directoryAuthority: authAuthorityStates.directoryAuthority,
      multiTenantReleased: authAuthorityStates.multiTenantReleased,
    })
    .from(authAuthorityStates)
    .where(eq(authAuthorityStates.id, AUTHORITY_ROW_ID))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // The expand migration seeds this row at M1 precisely so a missing state
    // is never guessed as legacy (T02.03's comment on the table).
    throw refuse(
      AUTHORITY_STATE_MISSING,
      `auth_authority_states has no row ${AUTHORITY_ROW_ID}; a missing AuthorityState is refused for every writer rather than defaulted to legacy`,
    );
  }
  return parseState(row);
}

/**
 * Compare the caller's expected version, then decide by the persisted branch.
 * The version is compared first: a stale command never learns which branch it
 * lost the race to, and a paused branch never hides a CAS conflict.
 */
async function requireWrite(
  tx: DirectoryTx,
  expectedVersion: Version,
  writer: AuthorityWriter,
): Promise<void> {
  requireVersion(expectedVersion, "expectedVersion");
  if (!(DIRECTORY_WRITERS as readonly string[]).includes(writer)) {
    throw refuse(
      DIRECTORY_WRITE_AUTHORITY_CLOSED,
      `writer "${String(writer)}" is not one of ${DIRECTORY_WRITERS.join("/")}`,
    );
  }
  const state = await read(tx);
  if (state.authorityVersion !== expectedVersion) {
    throw refuse(
      AUTHORITY_VERSION_CONFLICT,
      `the command was planned against authority version ${expectedVersion}, but the transaction reads ${state.authorityVersion}; refusing the write instead of re-planning against a state the command did not authorize`,
    );
  }
  switch (state.directoryAuthority) {
    case "legacy":
      if (writer !== "legacy") {
        throw refuse(
          DIRECTORY_WRITE_AUTHORITY_CLOSED,
          `phase ${state.phase} keeps the legacy directory authority; the Better Auth writer is closed until the M4 switch`,
        );
      }
      return;
    case "paused":
      throw refuse(
        DIRECTORY_MIGRATION_PAUSED,
        `phase ${state.phase} pauses directory writes for the offline backfill; every writer, including ${writer}, is refused until the migration advances`,
      );
    case "ba":
      if (writer !== "ba") {
        throw refuse(
          DIRECTORY_WRITE_AUTHORITY_CLOSED,
          `phase ${state.phase} handed directory writes to Better Auth; the legacy writer's rights were collected at the M4 CAS`,
        );
      }
      return;
    default:
      // parseState already refused an unknown mode; this keeps the switch
      // exhaustive for the type checker without inventing a branch.
      throw refuse(
        AUTHORITY_STATE_UNKNOWN,
        `directory authority ${String(state.directoryAuthority)} is not a branch`,
      );
  }
}

/**
 * The independent release gate (design §13.2). It compares the same CAS
 * version but never looks at phase or directoryAuthority: releasing M5/M6
 * must not change who writes the directory, and a directory authority (M4)
 * must not release the product.
 */
async function requireRelease(
  tx: DirectoryTx,
  expectedVersion: Version,
): Promise<void> {
  requireVersion(expectedVersion, "expectedVersion");
  const state = await read(tx);
  if (state.authorityVersion !== expectedVersion) {
    throw refuse(
      AUTHORITY_VERSION_CONFLICT,
      `the release was requested against authority version ${expectedVersion}, but the transaction reads ${state.authorityVersion}; a release never rides a state it was not planned against`,
    );
  }
  if (!state.multiTenantReleased) {
    throw refuse(
      MULTI_TENANT_NOT_RELEASED,
      `multi-tenant release is still closed at authority version ${state.authorityVersion}; the release gate is independent of directory authority and never inferred from it`,
    );
  }
}
