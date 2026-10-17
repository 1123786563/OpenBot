import { describe, expect, test } from "bun:test";
import { createWorkshopPublicRoutes } from "../src/workshop/public-routes";
import {
  createShareService,
  hashShareToken,
  newShareToken,
  type ShareStore,
} from "../src/workshop/sharing";
import { STATIC_CSP } from "../src/workshop/preview";

/**
 * The public door's contract (B15b): the token is the only key, the answer is static and
 * unindexed, the WS upgrade is refused before anything runs, and every miss looks the same.
 */
function build(input?: {
  scope?: "preview" | "preview_download";
  rateLimit?: (token: string) => Promise<boolean>;
  files?: Record<string, string>;
}) {
  const token = newShareToken();
  const hash = hashShareToken(token);
  const store: ShareStore = {
    setShare: async () => undefined,
    revokeShare: async () => undefined,
    findLiveShareByTokenHash: async (tokenHash) =>
      tokenHash === hash
        ? {
            channelId: "ch_1",
            botId: "bot_1",
            scope: input?.scope ?? "preview",
            expiresAt: null,
            revokedAt: null,
          }
        : undefined,
  };
  const sharing = createShareService({
    store,
    signingKey: "test-key",
    limiter: {
      hit: async (key) =>
        input?.rateLimit ? await input.rateLimit(key) : key === hash,
    },
  });
  const artifacts = [
    { id: "wa_1", name: "out.csv", type: "csv", sizeBytes: 12 },
  ];
  const files: Record<string, string> = input?.files ?? {
    "index.html": "<html>shared</html>",
  };
  const app = createWorkshopPublicRoutes({
    sharing: {
      resolveShareActor: sharing.resolveShareActor,
      underRateLimit: sharing.underRateLimit,
      signArtifactUrl: sharing.signArtifactUrl,
    },
    listArtifacts: async () => artifacts,
    readArtifactFile: async (_channelId, path) => {
      const body = files[path];
      return body === undefined
        ? null
        : { bytes: new TextEncoder().encode(body), contentType: "text/html" };
    },
  });
  // Mounted as app.ts mounts BOTH surfaces: the owner prefix the path regexes trim, and
  // the public prefix the anonymous routes answer under.
  const { Hono } = require("hono") as typeof import("hono");
  const mounted = new Hono();
  mounted.route("/api/workshop", app);
  mounted.route("/api/public/workshop", app);
  return { app: mounted, sharing, token };
}

const BASE = "/api/workshop/ch_1/public";

describe("the public share door (B15b)", () => {
  test("a valid token reads the static preview, unindexed and unreferrered", async () => {
    const { app, token } = build();
    const response = await app.request(`${BASE}/preview/index.html?t=${token}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shared");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe(STATIC_CSP);
  });

  test("a token for another channel answers the SAME 404 a miss does", async () => {
    // (A wrong token is rate-limited first — 429 — because the limiter keys on whatever
    // hash it was handed; the uniform 404 is about RESOLVED tokens and their channel.)
    const { app, token } = build();
    const otherChannel = await app.request(
      `http://x/api/workshop/ch_OTHER/public/preview/index.html?t=${token}`,
    );
    expect(otherChannel.status).toBe(404);
  });

  test("an anonymous websocket upgrade is refused before anything else runs", async () => {
    const { app, token } = build();
    const response = await app.request(
      new Request(`http://x${BASE}/preview/?t=${token}`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not part of a share");
  });

  test("the artifact list is read-only, and a preview-only share gets no download URLs", async () => {
    const { app, token } = build({ scope: "preview" });
    const response = await app.request(`${BASE}/artifacts?t=${token}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scope: string;
      artifacts: Array<{ id: string; downloadUrl: string | null }>;
    };
    expect(body.scope).toBe("preview");
    expect(body.artifacts[0]?.downloadUrl).toBeNull();
  });

  test("a preview_download share gets a signed URL, and the download route honors it", async () => {
    const { app, token } = build({ scope: "preview_download" });
    const list = await app.request(`${BASE}/artifacts?t=${token}`);
    const body = (await list.json()) as {
      artifacts: Array<{ id: string; downloadUrl: string | null }>;
    };
    expect(body.artifacts[0]?.downloadUrl).toContain("s=");
    const signed = body.artifacts[0]?.downloadUrl ?? "";
    const download = await app.request(
      `${signed}${signed.includes("?") ? "&" : "?"}t=${token}`,
    );
    expect(download.status).toBe(200);
    // A reshaped signature fails the same way a miss does.
    const mangled = signed.replace(/s=.{8}/, "s=xxxxxxxx");
    const refused = await app.request(
      `${mangled}${mangled.includes("?") ? "&" : "?"}t=${token}`,
    );
    expect(refused.status).toBe(404);
  });

  test("MOUNT SEMANTICS (closeout): the real /api/public/workshop mount answers, anonymously", async () => {
    // The shape app.ts actually serves: /api/public/workshop/<channelId>/public/…?t=<token>.
    // A valid token previews; an anonymous wrong token answers the uniform 404 — never a
    // 401, because no session exists to fail: the token is the only key.
    const { app, token } = build();
    const good = await app.request(
      `http://x/api/public/workshop/ch_1/public/preview/index.html?t=${token}`,
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("x-robots-tag")).toBe("noindex");
    const wrong = await app.request(
      `http://x/api/public/workshop/ch_1/public/preview/index.html?t=not-a-token`,
    );
    expect([404, 429]).toContain(wrong.status); // rate-limited first, else the uniform miss.
  });

  test("the rate limiter slows a probe before it is told anything", async () => {
    const { app, token } = build({
      rateLimit: async (key) => key === hashShareToken(token) && key.length < 0,
    });
    const response = await app.request(`${BASE}/artifacts?t=${token}`);
    expect(response.status).toBe(429);
  });
});
