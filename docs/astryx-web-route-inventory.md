# Astryx Web route and profile inventory

This inventory covers the Web router for #17. Parameter names use the router's notation. Index routes are listed without a final slash. The route groups below come from `FileRoutesByFullPath` in `app/src/routeTree.gen.ts`. The four historical profile IDs are still valid account preferences. See [the rehearsal](astryx-web-rollout.md) for the browser sample and its limits.

## Legacy profiles

All four expose home and conversation history, New conversation, Bots, Routines, Connections, Settings and account actions. Team sees Capabilities and eligible administrators see Admin. Personal gets the business-features dialog in the account menu. The unified sidebar and account menu carry those shared destinations. Astryx uses the same navigation for all four saved profile IDs and leaves the stored value intact.

| Profile | Legacy entry or dedicated workflow | Astryx destination |
| --- | --- | --- |
| `openbot` | Home, sidebar, search, pinned and recent Conversations, new chat, account and appearance | Home `/`, unified sidebar search and roster, `/channel/new`, `/channel/$channelId` or `/group/$channelId`, unified account menu |
| `openduet` | Chat tab and orb, side menu and recent list | Home or Conversation, recipient picker and conversation composer for dictation where available |
| `openduet` | Tasks tab at `/s/tasks` | `/tasks` with task sections and conversation links |
| `openduet` | Manage, Settings, new chat and theme controls | Shared sidebar and account menu, `/channel/new` |
| `opendots` | New chat, coworker tiles and history, Bot profile and add Bot | `/`, `/channel/new?agent=…`, Conversation routes, `/bots/$agentId`, `/bots?new=true` |
| `opendots` | Routines at `/s/routines` | `/routines` |
| `opendots` | Memories at `/s/memories` | `/capabilities/memory` where offered. Personal falls back to `/bots`. |
| `opendots` | Selected Bot's computer pane, pause, settings and breadcrumbs | Conversation computer with `?watch=true` where available, Bot profile actions and tabs, unified navigation |
| `openmuse` (shown as OpenFuse) | Chat tab, main chat, side chat, Bot chooser and add Bot | Conversation roster, `/channel/new?agent=…`, `/bots` and `/bots?new=true`; choose a recipient from the composer |
| `openmuse` | Activity tab and Bot attention at `/s/activity` | Same URL in the Astryx shell for any profile. Shows the saved eligible Bot or the default Bot. Includes Needs you, activity sections and a Bot profile link. |
| `openmuse` | Ideas and selected Bot's check-ins at `/s/ideas` | `/ideas` with Bot selection and check-in settings |
| `openmuse` | Goals and selected Bot's ongoing work at `/s/goals` | `/responsibilities?view=goals` with Bot Routines and Responsibilities |
| `openmuse` | Apps tab, notifications and approvals, account menu | `/connections`, Bot attention and `/settings/approvals`, unified account menu |

Unknown `/s/$screen` keys still go home. The archived #17 off bundle uses the old profile-specific screen registry. A bookmark for a different profile's dedicated screen can go home in that bundle, just as it did before the switch.

## Shared app routes and compatibility

