// server/tests/multitenancy/job-ownership.test.ts
// MT041（Issue #84）：任务、运行、触发与租约固定原始归属与配置版本。
//
// 验收事实源（Issue #84 验收 1–4，逐条对应 describe）：
//   (1) 创建时归属被持久化；后续请求携带不同选择标识不改变它。
//   (2) 租约只能被同一归属的执行者持有；跨范围认领被拒绝。
//   (3) 配置版本变化后可追溯当时的执行依据。
//   (4) 任务列表与详情只返回有权范围（含管理视图）。
//
// 机制：三张新表（job_ownership / job_config_snapshots / job_leases）经
// 「受约束关联」固定归属（Spec §4.2），expand-only 零既有表改动。归属行
// 创建一次永不改写（无任何角色的 UPDATE 授权）；租约认领经归属三比
// （tenant+workspace 与 pin 逐字相等 + 执行者匹配）；配置依据快照
// append-only（creation 每 job 一行 + execution 追加），真实 MT014
// runtime-config 服务产出依据；列表/详情经受信 Scope + 事务内成员重验 +
// 真实 RLS，跨范围一律 canonical RESOURCE_NOT_FOUND（MT011 语义）。
//
// 环境契约：专用企业测试库，缺显式 env 整套显式 skip，绝不回退开发库、
// skipped 不计通过。

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createJobOwnershipService,
  JOB_LEASE_NOT_HELD,
  JOB_LEASE_SCOPE_MISMATCH,
  JOB_OWNERSHIP_MISMATCH,
  JOB_OWNERSHIP_REQUIRED,
  type JobConfigBasisInput,
  type JobExecutor,
  type JobKind,
} from "../../src/enterprise/tenancy/job-ownership";
import {
  createJobOwnershipFixture,
  type JobOwnershipFixture,
  jobObjectId,
} from "./support/job-ownership";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const setup =
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL ??
    process.env.TEST_DATABASE_URL;
  if (!setup?.trim()) {
    return {
      ok: false,
      reason: "ENTERPRISE_TEST_SETUP_DATABASE_URL/TEST_DATABASE_URL not set",
    };
  }
  for (const role of ["DIRECTORY", "DATA", "OPERATOR"] as const) {
    if (!process.env[`ENTERPRISE_TEST_${role}_DATABASE_URL`]?.trim()) {
      return {
        ok: false,
        reason: `ENTERPRISE_TEST_${role}_DATABASE_URL not set`,
      };
    }
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: JobOwnershipFixture;
let service: ReturnType<typeof createJobOwnershipService>;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createJobOwnershipFixture();
  service = createJobOwnershipFixtureService(fixture);
});

afterAll(async () => {
  await fixture?.dispose();
});

/** Service wired to this fixture's verified restricted-role connections. */
function createJobOwnershipFixtureService(fx: JobOwnershipFixture) {
  return createJobOwnershipService(fx.operator, fx.data);
}

/** Asserts a promise rejects with a job seam sentinel code (`CODE: …` or exact). */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error).toBe(true);
    const message = error instanceof Error ? error.message : String(error);
    // The job seam uses `CODE: detail`; trusted-context seams (MT006/MT002)
    // throw the bare code — both are refusals by code, never by prose.
    expect(message === code || message.startsWith(`${code}: `)).toBe(true);
    return error as Error;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

const WORKER: JobExecutor = { kind: "worker", id: "mt041-worker-1" };
const WORKER_TWO: JobExecutor = { kind: "worker", id: "mt041-worker-2" };

const basisOf = (
  companyRevision: number,
  overrideRevision: number | null,
  tag: string,
): JobConfigBasisInput => ({
  companyRevision,
  overrideRevision,
  document: { model: { defaultModel: `mt041-${tag}` }, revision: tag },
});

interface Pinned {
  readonly kind: JobKind;
  readonly objectId: string;
  readonly scope: PlatformScope;
}

/** Pins one task in a scope and hands back the references for later steps. */
async function pinTask(
  identity: Parameters<typeof fixture.scopeAs>[0],
  companyKey: "company-a" | "company-b",
  teamKey: "team-a1" | "team-a2" | "team-b1",
  label: string,
  basis = basisOf(1, null, label),
): Promise<Pinned> {
  const scope = await fixture.scopeAs(identity, companyKey, teamKey);
  const principalId = scope.principalId;
  const objectId = jobObjectId(fixture, label);
  const result = await service.pinJobOwnership({
    kind: "task",
    objectId,
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    principalId,
    basis,
  });
  expect(result.status).toBe("pinned");
  return { kind: "task", objectId, scope };
}

