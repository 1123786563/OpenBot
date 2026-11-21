import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type AbstractAgent, HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type RunFinishedEvent,
  type RunStartedEvent,
} from "@ag-ui/core";
import { LLMock } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Observable, of } from "rxjs";
import { z } from "zod";
import {
  frontendApprovalSnapshot,
  observeApprovalAgent,
} from "../../app/src/lib/copilot/approval-context";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createApprovedActionExecutor } from "../src/approvals/execute";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { withApprovalContext } from "../src/approvals/types";
import { createServerApprovalService } from "../src/approvals/wiring";
import { createAuditStore, PERSON_INITIATOR } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createComputerTransport } from "../src/computer/client";
import { loadConfig } from "../src/config";
import {
  ASKED_RUN,
  buildAgents,
  createRequestAgents,
  type RegisteredAgent,
} from "../src/copilot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  routineRuns,
  routines,
  skillMarketSources,
  skills,
  users,
  workItems,
} from "../src/db/schema";
import { admitPickedSkill } from "../src/plugins/picked-skill";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { createResponsibilityRoutes } from "../src/responsibilities/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineStore } from "../src/routines/store";
import { createSkillMarketRoutes } from "../src/skill-market/routes";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const approvals = createApprovalStore(database);
const approvalService = createApprovalService(approvals);
const vendorCalls: string[] = [];
const pluginOptions = {
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  approvalGate: approvalService.gate,
} satisfies Parameters<typeof createPluginStore>[0];
const mcpStore = createPluginStore(pluginOptions);
const store = createPluginStore({
  ...pluginOptions,
  callVendor: async (_connection, toolName) => {
    vendorCalls.push(toolName);
    return { text: "done", isError: false };
  },
});
const suite = randomUUID().slice(0, 8);
const slug = `notes-${suite}`;
const collision = `collision-${suite}`;
const alternatives = [`market-notes-${suite}`, `market-memo-${suite}`] as const;
const racingSource = `race-source-${suite}`;
const racingCommand = `race-command-${suite}`;
const owner = `owner-${suite}`;
const member = `member-${suite}`;
const app = `workspace-${suite}`;
const protectedTool = `${app}/reset_workspace`;
const ungrantedTool = `${app}/rename_workspace`;
const bot = `shared-${suite}`;
const anotherBot = `another-${suite}`;
const emptyBot = `empty-${suite}`;
const spareBot = `spare-${suite}`;
const fingerprint = `sha256:${"a".repeat(64)}`;
let secondVersionCompatible = false;
let state: "published" | "newer" | "offline" | "withdrawn" = "published";

beforeAll(async () => {
  await database
    .insert(users)
    .values([owner, member].map((id) => ({ id, email: `${id}@example.test` })));
  await database.insert(mcpServers).values({
    id: app,
    title: "Workspace",
    vendor: "Test",
    url: "https://workspace.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values([
    {
      serverId: app,
      name: "reset_workspace",
      vendorName: "reset_workspace",
      effect: "write",
      destructive: true,
    },
    { serverId: app, name: "rename_workspace", vendorName: "rename_workspace" },
  ]);
  for (const id of [bot, anotherBot, emptyBot, spareBot]) {
    await database.insert(agents).values({
      id,
      name: id,
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      title: id,
      roleDescription: "Notes",
      avatarSeed: id,
      visibility: "public",
      ownerUserId: id === bot || id === spareBot ? null : owner,
    });
  }
  await store.grant("mcp", protectedTool, bot, "admin@example.test");
});

afterEach(() => {
  state = "published";
  secondVersionCompatible = false;
});

afterAll(async () => {
  const approvalIds = (
    await Promise.all([approvals.list(owner), approvals.list(member)])
  )
    .flat()
    .map(({ id }) => id);
  if (approvalIds.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(workItems.key, approvalIds),
        ),
      );
  await database
    .delete(agents)
    .where(inArray(agents.id, [bot, anotherBot, emptyBot, spareBot]));
  await database
    .delete(skillMarketSources)
    .where(inArray(skillMarketSources.slug, [slug, collision, racingSource]));
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [slug, collision, racingCommand, ...alternatives]),
    );
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database.delete(users).where(inArray(users.id, [owner, member]));
});

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-user") ?? "admin";
  const role = id === "admin" ? "admin" : "user";
  context.set("actor", { id, role, email: `${id}@example.test` });
  await next();
};

const profiles = createAgentProfileStore(database, undefined);
const plugins = createPluginRoutes(
  store,
  requireUser,
  async (actor, id) => (await profiles.get(actor, id)) !== null,
);

const routes = createSkillMarketRoutes(
  requireUser,
  {
    baseUrl: "http://skillhub:8080",
    namespace: "catalog",
    token: "read",
    confirmations: {
      "3": {
        slug,
        version: "1.0.0",
        versionId: 3,
        fingerprint,
        reviewTaskId: 1,
        reviewerId: "reviewer",
      },
      "4": {
        slug,
        version: "2.0.0",
        versionId: 4,
        fingerprint,
        reviewTaskId: 3,
        reviewerId: "reviewer",
      },
      "6": {
        slug: collision,
        version: "1.0.0",
        versionId: 6,
        fingerprint,
        reviewTaskId: 2,
        reviewerId: "reviewer",
      },
    },
  },
  async (url: URL) => {
    if (state === "offline") return new Response(null, { status: 503 });
    const { pathname } = url;
    const entry = pathname.split("/")[5];
    const skillId = entry === collision ? 5 : 2;
    const v1 = {
      id: entry === collision ? 6 : 3,
      version: "1.0.0",
      status: "PUBLISHED",
    };
    const v2 = { id: 4, version: "2.0.0", status: "PUBLISHED" };
    const version = pathname.endsWith("3.0.0")
      ? { id: 7, version: "3.0.0", status: "PENDING_REVIEW" }
      : pathname.endsWith("2.0.0") ||
          url.searchParams.get("version") === "2.0.0"
        ? v2
        : v1;
    let data: unknown = {
      id: skillId,
      namespace: "catalog",
      slug: entry,
      displayName: "Notes",
      status: "ACTIVE",
      visibility: "NAMESPACE_ONLY",
      publishedVersion: state === "published" ? v1 : v2,
    };
    if (pathname.endsWith("/resolve")) {
      data = {
        skillId,
        namespace: "catalog",
        slug: entry,
        version: version.version,
        versionId: version.id,
        fingerprint,
      };
    } else if (pathname.endsWith("/files")) {
      data = [{ filePath: "SKILL.md" }];
    } else if (pathname.includes("/versions/")) {
      data = {
        ...version,
        status:
          version === v1 && state === "withdrawn" ? "ARCHIVED" : version.status,
        parsedMetadataJson: JSON.stringify({
          body:
            version === v1
              ? "Summarize in three bullets."
              : "Produce an outline.",
          frontmatter: {
            metadata: {
              "openbot-compatibility": {
                scripts: version === v2 && !secondVersionCompatible,
                supportingFiles: false,
                dedicatedRuntime: false,
              },
            },
          },
        }),
      };
    }
    return Response.json({ code: 0, data });
  },
  store,
);

