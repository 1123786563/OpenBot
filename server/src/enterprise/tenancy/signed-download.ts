// server/src/enterprise/tenancy/signed-download.ts
// MT056（Issue #99）：签名下载与代理访问在签发点和访问点都授权，撤销即停止。
//
// 票面语义（Issue #99 正文）：
//   AC1 签发点对无权请求拒绝；代理点对过期、撤销、跨范围令牌拒绝。
//   AC2 撤销后已签发链接立即失效（有测试），不存在长期不可撤销直链被
//      当作已撤销。
//   AC3 同一规则被附件、产物与原文件下载复用（共享测试）。
//   AC4 签名与错误信息不泄露对象存在性与归属细节。
//
// 结构（一张共享规则面 + 三个族适配；零新表，零既有服务语义改动）：
//
//   1. 共享签名规则（createSignedDownloadRule）：token 语法
//      `${ref}.${expiry}.${hmac}`，HMAC-SHA256（装配注入的部署密钥）覆盖
//      ref+expiry，base64url。这是 MT024 附件签发/代理已经实现的同一条
//      规则——本票把它的加密核心提取为唯一事实源：attachments.ts 改为
//      消费本模块的 sign/verify（字节形状不变，附件套件不动）；产物族
//      （MT055 artifact-storage 的授权门）与原文件族（MT061 openmuse
//      file-tenancy 的 readFile 门）的签发/代理走同一实现。发现分叉先
//      统一再继续（票注原文）——统一后的分叉面只剩密钥与族门，不存在
//      第二套 token 语法。
//   2. 两点授权纪律（AC1）：签发点 = 族可见性门（附件 = MT024 readAttachment-
//      Facts 纪律；产物 = MT055 范围门；原文件 = MT061 readFile 门）+ sign；
//      代理点 = verify（常量时间 HMAC + 过期）之后**重验当前请求者的可见
//      性**——每次访问都是新的事实判定，无放行缓存。撤销的三条路径都在
//      代理点的重验处失效（AC2）：
//        - 对象撤销（附件 revokeUpload / 产物 delete）→ 族门 deny；
//        - 成员撤权（公司停用 epoch 递增 / 团队停用）→ 族门 deny；
//        - 令牌过期 → verify deny。
//      长期直链不存在：expiresAt 是 token 语法的一部分，任何链接都带
//      有效期上限（ttlSeconds 闭集 1..86400，与 MT024 同界）。
//   3. 族路由（AC3）：三个族的 issue/proxy 共用同一个服务形状；附件族
//      **整体委托** MT024 服务（issueDownloadUrl/resolveDownload 原方法）
//      ——不复制其判定 SQL，附件侧测试即共享规则的回归面。产物族与
//      原文件族经本服务用共享核心 + 各自族门组合。
//   4. 不泄露（AC4）：一切 deny = canonical RESOURCE_NOT_FOUND（与「不
//      存在」逐字节同形）；verify 的形状拒绝（分段数、字符集、整数）
//      与 HMAC 失败同一形状；签发点对跨范围对象拒绝时不区分「不存在/
//      他人对象/已撤销」。
//
// 边界（诚实披露）：
//   - 本票不接 HTTP 路由（服务面供下游接线票复用，MT024/MT053 同例）；
//     附件既有路由原样不动。
//   - 原文件族的 byte_path 事实经注入 seam（openmuse_file_versions 的
//      权威行；可见性判定 100% 委托 MT061 readFile，本模块零复刻判定）。
//   - 签名密钥经装配注入（生产从部署配置派生）；本模块不落密钥。
//   - 产物下载的字节面在 MT055（objectStore 注入端口）；本票只叠签名层。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlatformScope } from "../contracts";
import type { ArtifactStorageService } from "./artifact-storage";
import type { AttachmentService } from "./attachments";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import type { OpenMuseFileTenancyService } from "./openmuse-file-tenancy";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 哨兵码
// ---------------------------------------------------------------------------

export const SIGNED_DOWNLOAD_INPUT_INVALID = "SIGNED_DOWNLOAD_INPUT_INVALID";
export const SIGNED_DOWNLOAD_TTL_INVALID = "SIGNED_DOWNLOAD_TTL_INVALID";
export const SIGNED_DOWNLOAD_SIGNING_KEY_REQUIRED =
  "SIGNED_DOWNLOAD_SIGNING_KEY_REQUIRED";

// ---------------------------------------------------------------------------
// 共享签名规则（MT053/MT047 键纪律的同款纯函数面；token 语法 = MT024）
// ---------------------------------------------------------------------------

