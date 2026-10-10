/**
 * Public enterprise DTOs, per plan 02 §4.1.
 *
 * Only shapes an unauthenticated or tenant-member caller may see: no Scope, no credentials, no
 * authorization-engine configuration. The server-internal contracts (Scope, Directory, Authz) live
 * in `server/src/enterprise/contracts.ts` precisely so they cannot be imported by accident from
 * shared code.
 */

/*
 * The tenant-scoped key, per plan 02 §6 T2-D.
 *
 * Pure JSON encoding of the ordered triple — no Node Buffer, no per-segment separators — so every
 * runtime that can run JavaScript (server, web, desktop) derives the identical string. Because JSON
 * quotes and escapes each element, no value of any segment, separators included, can make two
 * different triples collide on one key. Server adapters that need an object path or cache key may
 * base64url the WHOLE string; they must not invent a different joining rule per segment.
 *
 * The key locates, it never authorizes: whatever it addresses still goes through the scoped read
 * path (plan 02 T2-B/T2-C) before any candidate reaches a user.
 */
export function scopedKey(tenantId: string, kind: string, id: string): string {
  return JSON.stringify([tenantId, kind, id]);
}

import type { TenantRole, TenantSummary } from "./mobile-schemas";
export type { TenantRole, TenantSummary };

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
