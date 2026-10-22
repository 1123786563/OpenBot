/*
 * Personal-key isolation (Bifrost 09.3, #288): the contract that an external personal key —
 * a short-lived gateway virtual key minted from a personal model-access grant (04.5) through
 * the CredentialBundle (05.4) — can reach model calls and ONLY model calls on its own
 * personal account. Company content (sessions, knowledge bases, team resources) and company
 * tools live behind server-issued trusted scopes; a key credential is not a session, so the
 * company surfaces are structurally unreachable, and every door a personal key CAN reach
 * resolves the payment account server-side from the grant and refuses a self-reported one.
 *
 * This module is 09.3's own two artifacts:
 *
 * - COMPANY_SCOPE_IDENTITY_FIELDS: the parameter names that name a COMPANY scope. Their
 *   presence in a personal-key protocol request (Reserve / Status / Settle / Release) is a
 *   scope-elevation attempt, refused at the shape boundary exactly like the account-identity
 *   fields of 06.4 — presence is the attempt, whatever the value spells. The four protocol
 *   doors import this list into their closed vocabularies (credit-reserve.ts and
 *   reservation-status.ts own the two exported tables; Settle and Release reuse Reserve's).
 *
 * - PERSONAL_KEY_ENTRYPOINTS: the rejection-path list (AC: "拒绝路径清单，供 22.1 全入口核
 *   查引用") — every entrypoint a personal key identity can reach, each with the mechanism
 *   that keeps company scope out and the refusal it answers with. The registry is pinned to
 *   real code anchors by personal-key-isolation.test.ts, so a seam that moves without its
 *   entry breaks the test rather than silently orphaning an entrypoint 22.1 would then miss.
 *
 * The refusals never leak existence: every code below answers with a fixed sentence and a
 * stable reason code, byte-identical whether the named company, workspace or grant exists
 * (the tenancy doors' own discipline — a missing, suspended and foreign scope are
 * indistinguishable; a grant_invalid never says whose grant a grantId was).
 */

/**
 * The request parameter names that name a company scope (09.3). `workspaceId` and `teamId`
 * are the team-scope selectors the company workbench's trusted middleware reads — on the
 * personal-key protocol they would be a caller trying to select its way into company
 * attribution. `orgId`/`organizationId` spell the same intent in the other common casings;
 * matching is case-insensitive at the doors (as 06.4's own list is), so `WORKSPACEID` and
 * `WorkspaceId` ride the same refusal.
 */
export const COMPANY_SCOPE_IDENTITY_FIELDS = [
  "workspaceId",
  "teamId",
  "orgId",
  "organizationId",
] as const;

/** One entrypoint on the personal-key reachable surface, as 22.1's audit consumes it. */
export interface PersonalKeyEntrypoint {
  /** The entrypoint's stable id in this registry. */
  readonly id: string;
  /** What surface this is, in one line. */
  readonly surface: string;
  /**
   * The code anchor the entrypoint's enforcement lives in (a module path, optionally with a
   * symbol). 22.1 verifies entrances against code, not titles; so does this registry's test.
   */
  readonly anchor: string;
  /** How company scope stays out: the one mechanism this entrypoint relies on. */
  readonly companyScopeMechanism:
    | "payer-resolved-server-side"
    | "server-issued-scope-only"
    | "session-identity-only"
    | "no-company-surface";
  /** The refusal(s) an elevation attempt on this entrypoint answers with. */
  readonly refusals: readonly {
    readonly code: string;
    readonly httpStatus: number;
    /**
     * Where the code string itself is defined, when that is not the anchor module — a
     * route answers an error class's code without restating it (the 403's code lives in
     * the grant service's error class; the read routes answer the cross-account error's
     * message). The registry's test checks the code where it is actually written.
     */
    readonly codeAnchor?: string;
  }[];
}

/**
 * The complete list of entrypoints a personal key identity can reach (09.3's Produces). The
 * billing protocol doors are where the key's calls become money; the key lifecycle doors are
 * where the key itself lives; the company content surfaces are listed with the mechanism
 * that keeps them session-scoped so 22.1's enumeration finds them accounted for here rather
 * than unmentioned.
 */
