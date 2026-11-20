export const SLACK_EVENT_PREFIX = "corsair-slack:";

export class SlackEventAccessRetry extends Error {
  constructor() {
    super("Slack event read access is temporarily unavailable.");
  }
}
