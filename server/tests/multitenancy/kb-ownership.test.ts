// server/tests/multitenancy/kb-ownership.test.ts
// MT036（Issue #79）：知识库的团队归属与受限查询（独立库，不假装跨库外键）。
//
// 验收事实源（Issue #79 验收 1–4，逐条对应 describe；覆盖父 Spec A1/A2/A4）：
//   (1) 列表与查询只返回当前范围的库；用另一公司的库 ID 访问返回不可见语义。
//   (2) 归属变更（迁移或团队调整）后查询结果立即反映，无缓存残留。
//   (3) 跨库引用通过同步版本与调用时授权校验；缺失或不一致时拒绝而不是放行。
//   (4) 知识库侧的内部服务身份不能被普通请求用来获得无限公司范围。
//
// 机制：主库（企业测试库）持 KB 注册（enterprise_resources kind='knowledge'）
// 与授权判定（MT008 注册表，只读消费；受限 data 角色 + 真实 RLS + 事务本地
// 上下文 + advisory 共享锁同键族）；KB 专用测试库持内容行与归属镜像状态行
// （knowledge_base_ownership_states，专用受限登录属主通道）。一致性由调用时
// 授权 + 同步版本令牌（kbSyncVersionOf）逐次比对保证，无任何缓存层。
//
// 环境契约：ENTERPRISE_TEST_SETUP_DATABASE_URL（或 TEST_DATABASE_URL）+
// KB_TEST_DATABASE_URL 缺一整套显式 skip，绝不回退开发库、skipped 不计通过。
// 迁移链按 brief 依赖序幂等 apply（MT004→…→MT069）；KB 库经 drizzle-kb
// journal 幂等迁移。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  compareKbOwnershipSnapshot,
  createKbOwnershipAuthority,
  KNOWLEDGE_RESOURCE_KIND,
  kbSyncVersionOf,
} from "../../src/enterprise/tenancy/kb-ownership";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { createRestrictedKbQueryService } from "../../src/kb/application/service/kb-restricted-query";
import { knowledgeBases } from "../../src/kb/db/schema";
import {
  applyKbOwnershipMigrations,
  createKbOwnershipFixture,
  type KbOwnershipFixture,
  probeKbOwnershipEnvironment,
} from "./support/kb-ownership";

const ENV = probeKbOwnershipEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** 主库迁移链（brief 依赖序；幂等：applied | up-to-date）。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
  "MT077",
  "MT026",
  "MT076",
  "MT069",
] as const;

/** 断言 promise 以指定哨兵码拒绝（纯码形态，零值回显）。 */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error && error.message === code).toBe(true);
    return;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

/** canonical 不可见结果（与 not-found-semantics 单一事实源同字节）。 */
const INVISIBLE = {
  ok: false as const,
  kind: "invisible" as const,
  verdict: notFoundVerdict(),
};

