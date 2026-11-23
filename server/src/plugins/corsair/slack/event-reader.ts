import { z } from "zod";
import { slackChannel, slackTeam } from "./provider";
import type { SharedSlackProvider } from "./shared-provider";

const slackError = z.object({ ok: z.literal(false), error: z.string() });
const botIdentity = z.object({
  ok: z.literal(true),
  team_id: slackTeam,
  bot_id: z.string(),
  user_id: z.string(),
  is_enterprise_install: z.boolean().optional(),
});
const channelInfo = z.object({
  ok: z.literal(true),
  channel: z.object({
    id: slackChannel,
    context_team_id: slackTeam.optional(),
    is_archived: z.boolean(),
    is_ext_shared: z.boolean(),
    is_org_shared: z.boolean().optional(),
    is_member: z.boolean(),
  }),
});
const memberPage = z.object({
  ok: z.literal(true),
  members: z.array(z.string()),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});
const deniedErrors = new Set([
  "access_denied",
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "missing_scope",
  "not_authed",
  "not_in_channel",
  "token_revoked",
]);

export function createSlackEventReader(
  {
    token,
    teamId,
    botId,
    botUserId,
  }: SharedSlackProvider["identity"] & { token: string },
  transport: typeof fetch = fetch,
) {
  return async ({
    channelId,
    slackUserId,
  }: {
    channelId: string;
    slackUserId: string;
  }): Promise<"allowed" | "denied" | "retry"> => {
    const signal = AbortSignal.timeout(10_000);
    async function call<S extends z.ZodType>(
      method: string,
      query: URLSearchParams,
      schema: S,
      httpMethod = "GET",
    ) {
      try {
        const response = await transport(
          `https://slack.com/api/${method}?${query}`,
          {
            method: httpMethod,
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal,
          },
        );
        if (response.status === 401 || response.status === 403)
          return { kind: "denied" } as const;
        if (!response.ok) return { kind: "retry" } as const;
        const body: unknown = await response.json();
        const failure = slackError.safeParse(body);
        if (failure.success && deniedErrors.has(failure.data.error))
          return { kind: "denied" } as const;
        return { kind: "ok", value: schema.parse(body) } as const;
      } catch {
        return { kind: "retry" } as const;
      }
    }
    const auth = await call(
      "auth.test",
      new URLSearchParams(),
      botIdentity,
      "POST",
    );
    if (auth.kind !== "ok") return auth.kind;
    if (
      auth.value.team_id !== teamId ||
      auth.value.bot_id !== botId ||
      auth.value.user_id !== botUserId ||
      auth.value.is_enterprise_install
    )
      return "denied";
    const query = new URLSearchParams({ channel: channelId });
    const info = await call("conversations.info", query, channelInfo);
    if (info.kind !== "ok") return info.kind;
    const { channel } = info.value;
    if (
      channel.id !== channelId ||
      (channel.context_team_id ?? teamId) !== teamId ||
      channel.is_archived ||
      channel.is_ext_shared ||
      channel.is_org_shared ||
      !channel.is_member
    )
      return "denied";

    query.set("limit", "200");
    for (let page = 0; page < 10; page++) {
      const members = await call("conversations.members", query, memberPage);
      if (members.kind !== "ok") return members.kind;
      if (members.value.members.includes(slackUserId)) return "allowed";
      const cursor = members.value.response_metadata?.next_cursor;
      if (!cursor) return "denied";
      if (cursor === query.get("cursor")) break;
      query.set("cursor", cursor);
    }
    return "retry";
  };
}
