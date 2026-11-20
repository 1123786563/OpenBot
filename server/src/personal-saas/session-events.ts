import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";

const sessionCheckIntervalMs = 1_000;

export function sessionEventRoutes(options: {
  cookieName: string;
  authorize: (
    token: string,
  ) => Promise<{ kind: "signed-out" | "unconfirmed" | "authorized" }>;
  isSessionLive: (token: string) => Promise<boolean>;
}) {
  const app = new Hono();
  app.get(
    "/assets/session.js",
    () =>
      new Response(
        `
    const events = new EventSource("/api/auth/session/events");
    function signedOut() {
      events.close();
      location.replace("/workspace");
    }
    events.addEventListener("signed-out", signedOut);
    events.addEventListener("error", async () => {
      // The session can end between rendering this page and opening its stream.
      const response = await fetch("/api/workspace").catch(() => null);
      if (response?.status === 401) signedOut();
    });
  `,
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      ),
  );

  app.get("/api/auth/session/events", async (context) => {
    const token = getCookie(context, options.cookieName);
    if (!token) return context.json({ error: "sign_in_required" }, 401);
    const session = await options.authorize(token);
    if (session.kind === "signed-out")
      return context.json({ error: "sign_in_required" }, 401);
    if (session.kind === "unconfirmed")
      return context.json({ error: "account_status_unconfirmed" }, 503);

    context.header("X-Accel-Buffering", "no");
    const response = streamSSE(context, async (stream) => {
      try {
        while (!stream.aborted && !stream.closed) {
          if (!(await options.isSessionLive(token))) {
            await stream.writeSSE({ event: "signed-out", data: "" });
            return;
          }
          await stream.write(": heartbeat\n\n");
          await stream.sleep(sessionCheckIntervalMs);
        }
      } catch {
        console.warn(
          JSON.stringify({ type: "personal-saas-session-stream-failure" }),
        );
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}
