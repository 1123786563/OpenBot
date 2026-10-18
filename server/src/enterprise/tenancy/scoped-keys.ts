// server/src/enterprise/tenancy/scoped-keys.ts
// MT015（Issue #58）：归属感知缓存/通道/前缀键 + 配置版本。
//
// 缓存键、事件通道名、对象存储前缀、向量命名空间都由真实归属（公司/团队）
// 与配置版本（公司配置 revision + 团队覆盖 revision，来源 = MT014
// runtime-config 的解析产物，本模块只读消费其类型）确定性派生，因此切换
// 公司/团队或更新配置后，旧范围的条目在结构上不可达；共享基础设施（连接池、
// 模板、静态目录等部署级形态）走显式的共享键，键里不带任何归属段（Spec §6：
// 「缓存键含实际归属及配置版本」「对象存储、外部线程、学习容器、向量检索命
// 名空间、缓存、事件通道按实际业务归属隔离；路径前缀/ID 编码只用于寻址」，
// 部署级基础设施继续共享）。
//
// 结构上的硬性规则（验收 2/3/4 的实现面）：
//   - 键对身份单射：归属与版本原样进入键，绝不静默 trim/归一化——归一化会
//     把两个不同身份折叠进同一个键（跨范围污染）。空白、越界、携带键形语法
//     字符（"/"、"="、控制字符等）的 ID 一律响亮拒绝；拒绝消息只含代码与
//     规则，绝不回显任何值。
//   - 键只做寻址，不做保险箱：归属 ID 是标识符（寻址），而调用方提供的逻辑
//     键段内容不受本模块控制，可能意外携带机密——因此逻辑段只以单向摘要
//     （SHA-256 截断 40 hex）入键：明文不出现，也不可反推。配置版本是整数
//     revision，不是机密。派生 API 的输入形状里根本没有凭据字段。
//   - 推导是纯函数：只依赖入参，绝不读取任何进程环境（环境变量、运行时全局
//     都不在本模块的输入面上），没有进程级可变状态，同名同参必然同键。
//   - 向量命名空间用受限字符集摘要形 `vn-<40hex>`（与 tenant-storage 的
//     schema 名派生同款），读形键供缓存/通道/对象前缀使用；四种键的 kind
//     前缀互不相同，同类同参不会跨 kind 碰撞，共享键永不与作用域键碰撞。
//   - 共享键与作用域键是两个显式入口：共享入口在类型上就不接受归属参数，
//     键形 `shared/v1/<domain>` 不含归属段，部署级基础设施不会被误加归属。

import { createHash } from "node:crypto";
import type { ResolvedRuntimeConfig } from "./runtime-config";

// ---------------------------------------------------------------------------
// 类型：归属与配置版本事实
// ---------------------------------------------------------------------------

/** 配置版本：公司配置 revision + 团队覆盖 revision（无覆盖为 null）。 */
export interface ScopedConfigVersion {
  readonly company: number;
  readonly override: number | null;
}

/**
 * 作用域键携带的归属事实：真实归属（公司/团队）+ 配置版本。
 * 键的单射性建立在这三个字段原样进入键上——任何归一化都会破坏它。
 */
export interface ScopedKeyOwnership {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly configVersion: ScopedConfigVersion;
}

// ---------------------------------------------------------------------------
// 拒绝：只含代码与规则，绝不回显任何值
// ---------------------------------------------------------------------------

const TENANT_ID_MAX = 128;
const DOMAIN_MAX = 64;
const LOGICAL_KEY_MAX = 4096;
const DIGEST_HEX = 40;

/** ID 语法：单行、路径/键安全（无 "/"、"="、空白、控制字符），首字符字母数字。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 域标签：小写 kebab，1..64 字符。 */
const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requireSelector(
  value: string | undefined,
  missing: string,
  invalid: string,
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(missing);
  if (
    value.length > TENANT_ID_MAX ||
    value === "." ||
    value === ".." ||
    !ID_PATTERN.test(value) ||
    hasControlCharacter(value)
  ) {
    throw new Error(
      `${invalid}: must be a single-line identifier of at most ${TENANT_ID_MAX} characters (letters, digits, dot, dash, underscore; no path, delimiter or control characters)`,
    );
  }
  return value;
}

function requireTenantId(value: string | undefined): string {
  return requireSelector(
    value,
    "TENANT_REQUIRED",
    "SCOPED_KEY_INVALID_TENANT_ID",
  );
}

function requireWorkspaceId(value: string | undefined): string {
  return requireSelector(
    value,
    "WORKSPACE_REQUIRED",
    "SCOPED_KEY_INVALID_WORKSPACE_ID",
  );
}

function requireConfigVersion(value: ScopedConfigVersion | undefined): void {
  if (
    !value ||
    typeof value !== "object" ||
    !isPositiveInteger(value.company) ||
    !(value.override === null || isPositiveInteger(value.override))
  ) {
    throw new Error(
      "SCOPED_KEY_INVALID_CONFIG_VERSION: company revision and override revision must be positive integers (override may be null)",
    );
  }
}

function requireDomain(value: string | undefined): string {
  if (typeof value !== "string" || !DOMAIN_PATTERN.test(value)) {
    throw new Error(
      `SCOPED_KEY_INVALID_DOMAIN: must be a lowercase kebab label of at most ${DOMAIN_MAX} characters`,
    );
  }
  return value;
}

