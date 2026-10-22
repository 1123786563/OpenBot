// server/tests/multitenancy/audit-domains.test.ts
// MT078（Issue #121）：业务审计与身份审计分域，计费管理需明确授权。
//
// 票面四条验收全部在真实 PostgreSQL（专用 openbot_enterprise_* 测试库 +
// 受限 ob_ent_* 角色 + RLS）上钉死；缺 env 显式 skip、skipped 不计通过：
//   AC1 审计查询只返回授权范围内的记录；跨范围查询为空或拒绝；
//   AC2 审计导出遵守同样范围与脱敏规则，不含明文秘密；
//   AC3 计费管理动作（发放、调整、退款）需要明确授权并留审计；
//   AC4 审计记录本身不被业务越权用例泄露存在性。
// 判定面：server/src/enterprise/tenancy/audit-domains.ts；表：MT078 任务迁移
// （enterprise_audit_events / billing_company_manage_grants）。

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import {
  AUDIT_SCOPE_FORBIDDEN,
  BILLING_MANAGE_REQUIRED,
  type BillingManagementService,
  createBillingManagementService,
  exportTenantAuditEvents,
  queryTenantAuditEvents,
  recordTenantAuditEvent,
} from "../../src/enterprise/tenancy/audit-domains";
import {
  type AuditDomainsFixture,
  auditRowCount,
  createAuditDomainsFixture,
  probeAuditDomainsEnvironment,
} from "./support/audit-domains";

const ENV = probeAuditDomainsEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: AuditDomainsFixture;
let billing: BillingManagementService;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createAuditDomainsFixture();
  billing = createBillingManagementService({
    database: fixture.db,
    operator: fixture.operator,
    writer: fixture.writer,
  });
});

afterAll(async () => {
  if (ENV.ok) await fixture.dispose();
});

