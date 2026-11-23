# Billing pilot backend baseline

Run from a clean checkout with Docker Engine, Buildx, Compose, Bash and `jq`.
Choose the target platform and a unique local tag. Keep evidence directories
outside the checkout. The acceptance run also takes a locally available OpenBot
backend image from a different build to exercise Worker version mismatch.

```sh
bash scripts/billing-pilot/test.sh
bash scripts/billing-pilot/build.sh /tmp/pilot-build openbot-pilot:local linux/arm64
bash scripts/billing-pilot/accept.sh /tmp/pilot-build /tmp/pilot-accept previous-openbot-image:local
```

The build records the source commit, archive hash, build arguments, Buildx
metadata, image ID and platform manifest. Acceptance boots an isolated Compose
project with PostgreSQL and a local AG-UI and Intelligence fixture. The smoke
uses the Bot run and Routines APIs and correlates a successful scheduled run
with the Worker dispatch log. It verifies the running image identity before and
after the smoke and tests rejection of a mismatched Worker and untraceable
Server. The script removes its Compose project and volume on exit.

Keep `inputs.json`, `buildx.json`, `build.log`, `image.json` and
`platform-manifest.txt` with the acceptance directory. `runtime-after.jsonl`,
`smoke.jsonl`, `worker-dispatch.jsonl` and the two `rejected-*.log` files record
the results. These results cover the isolated backend baseline; the Bifrost
provider and Harness checks are tracked in #89.

## Pinned Bifrost Zhipu adapter

The deployment image can be built from a pinned Bifrost checkout with the repository-maintained patches. The checkout must contain the patched `zhipu-core` and `transports` trees plus `Dockerfile.zhipu-proxy-go`.

```sh
bash scripts/billing-pilot/apply-bifrost-patch.sh /path/to/pinned-bifrost
cd /path/to/pinned-bifrost
GOPROXY=https://proxy.golang.org,https://mirrors.aliyun.com/goproxy,https://goproxy.cn,direct \
  docker buildx build --platform linux/arm64 \
  --file Dockerfile.zhipu-proxy-go \
  --tag openbot-bifrost:zhipu-cap-fixed --load .
```

The adapter patch maps `max_completion_tokens` to Zhipu's native `max_tokens` field for every `glm-*` chat model and removes conflicting passthrough keys. The build patch reapplies the `/zhipu-core` module replacement after `COPY transports/`, which otherwise overwrites `go.mod` before the final build.

The verified Zhipu cap result is recorded in [`docs/billing-zhipu-output-cap.md`](../../docs/billing-zhipu-output-cap.md).

## Run the Credit Pack checkout fixture

Use an isolated OpenBot instance and a migrated test database. On the test ledger, create Billing Accounts for the testers, publish a `credit_pack` with `upsertProduct`, and register and approve the test applications.

Set these variables on the OpenBot server.

| Variable | Value |
| --- | --- |
| `OPENBOT_CREDIT_PACK_TEST_ORIGIN` | The fixture origin, such as `http://127.0.0.1:9199` |
| `OPENBOT_CREDIT_PACK_TEST_TOKEN` | A disposable token with at least 24 URL-safe characters |
| `OPENBOT_CREDIT_PACK_TEST_MERCHANT` | A fixture merchant ID such as `fixture-local` |
| `OPENBOT_CREDIT_PACK_TEST_PRODUCT` | The published Credit Pack code |
| `OPENBOT_CREDIT_PACK_TEST_APPLICATION_IDS` | Comma-separated IDs of approved fixture paths |
| `OPENBOT_CREDIT_PACK_TEST_ACCOUNT_IDS` | Comma-separated Billing Account UUIDs eligible to place orders |

Give the fixture the same token. Set `OPENBOT_CREDIT_PACK_FIXTURE_CALLBACK` to `http://127.0.0.1:<OpenBot port>/api/billing/credit-pack-test/callback`. Run `bun --no-env-file server/scripts/credit-pack-test-fixture.ts` from the worktree root.

Sign in to OpenBot as an eligible tester and open **Credits → Test Credit Pack**. Place an order, prepare checkout, open the checkout link, and confirm the simulated payment. Return to Credits and select **Check payment** if the order is still pending. The order links to its paid credit source while the source has spendable credits.

The fixture holds payment records in memory. Keep it running through reconciliation. To stop new orders while retaining existing orders and callbacks, clear the account allowlist and restart OpenBot with the same fixture origin and merchant.
