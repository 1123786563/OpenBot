/**
 * The session workspace's plugin inventory — relpaths and opencode.json specs
 * only. A leaf module on purpose: the plugin WRITERS (turn-budget.ts,
 * connect-app-plugin.ts, webapp-plugin.ts) each import workspace.ts for the
 * session-directory helper, and workspace.ts imports this list for the config
 * it writes — so the specs must live somewhere with no imports of their own or
 * the module graph initializes in a cycle (SESSION_PLUGINS reading a spec whose
 * module is still mid-initialization).
 */

/** The turn-budget plugin's home inside a session workspace. */
export const TURN_BUDGET_PLUGIN_RELPATH = ".opencode/plugin/turn-budget.ts";

/** The `plugin` entry the per-session opencode.json carries for it. */
export const SESSION_TURN_BUDGET_PLUGIN_SPEC = `./${TURN_BUDGET_PLUGIN_RELPATH}`;

/** The connect-app plugin's home inside a session workspace (beside the budget plugin). */
export const CONNECT_APP_PLUGIN_RELPATH = ".opencode/plugin/connect-app.ts";

/** The `plugin` entry the per-session opencode.json carries for it. */
export const SESSION_CONNECT_APP_PLUGIN_SPEC = `./${CONNECT_APP_PLUGIN_RELPATH}`;

/** The webapp plugin's home inside a session workspace (the dev-server tool). */
export const WEBAPP_PLUGIN_RELPATH = ".opencode/plugin/webapp.ts";

/** The `plugin` entry the per-session opencode.json carries for it. */
export const SESSION_WEBAPP_PLUGIN_SPEC = `./${WEBAPP_PLUGIN_RELPATH}`;

/** The plugin list every session opencode.json carries. */
export const SESSION_PLUGINS: readonly string[] = [
  SESSION_TURN_BUDGET_PLUGIN_SPEC,
  SESSION_CONNECT_APP_PLUGIN_SPEC,
  SESSION_WEBAPP_PLUGIN_SPEC,
];
