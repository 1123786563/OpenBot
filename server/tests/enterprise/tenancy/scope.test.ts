import { describe, expect, test } from "bun:test";
import type { Directory, Membership } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import {
  assertScope,
  resolveScope,
} from "../../../src/enterprise/tenancy/scope";

/*
 * Scope issuance and trust, per plan 02 §6 T2-A step 1.
 *
 * These are unit cases: the Directory is a local fixture, so they prove the issuance RULES — the
 * selector cannot conjure a membership, a suspended anything is denied, and only scopes this
 * process actually issued are trusted. The real directory-role behaviour (one human listing two
 * tenants, another user seeing neither) is proven against the live database in directory.test.ts.
 *
 * The error contract is asserted on `code` and `status`, never on message text alone: §4.3 makes
 * the code the contract and the message deliberately just the code.
 */

const row: Membership = {
  tenantId: "a",
  principalId: "p",
  tenantName: "A",
  role: "member",
  epoch: 1,
  tenantStatus: "active",
  principalStatus: "active",
  memberStatus: "active",
};

/** Captures the EnterpriseError a rejected call throws, failing the test on any other outcome. */
async function enterpriseErrorOf(
  run: () => Promise<unknown>,
): Promise<EnterpriseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return error;
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

describe("plan 02 §6 T2-A step 1: non-member and suspended-member rejection", () => {
  test("selector cannot create membership", async () => {
    const directory: Directory = { listForUser: async () => [row] };
    await expect(resolveScope(directory, "u", "b")).rejects.toThrow(
      "TENANT_FORBIDDEN",
    );
  });

  test("suspended membership is denied", async () => {
    const directory: Directory = {
      listForUser: async () => [{ ...row, memberStatus: "suspended" }],
    };
    await expect(resolveScope(directory, "u", "a")).rejects.toThrow(
      "TENANT_FORBIDDEN",
    );
  });

  test("a plain object cannot impersonate a verified scope", () => {
    expect(() =>
      assertScope({
        tenantId: "a",
        principalId: "p",
        userId: "u",
        role: "member",
        epoch: 1,
      }),
    ).toThrow("UNVERIFIED_SCOPE");
  });
});

describe("resolveScope rejects before it ever queries the directory", () => {
  test("a missing or dev-local user is unauthenticated", async () => {
    const directory: Directory = { listForUser: async () => [row] };
    for (const userId of ["", "dev-local-user"]) {
      const error = await enterpriseErrorOf(() =>
        resolveScope(directory, userId, "a"),
      );
      expect(error.code).toBe("AUTH_REQUIRED");
      expect(error.status).toBe(401);
    }
  });

  test("a missing, empty or malformed selector is a bad request, not a forbidden one", async () => {
    const directory: Directory = { listForUser: async () => [row] };
    for (const selector of [
      undefined,
      "",
      "not a tenant id",
      "a".repeat(129),
    ]) {
      const error = await enterpriseErrorOf(() =>
        resolveScope(directory, "u", selector),
      );
      expect(error.code).toBe("TENANT_REQUIRED");
      expect(error.status).toBe(400);
    }
  });
});

describe("every non-active link in user → principal → membership → tenant denies", () => {
  test("a suspended tenant or principal is as forbidden as a suspended membership", async () => {
    for (const degraded of [
      { tenantStatus: "suspended" },
      { principalStatus: "suspended" },
    ] as const) {
      const directory: Directory = {
        listForUser: async () => [{ ...row, ...degraded }],
      };
      const error = await enterpriseErrorOf(() =>
        resolveScope(directory, "u", "a"),
      );
      expect(error.code).toBe("TENANT_FORBIDDEN");
      expect(error.status).toBe(403);
    }
  });
});

describe("an issued scope is trusted exactly as long as it is not copied", () => {
  test("resolveScope returns the membership facts and the scope passes assertScope", async () => {
    const directory: Directory = { listForUser: async () => [row] };
    const scope = await resolveScope(directory, "u", "a");
    expect(scope).toEqual({
      tenantId: "a",
      principalId: "p",
      userId: "u",
      role: "member",
      epoch: 1,
    });
    expect(() => assertScope(scope)).not.toThrow();
  });

  test("a serialized-and-restored or spread-copied scope loses trust", async () => {
    const directory: Directory = { listForUser: async () => [row] };
    const scope = await resolveScope(directory, "u", "a");
    const restored = JSON.parse(JSON.stringify(scope)) as typeof scope;
    expect(() => assertScope(restored)).toThrow("UNVERIFIED_SCOPE");
    expect(() => assertScope({ ...scope })).toThrow("UNVERIFIED_SCOPE");
  });

  test("a user whose directory listing is empty gets no scope at all", async () => {
    const directory: Directory = { listForUser: async () => [] };
    const error = await enterpriseErrorOf(() =>
      resolveScope(directory, "u", "a"),
    );
    expect(error.code).toBe("TENANT_FORBIDDEN");
    expect(error.status).toBe(403);
  });
});
