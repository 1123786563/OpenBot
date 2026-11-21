import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createApprovalStore } from "../src/approvals/store";
import {
  addAuditTap,
  createAuditStore,
  type AuditTapEvent,
} from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  actionPolicy,
  agents,
  approvalTeamRules,
  brokeredAccounts,
  brokeredConnections,
  corsairAccounts,
  corsairSharedAccess,
  githubPilotConnections,
  githubPilotRepositories,
  mcpServers,
  mcpTools,
  pluginGrants,
  sharedUseApprovals,
  sharedUseApprovalMembers,
  responsibilities,
  responsibilityTriggers,
  slackSharedInstallations,
  users,
  workItems,
} from "../src/db/schema";
import {
  createCorsairCutover,
  cutoverObservationMs,
} from "../src/plugins/corsair/cutover";
import { corsairGrantRef } from "../src/plugins/corsair/grants";
import { createCorsairReadinessRoutes } from "../src/plugins/corsair/readiness";
import { createRevocation } from "../src/plugins/corsair/revocation";
import { createGithubPilotProvider } from "../src/plugins/corsair/github";
import { createGithubPilotRoutes } from "../src/plugins/corsair/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.close());

function routes(
  workspaceId: string,
  role: "admin" | "user" = "admin",
  includeDeploymentLegacy = false,
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    c.set("actor", {
      id: "migration-admin",
      email: "migration-admin@example.test",
      role,
    });
    await next();
  };
  return createCorsairReadinessRoutes({
    database,
    requireUser,
    workspaceId,
    registrations: { github: "github-pilot", slack: "slack-pilot" },
    includeDeploymentLegacy,
    sharedSlackRegistration: "AFIXTURE",
  });
}

test("empty scoped inventory and missing evidence block readiness", async () => {
  const response = await routes("readiness-a").request("/github");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    workspaceId: "readiness-a",
    app: "github",
    ready: false,
    blockers: ["inventory_missing"],
    capabilities: [],
  });
  expect((await routes("readiness-a", "user").request("/github")).status).toBe(
    403,
  );
});

test("unreviewed grants cannot be copied", async () => {
  const response = await routes("readiness-a").request("/github/policies", {
    method: "POST",
    body: JSON.stringify({ legacyTool: "github/create_issue" }),
  });
  expect(response.status).toBe(400);
});