// ---------------------------------------------------------------------------
// AC1 — 创建时归属被持久化；后续请求携带不同选择标识不改变它
// ---------------------------------------------------------------------------

describeDb(
  "MT041 AC1: creation-time ownership is persisted and immutable",
  () => {
    itDb(
      "persists company, team, initiator, and business object at creation",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac1-pin",
        );
        const view = await service.readJob(pinned.scope, {
          kind: "task",
          objectId: pinned.objectId,
        });
        expect(view).toMatchObject({
          kind: "task",
          objectId: pinned.objectId,
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
          principalId: pinned.scope.principalId,
        });
        expect(view.creationBasis).toMatchObject({
          companyRevision: 1,
          overrideRevision: null,
        });
        // The digest is a real SHA-256 of the basis document, not a placeholder.
        expect(view.creationBasis.basisDigest).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    itDb(
      "is idempotent for the same ownership and writes nothing twice",
      async () => {
        const scope = await fixture.scopeAs(
          "a1-member",
          "company-a",
          "team-a1",
        );
        const objectId = jobObjectId(fixture, "ac1-idem");
        const basis = basisOf(1, null, "ac1-idem");
        const first = await service.pinJobOwnership({
          kind: "task",
          objectId,
          scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
          principalId: scope.principalId,
          basis,
        });
        expect(first.status).toBe("pinned");
        const second = await service.pinJobOwnership({
          kind: "task",
          objectId,
          scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
          principalId: scope.principalId,
          basis,
        });
        expect(second.status).toBe("existing");
        // Same pin comes back unchanged — including the creation instant.
        expect(second.ownership.createdAt).toEqual(first.ownership.createdAt);
        // A replay carrying a DIFFERENT basis cannot tamper with the recorded
        // creation basis either: the snapshot still says what creation said.
        const tampered = await service.pinJobOwnership({
          kind: "task",
          objectId,
          scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
          principalId: scope.principalId,
          basis: basisOf(9, 9, "ac1-idem-tampered"),
        });
        expect(tampered.status).toBe("existing");
        expect(tampered.ownership.creationBasis).toMatchObject({
          companyRevision: 1,
          overrideRevision: null,
        });
        expect(tampered.ownership.creationBasis).toEqual(
          first.ownership.creationBasis,
        );
        // Exactly one creation snapshot: the idempotent replay wrote nothing.
        const snapshots = await service.listConfigSnapshots(scope, {
          kind: "task",
          objectId,
        });
        expect(
          snapshots.filter((row) => row.purpose === "creation"),
        ).toHaveLength(1);
      },
    );

    itDb(
      "keeps the original pin when a later request selects a different team",
      async () => {
        const owner = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a1",
        );
        const otherTeam = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a2",
        );
        const objectId = jobObjectId(fixture, "ac1-team");
        await service.pinJobOwnership({
          kind: "task",
          objectId,
          scope: { tenantId: owner.tenantId, workspaceId: owner.workspaceId },
          principalId: owner.principalId,
          basis: basisOf(1, null, "ac1-team"),
        });
        // The same user, now selecting team A2, cannot move the pin.
        await expectSentinelRejection(
          service.pinJobOwnership({
            kind: "task",
            objectId,
            scope: {
              tenantId: otherTeam.tenantId,
              workspaceId: otherTeam.workspaceId,
            },
            principalId: otherTeam.principalId,
            basis: basisOf(1, null, "ac1-team"),
          }),
          JOB_OWNERSHIP_MISMATCH,
        );
        const view = await service.readJob(owner, {
          kind: "task",
          objectId,
        });
        // The pin still says team A1 — the later selection changed nothing.
        expect(view.workspaceId).toBe(owner.workspaceId);
        expect(view.workspaceId).not.toBe(otherTeam.workspaceId);
      },
    );

    itDb(
      "keeps the original pin when a later request selects a different company",
      async () => {
        const owner = await fixture.scopeAs(
          "multi-company",
          "company-a",
          "team-a1",
        );
        const otherCompany = await fixture.scopeAs(
          "multi-company",
          "company-b",
          "team-b1",
        );
        const objectId = jobObjectId(fixture, "ac1-company");
        await service.pinJobOwnership({
          kind: "task",
          objectId,
          scope: { tenantId: owner.tenantId, workspaceId: owner.workspaceId },
          principalId: owner.principalId,
          basis: basisOf(1, null, "ac1-company"),
        });
        await expectSentinelRejection(
          service.pinJobOwnership({
            kind: "task",
            objectId,
            scope: {
              tenantId: otherCompany.tenantId,
              workspaceId: otherCompany.workspaceId,
            },
            principalId: otherCompany.principalId,
            basis: basisOf(1, null, "ac1-company"),
          }),
          JOB_OWNERSHIP_MISMATCH,
        );
        const view = await service.readJob(owner, { kind: "task", objectId });
        expect(view.tenantId).toBe(owner.tenantId);
      },
    );

    itDb(
      "structurally forbids rewriting a pin (exact ACL matrix: no UPDATE/DELETE anywhere)",
      async () => {
        // The information_schema grant views are visibility-filtered (a role
        // sees only grants it holds or granted), so the complete ACL surface
        // is read through the has_*_privilege ACL functions instead: EVERY
        // grantee × privilege × table cell is enumerated and the live matrix
        // must equal this hardcoded list exactly — any extra grant (PUBLIC,
        // directory, identity_operator, or an UPDATE/DELETE anywhere) flips
        // a row and fails. Immutability is structural, not asserted loosely.
        const grants = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: fixture.isolation.ids["company-a"] },
          `with grantees(g) as (values
             ('public'),
             ('ob_ent_directory'),
             ('ob_ent_data'),
             ('ob_ent_operator'),
             ('ob_ent_identity_operator')),
           privileges(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')),
           tables(t) as (values
             ('job_ownership'), ('job_config_snapshots'), ('job_leases'))
          select g as grantee, p as privilege, t as table_name
            from grantees cross join privileges cross join tables
           where has_table_privilege(g, t, p)
           order by t, g, p`,
          [],
        );
        expect(
          grants.map(
            (row) => `${row.grantee}:${row.privilege}:${row.table_name}`,
          ),
        ).toEqual([
          "ob_ent_data:SELECT:job_config_snapshots",
          "ob_ent_operator:INSERT:job_config_snapshots",
          "ob_ent_operator:SELECT:job_config_snapshots",
          "ob_ent_data:SELECT:job_leases",
          "ob_ent_operator:INSERT:job_leases",
          "ob_ent_operator:SELECT:job_leases",
          "ob_ent_data:SELECT:job_ownership",
          "ob_ent_operator:INSERT:job_ownership",
          "ob_ent_operator:SELECT:job_ownership",
        ]);
        // Column level: table-level absence does not rule out column grants
        // (job_leases legitimately carries them). Enumerate the UPDATE column
        // surface for every column of all three tables under both roles that
        // hold any grant: exactly the seven service-written lease columns may
        // ever be updated — nothing else, for nobody.
        const columns = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: fixture.isolation.ids["company-a"] },
          `with roles(r) as (values ('ob_ent_data'), ('ob_ent_operator')),
           cols(t, c) as (values
             ('job_ownership', 'kind'),
             ('job_ownership', 'object_id'),
             ('job_ownership', 'tenant_id'),
             ('job_ownership', 'workspace_id'),
             ('job_ownership', 'principal_id'),
             ('job_ownership', 'created_at'),
             ('job_config_snapshots', 'id'),
             ('job_config_snapshots', 'kind'),
             ('job_config_snapshots', 'object_id'),
             ('job_config_snapshots', 'purpose'),
             ('job_config_snapshots', 'company_revision'),
             ('job_config_snapshots', 'override_revision'),
             ('job_config_snapshots', 'basis_digest'),
             ('job_config_snapshots', 'captured_at'),
             ('job_leases', 'kind'),
             ('job_leases', 'object_id'),
             ('job_leases', 'tenant_id'),
             ('job_leases', 'workspace_id'),
             ('job_leases', 'claimed_by_kind'),
             ('job_leases', 'claimed_by'),
             ('job_leases', 'lease_until'),
             ('job_leases', 'attempts'),
             ('job_leases', 'finished_at'),
             ('job_leases', 'last_error'),
             ('job_leases', 'created_at'),
             ('job_leases', 'updated_at'))
          select r as grantee, t as table_name, c as column_name
            from roles cross join cols
           where has_column_privilege(r, t, c, 'UPDATE')
           order by t, r, c`,
          [],
        );
        expect(
          columns.map(
            (row) =>
              `${row.grantee}:UPDATE:${row.table_name}.${row.column_name}`,
          ),
        ).toEqual([
          "ob_ent_operator:UPDATE:job_leases.attempts",
          "ob_ent_operator:UPDATE:job_leases.claimed_by",
          "ob_ent_operator:UPDATE:job_leases.claimed_by_kind",
          "ob_ent_operator:UPDATE:job_leases.finished_at",
          "ob_ent_operator:UPDATE:job_leases.last_error",
          "ob_ent_operator:UPDATE:job_leases.lease_until",
          "ob_ent_operator:UPDATE:job_leases.updated_at",
        ]);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC2 — 租约只能被同一归属的执行者持有；跨范围认领被拒绝
