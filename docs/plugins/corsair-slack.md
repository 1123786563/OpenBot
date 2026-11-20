# Corsair personal Slack pilot

The pilot exposes one reviewed action, `corsair/slack.post_message`, through the authenticated operator API. Each deployment registration selects one Slack app and target workspace. More than one Slack user can authorize within that registration. The API returns the Slack subject and Connection ID for each account, even when their display names match.

## Register the pilot

1. Create a Slack app with rotating tokens and the user scopes `chat:write`, `channels:read`, and `groups:read`. Add `<OpenBot public HTTPS URL>/api/corsair/slack/callback` to the Slack OAuth redirect URLs.
2. Configure `CORSAIR_SLACK_APP_ID`, `CORSAIR_SLACK_CLIENT_ID`, `CORSAIR_SLACK_CLIENT_SECRET`, and `CORSAIR_SLACK_TEAM_ID`. For an organization-level install, also set `CORSAIR_SLACK_ENTERPRISE_ID` and keep the team ID for the workspace where writes are permitted.
3. Set `CORSAIR_SLACK_CHANNEL_IDS` to the comma-separated stable IDs of approved channels. An empty list allows account setup and blocks posting. Posting requires verified channel membership and rejects Slack Connect channels. Membership checks read up to ten pages of 200 members and refuse the action if the user cannot be found.

## Authorize and use a Connection

All operations below start at `/api/corsair/slack`. Use the same signed-in OpenBot Person for the OAuth start and callback. Send `X-OpenBot-Pilot: slack` on mutating requests.

| Operation | Request |
| --- | --- |
| Start OAuth | `POST /connect`. Open the returned `authorizationUrl` in the browser. |
| List accounts | `GET /connections`. Each row includes the Slack subject scope, user ID, display name, and verification state. |
| Set a default | `PUT /connections/default` with `connectionId`. |
| Grant a Bot access | As an admin, `PUT /bots/:botId/grant` with `enabled`. See its reviewed action with `GET /bots/:botId/tools`. |
| Open a review | `POST /approvals` with `botId`, `channelId`, `text`, and an optional `connectionId`. Omit `connectionId` to resolve the current default. Review the returned target and text. |
| Decide | `POST /approvals/:id/decision` with `decision` set to `allow_once` or `deny`. |
| Execute | `POST /approvals/:id/execute` with the same Bot, channel, and text. The Approval pins the Connection. If supplied, `connectionId` must match. |

A user can reauthorize the same stable subject and keep the Connection ID. Reauthorization invalidates pending or approved writes tied to the previous authorization. Routine token rotation keeps the Approval binding when Slack confirms the same identity. A refresh that cannot be verified marks the Connection as requiring reauthorization. When Slack cannot confirm a write and its operator, check the channel before opening a new Approval.

## Carry over a verified Broker default

Set `CORSAIR_SLACK_VERIFIED_LEGACY_DEFAULTS` to a JSON array. Each entry contains `workspaceId` (OpenBot deployment ID), `registration` (`<app ID>/<client ID>/<team ID>` plus `/<enterprise ID>` for an org install), `personId`, `brokeredAccountId`, `subjectScope` (Slack team or enterprise ID), `userId` (stable Slack user ID), and `evidenceRef` (reference to the provider evidence behind the match). Use one record per OpenBot workspace, registration, and Person. The callback checks the exact stable subject and confirms that the Broker row is still the selected default. A Person can set a default manually when no verified mapping is available.

## Provider evidence and acceptance

The confidential server OAuth path uses Slack's documented `user_scope`, `authed_user`, and rotating user-token exchange. `auth.test` checks the resulting token's identity. The official Slack Node SDK's refresh response type documents the app and installation fields. The pinned `corsair@0.2.15` runs a single custom Slack endpoint with the verified invocation token. The inspected `@corsair-dev/slack@0.1.9` package uses a broad default scope list, so this pilot supplies the narrow OAuth exchange and write endpoint directly through the core SDK.

Primary references are [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [auth.test](https://docs.slack.dev/reference/methods/auth.test/), [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/), [conversations.members](https://docs.slack.dev/reference/methods/conversations.members/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), and the [Slack Node SDK OAuth types](https://github.com/slackapi/node-slack-sdk/blob/main/packages/oauth/src/install-provider.ts).

Automated acceptance uses PostgreSQL and a Slack HTTP fixture. Live acceptance needs a self-hosted app and controlled channels. Verify two real users and their destinations, workspace or enterprise mismatch handling, a genuine token refresh, Slack attribution, and zero writes on denied or stale Approvals, out-of-range channels, or missing membership. The pilot uses the operator API for account selection and review.
