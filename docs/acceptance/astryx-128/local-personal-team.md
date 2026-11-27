# Local Personal and Team acceptance

On 2026-11-26, both editions served the production Web build from `405ab7172` through their own loopback origins and APIs. Both APIs returned HTTP 200 from their health endpoints. Each edition used a separate database in a disposable PostgreSQL instance. Personal used single-user mode. Team used signed local Better Auth sessions backed by PostgreSQL for an administrator and a regular member.

| Scenario | Personal | Team |
| --- | --- | --- |
| Settings | Opened | Opened as administrator and regular member |
| Admin Playground | Redirected to Settings | Administrator saw the editor and preview pane. Regular member was redirected to the home route. |
| `/bot` | Composer opened and draft was present after reload | Composer opened and draft was present after reload |
| Conversation | Created through the API, opened in Chromium, and submitted from the composer. HTTP 502 surfaced an error and the text was present after reload. | Same result as Personal |

The historical #17 browser script timed out on both editions after loading the Bots page on this candidate. The table records a separate Chromium pass against the current routes and labels. Team signed-in views exercise session and role checks with fixture accounts. Live OAuth exchange remains unverified.

The local Intelligence endpoint was unavailable. The configured GLM model returned HTTP 429 to a direct streaming probe from the existing Bot container. No successful stream or pending approval was created. Tool cards, approval resumption across builds, and live A2UI submission remain open. The local exercise used loopback services only. Canary deployment is deferred.

## Same-origin Web rollback

Served the historical local preview originally based on `161615a3`, switched to the production candidate, and restored the historical preview through one loopback origin. The historical preview’s index digest matches its original local acceptance record. Its source revision is a base revision because that preview included local changes.

| Phase | HTTP objects checked against build digests |
| --- | ---: |
| Historical preview | 785 |
| Candidate with historical hashed assets retained | 1,631 |
| Restored preview with candidate hashed assets retained | 885 |

The first rollback surfaced a verifier mismatch. It required previous builds’ public icon files at stable URLs even though the active build owns those paths. The verifier now checks the active build in full and checks retained builds’ hashed Vite files under `assets/`. The rerun passed all three phases. The archive and rollout regression suite passed eleven tests.

## Mock runtime and model checks

Chromium ran the production candidate in Personal and Team with the same local edition APIs and sessions. The fixture supplied the AG-UI event stream and approval state. Separately, the existing server integration test used an OpenAI-compatible mock model with OpenBot’s real approval service, PostgreSQL state and resume worker.

| Scenario | Result in Personal and Team |
| --- | --- |
| Streaming and tool card on `/bot` | The first chunk appeared while Stop the Bot and the running tool were visible. Releasing the stream showed the complete reply and the tool result. |
| A2UI on `/bot` | An `openbot/ui@1` form accepted the edited value. Its action payload carried `context.who = "Ada Edited"`, and the mock reply echoed that value. |
| Approval across Web builds | The older local Conversation build started a mock run and displayed its pending approval. The production candidate reopened the same Conversation at the same origin and submitted `allow_once` once. The fixture recorded continuation on the original Thread and run IDs. Reload showed the continuation and no second browser run was started. |

The old Conversation bundle had index SHA-256 `f88f274e50b2d928ef3ab8954a3605953e27c142ff62c5014122ebd246771f86`. The candidate’s index SHA-256 was `72a59a6227669b786c95a771f3b1a69005f64d6f1385cb8e997aa3c33f63190c`.

The server test independently verified one tool execution and a completed original run in persisted history. It used the existing voice-triggered direct-chat case. The Chromium switch exercised the Web approval UI against fixture state. The five focused UI suites passed 39 tests, including Chromium A2UI theme and failure isolation checks. Real-model acceptance and canary deployment are deferred.
