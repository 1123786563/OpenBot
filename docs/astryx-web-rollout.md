# Astryx Web production rollout and rollback

Astryx is the default Web interface in Personal and Team. The API's `OPENBOT_EDITION` selects the edition at runtime. Current builds use the default Vite entry point. Issue #18 retired `VITE_OPENBOT_ASTRYX_PILOT`.

The [route and profile inventory](astryx-web-route-inventory.md) lists the Web routes and legacy bookmarks.

## Deploy the current Web build

1. Record the release commit and archive the deployed bundle with its digest and hashed assets.
2. Build the candidate with the deployment's tenant package. Set `VITE_OPENBOT_ASTRYX_BRAND_LOGO`, `VITE_OPENBOT_ASTRYX_ACCENT_LIGHT`, and `VITE_OPENBOT_ASTRYX_ACCENT_DARK` at build time if the deployment supplies those values.

   ```sh
   bun install --frozen-lockfile
   export TENANT_PACKAGE_DIR=/absolute/path/to/tenant
   bun run --cwd app typecheck
   bun run --cwd app build --outDir /absolute/path/to/candidate
   ```

3. Serve the candidate at the existing public origin. If OpenBot serves the bundle, put it under `APP_DIST_DIR` (`/app/app/dist` in the stock image). Keep the previous hashed assets reachable during rollout so open tabs can still load their chunks.
4. Canary one deployment. Verify sign-in, role checks, a Bot, a Conversation, a saved draft, old bookmarks, and both appearances. Compare asset failures, JavaScript errors, and API authorization rates with the baseline. Repeat in the other edition before expanding rollout.

## Roll back the current deployment

Restore the previous compatible Web artifact at the same origin. Restore its HTML and asset routing and verify its recorded digest. Reload with the existing session and check role access, saved data, and bookmarks. If you need to restore the legacy interface after #18, use the archived #17 legacy artifact or rebuild it at the pinned revision below.

## Isolated reproduction

This archived procedure records the #17 switch and rollback. Build the legacy bundle from `2ba5cd608fb92431a6ddc6ee5b6268170e80c50c` with `VITE_OPENBOT_ASTRYX_PILOT=0`. Build the Astryx bundle from `8569d4d929fc0839972915e2679a5650f58975b7` with `VITE_OPENBOT_ASTRYX_PILOT=1`. Run the build command above from each historical checkout and archive each output separately. The [#17 acceptance summary](acceptance/astryx-17/summary.md) records the original results.

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

4. Build the two historical bundles with the fixture brand and add the test SVG to the enabled output. Create one disposable directory per edition under `app`, copy `app/serve.ts` into each, and point each directory's `dist` symlink at the legacy artifact. Launch both copies with the correct `SERVER_PORT` and with `APP_PORT=34920` (Personal) or `34921` (Team). Use a same-directory symlink rename to switch each artifact pointer atomically.
5. Install the locked Chromium with `bunx playwright-core install chromium`. Create `/tmp/openbot-issue17` or supply an existing `ISSUE17_DIR`; the harness saves browser storage there. Run `bun scripts/acceptance/astryx-rollout.mjs personal before` and the same command for `team`. Run `enabled` after enabling each canary and `rollback` after restoring its off bundle. Capture stdout as JSON. The harness creates a private Bot and Conversation through the real API on the first pass, saves a component draft and checks those same records on later passes.

The Team fixture uses Better Auth sessions with a real PostgreSQL backing store. The rehearsal uses no model turns, connected-app consent round trips, external identity-provider exchange, active browser/computer, or generated Bot output. Personal drafts were verified through the component API. Team drafts were additionally opened in the Admin editor. Unsent composer text was lost on reload on the off build as well as Astryx. The new-composition recipient link remained usable. Existing pre-release shell bundles use the deployment name but apply their own marks and colors. The custom Astryx mark and accent checks apply to the enabled bundle.
