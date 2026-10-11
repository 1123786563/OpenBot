/**
 * Start/stop a session's webapp dev server through the agent-sandbox gateway.
 *
 * onyx builds a self-contained `start-webapp.sh` and execs it inside the pod (`nextjs_dev.py`),
 * binding a backend-reserved port. OpenBot has no in-pod exec: the agent-sandbox already owns
 * a per-Bot, per-directory dev-server pool (`POST /devserver/start`), so this module is a thin
 * adapter over that lifecycle verb — the dir is the session's `outputs/web`, the command the
 * scaffold's dev script (`bun run dev`), and the sandbox returns the port it allocated from its
 * own pool. The backend-reserved `craft_sessions.nextjs_port` survives as a stable identifier,
 * not a bind target (documented divergence in the port plan §7).
 */

export type DevServerStartResult =
  | { ok: true; port: number; command: string }
  | { ok: false; error: string };

export type DevServerInput = {
  botId: string;
  /** Agent-sandbox gateway base URL (no trailing slash). */
  baseUrl: string;
  token: string | null;
  /** Directory inside the Bot's workspace the dev server runs in (e.g. `<session>/outputs/web`). */
  dir: string;
  command?: string;
  fetchImpl?: typeof fetch;
};

function headersFor(
  botId: string,
  token: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { "x-openbot-bot-id": botId };
  if (token) headers["x-sandbox-token"] = token;
  return headers;
}

/** Start (or reattach to) the session's webapp dev server; returns the sandbox-allocated port. */
export async function startNextjsDevServer(
  input: DevServerInput,
): Promise<DevServerStartResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.baseUrl}/devserver/start`, {
      method: "POST",
      headers: {
        ...headersFor(input.botId, input.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dir: input.dir,
        ...(input.command?.trim() ? { command: input.command.trim() } : {}),
      }),
    });
  } catch {
    return { ok: false, error: "The sandbox dev server did not answer." };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body !== null && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `answered ${response.status}`;
    return { ok: false, error: message };
  }

  const body = (await response.json().catch(() => null)) as {
    port?: unknown;
    command?: unknown;
  } | null;
  if (body === null || typeof body.port !== "number") {
    return { ok: false, error: "The sandbox dev server returned no port." };
  }
  return {
    ok: true,
    port: body.port,
    command: typeof body.command === "string" ? body.command : "",
  };
}

/** Stop every dev server the Bot holds (the sandbox stops all dirs for the Bot). */
export async function stopNextjsDevServer(input: {
  botId: string;
  baseUrl: string;
  token: string | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  await fetchImpl(`${input.baseUrl}/devserver/stop`, {
    method: "POST",
    headers: {
      ...headersFor(input.botId, input.token),
      "content-type": "application/json",
    },
    body: "{}",
  }).catch(() => undefined);
}
