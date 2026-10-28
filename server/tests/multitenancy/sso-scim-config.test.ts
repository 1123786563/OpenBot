// server/tests/multitenancy/sso-scim-config.test.ts
// MT026（Issue #69）：每公司 SSO 配置与 SCIM 绑定的公司管理面隔离。
//
// 验收事实源（Issue #69 验收 2，逐条对应 describe）：
//   (2) SSO 配置读取与修改仅限该公司授权管理员；跨公司读取返回不可见语义。
//
// 隔离机制的三层证明：
//   - 结构层：服务的每个方法只收受信 CompanyAdminContext（MT006 签发半边，
//     WeakSet 信任 + 租户绑定）——API 形状上不存在租户参数，跨公司读取
//     不可表达；伪造上下文一律 UNVERIFIED_ADMIN_CONTEXT。
//   - 判定层：写路径在同一 operator 事务内重验 tenant_admin + epoch
//     （签发后的角色/成员漂移 → SCOPE_REVOKED）；无配置行与"别家公司有
//     配置"在读取上同码（SSO_CONFIG_NOT_FOUND——不可见语义，无存在泄漏）。
//   - 存储层：data/operator 角色 pin app.tenant_id=B 时 SELECT 不到 A 的行
//     （真实 RLS 反证，绝不只靠服务层纪律）。
//
// SCIM 绑定登记/停用走同一公司管理面：connection_key 全局唯一，B 公司登记
// A 已持有的 key 与本司重复登记返回同一代码（SCIM_BINDING_EXISTS——不泄漏
// 持有者）；跨公司/未知 key 的停用一律 SCIM_BINDING_NOT_FOUND（不可见）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里），绝不
// 回退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createSsoScimFixture, type SsoScimFixture } from "./support/sso-scim";

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
      reason: `MT026 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: SsoScimFixture;

const VALID_CONFIG = {
  protocol: "oidc",
  issuer: "https://idp.company-a.example",
  domain: "company-a.example",
  credentialRef: "credentials/sso/company-a/client-secret",
} as const;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createSsoScimFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

describeDb(
  "MT026 SSO config: only the company's own admin can read or modify",
  () => {
    itDb(
      "company A's admin writes and reads back the company's own config (revision increments)",
      async () => {
        const context = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const first = await fixture.configService.writeSsoConfig(
          context,
          VALID_CONFIG,
        );
        expect(first.revision).toBe(1);
        const read = await fixture.configService.readSsoConfig(context);
        expect(read.config).toMatchObject({
          protocol: "oidc",
          issuer: "https://idp.company-a.example",
          domain: "company-a.example",
        });
        expect(read.revision).toBe(1);
        const second = await fixture.configService.writeSsoConfig(context, {
          ...VALID_CONFIG,
          issuer: "https://idp2.company-a.example",
        });
        expect(second.revision).toBe(2);
        const reread = await fixture.configService.readSsoConfig(context);
        expect(reread.config.issuer).toBe("https://idp2.company-a.example");
        expect(reread.revision).toBe(2);
      },
    );

    itDb(
      "a company with no config reads the same NOT_FOUND as any other company (invisible semantics)",
      async () => {
        // Company B's admin reads: no config row for B exists — and company A's
        // live config is not visible in any shape or value.
        const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
        let code = "";
        try {
          await fixture.configService.readSsoConfig(contextOfB);
        } catch (error) {
          code = error instanceof Error ? error.message : String(error);
        }
        expect(code).toBe("SSO_CONFIG_NOT_FOUND");
      },
    );

    itDb("a forged context is refused before any database access", async () => {
      const forged = {
        tenantId: fixture.isolation.ids["company-a"],
        principalId: "forged-principal",
        actorId: "forged-user",
        memberEpoch: 1,
      };
      await expect(fixture.configService.readSsoConfig(forged)).rejects.toThrow(
        "UNVERIFIED_ADMIN_CONTEXT",
      );
      await expect(
        fixture.configService.writeSsoConfig(forged, VALID_CONFIG),
      ).rejects.toThrow("UNVERIFIED_ADMIN_CONTEXT");
    });

    itDb(
      "company A's admin cannot even obtain a company B admin context",
      async () => {
        // The MT006 authorizer is the only trust issuer; it refuses a
        // non-member with the same no-existence-leak code as the business path.
        await expect(
          fixture.adminContextOf("company-admin", "company-b"),
        ).rejects.toThrow("TENANT_FORBIDDEN");
      },
    );
  },
);

describeDb(
  "MT026 SSO config: invalid documents are refused, references only",
  () => {
    itDb(
      "bad protocol, empty issuer, and a non-reference credential shape are refused",
      async () => {
        const context = await fixture.adminContextOf("b-admin", "company-b");
        await expect(
          fixture.configService.writeSsoConfig(context, {
            ...VALID_CONFIG,
            protocol: "ldap" as never,
          }),
        ).rejects.toThrow("SSO_CONFIG_INVALID");
        await expect(
          fixture.configService.writeSsoConfig(context, {
            ...VALID_CONFIG,
            issuer: "",
          }),
        ).rejects.toThrow("SSO_CONFIG_INVALID");
        await expect(
          fixture.configService.writeSsoConfig(context, {
            ...VALID_CONFIG,
            credentialRef: "",
          }),
        ).rejects.toThrow("SSO_CONFIG_INVALID");
      },
    );
  },
);

describeDb(
  "MT026 SCIM bindings: register, list, deactivate inside the company fence",
  () => {
    itDb(
      "company A registers a binding; the duplicate key (own or foreign) is the same refused code",
      async () => {
        const contextOfA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const registered = await fixture.configService.registerScimBinding(
          contextOfA,
          {
            connectionKey: "okta-company-a",
            credentialRef: "credentials/scim/company-a/token",
          },
        );
        expect(registered.bindingId).toBeTruthy();
        // Own duplicate.
        await expect(
          fixture.configService.registerScimBinding(contextOfA, {
            connectionKey: "okta-company-a",
            credentialRef: "credentials/scim/company-a/token",
          }),
        ).rejects.toThrow("SCIM_BINDING_EXISTS");
        // Foreign collision: company B registers company A's key. The code MUST
        // be the same as the own-duplicate case (no leak of which company holds it).
        const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
        await expect(
          fixture.configService.registerScimBinding(contextOfB, {
            connectionKey: "okta-company-a",
            credentialRef: "credentials/scim/company-b/token",
          }),
        ).rejects.toThrow("SCIM_BINDING_EXISTS");
      },
    );

    itDb(
      "listing returns only the caller's own company's bindings",
      async () => {
        const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
        await fixture.configService.registerScimBinding(contextOfB, {
          connectionKey: "entra-company-b",
          credentialRef: "credentials/scim/company-b/token",
        });
        const ofB = await fixture.configService.listScimBindings(contextOfB);
        expect(ofB.map((binding) => binding.connectionKey)).toEqual([
          "entra-company-b",
        ]);
        const contextOfA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const ofA = await fixture.configService.listScimBindings(contextOfA);
        expect(ofA.map((binding) => binding.connectionKey)).toEqual([
          "okta-company-a",
        ]);
      },
    );

    itDb(
      "deactivating an unknown or foreign key is the same NOT_FOUND (invisible)",
      async () => {
        const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
        await expect(
          fixture.configService.deactivateScimBinding(
            contextOfB,
            "okta-company-a",
          ),
        ).rejects.toThrow("SCIM_BINDING_NOT_FOUND");
        await expect(
          fixture.configService.deactivateScimBinding(
            contextOfB,
            "no-such-key",
          ),
        ).rejects.toThrow("SCIM_BINDING_NOT_FOUND");
      },
    );

    itDb(
      "deactivating the own binding flips status once and stays idempotent",
      async () => {
        const contextOfA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const first = await fixture.configService.deactivateScimBinding(
          contextOfA,
          "okta-company-a",
        );
        expect(first.alreadyDeactivated).toBe(false);
        const second = await fixture.configService.deactivateScimBinding(
          contextOfA,
          "okta-company-a",
        );
        expect(second.alreadyDeactivated).toBe(true);
        const listed = await fixture.configService.listScimBindings(contextOfA);
        expect(listed[0]?.status).toBe("deactivated");
      },
    );
  },
);

describeDb(
  "MT026 storage fence: the restricted roles cannot see across companies",
  () => {
    itDb(
      "operator role pinned to company B selects none of company A's config rows",
      async () => {
        const tenantA = fixture.isolation.ids["company-a"];
        const tenantB = fixture.isolation.ids["company-b"];
        const rows = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantB },
          "select tenant_id from enterprise_sso_configs",
          [],
        );
        expect(rows).toHaveLength(0);
        // Sanity: the same query pinned to A sees exactly A's row — the fence is
        // the pin, not an empty table.
        const rowsOfA = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantA },
          "select tenant_id from enterprise_sso_configs",
          [],
        );
        expect(rowsOfA).toHaveLength(1);
        expect(rowsOfA[0]?.tenant_id).toBe(tenantA);
      },
    );

    itDb(
      "data role pinned to company B cannot read company A's config row",
      async () => {
        const tenantB = fixture.isolation.ids["company-b"];
        const rows = await fixture.isolation.queryRestricted(
          "data",
          { tenantId: tenantB },
          "select tenant_id, document from enterprise_sso_configs",
          [],
        );
        expect(rows).toHaveLength(0);
      },
    );

    itDb(
      "operator role pinned to company B sees none of company A's SCIM binding rows",
      async () => {
        const tenantB = fixture.isolation.ids["company-b"];
        const rows = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantB },
          "select connection_key from enterprise_scim_directory_bindings",
          [],
        );
        // Company B legitimately sees its own binding; company A's key must not
        // be among them (the fence is the pin, not an empty table).
        const keys = rows.map((row) => row.connection_key);
        expect(keys).toContain("entra-company-b");
        expect(keys).not.toContain("okta-company-a");
      },
    );
  },
);

describeDb(
  "MT026 revalidation drift: a context issued before a membership change is refused",
  () => {
    // Runs last in the file on purpose: it suspends company-admin's own
    // company A membership (real offline revocation, epoch bump).
    itDb(
      "an in-transaction revalidation fails with SCOPE_REVOKED after the epoch moved",
      async () => {
        const context = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        await fixture.isolation.suspendCompanyMembership(
          "company-admin",
          fixture.isolation.ids["company-a"],
        );
        await expect(
          fixture.configService.writeSsoConfig(context, VALID_CONFIG),
        ).rejects.toThrow("SCOPE_REVOKED");
      },
    );
  },
);
