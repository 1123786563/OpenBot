import { afterEach, describe, expect, test } from "bun:test";
import {
  deploymentAlias,
  isAlias,
  listTools,
  callTool,
  personalAlias,
  toolkitOf,
  useOpenConnectorClient,
  type OpenConnectorActions,
} from "../src/plugins/openconnector";

const stub: OpenConnectorActions = {
  listActions: async () => [
    {
      id: "github.get_current_user",
      description: "Get the authenticated user",
      inputSchema: { type: "object" },
    },
  ],
  execute: async (_call) => ({ data: { login: "octocat" } }),
};

afterEach(() => useOpenConnectorClient(null));

describe("toolkitOf", () => {
  test("reads the service off an openconnector url", () => {
    expect(toolkitOf("openconnector://github")).toBe("github");
  });
  test("null for anything else, including paths and other schemes", () => {
    expect(toolkitOf("composio://github")).toBeNull();
    expect(toolkitOf("openconnector://github/repo")).toBeNull();
    expect(toolkitOf("openconnector://")).toBeNull();
    expect(toolkitOf("https://example.com")).toBeNull();
  });
});

describe("aliases", () => {
  test("personal and deployment aliases are distinct and deterministic", () => {
    expect(personalAlias("user-1", "github")).toBe(
      personalAlias("user-1", "github"),
    );
    expect(personalAlias("user-1", "github")).not.toBe(
      personalAlias("user-2", "github"),
    );
    expect(deploymentAlias("dep-1", "github")).toMatch(/^openbot-d-/);
    expect(personalAlias("user-1", "github")).toMatch(/^openbot-u-/);
  });
  test("characters outside the safe set are escaped, so a service or id cannot forge another", () => {
    expect(personalAlias("user:1/x", "github")).not.toContain(":");
    expect(personalAlias("user-1", "git hub")).not.toContain(" ");
  });
  test("isAlias admits only minted aliases", () => {
    expect(isAlias(personalAlias("u", "github"))).toBe(true);
    expect(isAlias("some-person-id")).toBe(false);
    expect(isAlias(undefined)).toBe(false);
  });
});

describe("listTools", () => {
  test("lists the service's actions once a client is installed", async () => {
    useOpenConnectorClient(stub);
    const tools = await listTools({ url: "openconnector://github" });
    expect(tools.map((tool) => tool.name)).toEqual(["github.get_current_user"]);
  });
  test("refuses without an installed client rather than answering empty", async () => {
    await expect(listTools({ url: "openconnector://github" })).rejects.toThrow(
      /not configured/i,
    );
  });
  test("refuses a url that is not one of ours rather than asking the vendor", async () => {
    useOpenConnectorClient(stub);
    await expect(listTools({ url: "https://example.com" })).rejects.toThrow();
  });
});

describe("callTool", () => {
  test("dials with the alias handle when one is set", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool(
      {
        url: "openconnector://github",
        accountHandle: personalAlias("u1", "github"),
      },
      "github.get_current_user",
      {},
    );
    expect(result.isError).toBe(false);
  });
  test("dials without an alias for a no-auth service (virtual connection)", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool(
      { url: "openconnector://hackernews" },
      "hackernews.get_top_stories",
      {},
    );
    expect(result.isError).toBe(false);
  });
  test("a non-alias actorId is not sent as an alias", async () => {
    useOpenConnectorClient({
      ...stub,
      execute: async (call) => {
        expect(call.alias).toBeNull();
        return { data: {} };
      },
    });
    await callTool(
      { url: "openconnector://github" },
      "github.get_current_user",
      {},
    );
  });
  test("refuses a url with no service", async () => {
    useOpenConnectorClient(stub);
    const result = await callTool(
      { url: "https://example.com" },
      "github.get_current_user",
      {},
    );
    expect(result.isError).toBe(true);
  });
});
