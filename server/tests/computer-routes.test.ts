import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { receiveBrowserDownload } from "../../agent-computer/src/browser-downloads";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { personBrowserId } from "../src/browser/person";
import type { ComputerSeat } from "../src/computer/computer-key";
import { personSeat, seatOf } from "../src/computer/computer-key";
import {
  type ComputerGateway,
  ComputerStillStartingError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createSharedComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

describe("computer routes", () => {
  test("gets a screenshot through the governed computer gateway", async () => {
    const requestedBotIds: string[] = [];
    const gateway = {
      seatFor: async (botId: string, personId: string) =>
        personSeat(personId, botId),
      status: async (seat: ComputerSeat) => ({
        botId: seat.botId,
        state: "ready",
      }),
      screenshot: async (seat: ComputerSeat) => {
        requestedBotIds.push(seat.botId);
        return { image: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as ComputerGateway;
    const policyStore = {} as PolicyStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: "user-1", email: "u@openbot.test" } as never);
      await next();
    };
    // Permissive: what this covers is the gateway seam, not who may act as the Bot. That question
    // has its own suite in bot-access.test.ts.
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      requireUser,
      async () => true,
    );

    const response = await routes.request(
      "http://openbot.test/bot-17/screenshot",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requestedBotIds).toEqual(["bot-17"]);
  });
});

/**
 * Watching a computer must not start it, and a slow start must not read as a failure.
 *
 * `screenshot` resumes a suspended computer on the way, so the panel polling it once a second used
 * to be what woke every Bot it was opened on, and the first poll to give up drew "can't show the
 * screen" over a computer that was simply still booting.
 */
describe("a computer that is not ready yet", () => {
  function routesFor(gateway: Partial<ComputerGateway>) {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: "user-1", email: "u@openbot.test" } as never);
      await next();
    };
    return createComputerRoutes(
      {
        seatFor: async (botId: string, personId: string) =>
          personSeat(personId, botId),
        ...gateway,
      } as ComputerGateway,
      {} as PolicyStore,
      requireUser,
      async () => true,
    );
  }

  test.each(["absent", "starting"] as const)(
    "answers %s as a state, without taking a screenshot",
    async (state) => {
      let screenshots = 0;
      const routes = routesFor({
        status: async (seat: ComputerSeat) => ({ botId: seat.botId, state }),
        screenshot: async () => {
          screenshots++;
          return { base64: "AAAA", width: 1, height: 1, capturedAt: "" };
        },
      });

      const response = await routes.request("http://openbot.test/b/screenshot");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: false, state });
      expect(screenshots).toBe(0);
    },
  );

  test("passes an unreachable computer's reason through, still as an answer", async () => {
    const routes = routesFor({
      status: async (seat: ComputerSeat) => ({
        botId: seat.botId,
        state: "unreachable",
        reason: "The supervisor could not be reached.",
      }),
      screenshot: async () => {
        throw new Error("must not be called");
      },
    });

    const response = await routes.request("http://openbot.test/b/screenshot");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: false,
      state: "unreachable",
      reason: "The supervisor could not be reached.",
    });
  });

  test("an action whose cold start ran out says it was not performed, and is marked as starting", async () => {
    const routes = routesFor({
      navigate: async () => {
        throw new ComputerStillStartingError();
      },
    });

    const response = await routes.request("http://openbot.test/b/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.starting).toBe(true);
    expect(body.notPerformed).toBe(true);
    expect(String(body.error)).toContain("still starting");
    expect(String(body.error)).toContain("not performed");
  });
});

/**
 * The fleet listing is the one route here that is not about the Bot in its path.
 *
 * `:botId` is ignored and the handler returns every computer, so a signed-in person asking about a
 * Bot they own learned every Bot id in the deployment and whether its computer was running,
 * private coworkers included. Being signed in is not the question; administering the deployment is.
 */
const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const administrator: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor, computers: () => Promise<unknown>) {
  let listed = 0;
  const countingGateway = {
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    async computers() {
      listed += 1;
      return computers();
    },
  } as ComputerGateway;

  return {
    app: createComputerRoutes(
      countingGateway,
      {} as PolicyStore,
      asActor(actor),
      // Permissive. Whether this person may act as the Bot in the path is a different question with
      // its own suite, and `:botId` is not what this route answers about anyway.
      async () => true,
    ),
    listed: () => listed,
  };
}

