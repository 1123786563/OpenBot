import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRunHarness, probeRunsDatabase, type RunHarness } from "./support";

/*
 * E1-C RunPolicy（03 分册 §4.3，316-332 行）。
 *
 * 规则全集直接在真实库事务上取证：成员链、release published、resource/route 归属
 * scope 租户、显式 run_grants.start、model_grant.active、允许的 route profile；
 * read 须本人 Run 且专家资源 read 仍有效；resume 再验 start/resume_own 与当前模型
 * 授权；cancel 允许本人停止即使专家授权被撤、他人/跨租户不可。
 */

const probe = await probeRunsDatabase();
const describeDb = probe.ready ? describe : describe.skip;
if (!probe.ready) {
  console.warn(`[policy.test.ts] real-database assertions skipped: ${probe.reason}`);
}

let h: RunHarness;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

const runAccess = () => ({
  ownerPrincipalId: "r1c-principal-a",
  releaseId: h.releaseId,
  workspaceId: h.workspaceId,
  threadId: h.threadId,
});

describeDb("E1-C RunPolicy", () => {
  beforeAll(async () => {
    h = await createRunHarness();
  });
  afterAll(async () => {
    /* 只清理本夹具的 r1c- 行（dispatcher 等跨租户断言按全表取数，必须不留我的行），
     * 再关闭连接；不碰其他测试的数据。 */
    await h?.cleanup();
    await h?.close();
  });

  test("assertStart passes the full rule set for a granted, published release", async () => {
    await expect(
      h.inTenantTx(async (tx) =>
        h.policy.assertStart(tx, h.scope, h.releaseId, h.routeId),
      ),
    ).resolves.toBeUndefined();
  });

  test("assertStart refuses without the explicit start grant", async () => {
    await h.setRunGrant("start", false);
    try {
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertStart(tx, h.scope, h.releaseId, h.routeId)),
        ),
      ).toBe("RUN_START_NOT_GRANTED");
    } finally {
      await h.setRunGrant("start", true);
    }
  });

  test("assertStart refuses a disabled release and an unknown release alike", async () => {
    await h.setReleaseStatus("disabled");
    try {
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertStart(tx, h.scope, h.releaseId, h.routeId)),
        ),
      ).toBe("RUN_RELEASE_DISABLED");
    } finally {
      await h.setReleaseStatus("published");
    }
    expect(
      await h.inTenantTx(async (tx) =>
        codeOf(() => h.policy.assertStart(tx, h.scope, "r1c-no-release", h.routeId)),
      ),
    ).toBe("RUN_RELEASE_NOT_FOUND");
  });

  test("assertStart refuses without an active model grant or an active route", async () => {
    await h.setModelGrant("revoked");
    try {
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertStart(tx, h.scope, h.releaseId, h.routeId)),
        ),
      ).toBe("RUN_MODEL_GRANT_MISSING");
    } finally {
      await h.setModelGrant("active");
    }
    await h.setRouteStatus("disabled");
    try {
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertStart(tx, h.scope, h.releaseId, h.routeId)),
        ),
      ).toBe("RUN_MODEL_ROUTE_MISSING");
    } finally {
      await h.setRouteStatus("active");
    }
  });

  test("assertOwn read requires the expert resource read to stay valid", async () => {
    await expect(
      h.inTenantTx(async (tx) =>
        h.policy.assertOwn(tx, h.scope, runAccess(), "read"),
      ),
    ).resolves.toBeUndefined();
    await h.revokeResourceRead();
    try {
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertOwn(tx, h.scope, runAccess(), "read")),
        ),
      ).toBe("RESOURCE_NOT_FOUND");
    } finally {
      await h.grantResourceRead();
    }
  });

  test("assertOwn cancel keeps working after the expert authorization is revoked", async () => {
    await h.revokeResourceRead();
    try {
      await expect(
        h.inTenantTx(async (tx) =>
          h.policy.assertOwn(tx, h.scope, runAccess(), "cancel"),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await h.grantResourceRead();
    }
  });

  test("assertOwn never crosses principals or tenants", async () => {
    const foreign = {
      ...runAccess(),
      ownerPrincipalId: "r1c-principal-b",
    };
    expect(
      await h.inTenantTxFor(h.scopeB, async (tx) =>
        codeOf(() => h.policy.assertOwn(tx, h.scopeB, foreign, "cancel")),
      ),
    ).toBe("RUN_NOT_FOUND");
    /* 同一 runAccess 在租户 B 的 scope 下同样不可见：owner 与租户任一不匹配都是 404。 */
    expect(
      await h.inTenantTxFor(h.scopeB, async (tx) =>
        codeOf(() => h.policy.assertOwn(tx, h.scopeB, runAccess(), "read")),
      ),
    ).toBe("RUN_NOT_FOUND");
  });

  test("assertOwn resume re-verifies resume_own and the current model grant", async () => {
    expect(
      await h.inTenantTx(async (tx) =>
        codeOf(() => h.policy.assertOwn(tx, h.scope, runAccess(), "resume")),
      ),
    ).toBe("RUN_RESUME_NOT_GRANTED");
    await h.setRunGrant("resume_own", true);
    try {
      await expect(
        h.inTenantTx(async (tx) =>
          h.policy.assertOwn(tx, h.scope, runAccess(), "resume"),
        ),
      ).resolves.toBeUndefined();
      await h.setModelGrant("revoked");
      expect(
        await h.inTenantTx(async (tx) =>
          codeOf(() => h.policy.assertOwn(tx, h.scope, runAccess(), "resume")),
        ),
      ).toBe("RUN_MODEL_GRANT_MISSING");
    } finally {
      await h.setModelGrant("active");
      await h.setRunGrant("resume_own", false);
    }
  });
});
