import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseBotOwnership } from "../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../db/schema/enterprise-tenancy";

/*
 * FIX-F1 (#376, FR-1): the company the old personal-memory face works for.
 *
 * The route face (`/api/memory`) gets its company per request: a trusted, server-issued
 * `PlatformScope` (the enterprise resolver + `resolveHindsightBankScope`, the same seam
 * `/api/memory/pause-controls` uses). The Bot face (`memoryTools`, the personal-memory
 * injection) has no request to resolve — its identity is the (person, Bot) pair the run
 * was built for — so THIS module answers the same question from durable server state
 * alone, never from anything the model or the wire sent:
 *
 *   1. A Bot with an active `enterprise_bot_ownership` row belongs to that company, and
 *      only to it: an ownership row is globally unique per Bot, so a company-B Bot's runs
 *      can never be answered with company-A memories — not even when the person asking
 *      holds a provable attribution in company A. There is deliberately NO fallback away
 *      from an ownership row: falling back to the person's own company is exactly the
 *      cross-company leak this module exists to close.
 *   2. A personal Bot (no ownership row) carries no company of its own, so the person's
 *      attribution must be provable on its own: exactly one ACTIVE membership names the
 *      company, the same rule `hindsight/legacy-migration.ts` uses to backfill migration
 *      0211 — zero active memberships, no principal, or memberships in several companies
 *      answer "none", because a global user id never names a company and ambiguity is
 *      never resolved by picking the first one.
 *
 * "None" is a fail-closed answer: the caller refuses the memory work rather than reading
 * or writing rows unattributed. A single-user deployment without the enterprise layer
 * never calls this — its wiring passes no company through, and the old face keeps the
 * global-owner behaviour it always had.
 */

/** One proven company, the memory face's read/write pin for this call. */
export type MemoryCompany = { tenantId: string };

/** The company of one Bot's memory work, or undefined when none can be proven. */
export async function resolveMemoryCompany(
  database: Database,
  input: { ownerUserId: string; agentId?: string },
): Promise<MemoryCompany | undefined> {
  if (input.agentId !== undefined) {
    const [ownership] = await database
      .select({ tenantId: enterpriseBotOwnership.tenantId })
      .from(enterpriseBotOwnership)
      .where(
        and(
          eq(enterpriseBotOwnership.agentId, input.agentId),
          eq(enterpriseBotOwnership.status, "active"),
        ),
      )
      .limit(1);
    if (ownership) {
      // The person must still be an active member of the Bot's company — the same
      // live-membership discipline the request face's scope resolution enforces.
      const member = await database
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships)
        .innerJoin(
          enterprisePrincipals,
          eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
        )
        .where(
          and(
            eq(enterprisePrincipals.userId, input.ownerUserId),
            eq(enterpriseMemberships.tenantId, ownership.tenantId),
            eq(enterpriseMemberships.status, "active"),
          ),
        )
        .limit(1);
      // A Bot of a company the person no longer belongs to: unresolved, never their own.
      return member ? { tenantId: ownership.tenantId } : undefined;
    }
  }
  // A personal Bot: the person's own provable attribution — exactly one active
  // membership. The queries are legacy-migration.ts `attributionOf`'s own shape, so
  // the runtime answer and the migration's backfill can never disagree.
  const memberships = await database
    .select({ tenantId: enterpriseMemberships.tenantId })
    .from(enterpriseMemberships)
    .innerJoin(
      enterprisePrincipals,
      eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
    )
    .where(
      and(
        eq(enterprisePrincipals.userId, input.ownerUserId),
        eq(enterpriseMemberships.status, "active"),
      ),
    );
  if (memberships.length === 1) return { tenantId: memberships[0].tenantId };
  return undefined;
}
