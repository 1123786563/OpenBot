// server/src/enterprise/tenancy/scope-gate.ts
// MT005（Issue #48）：集中授权入口的业务事务半边。
//
// 签发半边（createScopeResolver.resolve）验证「有效公司成员资格 + 有效团队
// 成员资格」后签发受信 Scope；本文件是同一判定的**事务等价物**：任何业务
// 事务开始时在同一事务内重验两级成员资格，撤权（公司级或团队级）后的下一
// 个事务立即拒绝。形状与 `createConversationStore().transaction` 完全一致
// （conversations/store.ts 模式）：
//   assertTrustedScope → read committed + lock/statement timeout →
//   set_config('app.*', …, true)（事务本地，提交即清除，RLS 纵深防御）→
//   advisory 共享锁 tenant → principal → membership → workspace-membership →
//   公司成员重验（active + epoch === scope.memberEpoch + actor 绑定）→
//   团队成员重验（行存在且 status = 'active'）→ 业务操作。
//
// 裁决 #2（MT005）：本栈策略版本只有 tenancy-v1；本文件不引入任何策略版本
// 常量，也不存在 conversations-v1。团队级锁键是新键型
// ["enterprise","workspace-membership",tenant,workspace,principal]，排在
// membership 之后、resource 之前（seam-identification-mt005.md §4.3 顺序）。

import { and, eq, sql } from "drizzle-orm";
import type { CompanyAssurance } from "../../auth/company-assurance";
import type { DirectoryAuthority } from "../../auth/directory/authority";
import type { Database } from "../../db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "./connections";
import { assertTrustedScope } from "./store";

