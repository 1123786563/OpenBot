/**
 * The run-action policy, per plan 03 §4.3: start/cancel/read/resume authorization for the runs
 * ledger, deliberately NOT derived from 02's `read` permission ("不借 read 权限推导执行权").
 *
 * EVERY query and verdict below runs on the CALLER's transaction — "查询和判断都在调用方传
 * 入的同一个withTenant事务内", exactly as §4.3 requires: the live membership chain, the
 * release published, the release's and the route's resources present and active in the
 * scope's tenant, the EXPLICIT `run_grants.start` row, an active `model_grants` row, and a
 * route profile this deployment can execute. `assertOwn` gates the per-run actions: `read`
 * requires the caller's OWN run AND a still-valid expert resource read — re-running 02's
 * extracted `assertResourceReadInTx` (the shared resource lock included) on the very
 * transaction the caller hands in, which is the extraction's intended use; `resume`
 * additionally re-verifies the `resume_own` grant and the CURRENT model authorization;
 * `cancel` deliberately requires only ownership and tenancy — a person whose expert grant
 * was revoked can still stop their own run, while a different principal (in any tenant) gets
 * the same 404 an unknown run gets. A suspended user is stopped by the maintenance channel;
 * there is no unauthenticated cancel back door.
 *
 * The single-transaction property is backed by migration 0064, which completes the
 * run-writer's read-only catalog ("只读成员/资源/grants", plan §4.2) with tenant-pinned
 * SELECT policies on enterprise_tenants / enterprise_principals / enterprise_resource_grants
 * / enterprise_model_routes / enterprise_model_grants — before it, the model-route and
 * resource-grant facts were readable only behind other capability roles and the policy had
 * to preflight them cross-pool (a TOCTOU window the reviewer flagged). Nothing here writes:
 * the model ledger stays read-only for this role, ACLs stay operator-owned, and the audit
 * log is never written by the acting principal.
 *
 * Every failure is a stable EnterpriseError code; message text is the code.
 */