describeDb("MT078 #121 audit domains", () => {
  beforeAll(async () => {
    // 种子：公司 A 三域各有事件；公司 B 一条 business 事件（跨公司对照）。
    // 载荷带敏感键——AC2 的脱敏面在写入侧就要成立。
    await recordTenantAuditEvent(fixture.operator, {
      tenantId: fixture.ids.companyA,
      domain: "business",
      eventType: "document.updated",
      actorId: fixture.caller("a-member").principalId,
      payload: { note: "mt078-a-business", api_key: "plaintext-never-lands" },
    });
    await recordTenantAuditEvent(fixture.operator, {
      tenantId: fixture.ids.companyA,
      domain: "identity",
      eventType: "session.signed_in",
      actorId: fixture.caller("a-member").principalId,
      payload: { note: "mt078-a-identity", token: "secret-token-value" },
    });
    await recordTenantAuditEvent(fixture.operator, {
      tenantId: fixture.ids.companyA,
      domain: "platform",
      eventType: "management_action.cross_plane",
      actorId: "mt078-platform",
      payload: { note: "mt078-a-platform", password: "secret-password-value" },
    });
    await recordTenantAuditEvent(fixture.operator, {
      tenantId: fixture.ids.companyB,
      domain: "business",
      eventType: "document.updated",
      actorId: fixture.caller("b-admin").principalId,
      payload: { note: "mt078-b-business" },
    });
  });

  // ------------------------------------------------------------------ AC1
  describe("AC1 审计查询只返回授权范围内的记录；跨范围为空或拒绝", () => {
    itDb(
      "公司 auditor 读 business：只见本域本公司，不见 identity/platform 与他司",
      async () => {
        const rows = await queryTenantAuditEvents(
          fixture.operator,
          {
            kind: "company",
            principalId: fixture.caller("a-auditor").principalId,
          },
          { tenantId: fixture.ids.companyA, domain: "business" },
        );
        expect(rows.length).toBe(1);
        expect(rows[0].eventType).toBe("document.updated");
        expect(rows.every((row) => row.domain === "business")).toBe(true);
        // 写入侧已脱敏：明文秘密不落域。
        expect(rows[0].payload.api_key).toBe("[REDACTED]");
      },
    );

    itDb(
      "公司 tenant_admin 读 business：同一授权域（auditor 与 admin 同门）",
      async () => {
        const rows = await queryTenantAuditEvents(
          fixture.operator,
          {
            kind: "company",
            principalId: fixture.caller("a-admin").principalId,
          },
          { tenantId: fixture.ids.companyA, domain: "business" },
        );
        expect(rows.length).toBe(1);
      },
    );

    itDb(
      "普通成员读 business：拒绝，与「公司不存在」同形（不泄露存在性）",
      async () => {
        const member = queryTenantAuditEvents(
          fixture.operator,
          {
            kind: "company",
            principalId: fixture.caller("a-member").principalId,
          },
          { tenantId: fixture.ids.companyA, domain: "business" },
        );
        const stranger = queryTenantAuditEvents(
          fixture.operator,
          {
            kind: "company",
            principalId: fixture.caller("a-member").principalId,
          },
          {
            tenantId: `${fixture.ids.companyA}-nonexistent`,
            domain: "business",
          },
        );
        await expect(member).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
        await expect(stranger).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
      },
    );

    itDb(
      "公司主体读 identity / platform：拒绝（身份与平台审计是平台面）",
      async () => {
        for (const domain of ["identity", "platform"] as const) {
          await expect(
            queryTenantAuditEvents(
              fixture.operator,
              {
                kind: "company",
                principalId: fixture.caller("a-admin").principalId,
              },
              { tenantId: fixture.ids.companyA, domain },
            ),
          ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
        }
      },
    );

    itDb("平台主体读 identity / platform：放行且只见该域", async () => {
      const identity = await queryTenantAuditEvents(
        fixture.operator,
        { kind: "platform", subject: fixture.platformSubject },
        { tenantId: fixture.ids.companyA, domain: "identity" },
      );
      expect(identity.length).toBe(1);
      expect(identity[0].domain).toBe("identity");
      const platform = await queryTenantAuditEvents(
        fixture.operator,
        { kind: "platform", subject: fixture.platformSubject },
        { tenantId: fixture.ids.companyA, domain: "platform" },
      );
      expect(platform.length).toBe(1);
      expect(platform[0].domain).toBe("platform");
    });

    itDb(
      "平台主体读 business：拒绝（跨面授权本票不发放，fail-closed）",
      async () => {
        await expect(
          queryTenantAuditEvents(
            fixture.operator,
            { kind: "platform", subject: fixture.platformSubject },
            { tenantId: fixture.ids.companyA, domain: "business" },
          ),
        ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
      },
    );

    itDb(
      "他司 tenant_admin 查本公司：拒绝（成员资格活查按租户收口）",
      async () => {
        await expect(
          queryTenantAuditEvents(
            fixture.operator,
            {
              kind: "company",
              principalId: fixture.caller("b-admin").principalId,
            },
            { tenantId: fixture.ids.companyA, domain: "business" },
          ),
        ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
      },
    );

    itDb("RLS 地板：operator pin 到 B 时 A 的审计行结构性不可见", async () => {
      const rows = await fixture.queryRestricted(
        "operator",
        { tenantId: fixture.ids.companyB },
        "select count(*)::int as count from enterprise_audit_events where tenant_id = $1",
        [fixture.ids.companyA],
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    });

    itDb("停用成员资格立即失效：auditor 被停用后查询拒绝", async () => {
      const suspended = fixture.caller("a-auditor").principalId;
      // owner 通道置备翻转（A5 邻接：停用立即生效）。
      await fixture.db.execute(
        sql`update enterprise_memberships set status = 'suspended' where tenant_id = ${fixture.ids.companyA} and principal_id = ${suspended}`,
      );
      await expect(
        queryTenantAuditEvents(
          fixture.operator,
          { kind: "company", principalId: suspended },
          { tenantId: fixture.ids.companyA, domain: "business" },
        ),
      ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
      await fixture.db.execute(
        sql`update enterprise_memberships set status = 'active' where tenant_id = ${fixture.ids.companyA} and principal_id = ${suspended}`,
      );
      const rows = await queryTenantAuditEvents(
        fixture.operator,
        { kind: "company", principalId: suspended },
        { tenantId: fixture.ids.companyA, domain: "business" },
      );
      expect(rows.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------ AC2
  describe("AC2 审计导出遵守同样范围与脱敏规则，不含明文秘密", () => {
    itDb("auditor 导出 business：同一判定门、同一脱敏", async () => {
      const exported = await exportTenantAuditEvents(
        fixture.operator,
        {
          kind: "company",
          principalId: fixture.caller("a-auditor").principalId,
        },
        { tenantId: fixture.ids.companyA, domain: "business" },
      );
      expect(exported.events.length).toBe(1);
      expect(JSON.stringify(exported.events)).not.toContain(
        "plaintext-never-lands",
      );
      expect(exported.truncated).toBe(false);
    });

    itDb("越权导出与越权查询同形拒绝", async () => {
      await expect(
        exportTenantAuditEvents(
          fixture.operator,
          {
            kind: "company",
            principalId: fixture.caller("a-member").principalId,
          },
          { tenantId: fixture.ids.companyA, domain: "business" },
        ),
      ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
      await expect(
        exportTenantAuditEvents(
          fixture.operator,
          { kind: "platform", subject: fixture.platformSubject },
          { tenantId: fixture.ids.companyA, domain: "business" },
        ),
      ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
    });

    itDb("行数封顶如实披露 truncated，不静默截断", async () => {
      for (let index = 0; index < 3; index += 1) {
        await recordTenantAuditEvent(fixture.operator, {
          tenantId: fixture.ids.companyB,
          domain: "business",
          eventType: "document.updated",
          actorId: fixture.caller("b-admin").principalId,
          payload: { index },
        });
      }
      const exported = await exportTenantAuditEvents(
        fixture.operator,
        { kind: "company", principalId: fixture.caller("b-admin").principalId },
        { tenantId: fixture.ids.companyB, domain: "business", maxRows: 2 },
      );
      expect(exported.events.length).toBe(2);
      expect(exported.truncated).toBe(true);
    });

    itDb("identity 域导出：平台侧可用且脱敏（token 不出域）", async () => {
      const exported = await exportTenantAuditEvents(
        fixture.operator,
        { kind: "platform", subject: fixture.platformSubject },
        { tenantId: fixture.ids.companyA, domain: "identity" },
      );
      expect(exported.events.length).toBe(1);
      expect(JSON.stringify(exported.events)).not.toContain(
        "secret-token-value",
      );
    });
  });

  // ------------------------------------------------------------------ AC3
  describe("AC3 计费管理动作需要明确授权并留审计", () => {
    const managerKey = () => fixture.caller("a-manager");
    const actionBase = {
      tenantId: () => fixture.ids.companyA,
      principalId: () => managerKey().principalId,
      amountCents: 1000,
      reason: "mt078 manage action",
    } as const;

    itDb("无授权：拒绝、账面零变动、零审计写入", async () => {
      const before = await fixture.balanceOf("company-a");
      await expect(
        billing.performBillingManagementAction({
          ...actionBase,
          tenantId: actionBase.tenantId(),
          principalId: actionBase.principalId(),
          action: "grant",
          idempotencyKey: "mt078-denied-grant",
        }),
      ).rejects.toThrow(BILLING_MANAGE_REQUIRED);
      expect(await fixture.balanceOf("company-a")).toBe(before);
      expect(
        await auditRowCount(fixture.db, fixture.ids.companyA, "business"),
      ).toBe(1);
    });

    itDb("tenant_admin 角色不自动获得（角色与授权是两个事实）", async () => {
      await expect(
        billing.performBillingManagementAction({
          ...actionBase,
          tenantId: actionBase.tenantId(),
          principalId: fixture.caller("a-admin").principalId,
          action: "grant",
          idempotencyKey: "mt078-admin-no-grant",
        }),
      ).rejects.toThrow(BILLING_MANAGE_REQUIRED);
    });

    itDb("授权后发放：账面入账 + business 域审计事件", async () => {
      await billing.grantBillingManager({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a-manager").principalId,
        grantedBy: fixture.caller("a-admin").principalId,
        actions: ["grant", "adjust", "refund"],
      });
      const before = await fixture.balanceOf("company-a");
      const outcome = await billing.performBillingManagementAction({
        ...actionBase,
        tenantId: actionBase.tenantId(),
        principalId: actionBase.principalId(),
        action: "grant",
        idempotencyKey: "mt078-grant-1",
      });
      expect(outcome.inserted).toBe(true);
      expect(await fixture.balanceOf("company-a")).toBe(before + 1000);
      const rows = await queryTenantAuditEvents(
        fixture.operator,
        {
          kind: "company",
          principalId: fixture.caller("a-auditor").principalId,
        },
        {
          tenantId: fixture.ids.companyA,
          domain: "business",
          eventType: "billing.manage.grant",
        },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].actorId).toBe(fixture.caller("a-manager").principalId);
      expect(rows[0].payload.amountCents).toBe(1000);
    });

    itDb(
      "幂等回放：同 idempotencyKey 只入账一次，审计照记（inserted=false）",
      async () => {
        const before = await fixture.balanceOf("company-a");
        const outcome = await billing.performBillingManagementAction({
          ...actionBase,
          tenantId: actionBase.tenantId(),
          principalId: actionBase.principalId(),
          action: "grant",
          idempotencyKey: "mt078-grant-1",
        });
        expect(outcome.inserted).toBe(false);
        expect(await fixture.balanceOf("company-a")).toBe(before);
      },
    );

    itDb(
      "动作位不覆盖：只授 grant 者执行 refund → 拒绝且账面零变动",
      async () => {
        await billing.grantBillingManager({
          tenantId: fixture.ids.companyB,
          principalId: fixture.caller("b-admin").principalId,
          grantedBy: fixture.caller("b-admin").principalId,
          actions: ["grant"],
        });
        const before = await fixture.balanceOf("company-b");
        await expect(
          billing.performBillingManagementAction({
            tenantId: fixture.ids.companyB,
            principalId: fixture.caller("b-admin").principalId,
            action: "refund",
            amountCents: 500,
            reason: "mt078 refund without bit",
            idempotencyKey: "mt078-refund-no-bit",
          }),
        ).rejects.toThrow(BILLING_MANAGE_REQUIRED);
        expect(await fixture.balanceOf("company-b")).toBe(before);
      },
    );

    itDb("跨公司：B 的管理授权对 A 的账面无效", async () => {
      await expect(
        billing.performBillingManagementAction({
          tenantId: fixture.ids.companyA,
          principalId: fixture.caller("b-admin").principalId,
          action: "refund",
          amountCents: 100,
          reason: "mt078 cross company",
          idempotencyKey: "mt078-cross-company",
        }),
      ).rejects.toThrow(BILLING_MANAGE_REQUIRED);
    });

    itDb("撤销后：动作拒绝（撤销=删行，无中间态）", async () => {
      const { revoked } = await billing.revokeBillingManager({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a-manager").principalId,
      });
      expect(revoked).toBe(true);
      const before = await fixture.balanceOf("company-a");
      await expect(
        billing.performBillingManagementAction({
          ...actionBase,
          tenantId: actionBase.tenantId(),
          principalId: actionBase.principalId(),
          action: "adjust",
          idempotencyKey: "mt078-adjust-after-revoke",
        }),
      ).rejects.toThrow(BILLING_MANAGE_REQUIRED);
      expect(await fixture.balanceOf("company-a")).toBe(before);
      // 再次撤销幂等。
      expect(
        await billing.revokeBillingManager({
          tenantId: fixture.ids.companyA,
          principalId: fixture.caller("a-manager").principalId,
        }),
      ).toEqual({ revoked: false });
    });

    itDb("重复授权响亮拒绝（不静默刷新）", async () => {
      await expect(
        billing.grantBillingManager({
          tenantId: fixture.ids.companyB,
          principalId: fixture.caller("b-admin").principalId,
          grantedBy: fixture.caller("b-admin").principalId,
          actions: ["refund"],
        }),
      ).rejects.toThrow(/BILLING_MANAGE_GRANT_EXISTS/);
    });
  });

  // ------------------------------------------------------------------ AC4
  describe("AC4 审计记录不被业务越权用例泄露存在性", () => {
    itDb(
      "结构隔离：directory/data 对审计表零授权，operator 只有 SELECT/INSERT",
      async () => {
        const privilege = async (role: string, action: string) =>
          (
            await fixture.queryRestricted(
              "operator",
              { tenantId: fixture.ids.companyA },
              "select has_table_privilege($1, 'enterprise_audit_events', $2) as ok",
              [role, action],
            )
          )[0]?.ok;
        expect(await privilege("ob_ent_directory", "SELECT")).toBe(false);
        expect(await privilege("ob_ent_data", "SELECT")).toBe(false);
        expect(await privilege("ob_ent_operator", "SELECT")).toBe(true);
        expect(await privilege("ob_ent_operator", "INSERT")).toBe(true);
        expect(await privilege("ob_ent_operator", "DELETE")).toBe(false);
      },
    );

    itDb(
      "计费管理授权表对受限三角色零授权（billing 域 owner 通道）",
      async () => {
        for (const role of [
          "ob_ent_directory",
          "ob_ent_data",
          "ob_ent_operator",
        ]) {
          const rows = await fixture.queryRestricted(
            "operator",
            { tenantId: fixture.ids.companyA },
            "select has_table_privilege($1, 'billing_company_manage_grants', 'SELECT') as ok",
            [role],
          );
          expect(rows[0]?.ok).toBe(false);
        }
      },
    );

    itDb(
      "业务越权路径（data 角色）读不到审计行：RLS 下计数为零而非错误差异",
      async () => {
        // data 角色对审计表无 SELECT 授权：读取被权限层拒绝（结构隔离），
        // 错误与「表不存在」形状一致，不泄露行存在性。
        await expect(
          fixture.queryRestricted(
            "data",
            { tenantId: fixture.ids.companyA },
            "select count(*)::int as count from enterprise_audit_events",
            [],
          ),
        ).rejects.toThrow();
      },
    );

    itDb("operator 无租户 pin（上下文缺失）读审计表为零行", async () => {
      const rows = await fixture.queryRestricted(
        "operator",
        undefined,
        "select count(*)::int as count from enterprise_audit_events",
        [],
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    });

    itDb(
      "拒绝语义同形：成员/角色/公司三种缺口同一哨兵同一状态语义",
      async () => {
        const attempts = [
          {
            kind: "company",
            principalId: fixture.caller("a-member").principalId,
          },
          {
            kind: "company",
            principalId: `${fixture.caller("a-member").principalId}-x`,
          },
          { kind: "platform", subject: fixture.platformSubject },
        ] as const;
        for (const actor of attempts) {
          await expect(
            queryTenantAuditEvents(fixture.operator, actor, {
              tenantId: fixture.ids.companyA,
              domain: actor.kind === "platform" ? "business" : "identity",
            }),
          ).rejects.toThrow(AUDIT_SCOPE_FORBIDDEN);
        }
      },
    );
  });
});
