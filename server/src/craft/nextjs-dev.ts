/**
 * The session's webapp dev-server contract — ported from onyx `sandbox/nextjs_dev.py`.
 *
 * onyx generates a self-contained `start-webapp.sh` per session (chmod 444) and the
 * sandbox-side `webapp` plugin runs it in the session directory: flock against a double
 * start, a pid + log file beside it, and a 90s readiness poll. OpenBot keeps that shape
 * whole — the agent-sandbox runs `opencode serve` (and the plugin inside it) directly on
 * the host the craft server is co-located with, so the script's own `bun run dev` child
 * and the reserved port are first-class loopback citizens: the tool that starts the
 * server, the tool that reports its status, and the preview route all speak the SAME
 * port (the per-session reservation `craft_sessions.nextjs_port`, onyx's
 * reserve_nextjs_port__no_commit model), which is what keeps one managed process per
 * session honest.
 *
 * The phase-1 shape this module replaces (a `POST /devserver/start` pool client) is
 * superseded by the restored tool: the pool cannot bind a caller-chosen port, keep a
 * log the agent can read, or expose the pid — and its lazy preview start would spawn a
 * second process beside the script's. The script IS the process owner now.
 *
 * Environment substitutions (documented in the port contract, §3.5):
 * - no image outputs template: a missing `outputs/web` scaffold is honest guidance, not
 *   a template copy (the scaffold is the agent's job per AGENTS.md);
 * - `bun install` without the image cache bootstrap flags (no BUN_IMAGE_CACHE_DIR);
 * - the dev server binds `-H 127.0.0.1` (onyx pods needed 0.0.0.0; here the preview and
 *   probes are loopback);
 * - SESSION_PATH is normalized to an absolute path so bot-relative session dirs (the
 *   agent-sandbox mode) survive the script's own `cd`.
 */

import type { CraftConfig } from "./config";
import { sessionDirectory } from "./workspace";

/** The session-root filename of the generated script (onyx WEBAPP start script name). */
export const WEBAPP_BOOTSTRAP_SCRIPT_NAME = "start-webapp.sh";

/**
 * The protected, agent-facing bootstrap script. Its header (`SESSION_PATH`, `PORT`) is
 * the plugin's parsePort source; its success/failure lines are onyx byte-verbatim.
 */
export function buildWebappBootstrapScript(input: {
  /** The session directory the script lives in (either sessionDirectoryMode spelling). */
  sessionDirectory: string;
  /** The session's reserved port — the bind target AND the preview's routing contract. */
  port: number;
}): string {
  const { sessionDirectory, port } = input;
  return `#!/bin/bash
SESSION_PATH=${sessionDirectory}
# Normalize so bot-relative session dirs survive the script's own cd. The
# invocation contract (the plugin, and \`bash start-webapp.sh\` from the root)
# always runs with the session dir as cwd, so the cwd fallback is safe.
SESSION_PATH="$(cd "$SESSION_PATH" 2>/dev/null && pwd || pwd)"
PORT=${port}

# Read by the scaffold's dev script so a \`bun run dev\` the agent runs by
# hand still binds the port the preview proxy routes to.
echo $PORT > "$SESSION_PATH/.nextjs-port"

(
    set -e
    trap 'echo "bootstrap failed - read the error above, fix, and re-run bash start-webapp.sh" >&2' ERR

    # Replay safety: serialize the check-and-spawn so two starts (a timed-out
    # one beside its retry) can't both spawn a second dev server.
    flock -x 9

    # No image template ships in this environment: the scaffold under
    # outputs/web is the agent's own (see AGENTS.md).
    if [ ! -f "$SESSION_PATH/outputs/web/package.json" ]; then
        echo "no web app scaffold found - build your web app under outputs/web first (outputs/web/package.json), then call webapp start again" >&2
        exit 1
    fi

    NEXTJS_PID=""
    if [ -f "$SESSION_PATH/nextjs.pid" ]; then
        NEXTJS_PID="$(cat "$SESSION_PATH/nextjs.pid")"
    fi
    if [ -n "$NEXTJS_PID" ] && kill -0 "$NEXTJS_PID" 2>/dev/null; then
        echo "Next.js server already running (PID $NEXTJS_PID); reusing"
    else
        cd "$SESSION_PATH/outputs/web"
        if [ ! -d node_modules ]; then
            echo "Installing dependencies with bun..."
            bun install
        fi
        echo "Starting Next.js dev server on port $PORT..."
        # 9>&-: the server must not inherit the lock fd, or it would hold the
        # check-and-spawn lock for its entire lifetime.
        PORT="$PORT" nohup bun run dev -- -H 127.0.0.1 -p "$PORT" \\
            > "$SESSION_PATH/nextjs.log" 2>&1 9>&- &
        NEXTJS_PID=$!
        echo "Next.js server started with PID $NEXTJS_PID"
        echo $NEXTJS_PID > "$SESSION_PATH/nextjs.pid"
    fi
) 9>"$SESSION_PATH/.webapp.lock"
if [ "$?" -ne 0 ]; then
    exit 1
fi

echo "Waiting for the dev server to become ready..."
DEADLINE=$((SECONDS + 90))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
    if curl -s -o /dev/null --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/"; then
        echo "web app dev server running on port $PORT - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand."
        exit 0
    fi
    sleep 1
done

echo "server did not become ready - check nextjs.log; if it crashed, fix the error and re-run bash start-webapp.sh" >&2
echo "--- last 30 lines of nextjs.log ---" >&2
tail -n 30 "$SESSION_PATH/nextjs.log" 2>/dev/null >&2 || true
exit 1
`;
}

/**
 * Write the script into a session workspace (idempotent, like every setup write).
 * Protection is the opencode.json permission set, not chmod (the gateway's file API
 * writes bytes only): PROTECTED_FILE_RULES denies edit/write/patch on the name, and the
 * bash rules allow exactly the two documented fallback invocations.
 */
export async function writeWebappBootstrapScript(
  api: { writeFile(path: string, content: string): Promise<void> },
  sessionId: string,
  config: CraftConfig,
  port: number,
): Promise<void> {
  await api.writeFile(
    `${sessionDirectory(sessionId, config.sessionDirectoryMode)}/${
      WEBAPP_BOOTSTRAP_SCRIPT_NAME
    }`,
    buildWebappBootstrapScript({
      sessionDirectory: sessionDirectory(
        sessionId,
        config.sessionDirectoryMode,
      ),
      port,
    }),
  );
}

/**
 * Whether the session's dev server answers on its reserved port — onyx's ready
 * judgment (`manager.py:1570-1593`): ANY response counts (404 included), 2s timeout.
 */
export async function webappDevServerReady(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}
