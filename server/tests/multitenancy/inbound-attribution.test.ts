// server/tests/multitenancy/inbound-attribution.test.ts
// MT044（Issue #87）：入站邮件、GitHub 与 Webhook 的归属解析。
//
// 验收事实源（Issue #87 正文四条 AC，逐条对应 describe）：
//   (1) 入站事件按持久映射归属；载荷中伪造的公司/团队字段被忽略。
//   (2) 无法解析归属的事件进入隔离队列并可见于运维视图，不写入任何业务范围。
//   (3) 重复投递幂等处理，不产生重复任务或重复计费。
//   (4) 入站触发的执行遵守 MT042 的作用域重建规则。
//
// 机制：真实公共 ingress 路由（Hono fetch）+ 真实触发器/责任 store + 真实
// MT044 服务（directory/operator 受限通道 + 真实 RLS）+ 真实 MT041 pin +
// 真实 MT042 扫描执行器（元数据认领 → job_ownership 权威行重建 → 真实签发
// 入口 → MT005 gate）。载荷里的伪造归属字段只作为惰性数据被记录，从不参
// 与解析——伪造值与断言归属同时可见即证明字段未被消费。隔离边界 = 已认证
// 投递；匿名探测维持 401/404（既有套件在案），此处证明已认证但不可解析的
// 投递入隔离。
//
// 环境契约：专用企业测试库（openbot_enterprise_*），缺显式 env 整套显式
// skip，绝不回退开发库、skipped 不计通过。

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { jobOwnership } from "../../src/db/schema/job-ownership";
import {
  responsibilityEvents,
  responsibilityInboundQuarantine,
  responsibilityRuns,
  responsibilityTriggers,
} from "../../src/db/schema/responsibilities";
import { workItems } from "../../src/db/schema/work";
import {
  createMachineScanIdentity,
  createScanExecutor,
  type ScanOutcome,
} from "../../src/enterprise/runs/scan-executor";
import {
  createInboundAttributionService,
  createInboundTriggerScanExecute,
  INBOUND_MAPPING_INCOMPLETE,
  INBOUND_PRINCIPAL_UNRESOLVED,
  type InboundTriggerRunTurn,
} from "../../src/enterprise/tenancy/inbound-attribution";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  createInboundAttributionFixture,
  EMAIL_DOMAIN,
  type InboundAttributionFixture,
} from "./support/inbound-attribution";

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

let fixture: InboundAttributionFixture;

/** What one scan-and-dispatch recorded: rebuilt scope + the turn's inert payload. */
interface RecordedExecution {
  runId: string;
  scopeTrusted: boolean;
  tenantId: string;
  workspaceId: string;
  entrypoint: string;
  payloadTenantId: unknown;
  payloadOwner: unknown;
  gateSawPinRow: boolean;
}

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createInboundAttributionFixture();
  // The work queue is durable across runs: close whatever earlier runs left
  // behind so every scan in this run sees only this run's items.
  await fixture.scan.drainScanQueue();
});

afterAll(async () => {
  await fixture?.dispose();
});

/** The webhook payload every positive delivery uses: it FORGES company B and a stranger owner. */
function forgedPayload() {
  return {
    type: "deploy.finished",
    tenantId: fixture.owner.companyB.tenantId,
    workspaceId: fixture.owner.companyB.workspaceId,
    companyId: fixture.owner.companyB.tenantId,
    teamId: fixture.owner.companyB.workspaceId,
    ownerUserId: "attacker-owned-user",
    note: "mt044 forged-attribution delivery",
  };
}

/**
 * The real MT042 executor wrapped around the MT044 dispatch callback. The wrapper
 * records what the rebuild produced (scope + gate-tx visibility) before handing
 * the item to the inbound dispatch, which runs the turn through begin/settle.
 */
