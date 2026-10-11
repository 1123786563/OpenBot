/**
 * The craft layer's view of the sandbox: one thin adapter over the agent-sandbox gateway.
 *
 * onyx drove in-pod k8s/docker containers through a SandboxManager hierarchy; OpenBot's
 * sandbox is the external agent-sandbox service behind the token gateway that
 * `codesandbox/client.ts` already speaks. This module gives craft the three capabilities it
 * actually consumes — file writes (workspace setup), opencode-serve HTTP (the client + bus
 * in ./opencode/), and liveness (health check) — without dragging k8s/docker semantics along.
 *
 * One deliberate seam: `sandboxFor(botId)` returns per-sandbox connection facts, and the
 * manager layer constructs an OpencodeServeClient + PodEventBus per (sandbox, directory)
 * from them. The base URL is the agent-sandbox gateway; every opencode-serve endpoint rides
 * it with the same token headers the codesandbox client uses.
 */

import type { CraftConfig } from "./config";
import { PodEventBus } from "./opencode/event-bus";
import { OpencodeServeClient } from "./opencode/serve-client";
import type { WorkspaceApi } from "./workspace";

/** The sandbox-side file surface craft needs (backed by the gateway's file endpoints). */
export type AgentSandboxFileApi = {
  /** List a directory; throws when unreachable/missing. */
  listFiles(path: string): Promise<string[]>;
  /** Write one text file at an absolute workspace path. */
  writeFile(path: string, content: string): Promise<void>;
  /** Delete a file or directory tree. */
  deletePath(path: string): Promise<void>;
};

export type SandboxConnection = {
  botId: string;
  /** Base URL of the agent-sandbox gateway. */
  baseUrl: string;
  token: string | null;
};

export type SandboxGatewayOptions = {
  config: CraftConfig;
  /** Resolve the connection for a Bot's sandbox (baseUrl/token come from deployment wiring). */
  connectionFor: (botId: string) => SandboxConnection | null;
  fetchImpl?: typeof fetch;
};

export type SandboxGateway = {
  /** The file API for one Bot's sandbox, or null when none is configured. */
  fileApiFor(botId: string): AgentSandboxFileApi | null;
  /** One opencode-serve client bound to a session directory (unary endpoints). */
  serveClientFor(input: {
    botId: string;
    directory: string;
  }): OpencodeServeClient | null;
  /** The shared per-(sandbox, directory) event bus, created on first use, replaced when dead. */
  eventBusFor(input: { botId: string; directory: string }): PodEventBus | null;
  /** Liveness of the sandbox's opencode-serve (readiness probes). */
  healthCheck(botId: string): Promise<boolean>;
  /** Close every cached bus (shutdown hook). */
  close(): void;
  /** The workspace-write view of the file API. */
  workspaceApiFor(botId: string): WorkspaceApi | null;
};

export function createSandboxGateway(
  options: SandboxGatewayOptions,
): SandboxGateway {
  const { config } = options;
  const buses = new Map<string, PodEventBus>();
  const clients = new Map<string, OpencodeServeClient>();

  const gatewayUrl = (connection: SandboxConnection): string => {
    // The opencode-serve endpoints ride the same gateway base; the gateway routes
    // by bot id headers exactly as it does for the codesandbox verbs.
    const base = options.config.sandboxGatewayBaseUrl || connection.baseUrl;
    return base.replace(/\/$/, "");
  };

  const connection = (botId: string): SandboxConnection | null => {
    const conn = options.connectionFor(botId);
    if (!conn) return null;
    if (!options.config.sandboxGatewayBaseUrl && !conn.baseUrl) return null;
    return conn;
  };

  const busKey = (botId: string, directory: string) => `${botId}::${directory}`;

  return {
    fileApiFor(botId) {
      const conn = connection(botId);
      if (!conn) return null;
      const base = gatewayUrl(conn).replace(/\/$/, "");
      const headers: Record<string, string> = {};
      if (conn.token) headers["x-sandbox-token"] = conn.token;
      headers["x-openbot-bot-id"] = botId;
      const doFetch = options.fetchImpl ?? fetch;
      const request = async (
        path: string,
        init: RequestInit = {},
        timeoutMs = config.opencodeServeRequestTimeoutSeconds * 1000,
      ) => {
        const response = await doFetch(`${base}${path}`, {
          ...init,
          headers: { ...headers, ...(init.headers as Record<string, string>) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`Sandbox ${path} answered ${response.status}.`);
        }
        return response;
      };
      return {
        async listFiles(path) {
          const response = await request(
            `/file?path=${encodeURIComponent(path)}`,
          );
          const body = await response.json().catch(() => null);
          if (!Array.isArray(body)) return [];
          return body
            .map((entry) =>
              typeof entry === "string"
                ? entry
                : String((entry as { path?: unknown }).path ?? ""),
            )
            .filter((entry) => entry.length > 0);
        },
        async writeFile(path, content) {
          await request(`/file?path=${encodeURIComponent(path)}`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: content,
          });
        },
        async deletePath(path) {
          await request(`/file?path=${encodeURIComponent(path)}`, {
            method: "DELETE",
          }).catch(() => undefined);
        },
      };
    },

    workspaceApiFor(botId) {
      const fileApi = this.fileApiFor(botId);
      if (!fileApi) return null;
      return {
        writeFile: (path, content) => fileApi.writeFile(path, content),
        // The gateway's write creates parent directories; mkdir is a no-op kept
        // for the workspace API's shape.
        mkdir: async () => undefined,
      };
    },

    serveClientFor(input) {
      const conn = connection(input.botId);
      if (!conn) return null;
      const key = `${input.botId}::${input.directory}`;
      const cached = clients.get(key);
      if (cached) return cached;
      const bus = this.eventBusFor(input);
      const client = new OpencodeServeClient({
        baseUrl: gatewayUrl(conn),
        config,
        token: conn.token,
        botId: input.botId,
        eventBus: bus,
        fetchImpl: options.fetchImpl,
      });
      clients.set(key, client);
      return client;
    },

    eventBusFor(input) {
      const conn = connection(input.botId);
      if (!conn) return null;
      const key = busKey(input.botId, input.directory);
      const cached = buses.get(key);
      if (cached && !cached.isClosed()) return cached;
      if (cached) {
        // Replace a self-closed bus (it exhausted its reconnect budget) so callers
        // don't wedge on the closed sentinel until restart.
        buses.delete(key);
      }
      const bus = new PodEventBus({
        baseUrl: gatewayUrl(conn),
        config,
        directory: input.directory,
        token: conn.token,
        botId: input.botId,
        fetchImpl: options.fetchImpl,
      });
      buses.set(key, bus);
      return bus;
    },

    async healthCheck(botId) {
      const conn = connection(botId);
      if (!conn) return false;
      const client = new OpencodeServeClient({
        baseUrl: gatewayUrl(conn),
        config,
        token: conn.token,
        botId,
        fetchImpl: options.fetchImpl,
      });
      return client.healthCheck();
    },

    close() {
      for (const bus of buses.values()) bus.close();
      buses.clear();
      clients.clear();
    },
  };
}
