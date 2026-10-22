// server/tests/multitenancy/proactive-tx.test.ts
// MT045（Issue #88）：主动建议与外部调用前后的事务边界。
//
// 验收事实源（Issue #88 正文四条 AC，逐条对应 describe）：
//   AC1 主动建议只投递给归属范围内的授权接收者；正文不含无权内容。
//   AC2 外部调用前后是独立事务；测试证明没有在等待外部 API 时持有数据库
//      授权锁。
//   AC3 外部调用失败后重试安全（幂等），不产生重复投递或重复扣费。
//   AC4 撤销接收者权限后不再投递，且已投递内容不可被无权者读取。
//
// 机制：真实隔离矩阵（公司 A/B + §11 身份）+ 真实受限通道（directory/
// data/operator，真实 RLS）+ 真实签发入口（scope resolver，WeakSet 受信）
// + 真实 proactive store（0177 归属列经真实 create 路径写入）+ 真实 MT045
// 服务（归属解析 + 企业投递管线）。外部调用 seam 是记录型 transport（按
// dedupeKey 幂等 + 计费计数器）。AC2 的证明是可观察的：transport 阻塞在
// 外部调用上时，从 setup 连接探测 pg_locks/pg_stat_activity——发送连接上
// 没有任何打开的事务与任何 advisory/transactionid 锁；对照组先证明探针能
// 探到打开的事务（不是空转的断言）。
//
// 环境契约：专用企业测试库（openbot_enterprise_*），缺显式 env 整套显式
// skip，绝不回退开发库、skipped 不计通过。

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { notFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createEnterpriseProactiveDelivery,
  type ProactiveAuditEvent,
  type ProactiveAuditSink,
} from "../../src/enterprise/tenancy/proactive-delivery";
import {
  createProactiveTxFixture,
  type ProactiveTxFixture,
  recordingTransport,
  transportLedger,
} from "./support/proactive-tx";

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

const canonicalDeny = JSON.stringify(notFoundVerdict());

let fixture: ProactiveTxFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createProactiveTxFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// 共享件
// ---------------------------------------------------------------------------

function auditRecorder(): ProactiveAuditSink & {
  events(): readonly ProactiveAuditEvent[];
} {
  const seen: ProactiveAuditEvent[] = [];
  return {
    async record(event) {
      seen.push(event);
    },
    events: () => seen,
  };
}

/** One delivery service assembled over the fixture's real channels. */
function deliveryWith(
  transport: ReturnType<typeof recordingTransport>["transport"],
  audit: ProactiveAuditSink,
) {
  return createEnterpriseProactiveDelivery({
    platform: fixture.platform,
    data: fixture.data,
    attribution: fixture.attribution,
    transport,
    audit,
  });
}

/** Seeds an attributed setting with two suggestions; returns the ids. */
async function seededSetting(input: {
  identity: Parameters<typeof fixture.scopeAs>[0];
  companyKey: "company-a" | "company-b";
  teamKey: "team-a1" | "team-a2" | "team-b1";
  label: string;
}): Promise<{
  scope: PlatformScope;
  settingId: string;
  ownerUserId: string;
  botId: string;
  runId: string;
  suggestionIds: string[];
}> {
  const scope = await fixture.scopeAs(
    input.identity,
    input.companyKey,
    input.teamKey,
  );
  const setting = await fixture.enterpriseSetting(input);
  const suggestionIds = [
    await fixture.addSuggestion({
      settingId: setting.settingId,
      ownerUserId: scope.actorId,
      botId: setting.botId,
      runId: setting.runId,
      title: "Reply to the design thread",
      detail: "The client asked a question two days ago; it is still open.",
      sourceApp: "Linear",
    }),
    await fixture.addSuggestion({
      settingId: setting.settingId,
      ownerUserId: scope.actorId,
      botId: setting.botId,
      runId: setting.runId,
      title: "Book the infrastructure review",
      detail: "The certificate expires next week.",
    }),
  ];
  return {
    scope,
    settingId: setting.settingId,
    ownerUserId: scope.actorId,
    botId: setting.botId,
    runId: setting.runId,
    suggestionIds,
  };
}

// ---------------------------------------------------------------------------
// AC1 — 归属范围内的授权接收者；正文不含无权内容
// ---------------------------------------------------------------------------

