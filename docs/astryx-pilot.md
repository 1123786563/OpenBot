# Astryx Bots preview

The preview covers the Bots list and the Create Bot sheet opened from the list or from a new conversation. The rest of the Web UI uses the existing layout and skin. The preview uses the same Bot routes, permission checks, and database as the OpenBot API it points to.

## Run the preview

Set up a separate local OpenBot server and PostgreSQL database using [the deployment configuration guide](configuration.md). Point the preview at that API. This example assumes the API is listening on port 3301.

```sh
VITE_OPENBOT_ASTRYX_PILOT=1 bun run --cwd app build
APP_PORT=3310 SERVER_PORT=3301 bun --cwd app serve.ts
```

Open `http://127.0.0.1:3310/bots`. Team edition uses the preview server’s normal sign-in configuration. Personal edition opens directly on the same machine. A standard Web build omits the preview when `VITE_OPENBOT_ASTRYX_PILOT` is unset.

## Preview a deployment brand

Set `tenant.product_name` in the tenant package’s `brand.yaml`. The Web build uses the package selected by `TENANT_PACKAGE_DIR`.

| Build variable | Value |
| --- | --- |
| `VITE_OPENBOT_ASTRYX_BRAND_LOGO` | URL of the mark to show on the preview Bots list. Defaults to the bundled OpenBot mark. |
| `VITE_OPENBOT_ASTRYX_ACCENT_LIGHT` | Six-digit hex color for the light appearance. Defaults to `#5148AE`. |
| `VITE_OPENBOT_ASTRYX_ACCENT_DARK` | Six-digit hex color for the dark appearance. Defaults to `#BAB7FF`. |

The preview uses the existing light or dark preference. Accent button text switches between black and white based on the fill color. The configured name, mark, and accent apply to the preview surfaces while the shared navigation remains part of the current skin.

## Visual review

Review the list and creation sheet in both appearances, including a narrow window. From the list, a successful creation opens the new Bot. From a new conversation, it adds a recipient to the draft. Sign off on the pilot visuals before migrating further surfaces. See [the migration decision](adr/0003-pilot-astryx-for-web.md).