import type { Authz, Scope, Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import { firstRow } from "../tenancy/transaction";
import { assertResourceReadInTx } from "../authz/repository";

/** The run facts the CALLER already read in the same transaction; the policy re-checks them. */
export type RunAccess = {
  ownerPrincipalId: string;
  releaseId: string;
  workspaceId: string;
  threadId: string;
};

export interface RunPolicy {
  assertStart(tx: Tx, scope: Scope, releaseId: string, routeId: string): Promise<void>;
  assertOwn(
    tx: Tx,
    scope: Scope,
    run: RunAccess,
    action: "read" | "cancel" | "resume",
  ): Promise<void>;
}

/**
 * Route profiles this deployment admits at run creation. The runtime proxy (E4-C) extends this
 * set when it learns a new protocol; a route with any other profile is not executable here and
 * is refused closed instead of being started into a dead end.
 */
const ALLOWED_ROUTE_PROFILES: ReadonlySet<string> = new Set(["openai-chat"]);

const RUN_RELEASE_NOT_FOUND = new EnterpriseError("RUN_RELEASE_NOT_FOUND", 404);
const RUN_RELEASE_DISABLED = new EnterpriseError("RUN_RELEASE_DISABLED", 403);
const RUN_MODEL_ROUTE_MISSING = new EnterpriseError("RUN_MODEL_ROUTE_MISSING", 404);
const RUN_MODEL_GRANT_MISSING = new EnterpriseError("RUN_MODEL_GRANT_MISSING", 403);
const RUN_START_NOT_GRANTED = new EnterpriseError("RUN_START_NOT_GRANTED", 403);
const RUN_RESUME_NOT_GRANTED = new EnterpriseError("RUN_RESUME_NOT_GRANTED", 403);
const RUN_NOT_FOUND = new EnterpriseError("RUN_NOT_FOUND", 404);
const RESOURCE_NOT_FOUND = new EnterpriseError("RESOURCE_NOT_FOUND", 404);
const ROUTE_PROFILE_UNSUPPORTED = new EnterpriseError(
  "ROUTE_PROFILE_UNSUPPORTED",
  503,
);
const AUTHORIZATION_STATE_INVALID = new EnterpriseError(
  "AUTHORIZATION_STATE_INVALID",
  503,
);

/* ---------------------------------------------------------------------------
 * Statements. Module constants with $n placeholders; values travel only as
 * parameters. Every statement touches ONLY tables the run-writer login can
 * read on the caller's transaction (migration 0064's completed catalog).
 * ------------------------------------------------------------------------- */

/**
 * The membership half of the identity chain, re-checked here even though `withTenant` just
 * re-checked the FULL chain in the same transaction: a belt, and the guard for callers that
 * run the policy outside `withTenant`.
 */
const POLICY_SELECT_MEMBERSHIP_TEXT = `
  select 1 as ok
  from enterprise_memberships
  where tenant_id = $1 and principal_id = $2 and status = 'active'
    and epoch = $3::bigint and role = $4`;

const POLICY_SELECT_RELEASE_TEXT = `
  select id, status, resource_id, model_route_ref
  from enterprise_run_releases
  where tenant_id = $1 and id = $2`;

const POLICY_SELECT_RESOURCE_ACTIVE_TEXT = `
  select 1 as ok
  from enterprise_resources
  where tenant_id = $1 and id = $2 and status = 'active'`;

const POLICY_SELECT_RUN_GRANT_TEXT = `
  select revision from enterprise_run_grants
  where tenant_id = $1 and release_id = $2 and principal_id = $3 and action = $4`;

const POLICY_SELECT_THREAD_TEXT = `
  select id, owner_principal_id, status
  from enterprise_threads
  where tenant_id = $1 and id = $2`;

/** The route a run is admitted through: one active approved revision (migration 0064 read). */
const POLICY_SELECT_ROUTE_TEXT = `
  select id, resource_id, status, protocol_profile
  from enterprise_model_routes
  where tenant_id = $1 and id = $2 and status = 'active'`;

const POLICY_SELECT_MODEL_GRANT_TEXT = `
  select revision, status
  from enterprise_model_grants
  where tenant_id = $1 and route_id = $2 and principal_id = $3`;

/** bigint columns arrive as strings on the raw client; decimal strings only. */
function decimal(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw AUTHORIZATION_STATE_INVALID;
  }
  return text;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw AUTHORIZATION_STATE_INVALID;
  }
  return value;
}

async function routeById(
  tx: Tx,
  tenantId: string,
  routeId: string,
): Promise<{ id: string; resourceId: string; profile: string }> {
  const row = await firstRow(tx, POLICY_SELECT_ROUTE_TEXT, [tenantId, routeId]);
  if (row === undefined) {
    throw RUN_MODEL_ROUTE_MISSING;
  }
  return {
    id: text(row.id),
    resourceId: text(row.resource_id),
    profile: text(row.protocol_profile),
  };
}

async function requireModelGrant(
  tx: Tx,
  tenantId: string,
  routeId: string,
  principalId: string,
): Promise<string> {
  const row = await firstRow(tx, POLICY_SELECT_MODEL_GRANT_TEXT, [
    tenantId,
    routeId,
    principalId,
  ]);
  if (row === undefined || row.status !== "active") {
    throw RUN_MODEL_GRANT_MISSING;
  }
  return decimal(row.revision);
}

async function requirePublishedRelease(
  tx: Tx,
  scope: Scope,
  releaseId: string,
): Promise<Record<string, unknown>> {
  const row = await firstRow(tx, POLICY_SELECT_RELEASE_TEXT, [
    scope.tenantId,
    releaseId,
  ]);
  if (row === undefined) {
    throw RUN_RELEASE_NOT_FOUND;
  }
  if (row.status !== "published") {
    throw RUN_RELEASE_DISABLED;
  }
  return row;
}

async function requireActiveResource(
  tx: Tx,
  tenantId: string,
  resourceId: string,
): Promise<void> {
  const row = await firstRow(tx, POLICY_SELECT_RESOURCE_ACTIVE_TEXT, [
    tenantId,
    resourceId,
  ]);
  if (row === undefined) {
    throw RESOURCE_NOT_FOUND;
  }
}

