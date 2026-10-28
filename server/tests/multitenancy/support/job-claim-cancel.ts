/**
 * Shared MT043 fixture (Issue #86, job claim / retry / cancel ownership).
 *
 * Builds on the MT041 job-ownership fixture (real isolation matrix, real scope
 * resolver, restricted-role channels) and adds exactly what this ticket's
 * acceptance needs:
 *   - the real MT041 job service (pin / claim / renew / release) for the
 *     claim-and-lease lifecycle around every control action;
 *   - the real MT016 bot ownership service over the SAME channels, so a run job
 *     and its execution-side bot live in one tenant/workspace for AC3;
 *   - a setup (superuser) channel for deterministic lease backdating in the
 *     AC4 race and for raw row reads that assert state the services report;
 *   - a wide restricted operator pool so concurrent claims race on real
 *     separate connections instead of a serialized pool of two.
 * Nothing here mocks the authorization path.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  createBotOwnershipService,
  type BotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  verifyOperatorDatabase,
  type OperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createJobOwnershipService,
  type JobOwnershipService,
  type JobRef,
} from "../../../src/enterprise/tenancy/job-ownership";
import {
  createJobOwnershipFixture,
  type JobOwnershipFixture,
} from "./job-ownership";
import { enterpriseRuntimeDatabaseUrlFrom } from "../../support/enterprise-database";

export interface JobClaimCancelFixture {
  readonly jobs: JobOwnershipFixture;
  /** The real MT041 service bound to the fixture's verified channels. */
  readonly service: JobOwnershipService;
  /** The real MT016 bot ownership service over the same channels (AC3 plants). */
  readonly bots: BotOwnershipService;
  /** Superuser channel: deterministic lease backdating + raw row reads. */
  readonly setup: Database;
  /** A dedicated operator pool with `width` connections (AC4 real races). */
  raceServices(width: number): Promise<JobOwnershipService[]>;
  /** Backdates a job's live lease so the next claim race is a reclaim race. */
  backdateLease(ref: JobRef, ms: number): Promise<void>;
  /** Raw lease row (superuser; state the services must not misreport). */
  readLeaseRaw(
    ref: JobRef,
  ): Promise<{
    claimedByKind: string | null;
    claimedBy: string | null;
    leaseUntil: Date | null;
    finishedAt: Date | null;
    lastError: string | null;
    attempts: number;
  } | null>;
  /** Raw ownership row (superuser; the three invariants of AC2). */
  readOwnershipRaw(
    ref: JobRef,
  ): Promise<{
    tenantId: string;
    workspaceId: string;
    principalId: string;
  } | null>;
  /** Creation snapshot count + every execution snapshot (AC2 evidence). */
  readSnapshotsRaw(ref: JobRef): Promise<{
    creation: {
      companyRevision: number;
      overrideRevision: number | null;
      basisDigest: string;
    } | null;
    executions: {
      companyRevision: number;
      overrideRevision: number | null;
      basisDigest: string;
    }[];
  }>;
  dispose(): Promise<void>;
}

export async function createJobClaimCancelFixture(): Promise<JobClaimCancelFixture> {
  const jobs = await createJobOwnershipFixture();
  const service = createJobOwnershipService(jobs.operator, jobs.data);
  const bots = createBotOwnershipService({
    data: jobs.data,
    operator: jobs.operator,
  });
  const setup = createDatabase(process.env.TEST_DATABASE_URL ?? "", { max: 2 });
  const raceCloseables: Array<{ close(): void | Promise<void> }> = [];

  /** execute() result rows: drizzle returns either a row array or { rows }. */
  const rowsOf = (
    result: unknown,
  ): readonly Record<string, unknown>[] => {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    const rows = (result as { rows?: Record<string, unknown>[] }).rows;
    // An unrecognised driver shape must not masquerade as "no rows".
    if (rows === undefined) {
      throw new Error("UNRECOGNISED_DRIVER_RESULT_SHAPE");
    }
    return rows;
  };

  const fixture: JobClaimCancelFixture = {
    jobs,
    service,
    bots,
    setup,
    async raceServices(width: number) {
      const pool = (await verifyOperatorDatabase(
        createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator", process.env), {
          max: width,
        }),
      )) as unknown as OperatorDatabase;
      const client = (pool as unknown as { $client: { close(): void } }).$client;
      raceCloseables.push(client);
      return Array.from({ length: width }, () =>
        createJobOwnershipService(pool, jobs.data),
      );
    },
    async backdateLease(ref, ms) {
      const updated = (await setup.execute(
        sql`update job_leases set lease_until = now() - make_interval(secs => ${ms / 1000}) where kind = ${ref.kind} and object_id = ${ref.objectId} returning 1`,
      )) as unknown;
      // 0 affected rows means the ref did not match (job not pinned, kind or
      // objectId misspelled) and the reclaim-race case would race nothing.
      const updatedRows = Array.isArray(updated)
        ? updated
        : ((updated as { rows?: unknown[] })?.rows ?? []);
      if (updatedRows.length !== 1) {
        throw new Error(
          `LEASE_BACKDATE_MISSED:${ref.kind}:${ref.objectId}:${updatedRows.length}`,
        );
      }
    },
    async readLeaseRaw(ref) {
      const row = rowsOf(
        await setup.execute(
          sql`select claimed_by_kind, claimed_by, lease_until, finished_at, last_error, attempts from job_leases where kind = ${ref.kind} and object_id = ${ref.objectId}`,
        ),
      )[0] as
        | {
            claimed_by_kind: string | null;
            claimed_by: string | null;
            lease_until: Date | null;
            finished_at: Date | null;
            last_error: string | null;
            attempts: number;
          }
        | undefined;
      return row
        ? {
            claimedByKind: row.claimed_by_kind,
            claimedBy: row.claimed_by,
            leaseUntil: row.lease_until,
            finishedAt: row.finished_at,
            lastError: row.last_error,
            attempts: row.attempts,
          }
        : null;
    },
    async readOwnershipRaw(ref) {
      const row = rowsOf(
        await setup.execute(
          sql`select tenant_id, workspace_id, principal_id from job_ownership where kind = ${ref.kind} and object_id = ${ref.objectId}`,
        ),
      )[0] as
        | { tenant_id: string; workspace_id: string; principal_id: string }
        | undefined;
      return row
        ? {
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            principalId: row.principal_id,
          }
        : null;
    },
    async readSnapshotsRaw(ref) {
      const list = rowsOf(
        await setup.execute(
          sql`select purpose, company_revision, override_revision, basis_digest from job_config_snapshots where kind = ${ref.kind} and object_id = ${ref.objectId} order by captured_at asc, id asc`,
        ),
      ).map((row) => ({
        purpose: String(row.purpose),
        companyRevision: Number(row.company_revision),
        overrideRevision:
          row.override_revision === null
            ? null
            : Number(row.override_revision),
        basisDigest: String(row.basis_digest),
      }));
      const creation = list.find((row) => row.purpose === "creation") ?? null;
      return {
        creation: creation && {
          companyRevision: creation.companyRevision,
          overrideRevision: creation.overrideRevision,
          basisDigest: creation.basisDigest,
        },
        executions: list
          .filter((row) => row.purpose === "execution")
          .map((row) => ({
            companyRevision: row.companyRevision,
            overrideRevision: row.overrideRevision,
            basisDigest: row.basisDigest,
          })),
      };
    },
    async dispose() {
      const failures: unknown[] = [];
      for (const closeable of raceCloseables.reverse()) {
        try {
          await closeable.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await setup.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await jobs.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Job claim/cancel fixture disposal failed.",
        );
      }
    },
  };
  return fixture;
}
