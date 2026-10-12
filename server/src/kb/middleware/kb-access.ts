/**
 * KB 归属校验：handler 在触碰具体 KB 前调用，统一越权语义（v1 §7.2）：
 *   跨 tenant → 404（不泄漏存在性，对齐 kb-service）；
 *   role 不足 → 403；
 *   kbScope 白名单外 → 404（同跨租户处理：不让探测白名单范围）。
 *
 * 独立于 Mastra middleware 链：它需要先查 DB（KB 行），放在 handler 内联调用，
 * 保持在「HTTP 边界层」而不是中间件层（中间件无 DB 依赖，测试面干净）。
 */

import type { Identity } from "./auth";
import { canAccessKB, canAdmin, canRead, canWrite } from "./auth";

export type AccessDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; code: string; message: string };

/**
 * 校验访问某 KB 的权限。kb 为 null（DB 查不到）与跨租户同观感 404。
 */
export function checkKbAccess(
  identity: Identity,
  kb: { tenantId: string; id: string } | null,
  required: "read" | "write" | "admin",
): AccessDecision {
  if (!kb || !canAccessKB(identity, kb)) {
    // kb 不存在 / 跨租户 / 白名单外：一律 404，不泄漏任何一种区别。
    return {
      ok: false,
      status: 404,
      code: "not_found",
      message: "knowledge base not found",
    };
  }
  const roleOk =
    required === "admin"
      ? canAdmin(identity.role)
      : required === "write"
        ? canWrite(identity.role)
        : canRead(identity.role);
  if (!roleOk) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: `role ${identity.role} lacks ${required} permission`,
    };
  }
  return { ok: true };
}