export interface SignedDownloadRule {
  /** 签发：`${ref}.${expiry}.${hmac}`；ref 限 `[A-Za-z0-9_-]`（形状面）。 */
  sign(
    ref: string,
    ttlSeconds: number,
    nowMs?: number,
  ): { readonly token: string; readonly expiresAtMs: number };
  /** 校验：形状 + 常量时间 HMAC + 过期；一切失败 = null（同一形状）。 */
  verify(
    token: string,
    nowMs?: number,
  ): {
    readonly ref: string;
    readonly expiresAtMs: number;
  } | null;
  /** MT024 attachments 的内部等价面（统一后的唯一 HMAC 计算）。 */
  hmacOf(ref: string, expiry: number): string;
}

function assertTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
    throw new Error(SIGNED_DOWNLOAD_TTL_INVALID);
  }
  return ttlSeconds;
}

export function createSignedDownloadRule(
  signingKey: string,
): SignedDownloadRule {
  if (typeof signingKey !== "string" || signingKey.length < 16) {
    throw new Error(SIGNED_DOWNLOAD_SIGNING_KEY_REQUIRED);
  }
  const hmacOf = (ref: string, expiry: number): string =>
    createHmac("sha256", signingKey)
      .update(`${ref}.${expiry}`)
      .digest("base64url");
  return {
    hmacOf,
    sign(ref, ttlSeconds, nowMs = Date.now()) {
      assertTtl(ttlSeconds);
      if (!/^[A-Za-z0-9_-]+$/.test(ref)) {
        throw new Error(`${SIGNED_DOWNLOAD_INPUT_INVALID}: ref`);
      }
      const expiresAtMs = nowMs + ttlSeconds * 1000;
      return {
        token: `${ref}.${expiresAtMs}.${hmacOf(ref, expiresAtMs)}`,
        expiresAtMs,
      };
    },
    verify(token, nowMs = Date.now()) {
      const parts = String(token ?? "").split(".");
      if (parts.length !== 3) return null;
      const [ref, expiryText, mac] = parts;
      const expiresAtMs = Number(expiryText);
      if (
        !Number.isInteger(expiresAtMs) ||
        !/^[A-Za-z0-9_-]+$/.test(ref) ||
        !/^[A-Za-z0-9_-]+$/.test(mac)
      ) {
        return null;
      }
      const expected = Buffer.from(hmacOf(ref, expiresAtMs));
      const received = Buffer.from(mac);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        return null;
      }
      if (nowMs >= expiresAtMs) return null;
      return { ref, expiresAtMs };
    },
  };
}

// ---------------------------------------------------------------------------
// 原文件族的 byte_path seam（权威行事实；可见性判定在 MT061）
// ---------------------------------------------------------------------------

