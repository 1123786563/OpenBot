import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import {
  TenantSummarySchema,
} from "../../../../shared/enterprise/mobile-schemas";

// TenantSummary tests (C02)
describe("mobile TenantSummary schema (C02)", () => {
  test("accepts each valid role and a complete value", () => {
    for (const role of ["tenant_admin", "member", "auditor"]) {
      const parsed = TenantSummarySchema.safeParse({
        id: "t1",
        name: "T",
        role,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("rejects missing or empty fields", () => {
    const cases = [
      { name: "T", role: "member" },
      { id: "t1", role: "member" },
      { id: "t1", name: "T" },
      { id: "", name: "T", role: "member" },
      { id: "t1", name: "", role: "member" },
    ];
    for (const c of cases) {
      const parsed = TenantSummarySchema.safeParse(c as unknown);
      expect(parsed.success).toBe(false);
    }
  });

  test("rejects invalid roles", () => {
    const parsed = TenantSummarySchema.safeParse({
      id: "t1",
      name: "T",
      role: "owner",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects trusted identity/scope and credential fields", () => {
    for (const extra of [
      "scope",
      "tenantId",
      "principalId",
      "password",
      "credentials",
      "token",
    ]) {
      const obj: Record<string, unknown> = {
        id: "t1",
        name: "T",
        role: "member",
      };
      obj[extra] = "x";
      const parsed = TenantSummarySchema.safeParse(obj);
      expect(parsed.success).toBe(false);
    }
  });

  test("rejects any extra fields", () => {
    const parsed = TenantSummarySchema.safeParse({
      id: "t1",
      name: "T",
      role: "member",
      extra: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
