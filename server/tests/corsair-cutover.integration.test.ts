import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { eq } from "drizzle-orm";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import {
  createCorsairCutover,
  cutoverRefusal,
  dispatchCorsairWrite,
  withLegacyCorsairRoute,
} from "../src/plugins/corsair/cutover";
import { createCorsairReadinessRoutes } from "../src/plugins/corsair/readiness";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

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
  await expect(disconnect()).rejects.toThrow(
    "Use the legacy cleanup inventory",
  );
  expect(cleanupCalls).toBe(0);
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

test.each(["applied", "not_applied"] as const)(
  "a lost broker write response reconciled as %s controls legacy retries",
  async (outcome) => {
    const workspaceId = randomUUID();
    const botId = randomUUID();
    const actorId = randomUUID();
    const serverId = randomUUID();
    const app = "github" as const;
    const toolName = "GITHUB_CREATE_AN_ISSUE";
    const ref = `${serverId}/${toolName}`;
    const scope = { workspaceId, app };
    const cutover = createCorsairCutover(database, scope);
    let sends = 0;
    const store = createPluginStore({
      database,
      deploymentId: workspaceId,
      brokerProvider: "composio",
      auditStore: createAuditStore(database),
      credentials: createCredentialStore(database),
      encryptionKey: "A".repeat(43) + "=",
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      callVendor: async (connection, tool, args) => {
        expect(connection.actorId).toBe(actorId);
        expect(tool).toBe(toolName);
        expect(args).toEqual({
          owner: "team",
          repo: "project",
          title: "fixture",
        });
        if (++sends === 1) throw new Error("response lost");
        return { text: "created", isError: false };
      },
    });
    const migration = createCorsairReadinessRoutes({
      database,
      workspaceId,
      registrations: {},
      includeDeploymentLegacy: true,
      requireUser: async (c, next) => {
        c.set("actor", {
          id: actorId,
          email: "operator@example.test",
          role: "admin",
        });
        await next();
      },
    });
    const token = "fixture-deployment-agent-token";
    const config = loadConfig(testEnvironment({ AGENT_TOOL_TOKEN: token }));
    const appServer = createApp(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    async function write() {
      const response = await appServer.request("/api/agent-tools/call", {
        method: "POST",
        headers: {
          "x-openbot-agent-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: `mcp__${serverId}__${toolName}`,
          args: { owner: "team", repo: "project", title: "fixture" },
          run: mintRunAssertion(
            { botId, actorId, runId: randomUUID() },
            config.keyEncryptionKey,
          ),
        }),
      });
      expect(response.status).toBe(200);
      return response.json();
    }
    await database
      .insert(agents)
      .values({ id: botId, name: botId, type: "built_in", configuration: {} });
    try {
      await database.insert(mcpServers).values({
        id: serverId,
        title: "GitHub fixture",
        vendor: "GitHub",
        url: "composio://github",
        provenance: "composio",
        accountMode: "personal",
      });
      await database
        .insert(mcpTools)
        .values({ serverId, name: toolName, effect: "write" });
      await database.insert(brokeredConnections).values({
        provider: "composio",
        app,
        holder: "person",
        userId: actorId,
        vendorUserId: actorId,
        verified: true,
      });
      await store.grant("mcp", ref, botId, actorId);
      expect(await write()).toMatchObject({
        text: expect.stringContaining("response lost"),
        isError: true,
      });
      expect(await write()).toMatchObject({
        text: expect.stringContaining("Check its outcome"),
        isError: true,
      });
      expect(sends).toBe(1);
      await cutover.activate(actorId, async () => []);
      const [pending] = await (
        await migration.request("/github/unknown-writes")
      ).json();
      expect(pending).toMatchObject({
        targetId: ref,
        route: "legacy",
        canReconcile: true,
      });
      await expect(
        dispatchCorsairWrite(
          database,
          {
            ...scope,
            botId,
            registration: "fixture",
            grant: "fixture",
            approvalId: randomUUID(),
            writeKey: "native fixture key",
            binding: "personal",
          },
          randomUUID(),
          undefined,
          async () => {
            sends++;
          },
        ),
      ).rejects.toThrow("Check its outcome");
      expect(sends).toBe(1);
      expect(
        (
          await migration.request(
            `/github/unknown-writes/${pending.approvalId}`,
            {
              method: "PUT",
              headers: { "X-OpenBot-Pilot": "github" },
              body: JSON.stringify({
                outcome,
                evidenceRef: "fixture/provider-history",
              }),
            },
          )
        ).status,
      ).toBe(204);
      await cutover.rollback(actorId, {}, async () => true);
      if (outcome === "applied") {
        expect(await write()).toMatchObject({
          text: expect.stringContaining("confirmed applied"),
          isError: true,
        });
        expect(sends).toBe(1);
      } else {
        expect(await write()).toMatchObject({
          text: expect.stringContaining("created"),
          isError: false,
        });
        expect(sends).toBe(2);
      }
    } finally {
      await database
        .delete(brokeredConnections)
        .where(eq(brokeredConnections.userId, actorId));
      await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
      await database.delete(agents).where(eq(agents.id, botId));
    }
  },
);