/** openmuse 文件最新版本的权威 byte_path（平台通道行事实）。 */
export interface RawFileBytePathSeam {
  latestBytePathOf(fileId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// 服务形状
// ---------------------------------------------------------------------------

export type SignedUrlOutcome =
  | {
      readonly outcome: "allow";
      readonly url: string;
      readonly expiresAt: string;
    }
  | ResourceNotFoundVerdict;

export type SignedProxyOutcome =
  | {
      readonly outcome: "allow";
      readonly storagePath: string;
      readonly bytes?: Uint8Array;
    }
  | ResourceNotFoundVerdict;

export interface SignedDownloadService {
  // ── 附件族：整体委托 MT024（AC3 的「同一实现」半边，零复制）──────
  issueAttachmentDownload(
    scope: PlatformScope,
    attachmentId: string,
    input: { readonly ttlSeconds: number },
  ): Promise<SignedUrlOutcome>;
  proxyAttachmentDownload(
    scope: PlatformScope,
    token: string,
  ): Promise<SignedProxyOutcome>;

  // ── 产物族：共享核心 + MT055 范围门 ────────────────────────────────
  issueArtifactDownload(
    scope: PlatformScope,
    input: {
      readonly sessionId: string;
      readonly artifactId: string;
      readonly ttlSeconds: number;
    },
  ): Promise<SignedUrlOutcome>;
  proxyArtifactDownload(
    scope: PlatformScope,
    token: string,
  ): Promise<SignedProxyOutcome>;

  // ── 原文件族：共享核心 + MT061 readFile 门 ─────────────────────────
  issueRawFileDownload(
    scope: PlatformScope,
    fileId: string,
    input: { readonly ttlSeconds: number },
  ): Promise<SignedUrlOutcome>;
  proxyRawFileDownload(
    scope: PlatformScope,
    token: string,
  ): Promise<SignedProxyOutcome>;
}

export function createSignedDownloadService(deps: {
  /** MT024 附件服务（附件族两点授权的唯一实现——委托不复制）。 */
  readonly attachments: AttachmentService;
  /** MT055 产物服务（产物族的可见性门）。 */
  readonly artifacts: ArtifactStorageService;
  /** MT061 openmuse 文件服务（原文件族的可见性门）。 */
  readonly openMuseFiles: OpenMuseFileTenancyService;
  /** 原文件族的 byte_path 权威行 seam。 */
  readonly rawFileBytePaths: RawFileBytePathSeam;
  /** 原文件族的字节来源（注入端口）。 */
  readonly objectStore: { get(key: string): Promise<Uint8Array> };
  /** 部署签名密钥（与 MT024 同源——统一实现的前提）。 */
  readonly signingKey: string;
}): SignedDownloadService {
  const rule = createSignedDownloadRule(deps.signingKey);
  const {
    attachments,
    artifacts,
    openMuseFiles,
    rawFileBytePaths,
    objectStore,
  } = deps;

  const frozenUrl = (token: string, expiresAtMs: number): SignedUrlOutcome =>
    Object.freeze({
      outcome: "allow" as const,
      url: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });

  const DENY: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

  return {
    async issueAttachmentDownload(scope, attachmentId, input) {
      assertTrustedScope(scope);
      // 委托 MT024：签发点授权与 token 生成都归附件服务（同一实现）。
      const issued = await attachments.issueDownloadUrl(
        scope,
        attachmentId,
        input,
      );
      if (!("outcome" in issued) || issued.outcome !== "allow") return DENY;
      return Object.freeze({
        outcome: "allow" as const,
        url: issued.url,
        expiresAt: issued.expiresAt,
      });
    },

    async proxyAttachmentDownload(scope, token) {
      assertTrustedScope(scope);
      const resolved = await attachments.resolveDownload(scope, token);
      if (!("outcome" in resolved) || resolved.outcome !== "allow") return DENY;
      return Object.freeze({
        outcome: "allow" as const,
        storagePath: resolved.storagePath,
      });
    },

    async issueArtifactDownload(scope, input) {
      assertTrustedScope(scope);
      assertTtl(input.ttlSeconds);
      // 签发点：MT055 范围门（此刻有权的事实判定）。
      const authorized = await artifacts.authorizeDownload(scope, {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
      });
      if (!("outcome" in authorized) || authorized.outcome !== "allow") {
        return DENY;
      }
      const { token, expiresAtMs } = rule.sign(
        input.artifactId,
        input.ttlSeconds,
      );
      return frozenUrl(token, expiresAtMs);
    },

    async proxyArtifactDownload(scope, token) {
      assertTrustedScope(scope);
      const verified = rule.verify(token);
      if (!verified) return DENY;
      // 代理点：token 合法之后重验当前请求者（MT055 范围门按三元组 +
      // artifactId）——已签发链接在对象删除或撤权后在此失效（AC2）。
      const read = await artifacts.readArtifact(scope, {
        artifactId: verified.ref,
      });
      if (!("outcome" in read) || read.outcome !== "allow") return DENY;
      return Object.freeze({
        outcome: "allow" as const,
        storagePath: read.enterpriseKey,
        bytes: read.bytes,
      });
    },

    async issueRawFileDownload(scope, fileId, input) {
      assertTrustedScope(scope);
      assertTtl(input.ttlSeconds);
      // 签发点：MT061 readFile 门（可见性判定 100% 委托）。
      const read = await openMuseFiles.readFile(scope, fileId);
      if (!("outcome" in read) || read.outcome !== "allow") return DENY;
      const { token, expiresAtMs } = rule.sign(fileId, input.ttlSeconds);
      return frozenUrl(token, expiresAtMs);
    },

    async proxyRawFileDownload(scope, token) {
      assertTrustedScope(scope);
      const verified = rule.verify(token);
      if (!verified) return DENY;
      // 代理点：重验 + 权威行 byte_path + 注入字节源。
      const read = await openMuseFiles.readFile(scope, verified.ref);
      if (!("outcome" in read) || read.outcome !== "allow") return DENY;
      const bytePath = await rawFileBytePaths.latestBytePathOf(verified.ref);
      if (!bytePath) return DENY;
      const bytes = await objectStore.get(bytePath);
      return Object.freeze({
        outcome: "allow" as const,
        storagePath: bytePath,
        bytes,
      });
    },
  };
}
