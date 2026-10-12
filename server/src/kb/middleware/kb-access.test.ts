import { describe, expect, test } from "bun:test";
import type { Identity } from "./auth";
import { checkKbAccess } from "./kb-access";

function identityOf(
  role: Identity["role"],
  tenantId = "t1",
  kbScope: string[] = [],
): Identity {
  return { tenantId, role, kbScope: new Set(kbScope) };
}

describe("checkKbAccess", () => {
  const kb = { tenantId: "t1", id: "kb1" };

  test("read role passes read, fails write/admin with 403", () => {
    expect(checkKbAccess(identityOf("read"), kb, "read").ok).toBe(true);
    const write = checkKbAccess(identityOf("read"), kb, "write");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.status).toBe(403);
    const admin = checkKbAccess(identityOf("read"), kb, "admin");
    expect(admin.ok).toBe(false);
    if (!admin.ok) expect(admin.status).toBe(403);
  });

  test("cross-tenant access answers 404, not 403", () => {
    // 403 会泄漏「这个库存在于别的租户」；404 与「库不存在」不可区分。
    const decision = checkKbAccess(identityOf("admin", "t2"), kb, "read");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  test("missing kb row answers the same 404", () => {
    const decision = checkKbAccess(identityOf("admin"), null, "read");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  test("scoped key outside its whitelist answers 404", () => {
    const scoped = identityOf("admin", "t1", ["kb-other"]);
    const decision = checkKbAccess(scoped, kb, "read");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  test("admin passes everything on its own tenant", () => {
    expect(checkKbAccess(identityOf("admin"), kb, "read").ok).toBe(true);
    expect(checkKbAccess(identityOf("admin"), kb, "write").ok).toBe(true);
    expect(checkKbAccess(identityOf("admin"), kb, "admin").ok).toBe(true);
  });
});
