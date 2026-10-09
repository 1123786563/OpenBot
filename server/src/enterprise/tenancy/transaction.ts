/**
 * The transaction layer for enterprise tenancy reads and writes, per plan 02 §5 T1-C and §6 T2-B
 * (the lock primitives landed with T1-C because the provisioning commands needed them; T2-B adds
 * the reader-side `withTenant`).
 *
 * Statements run through Bun `SQL.unsafe(text, values)` — explicit `$n` placeholders with the
 * values passed separately, which is the parameterised form drizzle itself uses under the hood for
 * every query it builds (drizzle-orm/bun-sql/session.js executes `client.unsafe(query, params)`).
 * Nothing interpolates a runtime value into statement text.
 *
 * Advisory locks replace `SELECT FOR SHARE/UPDATE`, which would need extra table privileges a
 * read-only role must not hold. The lock name is a JSON array — `["enterprise", kind, ...ids]` —
 * so keys of different kinds, or one kind with different id arities, can never collide; a
 * hashtextextended collision only over-serializes two unrelated operations, it never grants one.
 * Locks are transaction-scoped and vanish with COMMIT or ROLLBACK however the transaction ends.
 *
 * Every writer takes its keys in the fixed order tenant → principal → membership → resource →
 * operation (global identity work takes principal → global operation and never a tenant key), and
 * within one kind in stable lexicographic order. Never hold one of these locks across a network
 * call.
 */
import type { SQL, TransactionSQL } from "bun";
import type { Database } from "../../db/client";
import type { Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import { assertScope } from "./scope";

/** A transaction-scoped Bun SQL client: the same driver drizzle wraps, inside BEGIN … COMMIT. */
export type TxClient = TransactionSQL;

const READ_COMMITTED = "set transaction isolation level read committed";
const LOCK_SHARED_TEXT =
  "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))";
const LOCK_EXCLUSIVE_TEXT =
  "select pg_advisory_xact_lock(hashtextextended($1, 0))";
const TENANT_CONTEXT_TEXT = "select set_config('app.tenant_id', $1, true)";
const TENANT_AND_PRINCIPAL_CONTEXT_TEXT =
  "select set_config('app.tenant_id', $1, true), set_config('app.operator_principal_id', $2, true)";

export function lockKey(kind: string, ...ids: string[]): string {
  return JSON.stringify(["enterprise", kind, ...ids]);
}

export async function lockShared(tx: TxClient, key: string): Promise<void> {
  await tx.unsafe(LOCK_SHARED_TEXT, [key]);
}

export async function lockExclusive(tx: TxClient, key: string): Promise<void> {
  await tx.unsafe(LOCK_EXCLUSIVE_TEXT, [key]);
}

/**
 * Runs `fn` inside one READ COMMITTED transaction on a single pooled connection. The isolation
 * level is set as the transaction's first statement, before any query can pin a different one.
 * Bun's `begin` commits when the callback resolves and rolls back when it rejects.
 */
export async function beginOperation<T>(
  database: Database,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return database.$client.begin(async (tx) => {
    await tx.unsafe(READ_COMMITTED);
    return fn(tx);
  });
}

/** Sets the transaction-local tenant context the operator's RLS policies are pinned to. */
export async function setTenantContext(
  tx: TxClient,
  tenantId: string,
): Promise<void> {
  await tx.unsafe(TENANT_CONTEXT_TEXT, [tenantId]);
}

/**
 * Sets the tenant context plus the single-principal lookup context. The operator can read exactly
 * the principal this names (`operator_principal_lookup`, columns id/user_id/status), which is the
 * whole principal visibility a tenant operator ever gets.
 */
export async function setTenantAndPrincipalContext(
  tx: TxClient,
  tenantId: string,
  principalId: string,
): Promise<void> {
  await tx.unsafe(TENANT_AND_PRINCIPAL_CONTEXT_TEXT, [tenantId, principalId]);
}

/**
 * Runs one statement with bound values and returns the first row, or undefined when the statement
 * matched nothing. Statement texts are module constants; only values travel as parameters.
 */
export async function firstRow(
  tx: TxClient,
  text: string,
  values: ReadonlyArray<string>,
): Promise<Record<string, unknown> | undefined> {
  /* unsafe's type parameter is the resolved rows array (Query<T> extends Promise<T>). */
  const rows = await tx.unsafe<Record<string, unknown>[]>(text, [...values]);
  return rows[0];
}

/*
 * The scoped read transaction, per plan 02 §6 T2-B step 3.
 *
 * `app.tenant_id` / `app.principal_id` / `app.user_id` are set as transaction-local context — the
 * three values the `ob_ent_data` RLS policies pin every enterprise table to — so context and query
 * share one transaction on one pooled connection and neither can bleed onto a neighbour. The
 * membership is then re-checked against the live database: the epoch and role must still be the
 * ones the scope was minted at, and the whole user → principal → membership → tenant chain must
 * still be active. A scope that passed `assertScope` but no longer matches the database fails
 * closed here with SCOPE_REVOKED.
 */
const TENANT_READ_CONTEXT_TEXT =
  "select set_config('app.tenant_id', $1, true), set_config('app.principal_id', $2, true), set_config('app.user_id', $3, true)";
const LOCK_TIMEOUT_TEXT = "set local lock_timeout = '2s'";
const STATEMENT_TIMEOUT_TEXT = "set local statement_timeout = '5s'";
const RECHECK_MEMBERSHIP_TEXT = `
  select m.epoch as epoch, m.role as role
  from enterprise_memberships m
  join enterprise_principals p on p.id = m.principal_id
  join enterprise_tenants t on t.id = m.tenant_id
  where m.tenant_id = $1 and m.principal_id = $2
    and p.user_id = $3 and m.status = 'active' and p.status = 'active' and t.status = 'active'`;

/**
 * Runs `fn` inside one READ COMMITTED transaction scoped to `scope`: the tenant context is
 * transaction-local, the plan's three shared advisory locks are taken in the fixed order, the live
 * membership is re-validated, and only then does the caller's work run. The transaction commits
 * when `fn` resolves and rolls back when it rejects; the `Tx` handle is never stored globally and
 * every DB result must be consumed before `fn` returns.
 */
export async function withTenant<T>(
  database: Database,
  scope: Scope,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  assertScope(scope);
  return beginOperation(database, async (tx) => {
    await tx.unsafe(TENANT_READ_CONTEXT_TEXT, [
      scope.tenantId,
      scope.principalId,
      scope.userId,
    ]);
    await tx.unsafe(LOCK_TIMEOUT_TEXT);
    await tx.unsafe(STATEMENT_TIMEOUT_TEXT);
    await lockShared(tx, lockKey("tenant", scope.tenantId));
    await lockShared(tx, lockKey("principal", scope.principalId));
    await lockShared(
      tx,
      lockKey("membership", scope.tenantId, scope.principalId),
    );

    const current = await firstRow(tx, RECHECK_MEMBERSHIP_TEXT, [
      scope.tenantId,
      scope.principalId,
      scope.userId,
    ]);
    if (
      current === undefined ||
      current.epoch !== scope.epoch ||
      current.role !== scope.role
    ) {
      throw new EnterpriseError("SCOPE_REVOKED", 403);
    }
    return fn(tx);
  });
}

/** Exposed for tests that need the raw client of a dedicated pool. */
export type { SQL };
