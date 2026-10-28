import { serve } from "bun";
import { Hono } from "hono";
import { ExecutionScopeRegistry } from "../../shared/execution-scope";
import { initProcessTracing, withTraceFetch } from "../../shared/trace";
import {
  authorised,
  describeExecutionScope,
  statedScope,
} from "./authorisation";
import { computerMemoryBytes } from "./computer-memory-bytes";
import {
  ComputerNotAnsweringError,
  DockerUnavailableError,
  ensure,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  stop,
} from "./docker";
import { environmentFor } from "./environment";
import { registerEntry } from "./identity";
import { listenPort } from "./listen-port";
import { namesFor } from "./names";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Neither is the network the boundary, but it is the layer in front of both. Compose publishes this
 * port on `127.0.0.1` rather than on every address the host has, for the same reason the computer's
 * own port is bound there: a secret in an environment variable is one leak away from being known,
 * and this process holds the Docker socket. This listener stays on every interface inside its own
 * container, which is what the published mapping forwards to and what a server running inside the
 * compose network connects to as `supervisor:4300`.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const resolvedPort = listenPort(process.env.PORT, 4300);
if (!resolvedPort.ok) {
  console.error(resolvedPort.reason);
  process.exit(1);
}
const port = resolvedPort.port;
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image =
  process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
const runtime = process.env.COMPUTER_RUNTIME?.trim() || undefined;
const resolvedMemory = computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES);
if (!resolvedMemory.ok) {
  console.error(resolvedMemory.reason);
  process.exit(1);
}
const memoryBytes = resolvedMemory.bytes;
const spireSocketVolume =
  process.env.SPIRE_AGENT_SOCKET_VOLUME?.trim() || undefined;

const app = new Hono();

/** Which execution scope each Bot's computer belongs to; first use binds (MT050). */
const computerScopes = new ExecutionScopeRegistry();

/*
 * The trace span, before the Bearer check so a refused request is still traced: the
 * caller's `traceparent` continues their trace here, and a request with none is traced
 * from a fresh root. The span closes when the handler below answers, so every verb this
 * process exposes is visible to the collector with its status.
 */
app.use("*", async (c, next) => {
  const traced = withTraceFetch(async () => {
    await next();
    return c.res;
  });
  return traced(c.req.raw);
});

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (!authorised(context.req.header("authorization"), token)) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  /*
   * The execution ownership the caller must state, per Bot (MT050): the token proves "a caller
   * of this deployment" and nothing about whose computer this is, so the scope rides two headers
   * and the Bot's first use binds it. A later request in disagreement is one scope's caller
   * reaching for another scope's container, and the refusal names the ownership (never the token)
   * so an operator can see which side crossed.
   */
  const scope = statedScope(context.req.header());
  if (!scope) {
    console.warn(
      "supervisor refused a request that stated no execution ownership.",
    );
    return context.json({ error: "Execution ownership is required." }, 403);
  }
  const botId = /^\/computers\/([^/]+)/.exec(context.req.path)?.[1];
  if (botId && !computerScopes.bind(botId, scope)) {
    console.warn(
      `supervisor refused a request for ${botId} from ${describeExecutionScope(scope)}: that Bot's computer belongs to another execution scope.`,
    );
    return context.json(
      { error: "That Bot's computer belongs to another execution scope." },
      403,
    );
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

app.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);

  try {
    // Registered before the computer is handed out, so it can prove which Bot it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
    });
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    // A held name is not an outage. 409 says the conflict is with something already there, so an
    // operator reads the message rather than going to look at a daemon that is working.
    if (error instanceof NameHeldError) {
      return context.json({ error: error.message }, 409);
    }
    // Not ready is a 503 like an outage is, because the caller's next move is the same: wait and
    // ask again. The message is what differs, and it is the part an operator acts on.
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

// Trace context propagation and, when a collector is configured, trace export. Installed
// before the listener so the first request already runs inside a span.
initProcessTracing("supervisor", process.env);

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
