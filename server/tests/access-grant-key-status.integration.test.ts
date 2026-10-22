import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createRequireUser } from "../src/auth/guards";
import {
  accessGrantRoutes,
  createAccessGrantService,
} from "../src/bot-services/access-grants";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceStore } from "../src/bot-services/store";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botBindingOffers,
  botServices,
  gatewayVirtualKeys,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #251 (05.10): the person's own key status, and revoke-everything for one Bot.
 *
 * The questions are the ticket's own: (1) the list answers each grant's live key versions —
 * version number, state, term — and nothing that could ever be a secret (the table has no
 * plaintext column; the assertion pins the wire shape staying that way); (2) one revoke-all
 * press retires EVERY active grant the person holds for that Bot, and with each grant every
 * key version it still held (05.7's semantics, exercised through the same seam); (3) the act
 * is idempotent — a replay after everything is already revoked answers an empty revoke, not
 * an error, and never touches anybody else's grants; (4) a body without a botId is refused
 * at the boundary.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const botStore = createBotServiceStore(database);
const issuer = createBindingOfferIssuer({ database, auditStore });

/** Every gateway-disable ask the composed revocation seam received, in order. */
const remoteDisableCalls: Array<{
  grantId: string;
  gatewayVirtualKeyIds: string[];
}> = [];

const service = createAccessGrantService({
  database,
  botServices: botStore,
  auditStore,
  revokeGatewayKeys: async (input) => {
    remoteDisableCalls.push(input);
  },
});

const requireUser = createRequireUser(
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-openbot-test-user");
        if (!id) return null;
        return {
          user: {
            id,
            email: `${id}@example.test`,
            name: null,
            image: null,
            role: "user",
          },
        };
      },
    },
  },
  { rolesForUser: async () => ["user"] },
);

const app = accessGrantRoutes(requireUser, service);

const prefix = `b5-251-${randomUUID()}`;
const hint = (suffix = randomUUID().slice(0, 8)) => `slack:${prefix}-${suffix}`;

const createdGrantIds: string[] = [];
const createdKeyRowIds: string[] = [];

