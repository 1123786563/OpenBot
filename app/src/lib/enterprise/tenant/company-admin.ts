import {
  type QueryClient,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/*
 * The company admin area's reads and writes (MT095/MT096/MT097, Issues #138-#140): people,
 * identity providers, credentials, audit, enterprise config, learning, and the company books —
 * every one of them behind the server's own capability or authorization answer.
 *
 * WHERE THE CAPABILITY DECISION LIVES. Not here: the frontend does not copy role judgment
 * (ticket note). `companyCapabilitiesQueryOptions` asks the server what this member may manage in
 * the selected company, entries render from that answer, and each data route refuses on its own —
 * a 403 arrives as the ONE typed refusal its surface renders (AC1), never as a role recomputed in
 * the browser. The company books' gate is the finance reader grant (MT073), not adminness; the
 * audit face's gate is the MT078 domain matrix; both answer 403 with their own sentinel codes.
 *
 * THE SAME SEAM EVERY SCOPED SURFACE RIDES (MT083). Keys compose onto the scope's own prefix, so
 * a switch drops the old scope's company answers wholesale; reads carry the selection pair and
 * pass the generation guard; writes carry the pair and invalidate this scope's subtree. A member
 * with no capability at all still gets a well-formed answer (all-false capabilities, or the typed
 * refusal from the gated read) — invisible semantics, not a crash and not a redirect home.
 */

// ---------------------------------------------------------------------------
// The server's answers, mirrored exactly
// ---------------------------------------------------------------------------

/** The capability bits the server derived from its own facts (company-capabilities.ts). */
export type CompanyCapabilities = {
  tenantId: string;
  principalId: string;
  peopleAdmin: boolean;
  auditReader: boolean;
  financeReader: boolean;
  billingManager: boolean;
};

/** One roster row (people-lifecycle's CompanyMemberRow; dates as ISO-8601 over the wire). */
export type CompanyMember = {
  principalId: string;
  userId: string;
  role: "tenant_admin" | "member" | "auditor";
  status: "active" | "suspended";
  epoch: number;
  joinedAt: string;
};

/** The masked credential roster (RedactedCredentialView — no envelope/plaintext fields exist). */
export type CompanyCredential = {
  credentialId: string;
  tenantId: string;
  kind: "connection" | "site-login";
  classification: "personal" | "team" | "company";
  workspaceId: string | null;
  target: string;
  label: string;
  status: "active";
  effectiveActions: { use: boolean; disclose: boolean };
  createdAt: string;
};

/** The company's identity facts: its own SSO reference document, or an honest null. */
export type CompanyIdentity = {
  sso: {
    protocol: "oidc" | "saml";
    issuer: string;
    domain: string;
    credentialRef: string;
    revision: number;
  } | null;
  scimBindings: ReadonlyArray<{
    bindingId: string;
    connectionKey: string;
    status: "active" | "deactivated";
  }>;
};

/** The company config projection (company-config.ts). */
export type CompanyConfig = {
  tenantId: string;
  name: string;
  status: "active" | "suspended";
  teams: ReadonlyArray<{ workspaceId: string; name: string }>;
  membersByRole: ReadonlyArray<{
    role: "tenant_admin" | "member" | "auditor";
    count: number;
  }>;
  offboardedCount: number;
};

/** One learning record of the selected scope (other scopes answer empty, not leaked). */
export type CompanyLearningRecord = {
  recordId: string;
  kind: "research" | "demonstration";
  title: string;
  containerId: string;
};

/** One business-domain audit event (already masked at write and again at export). */
export type CompanyAuditEvent = {
  id: string;
  domain: "business" | "identity" | "platform";
  eventType: string;
  actorId: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** The company usage evidence line (usage_outbox read-only projection). */
export type CompanyUsageLine = {
  eventId: string;
  source: "llm" | "code_run";
  model: string;
  workspaceId: string | null;
  inputTokens: number;
  outputTokens: number;
  reservationId: string | null;
  occurredAt: string;
};

/** The company books (MT073's CompanyBooks) plus the recent usage lines that evidence them. */
export type CompanyBooksAnswer = {
  books: {
    tenantId: string;
    authorization: {
      principalId: string;
      grantedBy: string;
      grantedAt: string;
    };
    customer: { externalCustomerId: string; boundAt: string } | null;
    account: {
      externalCustomerId: string;
      status: "active" | "quarantined";
    } | null;
    balanceUnits: number;
    usage: {
      companyTotal: { heldUnits: number; chargedUnits: number };
      byTeam: ReadonlyArray<{
        workspaceId: string;
        heldUnits: number;
        chargedUnits: number;
      }>;
      byUser: ReadonlyArray<{
        principalId: string;
        heldUnits: number;
        chargedUnits: number;
      }>;
    };
  };
  recentUsage: readonly CompanyUsageLine[];
};

// ---------------------------------------------------------------------------
// The typed refusals (one per gate; each surface renders its own, never a sentence)
// ---------------------------------------------------------------------------

/** The people/identity/credentials/config/learning gate refused: this member is not the admin. */
export class CompanyAdminRefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("That company management surface is not open to you.");
    this.name = "CompanyAdminRefusedError";
    this.code = code;
  }
}

