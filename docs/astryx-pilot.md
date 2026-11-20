# Astryx Web preview

The preview opens the Astryx Neutral shell, home, Bots list, and Create Bot sheet at their existing URLs. Create Bot still opens from the Bots list and the recipient picker in a new conversation. The preview also applies Astryx Neutral to Capabilities, Skills, Bot access, both component galleries, and Playground. Team Admin uses the preview frame and keeps its existing account-menu entry. The Admin overview, Providers, and Identity providers use Astryx Neutral. Other Admin pages keep their existing content under that frame. Settings and skin-specific screens keep their existing frames during the transition.

## Run the preview

Configure a separate OpenBot API and PostgreSQL database as described in the [deployment guide](configuration.md). This example uses API port 3404 and Web port 3405. Open `/` to start, or open `/bots` or `/channel/new` directly.

```sh
VITE_OPENBOT_ASTRYX_PILOT=1 bun run --cwd app build
APP_PORT=3405 SERVER_PORT=3404 bun --cwd app serve.ts
```

Team uses the API's normal sign-in configuration. Personal opens directly when the API is configured for local use. Build with `VITE_OPENBOT_ASTRYX_PILOT=0` for the standard Web UI, where the appearance picker still offers openbot, OpenDuet, OpenDots, and OpenMuse. The same Web bundle supports both editions. `OPENBOT_EDITION` selects the edition on the API server.

Team administrators can open `/admin/providers` and `/admin/identity-providers` directly. The legacy `/admin/enterprise` bookmark opens the Admin overview, which links to the pages where its controls now live.

## Preview a deployment brand

Set `tenant.product_name` in the tenant package's `brand.yaml` and pass that package to the Web build with `TENANT_PACKAGE_DIR`.

| Build variable | Value |
| --- | --- |
| `VITE_OPENBOT_ASTRYX_BRAND_LOGO` | Browser-accessible URL for the shell mark. Defaults to the bundled OpenBot mark. |
| `VITE_OPENBOT_ASTRYX_ACCENT_LIGHT` | Six-digit hex color for the light appearance. Defaults to `#5148AE`. |
| `VITE_OPENBOT_ASTRYX_ACCENT_DARK` | Six-digit hex color for the dark appearance. Defaults to `#BAB7FF`. |

The preview reads the existing light or dark appearance preference. Accent controls choose black or white text based on their fill color.

## Add the next batch

Keep the existing route and its loaders, permission checks, and actions. Routes under `/_authed/_app` already get `AstryxWebShell` in preview builds. Use `AstryxSurface` from `app/src/components/astryx-pilot/theme.tsx` around migrated content and use `astryxScope` on overlays that render in a portal. Both are gated by the same build flag. Keep behavior shared across the two modes and gate preview-specific controls on `astryxPilot`.

For each batch, check the standard and preview production builds against both Personal and Team APIs. In preview, open `/`, navigate to Bots and New conversation, and refresh at the destination. Check the active link, conversation search, and account menu. At narrow widths, open navigation with the keyboard, dismiss it with Escape, and verify that focus returns to its trigger. Check the default and custom branding in both appearances across reloads. Include one unmigrated destination and both Create Bot entry points in the regression run.
