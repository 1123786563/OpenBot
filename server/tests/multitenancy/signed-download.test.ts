// server/tests/multitenancy/signed-download.test.ts
// MT056（Issue #99）：签名下载与代理访问在签发点和访问点都授权，撤销即停止。
//
// 验收事实源（Issue #99 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：签发点对无权请求拒绝；代理点对过期、撤销、跨范围令牌拒绝。
//   验收 2：撤销后已签发链接立即失效；不存在长期不可撤销直链。
//   验收 3：同一规则被附件、产物与原文件下载复用（共享测试）。
//   验收 4：签名与错误信息不泄露对象存在性与归属细节。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt28-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/signed-download.test.ts

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createSignedDownloadRule,
  createSignedDownloadService,
} from "../../src/enterprise/tenancy/signed-download";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import { createOpenMuseFilesFixture } from "./support/openmuse-files";
import {
  createWorkshopTenancyFixture,
  type WorkshopTenancyFixture,
} from "./support/workshop-tenancy";

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
      reason: `MT056 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
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

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());

const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

const thrownMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let fixture: WorkshopTenancyFixture;
let openMuse: Awaited<ReturnType<typeof createOpenMuseFilesFixture>>;
let signingKey = "";

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createWorkshopTenancyFixture();
  openMuse = await createOpenMuseFilesFixture();
  signingKey = fixture.signingKey;
});

afterAll(async () => {
  if (openMuse) await openMuse.dispose();
  if (fixture) await fixture.dispose();
});

/** 原文件族的三件套：pin 过的文件 + 一个版本行（byte_path 权威事实）。 */
async function seededRawFile() {
  const companyA = openMuse.ids["company-a"];
  const teamA1 = openMuse.ids["team-a1"];
  const ownerUserId = openMuse.ids["user-a1-member"];
  const fileId = await openMuse.seedFile({ ownerUserId });
  const bytePath = `openmuse-files/${companyA}/${teamA1}/${fileId}/v1.bin`;
  await openMuse.platform.execute(
    sql`insert into openmuse_file_versions (version_id, file_id, byte_path, sha256) values (${`ofv-${randomUUID().slice(0, 12)}`}, ${fileId}, ${bytePath}, ${`sha-${fileId}`})`,
  );
  const scope = await openMuse.scopeAs("a1-member", companyA, teamA1);
  const pinned = await openMuse.service.pinFileScope(scope, { fileId });
  if (!("status" in pinned)) throw new Error("RAW_FILE_PIN_FAILED");
  return { fileId, bytePath, scope, companyA, teamA1 };
}

// ---------------------------------------------------------------------------
// 共享签名规则（纯函数面；token 语法 = MT024 的同一语法）
// ---------------------------------------------------------------------------

describeDb("MT056 shared signing rule (one grammar, zero forks)", () => {
  itDb("signs and verifies round-trip; ref and expiry ride the token", () => {
    const rule = createSignedDownloadRule("mt056-shared-signing-key-0001");
    const { token, expiresAtMs } = rule.sign("att-abc123", 60, 1_000_000);
    expect(token).toBe(
      `att-abc123.${1_060_000}.${rule.hmacOf("att-abc123", 1_060_000)}`,
    );
    const verified = rule.verify(token, 1_000_001);
    expect(verified).toEqual({ ref: "att-abc123", expiresAtMs });
  });

  itDb(
    "tampered, expired and malformed tokens all fail to the same null",
    () => {
      const rule = createSignedDownloadRule("mt056-shared-signing-key-0001");
      const { token } = rule.sign("wa-xyz", 60, 1_000_000);
      const other = createSignedDownloadRule("mt056-other-signing-key-000002");
      expect(rule.verify(`${token.slice(0, -3)}abc`, 1_000_001)).toBeNull();
      expect(rule.verify(token, 1_061_000)).toBeNull(); // expired
      expect(rule.verify("wa-xyz.99999", 1)).toBeNull(); // wrong segment count
      expect(rule.verify("wa-xyz.notanumber.AAAA", 1)).toBeNull();
      // 换密钥签出的 token 不被验证（部署密钥是唯一事实源）。
      const forged = other.sign("wa-xyz", 60, 1_000_000);
      expect(rule.verify(forged.token, 1_000_001)).toBeNull();
    },
  );

  itDb("ttl bounds are the closed set MT024 already enforces", async () => {
    const rule = createSignedDownloadRule("mt056-shared-signing-key-0001");
    await expect(thrownMessage(() => rule.sign("x", 0))).resolves.toBe(
      "SIGNED_DOWNLOAD_TTL_INVALID",
    );
    await expect(thrownMessage(() => rule.sign("x", 86_401))).resolves.toBe(
      "SIGNED_DOWNLOAD_TTL_INVALID",
    );
  });

  itDb(
    "an MT024 attachment token verifies with the shared rule (unified core)",
    async () => {
      // 统一证据：附件服务（MT024 原实现，现在消费共享核心）签出的
      // token 被共享规则 verify 接受——两者不是两套实现。
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const staged = await fixture.attachments.stageUpload(ownerScope, {
        filename: "mt056-unify.txt",
        sizeBytes: 12,
      });
      if (staged.outcome !== "allow") throw new Error("STAGE_FAILED");
      const issued = await fixture.attachments.issueDownloadUrl(
        ownerScope,
        staged.attachmentId,
        { ttlSeconds: 300 },
      );
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      const rule = createSignedDownloadRule(signingKey);
      const verified = rule.verify(issued.url);
      expect(verified?.ref).toBe(staged.attachmentId);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：同一规则被附件、产物与原文件下载复用（共享测试矩阵）
// ---------------------------------------------------------------------------

describeDb("MT056 AC3 one rule, three families (shared matrix)", () => {
  itDb(
    "family=artifact: authorized issue proxies; cross-scope issue is refused",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: {
          latestBytePathOf: async () => null,
        },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const artifact = await fixture.ensurePinnedArtifact({
        owner: "a1-member",
        team: "team-a1",
        name: "mt056-artifact",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const issued = await signed.issueArtifactDownload(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
        ttlSeconds: 300,
      });
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      const proxied = await signed.proxyArtifactDownload(
        ownerScope,
        issued.url,
      );
      expect(proxied.outcome).toBe("allow");
      if (proxied.outcome === "allow") {
        expect(proxied.storagePath).toBe(artifact.enterpriseKey);
      }
      // 签发点对无权请求拒绝（跨团队）。
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const deniedIssue = await signed.issueArtifactDownload(intruder, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
        ttlSeconds: 300,
      });
      expect(isCanonicalNotFound(deniedIssue)).toBe(true);
    },
  );

  itDb(
    "family=attachment: the MT024 service answers both points unchanged",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const staged = await fixture.attachments.stageUpload(ownerScope, {
        filename: "mt056-family.txt",
        sizeBytes: 8,
      });
      if (staged.outcome !== "allow") throw new Error("STAGE_FAILED");
      const issued = await signed.issueAttachmentDownload(
        ownerScope,
        staged.attachmentId,
        { ttlSeconds: 300 },
      );
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      const proxied = await signed.proxyAttachmentDownload(
        ownerScope,
        issued.url,
      );
      expect(proxied.outcome).toBe("allow");
      if (proxied.outcome === "allow") {
        expect(proxied.storagePath).toBe(staged.storagePath);
      }
      // 跨范围签发点拒绝：跨团队成员对他人附件 not-found（同一形状）。
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const deniedIssue = await signed.issueAttachmentDownload(
        intruder,
        staged.attachmentId,
        { ttlSeconds: 300 },
      );
      expect(isCanonicalNotFound(deniedIssue)).toBe(true);
    },
  );

  itDb(
    "family=raw-file: the MT061 readFile gate rides the same grammar",
    async () => {
      const bytes = new Uint8Array([9, 8, 7, 6]);
      const objectStore = {
        get: async (key: string) => {
          if (key !== rawFile.bytePath) throw new Error("BYTE_PATH_MISS");
          return bytes;
        },
      };
      const rawFile = await seededRawFile();
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: {
          latestBytePathOf: async (fileId) =>
            fileId === rawFile.fileId ? rawFile.bytePath : null,
        },
        objectStore,
        signingKey,
      });
      const issued = await signed.issueRawFileDownload(
        rawFile.scope,
        rawFile.fileId,
        { ttlSeconds: 300 },
      );
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      const proxied = await signed.proxyRawFileDownload(
        rawFile.scope,
        issued.url,
      );
      expect(proxied.outcome).toBe("allow");
      if (proxied.outcome === "allow") {
        expect(proxied.storagePath).toBe(rawFile.bytePath);
        expect(proxied.bytes).toEqual(bytes);
      }
      // 签发点拒绝：跨公司用户对他人文件 not-found。
      const foreigner = await openMuse.scopeAs(
        "b1-member",
        openMuse.ids["company-b"],
        openMuse.ids["team-b1"],
      );
      const deniedIssue = await signed.issueRawFileDownload(
        foreigner,
        rawFile.fileId,
        { ttlSeconds: 300 },
      );
      expect(isCanonicalNotFound(deniedIssue)).toBe(true);
    },
  );

  itDb(
    "a token from one family does not unlock another family (no cross-use)",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const staged = await fixture.attachments.stageUpload(ownerScope, {
        filename: "mt056-cross.txt",
        sizeBytes: 4,
      });
      if (staged.outcome !== "allow") throw new Error("STAGE_FAILED");
      const issued = await signed.issueAttachmentDownload(
        ownerScope,
        staged.attachmentId,
        { ttlSeconds: 300 },
      );
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      // 附件 ref 前缀 att- 不是产物 id 形状：产物代理点以同一 not-found
      // 拒绝（族门各管各的 ref 空间，token 不能串门）。
      const crossProxied = await signed.proxyArtifactDownload(
        ownerScope,
        issued.url,
      );
      expect(isCanonicalNotFound(crossProxied)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 1/2：代理点对过期、撤销、跨范围令牌拒绝；撤销后立即失效
// ---------------------------------------------------------------------------

describeDb("MT056 AC1+AC2 the proxy point re-verifies everything", () => {
  itDb(
    "attachment: a revoked upload kills an already-issued link immediately",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const staged = await fixture.attachments.stageUpload(ownerScope, {
        filename: "mt056-revoke.txt",
        sizeBytes: 6,
      });
      if (staged.outcome !== "allow") throw new Error("STAGE_FAILED");
      const issued = await fixture.attachments.issueDownloadUrl(
        ownerScope,
        staged.attachmentId,
        { ttlSeconds: 3600 },
      );
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      const before = await signed.proxyAttachmentDownload(
        ownerScope,
        issued.url,
      );
      expect(before.outcome).toBe("allow");
      await fixture.attachments.revokeUpload(ownerScope, staged.attachmentId);
      const after = await signed.proxyAttachmentDownload(
        ownerScope,
        issued.url,
      );
      expect(isCanonicalNotFound(after)).toBe(true);
    },
  );

  itDb(
    "artifact: deletion kills an already-issued link; ttl caps every link",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const artifact = await fixture.ensurePinnedArtifact({
        owner: "a1-member",
        team: "team-a1",
        name: "mt056-revoked-artifact",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const issued = await signed.issueArtifactDownload(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
        ttlSeconds: 3600,
      });
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      // 撤销 = 对象删除：代理点重验产物门 → not-found。
      await fixture.artifacts.deleteArtifact(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
      });
      const after = await signed.proxyArtifactDownload(ownerScope, issued.url);
      expect(isCanonicalNotFound(after)).toBe(true);
      // 长期直链不存在：签发 ttl 上限 86400s（闭集断言见纯函数面）。
      await expect(
        thrownMessage(() =>
          signed.issueArtifactDownload(ownerScope, {
            sessionId: artifact.sessionId,
            artifactId: artifact.artifactId,
            ttlSeconds: 100_000,
          }),
        ),
      ).resolves.toBe("SIGNED_DOWNLOAD_TTL_INVALID");
    },
  );

  itDb(
    "artifact: a member revocation kills an already-issued link (epoch fence)",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const artifact = await fixture.ensurePinnedArtifact({
        owner: "a1-other",
        team: "team-a1",
        name: "mt056-epoch-artifact",
      });
      const ownerScope = await fixture.scopeAs("a1-other", "team-a1");
      const issued = await signed.issueArtifactDownload(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
        ttlSeconds: 3600,
      });
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      const before = await signed.proxyArtifactDownload(ownerScope, issued.url);
      expect(before.outcome).toBe("allow");
      await fixture.suspendCompany("a1-other", "company-a");
      const after = await signed.proxyArtifactDownload(ownerScope, issued.url);
      expect(isCanonicalNotFound(after)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：签名与错误信息不泄露存在性与归属
// ---------------------------------------------------------------------------

describeDb("MT056 AC4 no existence or ownership leaks", () => {
  itDb(
    "proxy denies are byte-identical for wrong, cross-scope and expired tokens",
    async () => {
      const signed = createSignedDownloadService({
        attachments: fixture.attachments,
        artifacts: fixture.artifacts,
        openMuseFiles: openMuse.service,
        rawFileBytePaths: { latestBytePathOf: async () => null },
        objectStore: { get: async () => new Uint8Array() },
        signingKey,
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const staged = await fixture.attachments.stageUpload(ownerScope, {
        filename: "mt056-shapes.txt",
        sizeBytes: 3,
      });
      if (staged.outcome !== "allow") throw new Error("STAGE_FAILED");
      const issued = await fixture.attachments.issueDownloadUrl(
        ownerScope,
        staged.attachmentId,
        { ttlSeconds: 60 },
      );
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      const wrong = await signed.proxyAttachmentDownload(ownerScope, "nope");
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const crossScope = await signed.proxyAttachmentDownload(
        intruder,
        issued.url,
      );
      const expired = await signed.proxyArtifactDownload(
        ownerScope,
        `att-notreal.1.${createSignedDownloadRule(signingKey).hmacOf("att-notreal", 1)}`,
      );
      expect(JSON.stringify(wrong)).toBe(canonicalNotFoundJson);
      expect(JSON.stringify(crossScope)).toBe(canonicalNotFoundJson);
      expect(JSON.stringify(expired)).toBe(canonicalNotFoundJson);
    },
  );
});