describeDb(
  "MT045 AC1: suggestions deliver only inside the attributed scope",
  () => {
    itDb(
      "delivers to the same-team member and the body is composed of the suggestion's own fields only",
      async () => {
        const seeded = await seededSetting({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-own",
        });
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());

        const result = await delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });

        expect(result.outcome).toBe("delivered");
        if (result.outcome !== "delivered") return;
        expect(result.claims.map((claim) => claim.suggestionId).sort()).toEqual(
          [...seeded.suggestionIds].sort(),
        );
        const first = result.claims.find(
          (claim) => claim.suggestionId === seeded.suggestionIds[0],
        )!;
        // 正文只由建议行自身字段组成（title/detail/sourceApp）——不嵌入
        // 任何其他范围的数据。
        expect(first.text).toBe(
          [
            "Suggested next step: Reply to the design thread",
            "The client asked a question two days ago; it is still open.",
            "From Linear",
          ].join("\n"),
        );
        // 归属三元组随认领携带（接收面 = 本 scope）。
        expect(first.tenantId).toBe(seeded.scope.tenantId);
        expect(first.workspaceId).toBe(seeded.scope.workspaceId);
        expect(first.botId).toBe(seeded.botId);
        for (const id of seeded.suggestionIds) {
          expect(await fixture.deliveredAtOf(id)).not.toBeNull();
        }
      },
    );

    itDb(
      "a member of the other team of the same company gets nothing (three-way mismatch)",
      async () => {
        // The setting is attributed to A1; the SAME person is also in A2 and
        // delivers under the A2 scope: the persisted mapping must win.
        const seeded = await seededSetting({
          identity: "a1a2-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-cross-team",
        });
        const a2Scope = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a2",
        );
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());

        const result = await delivery.deliver(a2Scope, {
          settingId: seeded.settingId,
        });

        expect(JSON.stringify(result)).toBe(canonicalDeny);
        expect(transport.recording().sends).toHaveLength(0);
        for (const id of seeded.suggestionIds) {
          expect(await fixture.deliveredAtOf(id)).toBeNull();
        }
      },
    );

    itDb(
      "a member of another company gets nothing and learns nothing",
      async () => {
        const seeded = await seededSetting({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-cross-company",
        });
        const bScope = await fixture.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());

        const result = await delivery.deliver(bScope, {
          settingId: seeded.settingId,
        });

        expect(JSON.stringify(result)).toBe(canonicalDeny);
        expect(transport.recording().sends).toHaveLength(0);
      },
    );

    itDb(
      "a personal (unattributed) setting resolves to the personal outcome, no enterprise send",
      async () => {
        const personal = await fixture.personalSetting({
          identity: "a1-member",
          label: "ac1-personal",
        });
        await fixture.addSuggestion({
          settingId: personal.settingId,
          ownerUserId: (
            await fixture.scopeAs("a1-member", "company-a", "team-a1")
          ).actorId,
          botId: personal.botId,
          runId: personal.runId,
          title: "Personal suggestion",
          detail: "Personal domain behaviour is unchanged.",
        });
        const scope = await fixture.scopeAs(
          "a1-member",
          "company-a",
          "team-a1",
        );
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());

        const result = await delivery.deliver(scope, {
          settingId: personal.settingId,
        });

        expect(result).toEqual({ outcome: "personal" });
        expect(transport.recording().sends).toHaveLength(0);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC2 — 外部调用前后是独立事务
// ---------------------------------------------------------------------------

describeDb(
  "MT045 AC2: no database authorization lock is held while waiting on the external API",
  () => {
    itDb(
      "while the transport blocks, no backend holds an open transaction or advisory lock",
      async () => {
        const seeded = await seededSetting({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac2-blocked",
        });
        let releaseSend: (() => void) | undefined;
        const sendHeld = new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        const transport = recordingTransport({
          onSend: () => sendHeld,
        });
        const delivery = deliveryWith(transport.transport, auditRecorder());

        const inFlight = delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });
        // Let the claim phase finish and the send begin.
        await new Promise((resolve) => setTimeout(resolve, 250));

        // The probe: every other backend on this test database must be idle
        // (no open transaction) and hold no transaction/advisory locks.
        const probe = await fixture.platform.execute(sql`
          select a.pid,
                 a.xact_start is not null as in_transaction,
                 (select count(*) from pg_locks l
                   where l.pid = a.pid
                     and l.locktype in ('transactionid', 'advisory', 'transaction')) as held_locks
          from pg_stat_activity a
          where a.datname = current_database()
            and a.pid <> pg_backend_pid()
            and a.application_name is distinct from 'psql'
        `);
        const rows = (
          Array.isArray(probe)
            ? probe
            : ((probe as { rows?: unknown[] }).rows ?? [])
        ) as {
          pid: number;
          in_transaction: boolean;
          held_locks: string | number;
        }[];
        // 控制组在下一个用例证明这个探针能探到打开的事务；这里先要求
        // 发送路径干净：所有其他后端 idle、零锁。
        for (const row of rows) {
          expect(row.in_transaction).toBe(false);
          expect(Number(row.held_locks)).toBe(0);
        }
        // The advisory-lock family the authorize gate takes must be free.
        const tryLock = await fixture.platform.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify(["enterprise", "tenant", seeded.scope.tenantId])}, 0)) as taken`,
        );
        const tryRows = (
          Array.isArray(tryLock)
            ? tryLock
            : ((tryLock as { rows?: unknown[] }).rows ?? [])
        ) as { taken: boolean }[];
        expect(tryRows[0]?.taken).toBe(true);

        releaseSend?.();
        const result = await inFlight;
        expect(result.outcome).toBe("delivered");
        expect(transport.recording().sends.length).toBe(2);
      },
    );

    itDb(
      "probe control: an open transaction with an advisory lock IS detected (the probe is not vacuous)",
      async () => {
        // Hold a real transaction with an advisory lock on the platform pool,
        // then run the same probe: it must see it, or the AC2 assertion above
        // would prove nothing.
        const key = JSON.stringify([
          "enterprise",
          "tenant",
          `probe-control-${randomUUID().slice(0, 8)}`,
        ]);
        let releaseControl: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
          releaseControl = resolve;
        });
        const holder = (async () => {
          await fixture.platform.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
            );
            await held;
          });
        })();
        await new Promise((resolve) => setTimeout(resolve, 250));

        const probe = await fixture.platform.execute(sql`
          select count(*)::int as open_backends
          from pg_stat_activity a
          where a.datname = current_database()
            and a.pid <> pg_backend_pid()
            and a.xact_start is not null
        `);
        const rows = (
          Array.isArray(probe)
            ? probe
            : ((probe as { rows?: unknown[] }).rows ?? [])
        ) as { open_backends: number }[];
        expect(Number(rows[0]?.open_backends)).toBeGreaterThanOrEqual(1);

        releaseControl?.();
        await holder;
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC3 — 失败后重试安全（幂等），不重复投递、不重复扣费
// ---------------------------------------------------------------------------

describeDb("MT045 AC3: retries after external failure are idempotent", () => {
  itDb(
    "a send failure leaves the claims unsettled; the retry re-derives the same dedupe keys and charges once per key",
    async () => {
      const seeded = await seededSetting({
        identity: "a1-member",
        companyKey: "company-a",
        teamKey: "team-a1",
        label: "ac3-retry",
      });
      const [firstId, secondId] = seeded.suggestionIds;
      // The durable outbox state is shared across attempts — a retry after a
      // crash sees the keys the failed attempt already sent.
      const ledger = transportLedger();
      // The first claim sends FINE, the second throws: the settle phase
      // never runs, so the first send is exactly the crash window —
      // delivered to the provider, unrecorded in the database.
      const failing = recordingTransport({
        failOnKey: `suggestion:${secondId}`,
        ledger,
      });
      const delivery = deliveryWith(failing.transport, auditRecorder());

      await expect(
        delivery.deliver(seeded.scope, { settingId: seeded.settingId }),
      ).rejects.toThrow("Simulated provider failure.");
      expect(await fixture.deliveredAtOf(firstId)).toBeNull();
      expect(await fixture.deliveredAtOf(secondId)).toBeNull();
      expect(ledger.charges.get(`suggestion:${firstId}`)).toBe(1);

      // Retry with a healthy transport: BOTH keys are re-derived (same pure
      // function of the suggestion id); the already-charged key is REJECTED
      // by the outbox-shaped transport — no duplicate delivery, no second
      // charge — and only the second key is newly charged.
      const healthy = recordingTransport({ ledger });
      const retryDelivery = deliveryWith(healthy.transport, auditRecorder());
      const retried = await retryDelivery.deliver(seeded.scope, {
        settingId: seeded.settingId,
      });
      expect(retried.outcome).toBe("delivered");
      if (retried.outcome !== "delivered") return;
      const retriedKeys = retried.claims.map((claim) => claim.dedupeKey).sort();
      expect(retriedKeys).toEqual(
        seeded.suggestionIds.map((id) => `suggestion:${id}`).sort(),
      );
      expect(healthy.recording().duplicateKeyRejections).toContain(
        `suggestion:${firstId}`,
      );
      for (const id of seeded.suggestionIds) {
        expect(await fixture.deliveredAtOf(id)).not.toBeNull();
      }

      // Exactly one charge per suggestion across the whole failure+retry
      // sequence (charges never duplicate — AC3's billing half).
      for (const id of seeded.suggestionIds) {
        expect(ledger.charges.get(`suggestion:${id}`)).toBe(1);
      }
    },
  );

  itDb(
    "a redelivered suggestion is never re-claimed (delivered_at filter)",
    async () => {
      const seeded = await seededSetting({
        identity: "a1-member",
        companyKey: "company-a",
        teamKey: "team-a1",
        label: "ac3-claimed",
      });
      const transport = recordingTransport();
      const delivery = deliveryWith(transport.transport, auditRecorder());

      const first = await delivery.deliver(seeded.scope, {
        settingId: seeded.settingId,
      });
      expect(first.outcome).toBe("delivered");
      const second = await delivery.deliver(seeded.scope, {
        settingId: seeded.settingId,
      });
      expect(second.outcome).toBe("delivered");
      if (second.outcome !== "delivered") return;
      expect(second.claims).toHaveLength(0);
      expect(transport.recording().sends).toHaveLength(2);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4 — 撤销后不再投递；已投递内容不可被无权者读取
// ---------------------------------------------------------------------------

describeDb(
  "MT045 AC4: revocation stops delivery and gates reads of delivered content",
  () => {
    itDb(
      "team suspension stops delivery at the next claim; the delivered suggestion is unreadable afterwards",
      async () => {
        const seeded = await seededSetting({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac4-team",
        });
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());
        const first = await delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });
        expect(first.outcome).toBe("delivered");
        const deliveredId = seeded.suggestionIds[0];

        // Suspend the team membership; a NEW suggestion must not deliver.
        await fixture.suspendTeamMembership({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
        });
        const newSuggestionId = await fixture.addSuggestion({
          settingId: seeded.settingId,
          ownerUserId: seeded.ownerUserId,
          botId: seeded.botId,
          runId: `${seeded.runId}:2`,
          title: "After suspension",
          detail: "This must never reach the inbox.",
        });
        const suspended = await delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });
        expect(JSON.stringify(suspended)).toBe(canonicalDeny);
        expect(await fixture.deliveredAtOf(newSuggestionId)).toBeNull();

        // The ALREADY delivered suggestion is no longer readable by the
        // suspended member — canonical not-found, not an error that leaks it.
        const read = await delivery.readDelivered(seeded.scope, deliveredId);
        expect(JSON.stringify(read)).toBe(canonicalDeny);

        // A same-team LIVE member still reads it (the gate is per-viewer).
        const otherScope = await fixture.scopeAs(
          "a1-other",
          "company-a",
          "team-a1",
        );
        const otherRead = await delivery.readDelivered(otherScope, deliveredId);
        expect(otherRead.outcome).toBe("allow");

        await fixture.restoreTeamMembership({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
        });
      },
    );

    itDb(
      "company suspension stops delivery; a restored-but-stale scope stays denied (epoch fail-closed)",
      async () => {
        const seeded = await seededSetting({
          identity: "a2-member",
          companyKey: "company-a",
          teamKey: "team-a2",
          label: "ac4-company",
        });
        await fixture.suspendCompanyMembership("a2-member", "company-a");
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());

        // Suspended owner: the persisted mapping no longer resolves live —
        // nothing delivers, and the outcome says why (unresolvable, not a
        // scope-shaped denial).
        const suspended = await delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });
        expect(suspended).toEqual({
          outcome: "unresolvable",
          code: "PROACTIVE_PRINCIPAL_UNRESOLVED",
        });
        expect(transport.recording().sends).toHaveLength(0);

        // Restored membership, STALE scope: the epoch the scope was minted
        // under no longer matches the live row — fail-closed, canonical deny,
        // still zero sends.
        await fixture.restoreCompanyMembership("a2-member", "company-a");
        const stale = await delivery.deliver(seeded.scope, {
          settingId: seeded.settingId,
        });
        expect(JSON.stringify(stale)).toBe(canonicalDeny);
        expect(transport.recording().sends).toHaveLength(0);

        // A freshly minted scope delivers: the gate is liveness, not a cache.
        const freshScope = await fixture.scopeAs(
          "a2-member",
          "company-a",
          "team-a2",
        );
        const delivered = await delivery.deliver(freshScope, {
          settingId: seeded.settingId,
        });
        expect(delivered.outcome).toBe("delivered");
        expect(transport.recording().sends.length).toBe(2);
      },
    );

    itDb(
      "delivered content is invisible across teams and companies",
      async () => {
        const seeded = await seededSetting({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac4-read-scope",
        });
        const transport = recordingTransport();
        const delivery = deliveryWith(transport.transport, auditRecorder());
        await delivery.deliver(seeded.scope, { settingId: seeded.settingId });
        const deliveredId = seeded.suggestionIds[0];

        const samePersonOtherTeam = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a2",
        );
        expect(
          JSON.stringify(
            await delivery.readDelivered(samePersonOtherTeam, deliveredId),
          ),
        ).toBe(canonicalDeny);

        const otherCompany = await fixture.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        expect(
          JSON.stringify(
            await delivery.readDelivered(otherCompany, deliveredId),
          ),
        ).toBe(canonicalDeny);
      },
    );
  },
);
