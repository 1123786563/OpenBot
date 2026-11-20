import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditReader, createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  brokeredAccounts,
  githubPilotRepositories,
  users,
} from "../src/db/schema";
import type { GithubPilotProvider } from "../src/plugins/corsair/github";
import { readVerifiedLegacyGithubDefaults } from "../src/plugins/corsair/legacy-defaults";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
type AppArgs = Parameters<typeof createApp>;
type Pilot = NonNullable<AppArgs[34]>["githubPilot"];
const fixtureIds = {
  people: [] as string[],
  workspaces: [] as string[],
  bots: [] as string[],
};
const connectionResponse = z.object({ connectionId: z.uuid() });
const approvalResponse = z.object({
  id: z.uuid(),
  action: z.object({ target: connectionResponse }),
});

afterAll(async () => {
  await database
    .delete(githubPilotRepositories)
    .where(inArray(githubPilotRepositories.workspaceId, fixtureIds.workspaces));
  await database
    .delete(brokeredAccounts)
    .where(inArray(brokeredAccounts.userId, fixtureIds.people));
  await database.delete(agents).where(inArray(agents.id, fixtureIds.bots));
  await database.delete(users).where(inArray(users.id, fixtureIds.people));
  await database.$client.end({ timeout: 5 });
});

async function fixture() {
  const person = randomUUID();
  const otherPerson = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspace = randomUUID();
  const botId = randomUUID();
  const registration = "fixture/9";
  const otherRegistration = "fixture/10";
  fixtureIds.people.push(person, otherPerson);
  fixtureIds.workspaces.push(workspaceId, otherWorkspace);
  fixtureIds.bots.push(botId);
  await database.insert(users).values(
    [person, otherPerson].map((id) => ({
      id,
      name: "Fixture Person",
      email: `${id}@example.test`,
    })),
  );
  await database.insert(agents).values({
    id: botId,
    name: "Fixture Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: botId,
    ownerUserId: person,
    title: "Fixture Bot",
    roleDescription: "Test the public account API",
    avatarSeed: botId,
    visibility: "public",
  });
  const writes: { userId: number; title: string }[] = [];
  let now = new Date();
  const expiresAt = new Date(now.getTime() + 3_600_000);
  const identity = (token: string) => {
    if (token === "first") return { id: 12, login: "octocat" };
    if (token === "second") return { id: 34, login: "hubot" };
    if (token === "same-name") return { id: 56, login: "octocat" };
    throw new Error("Unexpected fixture token");
  };
  const provider: GithubPilotProvider = {
    authorizationUrl: ({ state }) => `https://example.test/?state=${state}`,
    exchange: async ({ code }) => ({
      token: code,
      identity: identity(code),
      expiresAt:
        code === "second"
          ? new Date(expiresAt.getTime() + 3_600_000)
          : expiresAt,
    }),
    revokeAccess: async () => {
      throw new Error("Unexpected GitHub revocation");
    },
    identity: async (token) => identity(token),
    repository: async () => ({
      id: 23,
      node_id: "R_pilot",
      name: "pilot",
      owner: { login: "acme" },
      has_issues: true,
      archived: false,
    }),
    createIssue: async ({ token, title }) => {
      const user = identity(token);
      writes.push({ userId: user.id, title });
      return {
        id: 901,
        number: writes.length,
        htmlUrl: `https://example.test/issues/${writes.length}`,
        user,
      };
    },
  };
  const deps = {
    workspaceId,
    registration,
    database,
    provider,
    approvals: createApprovalStore(database),
    audit: createAuditStore(database),
    encryptionKey: randomBytes(32).toString("base64"),
    clock: () => now,
  } satisfies Pilot;
  const client = (pilot: Pilot = deps, actor: string = person) => {
    const appArgs: AppArgs = [
      loadConfig(
        testEnvironment({
          DATABASE_URL: testDatabaseUrl(),
          KEY_ENCRYPTION_KEY: deps.encryptionKey,
        }),
      ),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get("x-fixture-person");
            return id === person || id === otherPerson
              ? { user: { id, email: `${id}@example.test` } }
              : null;
          },
        },
      },
      { rolesForUser: async () => ["admin"] },
    ];
    appArgs[9] = createAgentProfileStore(database, undefined);
    appArgs[34] = { githubPilot: pilot };
    const app = createApp(...appArgs);
    const request = (path: string, value?: unknown, method = "GET") =>
      app.request(`/api/corsair/github${path}`, {
        method,
        headers: {
          "X-OpenBot-Pilot": "github",
          "Content-Type": "application/json",
          "x-fixture-person": actor,
        },
        body: JSON.stringify(value),
      });
    return {
      request,
      connect: async (code: string) => {
        const start = await request("/connect", {}, "POST");
        expect(start.status).toBe(201);
        const state = new URL(
          (await start.json()).authorizationUrl,
        ).searchParams.get("state");
        const callback = await request(`/callback?code=${code}&state=${state}`);
        expect(callback.status).toBe(200);
        return connectionResponse.parse(await callback.json()).connectionId;
      },
      setDefault: (connectionId: string) =>
        request("/connections/default", { connectionId }, "PUT"),
      register: async (connectionId: string) => {
        expect(
          (
            await request(
              "/repositories",
              { connectionId, installationId: 819, repositoryId: 23 },
              "POST",
            )
          ).status,
        ).toBe(200);
        expect(
          (await request(`/bots/${botId}/grant`, { enabled: true }, "PUT"))
            .status,
        ).toBe(200);
      },
    };
  };
  return {
    person,
    otherPerson,
    workspaceId,
    otherWorkspace,
    registration,
    otherRegistration,
    writes,
    deps,
    client,
    expire: () => {
      now = expiresAt;
    },
    args: { botId, repositoryId: 23, title: "Fixture write" },
  };
}

