import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { AccountGrant } from "./account-access";

const sessionCheckIntervalMs = 1_000;

export function sessionEventRoutes(options: {
  cookieName: string;
  authorize: (
    token: string,
    refresh?: boolean,
  ) => Promise<
    | { kind: "signed-out" }
    | { kind: "unconfirmed"; reason: string; cutoffAt: number | null }
    | { kind: "authorized"; grant: AccountGrant }
  >;
  refreshSession: (token: string) => Promise<void>;
  now: () => number;
}) {
  const app = new Hono();
  app.get(
    "/assets/session.js",
    () =>
      new Response(
        `
    const initial = document.querySelector("[data-access-ms]");
    const events = new EventSource("/api/auth/session/events");
    function signedOut() {
      events.close();
      document.querySelector("main").hidden = true;
      location.replace("/workspace");
    }
    let expires = setTimeout(signedOut, Number(initial.dataset.accessMs));
    events.addEventListener("authorized", (event) => {
      clearTimeout(expires);
      expires = setTimeout(signedOut, Number(event.data));
    });
    events.addEventListener("signed-out", signedOut);
    events.addEventListener("account-status-unconfirmed", signedOut);
    events.addEventListener("error", async () => {
      // The session can end between rendering this page and opening its stream.
      const response = await fetch("/api/workspace").catch(() => null);
      if (response?.status === 401 || response?.status === 503) signedOut();
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
      return context.json(
        { error: session.reason, cutoffAt: session.cutoffAt },
        503,
      );

    context.header("X-Accel-Buffering", "no");
    const response = streamSSE(context, async (stream) => {
      let grant = session.grant;
      const abortAtExpiry = () =>
        setTimeout(
          () => stream.abort(),
          Math.max(0, grant.expiresAt - options.now()),
        );
      let expiry = abortAtExpiry();
      stream.onAbort(() => clearTimeout(expiry));
      try {
        let refreshing = false;
        while (!stream.aborted && !stream.closed) {
          if (options.now() >= grant.expiresAt) {
            await stream.writeSSE({
              event: "account-status-unconfirmed",
              data: "",
            });
            return;
          }
          const current = await options.authorize(token, false);
          if (stream.aborted) return;
          if (current.kind === "signed-out") {
            await stream.writeSSE({ event: "signed-out", data: "" });
            return;
          }
          if (
            current.kind !== "authorized" ||
            current.grant.epoch !== grant.epoch ||
            options.now() >= grant.expiresAt
          ) {
            await stream.writeSSE({
              event: "account-status-unconfirmed",
              data: "",
            });
            return;
          }

          if (current.grant.expiresAt !== grant.expiresAt) {
            grant = current.grant;
            clearTimeout(expiry);
            expiry = abortAtExpiry();
          }
          if (!refreshing) {
            refreshing = true;
            void options
              .refreshSession(token)
              .catch(() => undefined)
              .finally(() => {
                refreshing = false;
              });
          }
          const remaining = grant.expiresAt - options.now();
          await stream.writeSSE({
            event: "authorized",
            data: String(Math.max(0, remaining)),
          });
          await stream.sleep(
            Math.min(sessionCheckIntervalMs, Math.max(0, remaining)),
          );
        }
      } catch {
        console.warn(
          JSON.stringify({ type: "personal-saas-session-stream-failure" }),
        );
      } finally {
        clearTimeout(expiry);
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}
