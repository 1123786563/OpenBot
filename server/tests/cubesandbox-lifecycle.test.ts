import { describe, expect, setSystemTime, test } from "bun:test";
import { cubeSandboxBrowsers } from "../src/browser/cubesandbox";
import { personBrowserId } from "../src/browser/person";
import type { ComputerSeat } from "../src/computer/computer-key";

const PERSON = "ada";
const seat: ComputerSeat = {
  botId: personBrowserId(PERSON),
  key: { kind: "person", personId: PERSON },
};
const NOON = new Date("2026-11-28T10:00:00Z").getTime();
/** A moment `minutes` after noon, for a test that moves the clock. */
const minutesAfter = (minutes: number) => new Date(NOON + minutes * 60_000);

/** CubeAPI and the sandboxes it serves. `calls` holds every request, in the order they arrived. */
async function startCube() {
  const calls: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const connects: Record<string, unknown>[] = [];
  const renewed: Record<string, unknown>[] = [];
  const sandboxes = new Map<
    string,
    {
      state: "running" | "pausing" | "paused";
      browserUp: boolean;
      metadata: Record<string, string>;
    }
  >();
  let connectStatus = 200;
  let pauseStatus = 204;
  let renewalRefusal: 500 | "unreachable" | undefined;
  const cube = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/sandboxes") {
        if (request.method === "GET")
          return Response.json(
            [...sandboxes].map(([sandboxID, sandbox]) => ({
              sandboxID,
              state: sandbox.state,
              metadata: sandbox.metadata,
            })),
          );
        const body = (await request.json()) as {
          metadata?: Record<string, string>;
        };
        creates.push(body);
        const sandboxID = `sb-${creates.length}`;
        sandboxes.set(sandboxID, {
          state: "running",
          browserUp: false,
          metadata: body.metadata ?? {},
        });
        return Response.json({ sandboxID }, { status: 201 });
      }
      // Control plane: /sandboxes/<id>/<connect|pause|timeout>. Data plane: /<id>/...
      const segments = url.pathname.split("/").slice(1);
      const control = segments[0] === "sandboxes" ? segments.slice(1) : [];
      const sandboxID = control[0] ?? segments[0];
      const path = `/${(control[1] ? [control[1]] : segments.slice(1)).join("/")}`;
      const sandbox = sandboxes.get(sandboxID);
      if (!sandbox) return new Response(null, { status: 404 });
      if (path === "/connect") {
        connects.push((await request.json()) as Record<string, unknown>);
        if (connectStatus !== 200)
          return new Response(null, { status: connectStatus });
        sandbox.state = "running";
        return Response.json({ sandboxID, clientID: "client" });
      }
      if (path === "/pause") {
        if (pauseStatus === 204) {
          sandbox.state = "paused";
          sandbox.browserUp = false;
        }
        return new Response(null, { status: pauseStatus });
      }
      if (path === "/timeout") {
        renewed.push((await request.json()) as Record<string, unknown>);
        if (renewalRefusal === undefined)
          return new Response(null, { status: 204 });
        const refusal = renewalRefusal;
        renewalRefusal = undefined;
        // The provider follows no redirect, so this fails the way a lost connection does.
        return refusal === "unreachable"
          ? new Response(null, {
              status: 302,
              headers: { location: "/elsewhere" },
            })
          : new Response(null, { status: refusal });
      }
      if (sandbox.state !== "running")
        return new Response(null, { status: 503 });
      if (path === "/envd/process.Process/Start") {
        await request.arrayBuffer();
        sandbox.browserUp = true;
        return new Response(new Uint8Array([0, 0, 0, 0, 2, 123, 125]), {
          headers: { "content-type": "application/connect+json" },
        });
      }
      if (path === "/computers/stop-all") {
        const wasRunning = sandbox.browserUp;
        sandbox.browserUp = false;
        return Response.json({ wasRunning });
      }
      if (path === "/control")
        return sandbox.browserUp
          ? Response.json({})
          : new Response(null, { status: 503 });
      return new Response(null, { status: 404 });
    },
  });
  const browser = cubeSandboxBrowsers(
    {
      OPENBOT_CUBE_API_URL: cube.url.href,
      OPENBOT_CUBE_BROWSER_TEMPLATE: "browser-template",
      OPENBOT_CUBE_BROWSER_SECRET: "fixture-browser-secret-with-32-characters",
      OPENBOT_CUBE_ENVD_URL: `${cube.url.href}{{sandbox}}/envd`,
      OPENBOT_CUBE_BROWSER_URL: `${cube.url.href}{{sandbox}}`,
      OPENBOT_CUBE_BROWSER_VOLUMES: JSON.stringify({
        [PERSON]: "ada-browser-volume",
      }),
    },
    { policyForBot: async () => undefined, serialize: (_id, run) => run() },
  );
  if (!browser?.stop) {
    await cube.stop(true);
    throw new Error(
      "The Cube browser provider did not expose lifecycle controls.",
    );
  }
  return {
    browser,
    stopBrowser: browser.stop.bind(browser),
    calls,
    creates,
    connects,
    renewed,
    sandboxAddress: `${cube.url.href}sb-1`,
    refuseResume() {
      connectStatus = 409;
    },
    refusePause(status: number) {
      pauseStatus = status;
    },
    /** Cube fails to start the idle window again, once: it refuses, or it cannot be reached. */
    refuseRenewal(how: 500 | "unreachable") {
      renewalRefusal = how;
    },
    /** What Cube does once the idle window runs out, before it says `paused`. */
    pausing() {
      for (const sandbox of sandboxes.values()) sandbox.state = "pausing";
    },
    /** A sandbox the older OpenBot made: no lifecycle, so Cube destroys it once an idle window runs out. */
    madeBeforeThisChange() {
      for (const sandbox of sandboxes.values())
        delete sandbox.metadata.openbotPauses;
    },
    /** What the browser's own idle sweep does inside the sandbox: closes it, sandbox still running. */
    closeBrowsers() {
      for (const sandbox of sandboxes.values()) sandbox.browserUp = false;
    },
    async close() {
      await cube.stop(true);
    },
  };
}