function install(
  agentId: string,
  version = "1.0.0",
  user = "admin",
  sourceSlug = slug,
) {
  return routes.request(`/catalog/${sourceSlug}/versions/${version}/install`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify({ agentId }),
  });
}

function assign(command: string, user = "admin", sourceSlug = collision) {
  return routes.request(`/catalog/${sourceSlug}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify({ command }),
  });
}

async function slash(agentId: string, command = slug) {
  const picked = await admitPickedSkill(
    {
      messages: [
        { id: "message", role: "user", content: `/${command} these notes` },
      ],
      forwardedProps: {},
    },
    () => grantedSkills({ store, botId: agentId }),
  );
  return picked.kind === "admitted" ? picked.guidance : undefined;
}

test("a Bot invokes the installed version after a new release, outage and withdrawal", async () => {
  const before = await store.listForAgent(bot);
  const [first, second] = await Promise.all([install(bot), install(bot)]);
  expect([first.status, second.status].sort()).toEqual([200, 201]);
  const installed = first.status === 201 ? first : second;
  expect(await installed.json()).toMatchObject({
    command: slug,
    version: "1.0.0",
  });
  expect((await store.listForAgent(bot)).tools).toEqual(before.tools);
  expect(
    (await store.listForAgent(bot)).skills.find((skill) => skill.slug === slug)
      ?.tools,
  ).toEqual([]);
  expect(await targets(member)).toEqual([]);
  expect(await targets(owner)).toEqual([
    { id: anotherBot, title: anotherBot },
    { id: emptyBot, title: emptyBot },
  ]);
  expect((await install(bot, "1.0.0", member)).status).toBe(403);
  const sharedSkills = await plugins.request(`/for/${bot}`, {
    headers: { "x-user": member },
  });
  expect(sharedSkills.status).toBe(200);
  expect(await sharedSkills.json()).toMatchObject({
    skills: expect.arrayContaining([
      expect.objectContaining({
        slug,
        instructions: "Summarize in three bullets.",
      }),
    ]),
  });
  expect((await install(emptyBot, "2.0.0", owner)).status).toBe(422);
  expect((await install(emptyBot, "3.0.0", owner)).status).toBe(404);
  state = "newer";
  const guidance = await slash(bot);
  expect(guidance).toContain("Summarize in three bullets.");
  const call = {
    botId: bot,
    actorId: member,
    args: { workspace: "notes" },
  };
  await expect(
    store.callTool({ ...call, ref: ungrantedTool }),
  ).rejects.toBeInstanceOf(PluginRefusedError);
  const toolCallId = randomUUID();
  await expect(
    withApprovalContext(
      {
        runId: randomUUID(),
        threadId: `thread-${suite}`,
        toolCallId,
        toolName: "reset_workspace",
        args: call.args,
        messages: [
          { id: "message", role: "user", content: `/${slug} these notes` },
        ],
        state: {},
        context: [],
        forwardedProps: {},
      },
      () => store.callTool({ ...call, ref: protectedTool }),
    ),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const request = (await approvals.list(member)).find(
    (row) => row.action.toolCallId === toolCallId,
  );
  expect(request?.action.policy?.behaviour).toBe("ask");
  expect(vendorCalls).toEqual([]);
  state = "offline";
  expect(await slash(bot)).toContain("Summarize in three bullets.");
  expect((await install(emptyBot)).status).toBe(502);
  state = "withdrawn";
  expect((await install(emptyBot)).status).toBe(404);
  expect(await slash(emptyBot)).toBeUndefined();
  expect(await slash(bot)).toContain("Summarize in three bullets.");
});

async function targets(user: string) {
  const response = await routes.request("/install-targets", {
    headers: { "x-user": user },
  });
  expect(response.status).toBe(200);
  return (await response.json()).bots;
}

test("only an administrator can resolve a collision and both Bots use the winning assignment", async () => {
  await store.installSkill({
    slug: collision,
    title: "Original",
    summary: "",
    instructions: "Keep the original.",
    ownerUserId: null,
    by: "admin@example.test",
  });
  await store.grant("skill", collision, bot, "admin@example.test");
  const preview = await routes.request(`/catalog/${collision}/versions/1.0.0`);
  expect(await preview.json()).toMatchObject({
    installable: false,
    canAssignCommand: true,
    reasons: [
      "This market skill needs an unused slash command assigned by an administrator.",
    ],
  });
  expect((await install(anotherBot, "1.0.0", owner, collision)).status).toBe(
    409,
  );
  expect(await slash(anotherBot, collision)).toBeUndefined();
  const memberPreview = await routes.request(
    `/catalog/${collision}/versions/1.0.0`,
    { headers: { "x-user": owner } },
  );
  expect(await memberPreview.json()).not.toHaveProperty(
    "canAssignCommand",
    true,
  );
  expect((await assign(alternatives[0], owner)).status).toBe(403);
  expect((await assign("Invalid Command")).status).toBe(400);
  expect((await assign(collision)).status).toBe(409);

  const [first, second, racingInstall] = await Promise.all([
    assign(alternatives[0]),
    assign(alternatives[1]),
    install(anotherBot, "1.0.0", owner, collision),
  ]);
  expect([first.status, second.status].sort()).toEqual([201, 409]);
  const winner = first.status === 201 ? alternatives[0] : alternatives[1];
  const loser = first.status === 201 ? alternatives[1] : alternatives[0];
  expect([201, 409]).toContain(racingInstall.status);
  if (racingInstall.status === 201)
    expect(await racingInstall.json()).toMatchObject({ command: winner });

  await store.installSkill({
    slug: loser,
    title: "Available alternative",
    summary: "",
    instructions: "Use the alternative.",
    ownerUserId: null,
    by: "admin@example.test",
  });
  expect((await assign(loser)).status).toBe(409);
  expect((await assign(winner)).status).toBe(200);
  const installed = await Promise.all([
    install(bot, "1.0.0", "admin", collision),
    install(anotherBot, "1.0.0", owner, collision),
  ]);
  expect(installed.map((response) => response.status)).toEqual([
    201,
    racingInstall.status === 201 ? 200 : 201,
  ]);
  for (const response of installed) {
    expect(await response.json()).toMatchObject({ command: winner });
  }
  expect(await slash(bot, winner)).toContain("Summarize in three bullets.");
  expect(await slash(anotherBot, winner)).toContain(
    "Summarize in three bullets.",
  );
  expect(await slash(bot, collision)).toContain("Keep the original.");
});

test("an owner can install on their Bot and a managed Skill cannot replace the reserved command", async () => {
  expect((await install(anotherBot, "1.0.0", owner)).status).toBe(201);
  await expect(
    store.installSkill({
      slug,
      title: "Overwrite",
      summary: "",
      instructions: "Overwrite.",
      ownerUserId: null,
      by: "admin@example.test",
    }),
  ).rejects.toThrow("This command is reserved by a market skill.");
  expect(await slash(anotherBot)).toContain("Summarize in three bullets.");
});

test("switches and uninstalls only the selected Bot snapshot", async () => {
  expect((await install(emptyBot, "1.0.0", owner)).status).toBe(201);
  expect([200, 201]).toContain((await install(bot, "1.0.0")).status);
  expect(await slash(bot)).toContain("Summarize in three bullets.");
  const path = `/bots/${emptyBot}/installations`;
  const request = (path: string, user = owner, method = "GET", body?: object) =>
    routes.request(path, {
      method,
      headers: { "x-user": user, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const change = (version: string, expectedVersionId: number, user = owner) =>
    request(`/catalog/${slug}/versions/${version}/switch`, user, "POST", {
      agentId: emptyBot,
      expectedVersionId,
    });
  const uninstall = (expectedVersionId: number, user = owner) =>
    request(`${path}/${slug}`, user, "DELETE", { expectedVersionId });
  const list = async () => {
    const response = await request(path);
    expect(response.status).toBe(200);
    return response.json();
  };
  const runInput: Parameters<typeof admitPickedSkill>[0] = {
    messages: [
      { id: "message", role: "user", content: `/${slug} these notes` },
    ],
    forwardedProps: {},
  };
  const running = await grantedSkills({ store, botId: emptyBot });

  state = "offline";
  expect(await list()).toMatchObject({
    installations: [{ command: slug, version: "1.0.0", versionId: 3 }],
  });
  expect((await request(path, member)).status).toBe(403);
  expect((await change("2.0.0", 3, member)).status).toBe(403);
  expect((await uninstall(3, member)).status).toBe(403);
  expect((await change("2.0.0", 3)).status).toBe(502);

  state = "published";
  expect((await change("2.0.0", 3)).status).toBe(422);
  expect(await slash(emptyBot)).toContain("Summarize in three bullets.");
  secondVersionCompatible = true;
  state = "newer";
  const targetVersion = {
    ...disablementIdentity,
    version: "2.0.0",
    versionId: 4,
  };
  try {
    expect(
      (
        await changeDisablement(
          "PUT",
          "admin",
          "Already disabled",
          targetVersion,
        )
      ).status,
    ).toBe(204);
    const alreadyDisabled = await change("2.0.0", 3);
    expect(alreadyDisabled.status).toBe(422);
    expect(await alreadyDisabled.json()).toMatchObject({
      error: expect.stringContaining("Already disabled"),
    });
    expect(await list()).toMatchObject({ installations: [{ versionId: 3 }] });
    expect(
      (await changeDisablement("DELETE", "admin", undefined, targetVersion))
        .status,
    ).toBe(204);

    const write = store.installMarketSkill;
    const writeAfterDisable = spyOn(
      store,
      "installMarketSkill",
    ).mockImplementationOnce(async (...args) => {
      expect(
        (
          await changeDisablement(
            "PUT",
            "admin",
            "Disabled after qualification",
            targetVersion,
          )
        ).status,
      ).toBe(204);
      return write(...args);
    });
    try {
      const disabledAtWrite = await change("2.0.0", 3);
      expect(disabledAtWrite.status).toBe(422);
      expect(await disabledAtWrite.json()).toMatchObject({
        error: expect.stringContaining("Disabled after qualification"),
      });
      expect(await list()).toMatchObject({ installations: [{ versionId: 3 }] });
    } finally {
      writeAfterDisable.mockRestore();
    }
  } finally {
    await changeDisablement("DELETE", "admin", undefined, targetVersion);
  }

  const upgrades = await Promise.all([change("2.0.0", 3), change("2.0.0", 3)]);
  expect(upgrades.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const runningV2 = await grantedSkills({ store, botId: emptyBot });
  expect(await slash(emptyBot)).toContain("Produce an outline.");
  expect(await slash(bot)).toContain("Summarize in three bullets.");
  expect(
    await admitPickedSkill({ ...runInput }, async () => running),
  ).toMatchObject({
    guidance: expect.stringContaining("Summarize in three bullets."),
  });
  expect((await change("1.0.0", 3)).status).toBe(409);
  expect((await uninstall(3)).status).toBe(409);

  state = "withdrawn";
  expect((await change("1.0.0", 4)).status).toBe(404);
  expect(await slash(emptyBot)).toContain("Produce an outline.");
  secondVersionCompatible = true;
  state = "newer";
  expect((await change("1.0.0", 4)).status).toBe(200);
  expect(await slash(emptyBot)).toContain("Summarize in three bullets.");
  expect(
    await admitPickedSkill({ ...runInput }, async () => runningV2),
  ).toMatchObject({ guidance: expect.stringContaining("Produce an outline.") });

  state = "offline";
  expect((await uninstall(3)).status).toBe(204);
  expect(await list()).toEqual({ installations: [] });
  expect(await slash(emptyBot)).toBeUndefined();
  expect(await slash(bot)).toContain("Summarize in three bullets.");
  expect(
    await admitPickedSkill({ ...runInput }, async () => running),
  ).toMatchObject({
    guidance: expect.stringContaining("Summarize in three bullets."),
  });
});

test("an administrator can disable a version pinned by a live Bot after the final uninstall and catalog outage", async () => {
  secondVersionCompatible = true;
  state = "newer";
  expect((await install(emptyBot, "2.0.0", owner)).status).toBe(201);
  const endpointReceived = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const dispatch = spyOn(HttpAgent.prototype, "run").mockImplementation(
    (input) =>
      new Observable((subscriber) => {
        const role = input.messages.find(
          (message) => message.id === "standing-role:lifecycle",
        );
        endpointReceived.resolve(
          typeof role?.content === "string" ? role.content : "",
        );
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        void release.promise.then(() => {
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });
          subscriber.complete();
        });
      }),
  );
  try {
    const runtime = await buildAgents(
      [
        {
          id: emptyBot,
          name: "Notes",
          type: "remote_ag_ui",
          endpoint: "http://registry-fixture.example/run",
          standingMessage: {
            id: "standing-role:lifecycle",
            role: "system",
            content: "You help with notes.",
          },
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.5" },
      "synthetic-key",
      undefined,
      async () => [],
      undefined,
      undefined,
      undefined,
      {
        loadSkills: (botId) => grantedSkills({ store, botId }),
        choose: async () => null,
        registerMarketRun: (scope, version, snapshot) =>
          store.registerMarketRun(
            { ...scope, actorId: owner },
            version,
            undefined,
            snapshot,
          ),
      },
    );
    const agent = runtime[emptyBot]?.clone();
    if (!agent) throw new Error("Fixture Bot is unavailable");
    agent.setMessages([
      { id: "notes", role: "user", content: `/${slug} these notes` },
    ]);
    const running = agent.runAgent();
    try {
      const instructions = await Promise.race([
        endpointReceived.promise,
        running.then(() => {
          throw new Error("Run ended before reaching the fixture endpoint.");
        }),
      ]);
      expect(instructions).toContain("Produce an outline.");
      state = "offline";
      const removed = await routes.request(
        `/bots/${emptyBot}/installations/${slug}`,
        {
          method: "DELETE",
          headers: { "x-user": owner, "content-type": "application/json" },
          body: JSON.stringify({ expectedVersionId: 4 }),
        },
      );
      expect(removed.status).toBe(204);
      expect(await slash(emptyBot)).toBeUndefined();
      const identity = {
        ...disablementIdentity,
        version: "2.0.0",
        versionId: 4,
      };
      const listed = await routes.request("/version-disablements");
      expect(listed.status).toBe(200);
      const body = await listed.json();
      expect(body.versions).toContainEqual({ ...identity, reason: null });
      expect(JSON.stringify(body)).not.toContain("Produce an outline.");
      expect(
        (
          await changeDisablement(
            "PUT",
            "admin",
            "Review in progress",
            identity,
          )
        ).status,
      ).toBe(204);
      expect(
        (await changeDisablement("DELETE", "admin", "", identity)).status,
      ).toBe(204);
    } finally {
      release.resolve();
      await running;
    }
  } finally {
    dispatch.mockRestore();
  }
});

test("a browser computer approval carries on with the market version that emitted its call", async () => {
  expect((await install(emptyBot, "1.0.0", owner)).status).toBe(201);
  const threadId = randomUUID();
  const toolCallId = randomUUID();
  const toolName = "computer_click";
  const args = { ref: "submit" };
  const actor = {
    id: owner,
    role: "user",
    email: `${owner}@example.test`,
  } as const;
  const prompts: string[] = [];
  const endpoint = spyOn(HttpAgent.prototype, "run").mockImplementation(
    (input) => {
      const role = input.messages.find((message) => message.role === "system");
      prompts.push(String(role?.content));
      return of(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        ...(prompts.length === 1
          ? [
              {
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName: toolName,
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: JSON.stringify(args),
              },
              { type: EventType.TOOL_CALL_END, toolCallId },
            ]
          : []),
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      );
    },
  );
  try {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: emptyBot,
          name: "Notes",
          type: "remote_ag_ui",
          endpoint: "http://registry-fixture.example/run",
          standingMessage: {
            id: "standing-role",
            role: "system",
            content: "You help with notes.",
          },
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      resolveModelApiKey: async () => null,
      selectionForActor: () => ({
        loadSkills: (botId) => grantedSkills({ store, botId }),
        registerMarketRun: (scope, version, snapshot) =>
          store.registerMarketRun(
            { ...scope, actorId: owner },
            version,
            undefined,
            snapshot,
          ),
        choose: async () => null,
      }),
    });
    const [registered] = Object.values(
      await createRequestAgents(
        async () => actor,
        resolver,
      )({
        request: new Request("http://openbot.test"),
      }),
    );
    const agent: AbstractAgent = registered.clone();
    agent.threadId = threadId;
    agent.setMessages([
      { id: "question", role: "user", content: `/${slug} these notes` },
    ]);
    const stopObserving = observeApprovalAgent(agent);
    await agent.runAgent({
      forwardedProps: { [ASKED_RUN]: true },
      tools: [
        {
          name: toolName,
          description: "Click",
          parameters: { type: "object" },
        },
      ],
    });
    const assistant = agent.messages.find(
      (message) => message.role === "assistant",
    );
    if (assistant?.role !== "assistant" || !assistant.toolCalls?.[0])
      throw new Error("No browser tool call");
    const snapshot = frontendApprovalSnapshot({
      agent,
      toolCall: assistant.toolCalls[0],
    });
    stopObserving();
    if (!snapshot) throw new Error("No browser approval context");
    expect(prompts[0]).toContain("Summarize in three bullets.");

    state = "newer";
    secondVersionCompatible = true;
    expect(
      (
        await routes.request(`/catalog/${slug}/versions/2.0.0/switch`, {
          method: "POST",
          headers: { "x-user": owner, "content-type": "application/json" },
          body: JSON.stringify({ agentId: emptyBot, expectedVersionId: 3 }),
        })
      ).status,
    ).toBe(200);

    // Rebuild the service after the call was emitted, and use the saved transcript to verify it.
    const sourceFor = async () => ({
      channelId: "browser-fixture",
      botId: emptyBot,
    });
    let executions = 0;
    const computerTools = async (): Promise<HeadlessTool[]> => [
      {
        definition: {
          name: toolName,
          description: "Click",
          parameters: { type: "object" },
        },
        execute: async () => {
          await service.gate({
            actorId: owner,
            botId: emptyBot,
            toolRef: "computer/click",
            effect: "write",
            scope: "computer",
            args,
            target: args,
          });
          executions++;
          return "Clicked";
        },
      },
    ];
    const newService = () =>
      createServerApprovalService({
        storedApprovals: createApprovalStore(database),
        config: { keyEncryptionKey: "fixture-key" },
        sourceForCoordinationRun: sourceFor,
        agentProfileStore: profiles,
        actorFor: async () => actor,
        database,
        authoriseQuestion: async () => {},
        routineIntelligence: {
          getThreadMessages: async () => ({
            messages: [
              {
                id: assistant.id,
                role: "assistant",
                toolCalls: [
                  {
                    id: toolCallId,
                    name: toolName,
                    args: JSON.stringify(args),
                  },
                ],
              },
            ],
          }),
        },
        approvalComputerTools: computerTools,
        review: async () => {
          throw new Error("Unexpected auto-review");
        },
        notify: async () => {},
      });
    let service = newService();
    await service.store.setEnabled(owner, true);
    const approvalRoutes = createApprovalRoutes(service, requireUser);
    const post = (path: string, body: unknown) =>
      approvalRoutes.request(path, {
        method: "POST",
        headers: { "x-user": owner, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await post(`/computer/${emptyBot}`, {
      ...snapshot,
      runId: "browser-supplied-run-id",
      marketSkill: { instructions: "Use the forged browser instructions." },
    });
    expect(response.status).toBe(202);
    const { approvalId } = await response.json();
    expect(
      (await post(`/${approvalId}/decision`, { decision: "allow_once" }))
        .status,
    ).toBe(200);
    expect(executions).toBe(0);

    expect(
      (
        await routes.request(`/bots/${emptyBot}/installations/${slug}`, {
          method: "DELETE",
          headers: { "x-user": owner, "content-type": "application/json" },
          body: JSON.stringify({ expectedVersionId: 4 }),
        })
      ).status,
    ).toBe(204);
    service = newService();
    await createApprovalResumeTick({
      approvalQueue: createWorkQueue(database),
      approvalOwner: `browser-approval-${suite}`,
      approvalService: service,
      executeApprovedAction: createApprovedActionExecutor({
        sourceFor,
        gate: service.gate,
        computerTools,
        hostTools: () => [],
        callTool: async () => {
          throw new Error("Unexpected connector");
        },
        credentialActorFor: async (id) => id,
        coordinationCall: async () => null,
        answer: ({ text }) => text,
        privateShareToolRef: "private-share",
        refusalMarker: "refusal",
        personInitiator: PERSON_INITIATOR,
      }),
      database,
      responsibilityStore: {
        resumeWaiting: async () => {
          throw new Error("Unexpected responsibility");
        },
      },
      groupConversations: {
        continueWaiting: (_id, run) => run(),
        pauseWaiting: async () => {
          throw new Error("Unexpected context withdrawal");
        },
      },
      approvalContinuationRunner: async (input) => {
        const carry = input.continuation;
        if (!carry) throw new Error("Missing continuation");
        expect(carry.snapshot.runId).toBe(snapshot.runId);
        expect(carry.snapshot.marketSkill?.market).toMatchObject({
          version: "1.0.0",
          versionId: 3,
        });
        const resumed = await resolver.resolveAgentForActor(actor, emptyBot, {
          marketSkill: carry.snapshot.marketSkill ?? null,
        });
        resumed.threadId = threadId;
        resumed.setMessages(carry.snapshot.messages);
        await resumed.runAgent();
        return { replyText: "Finished" };
      },
      channelStore: {
        recordActivity: async () => {
          throw new Error("Unexpected channel activity");
        },
      },
      actorFor: async () => actor,
      notify: async () => {},
    })();
    expect(executions).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Summarize in three bullets.");
  } finally {
    endpoint.mockRestore();
  }
});

test("assignment and managed Skill creation cannot both claim a free command", async () => {
  const [assignment, managed] = await Promise.allSettled([
    assign(racingCommand, "admin", racingSource),
    store.installSkill({
      slug: racingCommand,
      title: "Managed",
      summary: "",
      instructions: "Use the managed instructions.",
      ownerUserId: null,
      by: "admin@example.test",
    }),
  ]);
  if (assignment.status === "rejected") throw assignment.reason;

  if (managed.status === "fulfilled") {
    expect(assignment.value.status).toBe(409);
    await store.grant("skill", racingCommand, bot, "admin@example.test");
    expect(await slash(bot, racingCommand)).toContain(
      "Use the managed instructions.",
    );
  } else {
    expect(assignment.value.status).toBe(201);
    expect(managed.reason).toBeInstanceOf(PluginRefusedError);
    const retry = await assign(racingCommand, "admin", racingSource);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ command: racingCommand });
  }
});

const disablementIdentity = {
  source: "http://skillhub:8080",
  namespace: "catalog",
  slug,
  version: "1.0.0",
  versionId: 3,
  registrySkillId: 2,
};

function changeDisablement(
  method: "PUT" | "DELETE",
  user = "admin",
  reason = "Review in progress",
  identity = disablementIdentity,
) {
  return routes.request("/version-disablements", {
    method,
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(method === "PUT" ? { ...identity, reason } : identity),
  });
}

test("only an administrator can disable and restore an exact version", async () => {
  const path = "/version-disablements";
  secondVersionCompatible = true;
  expect([200, 201]).toContain((await install(bot)).status);
  expect([200, 201]).toContain((await install(anotherBot)).status);
  expect((await install(emptyBot, "2.0.0")).status).toBe(201);
  const dispatched: string[] = [];
  const remote = spyOn(HttpAgent.prototype, "run").mockImplementation(
    (input) => {
      dispatched.push(
        input.messages
          .map((message) => ("content" in message ? message.content : ""))
          .join("\n"),
      );
      return of<[RunStartedEvent, RunFinishedEvent]>(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      );
    },
  );
  const available = await buildAgents(
    [
      {
        id: anotherBot,
        name: anotherBot,
        type: "built_in",
        systemPrompt: "Notes assistant",
      },
      ...[bot, emptyBot].map(
        (id): RegisteredAgent => ({
          id,
          name: id,
          type: "remote_ag_ui",
          endpoint: "https://bot.example.test",
          standingMessage: {
            id: "standing-role",
            role: "system",
            content: "Notes assistant",
          },
        }),
      ),
    ],
    { provider: "openai", defaultModel: "gpt-5.5" },
    null,
    undefined,
    async () => [],
    undefined,
    undefined,
    undefined,
    {
      loadSkills: (botId) => grantedSkills({ store, botId }),
      choose: async () => null,
    },
  );
  async function invoke(id: string) {
    const agent: AbstractAgent = available[id].clone();
    const failures: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        failures.push(event.message);
      },
    });
    agent.setMessages([
      { id: "question", role: "user", content: `/${slug} notes` },
    ]);
    await agent.runAgent().catch((error: Error) => {
      if (!failures.length) failures.push(error.message);
    });
    return failures;
  }

  try {
    expect(
      (await routes.request(path, { headers: { "x-user": owner } })).status,
    ).toBe(403);
    expect((await changeDisablement("PUT", owner)).status).toBe(403);
    expect((await changeDisablement("PUT", "admin", " ")).status).toBe(400);
    expect((await changeDisablement("PUT")).status).toBe(204);
    const preview = await routes.request(`/catalog/${slug}/versions/1.0.0`);
    expect(await preview.json()).toMatchObject({
      installable: false,
      disableReason: "Review in progress",
    });

    state = "offline";
    const listed = await routes.request(path);
    expect(await listed.json()).toMatchObject({
      versions: expect.arrayContaining([
        expect.objectContaining({
          ...disablementIdentity,
          reason: "Review in progress",
        }),
      ]),
    });
    expect((await changeDisablement("DELETE", owner)).status).toBe(403);
    expect(await invoke(bot)).toEqual([
      expect.stringContaining("Review in progress"),
    ]);
    expect(await invoke(anotherBot)).toEqual([
      expect.stringContaining("Review in progress"),
    ]);
    expect(await invoke(emptyBot)).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("Produce an outline.");
    state = "published";
    const refused = await install(emptyBot);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining("Review in progress"),
    });

    state = "offline";
    expect((await changeDisablement("DELETE")).status).toBe(204);
    expect(await invoke(bot)).toEqual([]);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toContain("Summarize in three bullets.");
  } finally {
    const restored = await changeDisablement("DELETE");
    remote.mockRestore();
    expect(restored.status).toBe(204);
  }
});

test("installation rechecks disablement after successful catalog qualification", async () => {
  const write = store.installMarketSkill;
  const installAfterDisable = spyOn(
    store,
    "installMarketSkill",
  ).mockImplementationOnce(async (...args) => {
    expect(
      (await changeDisablement("PUT", "admin", "Disabled before the write"))
        .status,
    ).toBe(204);
    return write(...args);
  });
  try {
    const refused = await install(spareBot);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining("Disabled before the write"),
    });
    expect(await slash(spareBot)).toBeUndefined();
  } finally {
    installAfterDisable.mockRestore();
    await changeDisablement("DELETE");
  }
  expect((await install(spareBot)).status).toBe(201);
});

test("a loaded market run pauses before the remote endpoint is dialled", async () => {
  expect([200, 201]).toContain((await install(bot)).status);
  const transport = spyOn(HttpAgent.prototype, "run").mockImplementation(() => {
    throw new Error("The remote endpoint was dialled");
  });
  try {
    const available = await buildAgents(
      [
        {
          id: bot,
          name: bot,
          type: "remote_ag_ui",
          endpoint: "https://bot.example.test",
          standingMessage: {
            id: "role",
            role: "system",
            content: "Notes assistant",
          },
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.5" },
      null,
      undefined,
      async () => [],
      undefined,
      undefined,
      undefined,
      {
        loadSkills: (botId) => grantedSkills({ store, botId }),
        choose: async () => null,
        registerMarketRun: (scope, version) =>
          store.registerMarketRun({ ...scope, actorId: member }, version),
      },
      undefined,
      async () => {
        expect((await changeDisablement("PUT")).status).toBe(204);
        return [];
      },
    );
    const agent: AbstractAgent = available[bot].clone();
    agent.setMessages([
      { id: "question", role: "user", content: `/${slug} notes` },
    ]);
    const errors: string[] = [];
    await agent
      .runAgent(undefined, {
        onRunErrorEvent: ({ event }) => {
          errors.push(event.message);
        },
      })
      .catch((error: Error) => {
        if (!errors.length) errors.push(error.message);
      });
    expect(errors.join(" ")).toContain("Review in progress");
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
    await changeDisablement("DELETE");
  }
});

async function serveMcp(tool: string, pauseAt?: "initialize" | "tools/call") {
  let initialized = 0;
  let dispatched = 0;
  const mock = new MCPMock();
  mock
    .addTool({
      name: tool,
      description: "Fixture tool",
      inputSchema: { type: "object" },
    })
    .onToolCall(tool, () => "done");
  const upstream = await mock.start();
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.text();
      const { method } = JSON.parse(body);
      if (method === "initialize") initialized++;
      if (method === "tools/call") dispatched++;
      if (method === pauseAt) {
        expect((await changeDisablement("PUT")).status).toBe(204);
        expect((await changeDisablement("DELETE")).status).toBe(204);
      }
      return fetch(upstream, {
        method: "POST",
        headers: request.headers,
        body,
      });
    },
  });
  const [previous] = await database
    .select({ url: mcpServers.url })
    .from(mcpServers)
    .where(eq(mcpServers.id, app));
  await database
    .update(mcpServers)
    .set({ url: `http://127.0.0.1:${relay.port}/mcp` })
    .where(eq(mcpServers.id, app));
  return {
    initialized: () => initialized,
    dispatched: () => dispatched,
    async stop() {
      relay.stop(true);
      await mock.stop();
      await database
        .update(mcpServers)
        .set({ url: previous.url })
        .where(eq(mcpServers.id, app));
    },
  };
}

// The runner has already yielded control to the approval queue at this point.
async function waitingRunHistory(
  target: "responsibility" | "routine",
  id: string,
  approvalId: string,
  threadId: string,
) {
  const common = {
    id,
    ownerUserId: member,
    agentId: bot,
    channelId: threadId,
    instruction: "Summarize the notes.",
  };
  const waiting = { kind: "approval" as const, approvalId };
  if (target === "routine") {
    await database.insert(routines).values({
      ...common,
      cron: "0 9 * * *",
      nextRunAt: new Date(),
    });
    await database.insert(routineRuns).values({
      id,
      routineId: id,
      status: "waiting",
      waiting,
    });
    return createRoutineRoutes(createRoutineStore(database), requireUser);
  }
  await database.insert(responsibilities).values({
    ...common,
    threadId,
    title: "Market notes",
    successCriteria: "Notes summarized.",
  });
  await database.insert(responsibilityEvents).values({
    id,
    ownerUserId: member,
    source: "manual",
    externalId: id,
    type: "requested",
    payload: {},
  });
  await database.insert(responsibilityRuns).values({
    id,
    responsibilityId: id,
    eventId: id,
    status: "waiting",
    waiting,
  });
  return createResponsibilityRoutes(
    createResponsibilityStore(database, { resolveTarget: async () => null }),
    {
      ingest: async () => {
        throw new Error("Unexpected event.");
      },
    },
    requireUser,
  );
}

for (const phase of [
  "before approval",
  "initialize",
  "tools/call",
  "after completion",
  "routine",
  "responsibility",
] as const) {
  const automation =
    phase === "routine" || phase === "responsibility" ? phase : null;
  const stoppedBeforeApproval =
    phase === "before approval" || automation !== null;
  const completedBeforeStop = phase === "after completion";
  const afterDispatch = phase === "tools/call" || completedBeforeStop;
  test(`approved MCP execution handles disablement at ${phase}`, async () => {
    expect([200, 201]).toContain((await install(bot)).status);
    const model = new LLMock();
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = await model.start();
    model.onMessage(/.*/, {
      toolCalls: [
        { name: "reset_workspace", arguments: '{"workspace":"notes"}' },
      ],
    });
    const guardedApprovals = createApprovalService(
      approvals,
      undefined,
      undefined,
      {
        marketPause: store.marketRunPauseReason,
      },
    );
    const execute = () =>
      mcpStore.callTool({
        botId: bot,
        actorId: member,
        ref: protectedTool,
        args: { workspace: "notes" },
      });
    const relay = await serveMcp(
      "reset_workspace",
      phase === "initialize" || phase === "tools/call" ? phase : undefined,
    );
    try {
      const available = await buildAgents(
        [
          {
            id: bot,
            name: bot,
            type: "built_in",
            systemPrompt: "Notes assistant",
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        "fixture",
        undefined,
        async () => [
          {
            name: "reset_workspace",
            ref: protectedTool,
            description: "Reset a workspace",
            parameters: z.object({ workspace: z.string() }),
            execute: async () => (await execute()).text,
          },
        ],
        undefined,
        undefined,
        undefined,
        {
          loadSkills: (botId) => grantedSkills({ store, botId }),
          choose: async () => null,
          registerMarketRun: (scope, version, snapshot) =>
            store.registerMarketRun(
              { ...scope, actorId: member },
              version,
              undefined,
              snapshot,
            ),
        },
      );
      const agent: AbstractAgent = available[bot].clone();
      const threadId = `paused-${suite}-${phase}`;
      agent.threadId = threadId;
      agent.setMessages([
        { id: "question", role: "user", content: `/${slug} notes` },
      ]);
      await agent.runAgent();
      const request = (await approvals.list(member)).find(
        (row) => row.action.threadId === threadId,
      );
      expect(request?.status).toBe("pending");
      if (!request) throw new Error("The Bot did not open an approval");

      if (stoppedBeforeApproval) {
        expect((await changeDisablement("PUT")).status).toBe(204);
        expect((await changeDisablement("DELETE")).status).toBe(204);
      }
      const approvalRoutes = createApprovalRoutes(
        guardedApprovals,
        requireUser,
      );
      expect(
        (
          await approvalRoutes.request(`/${request.id}/decision`, {
            method: "POST",
            headers: { "x-user": member, "content-type": "application/json" },
            body: JSON.stringify({ decision: "allow_once" }),
          })
        ).status,
      ).toBe(200);
      if (automation) {
        const history = await waitingRunHistory(
          automation,
          request.id,
          request.id,
          threadId,
        );
        const never = async () => {
          throw new Error("Paused work must not resume.");
        };
        await createApprovalResumeTick({
          approvalQueue: createWorkQueue(database),
          approvalOwner: `market-${automation}-${suite}`,
          approvalService: guardedApprovals,
          executeApprovedAction: never,
          database,
          responsibilityStore: { resumeWaiting: never },
          groupConversations: {
            continueWaiting: async (_id, run, reason) =>
              reason ? { replyText: reason } : run(),
            pauseWaiting: never,
          },
          approvalContinuationRunner: never,
          channelStore: { recordActivity: never },
          actorFor: never,
          notify: never,
        })();
        const response = await history.request(`/${request.id}/runs`, {
          headers: { "x-user": member },
        });
        expect(response.status).toBe(200);
        expect((await response.json()).runs).toContainEqual(
          expect.objectContaining({
            status: "paused",
            error: expect.stringContaining("Review in progress"),
          }),
        );
        return;
      }
      const dispatch = spyOn(mcpStore, "callTool");
      const continued: unknown[] = [];
      try {
        await guardedApprovals.resume(member, request.id, {
          validate: (action) =>
            guardedApprovals.validateReentry(action, execute),
          execute: async () => {
            const output = await execute();
            return output.text;
          },
          continue: async (outcome) => {
            continued.push(outcome);
          },
        });
        expect(dispatch).toHaveBeenCalledTimes(
          phase === "before approval" ? 0 : 2,
        );
        expect(relay.initialized()).toBe(phase === "before approval" ? 0 : 1);
        expect(relay.dispatched()).toBe(afterDispatch ? 1 : 0);
        expect(continued).toEqual([
          expect.objectContaining({
            ...(completedBeforeStop
              ? { result: { content: "done" } }
              : { pauseReason: expect.stringContaining("Review in progress") }),
          }),
        ]);
        expect(await approvals.get(member, request.id)).toMatchObject({
          status: "completed",
          result: afterDispatch
            ? { content: "done" }
            : { error: expect.stringContaining("Review in progress") },
        });
        if (completedBeforeStop) {
          expect((await changeDisablement("PUT")).status).toBe(204);
          expect((await changeDisablement("DELETE")).status).toBe(204);
        }
        const response = await approvalRoutes.request("/", {
          headers: { "x-user": member },
        });
        expect(response.status).toBe(200);
        const { requests } = z
          .object({
            requests: z.array(
              z.object({ id: z.string(), result: z.unknown() }),
            ),
          })
          .parse(await response.json());
        const entry = requests.find((row) => row.id === request.id);
        if (completedBeforeStop) expect(entry?.result).toEqual({});
        else
          expect(entry).toMatchObject({
            result: {
              ...(afterDispatch ? { content: "done" } : {}),
              pauseReason: expect.stringContaining("Review in progress"),
            },
          });
      } finally {
        dispatch.mockRestore();
        await database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, "approval.resume"),
              eq(workItems.key, request.id),
            ),
          );
      }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
      await model.stop();
      await relay.stop();
      await changeDisablement("DELETE");
    }
  });
}