/** The audit domain matrix refused (MT078's single sentinel, no reason distinguishable). */
export class AuditScopeForbiddenError extends Error {
  constructor() {
    super("That audit scope is not open to you.");
    this.name = "AuditScopeForbiddenError";
  }
}

/** No company finance read grant (MT073's single sentinel — adminness does not imply it). */
export class CompanyFinanceRequiredError extends Error {
  constructor() {
    super("The company books are not open to you.");
    this.name = "CompanyFinanceRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Keys: the scope's own subtree, like every MT083-bound surface
// ---------------------------------------------------------------------------

const CAPABILITIES = "company-admin-capabilities";
const PEOPLE = "company-admin-people";
const CREDENTIALS = "company-admin-credentials";
const IDENTITY = "company-admin-identity";
const CONFIG = "company-admin-config";
const LEARNING = "company-admin-learning";
const AUDIT = "company-admin-audit";
const BOOKS = "company-admin-books";

export const companyAdminKeys = {
  capabilities: () => [CAPABILITIES] as const,
  people: () => [PEOPLE] as const,
  credentials: () => [CREDENTIALS] as const,
  identity: () => [IDENTITY] as const,
  config: () => [CONFIG] as const,
  learning: () => [LEARNING] as const,
  audit: (eventType?: string) => [AUDIT, { eventType: eventType ?? null }] as const,
  books: () => [BOOKS] as const,
};

/** The refusal shape a gated read maps a 403 onto, branchable per surface. */
function refusalOf(
  response: Response,
  expected: "admin" | "audit" | "finance",
): Error | null {
  if (response.status !== 403) return null;
  if (expected === "audit") return new AuditScopeForbiddenError();
  if (expected === "finance") return new CompanyFinanceRequiredError();
  return new CompanyAdminRefusedError("FORBIDDEN");
}

/**
 * Reads the company admin API the scoped way: pair on the request, generation guard around the
 * fetch, the scope's own prefix on the key, and a pending scope reading nothing.
 */
async function scopedGet<T>(
  queryClient: QueryClient,
  scope: ScopedCache,
  path: string,
  init: {
    fallbackKey: string;
    expect403?: "admin" | "audit" | "finance";
  },
): Promise<T> {
  const open = scope.status === "open" ? scope : null;
  if (open === null) throw new Error("Company data is not readable yet.");
  return guarded(queryClient, open.userId, async () => {
    const response = await tryClient(path, {
      fallbackKey: init.fallbackKey,
      ...(open.selection ?? {}),
    });
    if (!response.ok) {
      const refusal = init.expect403
        ? refusalOf(response, init.expect403)
        : null;
      if (refusal !== null) throw refusal;
      throw new Error("That company surface could not be read.");
    }
    return (await response.json()) as T;
  });
}

/** The options half every factory shares: pending scope disables, open scope prefixes the key. */
function scopedKey(
  scope: ScopedCache,
  key: readonly unknown[],
): { enabled: boolean; queryKey: readonly unknown[] } {
  if (scope.status === "open") {
    return { enabled: true, queryKey: [...scope.prefix, ...key] };
  }
  return { enabled: false, queryKey: [...key, ":scope-pending"] };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * What this member may manage in the selected company (AC1's fact source). The answer is the
 * server's own composition — role, audit matrix, finance grant, billing grant — and the nav and
 * the route gates render it rather than recomputing any part of it.
 */
export function companyCapabilitiesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.capabilities()),
    queryFn: () =>
      scopedGet<CompanyCapabilities>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/capabilities",
        { fallbackKey: "companyAdmin.loadCapabilities" },
      ),
  });
}

/** The company roster, the admin-gated read (a refused member gets the typed refusal). */
export function companyPeopleQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.people()),
    queryFn: () =>
      scopedGet<{ members: CompanyMember[] }>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/people",
        { fallbackKey: "companyAdmin.loadPeople", expect403: "admin" },
      ),
  });
}

/**
 * The masked credential roster. The masked shape is structural (the server's view type has no
 * envelope or plaintext field), and this side adds nothing to it — no re-derivation, no echo.
 */
export function companyCredentialsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.credentials()),
    queryFn: () =>
      scopedGet<{ credentials: CompanyCredential[] }>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/credentials",
        { fallbackKey: "companyAdmin.loadCredentials", expect403: "admin" },
      ),
  });
}

/** The company's identity providers: its SSO reference document (or an honest null) and SCIM bindings. */
export function companyIdentityQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.identity()),
    queryFn: () =>
      scopedGet<CompanyIdentity>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/identity",
        { fallbackKey: "companyAdmin.loadIdentity", expect403: "admin" },
      ),
  });
}

/** The company config projection: own company only; another company's selection refuses. */
export function companyConfigQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.config()),
    queryFn: () =>
      scopedGet<CompanyConfig>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/enterprise-config",
        { fallbackKey: "companyAdmin.loadConfig", expect403: "admin" },
      ),
  });
}

