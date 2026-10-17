/**
 * Live end-to-end: real sandbox, real opencode, real GLM.
 *
 * Requires a running agent-sandbox (docker compose up -d agent-sandbox) and SANDBOX_TOKEN in the
 * environment. Asserts the three facts the product rests on: a session can be created, a task that
 * demands a file produces that file, and the text answer comes back.
 *
 * Run through `bun run test:live-codesandbox`, which loads .env with Bun's --env-file: this repo
 * ships no dotenv dependency, and the root scripts already standardize on --env-file.
 */
const token = process.env.SANDBOX_TOKEN?.trim();
const baseUrl =
  process.env.AGENT_SANDBOX_URL?.trim() || "http://127.0.0.1:4300";
const modelId = process.env.BOT_MODEL?.trim() || "GLM-5.3";
if (!token) {
  console.error(
    "SANDBOX_TOKEN is empty: set it in .env before running this suite.",
  );
  process.exit(1);
}

const { createSandboxClient } = await import(
  "../server/src/codesandbox/client"
);
const client = createSandboxClient({ baseUrl, token, botId: "smoke-bot" });

const sessionId = await client.createSession("smoke");
const run = await client.sendMessage(
  sessionId,
  "创建文件 answer.txt，内容只写 1024 三个字符，然后用一句话告诉我 2 的 10 次方是多少。",
  { modelId, timeoutMs: 300_000 },
);
const files = await client.listFiles();
if (!files.includes("answer.txt")) {
  console.error(
    `FAIL: answer.txt was not created. Workspace: ${files.join(", ")}`,
  );
  process.exit(1);
}
const answer = await client.readFile("answer.txt", 1024);
if (answer.content.trim() !== "1024") {
  console.error(
    `FAIL: answer.txt holds ${JSON.stringify(answer.content)}, expected 1024`,
  );
  process.exit(1);
}
if (!run.text) {
  console.error("FAIL: no text came back from the run.");
  process.exit(1);
}
console.log(
  `OK: session ${sessionId}, usage ${JSON.stringify(run.usage ?? {})}, answer.txt=${answer.content.trim()}, text=${run.text.slice(0, 120)}`,
);