describe("computer fleet listing", () => {
  test("refuses a signed-in user the fleet, and does not ask the gateway", async () => {
    const { app, listed } = appFor(member, async () => ({
      isolation: "per-person",
      computers: [
        { botId: "private-coworker", running: true, startedAt: null },
      ],
    }));

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only an admin can do this.",
    });
    // Refused before the gateway is asked: a check that runs after the fleet has been read is not a
    // check, it is a filter on the response.
    expect(listed()).toBe(0);
  });

  test("lets an administrator see the fleet", async () => {
    const fleet = {
      isolation: "per-person" as const,
      computers: [
        {
          botId: "private-coworker",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          egress: null,
        },
      ],
    };
    const { app, listed } = appFor(administrator, async () => fleet);

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(fleet);
    expect(listed()).toBe(1);
  });
});

/**
 * The kind of human input is what the path says, and only what the path says.
 *
 * The route checks `:kind` against the four gestures a person's mouse and keyboard produce, and then
 * built the call as `{ kind, ...body }`, so a body carrying its own `kind` replaced the value that
 * had just been checked. The gateway puts that value straight into the path it calls on the
 * computer, so the check decided one thing and the request went somewhere else.
 *
 * This route is the one that deliberately skips the policy decision and the audit row, because a
 * takeover exists so a person can type the thing nothing should keep. That makes it the worst one to
 * be able to redirect: nothing downstream writes the row that would have shown where it went.
 */
