import type {
  PackageErrorCode,
  PackageExpertCreatedDTO,
  PackageExpertCreateInput,
  PackageGrantDTO,
  PackageGrantInput,
  PackageGrantResource,
  PackageGrantRevokeInput,
  PackageInstallDetailDTO,
  PackageInstallDTO,
  PackageListQuery,
  PackageOperation,
  PackagePage,
  PackagePlanDTO,
  PackagePlanInput,
  PackageResourceKind,
} from "../../../../shared/enterprise/plugin-package-contracts";
import type { PlatformScope } from "../contracts";
import type { OperatorDatabase } from "../tenancy/connections";
import type { CompanyAdminContext } from "../tenancy/workspace-admin";

/**
 * PKG02 server-internal contract: the read/mutation seams, the write
 * transaction that is only issued by `PackageMutationStore.transaction`, and
 * the closed error vocabulary the HTTP layer maps to statuses.
 *
 * Nothing here exports a secret, a transport, a filesystem path, or a way to
 * write outside `PackageWriteTx`; the write handle is branded and checked on
 * every mutation entry point.
 */

export type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/** Closed error vocabulary; the message is exactly the wire code. */
export class PackageServiceError extends Error {
  constructor(readonly code: PackageErrorCode) {
    super(code);
    this.name = "PackageServiceError";
  }
}

export function packageError(code: PackageErrorCode): PackageServiceError {
  return new PackageServiceError(code);
}

export function packageErrorCodeOf(error: unknown): PackageErrorCode | null {
  if (error instanceof PackageServiceError) return error.code;
  return null;
}

/**
 * SQLSTATE classes that mean the database itself failed, not the request:
 * 08 connection, 40 transaction rollback, 53 insufficient resources,
 * 57 operator intervention, 58 system, XX internal. Integrity violations
 * (23xxx) and permission errors (42501) are product verdicts and stay out.
 */
const STORAGE_SQLSTATE_CLASS = /^(?:08|40|53|57|58|XX)/;

/**
 * Whether a throw is a driver-level storage failure that the HTTP layer must
 * answer 503 `PACKAGE_STORAGE_UNAVAILABLE` for. Recognised by the Postgres
 * error shape drizzle wraps as `cause` (Bun puts the SQLSTATE in `errno`,
 * node-style drivers in `code`), never by message text — an unexpected
 * statement error is still `INTERNAL`.
 */