for (const boundary of [
  "tool dispatch",
  "second model call",
  "provider fetch",
] as const) {
  test(`a market run pauses before its next ${boundary} and preserves a dispatched tool result`, async () => {
    expect([200, 201]).toContain((await install(bot)).status);
    const model = new LLMock();
    const upstream = await model.start();
    const previous = process.env.OPENAI_BASE_URL;
    let requests = 0;
    let dispatched = 0;
    let pauseDuringRun = true;
    model.onMessage(/.*/, {
      toolCalls: [{ name: "read_notes", arguments: "{}" }],
      content: "Read notes.",
    });
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests += 1;
        if (pauseDuringRun && boundary === "tool dispatch")
          expect((await changeDisablement("PUT")).status).toBe(204);
        const { pathname } = new URL(request.url);
        return fetch(`${upstream}${pathname}`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        });
      },
    });
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
    try {
      const available = await buildAgents(
        [
          {
            id: bot,
            name: bot,
            type: "built_in",
            systemPrompt: "Notes assistant",
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        "fixture",
        undefined,
        async () => [
          {
            name: "read_notes",
            ref: "fixture/read_notes",
            description: "Read the notes",
            parameters: z.object({}),
            execute: async () => {
              dispatched += 1;
              if (pauseDuringRun && boundary === "second model call")
                expect((await changeDisablement("PUT")).status).toBe(204);
              return "The vendor returned its accepted result.";
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        {
          loadSkills: (botId) => grantedSkills({ store, botId }),
          choose: async () => null,
          registerMarketRun: async (scope, version) => {
            const control = await store.registerMarketRun(
              { ...scope, actorId: member },
              version,
            );
            if (boundary !== "provider fetch") return control;
            return {
              ...control,
              async dispatch(start) {
                if (pauseDuringRun) {
                  expect((await changeDisablement("PUT")).status).toBe(204);
                  expect((await changeDisablement("DELETE")).status).toBe(204);
                }
                return control.dispatch(start);
              },
            };
          },
        },
      );
      const agent: AbstractAgent = available[bot].clone();
      agent.setMessages([
        { id: "question", role: "user", content: `/${slug} notes` },
      ]);
      const errors: string[] = [];
      const toolResults: string[] = [];
      await agent
        .runAgent(undefined, {
          onEvent: ({ event }) => {
            if (event.type === EventType.TOOL_CALL_RESULT && "content" in event)
              toolResults.push(String(event.content));
          },
          onRunErrorEvent: ({ event }) => {
            errors.push(event.message);
          },
        })
        .catch((error: Error) => {
          if (!errors.length) errors.push(error.message);
        });

      expect(errors.join(" ")).toContain("Review in progress");
      expect(requests).toBe(boundary === "provider fetch" ? 0 : 1);
      expect(dispatched).toBe(boundary === "second model call" ? 1 : 0);
      if (boundary === "second model call")
        expect(toolResults).toContainEqual(
          expect.stringContaining("The vendor returned its accepted result."),
        );

      expect((await changeDisablement("DELETE")).status).toBe(204);
      pauseDuringRun = false;
      model.onMessage(/fresh invocation/, { content: "New run works." });
      const fresh = available[bot].clone();
      fresh.setMessages([
        { id: "fresh", role: "user", content: `/${slug} fresh invocation` },
      ]);
      await fresh.runAgent();
      expect(requests).toBeGreaterThan(boundary === "provider fetch" ? 0 : 1);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
      relay.stop(true);
      await model.stop();
      await changeDisablement("DELETE");
    }
  });
}

for (const duringHandshake of [false, true]) {
  test(`a signed callback stays blocked after restore when paused ${duringHandshake ? "during MCP initialize" : "before the callback"}`, async () => {
    expect([200, 201]).toContain((await install(bot)).status);
    const relay = duringHandshake
      ? await serveMcp("rename_workspace", "initialize")
      : undefined;
    if (relay) {
      await database
        .update(mcpTools)
        .set({ effect: "read" })
        .where(
          and(
            eq(mcpTools.serverId, app),
            eq(mcpTools.name, "rename_workspace"),
          ),
        );
      await store.grant("mcp", ungrantedTool, bot, "admin@example.test");
    }
    const token = "skill-market-test-callback";
    const config = loadConfig(testEnvironment({ AGENT_TOOL_TOKEN: token }));
    const callbackApp = createApp(
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
      relay ? mcpStore : store,
    );
    let assertion: unknown;
    const transport = spyOn(HttpAgent.prototype, "run").mockImplementation(
      (input) => {
        assertion = input.forwardedProps?.openbotRun;
        return of<[RunStartedEvent, RunFinishedEvent]>(
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        );
      },
    );
    const dispatch = spyOn(relay ? mcpStore : store, "callTool");
    try {
      const available = await buildAgents(
        [
          {
            id: bot,
            name: bot,
            type: "remote_ag_ui",
            endpoint: "https://bot.example.test",
            standingMessage: {
              id: "role",
              role: "system",
              content: "Notes assistant",
            },
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        null,
        undefined,
        async () => [],
        (botId, runId, threadId) =>
          mintRunAssertion(
            { actorId: member, botId, threadId, runId },
            config.keyEncryptionKey,
          ),
        undefined,
        undefined,
        {
          loadSkills: (botId) => grantedSkills({ store, botId }),
          choose: async () => null,
          registerMarketRun: (scope, version) =>
            store.registerMarketRun({ ...scope, actorId: member }, version),
        },
      );
      const agent: AbstractAgent = available[bot].clone();
      agent.setMessages([
        { id: "question", role: "user", content: `/${slug} notes` },
      ]);
      await agent.runAgent({ forwardedProps: { openbotRun: "forged" } });
      expect(typeof assertion).toBe("string");
      expect(assertion).not.toBe("forged");
      if (!relay) {
        expect((await changeDisablement("PUT")).status).toBe(204);
        expect((await changeDisablement("DELETE")).status).toBe(204);
      }

      const response = await callbackApp.request(
        "http://openbot.local/api/agent-tools/call",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-agent-token": token,
          },
          body: JSON.stringify({
            name: relay ? ungrantedTool : protectedTool,
            args: { workspace: "notes" },
            run: assertion,
            runId: randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        isError: true,
        text: expect.stringContaining("Review in progress"),
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const rejected = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_rejected"),
            eq(auditEvents.targetId, relay ? ungrantedTool : protectedTool),
          ),
        );
      expect(rejected).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ refusal: "market_run_paused" }),
        }),
      );
      if (relay) {
        expect(relay.initialized()).toBe(1);
        expect(relay.dispatched()).toBe(0);
      }
    } finally {
      dispatch.mockRestore();
      await relay?.stop();
      transport.mockRestore();
      await changeDisablement("DELETE");
    }
  });
}

