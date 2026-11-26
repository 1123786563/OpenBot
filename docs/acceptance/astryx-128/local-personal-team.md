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
