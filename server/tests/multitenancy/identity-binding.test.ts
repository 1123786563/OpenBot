// server/tests/multitenancy/identity-binding.test.ts
// MT026（Issue #69）：身份绑定回调按服务端持久状态归属，不接受回调参数
// 改写公司。
//
// 验收事实源（Issue #69 验收 4，逐条对应 describe）：
//   (4) 身份绑定回调按服务端持久状态归属。
//
// 机制：意图创建时归属（tenant + user + kind）即持久化在
// enterprise_identity_binding_intents（state 主键不透明、服务端生成）；
// 回调解析按 state 精确 pin（RLS 臂 app.identity_binding_state）读持久行，
// 公司归属只来自行。回调声称的公司 ≠ 持久公司 →
// IDENTITY_BINDING_TENANT_MISMATCH（不消费、零改写——声称不生效也不烧掉
// state）；成功解析一次性消费（consumed_at）；未知/已消费/过期分别响亮
// 拒绝。受限角色无法按公司枚举意图（SELECT 只有 state 臂——RLS 反证）。
//
// 环境契约：同 sso-scim-config.test.ts——缺显式 env 整套显式 skip，绝不回退
// 开发库。

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

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createSsoScimFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

describeDb(
  "MT026 AC4: callback attribution follows the server-persisted state",
  () => {
    itDb(
      "resolution attributes the persisted company and user, exactly once",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const tenantA = fixture.isolation.ids["company-a"];
        const intent = await fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: multi.userId!,
          kind: "sso",
        });
        expect(intent.state).toBeTruthy();
        expect(intent.expiresAt.getTime()).toBeGreaterThan(Date.now());

        const resolved = await fixture.bindingService.resolveIntent({
          state: intent.state,
        });
        expect(resolved).toMatchObject({
          tenantId: tenantA,
          userId: multi.userId,
          kind: "sso",
        });
        // One-time: the second resolution of the same state is refused.
        await expect(
          fixture.bindingService.resolveIntent({ state: intent.state }),
        ).rejects.toThrow("IDENTITY_BINDING_STATE_CONSUMED");
      },
    );

    itDb(
      "a callback claiming another company is refused without burning the state",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const tenantA = fixture.isolation.ids["company-a"];
        const intent = await fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: multi.userId!,
          kind: "sso",
        });
        // The callback parameter tries to re-attribute the binding to company B.
        await expect(
          fixture.bindingService.resolveIntent({
            state: intent.state,
            claimedTenantId: fixture.isolation.ids["company-b"],
          }),
        ).rejects.toThrow("IDENTITY_BINDING_TENANT_MISMATCH");
        // The claim did not take effect AND did not consume the state: an honest
        // callback afterwards still resolves to the persisted company.
        const resolved = await fixture.bindingService.resolveIntent({
          state: intent.state,
        });
        expect(resolved.tenantId).toBe(tenantA);
      },
    );

    itDb("an unknown state is refused", async () => {
      await expect(
        fixture.bindingService.resolveIntent({ state: "no-such-state" }),
      ).rejects.toThrow("IDENTITY_BINDING_STATE_UNKNOWN");
    });

    itDb(
      "an expired intent is refused and cannot be consumed by a late callback",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const intent = await fixture.bindingService.createIntent({
          tenantId: fixture.isolation.ids["company-a"],
          userId: multi.userId!,
          kind: "scim",
          ttlSeconds: 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(
          fixture.bindingService.resolveIntent({ state: intent.state }),
        ).rejects.toThrow("IDENTITY_BINDING_EXPIRED");
      },
    );

    itDb("creation validates kind, ttl, and the user's existence", async () => {
      const multi = fixture.isolation.identities["multi-company"];
      const tenantA = fixture.isolation.ids["company-a"];
      await expect(
        fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: multi.userId!,
          kind: "oauth" as never,
        }),
      ).rejects.toThrow("IDENTITY_BINDING_INVALID");
      await expect(
        fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: multi.userId!,
          kind: "sso",
          ttlSeconds: 0,
        }),
      ).rejects.toThrow("IDENTITY_BINDING_INVALID");
      await expect(
        fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: multi.userId!,
          kind: "sso",
          ttlSeconds: 100_000,
        }),
      ).rejects.toThrow("IDENTITY_BINDING_INVALID");
      await expect(
        fixture.bindingService.createIntent({
          tenantId: tenantA,
          userId: "user-that-does-not-exist",
          kind: "sso",
        }),
      ).rejects.toThrow();
    });
  },
);

describeDb(
  "MT026 AC4 storage fence: intents are reachable only by exact state",
  () => {
    itDb(
      "the operator role cannot enumerate intents by company pin",
      async () => {
        // Intent rows exist (created above), but the SELECT policy only opens the
        // state-pin arm: a company-pinned enumeration must return zero rows.
        const tenantA = fixture.isolation.ids["company-a"];
        const rows = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantA },
          "select count(*)::int as n from enterprise_identity_binding_intents",
          [],
        );
        expect(Number((rows[0] as { n: number }).n)).toBe(0);
      },
    );
  },
);