async function requireRunGrant(
  tx: Tx,
  scope: Scope,
  releaseId: string,
  action: "start" | "resume_own",
): Promise<void> {
  const row = await firstRow(tx, POLICY_SELECT_RUN_GRANT_TEXT, [
    scope.tenantId,
    releaseId,
    scope.principalId,
    action,
  ]);
  if (row === undefined) {
    throw action === "start" ? RUN_START_NOT_GRANTED : RUN_RESUME_NOT_GRANTED;
  }
}

async function requireMembershipRow(tx: Tx, scope: Scope): Promise<void> {
  const row = await firstRow(tx, POLICY_SELECT_MEMBERSHIP_TEXT, [
    scope.tenantId,
    scope.principalId,
    String(scope.epoch),
    scope.role,
  ]);
  if (row === undefined) {
    /* The membership the scope was minted at is gone or changed: fail closed. */
    throw new EnterpriseError("SCOPE_REVOKED", 403);
  }
}

export function createRunPolicy(deps: { authz: Authz }): RunPolicy {
  const { authz } = deps;

  return {
    async assertStart(tx, scope, releaseId, routeId) {
      await requireMembershipRow(tx, scope);
      const release = await requirePublishedRelease(tx, scope, releaseId);
      await requireActiveResource(tx, scope.tenantId, text(release.resource_id));
      await requireRunGrant(tx, scope, releaseId, "start");

      /* The route's verdict — profile, its resource, the current model grant — on the SAME
       * transaction (migration 0064's completed read catalog). */
      const route = await routeById(tx, scope.tenantId, routeId);
      if (!ALLOWED_ROUTE_PROFILES.has(route.profile)) {
        throw ROUTE_PROFILE_UNSUPPORTED;
      }
      await requireActiveResource(tx, scope.tenantId, route.resourceId);
      await requireModelGrant(tx, scope.tenantId, route.id, scope.principalId);
    },

    async assertOwn(tx, scope, run, action) {
      /* Ownership first, and the same 404 for a foreign run in ANY tenant: an unknown run and
       * someone else's run are indistinguishable, across the tenant boundary included (the
       * transaction's RLS context already hides other tenants' rows). */
      if (run.ownerPrincipalId !== scope.principalId) {
        throw RUN_NOT_FOUND;
      }
      await requireMembershipRow(tx, scope);
      const thread = await firstRow(tx, POLICY_SELECT_THREAD_TEXT, [
        scope.tenantId,
        run.threadId,
      ]);
      if (
        thread === undefined ||
        text(thread.owner_principal_id) !== scope.principalId
      ) {
        throw RUN_NOT_FOUND;
      }
      if (thread.status !== "active") {
        throw new EnterpriseError("RUN_THREAD_ARCHIVED", 409);
      }

      if (action === "cancel") {
        /* Deliberately nothing more: a person whose expert grant was revoked can still stop
         * their own run. The revoked resource's CONTENT is never read on this path. */
        return;
      }

      const release = await requirePublishedRelease(tx, scope, run.releaseId);
      const releaseResourceId = text(release.resource_id);
      await requireActiveResource(tx, scope.tenantId, releaseResourceId);

      if (action === "read") {
        /* The expert resource read must STILL be valid — 02's exact single-transaction
         * algorithm (shared resource lock, live fact, local Authz) on the CALLER's own
         * transaction, the extraction's intended use. */
        await assertResourceReadInTx(tx, scope, releaseResourceId, authz);
        return;
      }

      /* resume: the resume_own grant AND the current model authorization for the release's
       * pinned route (the same verdict a fresh start would make, minus the start grant). */
      await requireRunGrant(tx, scope, run.releaseId, "resume_own");
      const route = await routeById(
        tx,
        scope.tenantId,
        text(release.model_route_ref),
      );
      await requireActiveResource(tx, scope.tenantId, route.resourceId);
      await requireModelGrant(tx, scope.tenantId, route.id, scope.principalId);
    },
  };
}