function requireLogicalKey(value: string | undefined): string {
  if (typeof value !== "string" || !value || value.length > LOGICAL_KEY_MAX) {
    throw new Error(
      `SCOPED_KEY_INVALID_LOGICAL_KEY: must be a non-empty string of at most ${LOGICAL_KEY_MAX} characters`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 派生原语
// ---------------------------------------------------------------------------

/** 单向摘要：逻辑段与受限字符集键的唯一入键形态（40 hex 截断）。 */
function digestOf(facts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex")
    .slice(0, DIGEST_HEX);
}

function ownershipFacts(
  ownership: ScopedKeyOwnership,
): readonly [string, string, number, number | null] {
  const tenantId = requireTenantId(ownership?.tenantId);
  const workspaceId = requireWorkspaceId(ownership?.workspaceId);
  requireConfigVersion(ownership?.configVersion);
  return [
    tenantId,
    workspaceId,
    ownership.configVersion.company,
    ownership.configVersion.override,
  ];
}

function overrideSegment(override: number | null): string {
  return override === null ? "-" : String(override);
}

/** 读形键的公共前缀：kind 版本 + 归属 + 版本。逻辑段/域段由各入口追加。 */
function readablePrefix(kind: string, ownership: ScopedKeyOwnership): string {
  const [tenantId, workspaceId, company, override] = ownershipFacts(ownership);
  return `${kind}/v1/t=${tenantId}/w=${workspaceId}/c=${company}/o=${overrideSegment(override)}`;
}

// ---------------------------------------------------------------------------
// 适配器：从 runtime-config 解析产物提取归属事实（只读消费，不改其模块）
// ---------------------------------------------------------------------------

/**
 * 从 MT014 runtime-config 的解析产物提取作用域键的归属事实：scope 的真实
 * 归属 + revisions 的配置版本。输入只要携带这两块即可（结构化子集，便于
 * 测试与其他调用方复用）。
 */
export function scopedKeyOwnership(
  resolved: Pick<ResolvedRuntimeConfig, "scope" | "revisions">,
): ScopedKeyOwnership {
  const tenantId = requireTenantId(resolved?.scope?.tenantId);
  const workspaceId = requireWorkspaceId(resolved?.scope?.workspaceId);
  requireConfigVersion(resolved?.revisions);
  return Object.freeze({
    tenantId,
    workspaceId,
    configVersion: Object.freeze({
      company: resolved.revisions.company,
      override: resolved.revisions.override,
    }),
  });
}

// ---------------------------------------------------------------------------
// 四种作用域键 + 共享基础设施键
// ---------------------------------------------------------------------------

/**
 * 缓存键：同一逻辑键在不同公司/团队/配置版本下互不命中。
 * 逻辑段单向摘要——调用方意外传入机密也不会出现在键里，更不可反推。
 */
export function scopedCacheKey(
  ownership: ScopedKeyOwnership,
  domain: string,
  logicalKey: string,
): string {
  const checked = requireDomain(domain);
  const logical = requireLogicalKey(logicalKey);
  return `${readablePrefix("scoped-cache", ownership)}/${checked}/${digestOf([logical])}`;
}

/**
 * 事件通道名：同一逻辑事件流在不同归属/版本下互不相通。
 * kind 前缀与缓存键不同——两类名字即使同域同参也不碰撞。
 */
export function scopedEventChannel(
  ownership: ScopedKeyOwnership,
  domain: string,
  logicalKey: string,
): string {
  const checked = requireDomain(domain);
  const logical = requireLogicalKey(logicalKey);
  return `${readablePrefix("event-channel", ownership)}/${checked}/${digestOf([logical])}`;
}

/**
 * 对象存储前缀（目录形，尾随 "/"）：不同归属/版本的对象路径天然分区，
 * 前缀即授权寻址边界之外的隔离事实——签名 URL 与下载接口仍需各自授权。
 */
export function scopedObjectPrefix(
  ownership: ScopedKeyOwnership,
  domain: string,
): string {
  const checked = requireDomain(domain);
  return `${readablePrefix("object-prefix", ownership)}/${checked}/`;
}

/**
 * 向量命名空间：受限字符集摘要形 `vn-<40hex>`（向量库的集合/命名空间命名
 * 约束远窄于读形键；与 tenant-storage 的 schema 名派生同款）。归属、版本
 * 与域全部进入摘要输入，不同范围永不共享命名空间。
 */
export function scopedVectorNamespace(
  ownership: ScopedKeyOwnership,
  domain: string,
): string {
  const checked = requireDomain(domain);
  const [tenantId, workspaceId, company, override] = ownershipFacts(ownership);
  return `vn-${digestOf(["vector-namespace/v1", tenantId, workspaceId, company, override, checked])}`;
}

/**
 * 共享基础设施键（连接池、模板、静态目录等部署级形态）：全局复用，键里
 * 不含归属段。类型上就不接受归属参数——「共享」是显式入口，不是遗漏。
 */
export function sharedInfrastructureKey(domain: string): string {
  const checked = requireDomain(domain);
  return `shared/v1/${checked}`;
}
