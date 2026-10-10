/**
 * What a Bot id is allowed to be, before it becomes a path or a port key.
 *
 * The id arrives as the `x-openbot-bot-id` header and becomes the directory the Bot's opencode
 * serve runs in (and which `/workspace/reset` deletes with `rm -rf`), so it gets the same answer
 * `agent-computer/src/bot-id.ts` gives the profile path: an id that is not a plain name never
 * reaches the filesystem. The rules match — letters, digits, hyphen and underscore, starting with a
 * letter or digit, at most 64 chars — because a deployment's ids are the same population on both
 * sides, and the narrower the accepted set, the less `..` reasoning anyone has to redo.
 */
/** Long enough for a uuid-shaped agent id, short enough to stay a sane directory name. */
const MAX_BOT_ID = 64;
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isPlainBotId(value: string): boolean {
  return value.length <= MAX_BOT_ID && ALLOWED.test(value);
}

/** Thrown rather than returned, so a caller cannot use the path by forgetting to check. */
export class UnusableBotIdError extends Error {
  constructor(botId: string) {
    super(
      `A bot id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit: ${JSON.stringify(botId)}`,
    );
    this.name = "UnusableBotIdError";
  }
}