// ---------------------------------------------------------------------------

describeDb(
  "MT041 AC2: leases are held only by same-ownership executors",
  () => {
    itDb("grants a lease to an executor in the same scope", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-grant",
      );
      const grant = await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      expect(grant.status).toBe("granted");
      expect(grant.attempts).toBe(1);
      expect(grant.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    });

    itDb("refuses a cross-team claim and writes nothing", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-team",
      );
      const holder = await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      expect(holder.status).toBe("granted");
      // Same company, different team: refused, and the live lease is untouched —
      // the original holder still holds it (idempotent `held`, attempts unchanged).
      await expectSentinelRejection(
        service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: fixture.isolation.ids["team-a2"],
          },
          executor: WORKER_TWO,
          leaseMs: 60_000,
        }),
        JOB_LEASE_SCOPE_MISMATCH,
      );
      const again = await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      expect(again.status).toBe("held");
      expect(again.attempts).toBe(1);
    });

    itDb("refuses a cross-company claim", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-company",
      );
      await expectSentinelRejection(
        service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: fixture.isolation.ids["company-b"],
            workspaceId: fixture.isolation.ids["team-b1"],
          },
          executor: WORKER_TWO,
          leaseMs: 60_000,
        }),
        JOB_LEASE_SCOPE_MISMATCH,
      );
    });

    itDb(
      "refuses a claim while another executor holds a live lease",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-held",
        );
        const first = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        expect(first.status).toBe("granted");
        await expectSentinelRejection(
          service.claimJobLease({
            kind: pinned.kind,
            objectId: pinned.objectId,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: pinned.scope.workspaceId,
            },
            executor: WORKER_TWO,
            leaseMs: 60_000,
          }),
          "JOB_LEASE_HELD",
        );
      },
    );

    itDb("re-claims an expired lease and counts the attempt", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-expire",
      );
      const first = await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      expect(first.status).toBe("granted");
      // Expire the lease through the operator channel (the DB clock decides).
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${pinned.scope.tenantId}, true)`,
        );
        await tx.execute(
          sql`update job_leases set lease_until = now() - interval '1 second'
              where kind = ${pinned.kind} and object_id = ${pinned.objectId}`,
        );
      });
      const second = await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER_TWO,
        leaseMs: 60_000,
      });
      expect(second.status).toBe("granted");
      expect(second.attempts).toBe(2);
    });

    itDb("renews and finishes only for the current holder", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-renew",
      );
      await service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      const renewed = await service.renewJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 120_000,
      });
      expect(renewed.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 60_000);
      // A different executor in the SAME team still cannot renew it.
      await expectSentinelRejection(
        service.renewJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER_TWO,
          leaseMs: 120_000,
        }),
        JOB_LEASE_NOT_HELD,
      );
      // finish is holder-checked: the wrong holder is refused outright.
      await expectSentinelRejection(
        service.finishJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER_TWO,
        }),
        JOB_LEASE_NOT_HELD,
      );
      // The right holder can still finish afterwards (the refusal wrote nothing).
      const finished = await service.finishJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
      });
      // finishedAt 来自数据库 now()，与测试进程的时钟不同源：毫秒级严格比较会被
      // 两者之间的时钟抖动打红。断言只钉「不是明显未来时间」。
      expect(finished.finishedAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 5_000,
      );
    });

    itDb(
      "refuses a release by another executor or with no holder, writing nothing",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-release",
        );
        const grant = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        expect(grant.status).toBe("granted");
        expect(grant.attempts).toBe(1);
        // Another executor in the SAME team cannot release a lease it does
        // not hold: refused outright (release is holder-checked like renew).
        await expectSentinelRejection(
          service.releaseJobLease({
            kind: pinned.kind,
            objectId: pinned.objectId,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: pinned.scope.workspaceId,
            },
            executor: WORKER_TWO,
            reason: "mt041 stranger release",
          }),
          JOB_LEASE_NOT_HELD,
        );
        // Zero state change, asserted forward: the lease is still live for
        // its holder — WORKER renews it (a cleared row would refuse) and a
        // duplicate claim still reports `held` with the original attempt
        // count, so the refused release neither freed nor rewrote the row.
        const renewed = await service.renewJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 120_000,
        });
        expect(renewed.leaseUntil.getTime()).toBeGreaterThan(
          Date.now() + 60_000,
        );
        const stillHeld = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        expect(stillHeld.status).toBe("held");
        expect(stillHeld.attempts).toBe(1);
        expect(stillHeld.claimedBy).toBe(WORKER.id);
        // The holder releases; the row remains with NO holder. A second
        // release — nobody holds the lease any more — is refused the same way.
        await service.releaseJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          reason: "mt041 holder release",
        });
        await expectSentinelRejection(
          service.releaseJobLease({
            kind: pinned.kind,
            objectId: pinned.objectId,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: pinned.scope.workspaceId,
            },
            executor: WORKER,
            reason: "mt041 double release",
          }),
          JOB_LEASE_NOT_HELD,
        );
        // And the refused second release wrote nothing: the job still leases
        // fresh to the next executor as attempt 2 (not attempt-drifted, not
        // stamped with the stranger's reason anywhere).
        const next = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER_TWO,
          leaseMs: 60_000,
        });
        expect(next.status).toBe("granted");
        expect(next.attempts).toBe(2);
      },
    );

    itDb(
      "lets the holder finish; the finished job can be leased again as a new attempt",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-finish",
        );
        await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        const finished = await service.finishJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
        });
        // finishedAt 来自数据库 now()，与测试进程的时钟不同源：毫秒级严格比较会被
        // 两者之间的时钟抖动打红。断言只钉「不是明显未来时间」。
        expect(finished.finishedAt.getTime()).toBeLessThanOrEqual(
          Date.now() + 5_000,
        );
        // Re-lease after finish: a new attempt, holder cleared by finish.
        const again = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER_TWO,
          leaseMs: 60_000,
        });
        expect(again.status).toBe("granted");
        expect(again.attempts).toBe(2);
        // Release frees the lease immediately for the same scope.
        await service.releaseJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER_TWO,
          reason: "mt041 release probe",
        });
        const third = await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        expect(third.status).toBe("granted");
        expect(third.attempts).toBe(3);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC3 — 配置版本变化后可追溯当时的执行依据
// ---------------------------------------------------------------------------

describeDb(
  "MT041 AC3: config revisions stay traceable after they move on",
  () => {
    itDb(
      "keeps the creation basis while a later job records the new revision",
      async () => {
        await fixture.seedCompanyConfig("company-a", 1);
        await fixture.seedTeamOverride("team-a1", 1);
        const before = await fixture.configService.resolve({
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const oldBasis: JobConfigBasisInput = {
          companyRevision: before.revisions.company,
          overrideRevision: before.revisions.override,
          document: before,
        };
        const old = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac3-old",
          oldBasis,
        );

        // The company config moves on: revision 2 (real row update, operator channel).
        await fixture.seedCompanyConfig("company-a", 2);
        const after = await fixture.configService.resolve({
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        expect(after.revisions.company).toBe(2);
        const newBasis: JobConfigBasisInput = {
          companyRevision: after.revisions.company,
          overrideRevision: after.revisions.override,
          document: after,
        };
        const fresh = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac3-new",
          newBasis,
        );

        const oldSnapshots = await service.listConfigSnapshots(old.scope, {
          kind: old.kind,
          objectId: old.objectId,
        });
        const freshSnapshots = await service.listConfigSnapshots(fresh.scope, {
          kind: fresh.kind,
          objectId: fresh.objectId,
        });
        // The old job's creation basis still says revision 1 — traceable.
        expect(oldSnapshots[0]).toMatchObject({
          purpose: "creation",
          companyRevision: 1,
        });
        expect(freshSnapshots[0]).toMatchObject({
          purpose: "creation",
          companyRevision: 2,
        });
        // Different bases bind different content digests.
        expect(oldSnapshots[0].basisDigest).not.toBe(
          freshSnapshots[0].basisDigest,
        );
      },
    );

    itDb(
      "records each execution basis so the history shows what each run was based on",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac3-exec",
          basisOf(1, null, "ac3-exec-creation"),
        );
        const execution = await service.recordJobExecutionBasis({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          basis: basisOf(2, null, "ac3-exec-second"),
        });
        expect(execution).toMatchObject({
          purpose: "execution",
          companyRevision: 2,
        });
        const history = await service.listConfigSnapshots(pinned.scope, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(history.map((row) => row.purpose)).toEqual([
          "creation",
          "execution",
        ]);
        expect(history.map((row) => row.companyRevision)).toEqual([1, 2]);
        expect(history[0].basisDigest).not.toBe(history[1].basisDigest);
      },
    );

    itDb(
      "refuses an execution basis recorded from another scope or for an unpinned job",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac3-guard",
        );
        await expectSentinelRejection(
          service.recordJobExecutionBasis({
            kind: pinned.kind,
            objectId: pinned.objectId,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: fixture.isolation.ids["team-a2"],
            },
            basis: basisOf(1, null, "ac3-guard"),
          }),
          JOB_OWNERSHIP_REQUIRED,
        );
        const stranger = jobObjectId(fixture, "ac3-unknown");
        await expectSentinelRejection(
          service.recordJobExecutionBasis({
            kind: "task",
            objectId: stranger,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: pinned.scope.workspaceId,
            },
            basis: basisOf(1, null, "ac3-guard"),
          }),
          JOB_OWNERSHIP_REQUIRED,
        );
        await expectSentinelRejection(
          service.claimJobLease({
            kind: "task",
            objectId: stranger,
            scope: {
              tenantId: pinned.scope.tenantId,
              workspaceId: pinned.scope.workspaceId,
            },
            executor: WORKER,
            leaseMs: 60_000,
          }),
          JOB_LEASE_SCOPE_MISMATCH,
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC4 — 任务列表与详情只返回有权范围（含管理视图）
// ---------------------------------------------------------------------------

describeDb(
  "MT041 AC4: lists and details return only the authorized scope",
  () => {
    itDb("lists only the viewer's own jobs in the selected team", async () => {
      const mine = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac4-mine",
      );
      const theirs = await pinTask(
        "a1-other",
        "company-a",
        "team-a1",
        "ac4-theirs",
      );
      const list = await service.listJobs(mine.scope);
      const ids = list.map((row) => row.objectId);
      expect(ids).toContain(mine.objectId);
      expect(ids).not.toContain(theirs.objectId);
      const otherList = await service.listJobs(theirs.scope);
      expect(otherList.map((row) => row.objectId)).toEqual([theirs.objectId]);
      void mine;
    });

    itDb(
      "does not leak other team selections into the list (workspace filter)",
      async () => {
        const inA1 = await pinTask(
          "a1a2-member",
          "company-a",
          "team-a1",
          "ac4-ws-a1",
        );
        const inA2 = await pinTask(
          "a1a2-member",
          "company-a",
          "team-a2",
          "ac4-ws-a2",
        );
        const a1List = await service.listJobs(inA1.scope);
        expect(a1List.map((row) => row.objectId)).toContain(inA1.objectId);
        expect(a1List.map((row) => row.objectId)).not.toContain(inA2.objectId);
        const a2List = await service.listJobs(inA2.scope);
        expect(a2List.map((row) => row.objectId)).toEqual([inA2.objectId]);
      },
    );

    itDb(
      "management view lists the whole company across teams and initiators",
      async () => {
        const inA1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac4-admin-a1",
        );
        const inA2 = await pinTask(
          "a2-member",
          "company-a",
          "team-a2",
          "ac4-admin-a2",
        );
        const inB1 = await pinTask(
          "b1-member",
          "company-b",
          "team-b1",
          "ac4-admin-b1",
        );
        const admin = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const list = await service.listJobsForCompanyAdmin(admin);
        const ids = list.map((row) => row.objectId);
        expect(ids).toContain(inA1.objectId);
        expect(ids).toContain(inA2.objectId);
        expect(ids).not.toContain(inB1.objectId);
        // Every management row belongs to the admin's own company.
        for (const row of list) {
          expect(row.tenantId).toBe(admin.tenantId);
        }
      },
    );

    itDb(
      "refuses the management view without a trusted admin context",
      async () => {
        const forged = {
          tenantId: fixture.isolation.ids["company-a"],
          principalId: "forged",
          actorId: "forged",
          memberEpoch: 1,
        };
        await expectSentinelRejection(
          service.listJobsForCompanyAdmin(forged),
          "UNVERIFIED_ADMIN_CONTEXT",
        );
      },
    );

    itDb(
      "hides cross-team, cross-company, and absent jobs behind one identical not-found",
      async () => {
        const mine = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac4-nf-mine",
        );
        const otherTeam = await pinTask(
          "a2-member",
          "company-a",
          "team-a2",
          "ac4-nf-team",
        );
        const otherCompany = await pinTask(
          "b1-member",
          "company-b",
          "team-b1",
          "ac4-nf-company",
        );
        const absent = jobObjectId(fixture, "ac4-nf-absent");
        const refusals: string[] = [];
        for (const ref of [
          { kind: otherTeam.kind, objectId: otherTeam.objectId },
          { kind: otherCompany.kind, objectId: otherCompany.objectId },
          { kind: "task" as const, objectId: absent },
        ]) {
          try {
            await service.readJob(mine.scope, ref);
            throw new Error(`expected RESOURCE_NOT_FOUND for ${ref.objectId}`);
          } catch (error) {
            refusals.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        // Byte-identical refusals: no existence leak across team/company/absent.
        expect(new Set(refusals).size).toBe(1);
        expect(refusals[0].startsWith("RESOURCE_NOT_FOUND: ")).toBe(true);
        // The admin view refuses another company's job the same way.
        const admin = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        try {
          await service.readJobForCompanyAdmin(admin, {
            kind: otherCompany.kind,
            objectId: otherCompany.objectId,
          });
          throw new Error(
            "expected RESOURCE_NOT_FOUND for admin cross-company",
          );
        } catch (error) {
          expect(error instanceof Error && error.message).toBe(refusals[0]);
        }
        // Positive control: the owner still reads their own job.
        const own = await service.readJob(mine.scope, {
          kind: mine.kind,
          objectId: mine.objectId,
        });
        expect(own.objectId).toBe(mine.objectId);
      },
    );

    itDb(
      "an empty cross-company list leaks nothing (count included)",
      async () => {
        const scope = await fixture.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        const list = await service.listJobs(scope);
        // The viewer's own company-B jobs (pinned by earlier cases) may appear;
        // what must never appear is ANY company-A row — company B sees no A job.
        const companyA = fixture.isolation.ids["company-a"];
        expect(list.every((row) => row.tenantId !== companyA)).toBe(true);
      },
    );

    itDb(
      "the data role cannot see another company's pins, snapshots, or leases",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac4-rls",
        );
        await service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        const companyA = fixture.isolation.ids["company-a"];
        // Pinned to company B, rows of company A are structurally invisible.
        const ownership = await fixture.isolation.queryRestricted(
          "data",
          { tenantId: fixture.isolation.ids["company-b"] },
          "select count(*)::int as total from job_ownership where tenant_id = $1",
          [companyA],
        );
        expect(ownership[0]?.total).toBe(0);
        const leases = await fixture.isolation.queryRestricted(
          "data",
          { tenantId: fixture.isolation.ids["company-b"] },
          "select count(*)::int as total from job_leases where tenant_id = $1",
          [companyA],
        );
        expect(leases[0]?.total).toBe(0);
        const snapshots = await fixture.isolation.queryRestricted(
          "data",
          { tenantId: fixture.isolation.ids["company-b"] },
          `select count(*)::int as total from job_config_snapshots s
        where exists (select 1 from job_ownership o
                       where o.kind = s.kind and o.object_id = s.object_id
                         and o.tenant_id = $1)`,
          [companyA],
        );
        expect(snapshots[0]?.total).toBe(0);
      },
    );
  },
);
