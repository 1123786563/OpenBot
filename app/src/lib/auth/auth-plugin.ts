import { ssoClient } from "@better-auth/sso/client";
import { organizationClient } from "better-auth/client/plugins";

/*
 * The fixed Better Auth client composition (T01.09, #521).
 *
 * Two plugins, for two different reasons. `ssoClient` is what every enabled
 * sign-in already goes through — email-domain discovery, the generic OAuth
 * provider Okta is registered as — and stays exactly as it was. `organizationClient`
 * is new: the pinned Better Auth UI source (ui-source.json, better-auth-ui 3.2.13)
 * is typed and wired against better-auth 1.7.1's organization client, so its
 * components and hooks only exist once that plugin is composed. The version is the
 * server's pin, not a floating range.
 *
 * Everything the first phase must not offer is absent by construction rather than
 * hidden later: no `adminClient` (impersonation, user CRUD), no organization
 * `dynamicAccessControl` / custom roles, and no organization provisioning plugin.
 * The organization actions the app does allow are narrowed again per rendered
 * subtree in organization-plugin.tsx.
 */
export function openBotClientPlugins() {
  return [ssoClient(), organizationClient()];
}
