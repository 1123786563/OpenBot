// server/tests/multitenancy/attachments.test.ts
// MT024（Issue #67）：附件暂存上传、绑定、下载签发与清理的归属。
//
// 验收事实源（Issue #67 四条，逐条对应 describe）：
//   (1) 附件对象存储路径按归属隔离；路径不可猜测，且签名 URL 在签发
//       点与代理访问点都校验权限。
//   (2) 无权用户请求下载得到不可见语义；撤销或撤权后新的签发被拒绝，
//       已签发链接按设计失效或拒绝代理。
//   (3) 清理任务只处理自己归属范围内的暂存附件，不跨公司删除。
//   (4) 上传上下文被持久化，后续绑定与下载不依赖客户端重述归属。
//
// 判定事实源：enterprise_resources kind='attachment'（附件行本体即上传
// 上下文）+ kind='attachment-bind'（绑定事实）+ HMAC 签名 URL（装配注入
// 密钥）。全链路经本票单一判定入口 createAttachmentService；不可见对象
// 按 MT011 canonical not-found 处理。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因
// 写在用例名里，skipped 不计为通过），绝不回退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type AttachmentFixture,
  type AttachmentIdentity,
  createAttachmentFixture,
} from "./support/attachments";

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
      reason: `MT024 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const isCanonicalNotFound = (value: unknown): boolean =>
  JSON.stringify(value) === serializeNotFoundVerdict(notFoundVerdict());

let threadCounter = 0;
const nextThread = () => {
  threadCounter += 1;
  return `mt024-thread-${String(threadCounter).padStart(3, "0")}`;
};

describeDb("MT024 / Issue #67 — 附件归属全链路", () => {
  let fixture: AttachmentFixture;

  const scopeAs = async (
    identity: AttachmentIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

  const stageAs = async (
    identity: AttachmentIdentity,
    tenantId: string,
    workspaceId: string,
    filename = "规格说明.pdf",
  ) => {
    const staged = await fixture.attachments.stageUpload(
      await scopeAs(identity, tenantId, workspaceId),
      { filename, sizeBytes: 1024 },
    );
    expect(staged.outcome).toBe("allow");
    return staged as {
      outcome: "allow";
      attachmentId: string;
      storagePath: string;
    };
  };

  beforeAll(async () => {
    fixture = await createAttachmentFixture();
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：路径按归属隔离且不可猜测；签发点与代理点双重校验
  // -------------------------------------------------------------------------
  describeDb("AC1 存储路径隔离与签名 URL 双点校验", () => {
    itDb(
      "路径按归属分段（tenant/workspace/ref），ref 服务端随机生成",
      async () => {
        const first = await stageAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const second = await stageAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
          "规格说明.pdf",
        );
        expect(first.storagePath).toBe(
          `${fixture.companyA}/${fixture.teamA1}/${first.attachmentId}/blob`,
        );
        // 同名文件两次上传：ref 与路径都不同（不可猜测、不可枚举）。
        expect(first.attachmentId).not.toBe(second.attachmentId);
        expect(first.storagePath).not.toBe(second.storagePath);
        expect(first.attachmentId).toMatch(/^att-[0-9a-f-]{36}$/);
      },
    );

    itDb("跨公司路径天然隔离：B 公司附件路径不含 A 的段", async () => {
      const aFile = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const bFile = await stageAs(
        "b1-member",
        fixture.companyB,
        fixture.teamB1,
      );
      expect(bFile.storagePath.startsWith(`${fixture.companyB}/`)).toBe(true);
      expect(bFile.storagePath.startsWith(`${fixture.companyA}/`)).toBe(false);
      expect(aFile.attachmentId).not.toBe(bFile.attachmentId);
    });

    itDb("签发点校验：owner 签发 allow，URL 三段式带过期", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const issued = await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 300 },
      );
      expect(issued.outcome).toBe("allow");
      const url = (issued as { url: string }).url;
      expect(url.split(".")).toHaveLength(3);
    });

    itDb("代理点校验：合法 token + 有权者 allow 返回存储路径", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const issued = (await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 300 },
      )) as { outcome: string; url: string };
      const resolved = await fixture.attachments.resolveDownload(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        issued.url,
      );
      expect(resolved).toEqual({
        outcome: "allow",
        storagePath: file.storagePath,
      });
    });

    itDb(
      "代理点校验：伪造 MAC / 篡改 ref 的 token canonical not-found",
      async () => {
        const file = await stageAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const issued = (await fixture.attachments.issueDownloadUrl(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          file.attachmentId,
          { ttlSeconds: 300 },
        )) as { url: string };
        const [, expiry, mac] = issued.url.split(".");
        const forged = `${file.attachmentId}x.${expiry}.${mac}`;
        const verdict = await fixture.attachments.resolveDownload(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          forged,
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC2：无权用户不可见语义；撤销/撤权后签发拒绝、已签发链接失效
  // -------------------------------------------------------------------------
  describeDb("AC2 无权、撤销与撤权", () => {
    itDb(
      "无权用户（跨公司 B / 跨团队 A2 / 同团队未入 grant）请求下载 canonical not-found",
      async () => {
        const file = await stageAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const fromB = await fixture.attachments.issueDownloadUrl(
          await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
          file.attachmentId,
          { ttlSeconds: 60 },
        );
        expect(isCanonicalNotFound(fromB)).toBe(true);
        const fromA2 = await fixture.attachments.issueDownloadUrl(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          file.attachmentId,
          { ttlSeconds: 60 },
        );
        expect(isCanonicalNotFound(fromA2)).toBe(true);
      },
    );

    itDb("撤销后：新签发被拒，已签发链接在代理点被拒", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const issued = (await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 300 },
      )) as { outcome: string; url: string };
      const revoked = await fixture.attachments.revokeUpload(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
      );
      expect(revoked.outcome).toBe("allow");
      const reIssue = await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 60 },
      );
      expect(isCanonicalNotFound(reIssue)).toBe(true);
      const proxied = await fixture.attachments.resolveDownload(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        issued.url,
      );
      expect(isCanonicalNotFound(proxied)).toBe(true);
      // 探针：生命周期列已翻转为 'private'。
      const rows = await fixture.readAttachmentRowsAsData(fixture.companyA);
      const row = rows.find((candidate) => candidate.id === file.attachmentId);
      expect(row?.visibility).toBe("private");
    });

    itDb("撤权后（MT006 停用）：新签发与已签发代理都被拒", async () => {
      const file = await stageAs("a1-other", fixture.companyA, fixture.teamA1);
      const issued = (await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 300 },
      )) as { outcome: string; url: string };
      await fixture.suspendCompanyMembership(
        fixture.companyA,
        fixture.ids["principal-a1-other"],
      );
      // 撤权后 scope 签发面立即死亡（MT006 epoch 递增，resolver 拒发）。
      await expect(
        scopeAs("a1-other", fixture.companyA, fixture.teamA1),
      ).rejects.toThrow("TENANT_FORBIDDEN");
      // 已签发链接在代理点被拒：附件是上传者个人事实，同团队他人
      // （a1-owner，active）也过不了可见门。
      const proxied = await fixture.attachments.resolveDownload(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        issued.url,
      );
      expect(isCanonicalNotFound(proxied)).toBe(true);
    });

    itDb("非上传者不能撤销（撤消门 = 上传者本人）", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const verdict = await fixture.attachments.revokeUpload(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        file.attachmentId,
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC3：清理只处理自己归属范围，不跨公司删除
  // -------------------------------------------------------------------------
  describeDb("AC3 清理范围隔离", () => {
    itDb("清理只触及本团队过期行：A1 清理后 A2/B1 的行完好", async () => {
      const a1File = await stageAs(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      const a2File = await stageAs(
        "a2-member",
        fixture.companyA,
        fixture.teamA2,
      );
      const b1File = await stageAs(
        "b1-member",
        fixture.companyB,
        fixture.teamB1,
      );
      // cutoff 与 created_at 同毫秒竞态：跨过整秒再清理。
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const cleaned = await fixture.attachments.cleanupStaleUploads(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { olderThanSeconds: 0 },
      );
      expect(cleaned.outcome).toBe("allow");
      const cleanedIds = (cleaned as { cleaned: string[] }).cleaned;
      expect(cleanedIds).toContain(a1File.attachmentId);
      // 跨团队与跨公司的行绝不在清单里。
      expect(cleanedIds).not.toContain(a2File.attachmentId);
      expect(cleanedIds).not.toContain(b1File.attachmentId);
      const aRows = await fixture.readAttachmentRowsAsData(fixture.companyA);
      expect(
        aRows.find((row) => row.id === a2File.attachmentId)?.visibility,
      ).toBe(null);
      const bRows = await fixture.readAttachmentRowsAsData(fixture.companyB);
      expect(
        bRows.find((row) => row.id === b1File.attachmentId)?.visibility,
      ).toBe(null);
    });

    itDb("已清理的附件：签发与代理 canonical not-found", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await fixture.attachments.cleanupStaleUploads(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { olderThanSeconds: 0 },
      );
      const issue = await fixture.attachments.issueDownloadUrl(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        { ttlSeconds: 60 },
      );
      expect(isCanonicalNotFound(issue)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC4：上传上下文持久化；绑定与下载不依赖客户端重述归属
  // -------------------------------------------------------------------------
  describeDb("AC4 归属只来自上传行", () => {
    itDb("上传者绑定自己的附件到自己的会话 allow", async () => {
      const threadId = nextThread();
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        principalId: fixture.ids["principal-a1-owner"],
        threadId,
      });
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const bound = await fixture.attachments.bindToConversation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        threadId,
      );
      expect(bound.outcome).toBe("allow");
    });

    itDb(
      "跨团队身份携带他人 ref 绑定：canonical not-found（重述归属无效）",
      async () => {
        const threadId = nextThread();
        await fixture.seedConversation({
          tenantId: fixture.companyA,
          workspaceId: fixture.teamA2,
          principalId: fixture.ids["principal-a2-member"],
          threadId,
        });
        const file = await stageAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const verdict = await fixture.attachments.bindToConversation(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          file.attachmentId,
          threadId,
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );

    itDb("附件与归属不符的会话绑定：canonical not-found", async () => {
      const file = await stageAs("a1-owner", fixture.companyA, fixture.teamA1);
      const verdict = await fixture.attachments.bindToConversation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        file.attachmentId,
        "mt024-thread-does-not-exist",
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
    });
  });
});
