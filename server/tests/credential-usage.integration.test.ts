import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createCredentialUsageReader } from "../src/admin/credential-usage";
import { createDatabase } from "../src/db/client";
import { agents, credentials, users } from "../src/db/schema/core";
import { identityLinks } from "../src/db/schema/identity";
import {
  mcpServers,
  mcpUserCredentials,
  pluginGrants,
} from "../src/db/schema/plugins";
import {
  responsibilities,
  responsibilitySourceBindings,
  responsibilityTriggers,
} from "../src/db/schema/responsibilities";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What points at a vault row, read before an administrator revokes it: every table that holds the
 * credential's id, the Bots that reach it through an app they hold or through a key of their own,
 * and the deployment's model key.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `credential-usage-${randomUUID()}`;
const owner = { id: `${prefix}owner`, email: `${prefix}owner@example.test` };
const goal = `${prefix}goal`;
const MODEL = { provider: `${prefix}openai`, keyId: "production" };

const ids = {
  serverToken: randomUUID(),
  oauthClient: randomUUID(),
  userToken: randomUUID(),
  link: randomUUID(),
  linkOfSomeoneGone: randomUUID(),
  binding: randomUUID(),
  trigger: randomUUID(),
  botKey: randomUUID(),
  model: randomUUID(),
  modelReplaced: randomUUID(),
  orphan: randomUUID(),
};

const bot = (
  suffix: string,
  name: string,
  key?: string,
): (typeof agents)["$inferInsert"] => ({
  id: `${prefix}${suffix}`,
  name,
  type: "built_in",
  configuration: key
    ? { auth: { header: "Authorization", credentialId: key } }
    : {},
});

async function seed() {
  await database.insert(users).values([owner]);
  await database
    .insert(agents)
    .values([
      bot("ada", "Ada", ids.botKey),
      bot("grace", "Grace"),
      bot("spare", "Spare"),
    ]);
  const row = (
    id: string,
    kind: string,
    provider: string,
    revoked = false,
  ) => ({
    id,
    kind: kind as never,
    // Starts with the run's prefix, so a crashed run's rows can be swept.
    provider: `${prefix}${provider}`,
    keyId: "fixture",
    metadata: {},
    encryptedValue: "not-read",
    ...(revoked ? { revokedAt: new Date("2026-11-01T00:00:00.000Z") } : {}),
  });
  await database.insert(credentials).values([
    row(ids.serverToken, "mcp", "notion"),
    row(ids.oauthClient, "mcp_oauth_client", "gmail"),
    row(ids.userToken, "mcp_user_token", "gmail"),
    row(ids.link, "connector", "github-user-token"),
    row(ids.linkOfSomeoneGone, "connector", "slack-user-token"),
    row(ids.binding, "connector", "github-webhook"),
    row(ids.trigger, "connector", "linear-trigger"),
    row(ids.botKey, "agent", "ag-ui"),
    { ...row(ids.model, "model", "openai"), keyId: MODEL.keyId },
    {
      ...row(ids.modelReplaced, "model", "openai", true),
      keyId: MODEL.keyId,
    },
    row(ids.orphan, "connector", "nobody"),
  ]);
  await database.insert(mcpServers).values([
    {
      id: `${prefix}notion`,
      title: "Notion",
      vendor: "fixture",
      url: "https://mcp.notion.test",
      credentialId: ids.serverToken,
    },
    {
      id: `${prefix}gmail`,
      title: "Gmail",
      vendor: "fixture",
      url: "https://mcp.gmail.test",
      credentialId: ids.oauthClient,
    },
  ]);
  await database.insert(pluginGrants).values([
    {
      kind: "mcp",
      ref: `${prefix}notion/search_pages`,
      agentId: `${prefix}ada`,
    },
    {
      kind: "mcp",
      ref: `${prefix}notion/create_page`,
      agentId: `${prefix}grace`,
    },
    // Another server whose id starts with the same word: a prefix match would wrongly list Spare.
    {
      kind: "mcp",
      ref: `${prefix}notion-tools/search_pages`,
      agentId: `${prefix}spare`,
    },
  ]);
  await database.insert(mcpUserCredentials).values({
    serverId: `${prefix}gmail`,
    userId: owner.id,
    credentialId: ids.userToken,
    scope: "read",
  });
  await database.insert(identityLinks).values({
    id: `${prefix}link`,
    provider: "github",
    realm: "github.com",
    subject: "42",
    userId: owner.id,
    verifiedBy: "oauth",
    handle: "octocat",
    credentialId: ids.link,
  });
  // A link outlives the person it belonged to: its user id is deliberately not a foreign key.
  await database.insert(identityLinks).values({
    id: `${prefix}link-gone`,
    provider: "slack",
    realm: "T123:C456",
    subject: "U789",
    userId: `${prefix}gone`,
    verifiedBy: "challenge",
    credentialId: ids.linkOfSomeoneGone,
  });
  await database.insert(responsibilities).values({
    id: goal,
    ownerUserId: owner.id,
    agentId: `${prefix}ada`,
    channelId: `${prefix}channel`,
    threadId: `${prefix}thread`,
    title: "Triage the inbox",
    instruction: "Sort new mail.",
    successCriteria: "The inbox is empty.",
  });
  await database.insert(responsibilitySourceBindings).values({
    id: `${prefix}binding`,
    ownerUserId: owner.id,
    source: "github",
    repository: "acme/widgets",
    credentialId: ids.binding,
  });
  await database.insert(responsibilityTriggers).values({
    id: `${prefix}trigger`,
    ownerUserId: owner.id,
    responsibilityId: goal,
    kind: "linear",
    config: {},
    credentialId: ids.trigger,
  });
}

