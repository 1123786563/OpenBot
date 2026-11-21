# Astryx Web

The normal Web build serves Astryx for Personal and Team. Set `OPENBOT_EDITION` on the API to select the edition.

```sh
bun run --cwd app build
APP_PORT=3405 SERVER_PORT=3404 bun --cwd app serve.ts
```

Use the [deployment guide](configuration.md) to configure the API and PostgreSQL. Team uses the API's sign-in configuration. Personal opens directly when configured for local use.

Set `tenant.product_name` in the tenant package's `brand.yaml` and pass that package to the Web build with `TENANT_PACKAGE_DIR`.

| Build variable | Value |
| --- | --- |
| `VITE_OPENBOT_ASTRYX_BRAND_LOGO` | Browser-accessible URL for the shell mark. Defaults to the bundled OpenBot mark. |
| `VITE_OPENBOT_ASTRYX_ACCENT_LIGHT` | Six-digit hex color for the light appearance. Defaults to `#5148AE`. |
| `VITE_OPENBOT_ASTRYX_ACCENT_DARK` | Six-digit hex color for the dark appearance. Defaults to `#BAB7FF`. |

Web reads the existing light or dark appearance preference. The [route inventory](astryx-web-route-inventory.md) lists the legacy bookmarks and their destinations. The [rollout rehearsal](astryx-web-rollout.md) records the original pilot and how to use an archived pre-retirement artifact for rollback.
