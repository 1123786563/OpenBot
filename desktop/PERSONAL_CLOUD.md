# OpenBot Cloud in Desktop

Set `OPENBOT_PERSONAL_SAAS_URL` to the same HTTPS origin used by the Personal SaaS trial server. The server must have the native sign-in routes and migration from #54. Set the origin when building the Desktop package so users can launch it normally. For local development, set it when launching Desktop. The app accepts an HTTPS origin with an optional port and no path, query, or credentials.

Configured builds add **OpenBot Cloud…** to the tray menu and the macOS application menu. Sign in using the system browser, then allow the browser to return to OpenBot. The installed app handles `openbot://auth/personal-saas` using the existing `openbot` scheme. If the browser does not return, use **Cancel sign-in** and start again.

Cloud identifies the Personal Workspace and default Assistant from the shared trial service. **Open local OpenBot** restores the existing Desktop window. The cloud session stays in the operating system’s credential store for that origin. Linux requires a running Secret Service provider. Local data and Desktop Host remain in the local window. Conversation history and other workspace resources require additional trial server support.