export const PERSONAL_KEY_ENTRYPOINTS: readonly PersonalKeyEntrypoint[] = [
  {
    id: "credit-protocol.reserve",
    surface:
      "The gateway's Reserve door: a personal-key model call's pre-dispatch hold (06.2).",
    anchor: "server/src/billing/credit-reserve.ts (reserveCreditInTransaction)",
    companyScopeMechanism: "payer-resolved-server-side",
    refusals: [
      { code: "payer_conflict", httpStatus: 422 },
      { code: "grant_invalid", httpStatus: 422 },
    ],
  },
  {
    id: "credit-protocol.status",
    surface:
      "The gateway's Status door: the lost-answer recovery query for a hold (06.7).",
    anchor: "server/src/billing/reservation-status.ts",
    companyScopeMechanism: "payer-resolved-server-side",
    refusals: [
      { code: "payer_conflict", httpStatus: 422 },
      { code: "request_invalid", httpStatus: 422 },
    ],
  },
  {
    id: "credit-protocol.settle",
    surface:
      "The gateway's Settle door: a personal-key call's terminal actual-cost settlement (06.9).",
    anchor: "server/src/billing/credit-settle.ts",
    companyScopeMechanism: "payer-resolved-server-side",
    refusals: [
      { code: "payer_conflict", httpStatus: 422 },
      { code: "settlement_conflict", httpStatus: 422 },
    ],
  },
  {
    id: "credit-protocol.release",
    surface:
      "The gateway's Release door: returning capacity a personal-key call never used (06.9).",
    anchor: "server/src/billing/credit-release.ts",
    companyScopeMechanism: "payer-resolved-server-side",
    refusals: [{ code: "payer_conflict", httpStatus: 422 }],
  },
  {
    id: "bot-service.keys.claim",
    surface:
      "The Bot-facing key claim door: where a Bot server presents its own credential for a grant's virtual key (05.3).",
    anchor: "server/src/gateway/key-issuance.ts (createKeyIssuanceRoutes)",
    companyScopeMechanism: "session-identity-only",
    refusals: [
      {
        code: "model_access_grant_refused",
        httpStatus: 403,
        codeAnchor: "server/src/bot-services/access-grants.ts",
      },
      {
        code: "bot_service_auth_failed",
        httpStatus: 401,
        codeAnchor: "server/src/bot-services/auth.ts",
      },
    ],
  },
  {
    id: "bot-service.keys.renew",
    surface:
      "The Bot-facing key renewal door (05.6), the same service guard as the claim.",
    anchor: "server/src/gateway/key-issuance.ts (createKeyIssuanceRoutes)",
    companyScopeMechanism: "session-identity-only",
    refusals: [
      {
        code: "model_access_grant_refused",
        httpStatus: 403,
        codeAnchor: "server/src/bot-services/access-grants.ts",
      },
      {
        code: "bot_service_auth_failed",
        httpStatus: 401,
        codeAnchor: "server/src/bot-services/auth.ts",
      },
    ],
  },
  {
    id: "gateway.customer.provision",
    surface:
      "The gateway Customer provisioning seam (05.1): only a personal subject ever maps to a gateway Customer.",
    anchor: "server/src/gateway/customer.ts",
    companyScopeMechanism: "no-company-surface",
    refusals: [],
  },
  {
    id: "enterprise.company-content",
    surface:
      "Company sessions, knowledge bases and team resources: every read runs inside a trusted PlatformScope revalidated per transaction (MT005).",
    anchor: "server/src/enterprise/tenancy/store.ts (createScopeResolver)",
    companyScopeMechanism: "server-issued-scope-only",
    refusals: [
      { code: "AUTH_REQUIRED", httpStatus: 401 },
      { code: "TENANT_FORBIDDEN", httpStatus: 403 },
      { code: "WORKSPACE_FORBIDDEN", httpStatus: 403 },
    ],
  },
  {
    id: "billing.personal-reads",
    surface:
      "The person-facing credit reads (02.6): the account is the session's own, and a request naming any account or company identity is refused before any read.",
    anchor: "server/src/billing/routes.ts (createBillingCreditRoutes)",
    companyScopeMechanism: "session-identity-only",
    refusals: [
      {
        code: "payer_cross_account_denied",
        httpStatus: 400,
        codeAnchor: "server/src/billing/payer-personal.ts",
      },
    ],
  },
];

/** The entrypoint registry entry with this id, or null — the lookup 22.1's consumers use. */
export function personalKeyEntrypoint(
  id: string,
): PersonalKeyEntrypoint | null {
  return PERSONAL_KEY_ENTRYPOINTS.find((entry) => entry.id === id) ?? null;
}

/**
 * The company-scope identity field present in a request's own spelling, or null (09.3's
 * boundary check for the protocol doors, mirroring 06.4's account-identity finder so the
 * two refusals share one shape at every door).
 */
export function findCompanyScopeIdentityField(
  source: Record<string, unknown>,
): string | null {
  const companyScope = new Set(
    COMPANY_SCOPE_IDENTITY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(source)) {
    if (companyScope.has(key.toLowerCase())) return key;
  }
  return null;
}
