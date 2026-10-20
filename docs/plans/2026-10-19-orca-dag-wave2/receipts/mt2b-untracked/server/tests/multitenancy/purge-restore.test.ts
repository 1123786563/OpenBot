// server/tests/multitenancy/purge-restore.test.ts
// MT068（Issue #111）：清理、保留与恢复带可核验归属与不可伪造 manifest。
//
// 验收事实源（Issue #111 四条，逐条对应 describe；真实 PostgreSQL，全程受
// 限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：manifest 由服务端依据归属生成并签名/校验；客户端提交的
//     manifest（载荷键：清单/签名/内容）被响亮拒绝。
//   验收 2：清理只触及 manifest 列出的范围；跨公司资源不被扫描或删除。
//   验收 3：restore 只恢复到原归属范围，不产生跨范围数据。
//   验收 4：操作全程留审计（sealed/executed/restored 只追加），失败可
//     安全重跑（幂等键收敛；已执行 manifest 重跑 = allow(already)）。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import type { IsolationFixture } from "./support/fixture";
import {
  createPurgeRestoreFixture,
  type PurgeRestoreFixture,
} from "./support/purge-restore";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT068 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

const isNotFound = (value: unknown): boolean =>
  JSON.stringify(value) ===
  JSON.stringify({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: PurgeRestoreFixture;
let isolation: IsolationFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamB1 = "";
let targetA = "";
let witnessB = "";
let manifestId = "";

describeDb(
  "MT068 purge, retention and restore carry verifiable ownership and unforgeable manifests (Issue #111)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT068 tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方（与 MT035/MT039/MT040 同款；已应用过的库返回 up-to-date 合法）。
      const dryRunOutcome = await runMigrateTest(["migrate", "MT068"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT068 dry-run refused: ${dryRunOutcome.reason}`);
      }
      const manifestPath = `/tmp/mt068-manifest-file-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT068")), null, 2)}\n`,
      );
      let applyOutcome: RunOutcome | undefined;
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT068", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      if (
        applyOutcome.kind !== "applied" &&
        applyOutcome.kind !== "up-to-date"
      ) {
        throw new Error(
          `MT068 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }

      fixture = await createPurgeRestoreFixture();
      isolation = fixture.base.isolation;
      companyA = isolation.ids["company-a"];
      companyB = isolation.ids["company-b"];
      teamA1 = isolation.ids["team-a1"];
      teamB1 = isolation.ids["team-b1"];

      targetA = await fixture.seedResource({
        tenantId: companyA,
        workspaceId: teamA1,
        displayName: "MT068 Target A",
      });
      witnessB = await fixture.seedResource({
        tenantId: companyB,
        workspaceId: teamB1,
        displayName: "MT068 Witness B",
      });

      const admin = await fixture.scopeAs("a1-member", companyA, teamA1);
      const built = await fixture.purge.buildPurgeManifest(admin, {
        operation: "purge",
        workspaceId: teamA1,
      });
      if (built.outcome !== "allow") {
        throw new Error(`fixture manifest failed: ${JSON.stringify(built)}`);
      }
      manifestId = built.manifestId;
      if (built.itemCount < 1) {
        throw new Error("fixture manifest enumerated no items");
      }
    });

    test("AC1 · manifests are server-generated and signed; client payloads are rejected", async () => {
      const admin = await fixture.scopeAs("a1-member", companyA, teamA1);
      // 服务端生成：同一归属可重复生成（各得新 manifest），签名内嵌。
      const again = await fixture.purge.buildPurgeManifest(admin, {
        operation: "retention",
        workspaceId: teamA1,
      });
      expect(again.outcome).toBe("allow");

      // 客户端提交的 manifest（载荷键：清单/签名）一律响亮拒绝。
      await expect(
        fixture.purge.buildPurgeManifest(admin, {
          operation: "purge",
          workspaceId: teamA1,
          itemRefs: [targetA],
        } as never),
      ).rejects.toThrow("MANIFEST_NOT_CLIENT_DECLARABLE");
      await expect(
        fixture.purge.buildPurgeManifest(admin, {
          operation: "purge",
          workspaceId: teamA1,
          signature: "0".repeat(128),
        } as never),
      ).rejects.toThrow("MANIFEST_NOT_CLIENT_DECLARABLE");

      // 执行入口同样不接受内联清单。
      await expect(
        fixture.purge.executePurge(admin, {
          manifestId,
          itemRefs: [targetA],
        } as never),
      ).rejects.toThrow("MANIFEST_NOT_CLIENT_DECLARABLE");
    });

    test("AC2 · purge touches only manifest-listed scope; cross-company untouched", async () => {
      const admin = await fixture.scopeAs("a1-member", companyA, teamA1);
      expect(await fixture.statusOf(companyA, targetA)).toBe("active");

      const executed = await fixture.purge.executePurge(admin, { manifestId });
      expect(executed.outcome).toBe("allow");
      if (executed.outcome === "allow") {
        expect((executed.purgedCount as number) ?? 0).toBeGreaterThanOrEqual(1);
      }

      // 清单内资源被清理；范围外（B 公司）资源原样。
      expect(await fixture.statusOf(companyA, targetA)).toBe("deleted");
      expect(await fixture.statusOf(companyB, witnessB)).toBe("active");

      // 跨公司执行者对 manifest 不可见（canonical not-found）。
      const b1 = await fixture.scopeAs("b1-member", companyB, teamB1);
      expect(
        isNotFound(await fixture.purge.executePurge(b1, { manifestId })),
      ).toBe(true);

      // B 自己生成 manifest：枚举按调用者归属（B 范围），A 公司资源
      // 不进任何 B 的清单——不存在"仅凭 user_id 扫全库"的通道。
      const bManifest = await fixture.purge.buildPurgeManifest(b1, {
        operation: "purge",
        workspaceId: teamB1,
      });
      expect(bManifest.outcome).toBe("allow");
      const bExecuted = await fixture.purge.executePurge(b1, {
        manifestId: (bManifest as { manifestId: string }).manifestId,
      });
      expect(bExecuted.outcome).toBe("allow");
      expect(await fixture.statusOf(companyB, witnessB)).toBe("deleted");
      expect(await fixture.statusOf(companyA, targetA)).toBe("deleted"); // A 不受 B 操作影响
    });

    test("AC3 · restore returns items only to their original scope", async () => {
      const admin = await fixture.scopeAs("a1-member", companyA, teamA1);
      expect(await fixture.statusOf(companyA, targetA)).toBe("deleted");

      const restored = await fixture.purge.restoreFromManifest(admin, {
        manifestId,
      });
      expect(restored.outcome).toBe("allow");
      expect(await fixture.statusOf(companyA, targetA)).toBe("active");

      // 跨范围调用者（他团队）对 manifest 不可见：不产生跨范围数据。
      const a2 = await fixture.scopeAs(
        "a2-member",
        companyA,
        isolation.ids["team-a2"],
      );
      expect(
        isNotFound(await fixture.purge.restoreFromManifest(a2, { manifestId })),
      ).toBe(true);

      // 重复 restore：范围谓词只命中 deleted 行——已恢复项不再变动，
      // 结果收敛（不产生第二份数据）。
      const replay = await fixture.purge.restoreFromManifest(admin, {
        manifestId,
      });
      expect(replay.outcome).toBe("allow");
      if (replay.outcome === "allow") {
        expect(replay.restoredCount).toBe(0);
      }
    });

    test("AC4 · audit trail is append-only and replays are idempotent", async () => {
      const admin = await fixture.scopeAs("a1-member", companyA, teamA1);

      // 已执行 manifest 重跑 = allow(already)，不是失败；审计记 no-op。
      const replay = await fixture.purge.executePurge(admin, { manifestId });
      expect(replay.outcome).toBe("allow");
      if (replay.outcome === "allow") {
        expect(replay.already).toBe(true);
      }

      const audit = await fixture.purge.listAudit(admin, { manifestId });
      const events = audit.map((row) => row.event);
      expect(events).toContain("sealed");
      expect(
        events.filter((event) => event === "executed").length,
      ).toBeGreaterThanOrEqual(2);
      expect(events).toContain("restored");

      // 不存在的 manifest：审计为空 + canonical not-found（不泄露存在性）。
      expect(
        isNotFound(
          await fixture.purge.executePurge(admin, {
            manifestId: `${manifestId}-none`,
          }),
        ),
      ).toBe(true);

      // 撤权后发起权限失效：先签发 scope，再 MT006 真实 suspend（epoch
      // 递增），已签发 scope 的下一个敏感动作 canonical not-found。
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);
      await fixture.suspendCompanyMembership("a1-member", companyA);
      expect(
        isNotFound(
          await fixture.purge.buildPurgeManifest(member, {
            operation: "purge",
            workspaceId: teamA1,
          }),
        ),
      ).toBe(true);
    });
  },
);
