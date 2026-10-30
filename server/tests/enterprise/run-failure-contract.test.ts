import { expect, test } from "../../../tests/support/e2e-compat";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  PlatformScope,
  RunnerRequestLease,
} from "../../src/enterprise/contracts";
import {
  failRunWithLease,
  validateRunFailureInput,
} from "../../src/enterprise/runs/service";
import {
  isCurrentRunLeaseSnapshot,
  runFailureRunLeaseFence,
} from "../../src/enterprise/runs/store";
import { verifyDirectoryDatabase } from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

function makeLease(
  overrides: Partial<RunnerRequestLease> = {},
): RunnerRequestLease {
  return {
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 3,
    ownerToken: "owner-a",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const fixedFailureCodes = [
  "MODEL_EXECUTION_UNAVAILABLE",
  "MODEL_EXECUTION_FAILED",
  "MODEL_SETTLEMENT_FAILED",
  "MODEL_BUDGET_EXCEEDED",
] as const;

test("accepts exactly the four fixed failure codes for a complete lease", () => {
  for (const errorCode of fixedFailureCodes) {
    expect(() =>
      validateRunFailureInput({ lease: makeLease(), errorCode }),
    ).not.toThrow();
  }
});

test("rejects malformed lease tuples and caller-selected failure codes", () => {
  const lease = makeLease();
  for (const invalidLease of [
    { ...lease, runId: " " },
    { ...lease, attemptId: "" },
    { ...lease, generation: 0 },
    { ...lease, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...lease, ownerToken: " " },
    { ...lease, expiresAt: new Date(Number.NaN) },
  ]) {
    expect(() =>
      validateRunFailureInput({
        lease: invalidLease,
        errorCode: "MODEL_EXECUTION_UNAVAILABLE",
      }),
    ).toThrow("INVALID_RUN_FAILURE_INPUT");
  }
  expect(() =>
    validateRunFailureInput({
      lease,
      errorCode: "arbitrary-error" as "MODEL_EXECUTION_UNAVAILABLE",
    }),
  ).toThrow("INVALID_RUN_FAILURE_INPUT");
});

test("rejects an expired failure lease snapshot", () => {
  expect(() =>
    validateRunFailureInput({
      lease: makeLease({ expiresAt: new Date(Date.now() - 1) }),
      errorCode: "MODEL_EXECUTION_UNAVAILABLE",
    }),
  ).toThrow("INVALID_RUN_FAILURE_INPUT");
});

test("a renewed claim with the same owner token rejects the old expiry snapshot", () => {
  const lease = makeLease();
  expect(
    isCurrentRunLeaseSnapshot(
      lease,
      lease.ownerToken,
      new Date(lease.expiresAt.getTime() + 5_000),
    ),
  ).toBe(false);
});

test("forged scope is rejected before the transition delegate is called", async () => {
  const lease = makeLease();
  let delegated = false;
  await expect(
    failRunWithLease(
      { tenantId: "forged" } as never,
      { lease, errorCode: "MODEL_EXECUTION_UNAVAILABLE" },
      async () => {
        delegated = true;
        return true;
      },
    ),
  ).rejects.toThrow("UNVERIFIED_SCOPE");
  expect(delegated).toBe(false);
});

test("trusted scope forwards exact lease and code and preserves false fencing result", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  const forwarded = await captureFailureForward(scope, lease, false);
  expect(forwarded).toEqual({
    lease,
    errorCode: "MODEL_EXECUTION_UNAVAILABLE",
  });
});

test("trusted scope forwards a new execution failure code unchanged and preserves false", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  for (const errorCode of [
    "MODEL_EXECUTION_FAILED",
    "MODEL_SETTLEMENT_FAILED",
    "MODEL_BUDGET_EXCEEDED",
  ] as const) {
    let forwarded: unknown;
    const outcome = await failRunWithLease(
      scope,
      { lease, errorCode },
      async (_scope, input) => {
        forwarded = input;
        return false;
      },
    );
    expect(outcome).toBe(false);
    expect(forwarded).toEqual({ lease, errorCode });
  }
});

test("invalid failure codes reject before the store transition delegate runs", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  for (const invalidCode of [
    "arbitrary-error",
    "MODEL_EXECUTION_UNAVAILABLE_X",
    "",
  ]) {
    let delegated = false;
    await expect(
      failRunWithLease(
        scope,
        { lease, errorCode: invalidCode as "MODEL_EXECUTION_UNAVAILABLE" },
        async () => {
          delegated = true;
          return true;
        },
      ),
    ).rejects.toThrow("INVALID_RUN_FAILURE_INPUT");
    expect(delegated).toBe(false);
  }
});

test("final Run lease SQL fence checks post-update failure, exact scope, and live expiry", () => {
  const scope: PlatformScope = {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
  const query = new PgDialect().sqlToQuery(
    runFailureRunLeaseFence(scope, makeLease(), "MODEL_EXECUTION_UNAVAILABLE"),
  );
  expect(query.sql).toContain("clock_timestamp()");
  expect(query.sql).toContain("tenant_id");
  expect(query.sql).toContain("workspace_id");
  expect(query.sql).toContain("principal_id");
  expect(query.sql).toContain("attempt_generation");
  expect(query.sql).toContain('"enterprise_runs"."status" =');
  expect(query.params).toContain("tenant-a");
  expect(query.params).toContain("workspace-a");
  expect(query.params).toContain("principal-a");
  expect(query.params).toContain("run-a");
  expect(query.params).toContain(3);
  expect(query.params).toContain("failed");
  expect(query.params).toContain("MODEL_EXECUTION_UNAVAILABLE");
});

test("the leased failure fence is parameterized by the supplied allowed error code", () => {
  const scope: PlatformScope = {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
  for (const errorCode of fixedFailureCodes) {
    const query = new PgDialect().sqlToQuery(
      runFailureRunLeaseFence(scope, makeLease(), errorCode),
    );
    expect(query.params).toContain("failed");
    expect(query.params).toContain(errorCode);
    for (const otherCode of fixedFailureCodes) {
      if (otherCode !== errorCode) {
        expect(query.params).not.toContain(otherCode);
        expect(query.sql).not.toContain(otherCode);
      }
    }
  }
});

async function captureFailureForward(
  scope: PlatformScope,
  expectedLease: RunnerRequestLease,
  result: boolean,
) {
  let forwarded: unknown;
  const outcome = await failRunWithLease(
    scope,
    { lease: expectedLease, errorCode: "MODEL_EXECUTION_UNAVAILABLE" },
    async (_scope, input) => {
      forwarded = input;
      return result;
    },
  );
  expect(outcome).toBe(false);
  expect(forwarded).toEqual({
    lease: expectedLease,
    errorCode: "MODEL_EXECUTION_UNAVAILABLE",
  });
  return forwarded;
}

async function makeTrustedScope(): Promise<PlatformScope> {
  const database = {
    execute: async () => [
      {
        current_user_matches: true,
        capability_attributes_ok: true,
        login_attributes_ok: true,
        login_has_expected_capability: true,
        capability_has_no_escalation_membership: true,
        login_has_no_other_memberships: true,
        no_protected_ownership: true,
        login_has_no_enterprise_privileges: true,
      },
    ],
    transaction: async (
      operation: (transaction: unknown) => Promise<unknown>,
    ) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: "tenant-a",
                principalId: "principal-a",
                tenantStatus: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
                status: "active",
              },
            ],
          };
          return query;
        },
      }),
  } as never;
  const directory = await verifyDirectoryDatabase(database);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    selectTenant: () => "tenant-a",
    selectWorkspace: () => "workspace-a",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}
