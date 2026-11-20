# Astryx Web production rollout and rollback

Enable Astryx per deployment by changing the Web build. The selected mechanism is `VITE_OPENBOT_ASTRYX_PILOT=1` at Vite build time. Build the rollback artifact with `VITE_OPENBOT_ASTRYX_PILOT=0`, or retain the already deployed compatible legacy artifact. Personal and Team use the same Web switch. The API's `OPENBOT_EDITION` continues to determine the edition.

The [route and profile inventory](astryx-web-route-inventory.md) lists all 97 normalized Web routes, the four legacy profiles, and compatibility destinations.

## Prepare the release

1. Pin the source commit and the current off artifact. Keep the Web API routes, public origin, authentication, tenant package and PostgreSQL connection on their current configuration. If the API also needs a feature release, deploy and validate that separately before this Web switch.
2. Build and archive both Web bundles. Use the same tenant package for both, with the deployment's `tenant.product_name`. Set `VITE_OPENBOT_ASTRYX_BRAND_LOGO`, `VITE_OPENBOT_ASTRYX_ACCENT_LIGHT` and `VITE_OPENBOT_ASTRYX_ACCENT_DARK` when the deployment supplies them. The off build renders its existing brand and skin styles. Record each artifact digest and serve an immutable directory or image for each revision.

   ```sh
   bun install --frozen-lockfile
   export TENANT_PACKAGE_DIR=/absolute/path/to/tenant
   VITE_OPENBOT_ASTRYX_PILOT=0 bun run --cwd app build --outDir /absolute/path/to/legacy
   VITE_OPENBOT_ASTRYX_PILOT=1 bun run --cwd app build --outDir /absolute/path/to/astryx
   bun run --cwd app typecheck
   ```

   When serving the image through OpenBot's built-in static hosting, package the matching bundle under `APP_DIST_DIR` (the stock image uses `/app/app/dist`). The stock Dockerfile builds the default Web UI. Setting a Vite variable in a running container leaves its compiled bundle as it was. For a separate Web service, use its existing static root and API proxy. Keep the previously published hashed assets reachable through the rollout window so open tabs can still load their lazy chunks. Serve or revalidate HTML and cache hashed assets independently.
3. Check initial Web/API health and baseline access as a regular user and as an admin in Team. Use a known Bot, Conversation and saved draft, bookmarks and both appearances. Ask people in a scheduled rollout window to finish or copy unsent composer text before refreshing their tab.

## Enable and observe

1. Start with one designated deployment and activate only its Astryx artifact. Check the shell, the six profile screen bookmarks, role and edition routing, an existing Bot and Conversation, a saved draft, and light and dark. Check static asset failures, JavaScript errors and API authorization rates against that deployment's baseline.
2. Expand to a representative deployment of the other edition after the first canary passes. Keep a mix of legacy and Astryx deployments during this stage. Continue one deployment cohort at a time after their gates pass.
3. Roll back the affected deployment on a broken working bookmark, lost saved data, authorization regression, or unrecoverable asset or shell error. Hold expansion until the discrepancy is understood.

## Roll back

Activate the archived off artifact at the same public origin. Restore its HTML and asset routing, then verify its digest and reload a browser tab with the existing session. Confirm legacy profile selection and appearance, Bot and Conversation access, saved draft, role checks and old bookmarks. Existing data and browser storage stay in place throughout. In the off build an old skin-specific bookmark is usable in the corresponding legacy profile. Keep that bundle and evidence through the retirement decision.

## Isolated reproduction

The rehearsal used two instances of `server/src/index.ts`, separate PostgreSQL 17 databases using pgvector, and two copies of the unchanged production `app/serve.ts` with independent `dist` pointers. The API, process and database stayed up during every Web switch. Deployments used a temporary copy of `examples/personal` with `tenant.product_name: Northstar QA`. The Astryx build used a local SVG mark at `/issue17-brand.svg` and accents `#245589` and `#9bd0ff`.