afterAll(async () => {
  if (createdKeyRowIds.length > 0) {
    await database
      .delete(gatewayVirtualKeys)
      .where(inArray(gatewayVirtualKeys.id, createdKeyRowIds));
  }
  if (createdGrantIds.length > 0) {
    await database
      .delete(accessGrants)
      .where(inArray(accessGrants.grantId, createdGrantIds));
  }
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

async function registeredBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  const existing = await botStore.getBotService(botId);
  if (existing) return existing;
  return botStore.register({
    botId,
    displayName: `Key Status Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
}

async function confirmedGrant(
  userId: string,
  botSuffix: string,
  identity = hint(),
) {
  await registeredBot(botSuffix);
  const botId = `${prefix}-${botSuffix}`;
  const offer = await issuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await service.confirm(userId, offer.bindingCode);
  createdGrantIds.push(grant.grantId);
  return { grant, botId };
}

/** One locally-recorded key version, as a claim or renewal would have written it. */
async function keyVersion(
  grant: { grantId: string; userId: string },
  botId: string,
  credentialVersion: number,
  status: "active" | "expired" | "revoked" = "active",
) {
  const [row] = await database
    .insert(gatewayVirtualKeys)
    .values({
      id: `gvk-${randomUUID()}`,
      grantId: grant.grantId,
      botId,
      gatewayCustomerId: `${prefix}-customer`,
      gatewayVirtualKeyId: `vk-${prefix}-${credentialVersion}-${randomUUID()}`,
      valueHash: randomUUID().replace(/-/g, "").repeat(4),
      credentialVersion,
      status,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  if (row) createdKeyRowIds.push(row.id);
  return row;
}

function request(
  path: string,
  userId: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (userId) headers["x-openbot-test-user"] = userId;
  return app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

test("the list answers each grant's live key versions — version, state, term, no secret", async () => {
  const userId = `${prefix}-list`;
  const { grant, botId } = await confirmedGrant(userId, "list");
  await keyVersion(grant, botId, 1, "expired");
  await keyVersion(grant, botId, 2);
  await keyVersion(grant, botId, 3);

  const response = await request("/grants", userId);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    grants: Array<{
      grantId: string;
      status: string;
      activeKeys: Array<{
        credentialVersion: number;
        status: string;
        expiresAt: string | null;
      }>;
    }>;
  };
  const mine = body.grants.find((row) => row.grantId === grant.grantId);
  expect(mine?.status).toBe("active");

  // Only the LIVE versions ride the answer, newest first; the expired one is history.
  expect(mine?.activeKeys.map((key) => key.credentialVersion)).toEqual([3, 2]);
  for (const key of mine?.activeKeys ?? []) {
    expect(key.status).toBe("active");
    expect(key.expiresAt).not.toBeNull();
  }

  // And the wire shape has no place a plaintext could ride: the serialized answer names no
  // secret field at all — the state is the deployment's belief about the key, never the key.
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/"secret"/i);
  expect(raw).not.toMatch(/"value"/i);
  expect(raw).not.toMatch(/"plain"/i);
});

test("one revoke-all retires every active grant of the Bot and every key version each held", async () => {
  const userId = `${prefix}-all`;
  const { grant: first, botId } = await confirmedGrant(userId, "multi");
  const { grant: second } = await confirmedGrant(userId, "multi", hint("alt"));
  await keyVersion(first, botId, 1);
  await keyVersion(first, botId, 2);
  await keyVersion(second, botId, 1);
  // A second person's grant for a DIFFERENT Bot must not move at all.
  const otherUser = `${prefix}-other`;
  const { grant: bystander, botId: bystanderBot } = await confirmedGrant(
    otherUser,
    "bystander",
  );
  await keyVersion(bystander, bystanderBot, 1);

  const response = await request("/grants/revoke-all", userId, {
    method: "POST",
    body: { botId },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    grants: Array<{ grantId: string; status: string }>;
    revokedCount: number;
  };
  expect(body.revokedCount).toBe(2);
  expect(
    body.grants.map((row) => row.grantId).sort(),
  ).toEqual([first.grantId, second.grantId].sort());

  // Every key version the two grants held is retired with them, and the gateway was asked to
  // disable each remote key — the same retirement a one-grant press gets.
  const rows = await database
    .select()
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.botId, botId));
  expect(rows.length).toBe(3);
  for (const row of rows) expect(row.status).toBe("revoked");
  expect(remoteDisableCalls.length).toBe(2);

  // The bystander's money-adjacent facts are exactly as they were.
  const [bystanderRow] = await database
    .select({ status: accessGrants.status })
    .from(accessGrants)
    .where(eq(accessGrants.grantId, bystander.grantId));
  expect(bystanderRow.status).toBe("active");

  // The list the page refetches shows the same truth: nothing active for this Bot.
  const listed = await request("/grants", userId);
  const listedBody = (await listed.json()) as {
    grants: Array<{ grantId: string; status: string; activeKeys: unknown[] }>;
  };
  const forBot = listedBody.grants.filter(
    (row) => body.grants.some((g) => g.grantId === row.grantId),
  );
  expect(forBot.length).toBe(2);
  for (const row of forBot) {
    expect(row.status).toBe("revoked");
    expect(row.activeKeys).toEqual([]);
  }
});

test("revoke-all is idempotent: a replay after everything is revoked answers an empty revoke", async () => {
  const userId = `${prefix}-replay`;
  const { botId } = await confirmedGrant(userId, "replay");

  const first = await request("/grants/revoke-all", userId, {
    method: "POST",
    body: { botId },
  });
  const firstBody = (await first.json()) as { revokedCount: number };
  expect(firstBody.revokedCount).toBe(1);

  remoteDisableCalls.length = 0;
  const replay = await request("/grants/revoke-all", userId, {
    method: "POST",
    body: { botId },
  });
  expect(replay.status).toBe(200);
  const replayBody = (await replay.json()) as { revokedCount: number };
  expect(replayBody.revokedCount).toBe(0);
  expect(remoteDisableCalls).toEqual([]);
});

test("a body without a botId is refused at the boundary", async () => {
  const userId = `${prefix}-bad`;
  await confirmedGrant(userId, "bad");

  const response = await request("/grants/revoke-all", userId, {
    method: "POST",
    body: {},
  });
  expect(response.status).toBe(400);
});
