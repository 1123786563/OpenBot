# OpenBot Cloud in Desktop

Set `OPENBOT_PERSONAL_SAAS_URL` to the same HTTPS origin used by the Personal SaaS trial server. The server must have the native sign-in routes and migration from #54. Set the origin when building the Desktop package so users can launch it normally. For local development, set it when launching Desktop. The app accepts an HTTPS origin with an optional port and no path, query, or credentials.

Configured builds add **OpenBot Cloud…** to the tray menu and the macOS application menu. Sign in using the system browser, then allow the browser to return to OpenBot. The installed app handles `openbot://auth/personal-saas` using the existing `openbot` scheme. If the browser does not return, use **Cancel sign-in** and start again.

Cloud shows the same Personal Workspace, default Assistant, and recent conversations as the trial Web entry. **Open local OpenBot** restores the existing Desktop window. The cloud session stays in the operating system’s credential store for that origin. Linux requires a running Secret Service provider. Local data and Desktop Host remain in the local window.

Before releasing a trial installer, verify that an installed build opens the system browser, handles the Casdoor callback through the registered Desktop URL scheme, and returns to the existing workspace and conversation history. Verify the cloud and local entry points on the target OS with the configured trial origin.
