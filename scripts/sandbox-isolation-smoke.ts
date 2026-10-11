/**
 * Live dual-bot isolation (S7, P1-A Task 6): two Bots, one sandbox, zero leakage.
 *
 * Requires a running agent-sandbox (docker compose up -d agent-sandbox) and SANDBOX_TOKEN in
 * the environment (`bun run test:live-sandbox-isolation` loads .env). Asserts the product's
 * isolation claim in three moves: a file one Bot writes is invisible to the other Bot's
 * listing; the writer Bot sees its own file (the test is about separation, not absence); and
 * a workspace reset empties the reset Bot only — the other Bot's files stand untouched.
 *
 * NO_PROXY before anything imports: a workstation-wide HTTP proxy intercepts loopback
 * fetches and drops custom headers, which reads as the sandbox refusing a valid token
 * (the wave-9 lesson, stated once more in a script that talks to 127.0.0.1).
 */
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const token = process.env.SANDBOX_TOKEN?.trim();
const baseUrl = process.env.AGENT_SANDBOX_URL?.trim() || "http://127.0.0.1:4300";
if (!token) {
  console.error(
    "SANDBOX_TOKEN is empty: bring the sandbox up (docker compose up -d agent-sandbox) and set SANDBOX_TOKEN in .env first.",
  );
  process.exit(1);
}

const call = async (
  path: string,
  init: RequestInit & { botId: string },
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-sandbox-token": token,
      "x-openbot-bot-id": init.botId,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

const listFiles = async (botId: string): Promise<string[]> => {
  const response = await call(`/file?path=.`, { botId });
  if (!response.ok) {
    console.error(`FAIL: ${botId} list answered ${response.status}.`);
    process.exit(1);
  }
  // The listing is a bare array (the upstream's shape): [{name, path, ...}] — no envelope.
  const body = (await response.json()) as unknown;
  const entries = Array.isArray(body)
    ? body
    : ((body as { files?: unknown[] }).files ?? []);
  return entries.map((entry) => {
    const file = entry as { path?: string; name?: string };
    return file.path ?? file.name ?? "";
  });
};

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const stamp = Date.now().toString(36);
const onlyA = `only-a-${stamp}.txt`;

// 1. bot-a writes a file (the writeFile verb), bot-b's listing must not see it.
const written = await call(`/file?path=${onlyA}`, {
  method: "POST",
  botId: "bot-a",
  headers: { "content-type": "text/plain" },
  body: `isolation probe ${stamp}`,
});
if (written.status !== 200 && written.status !== 201)
  fail(`bot-a write answered ${written.status}.`);

const bFiles = await listFiles("bot-b");
if (bFiles.some((name) => name.includes(onlyA)))
  fail(`bot-b sees bot-a's ${onlyA}: isolation is broken.`);

// 2. The writer sees its own file (the claim is separation, not invisibility).
const aFiles = await listFiles("bot-a");
if (!aFiles.some((name) => name.includes(onlyA)))
  fail(`bot-a does not see its own ${onlyA}: the write itself failed silently.`);

// 3. Reset bot-a: its workspace empties, bot-b's files stand.
const reset = await call(`/workspace/reset`, { method: "POST", botId: "bot-a" });
if (!reset.ok) fail(`bot-a reset answered ${reset.status}.`);
const aAfter = await listFiles("bot-a");
if (aAfter.some((name) => name.includes(onlyA)))
  fail(`bot-a still holds ${onlyA} after reset.`);
const bAfter = await listFiles("bot-b");
if (!bAfter.every((name) => !name.includes(onlyA)))
  fail(`bot-b's listing changed after bot-a's reset: the reset leaked across Bots.`);

console.log(
  `OK: bot-a's ${onlyA} was invisible to bot-b, visible to bot-a, and reset cleared bot-a only (bot-b: ${bAfter.length} files untouched).`,
);
