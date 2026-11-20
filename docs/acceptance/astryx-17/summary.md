# Issue #17 acceptance summary

Rehearsed a deployment-scoped Astryx switch and rollback using production Web bundles and isolated OpenBot servers backed by PostgreSQL 17.12 with pgvector. Chromium 151 ran against the same loopback origin and database for each edition. The existing legacy artifact came from integration base `2ba5cd608fb92431a6ddc6ee5b6268170e80c50c`. The enabled artifact included the Activity bookmark fix.

- Personal passed legacy, Astryx and rollback. The same private Bot, Conversation and saved component draft were readable throughout. The old Admin audit bookmark continued to open Personal Activity in Settings.
- Team passed legacy, Astryx and rollback. The same private Bot, Conversation and unpublished component draft were readable throughout, including the draft in the Admin editor. The signed-in member received 404 for the other user's private Bot and 403 from the Admin API. The Admin bookmark sent that member home.
- Personal enabled first while Team served its original bundle. Team then enabled separately. Each rollback returned its original HTML digest while the other deployment kept its selected bundle.
- The browser exercised all four saved profile settings. It checked old Tasks, Routines, Memories, Activity, Ideas and Goals URLs against the unified destinations, including the Personal Memories fallback. The previous Astryx build sent the Activity link to home for the standard profile. The candidate kept the bookmark in the unified shell and opened the user's chosen Bot's activity.
- Both editions retained their saved profile and dark appearance between phases and rendered in light and dark. Both builds showed the custom tenant name. The enabled build loaded the custom mark and applied both configured accents. Narrow navigation opened with Enter, closed with Escape, and restored focus. The legacy Create Bot deep link opened its dialog after enablement.
- Both Web production builds and Web type checks passed. The targeted regression suite passed with the flag off (93 passed, 2 skipped) and on (95 passed).

The saved draft fixture was a component draft. Unsent Conversation text was lost on ordinary reload in every phase, including the legacy baseline. The rehearsal did not exercise external SSO, live integrations, or real model turns. The route inventory is exhaustive against the registered Web router, with browser coverage recorded per URL and deployment. Feature identities, conversations and components in the logs are disposable rehearsal records.

[Route inventory](../../astryx-web-route-inventory.md) · [Rollout and rollback procedure](../../astryx-web-rollout.md) · [Browser and artifact evidence](rehearsal.json)
