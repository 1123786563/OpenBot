/**
 * Shared MT042 fixture (Issue #85, platform scan scope rebuild).
 *
 * Wraps the verified MT041 job-ownership fixture (companies A/B, §11 identity
 * matrix, restricted-role connections, real config service) and adds the
 * platform-scan seams:
 *   - the platform work-queue connection (work_items lives in the same
 *     dedicated enterprise test database, provisioned by the base migration);
 *   - a schedule-entrypoint scope issuer over the REAL scope resolver
 *     (`createScopeResolver` — the only issuance entry; trust marking happens
 *     inside, so the rebuilt scope is a genuinely issued scope, never a
 *     hand-built one);
 *   - the MT005 workspace gate over the verified data channel;
 *   - real membership suspension helpers (company via provision.suspendMembership,
 *     team via the operator channel's column-level UPDATE grant).
 * Nothing here mocks the authorization path.
 */

import { and, eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { jobLeases } from "../../../src/db/schema/job-ownership";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createJobOwnershipService,
  type JobOwnershipService,
} from "../../../src/enterprise/tenancy/job-ownership";
import { createWorkspaceGate } from "../../../src/enterprise/tenancy/scope-gate";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import { createWorkQueue, type WorkQueue } from "../../../src/work/queue";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import type { FixtureIdentity, TeamKey } from "./fixture";
import {
  createJobOwnershipFixture,
  type JobCompanyKey,
  type JobOwnershipFixture,
  type JobTeamKey,
  jobObjectId,
} from "./job-ownership";

export interface ScanFixture {
  readonly jobs: JobOwnershipFixture;
  readonly service: JobOwnershipService;
  /** Platform connection over work_items (the durable work queue). */
  readonly platform: Database;
  readonly queue: WorkQueue;
  readonly gate: ReturnType<typeof createWorkspaceGate>;
  /**
   * Issues a trusted PlatformScope through the REAL scope resolver with the
   * "schedule" entrypoint — the issuance entry is the only place a scope can
   * come from (AC4); the scan executor receives this seam, never a scope.
   */
  issueScheduleScope(facts: {
    actorId: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<PlatformScope>;
  /** Real company-level membership suspension (provision.suspendMembership). */
  suspendCompanyMembership(
    identity: FixtureIdentity,
    tenantId: string,
  ): Promise<{ changed: boolean; epoch: number }>;
  /** Real team-level suspension via the operator channel's column grant. */
  suspendTeamMembership(input: {
    tenantId: string;
    workspaceId: string;
    principalId: string;
  }): Promise<void>;
  /** The live lease row for a job, if any (assertion channel, superuser). */
  leaseRowOf(
    jobKind: string,
    objectId: string,
  ): Promise<
    | {
        tenantId: string;
        workspaceId: string;
        claimedByKind: string | null;
        claimedBy: string | null;
        attempts: number;
        finishedAt: Date | null;
      }
    | undefined
  >;
  /** Fresh business-object id namespaced by this fixture instance. */
  objectId(label: string): string;
  /**
   * Closes every unfinished scan-queue row left by earlier runs of this suite
   * (the work queue is shared and durable across runs; a stale row's pin is
   * gone, so the only honest end for it is a finished marker, not a retry).
   */
  drainScanQueue(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createScanExecutorFixture(): Promise<ScanFixture> {
  const jobs = await createJobOwnershipFixture();
  const service = createJobOwnershipService(jobs.operator, jobs.data);
  const platform = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 2,
  }) as Database;
  const queue = createWorkQueue(platform);
  const gate = createWorkspaceGate(jobs.data);

  // The real issuance entry over the verified directory connection; the scan
  // path resolves scopes with the "schedule" entrypoint (PlatformScope's
  // scheduled-execution entrance). Sessions bind server-side (WeakMap);
  // selectors come from the caller (the executor passes authoritative-record
  // facts, never queue-message fields).
  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string; workspaceId: string }
  >();
  const resolver = createScopeResolver(jobs.directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "schedule" };
    },
    selectTenant: (request) => sessions.get(request)?.tenantId,
    selectWorkspace: (request) => sessions.get(request)?.workspaceId,
  });

  return {
    jobs,
    service,
    platform,
    queue,
    gate,

    async issueScheduleScope(facts) {
      const request = new Request("https://tests.invalid/mt042-scan-scope");
      sessions.set(request, {
        userId: facts.actorId,
        tenantId: facts.tenantId,
        workspaceId: facts.workspaceId,
      });
      return resolver.resolve(request);
    },

    async suspendCompanyMembership(identity, tenantId) {
      return jobs.isolation.suspendCompanyMembership(identity, tenantId);
    },

    async suspendTeamMembership({ tenantId, workspaceId, principalId }) {
      await jobs.operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${principalId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
        );
        await tx.execute(
          sql`update enterprise_workspace_memberships set status = 'suspended', epoch = epoch + 1 where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and principal_id = ${principalId}`,
        );
      });
    },

    async leaseRowOf(jobKind, objectId) {
      const [row] = await platform
        .select({
          tenantId: jobLeases.tenantId,
          workspaceId: jobLeases.workspaceId,
          claimedByKind: jobLeases.claimedByKind,
          claimedBy: jobLeases.claimedBy,
          attempts: jobLeases.attempts,
          finishedAt: jobLeases.finishedAt,
        })
        .from(jobLeases)
        .where(
          and(eq(jobLeases.kind, jobKind), eq(jobLeases.objectId, objectId)),
        )
        .limit(1);
      return row;
    },

    objectId(label) {
      return jobObjectId(jobs, label);
    },

    async drainScanQueue() {
      await platform.execute(
        sql`update "work_items" set "finished_at" = now(), "claimed_by" = null, "lease_until" = null, "updated_at" = now() where "kind" = 'enterprise.job.due' and "finished_at" is null`,
      );
    },

    async dispose() {
      const failures: unknown[] = [];
      try {
        await platform.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await jobs.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Scan fixture disposal failed.");
      }
    },
  };
}

export type { FixtureIdentity, JobCompanyKey, JobTeamKey, TeamKey };
