import { timingSafeEqual } from "node:crypto";
import { receiveBrowserDownload } from "./browser-downloads";
import { ControlError, ControlRequestError, createControl } from "./control";
import { handleFileRequest } from "./file-routes";
import { parseExecTimeout } from "./request-validation";
import {
  createTerminalSockets,
  type TerminalSocketData,
} from "./terminal-socket";
import { snapshotWorkspaceUpload } from "./workspace-upload";
import { createWorkspaces } from "./workspaces";

const token = process.env.OPENBOT_EXECUTION_TOKEN;
if (!token) throw new Error("OPENBOT_EXECUTION_TOKEN is required.");

function matchesToken(candidate: string | null): boolean {
  if (!candidate || !token) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The OpenShell sandbox owns exactly one workspace and shell. The requested Bot
// headers never select a path inside the sandbox.
const workspaceRoot = "/sandbox";
const workspace = createWorkspaces(workspaceRoot, false, {
  ...process.env,
  // OpenShell injects these public CA paths for commands using its egress proxy.
  COMPUTER_SHELL_ENV:
    "NODE_EXTRA_CA_CERTS,DENO_CERT,SSL_CERT_FILE,REQUESTS_CA_BUNDLE,CURL_CA_BUNDLE,GIT_SSL_CAINFO",
});
const seat = "execution";
const control = createControl();
const terminal = createTerminalSockets<TerminalSocketData & { botId: string }>({
  shellFor: async () => (await workspace.for(seat)).shell.terminal,
  mayType: () => control.humanMayDrive(),
  takeControlFirst: "Take control of the terminal before typing.",
  describe: (error, fallback) =>
    error instanceof Error ? error.message : fallback,
});

Bun.serve<TerminalSocketData & { botId: string }>({
  hostname: "127.0.0.1",
  port: 4100,
  idleTimeout: 0,
  websocket: terminal.around({ message() {} }),
  async fetch(request, server) {
    const url = new URL(request.url);
    const isTerminal = url.pathname === "/terminal";
    if (
      !matchesToken(
        isTerminal
          ? url.searchParams.get("token")
          : request.headers.get("x-openbot-computer-token"),
      )
    ) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (
      isTerminal &&
      server.upgrade(request, { data: { kind: "terminal", botId: seat } })
    )
      return;
    if (url.pathname === "/health" && request.method === "GET")
      return Response.json({ ok: true });

    if (url.pathname === "/control" && request.method === "GET") {
      return Response.json(
        control.get(url.searchParams.get("requestId") ?? undefined),
      );
    }
    if (url.pathname.startsWith("/control/") && request.method === "POST") {
      const body: {
        requestId?: unknown;
        by?: unknown;
        reason?: unknown;
      } | null = await request.json().catch(() => null);
      if (url.pathname === "/control/request") {
        return Response.json(
          control.requestHelp(body?.reason, undefined, "manual"),
        );
      }
      if (typeof body?.requestId !== "string") {
        return Response.json(
          {
            error: "A handoff request ID is required.",
            controlRequestError: true,
          },
          { status: 400 },
        );
      }
      try {
        switch (url.pathname) {
          case "/control/take":
            return Response.json(
              await control.take(
                body.requestId,
                typeof body.by === "string" ? body.by : undefined,
              ),
            );
          case "/control/release":
            return Response.json(control.release(body.requestId));
          case "/control/cancel":
            return Response.json(control.cancel(body.requestId));
        }
      } catch (error) {
        if (!(error instanceof ControlRequestError)) throw error;
        return Response.json(
          { error: error.message, controlRequestError: true },
          { status: error.status },
        );
      }
    }
    if (url.pathname === "/files/browser-upload" && request.method === "GET") {
      try {
        return Response.json(
          await snapshotWorkspaceUpload(
            (await workspace.for(seat)).files,
            workspaceRoot,
            url.searchParams.get("path") ?? "",
            url.searchParams.get("content") === "1",
          ),
        );
      } catch {
        return Response.json(
          { error: "The workspace file is unavailable or exceeds 4 MiB." },
          { status: 400 },
        );
      }
    }
    if (url.pathname.startsWith("/files/")) {
      const download = await receiveBrowserDownload(request, workspaceRoot);
      if (download) return download;
      const result = await handleFileRequest(
        request,
        url,
        async () => (await workspace.for(seat)).files,
      );
      if (result) return result;
    }
    if (url.pathname === "/exec" && request.method === "POST") {
      const body: { command?: unknown; timeoutMs?: unknown } | null =
        await request.json().catch(() => null);
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return Response.json(
          { error: "A command is required." },
          { status: 400 },
        );
      }
      const timeout = parseExecTimeout(body.timeoutMs);
      if (!timeout.ok)
        return Response.json({ error: timeout.error }, { status: 400 });
      let release: (() => void) | undefined;
      try {
        release = control.admitBotAction();
        const { shell } = await workspace.for(seat);
        return Response.json(
          await shell.run({
            command: body.command,
            ...(timeout.timeoutMs !== undefined
              ? { timeoutMs: timeout.timeoutMs }
              : {}),
            signal: request.signal,
          }),
        );
      } catch (error) {
        if (error instanceof ControlError) {
          return Response.json(
            { error: error.message, humanHasControl: true },
            { status: 409 },
          );
        }
        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "The command could not run.",
          },
          { status: 500 },
        );
      } finally {
        release?.();
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});
