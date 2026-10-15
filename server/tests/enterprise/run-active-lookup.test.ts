import { expect, test } from "bun:test";
import type { PlatformScope, RunDTO } from "../../src/enterprise/contracts";
import * as runStore from "../../src/enterprise/runs/store";

const scope: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  actorId: "actor-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

const now = new Date("2026-10-12T12:00:00.000Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: "run-a",
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      threadId: "thread-a",
      status: "running",
      attemptGeneration: 2,
      leaseExpiresAt: new Date(now.getTime() + 10_000),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      errorCode: null,
    },
    attemptId: "attempt-a",
    attemptGeneration: 2,
    attemptStatus: "active",
    attemptLeaseExpiresAt: new Date(now.getTime() + 10_000),
    ...overrides,
  };
}

test("active run lookup returns exact active attempt without owner token", () => {
  const resolve = (runStore as Record<string, unknown>)
    .resolveActiveRunLookup as (
    scope: PlatformScope,
    threadId: string,
    rows: ReturnType<typeof candidate>[],
    now: Date,
  ) => { run: RunDTO; attemptId: string; generation: number } | null;

  expect(typeof resolve).toBe("function");
  const result = resolve(scope, "thread-a", [candidate()], now);
  expect(result).toMatchObject({
    run: { run_id: "run-a", thread_id: "thread-a", status: "running" },
    attemptId: "attempt-a",
    generation: 2,
  });
  expect(result).not.toHaveProperty("ownerToken");
});

test("active run lookup rejects absent, terminal, expired, mismatched and cross-scope rows", () => {
  const resolve = (runStore as Record<string, unknown>)
    .resolveActiveRunLookup as (
    scope: PlatformScope,
    threadId: string,
    rows: ReturnType<typeof candidate>[],
    now: Date,
  ) => { run: RunDTO; attemptId: string; generation: number } | null;
  const expired = new Date(now.getTime() - 1);

  expect(resolve(scope, "thread-a", [], now)).toBeNull();
  for (const row of [
    candidate({ run: { ...candidate().run, status: "succeeded" } }),
    candidate({ run: { ...candidate().run, leaseExpiresAt: expired } }),
    candidate({ attemptLeaseExpiresAt: expired }),
    candidate({ attemptGeneration: 1 }),
    candidate({ attemptStatus: "cancelled" }),
    candidate({ run: { ...candidate().run, threadId: "thread-b" } }),
    candidate({ run: { ...candidate().run, tenantId: "tenant-b" } }),
    candidate({ run: { ...candidate().run, workspaceId: "workspace-b" } }),
    candidate({ run: { ...candidate().run, principalId: "principal-b" } }),
  ]) {
    expect(resolve(scope, "thread-a", [row], now)).toBeNull();
  }
});

test("active run lookup fails closed on multiple eligible attempts", () => {
  const resolve = (runStore as Record<string, unknown>)
    .resolveActiveRunLookup as (
    scope: PlatformScope,
    threadId: string,
    rows: ReturnType<typeof candidate>[],
    now: Date,
  ) => { run: RunDTO; attemptId: string; generation: number } | null;
  expect(() =>
    resolve(
      scope,
      "thread-a",
      [candidate(), candidate({ run: { ...candidate().run, id: "run-b" } })],
      now,
    ),
  ).toThrow("RUN_ACTIVE_AMBIGUOUS");
});
