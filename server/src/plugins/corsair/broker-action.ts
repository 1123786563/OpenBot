import { z } from "zod";
import type { CorsairScope } from "./cutover";
import { slackChannel } from "./slack/provider";

export const issueArgs = z.strictObject({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1).max(256),
  body: z.string().max(32_000).optional(),
});
export const messageArgs = z.strictObject({
  channel: slackChannel,
  text: z.string().min(1).max(4000),
});
export function supportedBrokerAction(
  app: CorsairScope["app"],
  vendorName: string,
) {
  return app === "github"
    ? ["GITHUB_CREATE_AN_ISSUE", "Github.CreateIssue"].includes(vendorName)
    : vendorName === "SLACK_CHAT_POST_MESSAGE";
}

export function corsairBrokerInputSchema(app: CorsairScope["app"]) {
  const { $schema: _schema, ...schema } = z.toJSONSchema(
    app === "github" ? issueArgs : messageArgs,
  );
  return schema;
}
