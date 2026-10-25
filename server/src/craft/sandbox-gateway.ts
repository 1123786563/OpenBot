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

import {
  EXECUTION_TENANT_HEADER,
  EXECUTION_WORKSPACE_HEADER,
  type ExecutionScope,
} from "../../../shared/execution-scope";
import type { CraftConfig } from "./config";
import { SandboxExecutionScopeUnavailableError } from "./errors";
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
  /**
   * Resolve the execution ownership every outbound request states (MT050, #618): the
   * deployment-level pair the boot file threads beside its connection lambda — same
   * facts, every assembly point. Unset callers fall back to the config's parsed
   * `sandboxExecutionScope`, which is the same single source. A null resolution makes
   * every outbound group fail closed with the displayable error, never an
   * unattributed request.
   */
  executionScopeFor?: () => ExecutionScope | null;
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
  /**
   * Liveness of the sandbox's opencode-serve (readiness probes). Rejects with the
   * displayable scope refusal in a scopeless deployment (#618 OCR#12) — a permanent
   * configuration failure callers answer as unavailable, not as a cold start.
   */
  healthCheck(botId: string): Promise<boolean>;
  /** Close every cached bus (shutdown hook). */
  close(): void;
  /** The workspace-write view of the file API. */
  workspaceApiFor(botId: string): WorkspaceApi | null;
  /**
   * One packed snapshot of the Bot's whole workspace (application/gzip). Null ONLY on
   * 404 ("nothing snapshotted yet") — any other failure, a scope mismatch included,
   * throws (#618 FR-F2); a missing execution scope throws the displayable refusal.
   */
  snapshotArchiveFor(botId: string): Promise<Uint8Array | null>;
  /**
   * Replay a snapshot archive into the Bot's workspace. False only when the gateway
   * refused the payload (409 mid-turn, 400 non-snapshot); every other failure throws,
   * and a missing execution scope throws the displayable refusal instead of answering
   * false (#618 OCR#5) — false is "could not restore this instant", never a verdict.
   */
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

  /*
   * #618: the execution ownership, resolved through the injected lambda (the boot
   * file's one-const family) or the config's parsed pair — one source either way.
   * Two cadences by consumer (OCR#7): the file verbs and healthCheck resolve per
   * use, so the refusal keeps firing as long as the deployment has no scope;
   * serveClientFor and eventBusFor freeze the value resolved at CONSTRUCTION into
   * their cached instances (never invalidated while alive), so a later scope change
   * reaches them only through a fresh client or bus — in production the pair is
   * boot-time config, so there is no such moment.
   */
  const executionScope = (): ExecutionScope | null =>
    options.executionScopeFor
      ? options.executionScopeFor()
      : config.sandboxExecutionScope;

  /** The two ownership headers, or the fail-closed refusal — never unattributed headers. */
  const scopeHeaders = (): Record<string, string> => {
    const scope = executionScope();
    if (scope === null) throw new SandboxExecutionScopeUnavailableError();
    return {
      [EXECUTION_TENANT_HEADER]: scope.tenantId,
      [EXECUTION_WORKSPACE_HEADER]: scope.workspaceId,
    };
  };

  const busKey = (botId: string, directory: string) => `${botId}::${directory}`;

  return {
    fileApiFor(botId) {
      const conn = connection(botId);
      if (!conn) return null;
      const base = gatewayUrl(conn).replace(/\/$/, "");
      // Per request, not once: the ownership half is resolved (or refused) on every
      // call, so a deployment without a scope can never have cached unattributed
      // headers from a moment the scope did exist.
      const headersFor = (): Record<string, string> => {
        const headers: Record<string, string> = {};
        if (conn.token) headers["x-sandbox-token"] = conn.token;
        headers["x-openbot-bot-id"] = botId;
        return { ...headers, ...scopeHeaders() };
      };
      const doFetch = options.fetchImpl ?? fetch;
      const request = async (
        path: string,
        init: RequestInit = {},
        timeoutMs = config.opencodeServeRequestTimeoutSeconds * 1000,
      ) => {
        const response = await doFetch(`${base}${path}`, {
          ...init,
          headers: {
            // #618 (OCR#4): trust headers land LAST, mirroring serve-client's
            // buildHeaders — token/bot-id/scope are always the deployment's, so
            // a future verb that forwards caller headers into init.headers can
            // never override ownership or strip the credentials. headersFor()
            // states no content-type, so writeFile's own survives untouched.
            ...(init.headers as Record<string, string>),
            ...headersFor(),
          },
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
              headers: headersFor(),
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
              headers: headersFor(),
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
              headers: headersFor(),
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
        listFiles: (path) => fileApi.listFiles(path),
        readFile: (path) => fileApi.readFile(path),
      };
    },

    async snapshotArchiveFor(botId) {
      // The snapshot pair is Bot-scoped, not session-scoped: the agent-sandbox gateway packs
      // the Bot's WHOLE workspace (`/workspace/snapshot`), so a craft session's snapshot is the
      // Bot workspace it lives in — the shared-workspace divergence the port documents.
      const conn = connection(botId);
      if (!conn) return null;
      // #618: the ownership headers resolve (or refuse) before the dial — the archive
      // read is an outbound request like any other, not a side door.
      const headers: Record<string, string> = {};
      if (conn.token) headers["x-sandbox-token"] = conn.token;
      headers["x-openbot-bot-id"] = botId;
      Object.assign(headers, scopeHeaders());
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
      // #618 (FR-F2): only a 404 is the honest "no snapshot yet". Folding every !ok
      // into null dressed a scope-mismatch 403 up as "nothing to restore" — the
      // mismatch verdict must travel out as the error it is.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `Sandbox /workspace/snapshot answered ${response.status}.`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async restoreWorkspace(botId, archive) {
      const conn = connection(botId);
      if (!conn) return false;
      // #618: same gate as the snapshot half — refuse before any bytes leave.
      const headers: Record<string, string> = {};
      if (conn.token) headers["x-sandbox-token"] = conn.token;
      headers["x-openbot-bot-id"] = botId;
      headers["content-type"] = "application/gzip";
      Object.assign(headers, scopeHeaders());
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
      // honest "could not restore this instant" answers — false, not a throw. Every OTHER
      // verdict — a scope-mismatch 403 included — travels out as the error it is, mirroring
      // the snapshot half (#618 FR-F2/OCR#5): folding it into false dressed a mismatch up as
      // "nothing to restore" and the wake silently rebuilt the workspace over the mismatch.
      if (response.status === 409 || response.status === 400) return false;
      if (!response.ok) {
        throw new Error(
          `Sandbox /workspace/restore answered ${response.status}.`,
        );
      }
      return true;
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
        // #618: null (not undefined) when the deployment has no scope, so every verb
        // of this client refuses at its own boundary. Resolved at construction like
        // the connection above: the pair is deployment config, one value per process.
        executionScope: executionScope(),
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
        // #618: null (not undefined) when the deployment has no scope — subscribe()
        // then refuses with the displayable error instead of dialing unattributed.
        executionScope: executionScope(),
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
        // #618: the probe is an outbound request too — same ownership, same refusal.
        executionScope: executionScope(),
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
