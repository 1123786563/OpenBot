# Enable the Bifrost skill market

OpenBot's team edition can browse the Bifrost Skills Repository under
**Capabilities → Skills → Skill market**. All signed-in team-edition users
can see the configured Bifrost catalog. Use a Bifrost repository whose
contents are suitable for that audience.

1. Initialize the pinned Bifrost v2.6.0 service with its PostgreSQL config store.
2. As a PostgreSQL role administrator, create a dedicated login named
   `openbot_skill_reader`. Give it no role memberships. Set its password
   with `\password openbot_skill_reader` in `psql`.
3. As the Bifrost database owner, apply [skill-market-reader.sql](skill-market-reader.sql)
   to the Bifrost database before publishing or importing any versions. The script
   installs the publication trigger and grants the reader `SELECT` on the
   catalog views and package seals. Allow the reader to connect to the Bifrost database
   through the private PostgreSQL endpoint.
4. Put `BIFROST_SKILL_MARKET_DATABASE_URL` in the OpenBot server's private
   environment. Use the reader login and the Bifrost database name. For
   the middleware Compose deployment, set it in `.env.server`.
5. Recreate OpenBot with the reader configured. Use the registry proxy on the
   Bifrost loopback port for authorized administration. Keep gateway and
   registry access on trusted networks.

Bifrost is the active catalog. Installed snapshots and uninstalls work after
SkillHub retirement. See the [historical cutover runbook](skill-market-cutover.md)
for the migration and retained archives.

## Package files

Publish attachment content as text, a data URL, or an upload backed by
Bifrost's PostgreSQL blob store. Native Bifrost publication records a seal
for each version in the same PostgreSQL transaction. This separate record
binds the repository identifiers, Markdown, frontmatter, and every attachment
path and byte digest. OpenBot checks the seal against the exact version in a
consistent database snapshot before preview or ZIP creation. Administrators
approve eligible fingerprints in OpenBot before installation. The reader
accepts up to 256 attachments and 32 MiB of uncompressed package data.

Keep seals with the Bifrost database backups. The seal trusts Bifrost's
publication transaction and the database owner. It detects later storage
changes and missing data. Versions published before the trigger was installed
have no trusted seal. To qualify one, publish a new version from an
independently retained, verified package. Never seal current rows retroactively.

Configure the PostgreSQL blob store for this deployment. Bifrost's upstream
object-storage attachments lack locally verifiable bytes and are outside this
reader's supported storage contract. Object-storage references, mutable URL
sources, missing file rows, and missing or altered blobs fail closed, including
for otherwise valid SKILL.md content.

## Rehearse locally

Install the locked workspace dependencies, then run the isolated rehearsal.

```sh
bun install --frozen-lockfile
bash deploy/bifrost/rehearsal/verify.sh --skill-market
```

The rehearsal exercises exact-version downloads, the database reader grants,
native route privacy, and direct and routed inference. All services use a
private Docker network and synthetic data.

For a SkillHub cutover, follow the [cutover runbook](skill-market-cutover.md).
