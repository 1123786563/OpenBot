import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import type { PlatformScope } from "../enterprise/contracts";
import type { DeploymentEntryBusiness } from "../enterprise/tenancy/entry-context";
import {
  restorePayerBinding,
  withPayerBinding,
  type PayerBinding,
} from "./payer-binding";
import { resolveCompanyPayerAccount } from "./payer-company";

/*
 * The company-workbench payer wiring (Bifrost 09.2, #287): a workbench call made under a
 * server-issued company scope bills the company — the payer is bound at the request's edge
 * and every downstream money move (the admission reserve, the settlement, the carried
 * remainder) names that one account, because the consumption entry resolves whatever
 * `withPayerBinding` established and never re-resolves (02.5's no-switch semantics).
 *
 * The scope's own facts ride beside the binding: workspaceId (the team) and principalId
 * (the person) are usage ATTRIBUTION, not payment — the payer stays the company no matter
 * which team or member the call came from. The gate reads them at the usage fact, so the
 * record answers "who and which team" without those dimensions ever being able to move the
 * account the call billed.
 *
 * A request with no entry business (a personal deployment, or a workbench request that
 * carried no selection headers) binds nothing: the consumption entry falls to the
 * deployment's own binding exactly as before. Absent stays absent — this seam never
 * guesses a payer.
 */

/** The workbench scope's attribution facts, as the usage fact records them. */
export interface WorkbenchScopeAttribution {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

const scopeStore = new AsyncLocalStorage<WorkbenchScopeAttribution>();

/** Run `fn` (and everything it awaits) as work attributed to this workbench scope. */
export function withWorkbenchScope<T>(
  attribution: WorkbenchScopeAttribution,
  fn: () => Promise<T>,
): Promise<T> {
  return scopeStore.run(attribution, fn);
}

/** The request's workbench attribution, or undefined when no company scope established one. */
export function currentWorkbenchScope(): WorkbenchScopeAttribution | undefined {
  return scopeStore.getStore();
}

/**
 * Resolve the company binding for a trusted scope: the scope's tenant through the payer
 * layer's idempotent account create, rebuilt into the binding shape the consumption entry
 * consumes. The scope arrives from the tenancy middleware's own `entryBusiness` — never
 * from a header the caller typed.
 */
export async function resolveWorkbenchPayerBinding(
  database: Database,
  scope: PlatformScope,
): Promise<PayerBinding> {
  const account = await resolveCompanyPayerAccount(database, scope);
  return restorePayerBinding(account);
}

/**
 * The per-request payer binding for the workbench surface: whatever entry business the
 * tenancy middleware established ahead of this seam becomes the company the call bills and
 * the attribution the usage fact carries. No entry business means nothing to bind — the
 * personal/legacy paths keep their existing resolution untouched.
 */
export function createWorkbenchPayerMiddleware(deps: {
  database: Database;
}): MiddlewareHandler {
  const { database } = deps;
  return async (context, next) => {
    // The same untyped slot `createDeploymentEntryContextMiddleware` writes; this seam reads
    // only what that middleware established for this request.
    const business = (
      context as unknown as {
        get: (key: "entryBusiness") => DeploymentEntryBusiness | undefined;
      }
    ).get("entryBusiness");
    if (!business) return next();
    const binding = await resolveWorkbenchPayerBinding(database, business.scope);
    const { tenantId, workspaceId, principalId } = business.scope;
    return withWorkbenchScope({ tenantId, workspaceId, principalId }, () =>
      withPayerBinding(binding, next),
    );
  };
}
