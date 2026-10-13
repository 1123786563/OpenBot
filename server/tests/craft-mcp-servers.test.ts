import { describe, expect, test } from "bun:test";
import {
  craftMcpRelayUrl,
  craftMcpServerIdOfRelayUrl,
  craftMcpServerKey,
  resolveCraftMcpServers,
} from "../src/craft/mcp-servers";

/**
 * The per-user craft MCP resolution (onyx mcp_config.py:28-75): the slug-keyed
 * opencode server ids, the unauthenticated-server drop, and the OpenBot
 * environment-equivalent url — the server-side relay route, never the vendor
 * endpoint (credentials attach on the server side only).
 */

describe("craftMcpServerKey (onyx _server_key)", () => {
  test("slugifies the name and suffixes the id", () => {
    expect(craftMcpServerKey("Acme Tools", "42")).toBe("acme-tools-42");
  });

  test("non-alphanumeric runs fold to one hyphen; edges stripped", () => {
    expect(craftMcpServerKey("MCP Server!!", "7")).toBe("mcp-server-7");
    expect(craftMcpServerKey("--Weird  Name--", "7")).toBe("weird-name-7");
  });

  test("a name with no [a-z0-9] falls back to mcp", () => {
    expect(craftMcpServerKey("中文", "42")).toBe("mcp-42");
    expect(craftMcpServerKey("!!!", "42")).toBe("mcp-42");
  });
});

describe("relay urls", () => {
  test("the relay url is the deployment's craft tree + the server id", () => {
    expect(craftMcpRelayUrl("https://openbot.example", "srv_1")).toBe(
      "https://openbot.example/api/craft/mcp/srv_1",
    );
    expect(craftMcpRelayUrl("https://openbot.example/", "srv 1")).toBe(
      "https://openbot.example/api/craft/mcp/srv%201",
    );
  });

  test("the server id parses back out of a relay url", () => {
    expect(
      craftMcpServerIdOfRelayUrl("https://openbot.example/api/craft/mcp/srv_1"),
    ).toBe("srv_1");
    expect(
      craftMcpServerIdOfRelayUrl("https://openbot.example/api/craft/mcp/a%2Fb"),
    ).toBe("a/b");
    expect(craftMcpServerIdOfRelayUrl("https://acme.example/mcp")).toBeNull();
  });
});

describe("resolveCraftMcpServers", () => {
  const servers = [
    { id: "42", name: "Acme Tools" },
    { id: "50", name: "Ghost" },
    { id: "srv-7", name: "Another" },
  ];

  test("keeps only servers the user can authenticate; drops the rest entirely", () => {
    const resolved = resolveCraftMcpServers({
      servers,
      connectedServerIds: new Set(["42", "srv-7"]),
      relayBaseUrl: "https://openbot.example",
    });
    expect(resolved.map((server) => server.key)).toEqual([
      "acme-tools-42",
      "another-srv-7",
    ]);
    // Ghost never reaches the config — not in the mcp block, not in permissions.
    expect(resolved.some((server) => server.key.includes("ghost"))).toBe(false);
  });

  test("urls point at the relay, never the vendor endpoint", () => {
    const resolved = resolveCraftMcpServers({
      servers,
      connectedServerIds: new Set(["42"]),
      relayBaseUrl: "https://openbot.example",
    });
    expect(resolved[0].url).toBe("https://openbot.example/api/craft/mcp/42");
  });

  test("disabled tools are aggregated per server, sorted", () => {
    const resolved = resolveCraftMcpServers({
      servers,
      connectedServerIds: new Set(["42"]),
      relayBaseUrl: "https://openbot.example",
      disabledToolsByServer: { "42": ["delete_everything", "admin_reset"] },
    });
    expect(resolved[0].disabledTools).toEqual([
      "admin_reset",
      "delete_everything",
    ]);
  });

  test("no connections resolve to an empty set (a live fingerprint of none)", () => {
    expect(
      resolveCraftMcpServers({
        servers,
        connectedServerIds: new Set(),
        relayBaseUrl: "https://openbot.example",
      }),
    ).toEqual([]);
  });
});
