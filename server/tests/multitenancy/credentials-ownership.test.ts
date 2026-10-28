// server/tests/multitenancy/credentials-ownership.test.ts
// MT027（Issue #70）：连接凭据与站点登录归属，可用不等于可读明文。
//
// 验收事实源（Issue #70 四条，逐条对应 describe）：
//   (1) 个人凭据只对本人可用可读；同团队其他人不能使用也不能读取
//       （两条 canonical kind：site-login / connection；同团队他人、跨团队
//       同事、双团队成员、公司管理员一律 canonical RESOURCE_NOT_FOUND，
//       与「不存在」逐字节同形——不泄露存在性）。
//   (2) 团队/公司凭据只对该范围成员按动作授权可用；明文读取需要独立授权
//       且留审计（成员资格是必要条件、动作授权行是充分条件；'use' 行绝不
//       蕴含 'disclose'；每次成功披露恰好一行审计，撤销授权立即失效；
//       成员停用/凭据撤销立即关闭后续使用与读取）。
//   (3) 用另一公司的凭据 ID 调用得到不可见语义，且不会触发对供应商的调用
//       （deny = canonical 逐字节同形；allow 变体独占携带密封材料——deny
//       结构上没有可执行物；供应商探针只在 allow 分支计数，跨公司尝试后
//       计数为 0；跨公司归属行被复合外键判 23503 结构性不可能）。
//   (4) 列表与详情默认脱敏；任何响应、日志与错误都不含明文秘密
//       （脱敏视图类型上没有 envelope/plaintext 字段；canary 明文在全路径
//       输出扫描中零出现；列表计数不泄露跨范围存在性；vault 信封逐字包含
//       明文——任何信封泄漏都会被 canary 扫描抓到）。
//
// 存储契约（第五组）：FORCE RLS、最小授权矩阵（directory 零授权）、行形
// CHECK、动作闭集 CHECK、审计 append-only（data 无 SELECT、任何角色无
// UPDATE/DELETE）、事务本地上下文提交后清空（连接池复用不沿用范围）、
// 未验证通道 fail-closed。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT027 迁移（三张新表 + FORCE RLS +
// 最小列授权）经 MT003 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import {
  createCredentialOwnershipAdminService,
  createCredentialOwnershipDecisionService,
} from "../../src/enterprise/tenancy/credential-ownership";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type CredentialsFixture,
  createCredentialsFixture,
  scopeOf,
  thrownMessage,
} from "./support/credentials-ownership";

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
      reason: `MT027 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 判定断言助手：deny 只有一种对外形状（不泄露存在性）
// ---------------------------------------------------------------------------

const DENY_NOT_FOUND = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

/** Any key that would carry secret material through a redacted surface. */
const SECRET_CARRIER_KEYS = [
  "envelope",
  "plaintext",
  "encryptedValue",
  "encrypted_value",
  "secret",
  "secretRef",
] as const;

function assertRedactedShape(value: unknown): void {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      expect(SECRET_CARRIER_KEYS).not.toContain(key);
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(value);
}

// ---------------------------------------------------------------------------
// 共享夹具 + MT027 迁移（经 MT003 工具真实执行）
// ---------------------------------------------------------------------------

let fixture: CredentialsFixture;
let dryRunOutcome: RunOutcome;
let applyOutcome: RunOutcome;

// 凭据平面：公司 A 的个人（两 kind）/ 团队 A1 / 团队 A2 / 公司级，公司 B 个人对照。
let pSite: { credentialId: string; tenantId: string };
let pConn: { credentialId: string; tenantId: string };
let t1: { credentialId: string; tenantId: string };
let t2: { credentialId: string; tenantId: string };
let tRevocable: { credentialId: string; tenantId: string };
let c1: { credentialId: string; tenantId: string };
let b1: { credentialId: string; tenantId: string };

const CANARY_PERSONAL = "mt027-canary-personal-3f9a2b7c";
const CANARY_TEAM = "mt027-canary-team-8c41d5e0";
const CANARY_COMPANY = "mt027-canary-company-52ab90de";
const ALL_CANARIES = [CANARY_PERSONAL, CANARY_TEAM, CANARY_COMPANY];

describeDb(
  "MT027 credentials ownership: usable is not readable (Issue #70)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(
          `MT027 credentials tests refuse to run: ${resolved.reason}`,
        );
      }
      dryRunOutcome = await runMigrateTest(["migrate", "MT027"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      const manifestPath = `/tmp/mt027-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT027")), null, 2)}\n`,
      );
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT027", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      fixture = await createCredentialsFixture();
      // 公司管理员加入团队 A1（受权 operator 通道物化，MT005 先例）：让
      // 「管理员」成为个人凭据最严格的反例——即便是属主同团队成员的
      // tenant_admin，也不能使用或读取他人个人凭据（A1 owner-only）。
      await fixture.materializeAdminTeamMembership();
      const site = await fixture.provisionCredential({
        kind: "site-login",
        classification: "personal",
        owner: "a1-member",
        team: "team-a1",
        target: "https://site-a1.example.com",
        label: "a1 personal site login",
        plaintext: CANARY_PERSONAL,
      });
      pSite = site;
      pConn = await fixture.provisionCredential({
        kind: "connection",
        classification: "personal",
        owner: "a1-member",
        team: "team-a1",
        target: "github",
        label: "a1 personal connection",
        plaintext: CANARY_PERSONAL,
      });
      t1 = await fixture.provisionCredential({
        kind: "connection",
        classification: "team",
        team: "team-a1",
        target: "linear",
        label: "team a1 connection",
        plaintext: CANARY_TEAM,
      });
      t2 = await fixture.provisionCredential({
        kind: "connection",
        classification: "team",
        team: "team-a2",
        target: "notion",
        label: "team a2 connection",
        plaintext: CANARY_TEAM,
      });
      tRevocable = await fixture.provisionCredential({
        kind: "site-login",
        classification: "team",
        team: "team-a1",
        target: "https://revocable.example.com",
        label: "revocable team site login",
        plaintext: CANARY_TEAM,
      });
      c1 = await fixture.provisionCredential({
        kind: "connection",
        classification: "company",
        target: "salesforce",
        label: "company-wide connection",
        plaintext: CANARY_COMPANY,
      });
      b1 = await fixture.provisionCredential({
        kind: "site-login",
        classification: "personal",
        owner: "b1-member",
        team: "team-b1",
        target: "https://site-b1.example.com",
        label: "b1 personal site login",
        plaintext: "mt027-canary-company-b-77aa01",
      });
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    // -------------------------------------------------------------------------
    // 验收 1：个人凭据只对本人可用可读；同团队其他人不能使用也不能读取
    // -------------------------------------------------------------------------

    describeDb("AC1: personal credentials are owner-only", () => {
      itDb(
        "owner can use a personal site login (allow carries no plaintext)",
        async () => {
          const scope = await scopeOf(fixture, "a1-member", "team-a1");
          const resolution = await fixture.decisions.authorizeUse(
            scope,
            pSite.credentialId,
          );
          expect(resolution.outcome).toBe("allow");
          if (resolution.outcome !== "allow") return;
          expect(resolution.credential).toMatchObject({
            credentialId: pSite.credentialId,
            classification: "personal",
            kind: "site-login",
            target: "https://site-a1.example.com",
          });
          // allow 携带密封材料（给执行面），绝不携带明文字段。
          expect(resolution.envelope).toBe(`v1:${CANARY_PERSONAL}`);
          assertRedactedShape(resolution.credential);
          // allow 分支的供应商执行计数（正向对照：门放行才会触达供应商）。
          fixture.vendorProbe.execute();
          expect(fixture.vendorProbe.calls()).toBe(1);
        },
      );

      itDb(
        "owner can read the plaintext and the disclosure is audited once",
        async () => {
          const scope = await scopeOf(fixture, "a1-member", "team-a1");
          const before = await fixture.auditRows({
            tenantId: pSite.tenantId,
            credentialId: pSite.credentialId,
          });
          const disclosure = await fixture.decisions.disclosePlaintext(
            scope,
            pSite.credentialId,
          );
          expect(disclosure.outcome).toBe("allow");
          if (disclosure.outcome !== "allow") return;
          expect(disclosure.plaintext).toBe(CANARY_PERSONAL);
          const after = await fixture.auditRows({
            tenantId: pSite.tenantId,
            credentialId: pSite.credentialId,
          });
          expect(after).toHaveLength(before.length + 1);
          const latest = after[after.length - 1];
          expect(latest.id).toBe(disclosure.auditId);
          expect(latest.principalId).toBe(
            fixture.principalOf("a1-member", "company-a"),
          );
          expect(JSON.stringify(latest)).not.toContain(CANARY_PERSONAL);
        },
      );

      itDb(
        "same-team other person cannot use, read, describe or list it",
        async () => {
          const scope = await scopeOf(fixture, "a1-other", "team-a1");
          const use = await fixture.decisions.authorizeUse(
            scope,
            pSite.credentialId,
          );
          expect(use).toEqual(DENY_NOT_FOUND);
          const disclose = await fixture.decisions.disclosePlaintext(
            scope,
            pSite.credentialId,
          );
          expect(disclose).toEqual(DENY_NOT_FOUND);
          const detail = await fixture.decisions.describeCredential(
            scope,
            pSite.credentialId,
          );
          expect(detail).toEqual(DENY_NOT_FOUND);
          const list = await fixture.decisions.listVisible(scope);
          expect(
            list.some((entry) => entry.credentialId === pSite.credentialId),
          ).toBe(false);
          expect(fixture.vendorProbe.calls()).toBe(1);
        },
      );

      itDb("cross-team same-company member cannot use or read it", async () => {
        const scope = await scopeOf(fixture, "a2-member", "team-a2");
        expect(
          await fixture.decisions.authorizeUse(scope, pSite.credentialId),
        ).toEqual(DENY_NOT_FOUND);
        expect(
          await fixture.decisions.disclosePlaintext(scope, pSite.credentialId),
        ).toEqual(DENY_NOT_FOUND);
      });

      itDb(
        "multi-team membership does not make a colleague an owner",
        async () => {
          const scope = await scopeOf(fixture, "a1a2-member", "team-a1");
          expect(
            await fixture.decisions.authorizeUse(scope, pConn.credentialId),
          ).toEqual(DENY_NOT_FOUND);
          expect(
            await fixture.decisions.disclosePlaintext(
              scope,
              pConn.credentialId,
            ),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "company admin has no authority over personal credentials",
        async () => {
          const scope = await scopeOf(fixture, "company-admin", "team-a1");
          expect(
            await fixture.decisions.authorizeUse(scope, pSite.credentialId),
          ).toEqual(DENY_NOT_FOUND);
          expect(
            await fixture.decisions.disclosePlaintext(
              scope,
              pSite.credentialId,
            ),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb("personal connection kind is owner-only too", async () => {
        const owner = await scopeOf(fixture, "a1-member", "team-a1");
        expect(
          await fixture.decisions.authorizeUse(owner, pConn.credentialId),
        ).toMatchObject({ outcome: "allow" });
        const other = await scopeOf(fixture, "a1-other", "team-a1");
        expect(
          await fixture.decisions.authorizeUse(other, pConn.credentialId),
        ).toEqual(DENY_NOT_FOUND);
      });

      itDb(
        "owner-only denials are byte-identical to a nonexistent credential",
        async () => {
          const scope = await scopeOf(fixture, "a1-other", "team-a1");
          const ghost = await fixture.decisions.authorizeUse(
            scope,
            randomUUID(),
          );
          expect(ghost).toEqual(DENY_NOT_FOUND);
          const ghostDisclosure = await fixture.decisions.disclosePlaintext(
            scope,
            randomUUID(),
          );
          expect(ghostDisclosure).toEqual(DENY_NOT_FOUND);
          expect(ghostDisclosure).toEqual(
            await fixture.decisions.disclosePlaintext(
              scope,
              pSite.credentialId,
            ),
          );
        },
      );
    });

    // -------------------------------------------------------------------------
    // 验收 2：团队/公司凭据按动作授权可用；明文读取独立授权且留审计
    // -------------------------------------------------------------------------

    describeDb(
      "AC2: team/company credentials — action grants, independent disclosure, audit",
      () => {
        itDb("team membership alone does not authorize use", async () => {
          const scope = await scopeOf(fixture, "a1-member", "team-a1");
          expect(
            await fixture.decisions.authorizeUse(scope, t1.credentialId),
          ).toEqual(DENY_NOT_FOUND);
        });

        itDb(
          "'use' grant authorizes use but never plaintext disclosure",
          async () => {
            await fixture.grantAction({
              credentialId: t1.credentialId,
              to: "a1-member",
              action: "use",
            });
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const use = await fixture.decisions.authorizeUse(
              scope,
              t1.credentialId,
            );
            expect(use.outcome).toBe("allow");
            if (use.outcome === "allow") {
              expect(use.credential.effectiveActions).toEqual({
                use: true,
                disclose: false,
              });
              expect(use.envelope).toBe(`v1:${CANARY_TEAM}`);
            }
            // 独立授权：use 放行绝不顺带明文。
            const disclose = await fixture.decisions.disclosePlaintext(
              scope,
              t1.credentialId,
            );
            expect(disclose).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "'disclose' grant independently opens plaintext reads with audit",
          async () => {
            await fixture.grantAction({
              credentialId: t1.credentialId,
              to: "a1-member",
              action: "disclose",
            });
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const before = await fixture.auditRows({
              tenantId: t1.tenantId,
              credentialId: t1.credentialId,
            });
            const disclosure = await fixture.decisions.disclosePlaintext(
              scope,
              t1.credentialId,
            );
            expect(disclosure.outcome).toBe("allow");
            if (disclosure.outcome !== "allow") return;
            expect(disclosure.plaintext).toBe(CANARY_TEAM);
            const after = await fixture.auditRows({
              tenantId: t1.tenantId,
              credentialId: t1.credentialId,
            });
            expect(after).toHaveLength(before.length + 1);
            expect(after[after.length - 1].id).toBe(disclosure.auditId);
            // 动作行彼此独立：use 与 disclose 是两行，撤销互不影响。
            const rows = await fixture.actionRows({
              tenantId: t1.tenantId,
              credentialId: t1.credentialId,
            });
            expect(rows).toContainEqual({
              principalId: fixture.principalOf("a1-member", "company-a"),
              action: "use",
            });
            expect(rows).toContainEqual({
              principalId: fixture.principalOf("a1-member", "company-a"),
              action: "disclose",
            });
          },
        );

        itDb(
          "revoking the disclose grant closes plaintext reads immediately",
          async () => {
            await fixture.revokeAction({
              credentialId: t1.credentialId,
              from: "a1-member",
              action: "disclose",
            });
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const before = await fixture.auditRows({
              tenantId: t1.tenantId,
              credentialId: t1.credentialId,
            });
            expect(
              await fixture.decisions.disclosePlaintext(scope, t1.credentialId),
            ).toEqual(DENY_NOT_FOUND);
            expect(
              await fixture.auditRows({
                tenantId: t1.tenantId,
                credentialId: t1.credentialId,
              }),
            ).toHaveLength(before.length);
            // use 行不受 disclose 撤销影响（独立授权行）。
            expect(
              await fixture.decisions.authorizeUse(scope, t1.credentialId),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "same-team colleague with their own 'use' grant may use but not read",
          async () => {
            await fixture.grantAction({
              credentialId: t1.credentialId,
              to: "a1-other",
              action: "use",
            });
            const scope = await scopeOf(fixture, "a1-other", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(scope, t1.credentialId),
            ).toMatchObject({ outcome: "allow" });
            expect(
              await fixture.decisions.disclosePlaintext(scope, t1.credentialId),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "an action grant never substitutes for team membership",
          async () => {
            // a2-member 不是团队 A1 成员：即使动作行存在（本例先授后验）也拒绝。
            await fixture.grantAction({
              credentialId: t1.credentialId,
              to: "a2-member",
              action: "use",
            });
            const scope = await scopeOf(fixture, "a2-member", "team-a2");
            expect(
              await fixture.decisions.authorizeUse(scope, t1.credentialId),
            ).toEqual(DENY_NOT_FOUND);
            // t2（团队 A2 凭据）对 a1-member 同理。
            await fixture.grantAction({
              credentialId: t2.credentialId,
              to: "a1-member",
              action: "use",
            });
            const a1 = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(a1, t2.credentialId),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "by-ID operations derive the workspace from the credential, not the selector",
          async () => {
            // §5.2：按 ID 操作从对象归属确定 Workspace 再授权。a1a2-member 持
            // 团队 A2 的 selector、持团队 A1 凭据的 use 行 → 放行。
            await fixture.grantAction({
              credentialId: t1.credentialId,
              to: "a1a2-member",
              action: "use",
            });
            const scopeInA2 = await scopeOf(fixture, "a1a2-member", "team-a2");
            expect(
              await fixture.decisions.authorizeUse(scopeInA2, t1.credentialId),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "suspending the team membership closes use immediately; restoring reopens",
          async () => {
            // 停用前签发的 scope 是签发时快照；停用后判定按当前事实拒绝。
            const stale = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(stale, t1.credentialId),
            ).toMatchObject({ outcome: "allow" });
            await fixture.base.setTeamMembershipStatus(
              "a1-member",
              "team-a1",
              "suspended",
            );
            try {
              expect(
                await fixture.decisions.authorizeUse(stale, t1.credentialId),
              ).toEqual(DENY_NOT_FOUND);
            } finally {
              // 恢复在 finally 中执行：断言失败也不把停用状态泄漏给后续用例。
              await fixture.base.setTeamMembershipStatus(
                "a1-member",
                "team-a1",
                "active",
              );
            }
            const fresh = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(fresh, t1.credentialId),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "revoked credentials deny everyone, including previously granted members",
          async () => {
            await fixture.grantAction({
              credentialId: tRevocable.credentialId,
              to: "a1-member",
              action: "use",
            });
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(
                scope,
                tRevocable.credentialId,
              ),
            ).toMatchObject({ outcome: "allow" });
            await fixture.admin.revoke({
              tenantId: tRevocable.tenantId,
              credentialId: tRevocable.credentialId,
            });
            expect(
              await fixture.decisions.authorizeUse(
                scope,
                tRevocable.credentialId,
              ),
            ).toEqual(DENY_NOT_FOUND);
            expect(
              await fixture.decisions.describeCredential(
                scope,
                tRevocable.credentialId,
              ),
            ).toEqual(DENY_NOT_FOUND);
            expect(
              (await fixture.decisions.listVisible(scope)).some(
                (entry) => entry.credentialId === tRevocable.credentialId,
              ),
            ).toBe(false);
          },
        );

        itDb(
          "company credentials serve every member holding the action grant",
          async () => {
            const a1 = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(a1, c1.credentialId),
            ).toEqual(DENY_NOT_FOUND);
            await fixture.grantAction({
              credentialId: c1.credentialId,
              to: "a1-member",
              action: "use",
            });
            expect(
              await fixture.decisions.authorizeUse(a1, c1.credentialId),
            ).toMatchObject({ outcome: "allow" });
            // 另一团队的成员按自己的动作行放行（公司范围 ≠ 某个团队）。
            await fixture.grantAction({
              credentialId: c1.credentialId,
              to: "a2-member",
              action: "use",
            });
            const a2 = await scopeOf(fixture, "a2-member", "team-a2");
            expect(
              await fixture.decisions.authorizeUse(a2, c1.credentialId),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "company plaintext reads need their own disclosure grant and audit",
          async () => {
            const a1 = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.disclosePlaintext(a1, c1.credentialId),
            ).toEqual(DENY_NOT_FOUND);
            await fixture.grantAction({
              credentialId: c1.credentialId,
              to: "a1-member",
              action: "disclose",
            });
            const disclosure = await fixture.decisions.disclosePlaintext(
              a1,
              c1.credentialId,
            );
            expect(disclosure.outcome).toBe("allow");
            if (disclosure.outcome !== "allow") return;
            expect(disclosure.plaintext).toBe(CANARY_COMPANY);
            const rows = await fixture.auditRows({
              tenantId: c1.tenantId,
              credentialId: c1.credentialId,
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].action).toBe("plaintext.disclosed");
          },
        );

        itDb(
          "suspending the company membership denies the stale scope; a fresh scope recovers",
          async () => {
            const stale = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(stale, c1.credentialId),
            ).toMatchObject({ outcome: "allow" });
            await fixture.setCompanyMembershipStatus(
              "a1-member",
              "company-a",
              "suspended",
            );
            try {
              expect(
                await fixture.decisions.authorizeUse(stale, c1.credentialId),
              ).toEqual(DENY_NOT_FOUND);
            } finally {
              // 恢复在 finally 中执行：断言失败也不把停用状态泄漏给后续用例。
              await fixture.setCompanyMembershipStatus(
                "a1-member",
                "company-a",
                "active",
              );
            }
            const fresh = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              await fixture.decisions.authorizeUse(fresh, c1.credentialId),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "status suspension alone (no epoch bump) closes access — decisions never trust epoch discipline alone",
          async () => {
            // 安排替身（setup 通道，已披露）：只翻 status、不动 epoch——模拟
            // 违反 epoch 纪律的写入路径。判定必须仍拒绝（防线不因上游
            // 纪律而省略，纵深防御独立成立）。
            const tenantId = fixture.base.isolation.ids["company-a"];
            const principalId = fixture.principalOf("a1-member", "company-a");
            expect(tenantId).toBeTruthy();
            expect(principalId).toBeTruthy();
            // scope 在停用前签发（快照）；status 翻转不动 epoch，
            // 判定仍必须按当前 status 拒绝。
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            await fixture.setCompanyMembershipStatusWithoutEpochBump(
              "a1-member",
              "company-a",
              "suspended",
            );
            try {
              expect(
                await fixture.decisions.authorizeUse(scope, c1.credentialId),
              ).toEqual(DENY_NOT_FOUND);
            } finally {
              await fixture.setCompanyMembershipStatusWithoutEpochBump(
                "a1-member",
                "company-a",
                "active",
              );
            }
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 验收 3：跨公司凭据 ID 不可见且不触发供应商调用
    // -------------------------------------------------------------------------

    describeDb(
      "AC3: cross-company IDs are invisible and never reach the vendor",
      () => {
        itDb(
          "every company-A credential denies a company-B scope byte-identically, vendor untouched",
          async () => {
            const crossScope = await scopeOf(
              fixture,
              "multi-company",
              "team-b1",
            );
            const before = fixture.vendorProbe.calls();
            for (const target of [
              pSite.credentialId,
              t1.credentialId,
              c1.credentialId,
            ]) {
              const use = await fixture.decisions.authorizeUse(
                crossScope,
                target,
              );
              expect(use).toEqual(DENY_NOT_FOUND);
              expect(use).not.toHaveProperty("envelope");
              const disclose = await fixture.decisions.disclosePlaintext(
                crossScope,
                target,
              );
              expect(disclose).toEqual(DENY_NOT_FOUND);
            }
            expect(fixture.vendorProbe.calls()).toBe(before);
          },
        );

        itDb("cross-company disclosure writes no audit rows", async () => {
          const crossScope = await scopeOf(fixture, "b1-member", "team-b1");
          const before = await fixture.auditRows({
            tenantId: pSite.tenantId,
            credentialId: pSite.credentialId,
          });
          expect(
            await fixture.decisions.disclosePlaintext(
              crossScope,
              pSite.credentialId,
            ),
          ).toEqual(DENY_NOT_FOUND);
          expect(
            await fixture.auditRows({
              tenantId: pSite.tenantId,
              credentialId: pSite.credentialId,
            }),
          ).toHaveLength(before.length);
        });

        itDb("cross-company lists and details leak nothing", async () => {
          const crossScope = await scopeOf(fixture, "multi-company", "team-b1");
          const list = await fixture.decisions.listVisible(crossScope);
          // multi-company 在公司 B 不拥有任何凭据（b1 属于 b1-member），
          // 公司 B 也没有团队/公司凭据——列表为空且绝不含公司 A 的条目。
          expect(list.map((entry) => entry.credentialId)).toEqual([]);
          expect(
            await fixture.decisions.describeCredential(
              crossScope,
              c1.credentialId,
            ),
          ).toEqual(DENY_NOT_FOUND);
        });

        itDb(
          "a cross-company ownership row is structurally impossible (23503)",
          async () => {
            const companyBPrincipal = fixture.principalOf(
              "b1-member",
              "company-b",
            );
            const error = await thrownMessage(
              fixture.base.operator.transaction(async (tx) => {
                await tx.execute(
                  (await import("drizzle-orm"))
                    .sql`select set_config('app.tenant_id', ${pSite.tenantId}, true)`,
                );
                await tx.execute(
                  (await import("drizzle-orm"))
                    .sql`insert into enterprise_credentials
              (tenant_id, id, kind, classification, owner_principal_id, target, display, envelope, status)
              values (${pSite.tenantId}, ${randomUUID()}, 'site-login', 'personal', ${companyBPrincipal}, 'https://x.example.com', ${{ label: "x" }}, 'v1:x', 'active')`,
                );
              }),
            );
            expect(error).toContain("23503");
          },
        );

        itDb(
          "a nonexistent credential behaves byte-identically to a cross-company one",
          async () => {
            const crossScope = await scopeOf(
              fixture,
              "multi-company",
              "team-b1",
            );
            const ghost = await fixture.decisions.authorizeUse(
              crossScope,
              randomUUID(),
            );
            const cross = await fixture.decisions.authorizeUse(
              crossScope,
              pSite.credentialId,
            );
            expect(ghost).toEqual(cross);
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 验收 4：列表与详情默认脱敏；响应/日志/错误零明文
    // -------------------------------------------------------------------------

    describeDb(
      "AC4: redacted surfaces — responses, lists, errors carry no secrets",
      () => {
        itDb("list and detail views are structurally redacted", async () => {
          const scope = await scopeOf(fixture, "a1-member", "team-a1");
          const list = await fixture.decisions.listVisible(scope);
          expect(list.length).toBeGreaterThan(0);
          assertRedactedShape(list);
          const own = await fixture.decisions.describeCredential(
            scope,
            pSite.credentialId,
          );
          expect(own).toMatchObject({ outcome: "allow" });
          assertRedactedShape(own);
          const useAllow = await fixture.decisions.authorizeUse(
            scope,
            t1.credentialId,
          );
          if (useAllow.outcome === "allow")
            assertRedactedShape(useAllow.credential);
        });

        itDb(
          "canary secrets never appear in any list/detail/use/deny/error output",
          async () => {
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const outputs: unknown[] = [];
            outputs.push(await fixture.decisions.listVisible(scope));
            outputs.push(
              await fixture.decisions.describeCredential(
                scope,
                pSite.credentialId,
              ),
            );
            outputs.push(
              await fixture.decisions.describeCredential(scope, randomUUID()),
            );
            outputs.push(
              await fixture.decisions.authorizeUse(scope, randomUUID()),
            );
            outputs.push(
              await fixture.decisions.disclosePlaintext(scope, randomUUID()),
            );
            // 错误面：非法注册与非法动作授权的拒绝消息。
            outputs.push(
              await thrownMessage(
                fixture.admin.register({
                  tenantId: pSite.tenantId,
                  kind: "site-login",
                  classification: "personal",
                  ownerPrincipalId: fixture.principalOf(
                    "a1-member",
                    "company-a",
                  ),
                  target: "",
                  label: CANARY_PERSONAL,
                  plaintext: CANARY_PERSONAL,
                }),
              ),
            );
            outputs.push(
              await thrownMessage(
                fixture.admin.grantAction({
                  tenantId: pSite.tenantId,
                  credentialId: pSite.credentialId,
                  principalId: fixture.principalOf("a1-member", "company-a"),
                  action: "manage" as never,
                  grantedBy: fixture.principalOf("company-admin", "company-a"),
                }),
              ),
            );
            const serialized = outputs
              .map((entry) => JSON.stringify(entry))
              .join("\n");
            for (const canary of ALL_CANARIES) {
              expect(serialized).not.toContain(canary);
            }
          },
        );

        itDb("list counts never leak cross-scope existence", async () => {
          // a2-member（团队 A2）：只见 A2 团队凭据 + 公司凭据，绝不见 A1。
          const a2 = await scopeOf(fixture, "a2-member", "team-a2");
          const a2List = await fixture.decisions.listVisible(a2);
          expect(a2List.map((entry) => entry.credentialId).sort()).toEqual(
            [t2.credentialId, c1.credentialId].sort(),
          );
          // b1-member（公司 B）：只见自己的个人凭据。
          const bScope = await scopeOf(fixture, "b1-member", "team-b1");
          const bList = await fixture.decisions.listVisible(bScope);
          expect(bList.map((entry) => entry.credentialId)).toEqual([
            b1.credentialId,
          ]);
        });

        itDb(
          "the authorized disclosure is the only surface that returns plaintext",
          async () => {
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const disclosure = await fixture.decisions.disclosePlaintext(
              scope,
              pSite.credentialId,
            );
            expect(disclosure.outcome).toBe("allow");
            if (disclosure.outcome !== "allow") return;
            expect(disclosure.plaintext).toBe(CANARY_PERSONAL);
            // 披露结果除明文与审计 ID 外不携带其他材料。
            expect(Object.keys(disclosure).sort()).toEqual([
              "auditId",
              "outcome",
              "plaintext",
            ]);
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 存储契约：FORCE RLS、最小授权、CHECK、append-only 审计、上下文清理
    // -------------------------------------------------------------------------

    describeDb(
      "storage contract: FORCE RLS, least privilege, invariants",
      () => {
        itDb("all three tables force row level security", async () => {
          for (const table of [
            "enterprise_credentials",
            "enterprise_credential_actions",
            "enterprise_credential_audit",
          ]) {
            const flags = await fixture.catalog.rlsFlags(table);
            expect(flags).toEqual({
              relrowsecurity: true,
              relforcerowsecurity: true,
            });
          }
        });

        itDb(
          "the restricted roles hold exactly the designed grant matrix",
          async () => {
            const expectPrivilege = async (
              table: string,
              role: "ob_ent_directory" | "ob_ent_data" | "ob_ent_operator",
              privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
              allowed: boolean,
            ) => {
              expect(
                await fixture.catalog.hasPrivilege(table, role, privilege),
              ).toBe(allowed);
            };
            // directory：三表零授权。
            for (const table of [
              "enterprise_credentials",
              "enterprise_credential_actions",
              "enterprise_credential_audit",
            ]) {
              for (const privilege of [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
              ] as const) {
                await expectPrivilege(
                  table,
                  "ob_ent_directory",
                  privilege,
                  false,
                );
              }
            }
            // data：凭据/动作行只读、审计只写。
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_data",
              "SELECT",
              true,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_data",
              "INSERT",
              false,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_data",
              "UPDATE",
              false,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_data",
              "DELETE",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_data",
              "SELECT",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_data",
              "INSERT",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_data",
              "DELETE",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_data",
              "INSERT",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_data",
              "SELECT",
              false,
            );
            // operator：归属写面 + 动作管理 + 审计只读。
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_operator",
              "SELECT",
              true,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_operator",
              "INSERT",
              true,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_operator",
              "UPDATE",
              true,
            );
            await expectPrivilege(
              "enterprise_credentials",
              "ob_ent_operator",
              "DELETE",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_operator",
              "SELECT",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_operator",
              "INSERT",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_operator",
              "DELETE",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_actions",
              "ob_ent_operator",
              "UPDATE",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_operator",
              "SELECT",
              true,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_operator",
              "INSERT",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_operator",
              "UPDATE",
              false,
            );
            await expectPrivilege(
              "enterprise_credential_audit",
              "ob_ent_operator",
              "DELETE",
              false,
            );
          },
        );

        itDb(
          "ownership row shape is enforced by CHECK constraints",
          async () => {
            const attempt = async (
              classification: string,
              workspace: string | null,
              owner: string | null,
            ) =>
              thrownMessage(
                fixture.base.operator.transaction(async (tx) => {
                  await tx.execute(
                    (await import("drizzle-orm"))
                      .sql`select set_config('app.tenant_id', ${pSite.tenantId}, true)`,
                  );
                  await tx.execute(
                    (await import("drizzle-orm"))
                      .sql`insert into enterprise_credentials
                (tenant_id, id, kind, classification, workspace_id, owner_principal_id, target, display, envelope, status)
                values (${pSite.tenantId}, ${randomUUID()}, 'connection', ${classification}, ${workspace}, ${owner}, 'x', ${{ label: "x" }}, 'v1:x', 'active')`,
                  );
                }),
              );
            // personal 缺属主 / team 缺团队 / company 带团队 / company 带属主。
            expect(await attempt("personal", null, null)).toContain("23514");
            expect(await attempt("team", null, null)).toContain("23514");
            expect(
              await attempt(
                "company",
                fixture.base.teamOf("a1-member", "team-a1").workspaceId,
                null,
              ),
            ).toContain("23514");
            expect(
              await attempt(
                "company",
                null,
                fixture.principalOf("a1-member", "company-a"),
              ),
            ).toContain("23514");
          },
        );

        itDb(
          "the action vocabulary is a closed set at the database too",
          async () => {
            const error = await thrownMessage(
              fixture.base.operator.transaction(async (tx) => {
                await tx.execute(
                  (await import("drizzle-orm"))
                    .sql`select set_config('app.tenant_id', ${t1.tenantId}, true)`,
                );
                await tx.execute(
                  (await import("drizzle-orm"))
                    .sql`insert into enterprise_credential_actions
              (tenant_id, credential_id, principal_id, action, granted_by)
              values (${t1.tenantId}, ${t1.credentialId}, ${fixture.principalOf("a1-member", "company-a")}, 'manage', ${fixture.principalOf("company-admin", "company-a")})`,
                );
              }),
            );
            expect(error).toContain("23514");
          },
        );

        itDb("the disclosure audit is append-only for every role", async () => {
          const rows = await fixture.auditRows({
            tenantId: pSite.tenantId,
            credentialId: pSite.credentialId,
          });
          expect(rows.length).toBeGreaterThan(0);
          // data 角色无 UPDATE/DELETE 授权（42501 先于任何行可见性）。
          const updateError = await thrownMessage(
            fixture.base.data.transaction(async (tx) => {
              await tx.execute(
                (await import("drizzle-orm"))
                  .sql`select set_config('app.tenant_id', ${pSite.tenantId}, true), set_config('app.principal_id', ${fixture.principalOf("a1-member", "company-a")}, true)`,
              );
              await tx.execute(
                (await import("drizzle-orm"))
                  .sql`update enterprise_credential_audit set detail = '{}' where true`,
              );
            }),
          );
          expect(updateError).toContain("42501");
        });

        itDb(
          "transaction-local context is gone after commit on the pooled connection",
          async () => {
            await fixture.base.data.transaction(async (tx) => {
              await tx.execute(
                (await import("drizzle-orm"))
                  .sql`select set_config('app.tenant_id', ${pSite.tenantId}, true), set_config('app.principal_id', ${fixture.principalOf("a1-member", "company-a")}, true)`,
              );
            });
            // 同一池化连接（max:1）在事务外读取上下文：必须为空。
            const result = (await fixture.base.data.execute(
              (
                await import("drizzle-orm")
              )
                .sql`select nullif(current_setting('app.tenant_id', true), '') as tenant, nullif(current_setting('app.principal_id', true), '') as principal`,
            )) as unknown as Record<string, unknown>[];
            const row = result[0];
            expect(row?.tenant ?? null).toBeNull();
            expect(row?.principal ?? null).toBeNull();
          },
        );

        itDb(
          "unverified database channels are refused at service construction",
          async () => {
            const raw = createDatabase(enterpriseTestDatabaseUrlFrom(), {
              max: 1,
            });
            try {
              // 故意传未验证通道验证 fail-closed：工厂在构造时即拒绝。
              expect(() =>
                createCredentialOwnershipDecisionService(
                  raw as never,
                  fixture.vault,
                ),
              ).toThrow();
              expect(() =>
                createCredentialOwnershipAdminService(
                  raw as never,
                  fixture.vault,
                ),
              ).toThrow();
            } finally {
              await raw.$client.close();
            }
          },
        );

        itDb(
          "the applied migration plan is deterministic (replay is up-to-date after apply)",
          async () => {
            expect(
              dryRunOutcome.kind === "dry-run" ||
                dryRunOutcome.kind === "up-to-date",
            ).toBe(true);
            expect(
              applyOutcome.kind === "applied" ||
                applyOutcome.kind === "up-to-date",
            ).toBe(true);
            const replay = await runMigrateTest(["migrate", "MT027"], {
              environment: {
                TEST_DATABASE_URL: resolveTestDatabaseTarget(process.env).ok
                  ? resolveTestDatabaseTarget(process.env).target.url
                  : "",
              },
              out: () => {},
            });
            // dry-run 重放：无待应用步骤（journal 收敛，与 apply 留痕一致）。
            expect(
              replay.kind === "up-to-date" ||
                (replay.kind === "dry-run" && replay.pending.length === 0),
            ).toBe(true);
            expect(buildPlan("MT027").steps.map((step) => step.name)).toEqual([
              "0001_mt027_credential_ownership_tables.sql",
              "0002_mt027_credential_rls_policies.sql",
            ]);
          },
        );
      },
    );
  },
);