async function openApproval(
  client: ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>,
  args: object,
) {
  const opened = await client.request("/approvals", args, "POST");
  expect(opened.status).toBe(201);
  return approvalResponse.parse(await opened.json());
}

async function allow(
  client: ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>,
  approvalId: string,
) {
  expect(
    (
      await client.request(
        `/approvals/${approvalId}/decision`,
        { decision: "allow_once" },
        "POST",
      )
    ).status,
  ).toBe(200);
}

test("the Person can select a default and explicitly invoke another reauthorized GitHub account", async () => {
  const f = await fixture();
  const client = f.client();
  const first = await client.connect("first");
  const second = await client.connect("second");
  expect(first).not.toBe(second);
  expect(await (await client.request("/connections")).json()).toMatchObject({
    connections: expect.arrayContaining([
      {
        id: first,
        githubUserId: "12",
        login: "octocat",
        expiresAt: expect.any(String),
      },
      {
        id: second,
        githubUserId: "34",
        login: "hubot",
        expiresAt: expect.any(String),
      },
    ]),
    defaultConnectionId: null,
  });
  await client.register(first);
  const unselected = await client.request("/approvals", f.args, "POST");
  expect(unselected.status).toBe(409);
  expect(await unselected.json()).toMatchObject({
    error: expect.stringContaining("Choose"),
  });
  expect((await client.setDefault(second)).status).toBe(200);
  expect(await (await client.request("/connections")).json()).toMatchObject({
    defaultConnectionId: second,
  });
  const defaultApproval = await openApproval(client, f.args);
  const explicitArgs = { ...f.args, connectionId: first };
  const explicitApproval = await openApproval(client, explicitArgs);
  expect(defaultApproval.action.target.connectionId).toBe(second);
  expect(explicitApproval.action.target.connectionId).toBe(first);
  for (const [approval, args, userId] of [
    [defaultApproval, f.args, 34],
    [explicitApproval, explicitArgs, 12],
  ] as const) {
    await allow(client, approval.id);
    const result = await client.request(
      `/approvals/${approval.id}/execute`,
      args,
      "POST",
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      issue: { user: { id: userId } },
    });
  }
  expect(f.writes).toEqual([
    { userId: 34, title: f.args.title },
    { userId: 12, title: f.args.title },
  ]);
});

test("only the verified legacy GitHub user ID inherits the default in the attested workspace", async () => {
  const f = await fixture();
  const legacyAccount = {
    id: randomUUID(),
    provider: "composio" as const,
    app: "github",
    userId: f.person,
    vendorUserId: f.person,
    accountId: "broker-account-12",
    identity: "octocat",
    isDefault: true,
  };
  await database.insert(brokeredAccounts).values([
    legacyAccount,
    {
      ...legacyAccount,
      id: randomUUID(),
      userId: f.otherPerson,
      vendorUserId: f.otherPerson,
    },
  ]);
  const deps = {
    ...f.deps,
    legacyDefaults: readVerifiedLegacyGithubDefaults(
      JSON.stringify([
        {
          workspaceId: f.workspaceId,
          registration: f.registration,
          personId: f.person,
          brokeredAccountId: legacyAccount.id,
          githubUserId: 12,
          evidenceRef: "provider-identity-record-1",
        },
      ]),
    ),
  };
  const client = f.client(deps);
  const otherPerson = f.client(deps, f.otherPerson);
  const otherWorkspace = f.client({ ...deps, workspaceId: f.otherWorkspace });
  await client.connect("same-name");
  expect(await (await client.request("/connections")).json()).toMatchObject({
    defaultConnectionId: null,
  });
  await otherWorkspace.connect("first");
  expect(
    await (await otherWorkspace.request("/connections")).json(),
  ).toMatchObject({ defaultConnectionId: null });
  await otherPerson.connect("first");
  expect(
    await (await otherPerson.request("/connections")).json(),
  ).toMatchObject({ defaultConnectionId: null });
  const first = await client.connect("first");
  expect(await (await client.request("/connections")).json()).toMatchObject({
    defaultConnectionId: first,
  });
  const second = await client.connect("second");
  expect((await client.setDefault(second)).status).toBe(200);
  expect(await client.connect("first")).toBe(first);
  expect(await (await client.request("/connections")).json()).toMatchObject({
    defaultConnectionId: second,
  });
});