test("reviews are scoped and stale evidence cannot enable a policy copy", async () => {
  const workspace = randomUUID();
  const person = randomUUID();
  const botId = randomUUID();
  const restriction = randomUUID();
  const approvalIds: string[] = [];
  const serverId = randomUUID();
  const connection = randomUUID();
  const legacyTool = `${serverId}/GITHUB_CREATE_AN_ISSUE`;
  await database
    .insert(users)
    .values({ id: person, name: person, email: `${person}@example.test` });
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "built_in", configuration: {} });
  await database.insert(mcpServers).values({
    id: serverId,
    title: "GitHub fixture",
    vendor: "GitHub",
    url: "composio://github",
    provenance: "composio",
    accountMode: "personal",
  });
  try {
    await database
      .insert(mcpTools)
      .values({ serverId, name: "GITHUB_CREATE_AN_ISSUE", effect: "write" });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: legacyTool, agentId: botId });
    const [legacy] = await database
      .insert(brokeredAccounts)
      .values({
        provider: "composio",
        app: "github",
        userId: person,
        vendorUserId: person,
        isDefault: true,
      })
      .returning({ id: brokeredAccounts.id });
    await database.insert(githubPilotConnections).values({
      id: connection,
      workspaceId: workspace,
      registration: "github-pilot",
      personId: person,
      githubUserId: "123",
      login: "fixture",
      credential: "sealed-fixture",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await database.insert(githubPilotRepositories).values({
      workspaceId: workspace,
      registration: "github-pilot",
      repositoryId: "456",
      installationId: "789",
      nodeId: "repo-node",
      name: "fixture/repo",
    });
    const a = routes(workspace, "admin", true);
    const b = routes(randomUUID());
    const post = (url: string, input: unknown) =>
      a.request(url, { method: "POST", body: JSON.stringify(input) });
    const report = await (await a.request("/github")).json();
    expect(report.ready).toBe(false);
    const cutover = createCorsairCutover(database, {
      workspaceId: workspace,
      app: "github",
    });
    const observing = await cutover.activate("migration-admin", async () => []);
    if (observing?.kind !== "observing")
      throw new Error("Expected observing route");
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: "github",
      holder: "person",
      userId: person,
      vendorUserId: person,
      verified: true,
    });
    const rollbackReport = await (await a.request("/github")).json();
    const rollback = (body: unknown) =>
      a.request("/github/cutover", {
        method: "POST",
        headers: { "X-OpenBot-Pilot": "github" },
        body: JSON.stringify(body),
      });
    const refs = {
      legacyAuthorizationRef: "broker/live",
      currentPermissionsRef: "policy/live",
    };
    expect(
      (
        await rollback({
          kind: "rollback",
          inventoryRevision: rollbackReport.inventoryRevision,
          ...refs,
        })
      ).status,
    ).toBe(400);
    const evidence = {
      ...refs,
      workspaceId: workspace,
      app: "github",
      observationUntil: observing.until,
      observedAt: new Date().toISOString(),
      authorizationsValid: true,
      permissionsCurrent: true,
      capabilities: [
        `legacy-account:${legacy.id}`,
        `tool:${legacyTool}`,
      ].sort(),
    };
    const request = {
      kind: "rollback",
      inventoryRevision: rollbackReport.inventoryRevision,
    };
    for (const invalid of [
      { workspaceId: randomUUID() },
      { observedAt: new Date(Date.now() - 600_000).toISOString() },
      { capabilities: [] },
    ]) {
      expect(
        (await rollback({ ...request, evidence: { ...evidence, ...invalid } }))
          .status,
      ).toBe(409);
    }
    expect(
      (await rollback({ kind: "begin_cleanup", evidenceRef: "unchecked/ref" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await rollback({
          kind: "begin_cleanup",
          inventoryRevision: rollbackReport.inventoryRevision,
          evidence: {
            workspaceId: workspace,
            app: "github",
            observationUntil: observing.until,
            observedAt: observing.until,
            incidentsResolved: true,
            evidenceRef: "provider-review/observation",
          },
        })
      ).status,
    ).toBe(409);
    expect((await rollback({ ...request, evidence })).status).toBe(200);
    const checks = {
      identity: "evidence/identity",
      resourceScope: "evidence/resource",
      approval: "evidence/approval",
      event: "evidence/event",
      revocation: "evidence/revocation",
    };
    const revision = report.inventoryRevision;
    const decide = (
      capability: string,
      addedPermissions: string[],
      targetId?: string,
    ) =>
      post("/github/decisions", {
        capability,
        decision: {
          kind: "verified",
          inventoryRevision: revision,
          checks,
          addedPermissions,
          targetId,
        },
      });
    const capability = `tool:${legacyTool}`;
    expect((await decide(capability, ["issues:write"])).status).toBe(204);
    expect(
      (await decide(`legacy-account:${legacy.id}`, [], connection)).status,
    ).toBe(204);
    expect(await (await a.request("/github")).json()).toMatchObject({
      ready: false,
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          key: capability,
          blockers: [
            "policy_migration_required",
            "additional_permissions_required",
          ],
        }),
      ]),
    });
    const mapping = {
      legacyTool,
      botId,
      inventoryRevision: revision,
      binding: { kind: "personal", connections: [connection] },
      resources: ["456"],
      evidence: {
        equivalentAppAndAction: "evidence/action",
        identityAndResources: "evidence/scope",
        preservedRestrictions: "evidence/restrictions",
      },
    };
    expect((await post("/github/policies", mapping)).status).toBe(409);
    expect((await decide(capability, [])).status).toBe(204);
    expect((await (await a.request("/github")).json()).ready).toBe(false);
    expect((await (await a.request("/slack")).json()).ready).toBe(false);
    expect((await (await b.request("/github")).json()).ready).toBe(false);
    expect(
      (await post("/github/policies", { ...mapping, resources: ["457"] }))
        .status,
    ).toBe(409);
    expect((await post("/github/policies", mapping)).status).toBe(204);
    expect((await (await a.request("/github")).json()).ready).toBe(true);
    expect((await post("/github/policies", mapping)).status).toBe(409);
    const grant = await database
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "corsair.github"),
          eq(
            pluginGrants.ref,
            corsairGrantRef(
              workspace,
              "github-pilot",
              "corsair/github.create_issue",
            ),
          ),
          eq(pluginGrants.agentId, botId),
        ),
      );
    expect(grant).toHaveLength(1);

    const originalNow = Date.now;
    const expired = await (async () => {
      Date.now = () => originalNow() - cutoverObservationMs - 1000;
      try {
        return await cutover.activate("migration-admin", async () => []);
      } finally {
        Date.now = originalNow;
      }
    })();
    if (expired?.kind !== "observing")
      throw new Error("Expected observing route");
    const cleanupReport = await (await a.request("/github")).json();
    const cleanupEvidence = {
      workspaceId: workspace,
      app: "github",
      observationUntil: expired.until,
      observedAt: new Date().toISOString(),
      incidentsResolved: true,
      evidenceRef: "provider-review/observation",
    };
    const beginCleanup = (evidence: typeof cleanupEvidence) =>
      rollback({
        kind: "begin_cleanup",
        inventoryRevision: cleanupReport.inventoryRevision,
        evidence,
      });
    expect(
      (await beginCleanup({ ...cleanupEvidence, workspaceId: randomUUID() }))
        .status,
    ).toBe(409);
    const cleaned = await beginCleanup(cleanupEvidence);
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toEqual({ kind: "cleanup", excluded: [] });

    let remoteRequests = 0;
    const provider = createGithubPilotProvider(
      {
        appId: "9",
        clientId: "fixture",
        clientSecret: "fixture",
        redirectUri: "https://openbot.test/callback",
      },
      Object.assign(
        async () => {
          remoteRequests++;
          throw new Error("Unexpected remote request.");
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const approvals = createApprovalStore(database);
    const github = createGithubPilotRoutes({
      workspaceId: workspace,
      registration: "github-pilot",
      database,
      provider,
      approvals,
      audit: createAuditStore(database),
      encryptionKey: "fixture",
      canUseBot: async () => true,
      requireUser: async (c, next) => {
        c.set("actor", {
          id: person,
          email: `${person}@example.test`,
          role: "user",
        });
        await next();
      },
    });
    const invoke = (path: string, input: unknown) =>
      github.request(path, {
        method: "POST",
        headers: { "X-OpenBot-Pilot": "github" },
        body: JSON.stringify(input),
      });
    await database.insert(actionPolicy).values({
      id: "current",
      mode: "enforce",
      deny: [],
      allow: [`bot.id == "${botId}"`],
    });
    const input = {
      botId,
      connectionId: connection,
      repositoryId: 456,
      title: "Migration fixture",
    };
    const opened = await invoke("/approvals", input);
    const openedBody = await opened.json();
    expect(openedBody).toEqual(
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(opened.status).toBe(201);
    const current = await approvals.get(person, openedBody.id);
    const old = await approvals.open({
      ...current.action,
      toolRef: legacyTool,
      dispatch: undefined,
      policy: undefined,
      runId: randomUUID(),
      toolCallId: randomUUID(),
      actionDigest: randomUUID(),
    });
    approvalIds.push(old.id);
    expect((await invoke(`/approvals/${old.id}/execute`, input)).status).toBe(
      404,
    );
    await approvals.decide(person, old.id, "allow_conversation");
    expect((await invoke(`/approvals/${old.id}/execute`, input)).status).toBe(
      404,
    );
    expect(remoteRequests).toBe(0);

    await database.insert(approvalTeamRules).values({
      id: restriction,
      botId,
      toolRef: legacyTool,
      scope: "*",
      effect: "write",
      behaviour: "hand_off",
    });
    expect((await invoke("/approvals", input)).status).toBe(403);
    expect(remoteRequests).toBe(0);

    await database
      .update(githubPilotConnections)
      .set({ revision: randomUUID() })
      .where(eq(githubPilotConnections.workspaceId, workspace));
    const stale = await (await a.request("/github")).json();
    expect(stale.ready).toBe(false);
    expect(stale.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: capability,
          blockers: ["evidence_stale"],
        }),
      ]),
    );
    const exclusion = {
      capability,
      decision: {
        kind: "disabled",
        inventoryRevision: stale.inventoryRevision,
        reason: "Pilot owner retired this action.",
      },
    };
    expect(
      (
        await routes(workspace, "user", true).request("/github/decisions", {
          method: "POST",
          body: JSON.stringify(exclusion),
        })
      ).status,
    ).toBe(403);
    expect((await post("/github/decisions", exclusion)).status).toBe(204);
    expect(
      (
        await post("/github/decisions", {
          ...exclusion,
          capability: `legacy-account:${legacy.id}`,
        })
      ).status,
    ).toBe(204);
    const excluded = await (await a.request("/github")).json();
    expect(excluded.ready).toBe(true);
    const excludedCapability = excluded.capabilities.find(
      (entry: { key: string }) => entry.key === capability,
    );
    expect(excludedCapability.status).toBe("disabled");
    expect(excludedCapability.decision.actor).toBe("migration-admin");
  } finally {
    await database.delete(workItems).where(inArray(workItems.key, approvalIds));
    await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
    await database
      .delete(approvalTeamRules)
      .where(eq(approvalTeamRules.id, restriction));
    await database
      .delete(githubPilotRepositories)
      .where(eq(githubPilotRepositories.workspaceId, workspace));
    await database
      .delete(githubPilotConnections)
      .where(eq(githubPilotConnections.workspaceId, workspace));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(agents).where(eq(agents.id, botId));
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.userId, person));
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.userId, person));
    await database.delete(users).where(eq(users.id, person));
  }
});

