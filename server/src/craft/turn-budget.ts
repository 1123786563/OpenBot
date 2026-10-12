/**
 * The turn-budget contract's server half — ported from onyx
 * `sandbox/base.py`'s `stamp_turn_deadline` / `clear_turn_deadline`.
 *
 * The executor stamps the per-turn deadline file at turn start and the
 * sandbox-side plugin (templates/turn-budget.plugin.ts, written into each
 * session workspace) reads it to steer the agent toward converging past the
 * soft budget and finishing near the hard cap. Both writes are best-effort —
 * a failed stamp leaves the plugin inert (missing/garbage stamp → no notice),
 * and the stamp's `stale_after` self-invalidates it past the hard cap so a
 * failed next-turn restamp cannot nag a fresh turn.
 */

import { readFile } from "node:fs/promises";
import { getLogger } from "../../../shared/logger";
import type { CraftConfig } from "./config";
import type { SandboxGateway } from "./sandbox-gateway";
import { sessionDirectory } from "./workspace";

/** The inert stamp: unparseable as a deadline, so the plugin reads it as "off". */
export const TURN_BUDGET_CLEAR_JSON = "{}";

/**
 * The turn-budget plugin's home inside a session workspace. The sandbox's
 * opencode-serve runs with the session directory as the project root, and it
 * both auto-discovers `.opencode/plugin/*.ts` there and honors the `plugin`
 * config entries below — verified against opencode 1.18.7.
 */
export const TURN_BUDGET_PLUGIN_RELPATH = ".opencode/plugin/turn-budget.ts";

/**
 * The `plugin` entry the per-session opencode.json carries — relative to the
 * session directory (the config file's directory), exactly how opencode
 * resolves local plugin specs. onyx's absolute `/workspace/opencode-plugins/`
 * path cannot work here: the plugin is not baked into the agent-sandbox image
 * (OpenBot cannot change it), it is written per-session like every other
 * workspace file.
 */
export const SESSION_TURN_BUDGET_PLUGIN_SPEC = `./${TURN_BUDGET_PLUGIN_RELPATH}`;

/** The plugin list every session opencode.json carries (the budget steer). */
export const SESSION_PLUGINS: readonly string[] = [
  SESSION_TURN_BUDGET_PLUGIN_SPEC,
];

/**
 * The deadline stamp as the workspace bytes:
 * `{"soft_deadline_epoch_ms": now+soft, "final_deadline_epoch_ms": max(soft,
 * hard-final-notice-margin), "stale_after_epoch_ms": hard}` — every value
 * derived from config roots (onyx base.py:578-612), never a bare literal.
 * With the defaults (soft 720s, hard cap 1800s, margin 600s) this is
 * soft=now+720s, final=now+1200s, stale_after=now+1800s.
 */
export function turnBudgetStampJson(
  config: CraftConfig,
  nowMs: number,
): string {
  const softMs = nowMs + config.interactiveTurnSoftBudgetSeconds * 1000;
  const hardMs = nowMs + config.interactiveTurnHardCapSeconds * 1000;
  return JSON.stringify({
    soft_deadline_epoch_ms: softMs,
    final_deadline_epoch_ms: Math.max(
      softMs,
      hardMs - config.turnFinalNoticeMarginSeconds * 1000,
    ),
    stale_after_epoch_ms: hardMs,
  });
}

/** Where the stamp lives for a session: its directory + the contract filename. */
export function turnBudgetStampPath(
  sessionId: string,
  config: CraftConfig,
): string {
  return `${sessionDirectory(sessionId, config.sessionDirectoryMode)}/${
    config.turnBudgetFileName
  }`;
}

/**
 * Stamp the deadline at turn start — once per turn, after the preflight checks
 * (the analog of onyx's "only while holding the prompt slot": a racing loser
 * must not overwrite the live turn's stamp). Continuations do not restamp.
 * Best-effort: a failure logs and the turn proceeds (the plugin stays inert).
 */
export async function stampTurnDeadline(input: {
  gateway: SandboxGateway;
  botId: string;
  sessionId: string;
  config: CraftConfig;
  nowMs?: number;
}): Promise<void> {
  const api = input.gateway.fileApiFor(input.botId);
  if (!api) return;
  try {
    await api.writeFile(
      turnBudgetStampPath(input.sessionId, input.config),
      turnBudgetStampJson(input.config, input.nowMs ?? Date.now()),
    );
  } catch (error) {
    getLogger("server").warn(
      { error, sessionId: input.sessionId },
      "[craft] failed to stamp turn deadline",
    );
  }
}

/**
 * Invalidate the stamp at turn end so a failed next-turn restamp cannot
 * inherit it. Best-effort, ownership-guarded by the caller (the executor's
 * finally — only a runner that still owns the turn may clear).
 */
export async function clearTurnDeadline(input: {
  gateway: SandboxGateway;
  botId: string;
  sessionId: string;
  config: CraftConfig;
}): Promise<void> {
  const api = input.gateway.fileApiFor(input.botId);
  if (!api) return;
  try {
    await api.writeFile(
      turnBudgetStampPath(input.sessionId, input.config),
      TURN_BUDGET_CLEAR_JSON,
    );
  } catch (error) {
    getLogger("server").warn(
      { error, sessionId: input.sessionId },
      "[craft] failed to clear turn deadline",
    );
  }
}

let cachedPluginSource: string | null = null;

/**
 * The plugin's source, read once — the static asset every session workspace
 * materializes beside its AGENTS.md (the manager's template() precedent).
 */
export async function turnBudgetPluginSource(): Promise<string> {
  if (cachedPluginSource === null) {
    cachedPluginSource = await readFile(
      new URL("./templates/turn-budget.plugin.ts", import.meta.url),
      "utf8",
    );
  }
  return cachedPluginSource;
}

/** Write the plugin into a session workspace (idempotent, like every setup write). */
export async function writeTurnBudgetPlugin(
  api: { writeFile(path: string, content: string): Promise<void> },
  sessionId: string,
  config: CraftConfig,
): Promise<void> {
  await api.writeFile(
    `${sessionDirectory(sessionId, config.sessionDirectoryMode)}/${
      TURN_BUDGET_PLUGIN_RELPATH
    }`,
    await turnBudgetPluginSource(),
  );
}
