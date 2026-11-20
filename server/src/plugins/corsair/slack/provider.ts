import { createCorsair } from "corsair";
import { z } from "zod";
import { revokeSlackToken } from "./revoke-token";

export const slackTeam = z.string().regex(/^T[A-Z0-9]+$/);
const enterprise = z.string().regex(/^E[A-Z0-9]+$/);
const slackUser = z.string().regex(/^[UW][A-Z0-9]+$/);
export const slackChannel = z.string().regex(/^[CG][A-Z0-9]+$/);
const scopes = ["chat:write", "channels:read", "groups:read"];
const reconcileScopes = ["channels:history", "groups:history"];
const deliveryEvent = "openbot_slack_message_sent";
const deliveryHistory = z.object({
  messages: z.array(
    z.object({
      ts: z.string().regex(/^\d+\.\d+$/),
      user: slackUser.optional(),
      metadata: z
        .object({
          event_type: z.string(),
          event_payload: z.object({ delivery: z.uuid() }).optional(),
        })
        .optional()
        .catch(undefined),
    }),
  ),
});
const rotatingUser = z.object({
  token_type: z.literal("user"),
  access_token: z.string().startsWith("xoxe.xoxp-"),
  refresh_token: z.string().startsWith("xoxe-"),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(12 * 60 * 60),
  scope: z
    .string()
    .refine((value) =>
      scopes.every((scope) => value.split(",").includes(scope)),
    ),
});
const installation = z.object({
  app_id: z.string(),
  team: z.object({ id: slackTeam }).nullish(),
  enterprise: z.object({ id: enterprise }).nullish(),
  is_enterprise_install: z.boolean(),
});
const authTest = z.object({
  user_id: slackUser,
  user: z.string().min(1),
  team_id: slackTeam.nullish(),
  enterprise_id: enterprise.nullish(),
  bot_id: z.never().nullish(),
});
const posted = z.object({
  channel: slackChannel,
  ts: z.string().regex(/^\d+\.\d+$/),
  message: z.object({ user: slackUser }),
});

export type SlackRegistration = {
  appId: string;
  teamId: string;
  enterpriseId?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  reconcileGoalWrites?: boolean;
};

export class SlackIdentityMismatch extends Error {}
export class SlackWritePermissionUnavailable extends Error {}

