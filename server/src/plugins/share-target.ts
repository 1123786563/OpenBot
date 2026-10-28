import type { ShareAudience } from "../proactive/private-share";

/**
 * Whether a connector write sends content to other people, and to whom.
 *
 * The private-share check (proactive/private-share.ts) asks the owner before a Bot shares something
 * from their private conversation or memory with anybody else. A connector call is the widest door
 * for that: a Slack message, a Teams post, an email. This names the calls that go through it.
 *
 * By name, because neither MCP nor Composio publishes "this tool messages people": a write whose name
 * says it sends, posts, replies, forwards, shares or comments is a send. A write that only changes
 * the owner's own data (create a draft, update a row) is not, and passes on to the ordinary gates.
 * Read calls never reach this. Over-inclusive on purpose: asking once about a send that turned out
 * to be private costs a click; not asking about one that was public costs the person their privacy.
 */
const SENDS =
  /(^|[_\-.\s])(resend|send|post|reply|respond|forward|share|comment|publish|broadcast|invite|notify|message|chat[_-]?post|create[_-]?message|create[_-]?post|create[_-]?comment)s?([_\-.\s]|$)/i;
/** A write that only stages something for the owner, which sends nothing yet. */
const STAGES = /(^|[_\-.\s])(draft|drafts)([_\-.\s]|$)/i;

const CONTENT_KEYS = [
  "text",
  "message",
  "body",
  "content",
  "markdown",
  "html",
  "subject",
  "comment",
  "blocks",
];
const RECIPIENT_KEYS = [
  "channel",
  "channel_id",
  "channelId",
  "conversation_id",
  "chat_id",
  "chatId",
  "thread_ts",
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "email",
  "user",
  "users",
  "team_id",
];

function flatten(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(flatten).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type ShareTarget = { audience: ShareAudience; content: string };

export function shareTargetOf(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): ShareTarget | null {
  // Both camel boundaries become separators: lowercase→uppercase
  // ("sendMessage") and an acronym's last letter against a lowercase word
  // ("SMSsend", "SMSend") — a verb hiding behind an acronym must not pass
  // the ask unrequested.
  const name = toolName
    .replace(/(?<=[A-Z])([A-Z])([a-z])/g, "$1_$2")
    .replace(/([a-z])([A-Z])/g, "$1_$2");
  if (!SENDS.test(name)) return null;
  /*
   * A staging word only exempts a name that does nothing but stage: a name
   * carrying both (`send_draft`, `draft_and_send`) still sends, so it is
   * asked about like any other send — the over-inclusive side the header
   * promises.
   */
  if (STAGES.test(name) && !SENDS.test(name.replace(STAGES, " "))) {
    return null;
  }
  const content = CONTENT_KEYS.map((key) => flatten(args[key]))
    .filter(Boolean)
    .join("\n");
  const recipients = RECIPIENT_KEYS.map((key) => flatten(args[key]))
    .filter(Boolean)
    .join(" ");
  const id = (recipients || `${serverId}/${toolName}`).slice(0, 200);
  return {
    audience: {
      /*
       * Always `external`, including a Slack channel. Who can read a vendor's channel is the vendor's
       * to say, and this deployment does not know its members as user ids; `slack_channel` with no
       * recipients would read as "only the owner can see it" and pass unasked.
       */
      kind: "external",
      id,
      recipientUserIds: [],
      label: `${serverId}: ${id}`.slice(0, 200),
    },
    content: content || JSON.stringify(args).slice(0, 4000),
  };
}
