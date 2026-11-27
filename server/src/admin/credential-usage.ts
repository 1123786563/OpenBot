import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, credentials, users } from "../db/schema/core";
import { identityLinks } from "../db/schema/identity";
import {
  mcpServers,
  mcpUserCredentials,
  pluginGrants,
} from "../db/schema/plugins";
import {
  responsibilities,
  responsibilitySourceBindings,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
import { PROVIDERS } from "../identity/providers";

/**
 * What points at a credential in the vault, read before an administrator revokes it.
 *
 * Every pointer to a vault row is a column somewhere, and none of them were listed anywhere: the
 * confirmation said "any apps or models using it may stop working", which was a guess. This answers
 * it from the rows, so a credential nothing uses reads as such and one every Bot leans on says so.
 */

export type CredentialUsage = {
  /** What holds the credential, in words: an app, a person's own connection or link. */
  features: string[];
  /** The Bots that hold it: a key of their own, or a grant on an app whose credential it is. */
  bots: { id: string; name: string }[];
};

export type CredentialUsageReader = {
  /** Null when no live or revoked vault row has that id. */
  usage: (credentialId: string) => Promise<CredentialUsage | null>;
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** How a goal's event sources read on screen, as the Goals page names them. */
const SOURCES: Record<string, string> = {
  webhook: "Webhook",
  github: "GitHub",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
};
const words = (stored: string) => SOURCES[stored] ?? stored;

export function createCredentialUsageReader(
  database: Database,
  /**
   * The key every Bot's run is made with: the deployment's model provider and the key ID the tenant
   * package names. It is not a column anywhere, so it is the one pointer passed in.
   */
  modelKey: { provider: string; keyId: string },
): CredentialUsageReader {
  return {
    usage: async (credentialId) => {
      const features: string[] = [];
      const bots = new Map<string, string>();
      const [credential] = await database
        .select({
          kind: credentials.kind,
          provider: credentials.provider,
          keyId: credentials.keyId,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, credentialId))
        .limit(1);
      if (!credential) return null;

      // The model key is whichever live row holds the deployment's provider and key ID, so the row a
      // rotation replaced no longer counts.
      if (
        credential &&
        !credential.revokedAt &&
        credential.kind === "model" &&
        credential.provider === modelKey.provider &&
        credential.keyId === modelKey.keyId
      ) {
        features.push("Model access for every Bot");
      }

      // An app's own credential: a token for its MCP server, or the OAuth client a consent needs.
      const servers = await database
        .select({ id: mcpServers.id, title: mcpServers.title })
        .from(mcpServers)
        .where(eq(mcpServers.credentialId, credentialId));
      for (const server of servers) {
        features.push(`${server.title} app`);
        const holders = await database
          .select({ id: agents.id, name: agents.name })
          .from(pluginGrants)
          .innerJoin(agents, eq(agents.id, pluginGrants.agentId))
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              // A grant's ref is `<serverId>/<toolName>`; the server id is exact up to the slash.
              sql`split_part(${pluginGrants.ref}, '/', 1) = ${server.id}`,
            ),
          );
        for (const holder of holders) bots.set(holder.id, holder.name);
      }

      // A Bot's own key, kept in its configuration by `storeAgentAuth`.
      const keyed = await database
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          sql`${agents.configuration}->'auth'->>'credentialId' = ${credentialId}`,
        );
      for (const bot of keyed) bots.set(bot.id, bot.name);

      // A person's own connection to an app.
      const tokens = await database
        .select({ title: mcpServers.title, email: users.email })
        .from(mcpUserCredentials)
        .innerJoin(mcpServers, eq(mcpServers.id, mcpUserCredentials.serverId))
        .innerJoin(users, eq(users.id, mcpUserCredentials.userId))
        .where(eq(mcpUserCredentials.credentialId, credentialId));
      for (const token of tokens)
        features.push(`${token.title} for ${token.email}`);

      // A linked outside account. Its person may since have been deleted, so the name is optional.
      const links = await database
        .select({ provider: identityLinks.provider, email: users.email })
        .from(identityLinks)
        .leftJoin(users, eq(users.id, identityLinks.userId))
        .where(eq(identityLinks.credentialId, credentialId));
      for (const link of links) {
        const account =
          PROVIDERS[link.provider as keyof typeof PROVIDERS]?.title ??
          link.provider;
        features.push(
          link.email ? `${account} link for ${link.email}` : `${account} link`,
        );
      }

      // A goal's events from a repository, and the trigger that starts it.
      const bindings = await database
        .select({
          source: responsibilitySourceBindings.source,
          repository: responsibilitySourceBindings.repository,
        })
        .from(responsibilitySourceBindings)
        .where(eq(responsibilitySourceBindings.credentialId, credentialId));
      for (const binding of bindings)
        features.push(
          `${words(binding.source)} events from ${binding.repository}`,
        );
      const triggers = await database
        .select({
          kind: responsibilityTriggers.kind,
          goal: responsibilities.title,
        })
        .from(responsibilityTriggers)
        .innerJoin(
          responsibilities,
          eq(responsibilities.id, responsibilityTriggers.responsibilityId),
        )
        .where(eq(responsibilityTriggers.credentialId, credentialId));
      for (const trigger of triggers)
        features.push(`${words(trigger.kind)} trigger for ${trigger.goal}`);

      return {
        features: features.sort(),
        bots: [...bots].map(([id, name]) => ({ id, name })).sort(byName),
      };
    },
  };
}