describe("a person's browser on CubeSandbox", () => {
  test("is created so that Cube pauses it once nobody has reached it for a while, rather than keeping it running forever", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      expect(cube.creates).toHaveLength(1);
      expect(cube.creates[0]).toMatchObject({
        lifecycle: { onTimeout: "pause", autoResume: true },
        metadata: { openbotPauses: "on" },
      });
      expect(cube.creates[0]?.timeout).toBeGreaterThan(0);
    } finally {
      await cube.close();
    }
  });

  test("is resumed before anything is asked of it, and its browser is started again", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      await cube.stopBrowser(seat);
      cube.calls.length = 0;
      await expect(cube.browser.locate(seat)).resolves.toBe(
        cube.sandboxAddress,
      );
      // Resumed first, and Cube asked again whether it is running, before anything reaches the sandbox.
      expect(cube.calls).toEqual([
        "GET /sandboxes",
        "POST /sandboxes/sb-1/connect",
        "GET /sandboxes",
        "GET /sb-1/control",
        "POST /sb-1/envd/process.Process/Start",
        "GET /sb-1/control",
      ]);
      expect(cube.connects[0]?.timeout).toBeGreaterThan(0);
    } finally {
      await cube.close();
    }
  });

  test("is resumed with no idle window when it was made before this change, since Cube would destroy it once the window ran out", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.madeBeforeThisChange();
      await cube.stopBrowser(seat);
      await expect(cube.browser.locate(seat)).resolves.toBe(
        cube.sandboxAddress,
      );
      expect(cube.connects[0]?.timeout).toBe(-1);
    } finally {
      await cube.close();
    }
  });

  test("is never given an idle window when it was made before this change", async () => {
    const cube = await startCube();
    try {
      setSystemTime(minutesAfter(0));
      await cube.browser.locate(seat);
      cube.madeBeforeThisChange();
      // Twenty minutes on: where a sandbox made to pause would have its window started again.
      setSystemTime(minutesAfter(20));
      await expect(cube.browser.locate(seat)).resolves.toBe(
        cube.sandboxAddress,
      );
      expect(cube.renewed).toHaveLength(0);
    } finally {
      setSystemTime();
      await cube.close();
    }
  });

  test("has its idle window started again while OpenBot keeps asking for it, but not on every request", async () => {
    const cube = await startCube();
    try {
      setSystemTime(minutesAfter(0));
      // Making it starts the window.
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(0);
      // Ten minutes on, and again: inside the first half of the window.
      setSystemTime(minutesAfter(10));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(0);
      // Twenty minutes on: past the first half.
      setSystemTime(minutesAfter(20));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(1);
      expect(cube.renewed[0]?.timeout).toBeGreaterThan(0);
      // At once again: nothing more.
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(1);
    } finally {
      setSystemTime();
      await cube.close();
    }
  });

  for (const [how, answer] of [
    ["refuses to start", 500],
    ["cannot be reached to start", "unreachable"],
  ] as const)
    test(`costs its request nothing when Cube ${how} its idle window again`, async () => {
      const cube = await startCube();
      try {
        setSystemTime(minutesAfter(0));
        await cube.browser.locate(seat);
        cube.refuseRenewal(answer);
        setSystemTime(minutesAfter(20));
        await expect(cube.browser.locate(seat)).resolves.toBe(
          cube.sandboxAddress,
        );
        expect(cube.renewed).toHaveLength(1);
      } finally {
        setSystemTime();
        await cube.close();
      }
    });

  test("asks again for its idle window a minute after Cube refused, then not for fifteen minutes", async () => {
    const cube = await startCube();
    try {
      setSystemTime(minutesAfter(0));
      await cube.browser.locate(seat);
      cube.refuseRenewal(500);
      setSystemTime(minutesAfter(20));
      await cube.browser.locate(seat);
      // Half a minute on from the refusal: not yet.
      setSystemTime(minutesAfter(20.5));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(1);
      // A minute on: asked again, and this time Cube takes it.
      setSystemTime(minutesAfter(21));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(2);
      // Fourteen minutes after that: nothing more.
      setSystemTime(minutesAfter(35));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(2);
      setSystemTime(minutesAfter(36));
      await cube.browser.locate(seat);
      expect(cube.renewed).toHaveLength(3);
    } finally {
      setSystemTime();
      await cube.close();
    }
  });

  test("is not reached while its sandbox cannot be resumed", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      await cube.stopBrowser(seat);
      cube.refuseResume();
      cube.calls.length = 0;
      await expect(cube.browser.locate(seat)).rejects.toThrow(
        "CubeSandbox browser API answered 409.",
      );
      expect(cube.calls).toEqual([
        "GET /sandboxes",
        "POST /sandboxes/sb-1/connect",
      ]);
    } finally {
      await cube.close();
    }
  });

  test("is stopped by closing its browsers, then pausing its sandbox", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.calls.length = 0;
      await expect(cube.stopBrowser(seat)).resolves.toBe(true);
      expect(cube.calls).toEqual([
        "GET /sandboxes",
        "POST /sb-1/computers/stop-all",
        "POST /sandboxes/sb-1/pause",
      ]);
    } finally {
      await cube.close();
    }
  });

  test("is paused on stopping even when its browsers closed themselves, and then says nothing was running", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.closeBrowsers();
      cube.calls.length = 0;
      await expect(cube.stopBrowser(seat)).resolves.toBe(false);
      expect(cube.calls).toEqual([
        "GET /sandboxes",
        "POST /sb-1/computers/stop-all",
        "POST /sandboxes/sb-1/pause",
      ]);
    } finally {
      await cube.close();
    }
  });

  test("counts as stopped when Cube refuses to pause it because it is pausing already", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.refusePause(409);
      cube.calls.length = 0;
      await expect(cube.stopBrowser(seat)).resolves.toBe(true);
      expect(cube.calls).toEqual([
        "GET /sandboxes",
        "POST /sb-1/computers/stop-all",
        "POST /sandboxes/sb-1/pause",
      ]);
    } finally {
      await cube.close();
    }
  });

  test("is not said to be stopped when Cube refuses to pause it for any other reason", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.refusePause(500);
      await expect(cube.stopBrowser(seat)).rejects.toThrow(
        "CubeSandbox browser API answered 500.",
      );
    } finally {
      await cube.close();
    }
  });

  test("stopping one already paused asks nothing of it and says nothing was running", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      await cube.stopBrowser(seat);
      cube.calls.length = 0;
      await expect(cube.stopBrowser(seat)).resolves.toBe(false);
      expect(cube.calls).toEqual(["GET /sandboxes"]);
    } finally {
      await cube.close();
    }
  });

  test("stopping one Cube is pausing already asks nothing of it and says nothing was running", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.pausing();
      cube.calls.length = 0;
      await expect(cube.stopBrowser(seat)).resolves.toBe(false);
      expect(cube.calls).toEqual(["GET /sandboxes"]);
    } finally {
      await cube.close();
    }
  });

  test("reads as absent while paused, so the page offers to open it", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      await cube.stopBrowser(seat);
      expect(await cube.browser.status(seat)).toEqual({
        botId: seat.botId,
        state: "absent",
      });
    } finally {
      await cube.close();
    }
  });

  test("reads as absent while Cube is still pausing it", async () => {
    const cube = await startCube();
    try {
      await cube.browser.locate(seat);
      cube.pausing();
      expect(await cube.browser.status(seat)).toEqual({
        botId: seat.botId,
        state: "absent",
      });
    } finally {
      await cube.close();
    }
  });
});