/** The learning records of the selected scope — other scopes' containers never appear in it. */
export function companyLearningQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.learning()),
    queryFn: () =>
      scopedGet<{ records: CompanyLearningRecord[] }>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/learning",
        { fallbackKey: "companyAdmin.loadLearning", expect403: "admin" },
      ),
  });
}

/** The business-domain audit events this company's auditor may read (MT078's gate refuses 403). */
export function companyAuditEventsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  eventType?: string,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.audit(eventType)),
    queryFn: () => {
      const query = eventType
        ? `?eventType=${encodeURIComponent(eventType)}`
        : "";
      return scopedGet<{ events: CompanyAuditEvent[] }>(
        queryClient,
        scope,
        `/api/enterprise/workspace-scope/admin/audit-events${query}`,
        { fallbackKey: "companyAdmin.loadAudit", expect403: "audit" },
      );
    },
  });
}

/**
 * The company books with the usage lines that evidence them: the finance reader's view (team
 * usage, company total, balance) plus the read-only outbox projection — personal direct
 * consumption is structurally absent (the server filters by the company's own customer), so it
 * never appears here no matter what this side asks for.
 */
export function companyBooksQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, companyAdminKeys.books()),
    queryFn: () =>
      scopedGet<CompanyBooksAnswer>(
        queryClient,
        scope,
        "/api/enterprise/workspace-scope/admin/billing/company-books",
        { fallbackKey: "companyAdmin.loadBooks", expect403: "finance" },
      ),
  });
}

// ---------------------------------------------------------------------------
// Writes (people lifecycle) and the audit export
// ---------------------------------------------------------------------------

/** The pair an open scope submits under; a pending scope submits nothing. */
function scopeOptions(scope: ScopedCache) {
  return scope.status === "open" ? (scope.selection ?? {}) : {};
}

function invalidateCompanyPeople(queryClient: QueryClient, scope: ScopedCache) {
  if (scope.status !== "open") return Promise.resolve();
  return queryClient.invalidateQueries({
    queryKey: [...scope.prefix, ...companyAdminKeys.people()],
  });
}

/**
 * Promote a member to tenant_admin (AC3: the action submits under the company scope and the
 * server records its own audit row — this side carries the pair and refreshes the roster).
 */
export function companyPromoteMutationOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (principalId: string) => {
      const response = await tryClient(
        `/api/enterprise/workspace-scope/admin/people/${encodeURIComponent(principalId)}/promote`,
        {
          method: "POST",
          fallbackKey: "companyAdmin.promote",
          ...scopeOptions(scope),
        },
      );
      if (!response.ok) {
        throw refusalOf(response, "admin") ??
          new Error("That member could not be promoted.");
      }
      return (await response.json()) as unknown;
    },
    onSuccess: () => invalidateCompanyPeople(queryClient, scope),
  });
}

/** Demote a tenant_admin to member or auditor (body carries the target role). */
export function companyDemoteMutationOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (input: {
      principalId: string;
      to: "member" | "auditor";
    }) => {
      const response = await tryClient(
        `/api/enterprise/workspace-scope/admin/people/${encodeURIComponent(input.principalId)}/demote`,
        {
          method: "POST",
          body: { to: input.to },
          fallbackKey: "companyAdmin.demote",
          ...scopeOptions(scope),
        },
      );
      if (!response.ok) {
        throw refusalOf(response, "admin") ??
          new Error("That member could not be demoted.");
      }
      return (await response.json()) as unknown;
    },
    onSuccess: () => invalidateCompanyPeople(queryClient, scope),
  });
}

/**
 * Offboard a member (AC3): the company-scoped suspension + grant deletion with its audit row.
 * The roster invalidation is what makes the answer visible without a manual refresh.
 */
export function companyOffboardMutationOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (principalId: string) => {
      const response = await tryClient(
        `/api/enterprise/workspace-scope/admin/people/${encodeURIComponent(principalId)}/offboard`,
        {
          method: "POST",
          fallbackKey: "companyAdmin.offboard",
          ...scopeOptions(scope),
        },
      );
      if (!response.ok) {
        throw refusalOf(response, "admin") ??
          new Error("That member could not be offboarded.");
      }
      return (await response.json()) as unknown;
    },
    onSuccess: () => invalidateCompanyPeople(queryClient, scope),
  });
}

/**
 * The audit export as a fetch, not a link: the pair has to ride the request (a bare link cannot
 * carry headers), the server answers the same masked rows the list shows, and it records its own
 * audit row for the export — the caller receives the CSV text and decides what to do with it.
 */
export async function exportCompanyAuditEvents(
  queryClient: QueryClient,
  scope: ScopedCache,
): Promise<string> {
  const open = scope.status === "open" ? scope : null;
  if (open === null) throw new Error("The export needs an open scope.");
  return guarded(queryClient, open.userId, async () => {
    const response = await tryClient(
      "/api/enterprise/workspace-scope/admin/audit-events/export",
      {
        fallbackKey: "companyAdmin.exportAudit",
        ...(open.selection ?? {}),
      },
    );
    if (!response.ok) {
      throw refusalOf(response, "audit") ??
        new Error("That audit export could not be read.");
    }
    return response.text();
  });
}
