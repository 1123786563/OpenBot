# Casdoor account status for the private trial

Use this provider with a dedicated Casdoor organization and confidential application on the Casdoor SQLite deployment. The local trial prototype ran with image `casbin/casdoor-all-in-one@sha256:710df7fcb2d05ddc590cf78a6862ec61026a140c1a02ec6a40392dc24dabf7f9`. Pin the Casdoor image and repeat the acceptance checks below before adopting another build or changing the account mutation paths.

Casdoor must use a persistent local SQLite volume in WAL mode with `synchronous=FULL`. For the pinned image, set `dataSourceName` to `file:/data/casdoor.db?cache=shared&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)`. Keep the database, WAL, and shared-memory files on the same local filesystem and mount the whole directory into the provider. Both the Casdoor writer and the provider reader must support `unixepoch('subsec')` (SQLite 3.42 or newer). Use the Casdoor `JWT-Standard` token format with the stable `user.id` as OIDC `sub`. The organization and subject must remain stable for the entire lifetime of a trial account.

The provider installs triggers on the Casdoor `user` table. It records accounts created inactive, transitions from active to forbidden or soft-deleted, and physical deletes of active accounts. Each history row commits with the user mutation. An account already inactive retains its existing event if subsequently deleted. The provider reads capture configuration, current application credentials, account status, and complete disablement history within one SQLite read transaction. Missing or changed capture schema and unknown subjects produce HTTP 503. Retain the history for the entire lifetime of the issuer and preserve it when backing up the Casdoor database. Keep the status route out of service if a restore or maintenance operation creates a gap in the history.

## Install and run

1. Let Casdoor initialize the database. Create the dedicated organization and application before enabling account creation. Run the installer against this empty organization before it has ever admitted an account. A preexisting organization with trial accounts cannot establish its prior history through this installer.
2. Build the provider image from this repository.

   ```sh
   docker build -t openbot-casdoor-account-status docker/casdoor-account-status
   ```

3. Set `CASDOOR_SQLITE_PATH=/data/casdoor.db`, `CASDOOR_ISSUER` to the exact discovery issuer, and `CASDOOR_TRIAL_ORGANIZATION` to the dedicated organization name in a restricted environment file named `casdoor-status.env`. Add the confidential application's `CASDOOR_CLIENT_ID` and `CASDOOR_CLIENT_SECRET` from the same secret source as OpenBot. On secret rotation, update OpenBot and restart the provider with the new credentials. To install, use the writable volume that the Casdoor process uses. Here `trial-casdoor` is the deployment's volume name.

   ```sh
   docker run --rm --network none --env-file casdoor-status.env \
     --volume trial-casdoor:/data openbot-casdoor-account-status install
   ```

4. Run the endpoint with the Casdoor volume mounted read-only, in the HTTPS ingress network namespace. The example uses an existing container named `trial-https-gateway`. Keep the listener on loopback with no published port. The default port is 19444. Set `CASDOOR_ACCOUNT_STATUS_PORT` if that port is already in use.

   ```sh
   docker run -d --name trial-casdoor-account-status --restart unless-stopped \
     --network container:trial-https-gateway --env-file casdoor-status.env \
     --volume trial-casdoor:/data:ro openbot-casdoor-account-status
   ```

5. In the existing Casdoor HTTPS virtual host, forward the exact status path to the provider. Apply the same private network restriction as the trial, permit OpenBot's egress, and exclude request bodies from ingress logs. In OpenBot set `CASDOOR_ACCOUNT_STATUS_URL` to the Casdoor HTTPS origin followed by `/openbot-account-status`. Synchronize the Casdoor and OpenBot host clocks.

   ```nginx
   location = /openbot-account-status {
       client_max_body_size 4k;
       proxy_connect_timeout 1s;
       proxy_read_timeout 5s;
       proxy_pass http://127.0.0.1:19444;
   }
   ```

## Verify before admitting accounts

Run `python3 -B -m unittest discover -s docker/casdoor-account-status -v` with a Python build that links to SQLite 3.42 or newer. The tests use fresh SQLite databases and exercise the HTTP endpoint, authentication, a short disablement, deletion, and racing writes.

Repeat the following on the intended Casdoor build and ingress using a disposable account in the trial organization.

1. Sign in and compare the OIDC `sub` to the provider's active response for that subject. Check that an incorrect client secret is rejected and a subject from another organization yields 503.
2. Forbid and immediately re-enable the account between OpenBot polls. Check that the next status response reports an active account and retains the disablement event. Confirm that OpenBot revoked the old Application Session and that recovery requires a new sign-in.
3. Exercise the admin mutation paths enabled for the trial, including the supported soft-delete and physical-delete paths. Verify the returned inactive state, persistent event IDs, and OpenBot cutoff. Restart the sidecar and repeat the same status request to check history retention. Also exercise the fail-closed behavior on an isolated copy with an unavailable database or removed trigger.
