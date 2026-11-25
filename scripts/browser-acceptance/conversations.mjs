/*
 * The conversations the fixture's roster holds, so the sidebar draws real rows in every language, and what each row's
 * time reads in each of them.
 *
 * An age is counted back from the request that lists the roster, so a row's short relative time reads the same however
 * long the fixture runs. Each sits inside its unit and away from the edge where it would turn into the next one: "now"
 * for the first minute, 4½ minutes reads 4m for another half minute, then 3½ hours and 2½ days.
 *
 * Names and titles are kept short on purpose. A long one is cut with an ellipsis by design, and the page audit reports
 * every cut as clipped text.
 */
export const CONVERSATIONS = [
  {
    id: "acceptance-plan",
    bot: "general",
    name: "General Assistant",
    summary: "Plan next week",
    agoMs: 20_000,
    now: true,
  },
  {
    id: "acceptance-claims",
    bot: "research",
    name: "Research Bot",
    summary: "Source the claims",
    agoMs: 270_000,
    time: { en: "4m", "zh-CN": "4 分钟前" },
  },
  {
    id: "acceptance-budget",
    bot: "finance",
    name: "财务助手",
    summary: "核对季度预算",
    agoMs: 12_600_000,
    time: { en: "3h", "zh-CN": "3 小时前" },
  },
  {
    id: "acceptance-train",
    bot: "travel",
    name: "Travel Planner",
    summary: "Book the train",
    agoMs: 216_000_000,
    time: { en: "2d", "zh-CN": "2 天前" },
  },
  // Waiting on a Bot another Bot asked, so the row says so where its time goes.
  {
    id: "acceptance-handoff",
    bot: "general",
    name: "General Assistant",
    summary: "Ask the legal Bot",
    agoMs: 540_000,
    work: true,
  },
  // Nobody has used this one: no time at all, and the name the interface gives an unnamed conversation.
  {
    id: "acceptance-fresh",
    bot: "general",
    name: "General Assistant",
    summary: null,
    agoMs: null,
  },
];

/** The roster as `/api/channels` states it: one `ChannelSummary` per conversation (app/src/lib/channels/queries.ts). */
export function seededConversations(now = Date.now()) {
  const ago = (ms) => new Date(now - ms).toISOString();
  return CONVERSATIONS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    agentIds: [seed.bot],
    threadId: seed.id,
    active: true,
    lastMessageAt: seed.agoMs === null ? null : ago(seed.agoMs),
    ...(seed.work
      ? {
          work: [
            {
              kind: "handoff",
              key: `${seed.id}-handoff`,
              botId: "legal",
              botName: "Legal Bot",
              since: ago(40_000),
            },
          ],
        }
      : {}),
    summary: seed.summary,
    opening: null,
    lastMessage: null,
    lastMessageAgentId: seed.agoMs === null ? null : seed.bot,
    createdAt: ago((seed.agoMs ?? 0) + 3_600_000),
    pinned: false,
    lastReadAt: null,
  }));
}
