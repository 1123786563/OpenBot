// server/tests/multitenancy/support/admin-separation.ts
// MT075（Issue #118）support：真实 MT006 公司管理表面 + 受限 operator 连接。
//
// 复用 workspace-scope 夹具（真实隔离矩阵、真实路由、真实受限角色），
// 另开一条已验证的 operator 连接供跨面审计事件写入（与撤权审计同一
// RLS INSERT 策略通道）。无任何 mocked 授权路径。

import { createDatabase } from "../../../src/db/client";
import { verifyOperatorDatabase } from "../../../src/enterprise/tenancy/connections";
import { enterpriseRuntimeDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  createWorkspaceScopeFixture,
  type WorkspaceScopeFixture,
} from "./workspace-scope";

export interface AdminSeparationFixture {
  /** The real MT006 company management surface over the restricted roles. */
  readonly scope: WorkspaceScopeFixture;
  /** A verified operator connection for management-audit writes. */
  readonly operator: Awaited<ReturnType<typeof verifyOperatorDatabase>>;
  /** 释放夹具资源：清扫行 + 倒序关池 + 隔离夹具 dispose（失败聚合上报）。 */
  readonly dispose: () => Promise<void>;
}

export async function createAdminSeparationFixture(): Promise<AdminSeparationFixture> {
  const scope = await createWorkspaceScopeFixture();
  let candidate: ReturnType<typeof createDatabase>;
  let operator: Awaited<ReturnType<typeof verifyOperatorDatabase>>;
  try {
    // Inside the try: a missing/malformed operator URL must take the same
    // cleanup path as a failed verification instead of leaking the scope.
    candidate = createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator"), {
      max: 1,
    });
    operator = await verifyOperatorDatabase(candidate);
  } catch (error) {
    // Independent cleanup steps: a close failure must neither skip
    // scope.dispose() nor mask the verification error that caused them.
    const failures: unknown[] = [error];
    try {
      await candidate.$client.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await scope.dispose();
    } catch (disposeError) {
      failures.push(disposeError);
    }
    throw failures.length > 1
      ? new AggregateError(failures, "MT075 fixture setup failed.")
      : error;
  }
  let disposed = false;
  return {
    scope,
    operator,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      try {
        await operator.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await scope.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "MT075 fixture disposal failed.");
      }
    },
  };
}
