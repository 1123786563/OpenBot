import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createShell } from "../../agent-computer/src/shell";
import {
  createTerminalSockets,
  type TerminalSocketData,
} from "../../agent-computer/src/terminal-socket";
import type { AuthenticatedActor } from "../src/auth/guards";
import { cubeSandboxBrowsers } from "../src/browser/cubesandbox";
import { createComputerGateway } from "../src/computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createSharedComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";
import { loadConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";
import { testEnvironment } from "./support/environment";

const actor = {
  id: "pilot",
  email: "pilot@example.test",
  role: "user",
} satisfies AuthenticatedActor;
const basePath = "/api/computers/notes";

async function pilot() {
  const workspace = await mkdtemp(join(tmpdir(), "openbot-pilot-outage-"));
  // Seed the destination workspace at the point where delivery has already completed.
  await writeFile(
    join(workspace, "delivered.txt"),
    "cube handoff\nreached execution\n",
  );
  const shell = createShell(workspace);
  const terminal = createTerminalSockets<
    TerminalSocketData & { botId: string }
  >({
    shellFor: async () => shell.terminal,
    mayType: () => false,
    takeControlFirst: "Take control first.",
    describe: (error, fallback) =>
      error instanceof Error ? error.message : fallback,
  });
  const executionToken = "fixture-execution-token";
  const execution = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: terminal.around({ message() {} }),
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname === "/terminal" &&
        url.searchParams.get("token") === executionToken &&
        server.upgrade(request, { data: { kind: "terminal", botId: "notes" } })
      )
        return;
      if (
        url.pathname !== "/exec" ||
        request.headers.get("x-openbot-computer-token") !== executionToken
      )
        return new Response(null, { status: 404 });
      const body: unknown = await request.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("command" in body) ||
        typeof body.command !== "string"
      )
        return new Response(null, { status: 400 });
      return Response.json(await shell.run({ command: body.command }));
    },
  });
  const available = { browser: true, execution: true };
  const cube = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (!available.browser) return new Response(null, { status: 503 });
      if (url.pathname === "/sandboxes") {
        const label = url.searchParams.get("metadata")?.split("=")[1];
        return Response.json([
          {
            sandboxID: "pilot-browser",
            metadata: { openbotBrowser: label },
            state: "running",
          },
        ]);
      }
      if (url.pathname === "/pilot-browser/stream" && server.upgrade(request))
        return;
      if (url.pathname === "/pilot-browser/control")
        return Response.json({ holder: "bot" });
      if (url.pathname === "/pilot-browser/control/take")
        return Response.json({ holder: "human" });
      if (url.pathname === "/pilot-browser/screenshot")
        return Response.json({
          base64: "AAAA",
          width: 1,
          height: 1,
          capturedAt: "",
        });
      return new Response(null, { status: 404 });
    },
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: "frame", source: "cube" }));
      },
      message() {},
    },
  });
  let legacyConnections = 0;
  const provider = createSharedComputerProvider({
    baseUrl: "http://127.0.0.1:1",
  });
  const gateway = createComputerGateway({
    provider: {
      ...provider,
      locate: async () => {
        legacyConnections++;
        throw new Error("Unexpected legacy computer connection.");
      },
    },
    browserProvider: cubeSandboxBrowsers(
      {
        OPENBOT_CUBE_API_URL: cube.url.href,
        OPENBOT_CUBE_BROWSER_TEMPLATE: "browser-template",
        OPENBOT_CUBE_BROWSER_SECRET:
          "fixture-browser-secret-with-32-characters",
        OPENBOT_CUBE_ENVD_URL: `${cube.url.href}{{sandbox}}/envd`,
        OPENBOT_CUBE_BROWSER_URL: `${cube.url.href}{{sandbox}}`,
        OPENBOT_CUBE_BROWSER_VOLUMES: JSON.stringify({
          [actor.id]: "browser-volume",
        }),
      },
      { policyForBot: async () => undefined, serialize: (_id, run) => run() },
    ),
    execution: {
      pilotUsers: new Set([actor.id]),
      connect: async () => {
        if (!available.execution) throw new Error("OpenShell is unavailable.");
        return { url: execution.url.href, token: executionToken };
      },
    },
    auditStore: { insert: async () => {} },
    policy: () => DEFAULT_ACTION_POLICY,
  });
  const app = new Hono().route(
    "/api/computers",
    createComputerRoutes(
      gateway,
      createPolicyStore(DEFAULT_ACTION_POLICY),
      async (context, next) => {
        context.set("actor", actor);
        await next();
      },
      async () => true,
    ),
  );
  const http = startHttpServer({
    port: 0,
    config: loadConfig(
      testEnvironment({ AGENT_COMPUTER_URL: "http://127.0.0.1:1" }),
    ),
    resolveRequestActor: async () => ({ ...actor, name: "Pilot" }),
    agentProfileStore: {
      get: async (_actor, id) => ({
        id,
        name: "Notes",
        title: "Notes",
        roleDescription: "",
        avatarSeed: "notes",
        visibility: "private",
        ownerUserId: actor.id,
        systemOwned: false,
        hidden: false,
        pinned: false,
        deletedAt: null,
        endpoint: null,
        hasAuth: false,
        hasCallbackToken: false,
        isolated: false,
      }),
    },
    computerGateway: gateway,
    app,
  });
  const url = `http://127.0.0.1:${http.port}${basePath}`;
  return {
    available,
    get: (path: string) => fetch(url + path),
    post: (path: string, body: object) =>
      fetch(url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    upgradeFailure: (surface: "stream" | "terminal") =>
      fetch(`${url}/${surface}`, { headers: { upgrade: "websocket" } }),
    watch: (surface: "stream" | "terminal", message: object) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `${url.replace("http:", "ws:")}/${surface}`,
        );
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${surface}.`));
          socket.close();
        }, 3_000);
        socket.onmessage = (event) => {
          if (event.data !== JSON.stringify(message)) return;
          clearTimeout(timer);
          resolve();
          socket.close();
        };
        socket.onclose = () => {
          clearTimeout(timer);
          reject(new Error(`${surface} closed before its expected message.`));
        };
      }),
    legacyConnections: () => legacyConnections,
    async close() {
      await http.stop(true);
      await Promise.all([cube.stop(true), execution.stop(true)]);
      shell.dispose();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

test("a CubeSandbox outage names the unavailable browser on takeover and a fresh request recovers", async () => {
  const fixture = await pilot();
  try {
    fixture.available.browser = false;
    const screenshot = await fixture.get("/screenshot");
    expect(await screenshot.json()).toMatchObject({
      ready: false,
      state: "unreachable",
      reason: "CubeSandbox browser API answered 503.",
    });
    const takeover = await fixture.post("/control/take", {
      requestId: "outage",
    });
    expect(await takeover.json()).toMatchObject({
      error: "CubeSandbox browser API answered 503.",
    });
    expect(takeover.status).toBe(503);

    fixture.available.browser = true;
    const recovered = await fixture.post("/control/take", {
      requestId: "retry",
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ holder: "human" });
    expect(fixture.legacyConnections()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("CubeSandbox can fail while a Bot processes an already-delivered file and its terminal stays available", async () => {
  const fixture = await pilot();
  try {
    fixture.available.browser = false;
    const screen = await fixture.upgradeFailure("stream");
    expect(screen.status).toBe(502);
    expect(await screen.text()).toContain(
      "CubeSandbox browser API answered 503.",
    );

    const command = await fixture.post("/exec", {
      command: "tr '[:lower:]' '[:upper:]' < delivered.txt",
    });
    expect(command.status).toBe(200);
    expect(await command.json()).toMatchObject({
      exitCode: 0,
      stdout: "CUBE HANDOFF\nREACHED EXECUTION\n",
    });
    await fixture.watch("terminal", { type: "ready" });

    fixture.available.browser = true;
    await fixture.watch("stream", { type: "frame", source: "cube" });
    expect(fixture.legacyConnections()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("OpenShell can fail while a person views and takes over the CubeSandbox browser", async () => {
  const fixture = await pilot();
  try {
    fixture.available.execution = false;
    const command = await fixture.post("/exec", { command: "pwd" });
    expect(command.status).toBe(503);
    expect(await command.json()).toMatchObject({
      error: "OpenShell is unavailable.",
    });
    const terminal = await fixture.upgradeFailure("terminal");
    expect(terminal.status).toBe(502);
    expect(await terminal.text()).toContain("OpenShell is unavailable.");

    const screenshot = await fixture.get("/screenshot");
    expect(screenshot.status).toBe(200);
    expect(await screenshot.json()).toMatchObject({ base64: "AAAA" });
    const takeover = await fixture.post("/control/take", {
      requestId: "during-outage",
    });
    expect(takeover.status).toBe(200);
    expect(await takeover.json()).toMatchObject({ holder: "human" });
    await fixture.watch("stream", { type: "frame", source: "cube" });

    fixture.available.execution = true;
    const recovered = await fixture.post("/exec", {
      command: "cat delivered.txt",
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      exitCode: 0,
      stdout: "cube handoff\nreached execution\n",
    });
    await fixture.watch("terminal", { type: "ready" });
    expect(fixture.legacyConnections()).toBe(0);
  } finally {
    await fixture.close();
  }
});