export function isPackageStorageFailure(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    const driver = current as Error & {
      name?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    if (driver.name !== "PostgresError") continue;
    for (const value of [driver.errno, driver.code]) {
      if (
        typeof value === "string" &&
        /^[0-9A-Z]{5}$/.test(value) &&
        STORAGE_SQLSTATE_CLASS.test(value)
      ) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Read facts (restricted data role, real RLS)
// ---------------------------------------------------------------------------

export interface PackageResourceLinkFact {
  readonly resourceId: string;
  readonly kind: PackageResourceKind;
  readonly connectorInstallId: string | null;
  readonly existingSkillId: string | null;
  readonly expertTemplateRef: string | null;
}

/**
 * PKG03A active-grant facts for one Bot of one install: `revision` is the
 * count of distinct grant generations for the pair (the CAS counter), and
 * `resources` lists only rows whose `revoked_at` is null.
 */
export interface PackageGrantFact {
  readonly botId: string;
  readonly revision: number;
  readonly resources: readonly PackageGrantResource[];
}

/** Redacted install facts: no config, no envelope, no other team's rows. */
export interface PackageInstallFacts {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly installId: string;
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly revision: number;
  readonly generation: number;
  readonly status: PackageInstallDTO["status"];
  readonly links: readonly PackageResourceLinkFact[];
  readonly grants: readonly PackageGrantFact[];
}

export interface PackageReadStore {
  /** Current scope's installs only (tenant + workspace arm). */
  listInstalls(scope: PlatformScope): Promise<readonly PackageInstallFacts[]>;
  /** Cross-scope and unknown both resolve to null (identical 404 upstream). */
  getInstall(
    scope: PlatformScope,
    installId: string,
  ): Promise<PackageInstallFacts | null>;
}

// ---------------------------------------------------------------------------
// Mutation seam (restricted operator role; admin revalidated per transaction)
// ---------------------------------------------------------------------------

/**
 * The only handle that can write package install facts. It is issued solely by
 * `PackageMutationStore.transaction` after admin/membership revalidation, and
 * every writer asserts its provenance before touching `db`.
 */
export interface PackageWriteTx {
  readonly db: OperatorTransaction;
}

const issuedWriteTransactions = new WeakSet<object>();

/** Register a freshly issued write handle (called only by the mutation store). */
export function markPackageWriteTx(tx: PackageWriteTx): void {
  issuedWriteTransactions.add(tx);
}

export function assertPackageWriteTx(tx: PackageWriteTx): void {
  if (!tx || typeof tx !== "object" || !issuedWriteTransactions.has(tx)) {
    throw new Error("UNVERIFIED_PACKAGE_WRITE_TX");
  }
}

export interface PackagePlanRecord {
  readonly planId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly operation: PackageOperation;
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly expectedRevision: number | null;
  readonly canonicalInput: Record<string, unknown>;
  readonly inputDigest: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly result: unknown;
}

export interface PackageMutationStore {
  /**
   * Opens one operator transaction, pins the transaction-local context, takes
   * the canonical exclusive locks (tenant → principal → membership →
   * workspace-membership) and revalidates `tenant_admin`, epoch, principal and
   * team membership before issuing the write handle.
   */
  transaction<T>(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    fn: (tx: PackageWriteTx) => Promise<T>,
  ): Promise<T>;
  /** Short read-only operator transaction: the plan's own scope facts. */
  readPlan(
    scope: PlatformScope,
    planId: string,
  ): Promise<PackagePlanRecord | null>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface PackageApplyResult {
  readonly install: PackageInstallDTO;
  /** True only when this call created the install (HTTP 201). */
  readonly created: boolean;
}

/**
 * PKG03A grant mutation result: first write of a grant generation answers
 * `created: true` (HTTP 201); an idempotency-key replay or a no-op revoke
 * returns the stored/current grant with `created: false` (HTTP 200).
 */
export interface PackageGrantMutationResult {
  readonly grant: PackageGrantDTO;
  readonly created: boolean;
}

/**
 * PKG04A expert instantiation result: the first creation answers
 * `created: true` (HTTP 201); an idempotency-key replay returns the SAME
 * stored agentId with `created: false` (HTTP 200).
 */
export interface PackageExpertMutationResult {
  readonly expert: PackageExpertCreatedDTO;
  readonly created: boolean;
}

export interface PackageService {
  list(scope: PlatformScope, query: PackageListQuery): Promise<PackagePage>;
  get(
    scope: PlatformScope,
    installId: string,
  ): Promise<PackageInstallDetailDTO>;
  plan(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackagePlanInput,
  ): Promise<PackagePlanDTO>;
  apply(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    planId: string,
    idempotencyKey: string,
  ): Promise<PackageApplyResult>;
  /** PUT /installs/:id/bots/:botId/grants (tenant_admin, Idempotency-Key). */
  setBotGrant(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackageGrantInput,
    idempotencyKey: string,
  ): Promise<PackageGrantMutationResult>;
  /** DELETE /installs/:id/bots/:botId/grants (tenant_admin, Idempotency-Key). */
  revokeBotGrant(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackageGrantRevokeInput,
    idempotencyKey: string,
  ): Promise<PackageGrantMutationResult>;
  /**
   * POST /installs/:id/experts/:resourceId (tenant_admin, Idempotency-Key).
   * Creates a scoped Bot from the installed revision's expert template:
   * profile + ownership + provenance + initial Skill grant commit in ONE
   * operator transaction; replay with the same (actor, key) returns the same
   * agentId.
   */
  instantiateExpert(
    scope: PlatformScope,
    admin: CompanyAdminContext,
    input: PackageExpertCreateInput,
    idempotencyKey: string,
  ): Promise<PackageExpertMutationResult>;
}

/** Injected clock; tests advance it to exercise the 10-minute expiry. */
export type PackageClock = () => Date;
