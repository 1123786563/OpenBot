/**
 * Server-internal enterprise contracts, per plan 02 §4.2.
 *
 * The planned surface lives here precisely so shared/web code cannot import it by accident: Scope
 * is a process-internal trust object, Directory is the only membership source, Authz and
 * ResourceReader are the read path. Nothing in this file is a public DTO — those are
 * `shared/enterprise/contracts.ts`.
 *
 * The TypeScript `Readonly` on Scope is NOT the trust boundary: T2-A keeps the set of genuinely
 * issued scopes in a module-private WeakSet (`tenancy/scope.ts`), and T2-B re-checks the database
 * epoch inside every real transaction, so a copied or deserialized scope fails closed twice.
 */

import type {
  ResourceView,
  TenantRole,
} from "../../../shared/enterprise/contracts";

/*
 * The transaction handle every enterprise read/write runs on: the Bun SQL transaction client —
 * the very driver drizzle's bun-sql adapter wraps (`db.transaction` runs `client.begin`
 * underneath), so no second driver is introduced. Chosen over the drizzle transaction type
 * because statement texts must stay module constants with `$n` placeholders (values only ever
 * travel as parameters), which the raw client expresses directly.
 */
export type { TxClient as Tx } from "./tenancy/transaction";

/** One directory fact: the full user → principal → membership → tenant chain, statuses included. */
export type Membership = {
  tenantId: string;
  principalId: string;
  tenantName: string;
  role: TenantRole;
  epoch: number;
  tenantStatus: "active" | "suspended";
  principalStatus: "active" | "suspended";
  memberStatus: "active" | "suspended";
};

export interface Directory {
  listForUser(userId: string): Promise<Membership[]>;
}

export type Scope = Readonly<{
  tenantId: string;
  principalId: string;
  userId: string;
  role: TenantRole;
  epoch: number;
}>;

export type ResourceSnapshot = {
  id: string;
  tenantId: string;
  workspaceId: string;
  kind: string;
  revision: number;
  aclEpoch: number;
  policyRevision: string;
  active: boolean;
  locallyAllowed: boolean;
};

export type AuthorizationInput = {
  scope: Scope;
  resource: ResourceSnapshot;
  action: "read";
};

export interface Authz {
  check(input: AuthorizationInput): Promise<boolean>;
}

export interface ResourceReader {
  readAuthorizedResource(
    scope: Scope,
    resourceId: string,
  ): Promise<ResourceView>;
}
