/**
 * The session's webapp dev-server contract — ported from onyx `sandbox/nextjs_dev.py`.
 *
 * onyx generates a self-contained `start-webapp.sh` per session (chmod 444) and the
 * sandbox-side `webapp` plugin runs it in the session directory: flock against a double
 * start, a pid + log file beside it, and a 90s readiness poll. OpenBot keeps that shape
 * whole — the script's own `bun run dev` child runs INSIDE the sandbox, so the tool that
 * starts the server, the tool that reports its status, and the preview route all speak
 * the SAME port (the per-session reservation `craft_sessions.nextjs_port`, onyx's
 * reserve_nextjs_port__no_commit model), which is what keeps one managed process per
 * session honest. The port lives on the SANDBOX host (see F-E below): in-container
 * consumers (the script's curl, the plugin's probe) use loopback; the server's preview
 * and ready probe dial the sandbox host via `webappUpstreamHost`.
 *
 * The phase-1 shape this module replaces (a `POST /devserver/start` pool client) is
 * superseded by the restored tool: the pool cannot bind a caller-chosen port, keep a
 * log the agent can read, or expose the pid — and its lazy preview start would spawn a
 * second process beside the script's. The script IS the process owner now.
 *
 * Environment substitutions (documented in the port contract, §3.5):
 * - no image-baked template, but onyx's scaffold semantics are restored: the
 *   template ships with the server (`assets/craft/web-template/`, the
 *   byte-verbatim onyx tree) and materializes into the session at
 *   `.openbot/web-template/`; start copies it to `outputs/web` when the app
 *   does not exist yet (onyx's `cp -r /workspace/templates/outputs/*`), and
 *   only when neither exists is a missing scaffold reported;
 * - `bun install` without the image cache bootstrap flags (no BUN_IMAGE_CACHE_DIR);
 * - SESSION_PATH is normalized to an absolute path so bot-relative session dirs (the
 *   agent-sandbox mode) survive the script's own `cd`.
 *
 * The BIND stays onyx's own `-H 0.0.0.0`: the server's preview and ready probe dial the
 * reserved port on the SANDBOX host (finding F-E — the gateway connection's host, with
 * the range published from the sandbox), so the server must listen beyond the
 * container's loopback; the script's own readiness curl stays on in-container loopback,
 * and the in-sandbox webapp tool's probe likewise (both run where the server does).
 *
 * THE SPAWN IS setsid'd OUT OF THE SCRIPT'S PROCESS GROUP: the webapp plugin runs this
 * script as a group leader and kills the group when its wait window expires, and the dev
 * server must outlive that (see the spawn's own comment). Everything else in the script —
 * the install, the readiness poll — is turn-scoped and dies with the group, which is what
 * keeps a cancelled start from orphaning a half-finished install holding `.webapp.lock`.
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

# A record of the reserved port for tooling/debugging (onyx-template parity:
# onyx's template dev script reads it; a generic scaffold ignores it).
echo $PORT > "$SESSION_PATH/.nextjs-port"

(
    set -e
    trap 'echo "bootstrap failed - read the error above, fix, and re-run bash start-webapp.sh" >&2' ERR

    # Replay safety: serialize the check-and-spawn so two starts (a timed-out
    # one beside its retry) can't both spawn a second dev server.
    flock -x 9

    # onyx's scaffold semantics, restored: the template ships with the session
    # (materialized under .openbot/web-template by the managed-content push)
    # instead of a template baked into the sandbox image.
    if [ ! -f "$SESSION_PATH/outputs/web/package.json" ]; then
        if [ -f "$SESSION_PATH/.openbot/web-template/package.json" ]; then
            echo "Copying outputs template"
            mkdir -p "$SESSION_PATH/outputs"
            cp -R "$SESSION_PATH/.openbot/web-template" "$SESSION_PATH/outputs/web"
        else
            echo "no web app scaffold found - build your web app under outputs/web first (outputs/web/package.json), then call webapp start again" >&2
            exit 1
        fi
    fi

    NEXTJS_PID=""
    if [ -f "$SESSION_PATH/nextjs.pid" ]; then
        NEXTJS_PID="$(cat "$SESSION_PATH/nextjs.pid")"
    fi
    # Identity guard: kill -0 alone trusts a recycled pid. A stale
    # nextjs.pid could name an unrelated live process — skip the spawn
    # forever, and the plugin's restart arm would kill that process — so
    # reuse a pid only if its cwd is this session's app dir (onyx's
    # readlink /proc/$pid/cwd comparison).
    if [ -n "$NEXTJS_PID" ] && kill -0 "$NEXTJS_PID" 2>/dev/null && \\
       [ "$(readlink /proc/$NEXTJS_PID/cwd 2>/dev/null)" = "$SESSION_PATH/outputs/web" ]; then
        echo "Next.js server already running (PID $NEXTJS_PID); reusing"
    else
        # Stale, dead, or mismatched: drop the pid file before respawning so
        # a dead pid never outlives this run.
        rm -f "$SESSION_PATH/nextjs.pid"
        cd "$SESSION_PATH/outputs/web"
        # bun's install tempdir follows BUN_INSTALL when the image sets it
        # (agent-sandbox exports BUN_INSTALL=/usr/local, root-owned), which
        # fails install with AccessDenied — pin the cache under $HOME unless
        # the deployment already chose one.
        export BUN_INSTALL_CACHE_DIR="\${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install-cache}"
        # Not [ -d node_modules ]: a failed install leaves an empty directory
        # behind, and rerunning would skip straight to a spawn with no bins.
        if [ ! -x node_modules/.bin/next ]; then
            echo "Installing dependencies with bun..."
            bun install
        fi
        echo "Starting Next.js dev server on port $PORT..."
        # 9>&-: the server must not inherit the lock fd, or it would hold the
        # check-and-spawn lock for its entire lifetime. -H 0.0.0.0 is onyx's own
        # bind: the preview dials this port on the sandbox host (F-E), not the
        # container's private loopback.
        #
        # setsid puts the server in its OWN process group/session. The webapp
        # plugin runs this script as a group leader and kills that whole group
        # when its wait window expires; the dev server is a session-scoped
        # daemon, not a turn-scoped child, so it must sit outside the group or
        # a slow first boot is killed at the cap, and every retry is killed at
        # the cap, and the preview never comes up. setsid execs (rather than
        # forks) for a background child that is not already a group leader, so
        # $! below is still the server's own pid — the pid file and the
        # readlink /proc/<pid>/cwd identity guard keep naming the real process.
        PORT="$PORT" setsid nohup bun run dev -- -H 0.0.0.0 -p "$PORT" \\
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
 * The host the session's dev server is dialed on: the gateway base URL's hostname — the
 * sandbox host, the one machine the reserved port range is published from. Unparsable
 * input degrades to loopback (the co-located topology), never to a throw.
 */
export function webappUpstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

/**
 * Whether the session's dev server answers on its reserved port — onyx's ready judgment
 * (`manager.py:1570-1593`): ANY response counts (404 included), 2s timeout. The dial
 * goes to the SANDBOX host (F-E): the reserved port listens inside the sandbox, so the
 * probe is handed the host instead of assuming it shares this process's loopback.
 */
export async function webappDevServerReady(
  input: { host: string; port: number },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(`http://${input.host}:${input.port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}
