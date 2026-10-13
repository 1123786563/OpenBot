/**
 * The per-user craft MCP resolution — the port of onyx `sandbox/util/mcp_config.py`
 * (`resolve_craft_mcp_servers` / `_server_key`) over OpenBot's plugins domain.
 *
 * onyx resolves craft-enabled MCP servers the user can authenticate against, keys each
 * as `{slug}-{id}`, and drops a server whose credential cannot be resolved entirely
 * (injection would block its tool discovery, so emitting it only buys a permanently
 * failed MCP client — onyx logs `craft_mcp_skip_unauthenticated` and moves on).
 *
 * The OpenBot source is the environment-equivalent the contract's C3 ruling names: the
 * plugins catalogue's servers the user has connected in their own account (the same
 * personal-connection filter the connectable-apps list inverts). And the url each entry
 * carries is NEVER the vendor endpoint: it is the deployment's craft MCP relay route
 * (mcp-relay.ts), the trusted side that attaches the owner's credential per call —
 * no credential byte can enter the workspace config because none is ever known to it.
 */

import type { CraftMCPServerConfig } from "./opencode-config";

/** Runs of characters an opencode server key cannot hold (onyx `[^a-z0-9]+`). */
const NON_IDENTIFIER = /[^a-z0-9]+/g;

/** The slug half of a server key: lowercase, non-identifier runs folded to one hyphen. */
export function craftMcpSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(NON_IDENTIFIER, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The identifier-safe opencode server id; the id suffix keeps it unique across
 * servers that slugify to the same name (onyx `_server_key`, mcp_config.py:28-32).
 */
export function craftMcpServerKey(name: string, id: string): string {
  const slug = craftMcpSlug(name) || "mcp";
  return `${slug}-${id}`;
}

/** The relay route for one server, relative to the craft tree's mount root. */
export function craftMcpRelayPath(serverId: string): string {
  return `/mcp/${encodeURIComponent(serverId)}`;
}

/** The absolute relay url a session's mcp block carries for one server. */
export function craftMcpRelayUrl(base: string, serverId: string): string {
  return `${base.replace(/\/+$/, "")}/api/craft${craftMcpRelayPath(serverId)}`;
}

/**
 * The server id a relay url names, or null when the url is not a relay route
 * (the relay membership check reads this — a vendor url never matches).
 */
export function craftMcpServerIdOfRelayUrl(url: string): string | null {
  const index = url.indexOf("/api/craft/mcp/");
  if (index < 0) return null;
  const tail = url.slice(index + "/api/craft/mcp/".length);
  if (tail === "" || tail.includes("/")) return null;
  try {
    return decodeURIComponent(tail);
  } catch {
    return null;
  }
}

/** A plugins-catalogue server row as the craft resolution reads it. */
export type CraftMcpServerSource = {
  id: string;
  /** The server's display name (ServerRecord.title). */
  name: string;
};

/**
 * Resolve the user's craft MCP set (onyx `resolve_craft_mcp_servers`): servers the
 * user can authenticate against — connected in their own account — keyed for
 * opencode, pointed at the relay, with each server's disabled tools aggregated
 * and sorted. Unconnected servers are dropped entirely, exactly as onyx drops
 * unauthenticated ones: the relay would refuse their calls, so emitting them
 * only buys permanently broken tool discovery.
 */
export function resolveCraftMcpServers(input: {
  /** The catalogue rows in scope (already the deployment's enabled set). */
  servers: readonly CraftMcpServerSource[];
  /** Server ids the user has a usable personal connection for. */
  connectedServerIds: ReadonlySet<string>;
  /** The deployment's externally reachable base url (the relay's origin). */
  relayBaseUrl: string;
  /** Admin-disabled tool names per server id (empty until a source exists). */
  disabledToolsByServer?: Readonly<Record<string, readonly string[]>>;
}): CraftMCPServerConfig[] {
  const servers: CraftMCPServerConfig[] = [];
  for (const server of input.servers) {
    if (!input.connectedServerIds.has(server.id)) continue;
    const disabled = [
      ...(input.disabledToolsByServer?.[server.id] ?? []),
    ].sort();
    servers.push({
      key: craftMcpServerKey(server.name, server.id),
      url: craftMcpRelayUrl(input.relayBaseUrl, server.id),
      disabledTools: disabled,
    });
  }
  return servers;
}