export interface WorkspaceGate {
  /**
   * Runs `operation` inside a business transaction that revalidates both
   * company and team membership for the trusted scope before the operation,
   * throwing `SCOPE_REVOKED` (company level) or `WORKSPACE_REVOKED` (team
   * level) instead of executing it.
   */
  transaction<T>(
    scope: PlatformScope,
    operation: (
      tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T>;
}

/** The advisory-lock key the gate takes shared and admin writes take exclusive. */
export function workspaceMembershipLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise",
    "workspace-membership",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

/*
 * --- T03.01 (#538, interfaces §4): the BA-aware business gate ---------------
 *
 * The authority-aware half of the workspace gate. The persisted AuthorityState
 * is read INSIDE the gate's own short transaction, so the branch a scope is
 * revalidated against is the state its operation races with:
 *
 * - legacy (M0/M1) and paused (M2/M3): business reads keep the original
 *   revalidation on the legacy facts — the branches below read nothing else,
 *   so an existing tenant is never refused by a migration it has not reached
 *   (and the paused directory-write rules are untouched by this gate).
 * - ba (M4..M7): the gate additionally compares the persistent identity and
 *   the two-layer eligibility versions — `enterprise_principals.
 *   identity_generation` against the scope's `identityGeneration`, the
 *   company clock (kind=company, scope=tenant) against `memberEpoch`/
 *   `companyGeneration`, and the team clock (kind=team, scope=workspace)
 *   against `workspaceMemberEpoch`/`teamGeneration`. A scope without versions,
 *   a missing/tombstoned clock, or any drift closes the branch with the same
 *   two codes the legacy gate uses — never a fallback, never a default. The
 *   company proof port is asked in this same transaction.
 *
 * Construction takes the authority port and the proof port, both REQUIRED: an
 * optional authority would guess the branch and an optional proof port is
 * exactly the bypass interfaces §5 forbids.
 */

/** The required dependencies of the BA workspace gate (T03.01). */
export interface BaWorkspaceGateDeps {
  readonly authority: Pick<DirectoryAuthority, "read">;
  readonly assurance: CompanyAssurance;
}

/** A `Version` a reader may compare: a non-negative safe integer, never a default. */
function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Drizzle execute results arrive as rows or wrapped rows depending on driver shape. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/**
 * The server actor the proof question is asked for: the scope's holder. The
 * scope is a server-issued trusted object (WeakSet-proven above), so its
 * actor binding is server knowledge, not a client claim. `platform` because a
 * scope carries no session id — the live require (T05.04) answers this actor
 * from the user's active proof, and the per-session binding tightens when the
 * scope carries its private session association.
 */
function scopeActor(
  scope: PlatformScope,
): Parameters<CompanyAssurance["require"]>[1] {
  return Object.freeze({
    userId: scope.actorId,
    principalId: scope.principalId,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  });
}

export function createBaWorkspaceGate(
  data: Database,
  deps: BaWorkspaceGateDeps,
): WorkspaceGate {
  if (!deps || typeof deps?.authority?.read !== "function") {
    throw new Error(
      "BA_SCOPE_GATE_DEPS_REQUIRED: createBaWorkspaceGate needs the directory authority port — without an in-transaction authority read the gate cannot tell a ba revalidation from a legacy one, and an optional port is the bypass interfaces §3.3 forbids",
    );
  }
  if (typeof deps?.assurance?.require !== "function") {
    throw new Error(
      "BA_SCOPE_GATE_DEPS_REQUIRED: createBaWorkspaceGate needs the company assurance port — an optional proof dependency is exactly the bypass interfaces §5 forbids",
    );
  }
  const authority = deps.authority;
  const assurance = deps.assurance;
  return {
    async transaction(scope, operation) {
      // Trust boundary first: only this process's issuance entry can produce
      // a scope the gate will act on, before any database is touched.
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // The branch decision is read in THIS transaction (interfaces §3.3).
        const state = await authority.read(tx);
        // Lock order: tenant → principal → membership → workspace-membership.
        for (const key of [
          JSON.stringify(["enterprise", "tenant", scope.tenantId]),
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        if (state.directoryAuthority === "ba") {
          // Company level: the live statuses and epoch of the original gate,
          // plus the persistent identity generation comparison.
          const [membership] = await tx
            .select({
              memberStatus: enterpriseMemberships.status,
              memberEpoch: enterpriseMemberships.epoch,
              principalStatus: enterprisePrincipals.status,
              identityGeneration: enterprisePrincipals.identityGeneration,
              tenantStatus: enterpriseTenants.status,
            })
            .from(enterpriseMemberships)
            .innerJoin(
              enterprisePrincipals,
              eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
            )
            .innerJoin(
              enterpriseTenants,
              eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
            )
            .where(
              and(
                eq(enterpriseMemberships.tenantId, scope.tenantId),
                eq(enterpriseMemberships.principalId, scope.principalId),
                eq(enterprisePrincipals.userId, scope.actorId),
              ),
            )
            .limit(1);
          if (
            membership?.memberStatus !== "active" ||
            membership?.principalStatus !== "active" ||
            membership?.tenantStatus !== "active" ||
            membership?.memberEpoch !== scope.memberEpoch ||
            !isSafeVersion(scope.identityGeneration) ||
            membership.identityGeneration !== scope.identityGeneration
          ) {
            throw new Error("SCOPE_REVOKED");
          }
          // Team level: the live row, plus its epoch.
          const [teamMembership] = await tx
            .select({
              status: enterpriseWorkspaceMemberships.status,
              epoch: enterpriseWorkspaceMemberships.epoch,
            })
            .from(enterpriseWorkspaceMemberships)
            .where(
              and(
                eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
                eq(
                  enterpriseWorkspaceMemberships.workspaceId,
                  scope.workspaceId,
                ),
                eq(
                  enterpriseWorkspaceMemberships.principalId,
                  scope.principalId,
                ),
              ),
            )
            .limit(1);
          if (
            teamMembership?.status !== "active" ||
            !isSafeVersion(scope.workspaceMemberEpoch) ||
            teamMembership.epoch !== scope.workspaceMemberEpoch
          ) {
            throw new Error("WORKSPACE_REVOKED");
          }
          // The durable two-layer clocks, through the data role's controlled
          // read (the only privilege a runtime role holds on the clocks).
          const clocks = rowsOf(
            await tx.execute(
              sql`select kind, scope_id, epoch::text as epoch, generation::text as generation, tombstone
                    from auth_read_eligibility_clocks(${scope.tenantId}, ${scope.principalId})`,
            ),
          );
          const companyClock = clocks.find(
            (clock) =>
              clock.kind === "company" && clock.scope_id === scope.tenantId,
          );
          // A removed member's clock tombstones; a removed-and-rejoined
          // member's clock advances — both deny the OLD scope here.
          if (
            !companyClock ||
            companyClock.tombstone === true ||
            !isSafeVersion(Number(companyClock.epoch)) ||
            Number(companyClock.epoch) !== scope.memberEpoch ||
            !isSafeVersion(scope.companyGeneration) ||
            Number(companyClock.generation) !== scope.companyGeneration
          ) {
            throw new Error("SCOPE_REVOKED");
          }
          const teamClock = clocks.find(
            (clock) =>
              clock.kind === "team" && clock.scope_id === scope.workspaceId,
          );
          if (
            !teamClock ||
            teamClock.tombstone === true ||
            !isSafeVersion(Number(teamClock.epoch)) ||
            Number(teamClock.epoch) !== scope.workspaceMemberEpoch ||
            !isSafeVersion(scope.teamGeneration) ||
            Number(teamClock.generation) !== scope.teamGeneration
          ) {
            throw new Error("WORKSPACE_REVOKED");
          }
          // The company proof question, in this same transaction. A refusal
          // propagates — it is never folded into a revocation verdict.
          await assurance.require(tx, scopeActor(scope), scope.tenantId);
        } else {
          // legacy (M0/M1) and paused (M2/M3): business reads keep the
          // original revalidation, byte for byte.
          await revalidateLegacyMemberships(tx, scope);
        }
        return operation(tx);
      });
    },
  };
}

/**
 * The original two-level revalidation (MT005), shared verbatim by the legacy
 * gate and the BA gate's legacy/paused branches so the branches cannot drift.
 */
async function revalidateLegacyMemberships(
  tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  scope: PlatformScope,
): Promise<void> {
  // Company-level revalidation (same facts as conversations/store.ts).
  const [membership] = await tx
    .select({
      memberStatus: enterpriseMemberships.status,
      memberEpoch: enterpriseMemberships.epoch,
      principalStatus: enterprisePrincipals.status,
      tenantStatus: enterpriseTenants.status,
    })
    .from(enterpriseMemberships)
    .innerJoin(
      enterprisePrincipals,
      eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
    )
    .innerJoin(
      enterpriseTenants,
      eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
    )
    .where(
      and(
        eq(enterpriseMemberships.tenantId, scope.tenantId),
        eq(enterpriseMemberships.principalId, scope.principalId),
        eq(enterprisePrincipals.userId, scope.actorId),
      ),
    )
    .limit(1);
  if (
    membership?.memberStatus !== "active" ||
    membership?.principalStatus !== "active" ||
    membership?.tenantStatus !== "active" ||
    membership?.memberEpoch !== scope.memberEpoch
  ) {
    throw new Error("SCOPE_REVOKED");
  }
  // Team-level revalidation: the row must exist and be active. Removal
  // deletes the row; suspension flips its status — both land here.
  const [teamMembership] = await tx
    .select({ status: enterpriseWorkspaceMemberships.status })
    .from(enterpriseWorkspaceMemberships)
    .where(
      and(
        eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
        eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
        eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
      ),
    )
    .limit(1);
  if (teamMembership?.status !== "active") {
    throw new Error("WORKSPACE_REVOKED");
  }
}

export function createWorkspaceGate(data: DataDatabase): WorkspaceGate {
  return {
    async transaction(scope, operation) {
      // Trust boundary first: only this process's issuance entry can produce
      // a scope the gate will act on (acceptance 1).
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // Lock order: tenant → principal → membership → workspace-membership.
        for (const key of [
          JSON.stringify(["enterprise", "tenant", scope.tenantId]),
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        // The original two-level revalidation, shared with the BA gate's
        // legacy/paused branches (T03.01) so the branches cannot drift.
        await revalidateLegacyMemberships(tx, scope);
        return operation(tx);
      });
    },
  };
}
