/**
 * The identity providers this deployment has registered, as facts about the deployment.
 *
 * Better Auth's SSO plugin owns the table and the registration route, and both are right: parsing a
 * company's OIDC discovery document or SAML metadata is work worth not repeating. What it also does
 * is stamp the registering person's id on the row and then answer `GET /sso/providers` with
 * `providers.filter(p => p.userId === session.user.id)`, and refuse a delete unless the same person
 * asks. That is the correct model for a personal integration and the wrong one for this: a company's
 * Okta tenant is not the property of whichever administrator happened to paste the metadata in.
 *
 * Two things went wrong from it. A second administrator opening the Identity providers screen saw an
 * empty list and re-registered a provider that was already there, and the person who set it up
 * leaving the company took the company's sign-in with them, because the row cascaded from their user
 * row. So reads and removals come through here, against the whole table, and the column that used to
 * decide existence is now only a record of who registered it.
 *
 * Registration still goes to Better Auth. This never writes a provider, so there is one parser for
 * metadata and one place a client secret is stored.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, revokedAccess, ssoProviders, users } from "../db/schema";
import { isConfiguredAdmin } from "./roles";

/**
 * A registered provider, as an administrator screen may see it.
 *
 * Deliberately not the row. `oidcConfig` and `samlConfig` carry a client secret and a signing
 * certificate, and no projection that includes them can be safe to send to a browser, so the shape
 * that leaves this module cannot express them.
 */
export type RegisteredIdentityProvider = {
  providerId: string;
  issuer: string;
  /** The email domain that routes somebody here. */
  domain: string;
  /** Which protocol it speaks. SAML is what most enterprise identity teams hand over. */
  protocol: "saml" | "oidc";
  /** Whether the person who registered it still has an account here. Null once they are gone. */
  registeredBy: string | null;
};

export type IdentityProviderStore = {
  /** Every provider this deployment holds, whoever registered it. */
  list: () => Promise<RegisteredIdentityProvider[]>;
  /**
   * Forget one. Answers whether there was one to forget, so a caller can tell a stale screen from a
   * failure rather than reporting both as success.
   */
  remove: (providerId: string) => Promise<boolean>;
  /**
   * Who signs in through a provider, split into the people it is the only way in for and the people
   * who keep another one. Null when no provider of that name is registered.
   */
  impact: (providerId: string) => Promise<IdentityProviderImpact | null>;
};

export type IdentityProviderImpact = {
  /** The people whose only account is this provider, by email. */
  losing: { userId: string; email: string }[];
  /**
   * The people who keep a way in once this provider is gone, by email: through another account, or
   * because their address is one the configuration names as an emergency admin.
   */
  keeping: {
    userId: string;
    email: string;
    reason: "another-sign-in" | "emergency-admin";
  }[];
};

/**
 * `initialAdminEmails` is the emergency list, which lets an address in it sign in another way after
 * the provider it used is gone.
 */
export function createIdentityProviderStore(
  database: Database,
  initialAdminEmails: readonly string[] = [],
): IdentityProviderStore {
  return {
    list: async () => {
      const rows = await database
        .select({
          providerId: ssoProviders.providerId,
          issuer: ssoProviders.issuer,
          domain: ssoProviders.domain,
          samlConfig: ssoProviders.samlConfig,
          userId: ssoProviders.userId,
        })
        .from(ssoProviders)
        .orderBy(ssoProviders.domain);

      return rows.map((row) => ({
        providerId: row.providerId,
        issuer: row.issuer,
        domain: row.domain,
        // A row carries one config or the other, and which one is the protocol.
        protocol: row.samlConfig ? "saml" : "oidc",
        registeredBy: row.userId,
      }));
    },

    remove: async (providerId) => {
      const removed = await database
        .delete(ssoProviders)
        .where(eq(ssoProviders.providerId, providerId))
        .returning({ providerId: ssoProviders.providerId });

      return removed.length > 0;
    },

    impact: async (providerId) => {
      const [registered] = await database
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, providerId))
        .limit(1);
      if (!registered) return null;

      // One row per person who has an account here, with every provider they sign in through.
      const rows = await database
        .select({
          userId: users.id,
          email: users.email,
          providers: sql<string[]>`array_agg(distinct ${accounts.providerId})`,
          removed: sql<boolean>`bool_or(${revokedAccess.email} is not null)`,
        })
        .from(users)
        .innerJoin(accounts, eq(accounts.userId, users.id))
        .leftJoin(
          revokedAccess,
          eq(revokedAccess.email, sql`lower(${users.email})`),
        )
        .where(
          inArray(
            users.id,
            database
              .select({ userId: accounts.userId })
              .from(accounts)
              .where(eq(accounts.providerId, providerId)),
          ),
        )
        .groupBy(users.id);

      const impact: IdentityProviderImpact = { losing: [], keeping: [] };
      for (const { userId, email, providers, removed } of rows) {
        // Somebody removed has no way in to lose.
        if (removed) continue;
        if (providers.length > 1)
          impact.keeping.push({ userId, email, reason: "another-sign-in" });
        else if (isConfiguredAdmin(email, initialAdminEmails))
          impact.keeping.push({ userId, email, reason: "emergency-admin" });
        else impact.losing.push({ userId, email });
      }
      const byEmail = (a: { email: string }, b: { email: string }) =>
        a.email < b.email ? -1 : 1;
      impact.losing.sort(byEmail);
      impact.keeping.sort(byEmail);
      return impact;
    },
  };
}
