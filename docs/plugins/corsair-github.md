# GitHub App pilot through Corsair

OpenBot #19 provides an opt-in operator API for a Person to authorize a GitHub App user identity and approve one reviewed Bot action, creating an issue in a registered repository. The pilot uses the OpenBot deployment identity as the workspace boundary. OAuth state, Connections, registered repositories, and Bot Grants are isolated by workspace and GitHub App registration.

## Set up a pilot workspace

1. Create a dedicated GitHub App in each environment. Configure `<OpenBot public URL>/api/corsair/github/callback` as a user authorization callback. Enable expiring user access tokens. Use a GitHub App with repository **Issues: Read and write** and the implicit **Metadata: Read** permission. Install the App on selected pilot repositories.
2. Set `CORSAIR_GITHUB_APP_ID`, `CORSAIR_GITHUB_CLIENT_ID`, and `CORSAIR_GITHUB_CLIENT_SECRET` on the server and configure an HTTPS public URL. Apply the database migration. The API is opt-in when the three variables are supplied.
3. Start the flow as an OpenBot administrator with access to the GitHub installation. The GitHub callback returns the verified GitHub user ID and login. Use that Connection and the numeric GitHub installation and repository IDs to register each selected repository in OpenBot.
4. Grant `corsair/github.create_issue` to a pilot Bot. The Person who will exercise the Bot authorizes their own GitHub account. The Person can authorize additional accounts, choose a default, or name a Connection when opening an Approval.

The reviewed action creates a new issue with a `title` and optional `body`. It uses the selected GitHub App user access token and the registered repository's GitHub node ID. The write requires a current Bot Grant, permission to use the Bot, a fresh allow-once Approval for the exact action, and provider confirmation of the GitHub user and repository access. GitHub enforces the intersection of App and user permissions at execution. The server shows the resulting issue link and actor and records the Connection, repository, Approval and result in audit events.

## Operator API

All routes are under `/api/corsair/github` and use the standard OpenBot session. Send `X-OpenBot-Pilot: github` on mutating requests and `Content-Type: application/json` for JSON bodies. Open the URL returned by `POST /connect` in the browser where the Person is signed in to OpenBot.

| Request | Body or result |
| --- | --- |
| `POST /connect` | Returns `authorizationUrl`. The callback displays `connectionId` and provider-verified `identity`. |
| `GET /connections` | Returns `connections` with GitHub identities and expiry, and `defaultConnectionId` for the signed-in Person in this workspace and GitHub App registration. The default is `null` until chosen or inherited. |
| `PUT /connections/default` | Send `{ "connectionId": "…" }` for one of the signed-in Person's authorized Connections. Returns `defaultConnectionId`. |
| `POST /repositories` | Admin only. Send `connectionId`, numeric `installationId`, and numeric `repositoryId`. |
| `GET /repositories` | Lists registered repository IDs and names. |
| `DELETE /repositories/:repositoryId` | Admin only. Removes the repository from pilot scope. |
| `PUT /bots/:botId/grant` | Admin only. Send `{ "enabled": true }` to grant or `false` to revoke. |
| `GET /bots/:botId/tools` | Returns the reviewed tool when the caller can use the Bot and it holds the grant. |
| `POST /approvals` | Send `botId`, numeric `repositoryId`, `title`, and optional `body`. Include `connectionId` for an explicit account, or omit it to use the selected default. The response includes the pinned Connection in `action.target.connectionId`. |
| `POST /approvals/:id/decision` | The requesting Person sends `{ "decision": "allow_once" }` or `{ "decision": "deny" }`. |
| `POST /approvals/:id/execute` | Send the same action arguments as the requesting Person. Omit `connectionId` to use the pin, or resend that exact ID. Changing the default has no effect on an existing Approval. A consumed Approval cannot dispatch again. |

Reauthorize when the access token expires. Reauthorization changes the Connection revision, so request a new Approval before writes under the new credential. A provider response that does not confirm the write, repository, and operator is recorded as unconfirmed. Check the selected repository before requesting a fresh Approval. The pilot currently checks the first 100 installations and the first 100 repositories visible within the installation. Entries outside those pages are refused.

## Inherit a verified legacy default

Set `CORSAIR_GITHUB_VERIFIED_LEGACY_DEFAULTS` before reauthorization if you have provider evidence for a legacy default. The value is a JSON array. Each entry ties one existing Broker default to its verified GitHub user ID in one OpenBot workspace and App registration.

```json
[
  {
    "workspaceId": "pilot-workspace",
    "registration": "12345/Iv1.example",
    "personId": "openbot-person-id",
    "brokeredAccountId": "97bb36f7-c720-40a3-8ebd-938f3c7046cd",
    "githubUserId": 123456,
    "evidenceRef": "migration-record-42"
  }
]
```

Use OpenBot's deployment ID for `workspaceId`, `<app ID>/<client ID>` for `registration`, and the local `brokered_accounts.id` for `brokeredAccountId`. Obtain the stable user ID from a provider record tied to that exact legacy authorization. Verify the workspace independently because Broker rows store the Person and app only. Keep `evidenceRef` as a reference to the verification record. Use one entry per workspace, Person, and App registration.

The OAuth callback checks the provider's returned GitHub user ID and confirms the identified Broker account is still the Person's GitHub default. It inherits the choice only if a pilot default has yet to be selected. When evidence is missing, ambiguous, or outdated, use `GET /connections` and `PUT /connections/default` to choose among newly authorized accounts. The API prompts for this choice when an invocation omits its Connection and no default exists.

## SDK evidence and live acceptance

The published npm artifacts `corsair@0.2.15` and `@corsair-dev/github@0.1.20` were inspected directly. The built-in GitHub endpoint honored an invocation-scoped `keyBuilder` in the HTTP fixture. Its OAuth defaults request OAuth App scopes, and its REST write follows redirects. OpenBot uses the GitHub App authorization endpoints directly and registers a single custom `issues.create` endpoint with Corsair. The endpoint sends the GitHub GraphQL `createIssue` mutation using the verified repository node ID, rejects redirects, and disables SDK reauthorization and retries for this write.

Upstream references are the [Corsair SDK](https://www.npmjs.com/package/corsair/v/0.2.15), [Corsair GitHub plugin](https://www.npmjs.com/package/@corsair-dev/github/v/0.1.20), GitHub's [App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [installation access endpoints](https://docs.github.com/en/rest/apps/installations), and [`createIssue` schema](https://docs.github.com/en/graphql/reference/issues#createissue).

The automated checks use a disposable PostgreSQL database and GitHub HTTP fixtures. Live acceptance still needs two configured OpenBot workspaces, a controlled GitHub App and pilot repository, and a real Person authorization flow. Verify PKCE code mismatch handling, access-token expiry, the minimum App permissions for the GraphQL mutation, one remote issue attributed to the authorized person, the corresponding OpenBot audit events, and zero remote writes for a denied, repointed, revoked, or inaccessible action. The operator API is the #19 pilot entry point. Connections UI and general Bot runtime tool exposure require separate integration work.
