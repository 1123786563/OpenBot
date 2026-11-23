# Switch the OpenBot skill market to Bifrost

Use this runbook for an authorized deployment of [issue #140](https://github.com/1123786563/OpenBot/issues/140). Keep a private record of the release revision, image digest, receipt ID, checks, timestamps and operator decisions. Run the isolated rehearsal from a checkout with locked dependencies installed:

```sh
bun install --frozen-lockfile
bash deploy/middleware/bifrost/rehearsal/verify.sh --skill-cutover
```

The rehearsal uses the real pinned Bifrost v2.6.0 gateway, synthetic SkillHub data and HTTP responses, and fresh PostgreSQL databases. It runs the inference upgrade, exact package and migration checks, then exercises publication and OpenBot market routes, Bot invocation and approval continuation. It injects a Bifrost reader failure, falls back while frozen, and tests recovery and a simulated SkillHub stop. The Docker network is internal and publishes no ports.

## Prepare and freeze

1. Verify the Bifrost image, reader grants and model traffic against the deployment. Deploy the Bifrost registry proxy from its Compose file. The host's original Bifrost loopback port now belongs to that proxy. Keep inference on the existing middleware ingress and route administrators' Bifrost sessions through the registry proxy. Keep the gateway's raw container port private to the Bifrost network. If Bifrost is deployed without this Compose file, reproduce the same single-ingress boundary before continuing.
2. Install the revised [SkillHub OpenResty location](../skillhub/openresty-location.conf) on the live SkillHub host. Check that publishing and moderation clients use it. Restrict the raw SkillHub loopback ports and direct SkillHub container HTTP access, including on the shared PostgreSQL network. Restrict the Bifrost container network to deployment operators. Inventory tunnels, alternate ingress and automation, and stop any publisher that can reach a backend directly. Drain already admitted publication requests and wait for in-flight SkillHub moderation or scanner jobs that could publish. Keep workers needed for reads running.
3. Copy [the freeze include](../openresty/skill-market-write-freeze.conf) to both registry proxies. In the Bifrost Compose directory use `publication-freeze.d/freeze.conf`. For SkillHub use `/www/openbot-middleware/private/publication-freeze.d/freeze.conf` as seen from the OpenResty process. Test and reload both proxies. For Bifrost, run `docker compose exec registry-proxy nginx -t` and `docker compose exec registry-proxy nginx -s reload` with the deployment's Compose configuration. Use the deployment's normal config test and reload for OpenResty. Wait for old workers to drain. Verify 503 on authenticated publishing and moderation through the regular URLs. Check SkillHub catalog reads, Bifrost skill reads and model inference.
4. Set `SKILL_MARKET_WRITES_FROZEN=true` on every OpenBot API replica and drain old instances before taking the final inventory. Confirm that install, version switch, command assignment and review changes receive 503. Use a disposable installed Bot to verify invocation, then emergency-disable an exact version and verify the effect. Market reads, installed invocation, uninstall and emergency disablement operations remain available.
5. Follow the [migration and receipt runbook](skill-market-migration.md) using the final matched SkillHub snapshot and the same OpenBot database that serves the deployment. Retain the snapshot, object store and verified receipt. Use an operator-only importer on the Bifrost network during the freeze. The importer can reach the private backend for migration writes while publisher ingress stays frozen. Revoke that temporary direct access after import. Verify package identity and record the receipt before switching the catalog.

## Check before reopening

Keep SkillHub running. Set `BIFROST_SKILL_MARKET_DATABASE_URL` on every OpenBot API replica, retain the SkillHub reader configuration, and leave all freezes active until the operator checks and records each result below.

- A signed-in team member can browse the Bifrost catalog. Anonymous market access is refused.
- An exact historical version downloads the intended `SKILL.md` and all attachment bytes after the Bifrost serving pointer advances. Compare the extracted package manifest with the receipt.
- A legacy Bot's slash command invokes the same installed version while the catalog points to Bifrost.
- A tool approval created before the switch continues with the pinned legacy version and executes once when allowed.
- A second approval created before the switch remains blocked if an administrator emergency-disables its exact version. Confirm that the equivalent identity carries the same disablement. Restoring the version allows new invocations and leaves already-paused runs paused.
- Authenticated publication and new installs remain blocked, including legacy catalog URLs.

If any check fails, keep the freezes in place. Remove `BIFROST_SKILL_MARKET_DATABASE_URL` on every OpenBot API replica and deploy the same release against the same OpenBot database. Verify SkillHub browse and exact download, an installed invocation, and the freeze. Leave the imported packages and recorded receipt in place. Fix the failed check and repeat the frozen switch, or explicitly abort and reopen the legacy registry and OpenBot after the legacy checks pass.

## Reopen and recover

After the frozen checks pass, clear `SKILL_MARKET_WRITES_FROZEN` on every OpenBot API replica and remove the Bifrost proxy freeze include. Test and reload the proxy. Keep SkillHub publication frozen. Review eligible Bifrost versions against their exact fingerprints in OpenBot. Record a sample approved review, fresh install, version switch and emergency disablement using disposable test resources. Verify each through the normal OpenBot entry points.

If a regression appears after reopening, restore the OpenBot and Bifrost freezes first and drain in-flight writes. If needed, temporarily select the SkillHub catalog by clearing the Bifrost reader URL. Continue using the same OpenBot database and release. Preserve the Bifrost database and blobs with all writes accepted after reopening. Keep both registries frozen while repairing and then reselect Bifrost. Compare exact installed snapshots, review fingerprints and emergency disablements with the recorded state before reopening again. A pre-cutover database or object-store restore would discard accepted writes. For storage loss, recover the latest consistent state, including post-reopen writes, before serving the market.

## Retire SkillHub

Repeat the acceptance checks on the actual deployment and record operator sign-off before stopping SkillHub. Keep the matched SkillHub database and storage archive. Stop its service without removing volumes. Remove the legacy reader settings from OpenBot and verify signed-in browse, exact download, an approved fresh install and invocation with SkillHub unreachable. Recheck an existing legacy installation and emergency disablement. If the smoke fails, restore the service and legacy reader settings with publication frozen, then follow the recovery procedure.

After the shutdown smoke passes, retire SkillHub ingress and reader access and mark ADR 0010 as superseded by ADR 0012. The isolated rehearsal leaves this deployed acceptance and shutdown gate pending.