function inboundExecutor(record: RecordedExecution[]) {
  const turns: { runId: string; payload: Record<string, unknown> }[] = [];
  const runTurn: InboundTriggerRunTurn = async (context) => {
    turns.push({ runId: context.runId, payload: context.event.payload });
    return { replyText: "mt044 triaged" };
  };
  const dispatch = createInboundTriggerScanExecute({
    store: fixture.store,
    runTurn,
  });
  const executor = createScanExecutor({
    platform: fixture.scan.platform,
    operator: fixture.scan.jobs.operator,
    jobOwnership: fixture.scan.service,
    gate: fixture.scan.gate,
    issueScheduleScope: fixture.scan.issueScheduleScope,
    execute: async (context) => {
      // The rebuilt scope must be a genuinely issued one (MT005 trust
      // marking) — a hand-built lookalike would throw right here.
      assertTrustedScope(context.scope);
      // Inside the MT005 gate transaction the tenant context is live: the
      // operator sweep arm plus app.tenant_id must expose exactly this run's
      // authoritative pin row — cross-company rows would be invisible here.
      const pinRows = await context.tx
        .select({ objectId: jobOwnership.objectId })
        .from(jobOwnership)
        .where(
          and(
            eq(jobOwnership.kind, context.item.jobKind),
            eq(jobOwnership.objectId, context.item.objectId),
          ),
        );
      const recorded: RecordedExecution = {
        runId: context.item.objectId,
        scopeTrusted: true,
        tenantId: context.scope.tenantId,
        workspaceId: context.scope.workspaceId,
        entrypoint: context.scope.entrypoint,
        payloadTenantId: undefined,
        payloadOwner: undefined,
        gateSawPinRow: pinRows.length === 1,
      };
      await dispatch(context);
      const turn = turns.find((entry) => entry.runId === context.item.objectId);
      if (turn) {
        recorded.payloadTenantId = turn.payload.tenantId;
        recorded.payloadOwner = turn.payload.ownerUserId;
      }
      record.push(recorded);
    },
  });
  return executor;
}

/** Outcomes of one scan restricted to this test's run ids. */
function outcomesFor(outcomes: ScanOutcome[], runIds: string[]): ScanOutcome[] {
  const wanted = new Set(runIds);
  return outcomes.filter((outcome) => wanted.has(outcome.item?.objectId ?? ""));
}

