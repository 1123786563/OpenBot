import { github } from "@corsair-dev/github";
import { createCorsair } from "corsair";
import { z } from "zod";

export const githubId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const githubIdentity = z.object({
  id: githubId,
  login: z.string().min(1),
});
export const githubRepository = z.object({
  id: githubId,
  node_id: z.string().min(1),
  name: z
    .string()
    .regex(/^[\w.-]+$/)
    .refine((name) => name !== "." && name !== ".."),
  owner: z.object({ login: z.string().regex(/^[\w-]+$/) }),
  has_issues: z.literal(true),
  archived: z.literal(false),
});
const issueResult = z.object({
  id: githubId,
  number: githubId,
  htmlUrl: z.url(),
  user: githubIdentity,
});
const tokenResponse = z.object({
  access_token: z.string().startsWith("ghu_"),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(8 * 60 * 60),
});
const installation = z.object({
  id: githubId,
  app_id: githubId,
  suspended_at: z.null(),
  permissions: z.object({ issues: z.literal("write") }),
});

export type GithubPilotRegistration = {
  appId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function createGithubPilotProvider(
  registration: GithubPilotRegistration,
  transport: typeof fetch = fetch,
) {
  const { appId, clientId, clientSecret, redirectUri } = registration;
  async function githubApi<T extends z.ZodType>(
    path: string,
    token: string,
    schema: T,
  ) {
    const response = await transport(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenBot",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("GitHub could not verify access.");
    return schema.parse(await response.json());
  }

  return {
    authorizationUrl({
      state,
      challenge,
    }: {
      state: string;
      challenge: string;
    }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
        allow_signup: "false",
      }).toString();
      return url.toString();
    },
    async exchange({ code, verifier }: { code: string; verifier: string }) {
      const response = await transport(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
            code_verifier: verifier,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("GitHub authorization failed.");
      const token = tokenResponse.parse(await response.json());
      const identity = await githubApi(
        "/user",
        token.access_token,
        githubIdentity,
      );
      return {
        identity,
        token: token.access_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
      };
    },
    identity(token: string) {
      return githubApi("/user", token, githubIdentity);
    },
    async repository({
      token,
      installationId,
      repositoryId,
    }: {
      token: string;
      installationId: number;
      repositoryId: number;
    }) {
      const installations = z.object({ installations: z.array(z.unknown()) });
      const repositories = z.object({ repositories: z.array(z.unknown()) });
      const { installations: rows } = await githubApi(
        "/user/installations?per_page=100",
        token,
        installations,
      );
      const match = rows
        .map((row) => installation.safeParse(row))
        .find(
          (row) =>
            row.success &&
            row.data.id === installationId &&
            String(row.data.app_id) === appId,
        );
      if (!match)
        throw new Error(
          "GitHub App installation access could not be verified.",
        );
      const { repositories: available } = await githubApi(
        `/user/installations/${installationId}/repositories?per_page=100`,
        token,
        repositories,
      );
      const repository = available
        .map((row) => githubRepository.safeParse(row))
        .find((row) => row.success && row.data.id === repositoryId);
      if (!repository?.success)
        throw new Error("GitHub repository access could not be verified.");
      return repository.data;
    },
    async createIssue({
      token,
      repositoryNodeId,
      title,
      body,
    }: {
      token: string;
      repositoryNodeId: string;
      title: string;
      body?: string;
    }) {
      // Corsair asks for the key through keyBuilder. This instance holds one verified user token
      // and exposes only the stable-ID write. The stock REST endpoint follows redirects.
      const plugin = github({ authType: "api_key" });
      const client = createCorsair({
        plugins: [
          {
            id: plugin.id,
            options: plugin.options,
            authConfig: plugin.authConfig,
            refreshOnUnauthorized: false,
            keyBuilder: async (_context, purpose) => {
              if (purpose !== "endpoint")
                throw new Error("GitHub endpoint credential required.");
              return token;
            },
            endpoints: {
              issues: {
                create: async (
                  context: { key: string },
                  input: { repositoryId: string; title: string; body?: string },
                ) => {
                  try {
                    const response = await transport(
                      "https://api.github.com/graphql",
                      {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${context.key}`,
                          "Content-Type": "application/json",
                          "User-Agent": "OpenBot",
                        },
                        body: JSON.stringify({
                          query:
                            "mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { databaseId number url repository { id } author { login ... on User { databaseId } } } } }",
                          variables: { input },
                        }),
                        redirect: "error",
                        signal: AbortSignal.timeout(10_000),
                      },
                    );
                    if (!response.ok)
                      throw new Error(
                        "GitHub issue outcome could not be confirmed.",
                      );
                    const result = z
                      .object({
                        errors: z.never().optional(),
                        data: z.object({
                          createIssue: z.object({
                            issue: z.object({
                              databaseId: githubId,
                              number: githubId,
                              url: z.url(),
                              repository: z.object({
                                id: z.literal(input.repositoryId),
                              }),
                              author: z.object({
                                login: z.string(),
                                databaseId: githubId,
                              }),
                            }),
                          }),
                        }),
                      })
                      .parse(await response.json()).data.createIssue.issue;
                    return {
                      kind: "confirmed" as const,
                      issue: issueResult.parse({
                        id: result.databaseId,
                        number: result.number,
                        htmlUrl: result.url,
                        user: {
                          id: result.author.databaseId,
                          login: result.author.login,
                        },
                      }),
                    };
                  } catch {
                    // Keep uncertain write outcomes out of Corsair's error/retry path.
                    return { kind: "unconfirmed" as const };
                  }
                },
              },
            },
          },
        ],
      });
      const response: unknown = await client.github.api.issues.create({
        repositoryId: repositoryNodeId,
        title,
        ...(body === undefined ? {} : { body }),
      });
      return z
        .object({ kind: z.literal("confirmed"), issue: issueResult })
        .parse(response).issue;
    },
  };
}

export type GithubPilotProvider = ReturnType<typeof createGithubPilotProvider>;

export function githubPilotRegistration(
  environment: Record<string, string | undefined>,
  publicUrl: string | undefined,
): GithubPilotRegistration | null {
  const appId = environment.CORSAIR_GITHUB_APP_ID?.trim();
  const clientId = environment.CORSAIR_GITHUB_CLIENT_ID?.trim();
  const clientSecret = environment.CORSAIR_GITHUB_CLIENT_SECRET?.trim();
  if (!appId && !clientId && !clientSecret) return null;
  if (
    !appId ||
    !/^[1-9]\d*$/.test(appId) ||
    !clientId ||
    !clientSecret ||
    !publicUrl
  )
    throw new Error(
      "The GitHub pilot requires CORSAIR_GITHUB_APP_ID, CORSAIR_GITHUB_CLIENT_ID, CORSAIR_GITHUB_CLIENT_SECRET, and an OpenBot public URL.",
    );
  const redirectUri = new URL("/api/corsair/github/callback", publicUrl);
  if (
    redirectUri.protocol !== "https:" ||
    redirectUri.username ||
    redirectUri.password
  )
    throw new Error("The GitHub pilot requires an HTTPS OpenBot public URL.");
  return { appId, clientId, clientSecret, redirectUri: redirectUri.toString() };
}