describeDb("MT036 — 知识库团队归属与受限查询", () => {
  let fixture: KbOwnershipFixture;
  let authority: ReturnType<typeof createKbOwnershipAuthority>;
  let service: ReturnType<typeof createRestrictedKbQueryService>;
  let tenantA = "";
  let tenantB = "";
  let teamA1 = "";
  let teamA2 = "";
  let teamB1 = "";
  let resourceA1Bot = "";
  // 种子库。
  let kbA1Pub = "";
  let kbA1Grant = "";
  let kbA1Move = "";
  let kbA1MoveNsync = "";
  let kbA1Del = "";
  let kbA1Drift = "";
  let kbA2Pub = "";
  let kbB1Grant = "";
  const missingKbId = "mt036-nonexistent-kb-id";

  beforeAll(async () => {
    if (!ENV.ok) return;

    // 主库迁移链按 brief 依赖序经 MT003 工具真实执行（幂等）。
    const resolved = resolveTestDatabaseTarget(process.env);
    if (!resolved.ok) {
      throw new Error(`MT036 migration target refused: ${resolved.reason}`);
    }
    const migrationEnv = { TEST_DATABASE_URL: resolved.target.url };
    for (const task of MIGRATION_CHAIN) {
      const dryRun: RunOutcome = await runMigrateTest(["migrate", task], {
        environment: migrationEnv,
        out: () => {},
      });
      if (dryRun.kind !== "dry-run") {
        throw new Error(`${task} dry-run failed: ${JSON.stringify(dryRun)}`);
      }
      const manifestPath = `/tmp/mt036-manifest-${task}-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan(task)), null, 2)}\n`,
      );
      try {
        const applied: RunOutcome = await runMigrateTest(
          ["migrate", task, "--apply", "--manifest", manifestPath],
          { environment: migrationEnv, out: () => {} },
        );
        if (!["applied", "up-to-date"].includes(applied.kind)) {
          throw new Error(`${task} apply failed: ${JSON.stringify(applied)}`);
        }
      } finally {
        await rm(manifestPath, { force: true });
      }
    }

    // KB 专用测试库迁移（drizzle-kb journal，幂等）。
    await applyKbOwnershipMigrations();

    fixture = await createKbOwnershipFixture();
    const ids = fixture.ent.isolation.ids;
    tenantA = ids["company-a"];
    tenantB = ids["company-b"];
    teamA1 = ids["team-a1"];
    teamA2 = ids["team-a2"];
    teamB1 = ids["team-b1"];
    resourceA1Bot = ids["resource-a1"];

    // 公司 A 翻到 workspace-v1（团队公共语义；MT011 同款披露 stand-in）；
    // 公司 B 保持 tenancy-v1（授权语义混合覆盖）。
    await fixture.setTenantPolicyRevision(tenantA, "workspace-v1");

    const scopeA1 = { tenantId: tenantA, workspaceId: teamA1 };
    const scopeA2 = { tenantId: tenantA, workspaceId: teamA2 };
    kbA1Pub = await fixture.seedKnowledgeBase({
      key: "kb-a1-pub",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 team-public KB",
      visibility: "workspace",
    });
    kbA1Grant = await fixture.seedKnowledgeBase({
      key: "kb-a1-grant",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 grant-only KB",
      readers: [
        { identity: "a1-member", teamKey: "team-a1" },
        { identity: "a1a2-member", teamKey: "team-a1" },
      ],
    });
    kbA1Move = await fixture.seedKnowledgeBase({
      key: "kb-a1-move",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 move-me KB",
      visibility: "workspace",
    });
    kbA1MoveNsync = await fixture.seedKnowledgeBase({
      key: "kb-a1-mvns",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 move-without-sync KB",
      visibility: "workspace",
    });
    kbA1Del = await fixture.seedKnowledgeBase({
      key: "kb-a1-del",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 deletable KB",
      visibility: "workspace",
    });
    kbA2Pub = await fixture.seedKnowledgeBase({
      key: "kb-a2-pub",
      tenantId: tenantA,
      workspaceId: teamA2,
      name: "A2 team-public KB",
      visibility: "workspace",
    });
    kbB1Grant = await fixture.seedKnowledgeBase({
      key: "kb-b1-grant",
      tenantId: tenantB,
      workspaceId: teamB1,
      name: "B1 grant-only KB",
      readers: [
        { identity: "b1-member", teamKey: "team-b1" },
        { identity: "multi-company", teamKey: "team-b1" },
      ],
    });
    kbA1Drift = await fixture.seedKnowledgeBase({
      key: "kb-a1-drift",
      tenantId: tenantA,
      workspaceId: teamA1,
      name: "A1 drift-demo KB",
      visibility: "workspace",
    });

    authority = createKbOwnershipAuthority(fixture.ent.data);
    service = createRestrictedKbQueryService({
      authority,
      kbDb: fixture.kbDb,
    });
    void scopeA1;
    void scopeA2;
  }, 120000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  // -----------------------------------------------------------------
  // AC1：列表与查询只返回当前范围的库；他司/跨团队库 ID 不可见语义。
  // -----------------------------------------------------------------
  describeDb("MT036 AC1: 范围内列表/查询与他司不可见", () => {
    itDb(
      "a1-member 的列表只含 A1 范围内可见库；计数不泄露不可见库",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const listed = await service.listKnowledgeBases({ scope });
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        expect(new Set(listed.items.map((item) => item.id))).toEqual(
          new Set([
            kbA1Pub,
            kbA1Grant,
            kbA1Move,
            kbA1MoveNsync,
            kbA1Del,
            kbA1Drift,
          ]),
        );
        expect(listed.items).toHaveLength(6);
      },
    );

    itDb("列表按 scope 选择：同公司双成员各自只见自己团队的库", async () => {
      const scopeA1 = await fixture.ent.scopeFor("a1a2-member", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      const scopeA2 = await fixture.ent.scopeFor("a1a2-member", {
        tenantId: tenantA,
        workspaceId: teamA2,
      });
      const listedA1 = await service.listKnowledgeBases({ scope: scopeA1 });
      const listedA2 = await service.listKnowledgeBases({ scope: scopeA2 });
      expect(listedA1.ok && listedA2.ok).toBe(true);
      if (!listedA1.ok || !listedA2.ok) return;
      expect(new Set(listedA1.items.map((item) => item.id))).toEqual(
        new Set([
          kbA1Pub,
          kbA1Grant,
          kbA1Move,
          kbA1MoveNsync,
          kbA1Del,
          kbA1Drift,
        ]),
      );
      expect(new Set(listedA2.items.map((item) => item.id))).toEqual(
        new Set([kbA2Pub]),
      );
    });

    itDb(
      "团队公共放行：workspace-v1 下无授权同团队成员可见公共库，不见授权库",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-other", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const listed = await service.listKnowledgeBases({ scope });
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        expect(new Set(listed.items.map((item) => item.id))).toEqual(
          new Set([kbA1Pub, kbA1Move, kbA1MoveNsync, kbA1Del, kbA1Drift]),
        );
        const granted = await service.getKnowledgeBase({ scope }, kbA1Grant);
        expect(granted).toEqual(INVISIBLE);
        const publicOne = await service.getKnowledgeBase({ scope }, kbA1Pub);
        expect(publicOne.ok).toBe(true);
      },
    );

    itDb("tenancy-v1 公司保持授权语义：B1 仅授权人可见", async () => {
      const scopeB1 = await fixture.ent.scopeFor("b1-member", {
        tenantId: tenantB,
        workspaceId: teamB1,
      });
      const listed = await service.listKnowledgeBases({ scope: scopeB1 });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.items.map((item) => item.id)).toEqual([kbB1Grant]);
      // multi-company 在 A1 scope 也不因 B 授权而看见 A 的授权库。
      const scopeA1 = await fixture.ent.scopeFor("multi-company", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      const listedA1 = await service.listKnowledgeBases({ scope: scopeA1 });
      expect(listedA1.ok).toBe(true);
      if (!listedA1.ok) return;
      expect(new Set(listedA1.items.map((item) => item.id))).toEqual(
        new Set([kbA1Pub, kbA1Move, kbA1MoveNsync, kbA1Del, kbA1Drift]),
      );
    });

    itDb("另一公司的库 ID：不可见语义与不存在逐字节相同", async () => {
      const scope = await fixture.ent.scopeFor("b1-member", {
        tenantId: tenantB,
        workspaceId: teamB1,
      });
      const crossCompany = await service.getKnowledgeBase({ scope }, kbA1Pub);
      const nonexistent = await service.getKnowledgeBase(
        { scope },
        missingKbId,
      );
      expect(crossCompany).toEqual(INVISIBLE);
      expect(nonexistent).toEqual(INVISIBLE);
      // 字节级钉死：两个不可见回答序列化后逐字节相同。
      expect(
        serializeNotFoundVerdict(
          crossCompany.ok === false && crossCompany.kind === "invisible"
            ? crossCompany.verdict
            : notFoundVerdict(),
        ),
      ).toBe(serializeNotFoundVerdict(notFoundVerdict()));
    });

    itDb("同公司跨团队：不可见语义与不存在逐字节相同", async () => {
      const scope = await fixture.ent.scopeFor("a2-member", {
        tenantId: tenantA,
        workspaceId: teamA2,
      });
      const crossTeam = await service.getKnowledgeBase({ scope }, kbA1Pub);
      const nonexistent = await service.getKnowledgeBase(
        { scope },
        missingKbId,
      );
      expect(crossTeam).toEqual(nonexistent);
      expect(nonexistent).toEqual(INVISIBLE);
    });

    itDb(
      "suspended 成员立即失去团队公共路径；授权路径保留；恢复后复得",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        // 停用前两条路径都可见（基线）。
        expect((await service.getKnowledgeBase({ scope }, kbA1Pub)).ok).toBe(
          true,
        );
        expect((await service.getKnowledgeBase({ scope }, kbA1Grant)).ok).toBe(
          true,
        );
        await fixture.ent.setTeamMembershipStatus(
          "a1-member",
          "team-a1",
          "suspended",
        );
        // 同一受信 scope，停用后：团队公共立即不可见（调用时读当前事实）。
        expect(await service.getKnowledgeBase({ scope }, kbA1Pub)).toEqual(
          INVISIBLE,
        );
        // 显式授权路径按 MT008 语义不受成员状态影响。
        expect((await service.getKnowledgeBase({ scope }, kbA1Grant)).ok).toBe(
          true,
        );
        // 新取证被 seam 拒绝（停用成员拿不到 scope）。
        await expectSentinelRejection(
          fixture.ent.scopeFor("a1-member", {
            tenantId: tenantA,
            workspaceId: teamA1,
          }),
          "WORKSPACE_FORBIDDEN",
        );
        await fixture.ent.setTeamMembershipStatus(
          "a1-member",
          "team-a1",
          "active",
        );
        expect((await service.getKnowledgeBase({ scope }, kbA1Pub)).ok).toBe(
          true,
        );
      },
    );
  });

  // -----------------------------------------------------------------
  // AC2：归属变更后查询结果立即反映，无缓存残留。
  // -----------------------------------------------------------------
  describeDb("MT036 AC2: 归属变更立即反映", () => {
    itDb(
      "归属迁移（A1→A2）后旧团队立即失去、新团队立即获得、列表即时翻转",
      async () => {
        const scopeA1 = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const scopeA2 = await fixture.ent.scopeFor("a2-member", {
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        expect(
          (await service.getKnowledgeBase({ scope: scopeA1 }, kbA1Move)).ok,
        ).toBe(true);
        expect(
          await service.getKnowledgeBase({ scope: scopeA2 }, kbA1Move),
        ).toEqual(INVISIBLE);

        await fixture.moveKnowledgeBaseOwnership({
          tenantId: tenantA,
          kbId: kbA1Move,
          toWorkspaceId: teamA2,
          syncKbSide: true,
        });

        // 立即（下一次调用）反映：旧团队不可见、新团队可见。
        expect(
          await service.getKnowledgeBase({ scope: scopeA1 }, kbA1Move),
        ).toEqual(INVISIBLE);
        const after = await service.getKnowledgeBase(
          { scope: scopeA2 },
          kbA1Move,
        );
        expect(after.ok).toBe(true);
        if (after.ok) {
          expect(after.kb.workspaceId).toBe(teamA2);
        }
        // 连发多次结果一致（无缓存残留；每次调用重新求值）。
        for (let i = 0; i < 3; i += 1) {
          expect(
            await service.getKnowledgeBase({ scope: scopeA1 }, kbA1Move),
          ).toEqual(INVISIBLE);
          expect(
            (await service.getKnowledgeBase({ scope: scopeA2 }, kbA1Move)).ok,
          ).toBe(true);
        }
        // 列表即时翻转。
        const listedA1 = await service.listKnowledgeBases({ scope: scopeA1 });
        const listedA2 = await service.listKnowledgeBases({ scope: scopeA2 });
        expect(listedA1.ok && listedA2.ok).toBe(true);
        if (listedA1.ok && listedA2.ok) {
          expect(listedA1.items.map((item) => item.id)).not.toContain(kbA1Move);
          expect(listedA2.items.map((item) => item.id)).toContain(kbA1Move);
        }
      },
    );

    itDb("迁移未同步 KB 侧镜像：不一致拒绝而不是放行", async () => {
      const scopeA2 = await fixture.ent.scopeFor("a2-member", {
        tenantId: tenantA,
        workspaceId: teamA2,
      });
      await fixture.moveKnowledgeBaseOwnership({
        tenantId: tenantA,
        kbId: kbA1MoveNsync,
        toWorkspaceId: teamA2,
        syncKbSide: false,
      });
      const inconsistent = await service.getKnowledgeBase(
        { scope: scopeA2 },
        kbA1MoveNsync,
      );
      expect(inconsistent).toEqual({
        ok: false,
        kind: "ownership-inconsistent",
        code: "KB_OWNERSHIP_WORKSPACE_MISMATCH",
      });
      // 不一致对象不进列表（绝不浮现）。
      const listed = await service.listKnowledgeBases({ scope: scopeA2 });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.items.map((item) => item.id)).not.toContain(
          kbA1MoveNsync,
        );
      }
    });

    itDb(
      "团队不变、版本推进未同步：同步版本 stale 拒绝；补同步后恢复",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect((await service.getKnowledgeBase({ scope }, kbA1Grant)).ok).toBe(
          true,
        );
        await fixture.bumpRegistrationRevision({
          tenantId: tenantA,
          kbId: kbA1Grant,
          syncKbSide: false,
        });
        const stale = await service.getKnowledgeBase({ scope }, kbA1Grant);
        expect(stale).toEqual({
          ok: false,
          kind: "ownership-inconsistent",
          code: "KB_SYNC_VERSION_STALE",
        });
        // 补齐 KB 侧镜像（真实 kbSyncVersionOf）后立即恢复。
        await fixture.syncKbOwnershipState({
          tenantId: tenantA,
          kbId: kbA1Grant,
        });
        expect((await service.getKnowledgeBase({ scope }, kbA1Grant)).ok).toBe(
          true,
        );
      },
    );
  });

  // -----------------------------------------------------------------
  // AC3：跨库引用经同步版本与调用时授权校验；缺失/不一致拒绝。
  // -----------------------------------------------------------------
  describeDb("MT036 AC3: 跨库引用的调用时授权与同步版本", () => {
    itDb(
      "检索收窄：只放行授权且一致的库；未授权/不存在的 ID 不进检索集合",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const narrowed = await service.narrowRetrievalScope({ scope }, [
          kbA1Pub,
          kbA2Pub,
          missingKbId,
        ]);
        expect(narrowed.ok).toBe(true);
        if (!narrowed.ok) return;
        expect(narrowed.allowed).toEqual([kbA1Pub]);
      },
    );

    itDb(
      "MT009 依赖行 active 不 confer 可见性：调用时授权补上传递判定",
      async () => {
        // Bot（resource-a1）声明两条 knowledge 依赖：一条可见、一条跨团队。
        await fixture.seedKnowledgeDependency({
          tenantId: tenantA,
          resourceId: resourceA1Bot,
          kbId: kbA1Pub,
        });
        await fixture.seedKnowledgeDependency({
          tenantId: tenantA,
          resourceId: resourceA1Bot,
          kbId: kbA2Pub,
        });
        // 依赖行确实存在且 active（受限 data 通道读回；bun-sql 驱动下
        // execute 直接返回行数组）。
        const deps = await fixture.ent.data.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantA}, true)`,
          );
          return tx.execute<{
            dependency_ref: string;
          }>(
            sql`select dependency_ref from enterprise_resource_dependencies where tenant_id = ${tenantA} and resource_id = ${resourceA1Bot} and dependency_kind = 'knowledge' and status = 'active' order by dependency_ref`,
          );
        });
        expect(deps.length).toBe(2);
        // 但运行者本人的调用时授权仍是唯一检索面：跨团队依赖引用被收窄掉。
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const narrowed = await service.narrowRetrievalScope({ scope }, [
          kbA1Pub,
          kbA2Pub,
        ]);
        expect(narrowed.ok).toBe(true);
        if (!narrowed.ok) return;
        expect(narrowed.allowed).toEqual([kbA1Pub]);
      },
    );

    itDb("同步版本不一致的库不进检索集合；修复后恢复进入", async () => {
      const scope = await fixture.ent.scopeFor("a1-member", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      await fixture.bumpRegistrationRevision({
        tenantId: tenantA,
        kbId: kbA1Grant,
        syncKbSide: false,
      });
      const narrowed = await service.narrowRetrievalScope({ scope }, [
        kbA1Pub,
        kbA1Grant,
      ]);
      expect(narrowed.ok).toBe(true);
      if (!narrowed.ok) return;
      expect(narrowed.allowed).toEqual([kbA1Pub]);
      await fixture.syncKbOwnershipState({
        tenantId: tenantA,
        kbId: kbA1Grant,
      });
      const repaired = await service.narrowRetrievalScope({ scope }, [
        kbA1Pub,
        kbA1Grant,
      ]);
      expect(repaired.ok).toBe(true);
      if (repaired.ok) {
        expect(repaired.allowed).toEqual([kbA1Pub, kbA1Grant]);
      }
    });

    itDb(
      "KB 内容缺失（注册在、内容行软删）：不可见语义；检索同样排除",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect((await service.getKnowledgeBase({ scope }, kbA1Del)).ok).toBe(
          true,
        );
        await fixture.softDeleteKbRow({ kbId: kbA1Del });
        const gone = await service.getKnowledgeBase({ scope }, kbA1Del);
        expect(gone).toEqual(INVISIBLE);
        const narrowed = await service.narrowRetrievalScope({ scope }, [
          kbA1Pub,
          kbA1Del,
        ]);
        expect(narrowed.ok).toBe(true);
        if (narrowed.ok) {
          expect(narrowed.allowed).toEqual([kbA1Pub]);
        }
      },
    );

    itDb("主库注册缺失（KB 库行在）：KB 库单独不 confer 任何东西", async () => {
      const scope = await fixture.ent.scopeFor("a1-member", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      const orphanId = `${fixture.runId}-orphan`;
      await fixture.kbDb.insert(knowledgeBases).values({
        id: orphanId,
        tenantId: tenantA,
        name: "orphan KB without main-DB registration",
        chunkingConfig: {
          chunkSize: 512,
          chunkOverlap: 64,
          separators: ["\n\n"],
          strategy: "auto",
        },
        embeddingModelId: "mt036-test-embedder",
      });
      const orphan = await service.getKnowledgeBase({ scope }, orphanId);
      expect(orphan).toEqual(INVISIBLE);
      const narrowed = await service.narrowRetrievalScope({ scope }, [
        orphanId,
      ]);
      expect(narrowed.ok).toBe(true);
      if (narrowed.ok) {
        expect(narrowed.allowed).toEqual([]);
      }
    });

    itDb("主库 kind 漂移（注册非 knowledge）：绝不当作知识库服务", async () => {
      const scope = await fixture.ent.scopeFor("a1-member", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      // 把 kb-a1-pub 的主库注册 kind 改成 document（错误注册的漂移形态）。
      await fixture.corruptRegistrationKind({
        tenantId: tenantA,
        kbId: kbA1Pub,
        kind: "document",
      });
      expect(await service.getKnowledgeBase({ scope }, kbA1Pub)).toEqual(
        INVISIBLE,
      );
      const narrowedKind = await service.narrowRetrievalScope({ scope }, [
        kbA1Pub,
      ]);
      expect(narrowedKind.ok).toBe(true);
      if (narrowedKind.ok) {
        expect(narrowedKind.allowed).toEqual([]);
      }
      // 修正回 knowledge 后恢复可见（漂移不是永久状态）。
      await fixture.corruptRegistrationKind({
        tenantId: tenantA,
        kbId: kbA1Pub,
        kind: "knowledge",
      });
      expect((await service.getKnowledgeBase({ scope }, kbA1Pub)).ok).toBe(
        true,
      );
    });

    itDb(
      "KB 库内容行租户漂移（内容库标记错租户）：不可见且不进列表",
      async () => {
        const scope = await fixture.ent.scopeFor("a1-member", {
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        // 内容行被错标成公司 B（跨库内容漂移形态）；主库注册与镜像仍是 A。
        await fixture.kbDb
          .update(knowledgeBases)
          .set({ tenantId: tenantB })
          .where(sql`id = ${kbA1Drift}`);
        expect(await service.getKnowledgeBase({ scope }, kbA1Drift)).toEqual(
          INVISIBLE,
        );
        const listed = await service.listKnowledgeBases({ scope });
        expect(listed.ok).toBe(true);
        if (listed.ok) {
          expect(listed.items.map((item) => item.id)).not.toContain(kbA1Drift);
        }
        // 修正内容行租户后恢复。
        await fixture.kbDb
          .update(knowledgeBases)
          .set({ tenantId: tenantA })
          .where(sql`id = ${kbA1Drift}`);
        expect((await service.getKnowledgeBase({ scope }, kbA1Drift)).ok).toBe(
          true,
        );
      },
    );
  });

  // -----------------------------------------------------------------
  // AC4：内部服务身份不能被普通请求用来获得无限公司范围。
  // -----------------------------------------------------------------
  describeDb("MT036 AC4: 内部服务身份结构性受限", () => {
    itDb(
      "内部 API-Key 身份形状（tenant+role+kbScope）被入口结构性拒绝",
      async () => {
        // 空 kbScope = 公司内全库（旧公司范围 Key）。受限入口在结构上
        // 不接受该形状：三种入口全部 KB_REQUESTER_INVALID，无任何数据返回。
        const internalIdentity = {
          tenantId: tenantA,
          role: "admin",
          kbScope: new Set<string>(),
        };
        await expectSentinelRejection(
          service.getKnowledgeBase(internalIdentity as never, kbA1Pub),
          "KB_REQUESTER_INVALID",
        );
        await expectSentinelRejection(
          service.listKnowledgeBases(internalIdentity as never),
          "KB_REQUESTER_INVALID",
        );
        await expectSentinelRejection(
          service.narrowRetrievalScope(internalIdentity as never, [kbA1Pub]),
          "KB_REQUESTER_INVALID",
        );
      },
    );

    itDb("伪造 scope（非 seam 签发）被信任边界拒绝", async () => {
      const forged = {
        tenantId: tenantA,
        workspaceId: teamA1,
        principalId: "forged-principal",
        actorId: "forged-actor",
      };
      await expectSentinelRejection(
        service.getKnowledgeBase({ scope: forged as never }, kbA1Pub),
        "UNVERIFIED_SCOPE",
      );
      await expectSentinelRejection(
        service.listKnowledgeBases({ scope: forged as never }),
        "UNVERIFIED_SCOPE",
      );
    });

    itDb(
      "受限入口与权威模块不携带内部身份词汇（源码级，注释剥离后）",
      async () => {
        const stripComments = (source: string): string =>
          source.replace(/\/\/.*$/gm, "");
        const entrySource = stripComments(
          await Bun.file(
            "src/kb/application/service/kb-restricted-query.ts",
          ).text(),
        );
        expect(entrySource).not.toContain("kbScope");
        expect(entrySource).not.toContain("APIKeyEntry");
        const authoritySource = stripComments(
          await Bun.file("src/enterprise/tenancy/kb-ownership.ts").text(),
        );
        expect(authoritySource).not.toContain("process.env");
        expect(authoritySource).not.toContain("Bun.env");
        expect(authoritySource).not.toContain("import.meta.env");
      },
    );

    itDb("positive control：seam 签发的受信 scope 正常工作", async () => {
      const scope = await fixture.ent.scopeFor("a1-member", {
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      const got = await service.getKnowledgeBase({ scope }, kbA1Pub);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.kb.id).toBe(kbA1Pub);
        expect(got.kb.workspaceId).toBe(teamA1);
        expect(got.kb.syncVersion).toMatch(/^kb-sync\/v1\//);
      }
    });
  });

  // -----------------------------------------------------------------
  // 纯函数面（离线）：同步版本令牌与一致性比对。
  // -----------------------------------------------------------------
  describe("MT036 纯函数面：同步版本令牌与一致性比对（离线）", () => {
    const registration = {
      tenantId: "tenant-reg",
      kbId: "kb-reg",
      workspaceId: "ws-1",
      status: "active" as const,
      visibility: "workspace" as const,
      revision: 4,
      aclEpoch: 2,
      policyRevision: "workspace-v1",
    };

    test("kbSyncVersionOf 确定性且形状钉死；输入越界响亮拒绝；输出冻结", () => {
      const token = kbSyncVersionOf(registration);
      expect(token).toBe("kb-sync/v1/w=ws-1/r=4/e=2");
      expect(kbSyncVersionOf(registration)).toBe(token);
      expect(Object.isFrozen(token)).toBe(true);
      for (const bad of [
        { ...registration, workspaceId: "" },
        { ...registration, workspaceId: "  " },
        { ...registration, revision: 0 },
        { ...registration, revision: -1 },
        { ...registration, revision: 1.5 },
        { ...registration, aclEpoch: 0 },
      ]) {
        try {
          kbSyncVersionOf(bad);
          throw new Error("expected rejection");
        } catch (error) {
          expect((error as Error).message).toBe("KB_SYNC_INPUT_INVALID");
        }
      }
    });

    test("compareKbOwnershipSnapshot：缺失/租户不符/团队不符/版本 stale/一致 五态", () => {
      const snapshot = {
        tenantId: "tenant-reg",
        workspaceId: "ws-1",
        syncVersion: kbSyncVersionOf(registration),
      };
      expect(compareKbOwnershipSnapshot(registration, snapshot)).toEqual({
        ok: true,
      });
      expect(compareKbOwnershipSnapshot(registration, null)).toEqual({
        ok: false,
        code: "KB_OWNERSHIP_MISSING",
      });
      expect(
        compareKbOwnershipSnapshot(registration, {
          ...snapshot,
          tenantId: "tenant-other",
        }),
      ).toEqual({ ok: false, code: "KB_OWNERSHIP_MISSING" });
      expect(
        compareKbOwnershipSnapshot(registration, {
          ...snapshot,
          workspaceId: "ws-2",
        }),
      ).toEqual({ ok: false, code: "KB_OWNERSHIP_WORKSPACE_MISMATCH" });
      expect(
        compareKbOwnershipSnapshot(registration, {
          ...snapshot,
          syncVersion: "kb-sync/v1/w=ws-1/r=3/e=2",
        }),
      ).toEqual({ ok: false, code: "KB_SYNC_VERSION_STALE" });
    });

    test("一致性比对结果冻结且零回显（canary 输入不出现在任何输出）", () => {
      const canarySnapshot = {
        tenantId: "tenant-sk-mt036-canary",
        workspaceId: "ws-sk-mt036-canary",
        syncVersion: "kb-sync/v1/w=canary/r=1/e=1",
      };
      const mismatch = compareKbOwnershipSnapshot(registration, canarySnapshot);
      expect(mismatch.ok).toBe(false);
      expect(Object.isFrozen(mismatch)).toBe(true);
      const rendered = JSON.stringify(mismatch);
      expect(rendered).not.toContain("canary");
      expect(rendered).not.toContain("sk-mt036");
    });

    test("KNOWLEDGE_RESOURCE_KIND 钉死为 knowledge（主库注册 kind 词汇）", () => {
      expect(KNOWLEDGE_RESOURCE_KIND).toBe("knowledge");
    });
  });

  // -----------------------------------------------------------------
  // 存储契约（KB 库镜像状态行）。
  // -----------------------------------------------------------------
  describeDb("MT036 存储契约：KB 侧归属镜像状态行", () => {
    itDb("knowledge_base_ownership_states 携带归属与同步版本列", async () => {
      const columns = await fixture.kbDb.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'knowledge_base_ownership_states' order by column_name`,
      );
      const names = (columns as unknown as { column_name: string }[]).map(
        (row) => row.column_name,
      );
      expect(names).toEqual([
        "knowledge_base_id",
        "sync_version",
        "tenant_id",
        "updated_at",
        "workspace_id",
      ]);
    });

    itDb("KB 库迁移幂等：重复执行直接收敛", async () => {
      await applyKbOwnershipMigrations();
      await applyKbOwnershipMigrations();
      expect(true).toBe(true);
    });
  });
});
