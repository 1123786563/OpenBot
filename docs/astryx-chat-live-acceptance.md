# Astryx chat live acceptance for #168

Tested on 2026-11-24 at integration commit `42d664fdb` with the production web build, an isolated API and Postgres database, and the configured CopilotKit Intelligence project. The browser ran in T3 Preview with the General Assistant and a single-user administrator.

| Check | /bot | Conversation |
| --- | --- | --- |
| Enter in the composer | Submitted a real run and showed Thinking and Stop the Bot | Submitted a real run and showed Thinking and Stop the Bot |
| Shift+Enter in the composer | Inserted a newline without sending | Inserted a newline without sending |
| Model error | Showed that the model provider rejected the key and returned the message to the composer | Showed the same error and returned the message to the composer |
| Reload | Fetched the same Intelligence thread and restored the submitted messages and unsent draft | Fetched the same Intelligence thread and restored the submitted message |
| Successful streaming text, Copy reply, completed assistant reply restore, tool activity, approval resume | Pending successful model run | Pending successful model run |

The earlier isolated run logged connection-refused errors for both its Intelligence entitlement request and its separate computer endpoint. Its effective Intelligence URL and process environment were unavailable for comparison. With the private test config's `CPK_INTELLIGENCE_API_KEY`, the configured Intelligence endpoint returned HTTP 200 from `/api/entitlements/runtime`. On both routes, `POST /api/copilotkit/agent/general-assistant/run` returned HTTP 200 and the stream ended with a run error. Both thread messages requests returned HTTP 200 on reload. The Intelligence transport worked in this run. The test model endpoint returned HTTP 401, as did a direct chat completion with the primary checkout's configured model credential. Local Bifrost listed zero models and rejected its currently configured Bot model because the OpenAI provider was missing. The computer endpoint was left isolated and had no running computer, which also blocks computer-backed approval checks.

## Reproduce

1. Check out `42d664fdb` with dependencies installed. Link the private `.env.test` as described in AGENTS.md. Generate app config and build the app for production.
2. Start a disposable `pgvector/pgvector:pg17` database on loopback. Create a private API env file with its `DATABASE_URL`, `OPENBOT_SINGLE_USER=true`, `PORT=35469`, `OPENBOT_APP_URL=http://localhost:35470`, and `TRUSTED_ORIGINS=http://localhost:35470`. Copy `KEY_ENCRYPTION_KEY`, `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `CPK_INTELLIGENCE_API_KEY`, `COPILOTKIT_LICENSE_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `BOT_MODEL` from the private test config. Set `AGENT_COMPUTER_URL=http://127.0.0.1:35479` to keep this run off shared computers.
3. From `server/`, run `bun --no-env-file --env-file="$acceptance_env" scripts/migrate.ts`, then use the same flags for `src/index.ts`. From `app/`, run `APP_PORT=35470 SERVER_PORT=35469 node node_modules/vite/bin/vite.js preview --host localhost --strictPort`.
4. Open `http://localhost:35470/bot`, finish onboarding and send a short Markdown reply request with Enter. To create a separate Conversation, POST `{"agentIds":["general-assistant"]}` to `/api/channels` and open `/channel/<returned channel.id>`. Repeat on that route. Refresh each route and verify its prior user message. Use Shift+Enter in each composer and verify a two-line draft without a new run.
5. With a working model credential, repeat with a prompt that produces several lines of Markdown. Observe in-progress and settled rendering, use Copy reply and compare the clipboard to the Markdown in the response, then reload and compare the restored transcript. Use an isolated computer with a harmless approval-gated action to verify tool state and approval resume on both routes.

## Bifrost follow-up on 2026-11-24

Candidate `229c4233a` passed the workspace production build and typecheck. The Chromium A2UI frame fixture passed all three tests, including light and dark form legibility. That fixture run did not force a retry.

The local Bifrost gateway was the only Bifrost inference endpoint found in the project configuration and running services. Its model catalogue returned HTTP 200 with zero entries, both anonymously and with the configured server credential. A streaming Chat Completions smoke request for the deployment's configured model, `openai/qwen2.5-0.5b`, returned HTTP 400 for a missing provider in both cases. The gateway listener became unreachable during the browser run and remained unreachable on both loopback addresses. The test configuration also pointed to a direct provider already covered in the preceding run. No working Bifrost model was available for selection.

The production build ran in T3 Preview against a disposable API and Postgres database with a single-user administrator. On both `/bot` and a Conversation opened through `/channel/<id>`, Shift+Enter inserted a newline and Enter submitted the two-line message. Both routes displayed Thinking and eventually showed the connection-refused error after three attempts. The submitted prompt was visible again after reopening each route. The Conversation was created through the documented channel API, and the `/bot` composer was focused by click. In Conversation, the composer had focus when the route opened.

Live response rendering, clipboard contents, and completed assistant restoration need a reachable Bifrost endpoint with a model that passes streaming inference. Tool cards, approval resume including reopening a pending approval, and Tab navigation to approval and A2UI fields also need a tool-capable model and a disposable computer. Live light and dark screenshots of those states and the Personal and Team role checks remain open.