| Existing URLs | Destination and conditions |
| --- | --- |
| `/`, `/channel/new`, `/start/$startId` | Home, new Conversation, pending-send handoff. Preserve home `ask` and pending recipient `agent` where applicable. |
| `/channel/$channelId`, `/group/$channelId`, `/bot` | Same Conversation or default Bot route. Multi-Bot channel bookmarks resolve to the group transcript. Existing query state for conversation and side panels remains supported. |
| `/group/new` | `/channel/new`; select multiple recipients to create a group. |
| `/bots`, `/bots/$agentId` | Roster and profile. `?new=true` opens Create Bot. |
| `/agents`, `/agents?new=true`, `/agents?agent=…`, `/team-bots` | `/bots`, `/bots?new=true`, matching Bot profile, and `/bots`, respectively. Create takes precedence over profile. |
| `/bots/$agentId/access`, `/bots/$agentId/activity`, `/bots/$agentId/approvals`, `/bots/$agentId/reach`, `/bots/$agentId/responsibilities`, `/bots/$agentId/routines`, `/bots/$agentId/setup`, `/bots/$agentId/sharing` | Same Bot tabs subject to existing access and capability checks. |
| `/bots/$agentId/memory` | Same tab where Memory is offered; otherwise Bot Access. |
| `/browser` | Same Browser route; requires the deployment's Browser capability to be usable. |
| `/capabilities`, `/capabilities/skills`, `/skills` | `/capabilities/skills`; legacy Skills carries `new` and `edit` search parameters. |
| `/capabilities/memory`, `/memory`, `/settings/memory` | `/capabilities/memory` where offered; otherwise `/bots`. |
| `/connections`, `/connections/$key`, `/connections/browse/arcade`, `/connections/browse/composio` | Same list, detail and broker directories. Availability depends on deployment and provider. |
| `/connections/$key/bots/$agentId`, `/connections/$key/tools/$tool` | `/connections/$key`. |
| `/settings/connected-accounts`, `/settings/connected-accounts/$key` | Connections list/detail; preserve applicable consent callback state. |
| `/routines`, `/routines/new` | Same list and creation route. Existing Bot/Conversation launch context remains supported. |
| `/responsibilities`, `/ideas`, `/tasks` | Same Astryx destinations. The archived #17 off bundle sends Responsibilities to Bots and Ideas/Tasks to their dedicated legacy screens. |
| `/approvals`, `/reachability` | `/settings/approvals` and `/settings/notifications`. |
| `/sign`, `/onboarding`, `/sign-in/$requestId`, `/desktop-return` | Same authentication, first-run and desktop handoff routes. Unauthenticated protected bookmarks return through sign-in. |

## Settings and administration

| Existing URLs | Destination and conditions |
| --- | --- |
| `/settings`, `/settings/approvals`, `/settings/browsers`, `/settings/learning`, `/settings/notifications`, `/settings/passwords`, `/settings/setup`, `/settings/this-computer` | Same Settings routes with existing feature and setup gates. |
| `/settings/components-gallery`, `/settings/components-gallery/$name` | Same gallery and component preview. |
| `/settings/activity`, `/settings/computer`, `/settings/credentials`, `/settings/credentials/new`, `/settings/skills`, `/settings/skills/new`, `/settings/skills/$slug` | Same Personal settings. Team routes here fall back to `/settings`; Team administration lives at the corresponding Admin routes. |
| `/settings/plugins/$` | Personal Connections list/detail/directory according to the suffix. Team falls back to Settings. |
| `/admin`, `/admin/enterprise` | Team administrators open the Admin overview. Personal falls back to Settings. Team members go home. |
| `/admin/approvals`, `/admin/approvals/describe`, `/admin/approvals/guidance`, `/admin/boundaries`, `/admin/boundaries/new`, `/admin/boundaries/$index`, `/admin/permissions`, `/admin/permissions/describe`, `/admin/what-if` | Same Team governance routes. |
| `/admin/components`, `/admin/components/$name`, `/admin/playground`, `/admin/identity-providers`, `/admin/learning`, `/admin/people`, `/admin/proactive`, `/admin/providers` | Same Team administration routes. |
| `/admin/audit`, `/admin/computers`, `/admin/credentials`, `/admin/credentials/new`, `/admin/skills`, `/admin/skills/new`, `/admin/skills/$slug` | Same Team routes. Personal maps to Activity, Computer, Credentials and Skills under Settings, with path suffix carried where applicable. |
| `/admin/plugins`, `/admin/plugins/$key`, `/admin/plugins/$key/bots/$agentId`, `/admin/plugins/$key/tools/$tool`, `/admin/plugins/arcade`, `/admin/plugins/composio` | Same Team routes. Personal maps to Connections, broker browse or Connection detail, as applicable. |

Other Team Admin bookmarks fall back to Settings on Personal. Route visibility and API authorization remain separate checks.