test("a pending GitHub Approval keeps its Connection after the default changes and refuses an expired pin", async () => {
  const f = await fixture();
  const client = f.client();
  const first = await client.connect("first");
  const second = await client.connect("second");
  await client.register(first);
  expect((await client.setDefault(first)).status).toBe(200);
  const pending = await openApproval(client, f.args);
  const expiring = await openApproval(client, f.args);
  expect((await client.setDefault(second)).status).toBe(200);
  await allow(client, pending.id);
  await allow(client, expiring.id);
  const execute = (id: string, args: object) =>
    client.request(`/approvals/${id}/execute`, args, "POST");
  expect(
    (await execute(pending.id, { ...f.args, connectionId: randomUUID() }))
      .status,
  ).toBe(409);
  expect(
    (await execute(pending.id, { ...f.args, connectionId: second })).status,
  ).toBe(409);
  expect(
    (await execute(pending.id, { ...f.args, body: "Changed body" })).status,
  ).toBe(409);
  expect(f.writes).toEqual([]);
  const result = await execute(pending.id, f.args);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ issue: { user: { id: 12 } } });
  f.expire();
  const refused = await execute(expiring.id, f.args);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({
    error: expect.stringContaining("requires authorization"),
  });
  const { events } = await createAuditReader(database).list({
    actorUserId: f.person,
    eventType: "corsair.github.write_refused",
    limit: 10,
  });
  expect(events).toHaveLength(4);
  expect(events.every((event) => event.payload?.connectionId === first)).toBe(
    true,
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        approvalId: expiring.id,
        connectionId: first,
        reason: expect.stringContaining("requires authorization"),
      }),
    }),
  );
  expect(f.writes).toEqual([{ userId: 12, title: f.args.title }]);
  const fresh = await openApproval(client, f.args);
  expect(fresh.action.target.connectionId).toBe(second);
});

test("a GitHub default and its Connection are private to the Person, workspace and app registration", async () => {
  const f = await fixture();
  const owner = f.client();
  const first = await owner.connect("first");
  await owner.register(first);
  expect((await owner.setDefault(first)).status).toBe(200);
  const privateApproval = await openApproval(owner, f.args);
  expect(
    (await f.client(f.deps, "unsigned").request("/connections")).status,
  ).toBe(401);
  const others = [
    f.client(f.deps, f.otherPerson),
    f.client({ ...f.deps, workspaceId: f.otherWorkspace }),
    f.client({ ...f.deps, registration: f.otherRegistration }),
  ];
  for (const other of others) {
    expect(await (await other.request("/connections")).json()).toEqual({
      connections: [],
      defaultConnectionId: null,
    });
    const sameGithubUser = await other.connect("first");
    expect(sameGithubUser).not.toBe(first);
    await other.register(sameGithubUser);
    expect((await other.setDefault(first)).status).toBe(403);
    expect(
      (
        await other.request(
          "/approvals",
          { ...f.args, connectionId: first },
          "POST",
        )
      ).status,
    ).toBe(403);
    expect((await other.request("/approvals", f.args, "POST")).status).toBe(
      409,
    );
    expect(
      (
        await other.request(
          `/approvals/${privateApproval.id}/decision`,
          { decision: "allow_once" },
          "POST",
        )
      ).status,
    ).toBe(404);
    expect((await other.setDefault(sameGithubUser)).status).toBe(200);
    expect((await openApproval(other, f.args)).action.target.connectionId).toBe(
      sameGithubUser,
    );
  }
  expect((await openApproval(owner, f.args)).action.target.connectionId).toBe(
    first,
  );
  expect(f.writes).toEqual([]);
});