test("Slack shared migration requires separate review and preserves the approved audience", async () => {
  const workspaceId = randomUUID();
  const botId = randomUUID();
  const serverId = randomUUID();
  const installationId = randomUUID();
  const legacyTool = `${serverId}/Slack_SendMessage`;
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "built_in", configuration: {} });
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Slack fixture",
    vendor: "Slack",
    url: "arcade://Slack",
    provenance: "arcade",
    accountMode: "shared",
  });
  try {
    await database
      .insert(mcpTools)
      .values({ serverId, name: "Slack_SendMessage", effect: "write" });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: legacyTool, agentId: botId });
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: "Slack",
      holder: "deployment",
      vendorUserId: workspaceId,
      verified: true,
    });
    await database.insert(sharedUseApprovals).values({
      agentId: botId,
      serverId,
      audience: "people",
      outsideInput: false,
      approvedBy: "migration-admin",
      approvedAs: "admin",
    });
    await database.insert(sharedUseApprovalMembers).values({
      agentId: botId,
      serverId,
      kind: "group",
      value: "workspace-operators",
    });
    await database.insert(slackSharedInstallations).values({
      id: installationId,
      workspaceId,
      appId: "AFIXTURE",
      teamId: "TFIXTURE",
      botId: "BFIXTURE",
      botUserId: "UFIXTURE",
      channelIds: ["CFIXTURE"],
    });

    const api = routes(workspaceId, "admin", true);
    const inventory = await (await api.request("/slack")).json();
    const post = (path: string, body: unknown) =>
      api.request(path, { method: "POST", body: JSON.stringify(body) });
    for (const capability of [`tool:${legacyTool}`, "legacy-account:arcade:"]) {
      expect(
        (
          await post("/slack/decisions", {
            capability,
            decision: {
              kind: "verified",
              inventoryRevision: inventory.inventoryRevision,
              checks: {
                identity: "evidence/identity",
                resourceScope: "evidence/scope",
                approval: "evidence/approval",
                event: "evidence/event",
                revocation: "evidence/revocation",
              },
              addedPermissions: [],
              targetId: installationId,
            },
          })
        ).status,
      ).toBe(204);
    }
    const mapping = {
      legacyTool,
      botId,
      inventoryRevision: inventory.inventoryRevision,
      binding: { kind: "shared", installationId },
      resources: ["CFIXTURE"],
      evidence: {
        equivalentAppAndAction: "evidence/action",
        identityAndResources: "evidence/scope",
        preservedRestrictions: "evidence/restrictions",
      },
    };
    expect((await post("/slack/policies", mapping)).status).toBe(409);
    expect(
      (
        await post("/slack/policies", {
          ...mapping,
          evidence: {
            ...mapping.evidence,
            sharedAudienceAndOutsideInput: "evidence/audience",
          },
        })
      ).status,
    ).toBe(204);
    const [stored] = await database
      .select()
      .from(corsairSharedAccess)
      .where(eq(corsairSharedAccess.installationId, installationId));
    expect(stored).toMatchObject({
      granted: true,
      approval: {
        audience: "people",
        outsideInput: false,
        members: [{ kind: "group", value: "workspace-operators" }],
      },
    });
    expect(await (await api.request("/slack")).json()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          key: "legacy-account:arcade:",
          status: "ready",
          requiredConnectionIds: [installationId],
        }),
      ]),
    });
    await createRevocation({ database, verify: async () => false }).disconnect(
      eq(corsairAccounts.id, installationId),
      "migration-admin",
    );
    expect(await (await api.request("/slack")).json()).toMatchObject({
      ready: false,
      connections: expect.arrayContaining([
        expect.objectContaining({ id: installationId, status: "disconnected" }),
      ]),
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          key: "legacy-account:arcade:",
          status: "blocked",
          requiredConnectionIds: [installationId],
        }),
      ]),
    });
  } finally {
    await database
      .delete(corsairAccounts)
      .where(eq(corsairAccounts.id, installationId));
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.vendorUserId, workspaceId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(agents).where(eq(agents.id, botId));
  }
});

