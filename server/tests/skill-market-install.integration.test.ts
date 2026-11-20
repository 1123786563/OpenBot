import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { withApprovalContext } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  skillMarketSources,
  skills,
  users,
} from "../src/db/schema";
import { pickedSkillGuidance } from "../src/plugins/picked-skill";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { createSkillMarketRoutes } from "../src/skill-market/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const approvals = createApprovalStore(database);
const approvalService = createApprovalService(approvals);
const vendorCalls: string[] = [];
const store = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  approvalGate: (candidate) => approvalService.gate(candidate),
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
const fingerprint = `sha256:${"a".repeat(64)}`;
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
  for (const id of [bot, anotherBot, emptyBot]) {
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
      ownerUserId: id === bot ? null : owner,
    });
  }
  await store.grant("mcp", protectedTool, bot, "admin@example.test");
});

afterEach(() => {
  state = "published";
});

afterAll(async () => {
  await database
    .delete(agents)
    .where(inArray(agents.id, [bot, anotherBot, emptyBot]));
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
    baseUrl: "https://registry.example",
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
                scripts: version === v2,
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
  return pickedSkillGuidance(
    {
      messages: [
        { id: "message", role: "user", content: `/${command} these notes` },
      ],
      forwardedProps: {},
    },
    await grantedSkills({ store, botId: agentId }),
  );
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