/** One authenticated enterprise webhook delivery; returns the queued run ids. */
async function deliverEnterprise(
  label: string,
): Promise<{ triggerId: string; deliveryId: string; runIds: string[] }> {
  const created = await fixture.enterpriseWebhookTrigger(label);
  const deliveryId = `${label}-${randomUUID().slice(0, 8)}`;
  const response = await fixture.postWebhook(
    created.triggerId,
    created.secret,
    forgedPayload(),
    deliveryId,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { runIds: string[] };
  expect(body.runIds).toHaveLength(1);
  return { triggerId: created.triggerId, deliveryId, runIds: body.runIds };
}

describeDb("MT044 — inbound ownership attribution (Issue #87)", () => {
  describe("AC1: deliveries attribute by the persisted mapping; forged payload fields are ignored", () => {
    itDb(
      "resolves an enterprise trigger to its persisted company and team over restricted channels",
      async () => {
        const created = await fixture.enterpriseWebhookTrigger("ac1-resolve");
        const resolved = await fixture.triggers.directory.resolve(
          created.triggerId,
        );
        expect(resolved).not.toBeNull();
        // The persisted mapping is what resolution reads.
        expect(resolved?.tenantId).toBe(fixture.owner.tenantId);
        expect(resolved?.workspaceId).toBe(fixture.owner.workspaceId);
        const resolution = await fixture.seam.resolve(resolved!);
        expect(resolution.kind).toBe("enterprise");
        if (resolution.kind !== "enterprise") return;
        expect(resolution.attribution.tenantId).toBe(fixture.owner.tenantId);
        expect(resolution.attribution.workspaceId).toBe(
          fixture.owner.workspaceId,
        );
        expect(resolution.attribution.principalId).toBe(
          fixture.owner.principalId,
        );
      },
    );

    itDb(
      "an authenticated webhook carrying forged company, team and owner fields pins the persisted mapping",
      async () => {
        const delivered = await deliverEnterprise("ac1-forge");
        // The run's authoritative ownership is the persisted mapping — company A,
        // team A1, the owner's principal — never the forged company B fields the
        // payload carried.
        const pins = await fixture.responsibilities
          .select()
          .from(jobOwnership)
          .where(
            and(
              eq(jobOwnership.kind, "run"),
              eq(jobOwnership.objectId, delivered.runIds[0]),
            ),
          );
        expect(pins).toHaveLength(1);
        expect(pins[0].tenantId).toBe(fixture.owner.tenantId);
        expect(pins[0].workspaceId).toBe(fixture.owner.workspaceId);
        expect(pins[0].principalId).toBe(fixture.owner.principalId);
        // The forged fields were recorded as inert event data (visible, unused):
        // the event exists under the trigger's external id, owned by the mapping.
        const rows = await fixture.businessRowsOf({
          triggerId: delivered.triggerId,
          deliveryId: delivered.deliveryId,
        });
        expect(rows).toEqual({
          events: 1,
          runs: 1,
          scanItems: 1,
          personalItems: 0,
        });
      },
    );

    itDb(
      "a legacy personal trigger (no mapping columns) keeps the owner-user path unchanged",
      async () => {
        const created = await fixture.personalWebhookTrigger("ac1-personal");
        expect(created).toBeTruthy();
        const [mapping] = await fixture.responsibilities
          .select({
            tenantId: responsibilityTriggers.tenantId,
            workspaceId: responsibilityTriggers.workspaceId,
          })
          .from(responsibilityTriggers)
          .where(eq(responsibilityTriggers.id, created.triggerId));
        expect(mapping.tenantId).toBeNull();
        expect(mapping.workspaceId).toBeNull();
        const resolved = await fixture.triggers.directory.resolve(
          created.triggerId,
        );
        const resolution = await fixture.seam.resolve(resolved!);
        expect(resolution.kind).toBe("personal");
        // The personal delivery still queues the classic responsibility.run item.
        const deliveryId = `personal-${randomUUID().slice(0, 8)}`;
        const response = await fixture.postWebhook(
          created.triggerId,
          created.secret,
          { type: "deploy.finished" },
          deliveryId,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { runIds: string[] };
        expect(body.runIds).toHaveLength(1);
        const [item] = await fixture.responsibilities
          .select({ kind: workItems.kind })
          .from(workItems)
          .where(eq(workItems.key, body.runIds[0]));
        expect(item?.kind).toBe("responsibility.run");
      },
    );

    itDb(
      "a half-written mapping (one column set) is unresolvable, never a default scope",
      async () => {
        const created = await fixture.enterpriseWebhookTrigger("ac1-half");
        // Deliberate rotted mapping: tenant set, workspace missing (a data defect
        // seeded directly, not an API surface).
        await fixture.responsibilities
          .update(responsibilityTriggers)
          .set({ workspaceId: null })
          .where(eq(responsibilityTriggers.id, created.triggerId));
        const resolved = await fixture.triggers.directory.resolve(
          created.triggerId,
        );
        const resolution = await fixture.seam.resolve(resolved!);
        expect(resolution).toEqual({
          kind: "unresolvable",
          code: INBOUND_MAPPING_INCOMPLETE,
        });
      },
    );
  });

  describe("AC2: unresolvable deliveries quarantine, are visible to operators, and write no business rows", () => {
    itDb(
      "a rotted mapping (membership suspended) quarantines the delivery and writes nothing",
      async () => {
        const created = await fixture.enterpriseWebhookTrigger("ac2-rot");
        // Suspend the owner's company-a membership: the persisted mapping can no
        // longer resolve to a live principal, so the delivery must not run.
        await fixture.scan.suspendCompanyMembership(
          "a1-member",
          fixture.owner.tenantId,
        );
        try {
          const deliveryId = `rot-${randomUUID().slice(0, 8)}`;
          const response = await fixture.postWebhook(
            created.triggerId,
            created.secret,
            forgedPayload(),
            deliveryId,
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            queued: boolean;
            quarantined: boolean;
            quarantineId: string;
            reason: string;
          };
          expect(body.queued).toBe(false);
          expect(body.quarantined).toBe(true);
          expect(body.reason).toContain(INBOUND_PRINCIPAL_UNRESOLVED);
          expect(body.quarantineId).toBeTruthy();
          // Nothing in any business scope: no event, run, or queue item.
          const rows = await fixture.businessRowsOf({
            triggerId: created.triggerId,
            deliveryId,
          });
          expect(rows).toEqual({
            events: 0,
            runs: 0,
            scanItems: 0,
            personalItems: 0,
          });
          // Visible in the ops view, with the deterministic reason.
          const machine = createMachineScanIdentity({ id: "mt044-ops-rot" });
          const service = createInboundAttributionService({
            platform: fixture.responsibilities,
            directory: fixture.scan.jobs.directory,
            operator: fixture.scan.jobs.operator,
          });
          const listed = await service.listQuarantined(machine, {
            includeReviewed: true,
            limit: 500,
          });
          const mine = listed.filter((row) => row.id === body.quarantineId);
          expect(mine).toHaveLength(1);
          expect(mine[0].channel).toBe("webhook");
          expect(mine[0].triggerId).toBe(created.triggerId);
          expect(mine[0].reason).toBe(INBOUND_PRINCIPAL_UNRESOLVED);
          // The quarantine row itself is reviewable from the ops view.
          expect(
            await service.reviewQuarantined(machine, { id: body.quarantineId }),
          ).toBe(true);
        } finally {
          await fixture.restoreCompanyMembership(fixture.owner.tenantId);
        }
      },
    );

    itDb(
      "an authenticated email to an address that no longer routes is quarantined",
      async () => {
        const ghost = randomUUID();
        const messageId = `unrouted-${ghost.slice(0, 8)}`;
        const response = await fixture.postEmail({
          messageId,
          recipient: `trigger-${ghost}@${EMAIL_DOMAIN}`,
          from: "ops@example.test",
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          accepted: boolean;
          deliveries: number;
          quarantined?: number;
        };
        expect(body.accepted).toBe(true);
        expect(body.deliveries).toBe(0);
        expect(body.quarantined).toBe(1);
        // The quarantined mail produced no responsibility event anywhere.
        const events = await fixture.responsibilities
          .select({ id: responsibilityEvents.id })
          .from(responsibilityEvents)
          .where(eq(responsibilityEvents.externalId, `x:${messageId}`));
        expect(events).toHaveLength(0);
        // And exactly one quarantine row with the address-missing reason.
        const rows = await fixture.responsibilities
          .select()
          .from(responsibilityInboundQuarantine)
          .where(
            and(
              eq(responsibilityInboundQuarantine.channel, "email"),
              eq(responsibilityInboundQuarantine.deliveryId, messageId),
            ),
          );
        expect(rows).toHaveLength(1);
        expect(rows[0].triggerId).toBe(ghost);
        expect(rows[0].reason).toBe("INBOUND_MAPPING_MISSING");
      },
    );

    itDb(
      "the ops listing opens for a platform machine identity and refuses anything else",
      async () => {
        const service = createInboundAttributionService({
          platform: fixture.responsibilities,
          directory: fixture.scan.jobs.directory,
          operator: fixture.scan.jobs.operator,
        });
        const machine = createMachineScanIdentity({ id: "mt044-ops-list" });
        const listed = await service.listQuarantined(machine, { limit: 10 });
        expect(Array.isArray(listed)).toBe(true);
        // A hand-built lookalike is not an issued identity (structure ≠ trust).
        const forged = { kind: "machine-scan", id: "mt044-ops-forged" };
        let refused = false;
        try {
          await service.listQuarantined(forged as never, { limit: 10 });
        } catch (error) {
          refused = String(error).includes("MACHINE_IDENTITY_INVALID");
        }
        expect(refused).toBe(true);
      },
    );
  });

  describe("AC3: duplicate deliveries are idempotent — no duplicate runs, pins or queue items", () => {
    itDb(
      "a redelivered webhook returns the same run and pins exactly one ownership row",
      async () => {
        const created = await fixture.enterpriseWebhookTrigger("ac3-dup");
        const deliveryId = `dup-${randomUUID().slice(0, 8)}`;
        const first = await fixture.postWebhook(
          created.triggerId,
          created.secret,
          forgedPayload(),
          deliveryId,
        );
        const firstBody = (await first.json()) as {
          runIds: string[];
          duplicate: boolean;
          eventId: string;
        };
        expect(firstBody.duplicate).toBe(false);
        expect(firstBody.runIds).toHaveLength(1);
        const second = await fixture.postWebhook(
          created.triggerId,
          created.secret,
          forgedPayload(),
          deliveryId,
        );
        const secondBody = (await second.json()) as {
          runIds: string[];
          duplicate: boolean;
          eventId: string;
        };
        expect(secondBody.duplicate).toBe(true);
        expect(secondBody.runIds).toEqual(firstBody.runIds);
        expect(secondBody.eventId).toBe(firstBody.eventId);
        // Exactly one ownership pin, one scan queue item, one run — no duplicate
        // task (the run is the billable unit an inbound event creates).
        const pins = await fixture.responsibilities
          .select({ objectId: jobOwnership.objectId })
          .from(jobOwnership)
          .where(eq(jobOwnership.objectId, firstBody.runIds[0]));
        expect(pins).toHaveLength(1);
        const items = await fixture.responsibilities
          .select({ key: workItems.key })
          .from(workItems)
          .where(eq(workItems.key, `run:${firstBody.runIds[0]}`));
        expect(items).toHaveLength(1);
        const runs = await fixture.responsibilities
          .select({ id: responsibilityRuns.id })
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, firstBody.runIds[0]));
        expect(runs).toHaveLength(1);
      },
    );

    itDb("a redelivered unrouted email quarantines exactly once", async () => {
      const ghost = randomUUID();
      const messageId = `dq-${ghost.slice(0, 8)}`;
      const recipient = `trigger-${ghost}@${EMAIL_DOMAIN}`;
      const first = await fixture.postEmail({
        messageId,
        recipient,
        from: "ops@example.test",
      });
      const second = await fixture.postEmail({
        messageId,
        recipient,
        from: "ops@example.test",
      });
      expect(
        ((await first.json()) as { quarantined?: number }).quarantined,
      ).toBe(1);
      // The redelivery is acknowledged but queues no second quarantine row.
      expect(
        ((await second.json()) as { quarantined?: number }).quarantined ?? 0,
      ).toBe(0);
      const rows = await fixture.responsibilities
        .select({ id: responsibilityInboundQuarantine.id })
        .from(responsibilityInboundQuarantine)
        .where(
          and(
            eq(responsibilityInboundQuarantine.channel, "email"),
            eq(responsibilityInboundQuarantine.deliveryId, messageId),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe("AC4: inbound-triggered execution follows the MT042 scope rebuild", () => {
    itDb(
      "the scan executor rebuilds the scope from the authoritative pin and runs the turn inside the gate",
      async () => {
        const delivered = await deliverEnterprise("ac4-rebuild");
        const runId = delivered.runIds[0];
        // Queued ONLY through the MT042 scan shape — no personal queue item.
        const personal = await fixture.responsibilities
          .select({ key: workItems.key })
          .from(workItems)
          .where(eq(workItems.key, runId));
        expect(personal).toHaveLength(0);
        const [scanItem] = await fixture.responsibilities
          .select({ key: workItems.key, finishedAt: workItems.finishedAt })
          .from(workItems)
          .where(eq(workItems.key, `run:${runId}`));
        expect(scanItem?.key).toBe(`run:${runId}`);
        expect(scanItem?.finishedAt).toBeNull();

        const recorded: RecordedExecution[] = [];
        const outcomes = await inboundExecutor(recorded).scanAndExecute(
          createMachineScanIdentity({ id: "mt044-scan-ac4" }),
          { maxAttempts: 2 },
        );
        expect(outcomesFor(outcomes, [runId])).toEqual([
          {
            status: "executed",
            item: expect.objectContaining({ objectId: runId }),
          },
        ]);
        // The rebuilt scope is an issued, gate-accepted scope of the persisted
        // mapping — schedule entrypoint, company A / team A1. The forged payload
        // fields rode along as inert data (recorded, never consumed).
        // The scan is a shared sweep: filter to this test's run (other due items
        // from earlier describes may ride along — they are not this test's fact).
        const mine = recorded.filter((entry) => entry.runId === runId);
        expect(mine).toHaveLength(1);
        const execution = mine[0];
        expect(execution.scopeTrusted).toBe(true);
        expect(execution.tenantId).toBe(fixture.owner.tenantId);
        expect(execution.workspaceId).toBe(fixture.owner.workspaceId);
        expect(execution.entrypoint).toBe("schedule");
        expect(execution.payloadTenantId).toBe(fixture.owner.companyB.tenantId);
        expect(execution.payloadOwner).toBe("attacker-owned-user");
        expect(execution.gateSawPinRow).toBe(true);
        // The run settled succeeded through the real begin/settle path, and the
        // scan item finished exactly once.
        const [run] = await fixture.responsibilities
          .select({
            status: responsibilityRuns.status,
            reply: responsibilityRuns.replyText,
          })
          .from(responsibilityRuns)
          .where(eq(responsibilityRuns.id, runId));
        expect(run?.status).toBe("succeeded");
        expect(run?.reply).toBe("mt044 triaged");
        const [done] = await fixture.responsibilities
          .select({ finishedAt: workItems.finishedAt })
          .from(workItems)
          .where(eq(workItems.key, `run:${runId}`));
        expect(done?.finishedAt).not.toBeNull();
      },
    );

    itDb(
      "a revoked scope refuses the execution — released for retry, the run never starts",
      async () => {
        const delivered = await deliverEnterprise("ac4-revoke");
        const runId = delivered.runIds[0];
        // Revoke AFTER ingest: the rebuild-time scope issuance must now refuse.
        await fixture.scan.suspendCompanyMembership(
          "a1-member",
          fixture.owner.tenantId,
        );
        try {
          const recorded: RecordedExecution[] = [];
          const outcomes = await inboundExecutor(recorded).scanAndExecute(
            createMachineScanIdentity({ id: "mt044-scan-rev" }),
            { maxAttempts: 2 },
          );
          const mine = outcomesFor(outcomes, [runId]);
          expect(mine).toHaveLength(1);
          expect(mine[0].status).toBe("refused");
          if (mine[0].status === "refused")
            expect(mine[0].code).toBe("SCAN_SCOPE_UNRESOLVED");
          // The turn never ran for THIS run; it stays queued (never executed).
          expect(
            recorded.filter((entry) => entry.runId === runId),
          ).toHaveLength(0);
          const [run] = await fixture.responsibilities
            .select({ status: responsibilityRuns.status })
            .from(responsibilityRuns)
            .where(eq(responsibilityRuns.id, runId));
          expect(run?.status).toBe("queued");
        } finally {
          await fixture.restoreCompanyMembership(fixture.owner.tenantId);
        }
      },
    );
  });
});
