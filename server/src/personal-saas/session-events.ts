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
    const binding = document.currentScript.dataset.workspaceView;
    const workspace = document.getElementById("protected-workspace");
    const status = document.getElementById("workspace-access");
    const retry = document.getElementById("workspace-retry");
    const controller = new AbortController();
    let expiry, refresh;
    let remaining = () => Infinity;

    function withdraw() {
      workspace.remove();
      controller.abort();
      clearTimeout(expiry);
      clearTimeout(refresh);
      status.textContent = "Workspace access could not be verified.";
      status.hidden = false;
      retry.hidden = false;
    }

    function canCheckAccess() {
      return !document.hidden && document.hasFocus() && navigator.onLine;
    }

    function resume() {
      if (controller.signal.aborted && canCheckAccess()) location.reload();
    }

    async function checkAccess() {
      const started = performance.now();
      const wallStarted = Date.now();
      try {
        const response = await fetch("/api/auth/session/access", {
          cache: "no-store",
          redirect: "error",
          headers: { "OpenBot-Workspace-View": binding },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const accessMs = Number(response.headers.get("OpenBot-Access-Ms"));
        const nextRemaining = () => accessMs - Math.max(
          performance.now() - started, Date.now() - wallStarted,
        );
        const delay = nextRemaining();
        if (
          response.status !== 204 || !Number.isInteger(accessMs) ||
          accessMs > 60_000 || delay <= 0 || remaining() <= 0 || !canCheckAccess()
        ) {
          withdraw();
          if ([401, 403, 503].includes(response.status)) location.replace("/workspace");
          return;
        }
        remaining = nextRemaining;
        clearTimeout(expiry);
        expiry = setTimeout(withdraw, delay);
        workspace.hidden = false;
        status.hidden = true;
        refresh = setTimeout(checkAccess, 5_000);
      } catch {
        if (!controller.signal.aborted) withdraw();
      }
    }

    window.addEventListener("pagehide", withdraw);
    window.addEventListener("pageshow", (event) => { if (event.persisted) resume(); });
    window.addEventListener("offline", withdraw);
    window.addEventListener("online", resume);
    window.addEventListener("blur", withdraw);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) withdraw();
      else resume();
    });
    if (canCheckAccess()) void checkAccess();
    else withdraw();
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