describe("human input", () => {
  function recordingGateway() {
    const calls: Array<{ botId: string; input: Record<string, unknown> }> = [];
    const gateway = {
      seatFor: async (botId: string, personId: string) =>
        personSeat(personId, botId),
      humanInput: async (botId: string, input: Record<string, unknown>) => {
        calls.push({ botId, input });
        return { ok: true };
      },
    } as unknown as ComputerGateway;
    return {
      calls,
      app: createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor(member),
        async () => true,
      ),
    };
  }

  async function send(body: unknown, kind = "click") {
    const { app, calls } = recordingGateway();
    const response = await app.request(
      `http://openbot.test/bot-1/human/${kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { response, calls };
  }

  test("carries a real gesture through with its coordinates", async () => {
    const { response, calls } = await send({ x: 10, y: 20 });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.kind).toBe("click");
    expect(calls[0]?.input.x).toBe(10);
  });

  test("a body naming its own kind does not decide where the call goes", async () => {
    // `../computers/reset` is the shape that matters: the gateway interpolates this into the path it
    // calls, and a fetch resolves the `..` away, so the request lands on a different endpoint of the
    // computer's API carrying the deployment's computer token.
    const { calls } = await send({ kind: "../computers/reset", x: 1, y: 1 });

    expect(calls[0]?.input.kind).toBe("click");
  });

  test("a body naming its own kind cannot reach the shell either", async () => {
    const { calls } = await send(
      { kind: "../exec", text: "cat /workspace/notes" },
      "type",
    );

    expect(calls[0]?.input.kind).toBe("type");
  }, 10_000);

  test("a kind the path does not allow is still refused", async () => {
    // The existing check, which must go on working: the four gestures are the whole surface.
    const { response, calls } = await send({ x: 1 }, "screenshot");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

test("a pilot command uses the execution workspace and fails closed when it is unavailable", async () => {
  let executionAvailable = true;
  const executionRequests: string[] = [];
  const execution = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      executionRequests.push(new URL(request.url).pathname);
      const body = await request.json();
      return Response.json({
        command: body.command,
        stdout: "from execution workspace",
        stderr: "",
        exitCode: 0,
        elapsedMs: 1,
        timedOut: false,
        truncated: false,
      });
    },
  });
  try {
    const gatewayFor = (configureExecution: boolean) =>
      createComputerGateway({
        provider: createSharedComputerProvider({
          baseUrl: "http://127.0.0.1:1",
        }),
        browserProvider: {
          serves: (seat) =>
            seat.key.kind === "person" && seat.key.personId === "pilot",
          locate: async () => {
            throw new Error("CubeSandbox is unavailable");
          },
          status: async (seat) => ({
            botId: seat.botId,
            state: "unreachable",
            reason: "Fixture outage",
          }),
          tokenFor: () => "browser-fixture-token",
        },
        auditStore: { insert: async () => {} },
        policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
        ...(configureExecution
          ? {
              execution: {
                pilotUsers: new Set(["pilot"]),
                connect: async () => {
                  if (!executionAvailable)
                    throw new Error("OpenShell is unavailable");
                  return { url: execution.url.href };
                },
              },
            }
          : {}),
      });
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { id: "pilot", role: "user" } as AuthenticatedActor);
      await next();
    };
    const exec = (gateway: ComputerGateway) =>
      createComputerRoutes(
        gateway,
        {} as PolicyStore,
        requireUser,
        async () => true,
      ).request("http://openbot.test/notes/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      });
    const gateway = gatewayFor(true);
    const response = await exec(gateway);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stdout: "from execution workspace",
    });
    executionAvailable = false;
    const failure = await exec(gateway);
    expect(failure.status).toBe(503);
    expect(await failure.text()).toContain("OpenShell is unavailable");
    const missing = await exec(gatewayFor(false));
    expect(missing.status).toBe(503);
    expect(await missing.text()).toContain(
      "OpenShell execution is not configured",
    );
    expect(executionRequests).toEqual(["/exec"]);
  } finally {
    await execution.stop(true);
  }
});

test("retrying a pilot download transfers only the initiating seat's file without navigating again", async () => {
  const id = "136a7716-7a42-448e-a6b0-ffec2ae66ead";
  const emptyId = "828e5380-5cc3-4310-b706-fd1b29419512";
  const bytes = new Uint8Array([0, 255, 128, 10]);
  let navigations = 0;
  let available = false;
  let loseReceipt = false;
  const workspaces = await mkdtemp(join(tmpdir(), "openbot-download-routes-"));
  const audit: string[] = [];
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/navigate") {
        navigations++;
        return Response.json({
          url: "https://example.com",
          title: "",
          text: "",
          truncated: false,
          elapsedMs: 1,
          browserDownload: {
            status: "ready",
            id: navigations === 1 ? id : emptyId,
          },
        });
      }
      if (
        [id, emptyId].some((file) => path === `/browser-downloads/${file}`) &&
        request.headers.get("x-openbot-computer-token") === "browser-pilot" &&
        request.headers.get("x-openbot-bot-id") === "notes"
      )
        return path.endsWith(emptyId)
          ? new Response(new Uint8Array(), {
              headers: { "content-length": "0" },
            })
          : new Response(bytes, { headers: { "content-length": "4" } });
      return Response.json({ error: "Download not found." }, { status: 404 });
    },
  });
  const execution = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const token = request.headers.get("x-openbot-computer-token");
      const workspace = join(workspaces, encodeURIComponent(String(token)));
      const received = await receiveBrowserDownload(request, workspace);
      if (received) {
        if (received.ok && loseReceipt) {
          loseReceipt = false;
          return Response.json({ error: "Lost receipt." }, { status: 503 });
        }
        return received;
      }
      const command = Bun.spawn(
        ["od", "-An", "-t", "u1", join(workspace, `download-${id}`)],
        { stderr: "ignore" },
      );
      const result = await new Response(command.stdout).text();
      await command.exited;
      return Response.json({ stdout: result.trim().split(/\s+/).join(",") });
    },
  });
  try {
    const gateway = createComputerGateway({
      provider: createSharedComputerProvider({ baseUrl: "http://127.0.0.1:1" }),
      browserProvider: {
        serves: (seat) => seat.key.kind === "person",
        locate: async () => browser.url.href,
        status: async (seat) => ({ botId: seat.botId, state: "ready" }),
        tokenFor: (seat) =>
          seat.key.kind === "person" ? `browser-${seat.key.personId}` : "",
      },
      execution: {
        pilotUsers: new Set(["pilot", "other"]),
        connect: async (seat) => {
          if (!available || seat.key.kind !== "person")
            throw new Error("Fixture execution outage.");
          return {
            url: execution.url.href,
            token: `${seat.key.personId}/${seat.botId}`,
          };
        },
      },
      auditStore: {
        insert: async (event) => {
          audit.push(event.eventType);
        },
      },
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    });
    const post = async (path: string, body: object, person = "pilot") => {
      const routes = createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor({ ...member, id: person }),
        async () => true,
      );
      return routes.request(`http://openbot.test/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    };
    const initial = await post("notes/navigate", {
      url: "https://example.com",
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      download: { status: "failed", id },
    });
    available = true;
    for (const [bot, person] of [
      ["other-bot", "pilot"],
      ["notes", "other"],
    ]) {
      const denied = await post(
        `${bot}/browser-downloads/retry`,
        { id },
        person,
      );
      expect(denied.status).toBe(404);
      const command = await post(
        `${bot}/exec`,
        { command: "read download" },
        person,
      );
      expect(await command.json()).toMatchObject({ stdout: "" });
    }
    loseReceipt = true;
    const lost = await post("notes/browser-downloads/retry", { id });
    expect(lost.status).toBe(503);
    expect(await readdir(join(workspaces, "pilot%2Fnotes"))).toEqual([
      `download-${id}`,
    ]);
    for (const response of await Promise.all([
      post("notes/browser-downloads/retry", { id }),
      post("notes/browser-downloads/retry", { id }),
    ])) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "delivered",
        id,
        path: `download-${id}`,
        bytes: 4,
      });
    }
    const command = await post("notes/exec", { command: "read download" });
    expect(await command.json()).toMatchObject({ stdout: "0,255,128,10" });
    expect(await readdir(join(workspaces, "pilot%2Fnotes"))).toEqual([
      `download-${id}`,
    ]);
    expect(navigations).toBe(1);
    const automatic = await post("notes/navigate", {
      url: "https://example.com",
    });
    expect(await automatic.json()).toMatchObject({
      download: {
        status: "delivered",
        id: emptyId,
        path: `download-${emptyId}`,
        bytes: 0,
      },
    });
    expect(audit).toContain("computer.browser_download_failed");
    expect(audit).toContain("computer.browser_download_delivered");
  } finally {
    await browser.stop(true);
    await execution.stop(true);
    await rm(workspaces, { recursive: true, force: true });
  }
});

