import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createPreviewRoutes,
  DEV_CSP_ALLOW_LISTED,
  parseAllowedDevOrigins,
  parsePreviewMode,
  type PreviewSandbox,
  STATIC_CSP,
} from "../src/workshop/preview";
import type { AppVariables } from "../src/auth/guards";

/**
 * The preview door's contract: the mode switch, the two roads, the CSP tiers, the origin
 * allow-list, the upgrade refusal, and the gate nothing skips. All fakes: the artifact bytes
 * from a map, the sandbox's dev server from a switch, the Bot gate from a lambda.
 */
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "user_1" } as never);
  await next();
};

function makeApp(input: {
  mode?: string;
  origins?: string[];
  allowBot?: boolean;
  devPort?: number | null;
  files?: Record<string, { bytes: string; contentType: string }>;
}) {
  const files = input.files ?? {
    "index.html": { bytes: "<html>artifact</html>", contentType: "text/html" },
  };
  const sandbox: PreviewSandbox = {
    devServerFor: async (botId) =>
      botId === "bot_dev" && input.devPort !== null
        ? { port: input.devPort ?? 4600 }
        : null,
    // No webapp builds in these tests: the static road always answers from the snapshot.
    webappBuilt: async () => false,
  };
  const routes = createPreviewRoutes({
    requireUser,
    canUseBot: async (_actor, botId) =>
      input.allowBot === false ? false : botId.startsWith("bot_"),
    mode: parsePreviewMode(input.mode),
    allowedDevOrigins: input.origins ?? parseAllowedDevOrigins("http://localhost:5173"),
    sandbox,
    readArtifactFile: async (_channelId, path) => files[path] ?? null,
    readWebappFile: async () => null,
    // The B15b forwarder: the upgrade now forwards; a stub that records and answers as the
    // sandbox would (101-shaped) keeps the WS case's contract pinned without a live socket.
    forwardPreviewWebSocket: async (forward) =>
      new Response(null, {
        status: 101,
        headers: { "x-forwarded-bot": forward.botId },
      }),
  });
  // The mount the app itself performs: /api/workshop → the preview routes.
  const mounted = new Hono();
  mounted.route("/api/workshop", routes);
  return mounted;
}

// The routes are MOUNT-RELATIVE (they mount at /api/workshop): every test request goes
// through a parent that mounts them there, exactly as the app does.
const PREVIEW = "/api/workshop/none/preview/index.html?botId=";

describe("the workshop preview door (B15)", () => {
  test("the static road serves the artifact's bytes under the tight CSP", async () => {
    const app = makeApp({ mode: "static" });
    const response = await app.request(
      new Request(`http://x${PREVIEW}bot_1`, { headers: { origin: "http://localhost:5173" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await response.text()).toContain("artifact");
  });

  test("off answers 404 for everything below the door", async () => {
    const app = makeApp({ mode: "off" });
    const response = await app.request(`http://x${PREVIEW}bot_1`);
    expect(response.status).toBe(404);
  });

  test("the dev road's CSP is its own tier: the dev tools in, everything else out", async () => {
    const app = makeApp({ mode: "devserver", devPort: 4600, origins: ["http://app.test"] });
    // No real dev server listens at 4600 in tests, so the proxy answers 502 (the fetch
    // refused) — that refusal IS this batch's contract for an unreachable dev road. The CSP
    // tier itself is pinned against the constants both roads serve.
    const response = await app.request(
      new Request(`http://x${PREVIEW}bot_dev`, { headers: { origin: "http://app.test" } }),
    );
    expect([502, 503]).toContain(response.status);
    expect(DEV_CSP_ALLOW_LISTED).toContain("ws: wss:"); // The dev tools in...
    expect(DEV_CSP_ALLOW_LISTED).not.toContain("frame-ancestors"); // ...and the static tier's extras stay out.
    expect(STATIC_CSP).toContain("frame-ancestors 'self'"); // The tight tier keeps them.
  });

  test("an origin not on the allow-list is refused the dev road", async () => {
    const app = makeApp({ mode: "devserver", devPort: 4600, origins: ["http://app.test"] });
    const response = await app.request(
      new Request(`http://x${PREVIEW}bot_dev`, { headers: { origin: "http://evil.test" } }),
    );
    expect(response.status).toBe(403);
  });

  test("an empty allow-list trusts no dev origin at all", async () => {
    const app = makeApp({ mode: "devserver", devPort: 4600, origins: [] });
    const response = await app.request(`http://x${PREVIEW}bot_dev`);
    expect(response.status).toBe(403);
  });

  test("a websocket upgrade on the dev road forwards to the sandbox passthrough (B15b)", async () => {
    const app = makeApp({ mode: "devserver", devPort: 4600, origins: ["http://app.test"] });
    const response = await app.request(
      new Request(`http://x${PREVIEW}bot_dev`, {
        headers: { origin: "http://app.test", upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("x-forwarded-bot")).toBe("bot_dev");
  });

  test("auto falls back to the static road when the sandbox has no dev server", async () => {
    const app = makeApp({ mode: "auto", devPort: null });
    const response = await app.request(
      new Request(`http://x${PREVIEW}bot_1`, { headers: { origin: "http://app.test" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("artifact");
  });

  test("a Bot the caller may not use is gated before any road runs", async () => {
    const app = makeApp({ mode: "static", allowBot: false });
    const response = await app.request(`http://x${PREVIEW}bot_1`);
    expect(response.status).toBe(403);
  });

  test("mode parsing: the four words, and anything else is auto", () => {
    expect(parsePreviewMode("static")).toBe("static");
    expect(parsePreviewMode("devserver")).toBe("devserver");
    expect(parsePreviewMode("off")).toBe("off");
    expect(parsePreviewMode("auto")).toBe("auto");
    expect(parsePreviewMode("nonsense")).toBe("auto");
    expect(parsePreviewMode(undefined)).toBe("auto");
    expect(parseAllowedDevOrigins("http://a.test, http://b.test ,")).toEqual([
      "http://a.test",
      "http://b.test",
    ]);
    expect(parseAllowedDevOrigins(undefined)).toEqual([]);
  });
});
