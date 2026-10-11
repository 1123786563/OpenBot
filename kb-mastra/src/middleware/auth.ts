/**
 * API Key 解析（对齐 kb-service auth.go 的 Identity 语义）：
 * `Authorization: Bearer <key>` → 在 KB_API_KEYS 表中查身份 {tenantId, role, kbScope}。
 * key 不存在 → null（调用方回 401）。role 三档权限矩阵（v1 §7.2）。
 */

import type { APIKeyEntry, Config } from "../config";

/** 从 API Key 解析出的调用者身份（kb-service auth.Identity 对应物）。 */
export type Identity = {
  tenantId: string;
  role: APIKeyEntry["role"];
  /** kb id 白名单；空 = 租户内全库。 */
  kbScope: ReadonlySet<string>;
};

export function authenticate(
  config: Config,
  offeredKey: string,
): Identity | null {
  const key = offeredKey.trim();
  if (key === "") return null;
  const entry = config.apiKeys.get(key);
  if (!entry) return null;
  return {
    tenantId: entry.tenantId,
    role: entry.role,
    kbScope: entry.kbIds,
  };
}

/** read：检索/列库/查状态。 */
export function canRead(role: Identity["role"]): boolean {
  return role === "read" || role === "write" || role === "admin";
}

/** write：上传/删文档/触发重解析。 */
export function canWrite(role: Identity["role"]): boolean {
  return role === "write" || role === "admin";
}

/** admin：建/删 KB。 */
export function canAdmin(role: Identity["role"]): boolean {
  return role === "admin";
}

/**
 * 身份是否可访问某 KB：租户一致 + （kbScope 非空时）库在白名单内。
 * 调用方负责把 false 折成 404（跨租户不泄漏存在性）。
 */
export function canAccessKB(
  identity: Identity,
  kb: { tenantId: string; id: string },
): boolean {
  if (identity.tenantId !== kb.tenantId) return false;
  if (identity.kbScope.size > 0 && !identity.kbScope.has(kb.id)) return false;
  return true;
}
