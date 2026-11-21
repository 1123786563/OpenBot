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

The adapter patch maps `max_completion_tokens` to Zhipu's native `max_tokens` field for `glm-5.3-flash` and removes conflicting passthrough keys. The build patch reapplies the `/zhipu-core` module replacement after `COPY transports/`, which otherwise overwrites `go.mod` before the final build.

The verified Zhipu cap result is recorded in [`docs/billing-zhipu-output-cap.md`](../../docs/billing-zhipu-output-cap.md).