export function createSlackPilotProvider(
  config: SlackRegistration,
  transport: typeof fetch = fetch,
) {
  const { appId, teamId, enterpriseId, clientId, clientSecret, redirectUri } =
    config;
  const subjectScope = enterpriseId ?? teamId;
  async function request<S extends z.ZodType>(
    method: string,
    schema: S,
    init: RequestInit = {},
    verifyWriteScope = false,
  ) {
    const response = await transport(`https://slack.com/api/${method}`, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Slack request failed.");
    if (
      verifyWriteScope &&
      !response.headers
        .get("x-oauth-scopes")
        ?.split(",")
        .some((scope) => scope.trim() === "chat:write")
    )
      throw new SlackWritePermissionUnavailable();
    const payload: unknown = await response.json();
    z.object({ ok: z.literal(true) }).parse(payload);
    return schema.parse(payload);
  }
  function checkInstallation(result: z.infer<typeof installation>) {
    if (
      result.app_id !== appId ||
      (enterpriseId
        ? !result.is_enterprise_install ||
          result.enterprise?.id !== enterpriseId ||
          (result.team != null && result.team.id !== teamId)
        : result.is_enterprise_install || result.team?.id !== teamId)
    )
      throw new SlackIdentityMismatch();
  }
  function exchangeToken<S extends z.ZodType>(
    params: Record<string, string>,
    schema: S,
  ) {
    return request("oauth.v2.access", schema, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...params,
      }),
    });
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  async function identity(token: string, userId: string) {
    const result = await request("auth.test", authTest, {
      headers: bearer(token),
    });
    if (
      result.user_id !== userId ||
      (enterpriseId
        ? result.enterprise_id !== enterpriseId ||
          (result.team_id != null && result.team_id !== teamId)
        : result.team_id !== teamId)
    )
      throw new SlackIdentityMismatch();
    return result.user;
  }
  async function verify(token: z.infer<typeof rotatingUser>, userId: string) {
    return {
      userId,
      label: await identity(token.access_token, userId),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
    };
  }
  return {
    subjectScope,
    teamId,
    revoke: (token: string) => revokeSlackToken(transport, token),
    authorizationUrl(state: string) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        team: teamId,
        user_scope: [
          ...scopes,
          ...(config.reconcileGoalWrites ? reconcileScopes : []),
        ].join(","),
      }).toString();
      return url.toString();
    },
    async exchange(code: string) {
      const result = await exchangeToken(
        { code, redirect_uri: redirectUri },
        installation.extend({
          authed_user: rotatingUser.extend({ id: slackUser }),
        }),
      );
      checkInstallation(result);
      return verify(result.authed_user, result.authed_user.id);
    },
    async refresh(refreshToken: string, userId: string) {
      const result = await exchangeToken(
        { grant_type: "refresh_token", refresh_token: refreshToken },
        installation.extend(rotatingUser.shape),
      );
      checkInstallation(result);
      return verify(result, userId);
    },
    identity,
    async checkChannel({
      token,
      channelId,
      userId,
      verifyWriteScope = false,
    }: {
      token: string;
      channelId: string;
      userId: string;
      verifyWriteScope?: boolean;
    }) {
      const { channel } = await request(
        `conversations.info?${new URLSearchParams({ channel: channelId })}`,
        z.object({
          channel: z.object({
            id: slackChannel,
            context_team_id: slackTeam.optional(),
            is_archived: z.literal(false),
            is_ext_shared: z.literal(false),
          }),
        }),
        { headers: bearer(token) },
        verifyWriteScope,
      );
      if (
        channel.id !== channelId ||
        (channel.context_team_id ?? (enterpriseId ? undefined : teamId)) !==
          teamId
      )
        throw new SlackIdentityMismatch();
      const membersSchema = z.object({
        members: z.array(slackUser),
        response_metadata: z
          .object({ next_cursor: z.string().optional() })
          .optional(),
      });
      const query = new URLSearchParams({ channel: channelId, limit: "200" });
      const signal = AbortSignal.timeout(10_000);
      for (let page = 0; page < 10; page++) {
        const members = await request(
          `conversations.members?${query}`,
          membersSchema,
          { headers: bearer(token), signal },
        );
        if (members.members.includes(userId)) return;
        const cursor = members.response_metadata?.next_cursor;
        if (!cursor || cursor === query.get("cursor")) break;
        query.set("cursor", cursor);
      }
      throw new Error("Slack membership could not be verified.");
    },
    async findGoalMessage({
      token,
      channel,
      userId,
      delivery,
      startedAt,
    }: {
      token: string;
      channel: string;
      userId: string;
      delivery: string;
      startedAt: Date;
    }) {
      const query = new URLSearchParams({
        channel,
        oldest: String(startedAt.getTime() / 1000 - 30),
        limit: "15",
        include_all_metadata: "true",
      });
      const history = await request(
        `conversations.history?${query}`,
        deliveryHistory,
        {
          headers: bearer(token),
        },
      );
      return history.messages.find(
        (message) =>
          message.user === userId &&
          message.metadata?.event_type === deliveryEvent &&
          message.metadata.event_payload?.delivery === delivery,
      )?.ts;
    },
    async postMessage({
      token,
      channel,
      text,
      userId,
      delivery,
    }: {
      token: string;
      channel: string;
      delivery?: string;
      text: string;
      userId: string;
    }) {
      const client = createCorsair({
        plugins: [
          {
            id: "slack",
            refreshOnUnauthorized: false,
            keyBuilder: async (_context, purpose) => {
              if (purpose !== "endpoint")
                throw new Error("Slack endpoint credential required.");
              return token;
            },
            endpoints: {
              messages: {
                post: async (
                  context: { key: string },
                  args: { channel: string; text: string },
                ) => {
                  try {
                    const result = await request("chat.postMessage", posted, {
                      method: "POST",
                      headers: {
                        ...bearer(context.key),
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        ...args,
                        ...(delivery
                          ? {
                              metadata: {
                                event_type: deliveryEvent,
                                event_payload: { delivery },
                              },
                            }
                          : {}),
                        unfurl_links: false,
                        unfurl_media: false,
                      }),
                    });
                    if (
                      result.channel === args.channel &&
                      result.message.user === userId
                    )
                      return {
                        kind: "confirmed" as const,
                        channel: result.channel,
                        timestamp: result.ts,
                        userId: result.message.user,
                      };
                  } catch {
                    // Return an uncertain outcome to Corsair without entering its retry path.
                  }
                  return { kind: "unconfirmed" as const };
                },
              },
            },
          },
        ],
      });
      const result = await client.slack.api.messages.post({ channel, text });
      if (result.kind !== "confirmed")
        throw new Error("Slack did not confirm the write.");
      return result;
    },
  };
}

export type SlackPilotProvider = ReturnType<typeof createSlackPilotProvider>;

export function slackPilotRegistration(
  env: Record<string, string | undefined>,
  publicUrl: string | undefined,
) {
  const appId = env.CORSAIR_SLACK_APP_ID?.trim();
  const clientId = env.CORSAIR_SLACK_CLIENT_ID?.trim();
  const clientSecret = env.CORSAIR_SLACK_CLIENT_SECRET?.trim();
  const team = env.CORSAIR_SLACK_TEAM_ID?.trim();
  const org = env.CORSAIR_SLACK_ENTERPRISE_ID?.trim();
  const channels = env.CORSAIR_SLACK_CHANNEL_IDS?.trim();
  if (!appId && !clientId && !clientSecret && !team && !org && !channels)
    return null;
  if (
    !appId ||
    !/^A[A-Z0-9]+$/.test(appId) ||
    !clientId ||
    !clientSecret ||
    !team ||
    !publicUrl
  )
    throw new Error(
      "The Slack pilot requires its App ID, client ID, client secret, team ID, and OpenBot public URL.",
    );
  const teamId = slackTeam.parse(team);
  const enterpriseId = org ? enterprise.parse(org) : undefined;
  const redirectUri = new URL("/api/corsair/slack/callback", publicUrl);
  if (
    redirectUri.protocol !== "https:" ||
    redirectUri.username ||
    redirectUri.password
  )
    throw new Error("The Slack pilot requires an HTTPS OpenBot public URL.");
  return {
    config: {
      appId,
      clientId,
      clientSecret,
      teamId,
      enterpriseId,
      redirectUri: redirectUri.toString(),
    },
    registration: `${appId}/${clientId}/${teamId}${enterpriseId ? `/${enterpriseId}` : ""}`,
    allowedChannels: new Set(
      channels
        ? channels.split(",").map((id) => slackChannel.parse(id.trim()))
        : [],
    ),
  };
}