/** This run's rows, and a previous run's if it stopped before its own afterAll. */
async function cleanUp() {
  const stale = "credential-usage-%";
  await database.delete(pluginGrants).where(like(pluginGrants.agentId, stale));
  await database.delete(identityLinks).where(like(identityLinks.id, stale));
  await database
    .delete(mcpUserCredentials)
    .where(like(mcpUserCredentials.userId, stale));
  await database
    .delete(responsibilityTriggers)
    .where(like(responsibilityTriggers.id, stale));
  await database
    .delete(responsibilitySourceBindings)
    .where(like(responsibilitySourceBindings.id, stale));
  await database
    .delete(responsibilities)
    .where(like(responsibilities.id, stale));
  await database.delete(mcpServers).where(like(mcpServers.id, stale));
  await database.delete(agents).where(like(agents.id, stale));
  await database.delete(users).where(like(users.id, stale));
  // Last: the app rows above refuse to delete a credential they still point at.
  await database.delete(credentials).where(like(credentials.provider, stale));
}

beforeAll(async () => {
  await cleanUp();
  await seed();
});
afterAll(async () => {
  await cleanUp();
  await database.$client.end({ timeout: 5 });
});

const reader = createCredentialUsageReader(database, MODEL);

test("an app's own credential names the app and the Bots holding a grant on it", async () => {
  expect(await reader.usage(ids.serverToken)).toEqual({
    features: ["Notion app"],
    bots: [
      { id: `${prefix}ada`, name: "Ada" },
      { id: `${prefix}grace`, name: "Grace" },
    ],
  });
});

test("a Bot's own key names that Bot and nothing else", async () => {
  expect(await reader.usage(ids.botKey)).toEqual({
    features: [],
    bots: [{ id: `${prefix}ada`, name: "Ada" }],
  });
});

test("the deployment's model key is used by every Bot, and the one it replaced is used by nothing", async () => {
  expect(await reader.usage(ids.model)).toEqual({
    features: ["Model access for every Bot"],
    bots: [],
  });
  expect(await reader.usage(ids.modelReplaced)).toEqual({
    features: [],
    bots: [],
  });
});

test("a person's own connection to an app names the app and the person", async () => {
  expect(await reader.usage(ids.userToken)).toEqual({
    features: [`Gmail for ${owner.email}`],
    bots: [],
  });
});

test("a linked outside account names the account and the person", async () => {
  expect(await reader.usage(ids.link)).toEqual({
    features: [`GitHub link for ${owner.email}`],
    bots: [],
  });
});

test("a link whose person is gone still names the account it holds", async () => {
  expect(await reader.usage(ids.linkOfSomeoneGone)).toEqual({
    features: ["Slack link"],
    bots: [],
  });
});

test("a goal's repository events and its trigger each name what they are for", async () => {
  expect(await reader.usage(ids.binding)).toEqual({
    features: ["GitHub events from acme/widgets"],
    bots: [],
  });
  expect(await reader.usage(ids.trigger)).toEqual({
    features: ["Linear trigger for Triage the inbox"],
    bots: [],
  });
});

test("a credential nothing points at is used by nothing", async () => {
  expect(await reader.usage(ids.orphan)).toEqual({ features: [], bots: [] });
});

test("a credential that does not exist has nothing to read", async () => {
  expect(await reader.usage(randomUUID())).toBeNull();
});
