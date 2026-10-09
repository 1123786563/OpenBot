/**
 * Public enterprise DTOs, per plan 02 §4.1.
 *
 * Only shapes an unauthenticated or tenant-member caller may see: no Scope, no credentials, no
 * authorization-engine configuration. The server-internal contracts (Scope, Directory, Authz) live
 * in `server/src/enterprise/contracts.ts` precisely so they cannot be imported by accident from
 * shared code.
 */

export type TenantRole = "tenant_admin" | "member" | "auditor";

export type TenantSummary = { id: string; name: string; role: TenantRole };

export type ScopeView = {
  tenantId: string;
  principalId: string;
  role: TenantRole;
};

export type ResourceView = {
  id: string;
  workspaceId: string;
  kind: string;
  revision: number;
};
