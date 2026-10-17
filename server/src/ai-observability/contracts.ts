/**
 * Observation authorization vocabulary.
 *
 * Errors follow the house convention (server/src/enterprise/errors.ts): the code is the contract
 * and the message is deliberately just the code. Callers classify by `code`, map transport status
 * from `status`, and never parse message text. Anything unrecognized fails closed.
 *
 * There is exactly ONE scope kind. That is not an oversight and not a stub: the parent Spec
 * reserves enterprise tenancy as a seam, and a seam that already has a second variant is a seam
 * somebody has started to guess at. An enterprise caller is refused by `resolveObservationScope`
 * with ENTERPRISE_SCOPE_UNSUPPORTED rather than admitted under a kind this codebase cannot yet
 * authorize.
 */

export type ObservationScopeKind = "workbench";

/**
 * The scope every observation consumer carries explicitly. `key` is what participates in record
 * keys, cursors, caches, exports and jobs, so two scopes with the same botId are still two
 * different key spaces. `epoch` is the ownership generation: a transfer or revocation bumps it,
 * which invalidates every cursor and cache entry minted under the old one.
 */
export type ObservationScope = Readonly<{
  kind: ObservationScopeKind;
  key: string;
  actorId: string;
  botId: string;
  epoch: number;
}>;

/** The caller's answer about this Bot, resolved elsewhere. This module never queries for it. */
export type BotOwnership = "owner" | "admin" | "none";

export type ScopeResolutionInput = {
  actorId: string | undefined;
  botId: string | undefined;
  ownership: BotOwnership;
  /** Ownership generation; bump on transfer or revocation so cached cursors die with it. */
  epoch: number;
  /**
   * Anything an enterprise integration might hand us. Present-and-unresolved is a refusal, not a
   * hint to fall back to the workbench. Deliberately `unknown`: this module must not learn to read
   * a tenant id, a tenant header, or a workspace name out of it.
   */
  enterpriseHint?: unknown;
};

export type ObservationScopeErrorCode =
  | "AUTH_REQUIRED"
  | "BOT_REQUIRED"
  | "OWNERSHIP_REQUIRED"
  | "ENTERPRISE_SCOPE_UNSUPPORTED";

export class ObservationScopeError extends Error {
  constructor(
    public code: ObservationScopeErrorCode,
    public status: 400 | 401 | 403,
  ) {
    super(code);
  }
}

/** Where a scope's records live upstream. A locator is not a permission — see resolveStorageLocator. */
export type ObservationStorageLocator = Readonly<{
  scopeKey: string;
  workspace: string;
  project: string;
}>;

export type EvaluationEligibility = Readonly<
  | { allowed: true; scopeKey: string }
  | { allowed: false; code: ObservationScopeErrorCode }
>;
