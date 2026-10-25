import type { Database } from "../db/client";
import type { PlatformScope } from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";
import { createPayerAccount, type PayerAccount, type PayerRef } from "./payer";

/**
 * The payer resolution module's company branch: a company-workbench request bills the tenant, not
 * the person. The trusted scope — `PlatformScope`, minted only by the enterprise tenancy layer's
 * `createScopeResolver` after the database membership check — is the one input, and `payer-company`
 * turns it into the same PayerRef layer the personal branch (02.4) and the Bot branches (04.5,
 * 05.3) resolve through. Usage attribution keeps riding the scope (workspaceId = team,
 * principalId = user); the payer itself is fixed to the company.
 *
 * The security property is structural, not checked per call: the resolver consumes only the
 * server-issued scope object, so a tenantId or companyId in a request body, query parameter or
 * header cannot participate in the resolution — those channels never reach this function. The
 * complement is the explicit refusal: a scope that is missing, hand-built, or cloned from a
 * trusted one is answered with `CompanyScopeRequiredError`, never with a personal ref, never with
 * the deployment's legacy account, never with silence plus a fallback. (ADR 0004: the payer is
 * fixed by server-side business attribution; an insufficient company balance switches nothing.)
 */

/**
 * A company resolution asked to run without a server-issued trusted scope. The credit paths map
 * the stable `code` at their boundary; `reason` names which refusal fired ("missing" for no scope
 * at all, "untrusted" for an object the tenancy layer did not issue). Programmatic consumers
 * (the Reserve service, 06.1) match on the code, never the message.
 */
export class CompanyScopeRequiredError extends Error {
  readonly code = "company_scope_required";
  readonly reason: "missing" | "untrusted";

  constructor(
    reason: "missing" | "untrusted",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CompanyScopeRequiredError";
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Resolve the one company payer for a trusted company-workbench scope — pure, no database. The
 * scope must be one the tenancy layer issued (`assertTrustedScope`'s issued-object marker);
 * anything else — a forged plain object with a complete PlatformScope shape included, and a
 * spread clone of a real scope too — is refused. The answer carries the scope's tenant id
 * verbatim, so the account key (`openbot-company-<tenantId>`) is as trustworthy as the scope was.
 */
export function resolvePayerForCompanyContext(scope: PlatformScope): PayerRef {
  if (scope === null || scope === undefined) {
    throw new CompanyScopeRequiredError(
      "missing",
      "resolvePayerForCompanyContext needs a server-issued trusted company scope; company billing never falls back to a personal or deployment account.",
    );
  }
  try {
    assertTrustedScope(scope);
  } catch (error) {
    throw new CompanyScopeRequiredError(
      "untrusted",
      "resolvePayerForCompanyContext only accepts a scope issued by the server's tenancy layer; hand-built or cloned scopes are refused, and company billing never falls back to a personal or deployment account.",
      error,
    );
  }
  return { kind: "company", id: scope.tenantId };
}

/**
 * Resolve the company account for a trusted scope, creating it idempotently when the company's
 * first billable moment is now — through the payer layer's race-safe `createPayerAccount`, so
 * concurrent first requests leave exactly one mapping. This is the explicit missing-account rule:
 * the account is born a mapping row and nothing else (no grant, no ledger row, no balance), and
 * nothing is ever opened for the user's personal subject or the deployment instead. The replay
 * answer carries the same account as the first create.
 */
export async function resolveCompanyPayerAccount(
  database: Database,
  scope: PlatformScope,
): Promise<PayerAccount> {
  const { account } = await createPayerAccount(
    database,
    resolvePayerForCompanyContext(scope),
  );
  return account;
}

/**
 * The provision path's company payer (T03.03 / #540): create the mapping a
 * platform `company.provision` command fixed to the company it committed.
 * The request-facing resolver above demands a trusted company scope — a
 * request channel can never name the company billed — and this function is
 * the other, narrower door: its tenant id is the server command's own
 * committed pre-allocation, never a request body, header or query value.
 * It goes through the payer layer's race-safe `createPayerAccount`, so the
 * Customer floor row and the account mapping are exactly one row however
 * many retries converge, and the account is born a mapping row and nothing
 * else (no grant, no ledger row, no balance, no half benefit).
 */
export async function ensureProvisionedCompanyPayerAccount(
  database: Database,
  input: { readonly tenantId: string },
): Promise<PayerAccount> {
  if (typeof input?.tenantId !== "string" || input.tenantId.trim() === "") {
    throw new CompanyScopeRequiredError(
      "missing",
      "ensureProvisionedCompanyPayerAccount needs the committed provision's tenant id; an empty tenant id is refused before any account is touched",
    );
  }
  const { account } = await createPayerAccount(database, {
    kind: "company",
    id: input.tenantId,
  });
  return account;
}
