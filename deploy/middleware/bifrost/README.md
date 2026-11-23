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
   to the Bifrost database. The script grants the reader `SELECT` on the
   three catalog views. Allow the reader to connect to the Bifrost database
   through the private PostgreSQL endpoint.
4. Put `BIFROST_SKILL_MARKET_DATABASE_URL` in the OpenBot server's private
   environment. Use the reader login and the Bifrost database name. For
   the middleware Compose deployment, set it in `.env.server`.
5. Apply the [OpenResty configuration](../openresty/openbot-middleware.conf)
   and restart OpenBot. Use the loopback Bifrost port for authorized
   administration. The middleware host rejects Bifrost's native skills
   routes and keeps its existing inference access rules.

Bifrost becomes the market search source when the reader URL is set. Keep
the SkillHub settings to retain reads and installation eligibility for
legacy SkillHub coordinates. Bifrost versions support preview and download.
Installation approval for Bifrost is a separate rollout step.

## Package files

Publish attachment content as text, a data URL, or an upload backed by
Bifrost's PostgreSQL blob store. OpenBot reconstructs `SKILL.md` from the
selected version's frontmatter and Markdown body. It checks the attachment
paths and stored byte lengths before returning a ZIP. The download accepts
up to 256 attachments and 32 MiB of uncompressed package data.

Mutable URL sources, object-store references, and missing or mismatched
blobs cause the download to fail. The version's PostgreSQL file rows are
the attachment manifest. Bifrost v2.6.0 does not store independent content
checksums for those blobs.

## Rehearse locally

Install the locked workspace dependencies, then run the isolated rehearsal.

```sh
bun install --frozen-lockfile
bash deploy/middleware/bifrost/rehearsal/verify.sh --skill-market
```

The rehearsal exercises exact-version downloads, the database reader grants,
native route privacy, and direct and routed inference. All services use a
private Docker network and synthetic data.

For a SkillHub cutover, follow the [catalog migration and verification
runbook](skill-market-migration.md).
