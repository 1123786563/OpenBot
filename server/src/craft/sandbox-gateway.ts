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
  /**
   * Write one file's raw bytes (binary-safe uploads). The gateway's POST /file writes the body
   * verbatim, so the bytes land byte-for-byte — the channel the upload endpoint needs.
   */
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Delete one file; true when deleted, false when absent (the gateway's DELETE /file refuses
   * directories with the same 404 as absence, mirroring onyx's `[ -f ] && rm` semantics).
   */
  deletePath(path: string): Promise<boolean>;
  /** Read a text file's contents, or null when absent/non-text. */
  readFile(path: string): Promise<string | null>;
  /** Read a file's raw bytes, or null when absent (binary-safe artifact download). */
  readFileBytes(path: string): Promise<Uint8Array | null>;
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
  /** One packed snapshot of the Bot's whole workspace (application/gzip), or null when absent. */
  snapshotArchiveFor(botId: string): Promise<Uint8Array | null>;
  /** Replay a snapshot archive into the Bot's workspace; false when refused/unreachable. */
  restoreWorkspace(botId: string, archive: Uint8Array): Promise<boolean>;
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
        async writeFileBytes(path, bytes) {
          // The raw-bytes twin of writeFile: the body rides as-is (no content-type text
          // coercion), so a binary attachment round-trips exactly.
          await request(`/file?path=${encodeURIComponent(path)}`, {
            method: "POST",
            body: bytes as unknown as BodyInit,
          });
        },
        async deletePath(path) {
          // 404 is the honest "absent" (and the gateway's answer for a directory too —
          // onyx parity), so it resolves false rather than throwing; other failures raise.
          const response = await doFetch(
            `${base}/file?path=${encodeURIComponent(path)}`,
            {
              method: "DELETE",
              headers,
              signal: AbortSignal.timeout(
                config.opencodeServeRequestTimeoutSeconds * 1000,
              ),
            },
          );
          if (response.status === 404) return false;
          if (!response.ok) {
            throw new Error(
              `Sandbox DELETE /file answered ${response.status}.`,
            );
          }
          return true;
        },
        async readFile(path) {
          // opencode answers /file/content with a JSON envelope ({type:"text",
          // content}) for text files and passes binary bytes straight through. A
          // 404 is the honest "absent" — null, not a throw — so callers degrade to
          // "regenerate" instead of surfacing a phantom error (see codesandbox/client.ts
          // readFile for the identical envelope-unwrap on the companion gateway).
          const response = await doFetch(
            `${base}/file/content?path=${encodeURIComponent(path)}`,
            {
              headers,
              signal: AbortSignal.timeout(
                config.opencodeServeRequestTimeoutSeconds * 1000,
              ),
            },
          );
          if (response.status === 404) return null;
          if (!response.ok) {
            throw new Error(
              `Sandbox /file/content answered ${response.status}.`,
            );
          }
          const raw = await response.text();
          try {
            const parsed = JSON.parse(raw) as {
              type?: unknown;
              content?: unknown;
            };
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              parsed.type === "text" &&
              typeof parsed.content === "string"
            ) {
              return parsed.content;
            }
          } catch {
            // Not JSON: the raw body is the content.
          }
          return raw;
        },
        async readFileBytes(path) {
          // The download path needs the raw bytes unmolested: opencode hands text
          // files back as a JSON envelope and binary files as bare bytes, and both
          // have to arrive byte-for-byte. 404 is still the honest "absent" (null),
          // so a deleted artifact degrades to "regenerate" instead of throwing.
          const response = await doFetch(
            `${base}/file/content?path=${encodeURIComponent(path)}`,
            {
              headers,
              signal: AbortSignal.timeout(
                config.opencodeServeRequestTimeoutSeconds * 1000,
              ),
            },
          );
          if (response.status === 404) return null;
          if (!response.ok) {
            throw new Error(
              `Sandbox /file/content answered ${response.status}.`,
            );
          }
          return new Uint8Array(await response.arrayBuffer());
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

    async snapshotArchiveFor(botId) {
      // The snapshot pair is Bot-scoped, not session-scoped: the agent-sandbox gateway packs
      // the Bot's WHOLE workspace (`/workspace/snapshot`), so a craft session's snapshot is the
      // Bot workspace it lives in — the shared-workspace divergence the port documents.
      const conn = connection(botId);
      if (!conn) return null;
      const headers: Record<string, string> = {};
      if (conn.token) headers["x-sandbox-token"] = conn.token;
      headers["x-openbot-bot-id"] = botId;
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(
        `${gatewayUrl(conn).replace(/\/$/, "")}/workspace/snapshot`,
        {
          headers,
          signal: AbortSignal.timeout(
            config.opencodeServeRequestTimeoutSeconds * 1000,
          ),
        },
      );
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    },

    async restoreWorkspace(botId, archive) {
      const conn = connection(botId);
      if (!conn) return false;
      const headers: Record<string, string> = {};
      if (conn.token) headers["x-sandbox-token"] = conn.token;
      headers["x-openbot-bot-id"] = botId;
      headers["content-type"] = "application/gzip";
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(
        `${gatewayUrl(conn).replace(/\/$/, "")}/workspace/restore`,
        {
          method: "POST",
          headers,
          body: archive as unknown as BodyInit,
          signal: AbortSignal.timeout(
            config.opencodeServeRequestTimeoutSeconds * 1000,
          ),
        },
      );
      // The gateway refuses a restore mid-turn (409) and rejects a non-snapshot (400); both are
      // honest "could not restore this instant" answers — false, not a throw — so the caller can
      // degrade to "rebuild the workspace" instead of surfacing a phantom error.
      return response.ok;
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