1. Start `pgvector/pgvector:pg17` bound to loopback port 34917, with disposable password `issue17`. Create `personal` and `team` databases and run `bun run --cwd server db:migrate` once against each. The URL for each is `postgres://postgres:issue17@127.0.0.1:34917/<edition>`.
2. Start from the `server` directory with the matching `DATABASE_URL`, `PORT` (34918 Personal, 34919 Team), `OPENBOT_EDITION`, absolute `TENANT_PACKAGE_DIR`, and a disposable `KEY_ENCRYPTION_KEY`. Set `OPENBOT_OTEL_EXPORT=off`, `OPENBOT_PRODUCT_TELEMETRY=0` and `COPILOTKIT_TELEMETRY_DISABLED=true`. For this routing rehearsal only, set `INTELLIGENCE_API_URL=http://127.0.0.1:34929`, `INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:34929` and a disposable `INTELLIGENCE_API_KEY`. Personal also needs `OPENBOT_SINGLE_USER=true` and `AGENT_COMPUTER_URL=http://127.0.0.1:34929`. Run `bun src/index.ts`.
3. Team requires nonempty Google OAuth client ID and secret for boot. Use local placeholders, `BETTER_AUTH_URL=http://127.0.0.1:34921`, the disposable secret from the browser script and `INITIAL_ADMIN_EMAILS=admin@issue17.test`. Preload these signed-in role fixtures into the **Team fixture database**. This bypasses the external identity-provider exchange while exercising the actual session resolver and authorization.

   ```sql
   INSERT INTO users (id,email,name,email_verified,onboarding_completed_at,preferences) VALUES
     ('issue17-admin','admin@issue17.test','QA admin',true,now(),'{"skin":"openmuse"}'),
     ('issue17-member','member@issue17.test','QA member',true,now(),'{"skin":"opendots"}');
   INSERT INTO user_roles (user_id,role) VALUES
     ('issue17-admin','admin'), ('issue17-member','user');
   INSERT INTO sessions (id,user_id,token,expires_at) VALUES
     ('fixture-admin','issue17-admin','issue17-admin-token',now()+interval '1 day'),
     ('fixture-member','issue17-member','issue17-member-token',now()+interval '1 day');
   ```

   In the **Personal fixture database**, finish onboarding for the local user after boot. The harness tests an existing signed-in account in both editions.

   ```sql
   UPDATE users SET name='QA personal',onboarding_completed_at=now()
     WHERE id='dev-local-user';
   ```

4. Build the branded bundles above and add the test SVG to the enabled output. Create one disposable directory per edition under `app`, copy `app/serve.ts` into each, and point each directory's `dist` symlink at the legacy artifact. Launch both copies with the correct `SERVER_PORT` and with `APP_PORT=34920` (Personal) or `34921` (Team). Use a same-directory symlink rename to switch each artifact pointer atomically.
5. Install the locked Chromium with `bunx playwright-core install chromium`. Create `/tmp/openbot-issue17` or supply an existing `ISSUE17_DIR`; the harness saves browser storage there. Run `bun scripts/acceptance/astryx-rollout.mjs personal before` and the same command for `team`. Run `enabled` after enabling each canary and `rollback` after restoring its off bundle. Capture stdout as JSON. The harness creates a private Bot and Conversation through the real API on the first pass, saves a component draft and checks those same records on later passes.

The Team fixture uses Better Auth sessions with a real PostgreSQL backing store. The rehearsal uses no model turns, connected-app consent round trips, external identity-provider exchange, active browser/computer, or generated Bot output. Personal drafts were verified through the component API. Team drafts were additionally opened in the Admin editor. Unsent composer text was lost on reload on the off build as well as Astryx. The new-composition recipient link remained usable. Existing pre-release shell bundles use the deployment name but apply their own marks and colors. The custom Astryx mark and accent checks apply to the enabled bundle.
