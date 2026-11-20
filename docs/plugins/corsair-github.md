# GitHub App pilot through Corsair

OpenBot #19 provides an opt-in operator API for a Person to authorize a GitHub App user identity and approve one reviewed Bot action, creating an issue in a registered repository. The pilot uses the OpenBot deployment identity as the workspace boundary. OAuth state, Connections, registered repositories, and Bot Grants are isolated by workspace and GitHub App registration.

## Set up a pilot workspace

1. Create a dedicated GitHub App in each environment. Configure `<OpenBot public URL>/api/corsair/github/callback` as a user authorization callback. Enable expiring user access tokens. Use a GitHub App with repository **Issues: Read and write** and the implicit **Metadata: Read** permission. Install the App on selected pilot repositories.
2. Set `CORSAIR_GITHUB_APP_ID`, `CORSAIR_GITHUB_CLIENT_ID`, and `CORSAIR_GITHUB_CLIENT_SECRET` on the server and configure an HTTPS public URL. Apply the database migration. The API is opt-in when the three variables are supplied.
3. Start the flow as an OpenBot administrator with access to the GitHub installation. The GitHub callback returns the verified GitHub user ID and login. Use that Connection and the numeric GitHub installation and repository IDs to register each selected repository in OpenBot.
4. Grant `corsair/github.create_issue` to a pilot Bot. The Person who will exercise the Bot authorizes their own GitHub account. Select that Person's Connection ID when opening an Approval.

The reviewed action creates a new issue with a `title` and optional `body`. It uses the selected GitHub App user access token and the registered repository's GitHub node ID. The write requires a current Bot Grant, permission to use the Bot, a fresh allow-once Approval for the exact action, and provider confirmation of the GitHub user and repository access. GitHub enforces the intersection of App and user permissions at execution. The server shows the resulting issue link and actor and records the Connection, repository, Approval and result in audit events.

## Operator API

All routes are under `/api/corsair/github` and use the standard OpenBot session. Send `X-OpenBot-Pilot: github` on mutating requests and `Content-Type: application/json` for JSON bodies. Open the URL returned by `POST /connect` in the browser where the Person is signed in to OpenBot.

| Request | Body or result |
| --- | --- |
| `POST /connect` | Returns `authorizationUrl`. The callback displays `connectionId` and provider-verified `identity`. |
| `GET /connections` | Lists the signed-in Person's Connections, GitHub identities and expiry. |
| `POST /repositories` | Admin only. Send `connectionId`, numeric `installationId`, and numeric `repositoryId`. |
| `GET /repositories` | Lists registered repository IDs and names. |
| `DELETE /repositories/:repositoryId` | Admin only. Removes the repository from pilot scope. |
| `PUT /bots/:botId/grant` | Admin only. Send `{ "enabled": true }` to grant or `false` to revoke. |
| `GET /bots/:botId/tools` | Returns the reviewed tool when the caller can use the Bot and it holds the grant. |
| `POST /approvals` | Send `botId`, `connectionId`, numeric `repositoryId`, `title`, and optional `body`. Returns the Approval ID, exact arguments, and target. |
| `POST /approvals/:id/decision` | The requesting Person sends `{ "decision": "allow_once" }` or `{ "decision": "deny" }`. |
| `POST /approvals/:id/execute` | Send the identical invocation as the requesting Person. A consumed Approval cannot dispatch again. |

Reauthorize when the access token expires. Reauthorization changes the Connection revision, so request a new Approval before writes under the new credential. A provider response that does not confirm the write, repository, and operator is recorded as unconfirmed. Check the selected repository before requesting a fresh Approval. The pilot currently checks the first 100 installations and the first 100 repositories visible within the installation. Entries outside those pages are refused.

## SDK evidence and live acceptance

The published npm artifacts `corsair@0.2.15` and `@corsair-dev/github@0.1.20` were inspected directly. The built-in GitHub endpoint honored an invocation-scoped `keyBuilder` in the HTTP fixture. Its OAuth defaults request OAuth App scopes, and its REST write follows redirects. OpenBot uses the GitHub App authorization endpoints directly and registers a single custom `issues.create` endpoint with Corsair. The endpoint sends the GitHub GraphQL `createIssue` mutation using the verified repository node ID, rejects redirects, and disables SDK reauthorization and retries for this write.

Upstream references are the [Corsair SDK](https://www.npmjs.com/package/corsair/v/0.2.15), [Corsair GitHub plugin](https://www.npmjs.com/package/@corsair-dev/github/v/0.1.20), GitHub's [App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [installation access endpoints](https://docs.github.com/en/rest/apps/installations), and [`createIssue` schema](https://docs.github.com/en/graphql/reference/issues#createissue).

The automated checks use a disposable PostgreSQL database and GitHub HTTP fixtures. Live acceptance still needs two configured OpenBot workspaces, a controlled GitHub App and pilot repository, and a real Person authorization flow. Verify PKCE code mismatch handling, access-token expiry, the minimum App permissions for the GraphQL mutation, one remote issue attributed to the authorized person, the corresponding OpenBot audit events, and zero remote writes for a denied, repointed, revoked, or inaccessible action. The operator API is the #19 pilot entry point. Connections UI and general Bot runtime tool exposure require separate integration work.
