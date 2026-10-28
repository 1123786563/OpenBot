#!/usr/bin/env node
import { appendFileSync } from "node:fs";
/**
 * Minimal OpenAI-compatible gateway STAND-IN for isolated local verification of
 * deploy/hindsight (ticket #380).
 *
 * The approved production gateway (Bifrost's OpenAI-compatible HTTP transport) is not
 * deployed in this workspace yet — server-side gateway endpoint config is bifrost-5
 * ticket 01.1 and the bifrost submodule is not checked out here. This stand-in speaks
 * the same protocol subset Hindsight uses (`/v1/chat/completions`, `/v1/embeddings`)
 * so the deployment recipe and the three-state health check can be exercised against
 * a real self-hosted Hindsight instance without any external model provider.
 *
 * It is NOT a gateway: no auth enforcement, fixed responses, single tenant. Point
 * hindsight.env at the real Bifrost endpoint for any real deployment. Routes answer
 * on both `/v1/...` and bare `/...` because provider SDKs differ in whether the base
 * URL is expected to carry the `/v1` prefix.
 *
 * Every request is appended to the log file given by --log so the verification report
 * can show which model calls Hindsight routed through the configured gateway endpoint.
 *
 * Usage: node gateway-standin.mjs [--port 9100] [--host 127.0.0.1] [--log /tmp/hindsight-gateway-standin.log] [--extract-facts]
 *   Binds to the loopback address by default. A non-loopback --host (e.g. `--host 0.0.0.0`,
 *   to let the Docker container reach the stand-in via http://host.docker.internal:<port>
 *   during isolated local verification) is refused unless --allow-non-loopback is also
 *   passed: the guard keeps this unauthenticated stand-in from ever being exposed beyond
 *   the operator's explicit opt-in.
 *
 * --extract-facts (Hindsight 05 / #382) flips the chat completion from inert filler to ONE
 * echo fact per request, shaped exactly as Hindsight's extraction schema parses
 * ({"facts": [{what, when, where, who, why, fact_type}]}): the fact's `what` prefixes the
 * echoed request text so a recalled hit's text is always distinguishable from the original
 * document — the property the #382 contract suite asserts when proving the Bot receives the
 * OpenBot-confirmed original rather than Hindsight's extraction. Off by default: #380/#381
 * verification keeps the inert behavior it was written against.
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);

function readFlagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(
      `gateway stand-in: ${name} requires a value, e.g. ${name} <value>`,
    );
    process.exit(2);
  }
  return value;
}

const rawPort = readFlagValue("--port") ?? process.env.PORT ?? "9100";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    `gateway stand-in: --port must be a whole number between 1 and 65535 (got "${rawPort}")`,
  );
  process.exit(2);
}

const host = readFlagValue("--host") ?? "127.0.0.1";
const logFile = readFlagValue("--log") ?? "/tmp/hindsight-gateway-standin.log";

// Hard misuse guard: this process enforces no authentication and its traffic carries
// personal-memory payloads, so it must stay on loopback unless the operator explicitly
// opts in (--allow-non-loopback) for one purpose only — letting a local Docker
// container reach it via host.docker.internal during isolated local verification.
// It must never be pointed at or exposed to production. Exits before any port is bound.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(host) && !args.includes("--allow-non-loopback")) {
  console.error(
    `gateway stand-in: refusing to bind non-loopback host "${host}" without --allow-non-loopback.\n` +
      "This stand-in enforces no authentication, its payloads contain personal-memory content,\n" +
      "and it exists solely for isolated local verification — never point it at production.\n" +
      "Re-run with --allow-non-loopback only to let a local Docker container reach it via\n" +
      "host.docker.internal during that verification.",
  );
  process.exit(2);
}

const EMBEDDING_DIMENSIONS = 8;

// --extract-facts: see the header comment. Off = the inert filler earlier tickets verified.
const EXTRACT_FACTS = args.includes("--extract-facts");

function log(entry) {
  appendFileSync(
    logFile,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

/** The text of the last user message, the closest thing to "what was to be extracted". */
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    const content = messages[i].content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join(" ");
    return "";
  }
  return "";
}

function chatCompletion(body) {
  const model = body?.model ?? "stand-in-model";
  let content;
  if (EXTRACT_FACTS) {
    // One echo fact, in the shape hindsight_api's lenient facts parser accepts. The prefix
    // keeps the extracted text distinct from the original document text.
    const what = `stand-in extracted: ${lastUserText(body).slice(0, 500)}`;
    content = JSON.stringify({
      facts: [
        {
          what,
          when: "N/A",
          where: "N/A",
          who: "N/A",
          why: "N/A",
          fact_type: "world",
        },
      ],
    });
  } else {
    // A JSON-string answer satisfies OpenAI-compatible clients that asked for a
    // JSON-shaped reply; the content is deliberately inert filler.
    content = JSON.stringify({
      facts: [],
      note: "stand-in gateway: no real extraction",
    });
  }
  return {
    id: `chatcmpl-standin-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function embedding(body) {
  const count = Array.isArray(body?.input) ? body.input.length : 1;
  const vector = Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) => (i + 1) / EMBEDDING_DIMENSIONS,
  );
  return {
    object: "list",
    data: Array.from({ length: count }, (_, i) => ({
      object: "embedding",
      index: i,
      embedding: vector,
    })),
    model: body?.model ?? "stand-in-embedding",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  // A client disconnecting mid-request (e.g. a probe aborted by a timeout) makes the
  // request stream emit an ECONNRESET 'error'. Without a handler that unhandled event
  // crashes the whole stand-in process, which later verification scenarios would then
  // misread as gateway_down; record and keep serving instead.
  req.on("error", (err) => log({ kind: "request-error", error: String(err) }));
  res.on("error", (err) => log({ kind: "response-error", error: String(err) }));
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    log({ method: req.method, path: req.url, model: body?.model });

    let payload;
    const path = req.url.replace(/^\/v1(?=\/)/, ""); // accept both /v1/x and /x
    if (path === "/chat/completions") payload = chatCompletion(body);
    else if (path === "/embeddings") payload = embedding(body);
    else if (path === "/models")
      payload = {
        object: "list",
        data: [{ id: body?.model ?? "stand-in-model", object: "model" }],
      };
    else payload = { error: { message: `stand-in: no route ${req.url}` } };

    const status =
      path.startsWith("/") &&
      ["/chat/completions", "/embeddings", "/models"].includes(path)
        ? 200
        : 404;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

server.listen(port, host, () => {
  console.log(
    `gateway stand-in listening on http://${host}:${port} (log: ${logFile})`,
  );
});
