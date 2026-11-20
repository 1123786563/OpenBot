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

## Post from a GitHub event Goal

When the GitHub event pilot is enabled, a Goal Run from a bound GitHub Trigger can ask for a one-time Approval to post in a registered Slack channel. The Bot needs the Slack grant and the Goal owner needs a selected or default Slack Connection. The Approval pins the Slack user, Connection revision, channel, and message. The worker checks the original GitHub Trigger and the pinned Slack authorization before posting. A temporary GitHub lookup failure keeps the Run waiting. A revoked GitHub or Slack authorization closes the Approval and fails the Run.

For automated reconciliation of an unconfirmed send, add the Slack user scopes `channels:history` and `groups:history` and reconnect existing Slack Connections. OpenBot checks recent history in the approved channel for the approved user and the message's delivery ID. If that check cannot confirm delivery, OpenBot records the outcome as unconfirmed. Check the channel before requesting a new Approval. [Slack message history](https://docs.slack.dev/reference/methods/conversations.history/) and [message metadata](https://docs.slack.dev/messaging/message-metadata/).

## Carry over a verified Broker default

Set `CORSAIR_SLACK_VERIFIED_LEGACY_DEFAULTS` to a JSON array. Each entry contains `workspaceId` (OpenBot deployment ID), `registration` (`<app ID>/<client ID>/<team ID>` plus `/<enterprise ID>` for an org install), `personId`, `brokeredAccountId`, `subjectScope` (Slack team or enterprise ID), `userId` (stable Slack user ID), and `evidenceRef` (reference to the provider evidence behind the match). Use one record per OpenBot workspace, registration, and Person. The callback checks the exact stable subject and confirms that the Broker row is still the selected default. A Person can set a default manually when no verified mapping is available.

## Provider evidence and acceptance

The confidential server OAuth path uses Slack's documented `user_scope`, `authed_user`, and rotating user-token exchange. `auth.test` checks the resulting token's identity. The official Slack Node SDK's refresh response type documents the app and installation fields. The pinned `corsair@0.2.15` runs a single custom Slack endpoint with the verified invocation token. The inspected `@corsair-dev/slack@0.1.9` package uses a broad default scope list, so this pilot supplies the narrow OAuth exchange and write endpoint directly through the core SDK.

Primary references are [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [token rotation](https://docs.slack.dev/authentication/using-token-rotation/), [auth.test](https://docs.slack.dev/reference/methods/auth.test/), [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/), [conversations.members](https://docs.slack.dev/reference/methods/conversations.members/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), and the [Slack Node SDK OAuth types](https://github.com/slackapi/node-slack-sdk/blob/main/packages/oauth/src/install-provider.ts).

Automated acceptance uses PostgreSQL and a Slack HTTP fixture. Live acceptance needs a self-hosted app and controlled channels. Verify two real users and their destinations, workspace or enterprise mismatch handling, a genuine token refresh, Slack attribution, and zero writes on denied or stale Approvals, out-of-range channels, or missing membership. The pilot uses the operator API for account selection and review.

## Post as a shared installation Bot

1. Install the Slack app in the target workspace with Bot scopes `chat:write`, `channels:read`, and `groups:read`. Add the Bot to the channels you plan to enroll. Configure the five `CORSAIR_SLACK_SHARED_*` settings in the OpenBot server environment. [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/) · [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
2. Sign in as an OpenBot admin and send `PUT /installation` with `channelIds`. OpenBot verifies the token's Slack workspace, Bot ID, Bot user ID, and channel membership. Each OpenBot deployment enrolls its own channels under its deployment ID. Changing the enrolled identity or channels clears the grants and Shared-use Approvals for that enrollment.
3. Send `PUT /bots/:botId/grant` with `enabled: true`. Then send `PUT /bots/:botId/shared-use` with an `approval` object containing `audience` (`owner`, `people`, or `team`), `outsideInput` (a boolean), and `members` (an array). For `people`, include entries with `kind` of `user` or `group` and a `value` containing the user ID or group name. Use an empty array for the other audiences. Set `approval` to `null` to revoke Shared-use Approval.
4. Open a review with `POST /approvals` and the fields `botId`, `channelId`, and `text`. For a Goal Run, use `POST /goal-runs/:runId/approvals`. OpenBot verifies that the signed-in person owns the Run and reads the source from the stored event. Webhook and other external sources require `outsideInput: true`.
5. Review the destination, installation identity, and text. Send `POST /approvals/:id/decision` with `decision` set to `allow_once` or `deny`. To dispatch an approved message, send `POST /approvals/:id/execute` with an empty body. OpenBot checks current authorization and Slack membership before using the Approval.

Prefix each route with `/api/corsair/slack/shared`. Send `X-OpenBot-Pilot: slack` on mutations. Admins can inspect enrollment with `GET /installation` or revoke it with `DELETE /installation`.

For live acceptance, post to a controlled channel and compare the Slack author with the enrolled Bot and the `slack_installation_bot` identity in the OpenBot audit event. Check that a denied attempt leaves a refusal event and no Slack message. If Slack's response leaves the result uncertain, inspect the channel before opening another Approval.

## Dispatch Slack channel events to Goals

1. On the shared installation Slack app, subscribe to the Bot events `message.channels`, `message.groups`, `app_mention`, and `reaction_added` as needed. Add the corresponding Bot scopes and reinstall the app if the scopes change. Set the request URL to `<OpenBot public HTTPS URL>/api/corsair/slack/webhook`. Set `CORSAIR_SLACK_EVENTS_SIGNING_SECRET` to this app's signing secret. [Slack Events API](https://docs.slack.dev/apis/events-api/) and [Slack request signatures](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
2. Enroll the shared installation and its channels in each OpenBot workspace that should receive events. For each Goal owner, connect a personal Slack account in that OpenBot workspace. Use a Slack account from the installation's Slack team with access to the enrolled channel.
3. Create a Slack Goal Trigger with the team, channel, and event mode. The existing Trigger setup uses the owner's OpenTag pairing to validate the channel. For the configured team, Corsair dispatches channel events to Goals. OpenTag still handles conversations and replies through its existing agent endpoint.

Use the audit events `corsair.slack.event_delivery` and `corsair.slack.event_run_skipped` to trace the Slack event ID, receipt, Trigger, and Run. A timeout delays dispatch for that Trigger. An explicit denial produces no Run. OpenBot checks the current installation and channel membership again before a queued Run starts. [Slack channel membership API](https://docs.slack.dev/reference/methods/conversations.members/).

To verify a live pilot, send a message in an enrolled channel with two matching Triggers. Compare the Slack event ID and Run IDs in the audit trail. Replay the delivery, then revoke the owner's connection and send another message. Use an OpenTag channel conversation to verify that the Bot's reply still reaches the sender.

Use the source handoff procedure before transferring Goal Run creation from OpenTag to Corsair. [Reconcile Corsair Goal event delivery](corsair-event-handoff.md).
