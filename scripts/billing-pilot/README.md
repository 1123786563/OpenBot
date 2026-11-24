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