for (const afterPreparation of [false, true]) {
  test(`browser approval uses the server-bound run when paused ${afterPreparation ? "during preparation" : "before approval"}`, async () => {
    expect([200, 201]).toContain((await install(bot)).status);
    const callId = randomUUID();
    const threadId = randomUUID();
    const name = afterPreparation ? "computer_navigate" : "computer_click";
    const args = afterPreparation
      ? { url: "https://example.test" }
      : { x: 10, y: 10 };
    const transport = spyOn(HttpAgent.prototype, "run").mockImplementation(
      (input) =>
        of(
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: callId,
            toolCallName: name,
          },
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: callId,
            delta: JSON.stringify(args),
          },
          { type: EventType.TOOL_CALL_END, toolCallId: callId },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        ),
    );
    let computerRequests = 0;
    const computer = createComputerTransport({
      fetchImpl: Object.assign(
        async () => {
          computerRequests++;
          return Response.json({ ok: true });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const computerDispatch = async () => {
      expect(afterPreparation).toBe(true);
      expect((await changeDisablement("PUT")).status).toBe(204);
      expect((await changeDisablement("DELETE")).status).toBe(204);
      return computer.post("http://computer.test", bot, "/navigate", args);
    };
    const serverApprovals = createServerApprovalService({
      storedApprovals: approvals,
      config: loadConfig(testEnvironment()),
      sourceForCoordinationRun: async () => ({
        channelId: "notes-channel",
        botId: bot,
      }),
      agentProfileStore: profiles,
      actorFor: async (id) => ({ id, role: "user" }),
      database,
      authoriseQuestion: async () => {},
      routineIntelligence: {
        getThreadMessages: async () => ({
          messages: [
            {
              id: "answer",
              role: "assistant",
              toolCalls: [{ id: callId, name, args: JSON.stringify(args) }],
            },
          ],
        }),
      },
      approvalComputerTools: async () => [
        {
          definition: { name, description: "Click", parameters: {} },
          execute: computerDispatch,
        },
      ],
      review: async () => {
        throw new Error("Unexpected approval review");
      },
      notify: async () => {},
    });
    try {
      const available = await buildAgents(
        [
          {
            id: bot,
            name: bot,
            type: "remote_ag_ui",
            endpoint: "https://bot.example.test",
            standingMessage: {
              id: "role",
              role: "system",
              content: "Notes assistant",
            },
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        null,
        undefined,
        async () => [],
        undefined,
        undefined,
        undefined,
        {
          loadSkills: (botId) => grantedSkills({ store, botId }),
          choose: async () => null,
          registerMarketRun: (scope, version) =>
            store.registerMarketRun({ ...scope, actorId: member }, version),
        },
      );
      const agent: AbstractAgent = available[bot].clone();
      agent.threadId = threadId;
      agent.setMessages([
        { id: "question", role: "user", content: `/${slug} notes` },
      ]);
      await agent.runAgent({
        tools: [{ name, description: "Click", parameters: {} }],
      });
      if (!afterPreparation) {
        expect((await changeDisablement("PUT")).status).toBe(204);
        expect((await changeDisablement("DELETE")).status).toBe(204);
      }
      const approvalApp = createApprovalRoutes(serverApprovals, requireUser);
      const check = await approvalApp.request(
        `http://openbot.local/threads/${threadId}?${new URLSearchParams({ botId: bot, toolCallId: callId })}`,
        { headers: { "x-user": member } },
      );
      expect(await check.json()).toMatchObject({ requiresRunContext: true });
      await expect(
        serverApprovals.frontendAction(member, bot, {
          runId: randomUUID(),
          threadId,
          toolCallId: callId,
          toolName: name,
          args,
          state: {},
          messages: [
            {
              id: "answer",
              role: "assistant",
              toolCalls: [
                {
                  id: callId,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          ],
          context: [],
          forwardedProps: {},
        }),
      ).rejects.toThrow("Review in progress");
      expect(computerRequests).toBe(0);
    } finally {
      transport.mockRestore();
      await changeDisablement("DELETE");
    }
  });
}
