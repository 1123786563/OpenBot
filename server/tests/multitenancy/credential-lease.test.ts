// server/tests/multitenancy/credential-lease.test.ts
// MT029（Issue #72）：凭据取用 lease——固定用途、作用域且可撤销。
//
// 验收事实源（Issue #72 四条，逐条对应 describe）：
//   (1) lease 只能用于签发时声明的用途与作用域；改用途或改范围被拒绝
//       （purpose/claimed scope 与持久行逐字段比对；claimed 只参与比对、
//       永不改写持久行——MT026/MT028 先例：不匹配的呈现既不生效也不
//       破坏行；伪造 scope 在判定入口即 UNVERIFIED_SCOPE 拒绝）。
//   (2) 撤销或过期后，正在进行的取用在下一次校验点失效；后续新取用被
//       拒绝（validate 每次读实时行：status active / 未过期 / 持有人
//       公司+团队成员资格 active 且 epoch 匹配 / MT027 use 权威现读——
//       lease 撤销、凭据撤销、成员停用都在下一个校验点立即失效；恢复
//       后同一 lease 重新放行，不存在拒绝缓存——MT007 AC3 同语义）。
//   (3) 公共 Bot 的其他使用者无法获得创建者个人凭据的 lease（issue 在
//       签发事务内重验 MT027 use 权威：personal ⇒ 仅属主本人；同团队
//       他人/双团队成员/兼任团队管理员/跨公司成员一律 canonical
//       RESOURCE_NOT_FOUND，与「不存在」逐字节同形——不泄露存在性）。
//   (4) 每次签发、使用与撤销留审计（不含明文）（专用 append-only
//       enterprise_credential_lease_audit：issued/validated/revoked 三种
//       闭集动作行，签发/校验/撤销在同一事务写入；deny 零审计零副作用；
//       detail 闭形且 CHECK 禁止秘密载体键；canary 明文全路径零出现；
//       lease 判定面类型上无 envelope/plaintext——密封材料只能经 MT027
//       authorizeUse 的 allow 分支离开）。
//
// 存储契约（第五组）：两表 FORCE RLS、最小授权矩阵（directory 零授权、
// data 零 UPDATE/DELETE、audit 对任何角色无 UPDATE/DELETE）、purpose/status/
// action 闭集 CHECK、行形 CHECK（revoked ⇔ revoked_at）、窗口 CHECK
// （expires_at > created_at）、audit detail 闭形 CHECK、跨公司行被复合
// 外键判 23503 结构性不可能。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT029 迁移（两张新表 + FORCE RLS +
// 最小授权）经 MT003 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type CredentialLeaseFixture,
  createCredentialLeaseFixture,
  scopeOf,
  thrownMessage,
} from "./support/credential-lease";

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
      reason: `MT029 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const denyBytes = (verdict: unknown): string => JSON.stringify(verdict);

/** Any key that would carry secret material through an audited surface. */
const SECRET_CARRIER_KEYS = [
  "envelope",
  "plaintext",
  "encryptedValue",
  "encrypted_value",
  "secret",
  "secretRef",
  "password",
  "token",
] as const;

// ---------------------------------------------------------------------------
// 共享夹具 + MT029 迁移（经 MT003 工具真实执行）
// ---------------------------------------------------------------------------

let fixture: CredentialLeaseFixture;

// 凭据平面：公司 A 的个人 / 团队 A1 / 团队 A2 / 可撤销团队 / 公司级，
// 公司 B 个人对照。
let pSite: { credentialId: string; tenantId: string };
let t1: { credentialId: string; tenantId: string };
let t2: { credentialId: string; tenantId: string };
let tRevocable: { credentialId: string; tenantId: string };
let c1: { credentialId: string; tenantId: string };

const CANARY_PERSONAL = "mt029-canary-personal-4e7c1d90";
const CANARY_TEAM = "mt029-canary-team-2b58af36";
const ALL_CANARIES = [CANARY_PERSONAL, CANARY_TEAM];

describeDb(
  "MT029 credential lease: fixed purpose, scope, revocable (Issue #72)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT029 lease tests refuse to run: ${resolved.reason}`);
      }
      await runMigrateTest(["migrate", "MT029"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      const manifestPath = `/tmp/mt029-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT029")), null, 2)}\n`,
      );
      try {
        await runMigrateTest(
          ["migrate", "MT029", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      fixture = await createCredentialLeaseFixture();
      // 公司管理员加入团队 A1（受权 operator 通道物化，MT005 先例）：让
      // 「管理员」成为个人凭据最严格的反例——即便是属主同团队成员的
      // tenant_admin，也不能为自己的团队会话取得他人个人凭据的 lease。
      await fixture.base.materializeAdminTeamMembership();
      pSite = await fixture.base.provisionCredential({
        kind: "site-login",
        classification: "personal",
        owner: "a1-member",
        team: "team-a1",
        target: "https://site-a1.example.com",
        label: "a1 personal site login",
        plaintext: CANARY_PERSONAL,
      });
      t1 = await fixture.base.provisionCredential({
        kind: "connection",
        classification: "team",
        team: "team-a1",
        target: "linear",
        label: "team a1 connection",
        plaintext: CANARY_TEAM,
      });
      t2 = await fixture.base.provisionCredential({
        kind: "connection",
        classification: "team",
        team: "team-a2",
        target: "notion",
        label: "team a2 connection",
        plaintext: CANARY_TEAM,
      });
      tRevocable = await fixture.base.provisionCredential({
        kind: "site-login",
        classification: "team",
        team: "team-a1",
        target: "https://revocable.example.com",
        label: "revocable team site login",
        plaintext: CANARY_TEAM,
      });
      c1 = await fixture.base.provisionCredential({
        kind: "connection",
        classification: "company",
        target: "salesforce",
        label: "company-wide connection",
        plaintext: CANARY_TEAM,
      });
      // use 动作行（团队/公司凭据的 MT027 权威事实；'use' 与 'disclose'
      // 互不蕴含——本票只消费 'use' 权威，绝不触碰明文面）。
      await fixture.base.grantAction({
        credentialId: t1.credentialId,
        to: "a1-member",
        action: "use",
      });
      await fixture.base.grantAction({
        credentialId: t1.credentialId,
        to: "a1-other",
        action: "use",
      });
      await fixture.base.grantAction({
        credentialId: t2.credentialId,
        to: "a1a2-member",
        action: "use",
      });
      await fixture.base.grantAction({
        credentialId: tRevocable.credentialId,
        to: "a1-member",
        action: "use",
      });
      await fixture.base.grantAction({
        credentialId: c1.credentialId,
        to: "a1-member",
        action: "use",
      });
      await fixture.base.grantAction({
        credentialId: c1.credentialId,
        to: "a1a2-member",
        action: "use",
      });
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    // -------------------------------------------------------------------------
    // 验收 1：lease 只能用于签发时声明的用途与作用域
    // -------------------------------------------------------------------------

    describeDb(
      "AC1: a lease is bound to its declared purpose and scope",
      () => {
        itDb(
          "the holder validates the lease at its declared purpose and scope",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: c1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            expect(issued.leaseId).not.toBe("");
            expect(issued.credentialId).toBe(c1.credentialId);
            expect(issued.purpose).toBe("bot-run");
            expect(issued.workspaceId).toBe(scope.workspaceId);
            expect(issued.principalId).toBe(scope.principalId);
            expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
            // allow 变体零秘密材料位（密封材料只能经 MT027 authorizeUse）。
            expect(Object.keys(issued).sort()).toEqual([
              "credentialId",
              "expiresAt",
              "leaseId",
              "outcome",
              "principalId",
              "purpose",
              "workspaceId",
            ]);

            const validated = await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            });
            expect(validated).toMatchObject({
              outcome: "allow",
              leaseId: issued.leaseId,
              credentialId: c1.credentialId,
              purpose: "bot-run",
            });
          },
        );

        itDb(
          "a lease issued for one purpose is refused at a different purpose, and the denial mutates nothing",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: t1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "connector-call",
              }),
            ).toEqual(DENY_NOT_FOUND);
            // 拒绝不消费、不改写（MT026 先例）：原用途的取用仍然成立。
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toMatchObject({ outcome: "allow" });
            const rows = await fixture.leaseRows({ tenantId: t1.tenantId });
            expect(rows.filter((row) => row.id === issued.leaseId)).toEqual([
              expect.objectContaining({
                purpose: "bot-run",
                status: "active",
              }),
            ]);
          },
        );

        itDb(
          "a lease issued in one workspace is refused from another workspace of the same double-team member",
          async () => {
            const scopeA1 = await scopeOf(
              fixture.base,
              "a1a2-member",
              "team-a1",
            );
            const issued = await fixture.leases.issue(scopeA1, {
              credentialId: c1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            const scopeA2 = await scopeOf(
              fixture.base,
              "a1a2-member",
              "team-a2",
            );
            expect(
              await fixture.leases.validate(scopeA2, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
            // 改范围被拒绝且不留副作用：原作用域仍然成立。
            expect(
              await fixture.leases.validate(scopeA1, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "another principal cannot ride someone else's lease from the same team",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: t1.credentialId,
              purpose: "connector-call",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            const otherScope = await scopeOf(
              fixture.base,
              "a1-other",
              "team-a1",
            );
            expect(
              await fixture.leases.validate(otherScope, {
                leaseId: issued.leaseId,
                purpose: "connector-call",
              }),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "team-membership suspension invalidates the lease at the next checkpoint and recovery re-admits",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: t1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toMatchObject({ outcome: "allow" });
            await fixture.setTeamMembershipStatus(
              "a1-member",
              "team-a1",
              "suspended",
            );
            // lease 团队上下文的成员资格失效 ⇒ 下一次校验点拒绝（A5 停用面）。
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
            await fixture.setTeamMembershipStatus(
              "a1-member",
              "team-a1",
              "active",
            );
            // 恢复语义（MT007 AC3 同款）：实时重读、恢复即重新放行。
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "a team member without a use grant cannot issue a lease for the team credential",
          async () => {
            // a1a2-member 是 team-a1 的 active 成员，但没有 t1 的 use
            // 动作行：成员资格是必要条件、动作行是充分条件（MT027 语义）。
            const doubleScope = await scopeOf(
              fixture.base,
              "a1a2-member",
              "team-a1",
            );
            expect(
              await fixture.leases.issue(doubleScope, {
                credentialId: t1.credentialId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "membership status alone (no epoch bump) is enforced by the decision layer",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: c1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            // 停用但不动 epoch（披露的 stand-in）：钉死判定层自己读 status，
            // 绝不只信任上游 epoch 纪律（MT027 同款不变量）。
            await fixture.base.setCompanyMembershipStatusWithoutEpochBump(
              "a1-member",
              "company-a",
              "suspended",
            );
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
            await fixture.base.setCompanyMembershipStatusWithoutEpochBump(
              "a1-member",
              "company-a",
              "active",
            );
            expect(
              await fixture.leases.validate(scope, {
                leaseId: issued.leaseId,
                purpose: "bot-run",
              }),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "issuing with an unknown purpose / extra field / bad ttl is a loud input rejection",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            expect(
              await thrownMessage(
                fixture.leases.issue(scope, {
                  credentialId: c1.credentialId,
                  purpose: "anything-else" as never,
                }),
              ),
            ).toContain("CREDENTIAL_LEASE_INVALID: purpose");
            expect(
              await thrownMessage(
                fixture.leases.issue(scope, {
                  credentialId: c1.credentialId,
                  purpose: "bot-run",
                  ttlSeconds: 0,
                }),
              ),
            ).toContain("ttlSeconds");
            expect(
              await thrownMessage(
                fixture.leases.issue(scope, {
                  credentialId: c1.credentialId,
                  purpose: "bot-run",
                  hijack: true,
                } as never),
              ),
            ).toContain("unexpected field");
            const issued = await fixture.leases.issue(scope, {
              credentialId: c1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            expect(
              await thrownMessage(
                fixture.leases.validate(scope, {
                  leaseId: issued.leaseId,
                  purpose: "site-access",
                  checkpoint: "not-a-checkpoint",
                }),
              ),
            ).toContain("REVOCATION_CHECKPOINT_UNKNOWN");
          },
        );

        itDb(
          "a forged (unissued) scope is refused at issue and validate alike",
          async () => {
            const forged: PlatformScope = {
              tenantId: fixture.base.base.isolation.ids["company-a"],
              workspaceId: fixture.base.base.teamOf("a1-member", "team-a1")
                .workspaceId,
              principalId: fixture.base.principalOf("a1-member", "company-a"),
              actorId: "forged-actor",
              memberEpoch: 1,
              aclEpoch: 1,
              entrypoint: "web",
            };
            expect(
              await thrownMessage(
                fixture.leases.issue(forged, {
                  credentialId: c1.credentialId,
                  purpose: "bot-run",
                }),
              ),
            ).toContain("UNVERIFIED_SCOPE");
            expect(
              await thrownMessage(
                fixture.leases.validate(forged, {
                  leaseId: randomUUID(),
                  purpose: "bot-run",
                }),
              ),
            ).toContain("UNVERIFIED_SCOPE");
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 验收 2：撤销或过期后，下一次校验点失效；后续新取用被拒绝
    // -------------------------------------------------------------------------

    describeDb("AC2: revocation and expiry bite at the next checkpoint", () => {
      itDb(
        "revocation invalidates the very next validation of an in-flight lease",
        async () => {
          const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
          const issued = await fixture.leases.issue(scope, {
            credentialId: t1.credentialId,
            purpose: "bot-run",
          });
          expect(issued.outcome).toBe("allow");
          if (issued.outcome !== "allow") return;
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toMatchObject({ outcome: "allow" });
          const revoked = await fixture.leaseAdmin.revoke({
            tenantId: t1.tenantId,
            leaseId: issued.leaseId,
          });
          expect(revoked.revoked).toBe(true);
          // 下一次校验点：立即失效，无缓存无宽限。
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "revocation is idempotent and unknown leases report revoked:false",
        async () => {
          const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
          const issued = await fixture.leases.issue(scope, {
            credentialId: t1.credentialId,
            purpose: "site-access",
          });
          expect(issued.outcome).toBe("allow");
          if (issued.outcome !== "allow") return;
          expect(
            (
              await fixture.leaseAdmin.revoke({
                tenantId: t1.tenantId,
                leaseId: issued.leaseId,
              })
            ).revoked,
          ).toBe(true);
          expect(
            (
              await fixture.leaseAdmin.revoke({
                tenantId: t1.tenantId,
                leaseId: issued.leaseId,
              })
            ).revoked,
          ).toBe(false);
          expect(
            (
              await fixture.leaseAdmin.revoke({
                tenantId: t1.tenantId,
                leaseId: randomUUID(),
              })
            ).revoked,
          ).toBe(false);
        },
      );

      itDb(
        "expiry invalidates validation without revoking the row",
        async () => {
          const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
          const issued = await fixture.leases.issue(scope, {
            credentialId: c1.credentialId,
            purpose: "bot-run",
            ttlSeconds: 1,
          });
          expect(issued.outcome).toBe("allow");
          if (issued.outcome !== "allow") return;
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toMatchObject({ outcome: "allow" });
          await new Promise((resolve) => setTimeout(resolve, 1200));
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toEqual(DENY_NOT_FOUND);
          // 过期 ≠ 撤销：行仍是 active（取证清晰，MT028 先例：行不改写）。
          const rows = await fixture.leaseRows({ tenantId: c1.tenantId });
          expect(rows.find((row) => row.id === issued.leaseId)?.status).toBe(
            "active",
          );
        },
      );

      itDb(
        "credential revocation (MT027) invalidates in-flight leases at the next checkpoint",
        async () => {
          const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
          const issued = await fixture.leases.issue(scope, {
            credentialId: tRevocable.credentialId,
            purpose: "bot-run",
          });
          expect(issued.outcome).toBe("allow");
          if (issued.outcome !== "allow") return;
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toMatchObject({ outcome: "allow" });
          await fixture.base.admin.revoke({
            tenantId: tRevocable.tenantId,
            credentialId: tRevocable.credentialId,
          });
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            }),
          ).toEqual(DENY_NOT_FOUND);
          // 凭据撤销后新的签发同样被拒（权威已消失）。
          expect(
            await fixture.leases.issue(scope, {
              credentialId: tRevocable.credentialId,
              purpose: "bot-run",
            }),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "company-membership suspension invalidates the lease at the next checkpoint and recovery re-admits",
        async () => {
          const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
          const issued = await fixture.leases.issue(scope, {
            credentialId: c1.credentialId,
            purpose: "connector-call",
          });
          expect(issued.outcome).toBe("allow");
          if (issued.outcome !== "allow") return;
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "connector-call",
            }),
          ).toMatchObject({ outcome: "allow" });
          await fixture.base.setCompanyMembershipStatus(
            "a1-member",
            "company-a",
            "suspended",
          );
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "connector-call",
            }),
          ).toEqual(DENY_NOT_FOUND);
          await fixture.base.setCompanyMembershipStatus(
            "a1-member",
            "company-a",
            "active",
          );
          // 恢复语义（MT007 AC3 同款）：实时重读、恢复即重新放行；epoch
          // 已递增，旧 scope 被拒、新 scope 放行——lease 绑定持有人与
          // 团队上下文，不绑死签发时的成员版本。
          expect(
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "connector-call",
            }),
          ).toEqual(DENY_NOT_FOUND);
          const freshScope = await scopeOf(
            fixture.base,
            "a1-member",
            "team-a1",
          );
          expect(
            await fixture.leases.validate(freshScope, {
              leaseId: issued.leaseId,
              purpose: "connector-call",
            }),
          ).toMatchObject({ outcome: "allow" });
        },
      );
    });

    // -------------------------------------------------------------------------
    // 验收 3：公共 Bot 的其他使用者无法获得创建者个人凭据的 lease
    // -------------------------------------------------------------------------

    describeDb(
      "AC3: nobody but the owner can lease a personal credential",
      () => {
        itDb(
          "another member of the owner's own team is refused at issue",
          async () => {
            const otherScope = await scopeOf(
              fixture.base,
              "a1-other",
              "team-a1",
            );
            expect(
              await fixture.leases.issue(otherScope, {
                credentialId: pSite.credentialId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "a double-team colleague of the owner is refused at issue",
          async () => {
            const doubleScope = await scopeOf(
              fixture.base,
              "a1a2-member",
              "team-a1",
            );
            expect(
              await fixture.leases.issue(doubleScope, {
                credentialId: pSite.credentialId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "even the company admin (materialized team member) is refused at issue",
          async () => {
            const adminScope = await scopeOf(
              fixture.base,
              "company-admin",
              "team-a1",
            );
            expect(
              await fixture.leases.issue(adminScope, {
                credentialId: pSite.credentialId,
                purpose: "bot-run",
              }),
            ).toEqual(DENY_NOT_FOUND);
          },
        );

        itDb(
          "a cross-company user gets the identical not-found with zero existence leak",
          async () => {
            const crossScope = await scopeOf(
              fixture.base,
              "b1-member",
              "team-b1",
            );
            const denied = await fixture.leases.issue(crossScope, {
              credentialId: pSite.credentialId,
              purpose: "bot-run",
            });
            expect(denied).toEqual(DENY_NOT_FOUND);
            // 与「凭据不存在」逐字节同形：确定性序列化一致（MT011 canonical）。
            const missing = await fixture.leases.issue(crossScope, {
              credentialId: randomUUID(),
              purpose: "bot-run",
            });
            expect(denyBytes(denied)).toBe(denyBytes(missing));
            expect(denyBytes(denied)).toBe(denyBytes(DENY_NOT_FOUND));
          },
        );

        itDb(
          "the owner himself still leases his personal credential (positive control)",
          async () => {
            const ownerScope = await scopeOf(
              fixture.base,
              "a1-member",
              "team-a1",
            );
            expect(
              await fixture.leases.issue(ownerScope, {
                credentialId: pSite.credentialId,
                purpose: "site-access",
              }),
            ).toMatchObject({ outcome: "allow" });
          },
        );

        itDb(
          "denied issuances leave zero lease rows and zero audit rows (no side channel)",
          async () => {
            const tenantId = pSite.tenantId;
            const beforeLeases = await fixture.leaseRows({ tenantId });
            const beforeAudit = await fixture.auditRows({ tenantId });
            const otherScope = await scopeOf(
              fixture.base,
              "a1-other",
              "team-a1",
            );
            await fixture.leases.issue(otherScope, {
              credentialId: pSite.credentialId,
              purpose: "bot-run",
            });
            await fixture.leases.issue(otherScope, {
              credentialId: randomUUID(),
              purpose: "bot-run",
            });
            expect(await fixture.leaseRows({ tenantId })).toEqual(beforeLeases);
            expect(await fixture.auditRows({ tenantId })).toEqual(beforeAudit);
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 验收 4：每次签发、使用与撤销留审计（不含明文）
    // -------------------------------------------------------------------------

    describeDb(
      "AC4: every issue, use and revoke is audited without secrets",
      () => {
        itDb(
          "a full lifecycle leaves exactly one audit row per operation, in order",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: t1.credentialId,
              purpose: "bot-run",
              ttlSeconds: 3600,
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
              checkpoint: "task.sensitive",
            });
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "bot-run",
            });
            expect(
              (
                await fixture.leaseAdmin.revoke({
                  tenantId: t1.tenantId,
                  leaseId: issued.leaseId,
                })
              ).revoked,
            ).toBe(true);

            const rows = await fixture.auditRows({
              tenantId: t1.tenantId,
              leaseId: issued.leaseId,
            });
            expect(rows.map((row) => row.action)).toEqual([
              "issued",
              "validated",
              "validated",
              "revoked",
            ]);
            for (const row of rows) {
              expect(row.leaseId).toBe(issued.leaseId);
              expect(row.credentialId).toBe(t1.credentialId);
              expect(row.principalId).toBe(scope.principalId);
            }
            // detail 闭形：issued 携带 ttl 与 workspace；validated 携带
            // checkpoint（显式与默认各一次）；revoked 携带凭据与用途。
            expect(rows[0].detail).toEqual({
              credential_id: t1.credentialId,
              purpose: "bot-run",
              workspace_id: scope.workspaceId,
              ttl_seconds: 3600,
            });
            expect(rows[1].detail).toEqual({
              credential_id: t1.credentialId,
              purpose: "bot-run",
              checkpoint: "task.sensitive",
            });
            expect(rows[2].detail).toEqual({
              credential_id: t1.credentialId,
              purpose: "bot-run",
              checkpoint: "credentials.access",
            });
            expect(rows[3].detail).toEqual({
              credential_id: t1.credentialId,
              purpose: "bot-run",
            });
          },
        );

        itDb(
          "audit rows never carry secret material and denied operations write nothing",
          async () => {
            const scope = await scopeOf(fixture.base, "a1-member", "team-a1");
            const issued = await fixture.leases.issue(scope, {
              credentialId: t1.credentialId,
              purpose: "bot-run",
            });
            expect(issued.outcome).toBe("allow");
            if (issued.outcome !== "allow") return;
            // 一次 deny（用途不符）与一次 deny（未知 lease）都不落审计。
            await fixture.leases.validate(scope, {
              leaseId: issued.leaseId,
              purpose: "connector-call",
            });
            await fixture.leases.validate(scope, {
              leaseId: randomUUID(),
              purpose: "bot-run",
            });
            const rows = await fixture.auditRows({ tenantId: t1.tenantId });
            const serialized = JSON.stringify(rows);
            for (const canary of ALL_CANARIES) {
              expect(serialized).not.toContain(canary);
            }
            const walk = (node: unknown): void => {
              if (node === null || typeof node !== "object") return;
              for (const key of Object.keys(node as Record<string, unknown>)) {
                expect(SECRET_CARRIER_KEYS).not.toContain(key);
                walk((node as Record<string, unknown>)[key]);
              }
            };
            for (const row of rows) {
              walk(row.detail);
            }
            // 恰好每个成功操作一行：本租户审计数 == lease 数（issued）+
            // validate 次数 + revoke 次数；两条 deny 未增加行数——用同租户
            // 前后计数钉死（deny 零审计零副作用）。
            const issuedCount = rows.filter(
              (row) => row.action === "issued",
            ).length;
            const validatedCount = rows.filter(
              (row) => row.action === "validated",
            ).length;
            const revokedCount = rows.filter(
              (row) => row.action === "revoked",
            ).length;
            expect(validatedCount).toBeGreaterThanOrEqual(1);
            expect(revokedCount).toBeGreaterThanOrEqual(1);
            expect(issuedCount).toBeGreaterThanOrEqual(1);
            // 精确断言：本 lease 恰 1 行（issued）；两条 deny（用途不符 /
            // 未知 lease）均未加行——deny 零审计零副作用在此钉死。
            const mine = rows.filter((row) => row.leaseId === issued.leaseId);
            expect(mine.map((row) => row.action)).toEqual(["issued"]);
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // 存储契约：RLS、最小授权、结构 CHECK
    // -------------------------------------------------------------------------

    describeDb("MT029 storage fences", () => {
      itDb("both lease tables are FORCE row-level security", async () => {
        for (const table of [
          "enterprise_credential_leases",
          "enterprise_credential_lease_audit",
        ]) {
          const flags = await fixture.base.catalog.rlsFlags(table);
          expect(flags.relrowsecurity).toBe(true);
          expect(flags.relforcerowsecurity).toBe(true);
        }
      });

      itDb(
        "the grant matrix is minimal: directory blind, data cannot mutate, nobody deletes",
        async () => {
          const { catalog } = fixture.base;
          // leases：data 只读+插（本人行 RLS pin）；operator 读+改（撤销）。
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_data",
              "SELECT",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_data",
              "INSERT",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_data",
              "UPDATE",
            ),
          ).toBe(false);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_data",
              "DELETE",
            ),
          ).toBe(false);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_operator",
              "SELECT",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_operator",
              "UPDATE",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_operator",
              "INSERT",
            ),
          ).toBe(false);
          for (const role of [
            "ob_ent_directory",
            "ob_ent_data",
            "ob_ent_operator",
          ] as const) {
            expect(
              await catalog.hasPrivilege(
                "enterprise_credential_leases",
                role,
                "DELETE",
              ),
            ).toBe(false);
            expect(
              await catalog.hasPrivilege(
                "enterprise_credential_lease_audit",
                role,
                "DELETE",
              ),
            ).toBe(false);
            expect(
              await catalog.hasPrivilege(
                "enterprise_credential_lease_audit",
                role,
                "UPDATE",
              ),
            ).toBe(false);
          }
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_leases",
              "ob_ent_directory",
              "SELECT",
            ),
          ).toBe(false);
          // audit：data 只插不读（成员不能互相侦察）；operator 读+插（撤销留痕）。
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_lease_audit",
              "ob_ent_data",
              "INSERT",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_lease_audit",
              "ob_ent_data",
              "SELECT",
            ),
          ).toBe(false);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_lease_audit",
              "ob_ent_operator",
              "SELECT",
            ),
          ).toBe(true);
          expect(
            await catalog.hasPrivilege(
              "enterprise_credential_lease_audit",
              "ob_ent_directory",
              "SELECT",
            ),
          ).toBe(false);
        },
      );

      itDb(
        "purpose, status, window and row-shape CHECKs hold at the storage boundary",
        async () => {
          // CHECK 探针走受限 data 通道（RLS INSERT 策略 pin tenant+holder，
          // 探针行本身合法可过 RLS，坏值由 CHECK 判 23514）；operator 无
          // INSERT 授权是授权矩阵用例钉死的事实——探针绝不走提权通道。
          const holder = fixture.base.principalOf("a1-member", "company-a");
          const team = fixture.base.base.teamOf("a1-member", "team-a1");
          const dataTx = (
            body: (
              tx: Parameters<
                Parameters<typeof fixture.base.base.data.transaction>[0]
              >[0],
            ) => Promise<unknown>,
          ) =>
            thrownMessage(
              fixture.base.base.data.transaction(async (tx) => {
                await tx.execute(
                  sql`select set_config('app.tenant_id', ${t1.tenantId}, true), set_config('app.principal_id', ${fixture.base.principalOf("a1-member", "company-a")}, true)`,
                );
                await body(tx);
              }),
            );
          const attempt = (purpose: string, status: string, window: string) =>
            dataTx((tx) =>
              tx.execute(
                sql`insert into enterprise_credential_leases
                (tenant_id, id, credential_id, principal_id, workspace_id, purpose, status, created_at, expires_at)
                values (${t1.tenantId}, ${randomUUID()}, ${t1.credentialId}, ${holder}, ${team.workspaceId}, ${purpose}, ${status}, now(), now() + ${window}::interval)`,
              ),
            );
          expect(await attempt("surfing", "active", "1 hour")).toContain(
            "23514",
          );
          expect(await attempt("bot-run", "frozen", "1 hour")).toContain(
            "23514",
          );
          // 窗口倒挂（expires_at <= created_at）。
          expect(
            await dataTx((tx) =>
              tx.execute(
                sql`insert into enterprise_credential_leases
                (tenant_id, id, credential_id, principal_id, workspace_id, purpose, status, created_at, expires_at)
                values (${t1.tenantId}, ${randomUUID()}, ${t1.credentialId}, ${holder}, ${team.workspaceId}, 'bot-run', 'active', now(), now())`,
              ),
            ),
          ).toContain("23514");
        },
      );

      itDb(
        "the audit vocabulary and detail shape are closed sets at the database too",
        async () => {
          const holder = fixture.base.principalOf("a1-member", "company-a");
          const badAction = await thrownMessage(
            fixture.base.base.data.transaction(async (tx) => {
              await tx.execute(
                sql`select set_config('app.tenant_id', ${t1.tenantId}, true)`,
              );
              await tx.execute(
                sql`insert into enterprise_credential_lease_audit
              (tenant_id, id, lease_id, credential_id, principal_id, action, detail)
              values (${t1.tenantId}, ${randomUUID()}, ${randomUUID()}, ${t1.credentialId}, ${holder}, 'inspected', ${{
                checkpoint: "list",
              }})`,
              );
            }),
          );
          expect(badAction).toContain("23514");
          const badDetail = await thrownMessage(
            fixture.base.base.data.transaction(async (tx) => {
              await tx.execute(
                sql`select set_config('app.tenant_id', ${t1.tenantId}, true)`,
              );
              await tx.execute(
                sql`insert into enterprise_credential_lease_audit
              (tenant_id, id, lease_id, credential_id, principal_id, action, detail)
              values (${t1.tenantId}, ${randomUUID()}, ${randomUUID()}, ${t1.credentialId}, ${holder}, 'issued', ${{
                plaintext: "leak",
              }})`,
              );
            }),
          );
          expect(badDetail).toContain("23514");
        },
      );

      itDb(
        "cross-company lease rows are structurally impossible (composite FKs)",
        async () => {
          // 结构证明走目录只读探针（超户，披露的 stand-in——绝不用于业务
          // 读写）：三条复合外键分别钉住凭据/持有人/团队必属本公司，且
          // 删除策略为 cascade。RLS 授权矩阵内没有任何通道能插入跨公司
          // 行（data 的 INSERT 策略 pin principal，operator 无 INSERT），
          // 故不以外键违例探针破授权矩阵（MT027 的 23503 探针依赖
          // operator INSERT——本表授权矩阵刻意不授予）。
          const fks = await fixture.catalog.foreignKeys(
            "enterprise_credential_leases",
          );
          expect(fks).toContainEqual(
            expect.objectContaining({
              refTable: "enterprise_credentials",
              onDelete: "c",
            }),
          );
          expect(fks).toContainEqual(
            expect.objectContaining({
              refTable: "enterprise_memberships",
              onDelete: "c",
            }),
          );
          expect(fks).toContainEqual(
            expect.objectContaining({
              refTable: "enterprise_workspaces",
              onDelete: "c",
            }),
          );
        },
      );
    });
  },
);