test("activation rereads current readiness and switches only the reviewed app", async () => {
  const workspaceId = randomUUID();
  const botId = randomUUID();
  const installationId = randomUUID();
  const owner = randomUUID();
  const goalId = randomUUID();
  const triggerId = randomUUID();
  const app = routes(workspaceId, "admin", true);
  const tapped: AuditTapEvent[] = [];
  const detachTap = addAuditTap((event) => {
    if (event.targetId === JSON.stringify([workspaceId, "slack"]))
      tapped.push(event);
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "X-OpenBot-Pilot": "slack" },
      body: JSON.stringify(body),
    });
  await database.insert(agents).values({
    id: botId,
    name: botId,
    type: "built_in",
    configuration: {},
  });
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(responsibilities).values({
    id: goalId,
    ownerUserId: owner,
    agentId: botId,
    channelId: "fixture-channel",
    threadId: "fixture-thread",
    title: "Observe Slack",
    instruction: "Observe Slack messages",
    successCriteria: "Observe one message",
  });
  await database.insert(responsibilityTriggers).values({
    id: triggerId,
    ownerUserId: owner,
    responsibilityId: goalId,
    kind: "slack",
    config: {
      kind: "slack",
      teamId: "TFIXTURE",
      channels: ["CFIXTURE"],
      mode: "phrase",
      phrases: ["fixture"],
      reactions: [],
    },
  });
  try {
    await database.insert(slackSharedInstallations).values({
      id: installationId,
      workspaceId,
      appId: "AFIXTURE",
      teamId: "TFIXTURE",
      botId: "BFIXTURE",
      botUserId: "UFIXTURE",
      channelIds: ["CFIXTURE"],
    });
    await database.insert(corsairSharedAccess).values({
      installationId,
      botId,
      granted: true,
    });
    const { inventoryRevision } = await (await app.request("/slack")).json();
    const activate = (revision: string) =>
      post("/slack/cutover", { kind: "activate", inventoryRevision: revision });
    expect((await activate(inventoryRevision)).status).toBe(409);
    expect(
      (
        await post("/slack/decisions", {
          capability: `shared-grant:${botId}:${installationId}`,
          decision: {
            kind: "verified",
            inventoryRevision,
            checks: {
              identity: "fixture/identity",
              resourceScope: "fixture/scope",
              approval: "fixture/approval",
              event: "fixture/event",
              revocation: "fixture/revocation",
            },
            addedPermissions: [],
          },
        })
      ).status,
    ).toBe(204);
    expect((await activate(inventoryRevision)).status).toBe(409);
    const exclusion = {
      capability: `trigger:${triggerId}`,
      decision: {
        kind: "disabled",
        inventoryRevision,
        reason: "Exclude fixture Trigger",
      },
    };
    expect(
      (
        await routes(workspaceId, "user", true).request("/slack/decisions", {
          method: "POST",
          body: JSON.stringify(exclusion),
        })
      ).status,
    ).toBe(403);
    expect((await post("/slack/decisions", exclusion)).status).toBe(204);
    expect((await activate("0".repeat(64))).status).toBe(409);
    const activated = await activate(inventoryRevision);
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      kind: "observing",
      excluded: [`trigger:${triggerId}`],
    });
    expect(tapped.map((row) => row.eventType)).toEqual([
      "corsair.migration_readiness_decided",
      "corsair.migration_readiness_decided",
      "corsair.migration_route_changed",
    ]);
    const store = createResponsibilityStore(database, {
      deploymentId: workspaceId,
      resolveTarget: async () => ({ threadId: "fixture-thread" }),
    });
    const result = await store.ingestEvent({
      ownerUserId: owner,
      responsibilityId: goalId,
      triggerId,
      source: "slack",
      externalId: randomUUID(),
      type: "slack.message",
      payload: {},
    });
    expect(result.runIds).toEqual([]);
    expect(await store.listRuns(owner, goalId)).toEqual([]);
    expect(await (await app.request("/github/cutover")).json()).toEqual({
      kind: "legacy",
    });
  } finally {
    detachTap();
    await database.delete(users).where(eq(users.id, owner));
    await database
      .delete(corsairAccounts)
      .where(eq(corsairAccounts.id, installationId));
    await database.delete(agents).where(eq(agents.id, botId));
  }
});
