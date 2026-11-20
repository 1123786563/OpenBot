import { MCPMock } from "@copilotkit/aimock/mcp";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { agents, mcpServers } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import {
  createCorsairCutover,
  cutoverRefusal,
  withLegacyCorsairRoute,
} from "../src/plugins/corsair/cutover";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 6 });
afterAll(() => database.$client.close());

test("a draining workspace/app rejects new dispatch and keeps legacy on timeout", async () => {
  const workspaceId = randomUUID();
  const scope = { workspaceId, app: "github" as const };
  const cutover = createCorsairCutover(database, scope, 250);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const call = cutover.dispatch("legacy", () => {
    started.resolve();
    return finish.promise;
  });
  await started.promise;
  try {
    const switchRoute = cutover.activate("admin", async () => []);
    await expect(
      (async () => {
        for (let poll = 0; poll < 100; poll++) {
          try {
            await cutover.dispatch("legacy", async () => "legacy");
          } catch (error) {
            if (error instanceof cutoverRefusal) return error.status;
            throw error;
          }
          await Bun.sleep(5);
        }
        throw new Error("The route never closed admission during its drain.");
      })(),
    ).resolves.toBe(409);
    await expect(
      withLegacyCorsairRoute(
        database,
        workspaceId,
        "arcade",
        "arcade://slack",
        async () => "slack",
      ),
    ).resolves.toBe("slack");
    expect(await switchRoute).toBeNull();
    expect(await cutover.read()).toEqual({ kind: "legacy" });
  } finally {
    finish.resolve("completed");
    await call;
  }
  expect(await cutover.activate("admin", async () => [])).toMatchObject({
    kind: "observing",
  });
  await expect(
    cutover.dispatch("legacy", async () => "legacy"),
  ).rejects.toThrow();
  await expect(
    cutover.dispatch("corsair", async () => "corsair"),
  ).resolves.toBe("corsair");
  await expect(
    withLegacyCorsairRoute(
      database,
      workspaceId,
      "mcp",
      "https://mcp.example/github",
      async () => "direct MCP",
    ),
  ).resolves.toBe("direct MCP");
  await expect(
    withLegacyCorsairRoute(
      database,
      randomUUID(),
      "composio",
      "composio://github",
      async () => "other workspace",
    ),
  ).resolves.toBe("other workspace");
});

test("rollback requires current evidence and is permanently blocked once cleanup starts", async () => {
  const cutover = createCorsairCutover(database, {
    workspaceId: randomUUID(),
    app: "slack",
  });
  expect(await cutover.activate("admin", async () => null)).toBeNull();
  await cutover.activate("admin", async () => []);
  let cleanupCalls = 0;
  const disconnect = () =>
    cutover.disconnectLegacy("admin", async () => ++cleanupCalls);
  await expect(disconnect()).rejects.toThrow("Mark legacy cleanup");
  expect(cleanupCalls).toBe(0);
  expect(
    await cutover.rollback(
      "admin",
      {
        legacyAuthorizationRef: "provider-review/1",
        currentPermissionsRef: "policy-review/1",
      },
      async () => false,
    ),
  ).toBeNull();
  expect(
    await cutover.rollback(
      "admin",
      {
        legacyAuthorizationRef: "provider-review/2",
        currentPermissionsRef: "policy-review/2",
      },
      async () => true,
    ),
  ).toEqual({ kind: "legacy" });
  await cutover.activate("admin", async () => []);
  expect(
    await cutover.beginCleanup("admin", "provider-review/3"),
  ).toMatchObject({ kind: "cleanup" });
  await expect(disconnect()).resolves.toBe(1);
  expect(
    await cutover.rollback(
      "admin",
      {
        legacyAuthorizationRef: "provider-review/4",
        currentPermissionsRef: "policy-review/4",
      },
      async () => true,
    ),
  ).toBeNull();
  await expect(
    cutover.dispatch("corsair", async () => "repaired"),
  ).resolves.toBe("repaired");
});

test("an active GitHub cutover leaves a direct MCP session and tool call available", async () => {
  const mock = new MCPMock();
  let reached = 0;
  mock
    .addTool({
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: {} },
    })
    .onToolCall("list_issues", () => {
      reached++;
      return "fixture issue #123";
    });
  const url = await mock.start();
  const workspaceId = randomUUID();
  const serverId = randomUUID();
  const botId = randomUUID();
  const actorId = randomUUID();
  const store = createPluginStore({
    database,
    deploymentId: workspaceId,
    brokerProvider: "composio",
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: "A".repeat(43) + "=",
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  });
  try {
    await createCorsairCutover(database, {
      workspaceId,
      app: "github",
    }).activate(actorId, async () => []);
    await database
      .insert(agents)
      .values({ id: botId, name: botId, type: "built_in", configuration: {} });
    // Register the fixture directly because the admin form requires TLS.
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Direct MCP fixture",
      vendor: "GitHub",
      url,
      provenance: "custom",
    });
    await store.refreshTools(serverId);
    const ref = `${serverId}/list_issues`;
    await store.grant("mcp", ref, botId, actorId);
    const outcome = await store.callTool({ ref, botId, actorId, args: {} });
    expect(outcome).toEqual({ text: "fixture issue #123", isError: false });
    expect(reached).toBe(1);
  } finally {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(agents).where(eq(agents.id, botId));
    await mock.stop();
  }
});