test("manual browser downloads reach only an owned recipient workspace after explicit selection", async () => {
  const id = "136a7716-7a42-448e-a6b0-ffec2ae66ead";
  const person = personBrowserId("pilot");
  const file = {
    id,
    name: "invoice.pdf",
    bytes: 4,
    downloadedAt: "2026-11-26T00:00:00.000Z",
  };
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const workspace = await mkdtemp(join(tmpdir(), "openbot-manual-download-"));
  const writes: string[] = [];
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.headers.get("x-openbot-computer-token") === "browser-pilot" &&
        request.headers.get("x-openbot-bot-id") === person
      ) {
        if (path === "/browser-downloads")
          return Response.json({ downloads: [file] });
        if (path === `/browser-downloads/${id}`)
          return new Response(bytes, { headers: { "content-length": "4" } });
      }
      return Response.json({ error: "Download not found." }, { status: 404 });
    },
  });
  const execution = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const token = request.headers.get("x-openbot-computer-token");
      if (token) writes.push(token);
      return (
        (await receiveBrowserDownload(request, workspace)) ??
        new Response(null, { status: 404 })
      );
    },
  });
  try {
    const gateway = createComputerGateway({
      provider: createSharedComputerProvider({ baseUrl: "http://127.0.0.1:1" }),
      browserProvider: {
        serves: () => true,
        locate: async () => browser.url.href,
        status: async (seat) => ({ botId: seat.botId, state: "ready" }),
        tokenFor: (seat) =>
          seat.key.kind === "person"
            ? `browser-${seat.key.personId}`
            : seat.botId === person
              ? "browser-pilot"
              : "browser-other",
      },
      seats: { seatFor: async (bot, user) => seatOf(bot, user, null, false) },
      execution: {
        pilotUsers: new Set(["pilot", "other"]),
        connect: async (seat) => ({
          url: execution.url.href,
          token:
            seat.key.kind === "person"
              ? `${seat.key.personId}/${seat.botId}`
              : "isolated",
        }),
      },
      auditStore: { insert: async () => {} },
      policy: () => ({ mode: "enforce", allow: [], deny: [] }),
    });
    const routesFor = (user: string) =>
      createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor({ ...member, id: user }),
        async () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        async (actor, bot) =>
          (actor.id === "pilot" && bot === "notes") ||
          (actor.id === "other" && bot === "other-notes"),
      );
    const post = (bot: string, user = "pilot", action = "deliver") =>
      routesFor(user).request(`/${bot}/browser-downloads/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    const list = await routesFor("pilot").request(
      `/${person}/browser-downloads`,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ downloads: [file] });
    expect(
      (await routesFor("other").request(`/${person}/browser-downloads`)).status,
    ).toBe(404);
    expect((await post("foreign")).status).toBe(404);
    expect((await post("notes", "other")).status).toBe(404);
    expect((await post("other-notes", "other")).status).toBe(404);
    expect((await post("notes", "pilot", "retry")).status).toBe(404);
    expect(writes).toEqual([]);
    for (const response of await Promise.all([post("notes"), post("notes")])) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "delivered",
        id,
        path: `download-${id}`,
        bytes: 4,
      });
    }
    expect(writes).toEqual(["pilot/notes", "pilot/notes"]);
    expect(await readdir(workspace)).toEqual([`download-${id}`]);
    expect(
      new Uint8Array(
        await Bun.file(join(workspace, `download-${id}`)).arrayBuffer(),
      ),
    ).toEqual(bytes);
  } finally {
    await browser.stop(true);
    await execution.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
});
