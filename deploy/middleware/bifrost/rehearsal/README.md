# Bifrost HTTP transport upgrade rehearsal

On 2026-11-23, the latest stable Bifrost HTTP transport release was
`transports/v2.6.0`. The default deployment image uses the release tag and an
immutable OCI index digest.

- Candidate: `maximhq/bifrost:v2.6.0@sha256:5968d007ba4f74ee01bc4ceb071decb9927a0b7bb43dbb9072208f75e2d522e3`
- Baseline: `maximhq/bifrost:v2.4.0@sha256:a1c90607dcfd13c1fb2f9476ceb3bb24407a50ade7fdf3e61a59fb42b09e5c57`

See the [official HTTP transport release](https://github.com/maximhq/bifrost/releases/tag/transports%2Fv2.6.0).

Run the rehearsal from the repository root with Docker and Docker Compose.

```sh
bash deploy/middleware/bifrost/rehearsal/verify.sh
```

The script starts real Bifrost and PostgreSQL images in an internal Docker
network with no published ports. The v2.4.0 gateway seeds PostgreSQL with a
synthetic provider, virtual key, and model routing rule. The script dumps the database and
restores it into a separate database. The v2.6.0 gateway starts with a fresh
container filesystem and reads its provider, routing rule, and administrator
credentials from the restored snapshot. The provider and pricing data stay
local to the fixture.

## Verification on 2026-11-23

The isolated rehearsal ran on Linux ARM64. The Compose check first failed
against the v2.4.0 default and then passed with the pinned OCI index.
Both real gateway images returned the expected fixture response for
`openai/gpt-4o-mini` and `fixture-alias`. The v2.6.0 gateway used the restored
PostgreSQL configuration and the same fixture virtual key.

The administrator published `1.0.0` with a script, a nested reference,
and a binary asset. After publishing `1.1.0`, the exact-version management
request returned the `1.0.0` instructions and all three attachment paths.
The raw file route follows the served version. The rehearsal temporarily
served `1.0.0` and verified all three files byte for byte before restoring
the serving pointer to `1.1.0`.

The remaining rollout check for [issue #135](https://github.com/1123786563/OpenBot/issues/135)
requires an approved copy of the existing deployment's pre-upgrade PostgreSQL
configuration and authorized test credentials for its configured provider
routes. This rehearsal uses synthetic data and a local upstream. It exercises
the database upgrade and gateway requests without production access.
