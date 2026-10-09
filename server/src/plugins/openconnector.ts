import { cutAtCodeUnits } from "../channels/text";
import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

/**
 * How this deployment calls OpenConnector the TRANSPORT: one service's actions, dialled over REST
 * with a per-person connection alias. Everything about connecting (directory, fields, lifecycle)
 * lives in `./openconnector-adapter`; this module imports no vendor and no fetch, exactly as
 * `./composio` does not.
 *
 * THE ALIAS IS THE ACCOUNT HANDLE. Composio keeps people apart by a user id sent with every call;
 * OpenConnector is single-tenant and keeps them apart by named connections selected per call. The
 * per-person mapping is therefore minted here, deterministically, from ids this deployment already
 * trusts — `openbot-u-<user>-<service>` for a person, `openbot-d-<deployment>-<service>` for a
 * shared account — and rides `brokered_connections.vendorUserId` to the call, arriving as
 * `accountHandle`. A value that is not one of ours is never sent as an alias: the only actorId a
 * call can carry that is not an alias is a person's id on a NO_AUTH service, where OpenConnector
 * uses its virtual connection and no alias may be named.
 */
export type OpenConnectorAction = {
  id: string;
  description: string;
  inputSchema: unknown;
};

export type OpenConnectorActions = {
  listActions(service: string): Promise<OpenConnectorAction[]>;
  execute(
    call: { service: string; actionId: string; alias: string | null },
    input: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

let installed: OpenConnectorActions | null = null;

/** The seam `index.ts` hands this module its client through, once, at startup. `null` uninstalls. */
export function useOpenConnectorClient(client: OpenConnectorActions | null): void {
  installed = client;
}

export const listNeedsCredential = false;

const SERVICE_SLUG = /^[A-Za-z0-9_-]+$/;

/** Which service this connection is about — `openconnector://github` — or null for anything else. */
export function toolkitOf(url: string): string | null {
  const prefix = "openconnector://";
  if (!url.startsWith(prefix)) return null;
  const slug = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return SERVICE_SLUG.test(slug) ? slug : null;
}

function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (ch) => `~${ch.charCodeAt(0).toString(16)}`);
}

/** The alias one person's connection to one service lives under at the broker. */
export function personalAlias(userId: string, service: string): string {
  return `openbot-u-${segment(userId)}-${segment(service)}`;
}

/** The alias this deployment's own shared connection to one service lives under. */
export function deploymentAlias(deploymentId: string, service: string): string {
  return `openbot-d-${segment(deploymentId)}-${segment(service)}`;
}

/** Whether a value was minted above — the only aliases this transport ever names. */
export function isAlias(value: string | null | undefined): boolean {
  return typeof value === "string" && /^openbot-[ud]-/.test(value);
}

export async function listTools(connection: { url: string }): Promise<ListedTool[]> {
  const service = toolkitOf(connection.url);
  if (!service) {
    throw new Error(`This row's url is not an OpenConnector service address, so there is nothing to list.`);
  }
  if (!installed) {
    throw new Error(
      "OpenConnector is not configured for this deployment, so nothing was asked. Set OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN to make its apps available.",
    );
  }
  const actions = await installed.listActions(service);
  return actions.map((action) => ({
    name: action.id,
    description: action.description,
    /*
     * AN OBJECT SCHEMA OR NONE, for the reason `composio.ts` gives on the field beside it: a schema
     * has no reader that would break on the wrong shape — `parametersFor` in `./tools` offers
     * anything that is not an object schema as an open one — so an unreadable one keeps the action
     * callable rather than refusing the app's whole listing over it. The projection types this
     * field `unknown` because the vendor's answer is the vendor's.
     */
    inputSchema:
      action.inputSchema && typeof action.inputSchema === "object" && !Array.isArray(action.inputSchema)
        ? (action.inputSchema as Record<string, unknown>)
        : {},
  }));
}

/**
 * TWO KINDS OF FAILURE, both of them `isError: true` and each with its own sentence, because
 * `store.ts` records that sentence beside the audit row: this transport refused before dialling,
 * or OpenConnector reported the call's failure itself. That is `composio.ts`'s three with the third
 * — an answer this deployment could not read — absent by construction, because `execute`'s answer
 * is JSON this deployment serialized rather than an envelope it has to interpret: whatever comes
 * back is either the vendor's `data` or the throw that never reached the serialization.
 */
export async function callTool(
  connection: { url: string; accountHandle?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const service = toolkitOf(connection.url);
  if (!service) {
    return failure(`This row's url is not an OpenConnector service address, so ${toolName} was not called.`);
  }
  if (!installed) {
    return failure(
      "OpenConnector is not configured for this deployment, so nothing was asked. Set OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN.",
    );
  }
  const handle = connection.accountHandle ?? null;
  const alias = isAlias(handle) ? handle : null;
  try {
    const answer = await installed.execute({ service, actionId: toolName, alias }, args);
    return success(JSON.stringify(answer.data ?? null));
  } catch (error) {
    return failure(vendorSentence(error));
  }
}

function vendorSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.trim() === ""
    ? "OpenConnector said nothing about why this action failed. Check its container and its logs."
    : message;
}

/**
 * The cap every string this module puts in front of a model goes through — the same one, for the
 * same reason, as `composio.ts`'s: a tool result lands in a model's context whether it is an
 * answer or a refusal, so an unbounded one is somebody else's container deciding how much of our
 * context window to spend. Truncated visibly, never silently.
 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

const failure = (message: string): McpCallResult => ({
  ...cap(message),
  isError: true,
});

const success = (text: string): McpCallResult => ({
  ...cap(text),
  isError: false,
});
