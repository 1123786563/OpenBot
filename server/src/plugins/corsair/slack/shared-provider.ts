import { createCorsair } from "corsair";
import { z } from "zod";
import { slackChannel, slackTeam } from "./provider";

export const slackInstallationIdentity = z.strictObject({
  appId: z.string().regex(/^A[A-Z0-9]+$/),
  teamId: slackTeam,
  botId: z.string().regex(/^B[A-Z0-9]+$/),
  botUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
});
const registration = slackInstallationIdentity.extend({
  token: z.string().regex(/^xoxb-[\w-]+$/),
});
export const sharedSlackTool = {
  ref: "corsair/slack.shared_post_message",
  effect: "write",
  identity: "slack_installation_bot",
  resource: "registered_channel",
  permissions: ["chat:write", "channels:read", "groups:read"],
} as const;

export function sharedSlackRegistration(
  env: Record<string, string | undefined>,
) {
  const fields = {
    appId: env.CORSAIR_SLACK_SHARED_APP_ID?.trim(),
    teamId: env.CORSAIR_SLACK_SHARED_TEAM_ID?.trim(),
    botId: env.CORSAIR_SLACK_SHARED_BOT_ID?.trim(),
    botUserId: env.CORSAIR_SLACK_SHARED_BOT_USER_ID?.trim(),
    token: env.CORSAIR_SLACK_SHARED_BOT_TOKEN?.trim(),
  };
  if (!Object.values(fields).some(Boolean)) return null;
  const result = registration.safeParse(fields);
  if (!result.success)
    throw new Error(
      "Shared Slack requires a workspace Bot token and its App, team, Bot and Bot user IDs.",
    );
  return result.data;
}

export function createSharedSlackProvider(
  config: z.infer<typeof registration>,
  transport: typeof fetch = fetch,
) {
  const { token, ...identity } = registration.parse(config);
  async function request<S extends z.ZodType>(
    method: string,
    schema: S,
    init?: RequestInit,
  ) {
    const response = await transport(`https://slack.com/api/${method}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init?.headers },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Slack request failed.");
    const body: unknown = await response.json();
    z.object({ ok: z.literal(true) }).parse(body);
    return schema.parse(body);
  }
  return {
    identity,
    async verifyIdentity() {
      const result = await request(
        "auth.test",
        z.object({
          team_id: slackTeam,
          bot_id: z.string(),
          user_id: z.string(),
          is_enterprise_install: z.literal(false).optional(),
        }),
        { method: "POST" },
      );
      if (
        result.team_id !== identity.teamId ||
        result.bot_id !== identity.botId ||
        result.user_id !== identity.botUserId
      )
        throw new Error(
          "Slack did not verify the configured installation Bot.",
        );
    },
    async checkChannel(channelId: string) {
      const query = new URLSearchParams({ channel: channelId });
      const { channel } = await request(
        `conversations.info?${query}`,
        z.object({
          channel: z.object({
            id: slackChannel,
            context_team_id: slackTeam.optional(),
            is_archived: z.literal(false),
            is_ext_shared: z.literal(false),
            is_org_shared: z.literal(false).optional(),
            is_member: z.literal(true),
          }),
        }),
      );
      if (
        channel.id !== channelId ||
        (channel.context_team_id && channel.context_team_id !== identity.teamId)
      )
        throw new Error("Slack did not verify the configured channel.");
    },
    async postMessage(input: { channel: string; text: string }) {
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
                post: async (context: { key: string }, args: typeof input) => {
                  try {
                    const result = await request(
                      "chat.postMessage",
                      z.object({
                        channel: slackChannel,
                        ts: z.string().regex(/^\d+\.\d+$/),
                        message: z.object({
                          bot_id: z.string(),
                          user: z.string().optional(),
                          app_id: z.string().optional(),
                        }),
                      }),
                      {
                        method: "POST",
                        headers: {
                          Authorization: `Bearer ${context.key}`,
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                          ...args,
                          unfurl_links: false,
                          unfurl_media: false,
                        }),
                      },
                    );
                    if (
                      result.channel === args.channel &&
                      result.message.bot_id === identity.botId &&
                      (result.message.user === undefined ||
                        result.message.user === identity.botUserId) &&
                      (result.message.app_id === undefined ||
                        result.message.app_id === identity.appId)
                    )
                      return {
                        channel: result.channel,
                        timestamp: result.ts,
                        identity,
                      };
                  } catch {
                    // A remote write may already exist. Return a sentinel to suppress Corsair retries.
                  }
                  return null;
                },
              },
            },
          },
        ],
      });
      return client.slack.api.messages.post(input);
    },
  };
}
export type SharedSlackProvider = ReturnType<typeof createSharedSlackProvider>;
