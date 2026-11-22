import {
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { client, tryClient } from "@/lib/client";

export type CorsairProvider = "github" | "slack";

const connection = z.object({
  id: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
});
const accountList = z.object({ defaultConnectionId: z.uuid().nullable() });
const githubList = accountList.extend({
  connections: z.array(
    connection.extend({
      login: z.string(),
      githubUserId: z.string(),
    }),
  ),
});
const slackList = accountList.extend({
  teamId: z.string(),
  connections: z.array(
    connection.extend({
      label: z.string(),
      userId: z.string(),
      subjectScope: z.string(),
      verificationRequiredAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});
const revocations = z.object({
  connections: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      revocation: z.object({ status: z.enum(["pending", "revoked"]) }),
    }),
  ),
});

export type CorsairAccount = {
  id: string;
  label: string;
  identity: string;
  needsAuthorization: boolean;
};

export const corsairKeys = {
  accounts: (provider: CorsairProvider) =>
    ["corsair", provider, "accounts"] as const,
  revocations: (provider: CorsairProvider) =>
    ["corsair", provider, "revocations"] as const,
  integrations: ["corsair", "integrations"] as const,
};

/*
 * One entry per app the Corsair catalog offers. The server skips credential checks by design, so
 * every field a person reads here is a fact about the catalog, never about an account they hold.
 */
const corsairIntegration = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  npmPackageName: z.string(),
  authTypes: z.array(z.string()),
  defaultAuthType: z.string().nullable(),
  counts: z.object({ api: z.number(), webhooks: z.number(), db: z.number() }),
  icon: z.string().nullable(),
  credentialConfigured: z.boolean(),
  oauthClientConfigured: z.boolean(),
  validationSkipped: z.boolean(),
  connected: z.boolean(),
});

export type CorsairIntegration = z.infer<typeof corsairIntegration>;

/** Where the app's own mark lives, vendored with the catalog. Null means it never had one. */
export function corsairIntegrationIconUrl(app: Pick<CorsairIntegration, "id" | "icon">) {
  return app.icon ? `/corsair-icons/${app.id}.${app.icon}` : null;
}

export function corsairIntegrationsQueryOptions() {
  return queryOptions({
    queryKey: corsairKeys.integrations,
    queryFn: async ({
      signal,
    }): Promise<CorsairIntegration[] | null> => {
      // A 404 is a server from before the catalog existed, not a failure to read it.
      const response = await tryClient("/api/corsair/integrations", { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't load the app directory.");
      const data: unknown = await response.json();
      return z.object({ integrations: z.array(corsairIntegration) }).parse(data)
        .integrations;
    },
  });
}

export function corsairAccountsQueryOptions(provider: CorsairProvider) {
  return queryOptions({
    queryKey: corsairKeys.accounts(provider),
    queryFn: async ({
      signal,
    }): Promise<{
      accounts: CorsairAccount[];
      defaultConnectionId: string | null;
    } | null> => {
      const response = await tryClient(`/api/corsair/${provider}/connections`, {
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't load your tool accounts.");
      const data: unknown = await response.json();
      if (provider === "github") {
        const { connections, defaultConnectionId } = githubList.parse(data);
        return {
          defaultConnectionId,
          accounts: connections.map((row) => ({
            id: row.id,
            label: row.login,
            identity: `GitHub user ${row.githubUserId}`,
            needsAuthorization: Date.parse(row.expiresAt) <= Date.now(),
          })),
        };
      }

      const { connections, defaultConnectionId, teamId } =
        slackList.parse(data);
      return {
        defaultConnectionId,
        accounts: connections.map((row) => ({
          id: row.id,
          label: row.label,
          identity: `Workspace ${teamId} · User ${row.userId}${
            row.subjectScope === teamId
              ? ""
              : ` · Enterprise ${row.subjectScope}`
          }`,
          // An expired Slack access token can be refreshed by the server.
          needsAuthorization: row.verificationRequiredAt !== null,
        })),
      };
    },
  });
}

export function corsairRevocationsQueryOptions(provider: CorsairProvider) {
  return queryOptions({
    queryKey: corsairKeys.revocations(provider),
    queryFn: async ({ signal }) => {
      const response = await client(
        `/api/corsair/${provider}/connections/revocations`,
        {
          signal,
          fallback: "Couldn't load revocation status.",
        },
      );
      return revocations.parse(await response.json()).connections;
    },
  });
}

export function corsairWrite(
  provider: CorsairProvider,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
) {
  return client(`/api/corsair/${provider}/${path}`, {
    method,
    body,
    headers: { "X-OpenBot-Pilot": provider },
  });
}

const INTEGRATIONS_FALLBACK = "Couldn't connect that app.";

/** Records an app-level connection from the directory. No credentials change hands yet. */
export function connectCorsairIntegrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (integrationId: string): Promise<void> =>
      client(`/api/corsair/integrations/${integrationId}/connect`, {
        method: "POST",
        headers: { "X-OpenBot-Pilot": "integrations" },
        fallback: INTEGRATIONS_FALLBACK,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: corsairKeys.integrations }),
  });
}
